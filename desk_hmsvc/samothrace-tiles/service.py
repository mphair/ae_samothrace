"""Samothrace tile service (hmsvc) -- serves local map tiles over plain
HTTP, replacing the old approach of base64-shuttling each tile through
the Bridge API's `desk.documents` capability one round trip at a time.
Real HTTP means the browser's own cache does the work instead.

Also synthesizes two new kinds of layer the raw source data never
separated out on its own (see "Topographic extraction" and "Structure
exclusion" below):

  - "topographic": the Restored State Plan's own terrain drawing
    (contour-ish lines, paths, ground texture) with building/monument
    footprints masked out -- Restored-only (2026-10-15: previously a
    cross-plan diff against Actual, redone to use only Restored,
    ground-truth structure polygons instead; see git history for the
    diff-based version if that's ever wanted back).
  - "<plan>-structures": each plan's own tiles with that same
    ground-truth-derived "not terrain" mask subtracted out, leaving
    just that plan's own building/structure line work. Still computed
    from an Actual-vs-Restored diff internally (`_shared_diff_mask_png`)
    -- unchanged by the above, since nothing asked for these two to
    change and they're not Restored-only by nature (each needs to know
    what's "extra" on ITS OWN plan, Actual included).

Run standalone for development: `uvicorn service:app --reload --port 8099`
(from this directory) -- DESK_PROJECT_DIR then needs to be set manually
since there's no Desk process to set it for you; see `_project_dir()`.
"""
import io
import json
import math
import os
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageChops, ImageDraw, ImageFilter

TILE_SIZE = 256
MIN_ZOOM = 17
MAX_ZOOM = 22

# ── Topographic/structures extraction tuning ──
# Both Actual/Restored State Plan tiles are independently-rendered raster
# line art over the same terrain, so their anti-aliased edges don't land
# on exactly the same pixels even where the underlying content is
# identical. A small blur before diffing (applied only to the comparison,
# never to the output pixels) absorbs that sub-pixel jitter; the
# tolerance is a max-per-channel-difference threshold on the *blurred*
# comparison. Both constants were picked by eyeballing the result against
# real tiles -- see the "Build samothrace-tiles hmsvc service" task notes
# for the before/after comparison that led here. Still used by
# `_shared_diff_mask_png` (the "structures" split's own internal helper)
# -- not by the public "topographic" layer any more, see that function's
# own comment.
DIFF_BLUR_RADIUS = 1.0
DIFF_TOLERANCE = 40

# Ground-truth structure exclusion for the Restored-only "topographic"
# layer -- the SAME Overlay.geojson polygons and the same reasoning
# scripts/extract_vector_layers.py's own build_structure_exclusion_mask
# already uses (see that function's header comment for the full "why
# ground truth, not inferred from the raster" rationale, and why FID 27
# is skipped). STRUCTURE_BUFFER_PX_AT_Z20 is that script's own
# STRUCTURE_BUFFER_PX value, calibrated at its fixed working zoom (20);
# this service covers MIN_ZOOM..MAX_ZOOM, so the buffer is scaled per
# tile zoom (_structure_buffer_px) to cover the same real-world distance
# at every zoom level, not the same pixel count.
STRUCTURE_EXCLUSION_SKIP_FIDS = {27}
STRUCTURE_BUFFER_PX_AT_Z20 = 14
STRUCTURE_BUFFER_REF_ZOOM = 20


def _project_dir() -> Path:
    raw = os.environ.get("DESK_PROJECT_DIR")
    return Path(raw).resolve() if raw else Path.cwd().resolve()


PROJECT_DIR = _project_dir()
TILES_DIR = PROJECT_DIR / "Data" / "mapTiles"
FEATURES_DIR = PROJECT_DIR / "Data" / "mapFeatures"

PLAN_DIRS = {
    "actual": TILES_DIR / "SamoWebsite_ActualStatePlan_3857",
    "restored": TILES_DIR / "SamoWebsite_RestoredStatePlan_3857",
}
RAW_LAYER_DIRS = {
    "actual-monuments": TILES_DIR / "SamoWebsite_ActualStateMonuments_3857",
    "restored-monuments": TILES_DIR / "SamoWebsite_RestoredStateMonuments_3857",
    "aerial": TILES_DIR / "SamoWebsite_AerialImagery_3857",
    # Passthrough of the two raw source plans the topographic/structures
    # split below is derived from -- not part of LAYERS (the main
    # Samothrace Map widget's own layer list), since these are debugging
    #/comparison inputs rather than something that widget's panel should
    # offer toggling on its own. Added for the "topo-compare" widget,
    # which needs to show the original, undecomposed sources.
    "actual-plan-raw": PLAN_DIRS["actual"],
    "restored-plan-raw": PLAN_DIRS["restored"],
}
COMPUTED_LAYERS = {"topographic", "actual-structures", "restored-structures"}

# `order` controls compositing stack order (ascending = bottom to top);
# the widget composites whichever layers are checked in this order,
# independent of the order the user happened to toggle them in.
# "imagery" is a mutually-exclusive (radio-select) group on the widget
# side as of 2026-10-15 -- "topographic" moved here from its own
# now-removed "shared" group when it stopped being a cross-plan diff (see
# this module's own header comment).
LAYERS = [
    {"id": "aerial", "label": "Aerial Imagery", "group": "imagery", "order": 0, "defaultVisible": False},
    {"id": "topographic", "label": "Topographic", "group": "imagery", "order": 1, "defaultVisible": True},
    # Plain white backdrop -- same opaque white the paper background on
    # the other two "imagery" tiles already renders as (see _blank_png's
    # own comment). Radio-selects against Aerial/Topographic the same way
    # those two already do (the widget's own RADIO_GROUPS treats the
    # whole "imagery" group as mutually exclusive, not special-cased per
    # id) -- useful for looking at just the vector overlays with nothing
    # underneath but a plain backdrop.
    {"id": "blank", "label": "Blank", "group": "imagery", "order": 2, "defaultVisible": False},
    {"id": "restored-structures", "label": "Restored State — Structures", "group": "restored", "order": 21, "defaultVisible": False},
    {"id": "restored-monuments", "label": "Restored State — Monuments", "group": "restored", "order": 31, "defaultVisible": False},
    # 2026-10-15: a staged reveal of how "topographic" (above) gets
    # computed, mirroring the Restored/Waterways pipeline-stage debug
    # layers -- requested directly, hovering the final result and asking
    # "how did this get to look how it is." Live hmsvc tile layers, not
    # static pipeline-stage PNGs, since this computation genuinely is
    # per-tile/per-zoom (unlike extract_vector_layers.py's one-shot batch
    # mosaic passes) -- reusing that static-PNG mechanism would mean
    # re-deriving it at one fixed zoom, not showing what actually runs.
    {"id": "restored-plan-raw", "label": "00 — Restored raw (unmasked)", "group": "pipeline-topographic", "order": 0, "defaultVisible": False},
    {"id": "topographic-structures-raw", "label": "01 — Structure footprints (ground truth)", "group": "pipeline-topographic", "order": 1, "defaultVisible": False},
    {"id": "topographic-structures-buffered", "label": "02 — Exclusion mask (buffered)", "group": "pipeline-topographic", "order": 2, "defaultVisible": False},
]
# Validation set for /tiles/{layer}/... is deliberately wider than LAYERS
# (which only backs the /layers response, i.e. the main map widget's
# toggle panel) -- it also accepts the two raw-passthrough ids, plus
# "actual-structures"/"actual-monuments" (2026-10-15: dropped from LAYERS
# itself, since the main widget no longer offers an "Actual State"
# category at all -- but the tiles themselves are still computed/served
# here, since the standalone `topo-compare` widget still references
# "actual-structures" directly, by hardcoded id, independent of this
# service's own /layers response).
LAYER_IDS = {entry["id"] for entry in LAYERS} | {"actual-plan-raw", "restored-plan-raw", "actual-structures", "actual-monuments"}

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

PNG_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable"}


def _tms_path(base: Path, z: int, x: int, y: int) -> Path:
    # These tiles are stored TMS-style (y counted from the south) rather
    # than the standard XYZ (y counted from the north) the widget's own
    # tile math uses, so every lookup flips y the same way Leaflet's own
    # `tms: true` option used to.
    y_tms = (2**z) - 1 - y
    return base / str(z) / str(x) / f"{y_tms}.png"


def _load_rgba(base: Path, z: int, x: int, y: int) -> Image.Image | None:
    path = _tms_path(base, z, x, y)
    if not path.is_file():
        return None
    try:
        with Image.open(path) as im:
            return im.convert("RGBA")
    except Exception:
        return None


def _encode_png(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


@lru_cache(maxsize=4096)
def _shared_diff_mask_png(z: int, x: int, y: int) -> bytes | None:
    """Actual-vs-Restored diff -- the ORIGINAL "topographic" computation,
    kept as a private helper purely for `_structures_png` below (each
    plan's own "structures" split still needs to know what's common to
    both plans' drawings vs. extra on its own). No longer backs the
    public "topographic" layer -- see this module's own header comment
    for why that moved to Restored-only ground-truth exclusion instead."""
    actual = _load_rgba(PLAN_DIRS["actual"], z, x, y)
    restored = _load_rgba(PLAN_DIRS["restored"], z, x, y)
    if actual is None or restored is None:
        return None  # no reliable "shared" content without both sides

    actual_rgb = actual.convert("RGB").filter(ImageFilter.GaussianBlur(DIFF_BLUR_RADIUS))
    restored_rgb = restored.convert("RGB").filter(ImageFilter.GaussianBlur(DIFF_BLUR_RADIUS))
    diff = ImageChops.difference(actual_rgb, restored_rgb)
    max_channel_diff = ImageChops.lighter(ImageChops.lighter(diff.getchannel("R"), diff.getchannel("G")), diff.getchannel("B"))
    same_mask = max_channel_diff.point(lambda p: 255 if p <= DIFF_TOLERANCE else 0)

    out = actual.copy()
    out.putalpha(ImageChops.multiply(out.getchannel("A"), same_mask))
    return _encode_png(out)


# ── Restored-only structure exclusion (for the "topographic" layer) ──
# Same ground-truth source and reasoning as
# scripts/extract_vector_layers.py's build_structure_exclusion_mask --
# see that function's own header comment. Reimplemented here rather than
# imported: that module works over one fixed-zoom stitched mosaic, this
# service works per-tile across MIN_ZOOM..MAX_ZOOM, different enough
# shapes that sharing code would mean threading a mosaic-shaped
# abstraction through a service that doesn't otherwise need one.


@lru_cache(maxsize=1)
def _restored_structure_rings() -> tuple[tuple[tuple[float, float], ...], ...]:
    path = FEATURES_DIR / "SamoWeb_RestoredStatePlan_Overlay.geojson"
    if not path.is_file():
        return ()
    data = json.loads(path.read_text())
    rings: list[tuple[tuple[float, float], ...]] = []
    for feature in data["features"]:
        props = feature.get("properties") or {}
        fid = props.get("FID", props.get("id"))
        if fid in STRUCTURE_EXCLUSION_SKIP_FIDS:
            continue
        geom = feature["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            for ring in poly:
                rings.append(tuple((lon, lat) for lon, lat in ring))
    return tuple(rings)


def _lonlat_to_tile_px(lon: float, lat: float, z: int, x: int, y: int) -> tuple[float, float]:
    """Forward Web Mercator, local to tile (x, y) at zoom z -- same
    formula as extract_vector_layers.py's lonlat_to_pixel /
    samothrace-map.ts's projectWorld, parameterized over a variable
    zoom/tile-origin instead of a fixed mosaic. `y` here is standard XYZ
    (north-origin), matching the `y` this module's own /tiles endpoint
    already takes (see _tms_path's own comment on the TMS flip needed
    only for the on-disk file lookup, not for this math)."""
    n = 2**z * TILE_SIZE
    world_x = (lon + 180) / 360 * n
    lat_rad = math.radians(lat)
    world_y = (1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n
    return world_x - x * TILE_SIZE, world_y - y * TILE_SIZE


def _structure_buffer_px(z: int) -> int:
    """STRUCTURE_BUFFER_PX_AT_Z20, scaled so it covers the same
    real-world distance at every zoom level (pixels-per-meter doubles
    each zoom step) rather than the same pixel count."""
    return max(1, round(STRUCTURE_BUFFER_PX_AT_Z20 * (2 ** (z - STRUCTURE_BUFFER_REF_ZOOM))))


@lru_cache(maxsize=4096)
def _restored_structure_raw_mask(z: int, x: int, y: int) -> Image.Image:
    """255 = inside a mapped Restored-plan structure footprint, 0 =
    elsewhere -- the RAW rasterized ground-truth polygons, before the
    buffer step below. Its own debug tile layer (see
    "topographic-structures-raw") exists specifically so the footprint
    polygons' own placement/accuracy can be checked in isolation from
    how much the buffer subsequently grows them by."""
    img = Image.new("L", (TILE_SIZE, TILE_SIZE), 0)
    draw = ImageDraw.Draw(img)
    rings = _restored_structure_rings()
    for ring in rings:
        pts = [_lonlat_to_tile_px(lon, lat, z, x, y) for lon, lat in ring]
        # Cheap reject: every point of this ring falls outside the tile
        # (plus a little slack for the buffer the caller may apply next)
        # -- skip the draw call entirely rather than let PIL clip
        # thousands of off-tile rings.
        if any(-64 <= px <= TILE_SIZE + 64 and -64 <= py <= TILE_SIZE + 64 for px, py in pts):
            if len(pts) >= 3:
                draw.polygon(pts, fill=255)
    return img


@lru_cache(maxsize=4096)
def _restored_structure_buffered_mask(z: int, x: int, y: int) -> Image.Image:
    """255 = inside a mapped structure footprint OR its buffer margin, 0
    = elsewhere -- same raw mask as above, grown by _structure_buffer_px
    via a grayscale MaxFilter (dilation) rather than scipy.ndimage, to
    avoid adding a new dependency to this already-minimal service for
    one mask. This is the actual exclusion zone "topographic" (below)
    subtracts -- its own debug tile layer
    ("topographic-structures-buffered") shows exactly how much bigger
    this is than the raw footprint, which the buffer's own real purpose
    (covering decorative wall hachure just outside the footprint -- see
    STRUCTURE_BUFFER_PX_AT_Z20's own comment) makes hard to judge from
    the raw mask alone."""
    img = _restored_structure_raw_mask(z, x, y)
    if img.getbbox() is None:
        return img  # nothing in view on this tile -- buffering an all-zero mask is a no-op, skip the filter call
    buf = _structure_buffer_px(z)
    return img.filter(ImageFilter.MaxFilter(buf * 2 + 1)) if buf > 0 else img


@lru_cache(maxsize=4096)
def _restored_not_structure_mask(z: int, x: int, y: int) -> Image.Image:
    """255 = terrain (keep), 0 = inside/near a mapped Restored-plan
    structure footprint (exclude) -- just the buffered mask above,
    inverted."""
    return _restored_structure_buffered_mask(z, x, y).point(lambda p: 0 if p > 0 else 255)


def _mask_debug_png(mask: Image.Image) -> bytes:
    """Same black(mask)/white(not-mask) convention
    extract_vector_layers.py's own save_stage_mask uses for its pipeline
    -stage PNGs, so a structure-exclusion debug tile reads consistently
    with the Restored/Waterways pipeline-stage layers right next to it in
    the panel."""
    rgb = Image.new("RGB", mask.size, (255, 255, 255))
    rgb.paste((20, 20, 20), mask=mask)
    return _encode_png(rgb)


@lru_cache(maxsize=4096)
def _topographic_structures_raw_png(z: int, x: int, y: int) -> bytes:
    return _mask_debug_png(_restored_structure_raw_mask(z, x, y))


@lru_cache(maxsize=4096)
def _topographic_structures_buffered_png(z: int, x: int, y: int) -> bytes:
    return _mask_debug_png(_restored_structure_buffered_mask(z, x, y))


@lru_cache(maxsize=1)
def _blank_png() -> bytes:
    """A plain, opaque white tile -- same (255, 255, 255, 255) the
    Restored/Actual plan tiles' own paper background already renders as
    (confirmed directly: the single most common pixel in every sampled
    tile that has ANY margin around its ink). One tile, memoized once
    (maxsize=1, no z/x/y in the cache key -- a blank tile looks the same
    everywhere, nothing to vary by position/zoom), reused for every
    request rather than redrawing an identical image per tile."""
    img = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (255, 255, 255, 255))
    return _encode_png(img)


@lru_cache(maxsize=4096)
def _topographic_png(z: int, x: int, y: int) -> bytes | None:
    """Restored State Plan's own raw tile with mapped structure
    footprints masked out -- Restored-only, no Actual-plan dependency at
    all (2026-10-15, see this module's own header comment for why this
    changed from a cross-plan diff)."""
    restored = _load_rgba(PLAN_DIRS["restored"], z, x, y)
    if restored is None:
        return None
    not_structure = _restored_not_structure_mask(z, x, y)
    out = restored.copy()
    out.putalpha(ImageChops.multiply(out.getchannel("A"), not_structure))
    return _encode_png(out)


@lru_cache(maxsize=4096)
def _structures_png(plan_key: str, z: int, x: int, y: int) -> bytes | None:
    plan = _load_rgba(PLAN_DIRS[plan_key], z, x, y)
    if plan is None:
        return None
    topo_bytes = _shared_diff_mask_png(z, x, y)
    if topo_bytes is None:
        return _encode_png(plan)  # nothing to subtract -- whole tile is "structure"

    with Image.open(io.BytesIO(topo_bytes)) as topo:
        topo_alpha = topo.getchannel("A")
    not_topo = topo_alpha.point(lambda p: 0 if p > 0 else 255)

    out = plan.copy()
    out.putalpha(ImageChops.multiply(out.getchannel("A"), not_topo))
    return _encode_png(out)


@lru_cache(maxsize=8192)
def _raw_png(layer: str, z: int, x: int, y: int) -> bytes | None:
    base = RAW_LAYER_DIRS.get(layer)
    if base is None:
        return None
    path = _tms_path(base, z, x, y)
    if not path.is_file():
        return None
    return path.read_bytes()


@app.get("/layers")
def layers():
    return {"layers": LAYERS, "minZoom": MIN_ZOOM, "maxZoom": MAX_ZOOM, "tileSize": TILE_SIZE}


@app.get("/tiles/{layer}/{z}/{x}/{y}.png")
def tile(layer: str, z: int, x: int, y: int):
    if layer not in LAYER_IDS or not (MIN_ZOOM <= z <= MAX_ZOOM):
        return Response(status_code=404)

    if layer == "blank":
        data = _blank_png()
    elif layer == "topographic":
        data = _topographic_png(z, x, y)
    elif layer == "actual-structures":
        data = _structures_png("actual", z, x, y)
    elif layer == "restored-structures":
        data = _structures_png("restored", z, x, y)
    elif layer == "topographic-structures-raw":
        data = _topographic_structures_raw_png(z, x, y)
    elif layer == "topographic-structures-buffered":
        data = _topographic_structures_buffered_png(z, x, y)
    else:
        data = _raw_png(layer, z, x, y)

    if data is None:
        return Response(status_code=404)
    return Response(content=data, media_type="image/png", headers=PNG_HEADERS)
