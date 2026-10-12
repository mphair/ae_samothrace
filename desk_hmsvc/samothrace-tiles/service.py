"""Samothrace tile service (hmsvc) -- serves local map tiles over plain
HTTP, replacing the old approach of base64-shuttling each tile through
the Bridge API's `desk.documents` capability one round trip at a time.
Real HTTP means the browser's own cache does the work instead.

Also synthesizes two new kinds of layer the raw source data never
separated out on its own (see "Topographic extraction" below):

  - "topographic": the site's underlying terrain drawing (contour-ish
    lines, paths, ground texture) that both the Actual State Plan and
    Restored State Plan tiles share.
  - "<plan>-structures": each plan's own tiles with the shared
    topographic content subtracted out, leaving just that plan's own
    building/structure line work.

Run standalone for development: `uvicorn service:app --reload --port 8099`
(from this directory) -- DESK_PROJECT_DIR then needs to be set manually
since there's no Desk process to set it for you; see `_project_dir()`.
"""
import io
import os
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageChops, ImageFilter

TILE_SIZE = 256
MIN_ZOOM = 17
MAX_ZOOM = 22

# ── Topographic extraction tuning ──
# Both Actual/Restored State Plan tiles are independently-rendered raster
# line art over the same terrain, so their anti-aliased edges don't land
# on exactly the same pixels even where the underlying content is
# identical. A small blur before diffing (applied only to the comparison,
# never to the output pixels) absorbs that sub-pixel jitter; the
# tolerance is a max-per-channel-difference threshold on the *blurred*
# comparison. Both constants were picked by eyeballing the result against
# real tiles -- see the "Build samothrace-tiles hmsvc service" task notes
# for the before/after comparison that led here.
DIFF_BLUR_RADIUS = 1.0
DIFF_TOLERANCE = 40


def _project_dir() -> Path:
    raw = os.environ.get("DESK_PROJECT_DIR")
    return Path(raw).resolve() if raw else Path.cwd().resolve()


PROJECT_DIR = _project_dir()
TILES_DIR = PROJECT_DIR / "Data" / "mapTiles"

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
LAYERS = [
    {"id": "aerial", "label": "Aerial Imagery", "group": "imagery", "order": 0, "defaultVisible": False},
    {"id": "topographic", "label": "Topographic Base", "group": "shared", "order": 10, "defaultVisible": True},
    {"id": "actual-structures", "label": "Actual State — Structures", "group": "actual", "order": 20, "defaultVisible": True},
    {"id": "restored-structures", "label": "Restored State — Structures", "group": "restored", "order": 21, "defaultVisible": False},
    {"id": "actual-monuments", "label": "Actual State — Monuments", "group": "actual", "order": 30, "defaultVisible": True},
    {"id": "restored-monuments", "label": "Restored State — Monuments", "group": "restored", "order": 31, "defaultVisible": False},
]
# Validation set for /tiles/{layer}/... is deliberately wider than LAYERS
# (which only backs the /layers response, i.e. the main map widget's
# toggle panel) -- it also accepts the two raw-passthrough ids above so
# a debugging client can fetch them without them showing up as a
# user-facing layer option.
LAYER_IDS = {entry["id"] for entry in LAYERS} | {"actual-plan-raw", "restored-plan-raw"}

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
def _topographic_png(z: int, x: int, y: int) -> bytes | None:
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


@lru_cache(maxsize=4096)
def _structures_png(plan_key: str, z: int, x: int, y: int) -> bytes | None:
    plan = _load_rgba(PLAN_DIRS[plan_key], z, x, y)
    if plan is None:
        return None
    topo_bytes = _topographic_png(z, x, y)
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

    if layer == "topographic":
        data = _topographic_png(z, x, y)
    elif layer == "actual-structures":
        data = _structures_png("actual", z, x, y)
    elif layer == "restored-structures":
        data = _structures_png("restored", z, x, y)
    else:
        data = _raw_png(layer, z, x, y)

    if data is None:
        return Response(status_code=404)
    return Response(content=data, media_type="image/png", headers=PNG_HEADERS)
