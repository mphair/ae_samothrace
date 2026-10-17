"""Bakes a user-locked-in rotate/scale/photo-angle adjustment (made live,
interactively, via the Agent Q&A tab's own 'adjust-image-transform'
question -- see samothrace-map-agent-qa-tab.ts's own header comment) into
a real TMS tile set under Data/mapTiles/, served by
desk_hmsvc/samothrace-tiles/service.py as an "imagery" layer.

Generalized over `<slug>`, not hardcoded to one photo -- this is meant to
be the first of several such imports (per the user's own framing). Each
import lives at:

    Data/mapSources/<slug>/source.<ext>    -- the uploaded photo, as-is
    Data/mapSources/<slug>/transform.json  -- the locked-in parameters
    Data/mapSources/<slug>/keys/<id>.png   -- optional, see extract_keys()

`transform.json` may also carry a "keys" list -- axis-aligned boxes (in
the photo's own unwarped pixel space) to crop out as their own standalone
images AND blank out of the main raster bake, e.g. a printed legend that
shouldn't pan/zoom with the map (served by hmsvc as a fixed-position
"Keys" layer instead -- see extract_keys()'s own docstring).

Pass which slug to process via this job's own config_path (see
tempui-installed-jobs.md): `{"project_dir": "...", "slug": "initial-map"}`.

## Why a single exact homography, not the previous piecewise-affine attempt

The previous version (desk-installed-jobs/samothrace-initial-map/, now
removed) auto-picked ~11 control points by visual inspection and fit a
piecewise-affine warp -- it didn't work well enough. This version drops
automatic alignment entirely: the USER interactively rotates/scales/
tilts the photo against the real map, live, via a plain CSS 3D
`transform` on an `<img>` overlay (see the widget's own code for that
half) -- no custom warping math needed for what they SEE. This job's
only job is to reproduce EXACTLY what they saw as a real pixel warp:

A CSS 3D transform applied to a flat element is mathematically a
projective transform -- fully determined by where its 4 corners land.
So: replicate the identical 4x4 matrix pipeline CSS itself composes for
`transform: perspective(p) rotateX(tiltY) rotateY(tiltX) rotate(rotate)
scale(s)` (scale innermost/applied-first, perspective outermost/applied
-last, matching CSS's own right-to-left function-list composition) over
the photo's own 4 corners, in WORLD-PIXEL units at REF_ZOOM (not screen
units -- the widget's own live preview recomputes an equivalent `s` in
screen-px for whatever zoom the user happens to be looking at, but the
STORED transform.json parameters, and everything in this job, stay
zoom-independent). Then `cv2.getPerspectiveTransform` -- exact for 4
point correspondences, not a least-squares fit -- turns those 4 corner
correspondences into one homography, applied via `cv2.warpPerspective`.
Nothing approximate: what the user locked in IS what gets baked in.
"""
import json
import math
import os
import shutil
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

TILE = 256
REF_ZOOM = 20
MIN_ZOOM = 17
MAX_ZOOM = 22

# Fixed "camera distance" for the perspective divide, expressed as a
# multiple of the image's own (already metersPerPhotoPx/userScale
# -scaled) larger dimension rather than an absolute pixel count -- this
# ratio is what actually determines how strong the tilt distortion looks
# for a given angle, and keeping it relative (not absolute) is exactly
# what makes the widget's own live CSS preview (computed in screen-px at
# whatever zoom the user's looking at) and this job's own bake (computed
# in world-px at REF_ZOOM) produce IDENTICAL visual distortion -- both
# are "2.5x the image's own current size," just in different units.
PERSPECTIVE_DISTANCE_MULTIPLIER = 2.5


def _project_dir_and_slug() -> tuple[Path, str]:
    try:
        config_path_global = CONFIG_PATH  # type: ignore[name-defined]  -- injected by Desk's own installed-job runner
    except NameError:
        config_path_global = None
    if not config_path_global:
        raise RuntimeError(
            "map-import-from-photo needs a config_path: "
            '{"project_dir": "...", "slug": "..."}'
        )
    config = json.loads(Path(config_path_global).read_text())
    project_dir = config.get("project_dir") or os.environ.get("DESK_PROJECT_DIR")
    if not project_dir:
        raise RuntimeError("config.json must set project_dir (installed jobs get neither a reliable cwd nor DESK_PROJECT_DIR)")
    slug = config.get("slug")
    if not slug:
        raise RuntimeError("config.json must set slug (which Data/mapSources/<slug>/ to process)")
    return Path(project_dir).resolve(), slug


def _camel_case(slug: str) -> str:
    """'initial-map' -> 'InitialMap' -- the tile-directory naming
    convention every other Data/mapTiles/SamoWebsite_<Name>_3857/
    directory already follows."""
    return "".join(word.capitalize() for word in slug.split("-"))


def project_world(lon: float, lat: float, zoom: int) -> tuple[float, float]:
    """Standard Web Mercator lon/lat -> world pixel -- same formula used
    throughout this project (scripts/extract_vector_layers.py's own
    lonlat_to_pixel, desk_hmsvc/samothrace-tiles/service.py's own
    _lonlat_to_tile_px), reimplemented here since neither exposes it as
    an import-safe standalone function."""
    n = (2 ** zoom) * TILE
    x = (lon + 180) / 360 * n
    lat_rad = math.radians(lat)
    y = (1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n
    return x, y


def world_px_per_meter(zoom: int, lat: float) -> float:
    """Inverse of the ~156543*cos(lat)/2**zoom meters-per-pixel formula
    this project's own hmsvc service.py already documents (STRUCTURE
    _BUFFER_PX_AT_Z20's own comment) -- used to turn metersPerPhotoPx
    into a world-pixel-at-REF_ZOOM scale factor."""
    meters_per_px = 156543.03392 * math.cos(math.radians(lat)) / (2 ** zoom)
    return 1.0 / meters_per_px


def corner_to_world(
    local_x: float,
    local_y: float,
    scale: float,
    rotate_deg: float,
    tilt_x_deg: float,
    tilt_y_deg: float,
    perspective: float,
    anchor_world: tuple[float, float],
) -> tuple[float, float]:
    """One photo-local point (origin at the photo's own center, photo
    -pixel units) through the exact same pipeline CSS's own
    `perspective(p) rotateX(tiltY) rotateY(tiltX) rotate(rotate) scale(s)`
    composes -- see this file's own header comment for why this is exact,
    not approximate. Returns a world-pixel-at-REF_ZOOM point."""
    x, y, z = local_x * scale, local_y * scale, 0.0

    # rotate(rotateDeg) -- in-plane, CSS/image Y-down convention (same
    # convention this whole project already uses for screen/tile space).
    rz = math.radians(rotate_deg)
    x, y = x * math.cos(rz) - y * math.sin(rz), x * math.sin(rz) + y * math.cos(rz)

    # rotateY(tiltXDeg) -- around the vertical axis, tilts left/right
    # edges toward/away from the viewer (changes x and z).
    ry = math.radians(tilt_x_deg)
    x, z = x * math.cos(ry) + z * math.sin(ry), -x * math.sin(ry) + z * math.cos(ry)

    # rotateX(tiltYDeg) -- around the horizontal axis, tilts top/bottom
    # edges toward/away from the viewer (changes y and z).
    rx = math.radians(tilt_y_deg)
    y, z = y * math.cos(rx) - z * math.sin(rx), y * math.sin(rx) + z * math.cos(rx)

    # perspective(p) -- CSS's own perspective divide.
    w = 1 - z / perspective
    x, y = x / w, y / w

    return anchor_world[0] + x, anchor_world[1] + y


def build_homography(transform: dict) -> tuple[np.ndarray, int, int, float, float]:
    """Returns (H, canvas_w, canvas_h, origin_x, origin_y) -- H maps
    photo-pixel coordinates directly to CANVAS-local pixel coordinates
    (already shifted so the canvas's own top-left is (0,0)), ready for
    cv2.warpPerspective. origin_x/origin_y are the canvas's own top-left
    corner in world-pixel-at-REF_ZOOM space, needed afterward to know
    which real tiles this raster covers."""
    w, h = transform["photoWidth"], transform["photoHeight"]
    anchor_world = project_world(transform["centerLon"], transform["centerLat"], REF_ZOOM)
    scale = transform["metersPerPhotoPx"] * transform["userScale"] * world_px_per_meter(REF_ZOOM, transform["centerLat"])
    perspective = PERSPECTIVE_DISTANCE_MULTIPLIER * max(w, h) * scale

    src_corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
    local_corners = [(0 - w / 2, 0 - h / 2), (w - w / 2, 0 - h / 2), (w - w / 2, h - h / 2), (0 - w / 2, h - h / 2)]
    world_corners = np.array(
        [
            corner_to_world(
                lx, ly, scale,
                transform["rotateDeg"], transform["tiltXDeg"], transform["tiltYDeg"],
                perspective, anchor_world,
            )
            for lx, ly in local_corners
        ],
        dtype=np.float64,
    )

    origin_x, origin_y = world_corners.min(axis=0)
    canvas_w = int(math.ceil(world_corners[:, 0].max() - origin_x))
    canvas_h = int(math.ceil(world_corners[:, 1].max() - origin_y))
    dst_corners = (world_corners - np.array([origin_x, origin_y])).astype(np.float32)

    homography = cv2.getPerspectiveTransform(src_corners, dst_corners)
    return homography, canvas_w, canvas_h, origin_x, origin_y


def extract_keys(photo: Image.Image, keys: list[dict], keys_dir: Path) -> Image.Image:
    """`transform.json`'s own optional "keys" list -- axis-aligned boxes
    in the ORIGINAL, unwarped photo's own pixel space (simplest possible
    thing to specify, and simplest to crop: a plain `Image.crop`, no
    homography involved at all since this runs BEFORE that's built).
    For each one: crop it out to its own standalone PNG under
    `keys_dir/<id>.png` (served by hmsvc's own `/key/<slug>/<id>.png`,
    picked up by the widget's "Keys" layer-panel group -- see that
    group's own comment in samothrace-map.ts for why it's rendered as a
    fixed-screen-position overlay instead of a geo-tied tile layer: a
    printed legend box has no real-world lon/lat of its own). Returns a
    COPY of `photo` with the relevant region(s) flat-filled, so the
    warped/tiled main raster doesn't show it a second time -- "extract
    INTO its own layer," not "also still baked into the map." The fill
    color is sampled from a point just above each masked box (assumed
    blank paper) rather than hardcoded white, so the cutout blends into
    the surrounding paper tone instead of reading as an obvious
    rectangle.

    The single `x0/y0/x1/y1` box is always what gets CROPPED into the
    standalone key PNG -- generous margins there are harmless (and often
    nicer-looking) since it's just a small reference image. What gets
    MASKED off the main raster is a SEPARATE, optional `maskBoxes` list
    (each `{x0,y0,x1,y1}`) -- defaults to `[the single box]` when absent,
    but can be one or more TIGHTER sub-rectangles instead, for a legend
    that isn't itself a clean rectangle in the photo (2026-10-17, found
    live: the first version's one generous box also blanked out a real
    stretch of river, a "regio" arrow+label pointing at it, and the top
    edge of an unrelated labeled square that all happened to sit inside
    that same bounding box, in the gap/margin around the actual legend
    text -- none of those are part of the legend and shouldn't have been
    touched at all)."""
    if not keys:
        return photo
    keys_dir.mkdir(parents=True, exist_ok=True)
    masked = photo.copy()
    draw = ImageDraw.Draw(masked)
    for key in keys:
        crop_box = (key["x0"], key["y0"], key["x1"], key["y1"])
        photo.crop(crop_box).save(keys_dir / f"{key['id']}.png")
        mask_boxes = key.get("maskBoxes") or [key]
        for mb in mask_boxes:
            box = (mb["x0"], mb["y0"], mb["x1"], mb["y1"])
            sample_x = max(0, min(photo.width - 1, box[0]))
            sample_y = max(0, box[1] - 20)
            fill = photo.getpixel((sample_x, sample_y))
            draw.rectangle(box, fill=fill)
    return masked


def rasterize(photo: Image.Image, homography: np.ndarray, canvas_w: int, canvas_h: int) -> Image.Image:
    photo_bgr = cv2.cvtColor(np.asarray(photo), cv2.COLOR_RGB2BGR)
    warped_bgr = cv2.warpPerspective(photo_bgr, homography, (canvas_w, canvas_h))
    warped_rgb = cv2.cvtColor(warped_bgr, cv2.COLOR_BGR2RGB)

    alpha_src = np.full((photo.height, photo.width), 255, dtype=np.uint8)
    alpha = cv2.warpPerspective(alpha_src, homography, (canvas_w, canvas_h))

    rgba = np.dstack([warped_rgb, alpha])
    return Image.fromarray(rgba, mode="RGBA")


def write_tiles(raster: Image.Image, origin_x: float, origin_y: float, output_dir: Path) -> int:
    """Same TMS-slicing approach already proven working in the previous
    version of this job -- see that one's own git history for the
    reasoning; unchanged here beyond taking `output_dir` as a parameter
    instead of a hardcoded constant, so this job is reusable per-slug."""
    if output_dir.is_dir():
        shutil.rmtree(output_dir)
    written = 0
    for zoom in range(MIN_ZOOM, MAX_ZOOM + 1):
        scale = 2 ** (zoom - REF_ZOOM)
        if scale != 1:
            w = max(1, round(raster.width * scale))
            h = max(1, round(raster.height * scale))
            resample = Image.LANCZOS if scale < 1 else Image.BICUBIC
            zoom_raster = raster.resize((w, h), resample)
        else:
            zoom_raster = raster
        zoom_origin_x = origin_x * scale
        zoom_origin_y = origin_y * scale

        tile_x0 = int(zoom_origin_x // TILE)
        tile_y0 = int(zoom_origin_y // TILE)
        tile_x1 = int((zoom_origin_x + zoom_raster.width) // TILE) + 1
        tile_y1 = int((zoom_origin_y + zoom_raster.height) // TILE) + 1

        aligned_w = (tile_x1 - tile_x0 + 1) * TILE
        aligned_h = (tile_y1 - tile_y0 + 1) * TILE
        aligned = Image.new("RGBA", (aligned_w, aligned_h), (0, 0, 0, 0))
        paste_x = int(round(zoom_origin_x - tile_x0 * TILE))
        paste_y = int(round(zoom_origin_y - tile_y0 * TILE))
        aligned.paste(zoom_raster, (paste_x, paste_y), zoom_raster)

        for xi in range(tile_x0, tile_x1 + 1):
            for yi in range(tile_y0, tile_y1 + 1):
                left = (xi - tile_x0) * TILE
                top = (yi - tile_y0) * TILE
                tile = aligned.crop((left, top, left + TILE, top + TILE))
                if tile.getbbox() is None:
                    continue
                y_tms = (2 ** zoom) - 1 - yi
                out_path = output_dir / str(zoom) / str(xi) / f"{y_tms}.png"
                out_path.parent.mkdir(parents=True, exist_ok=True)
                tile.save(out_path)
                written += 1
    return written


def main() -> None:
    project_dir, slug = _project_dir_and_slug()
    source_dir = project_dir / "Data" / "mapSources" / slug

    transform_path = source_dir / "transform.json"
    if not transform_path.is_file():
        raise FileNotFoundError(f"no transform.json for slug {slug!r}: {transform_path}")
    transform = json.loads(transform_path.read_text())

    source_candidates = [p for p in source_dir.iterdir() if p.stem == "source"]
    if not source_candidates:
        raise FileNotFoundError(f"no source.* photo for slug {slug!r} in {source_dir}")
    photo = Image.open(source_candidates[0]).convert("RGB")
    print(f"slug={slug!r} source={source_candidates[0].name} photo={photo.size} transform={transform}")

    keys = transform.get("keys", [])
    photo_for_raster = extract_keys(photo, keys, source_dir / "keys")
    if keys:
        print(f"extracted {len(keys)} key region(s) to {source_dir / 'keys'}")

    homography, canvas_w, canvas_h, origin_x, origin_y = build_homography(transform)
    print(f"canvas: {canvas_w}x{canvas_h} at world-px origin ({origin_x:.1f}, {origin_y:.1f}), zoom {REF_ZOOM}")

    raster = rasterize(photo_for_raster, homography, canvas_w, canvas_h)

    layer_id = transform.get("layerId", slug)
    output_dir = project_dir / "Data" / "mapTiles" / f"SamoWebsite_{_camel_case(layer_id)}_3857"
    tile_count = write_tiles(raster, origin_x, origin_y, output_dir)
    print(f"wrote {tile_count} tiles to {output_dir} across zoom {MIN_ZOOM}..{MAX_ZOOM}")


main()
