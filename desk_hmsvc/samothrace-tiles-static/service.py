"""Samothrace Tiles (static) hmsvc -- serves the public, deployable
subset of desk_hmsvc/samothrace-tiles/'s own raster layers as plain
static files, with NO per-request computation of any kind. Exists
specifically for the aws_am_samothrace deployment (see that project's
own ae-sam-requests/ for the originating request): a standalone S3 +
CloudFront deployment has no live compute tier at all for these layers,
so everything this service answers for has to already be bytes on disk
before any request ever arrives.

Seven layers, three different kinds of "already just bytes":

  - "topographic", "restored-structures" -- the two layers
    desk_hmsvc/samothrace-tiles/ computes live via PIL per z/x/y
    request. Pre-baked once by scripts/bake_static_tiles.py into
    Data/mapTilesStatic/<layer-id>/<z>/<x>/<y>.png (plain XYZ, no TMS
    flip -- see that script's own header comment for why this
    directory's own layout doesn't need to match the raw tile sets'
    on-disk convention).
  - "aerial", "initial-map", "restored-monuments", "restored-plan-raw"
    -- already-static passthrough tiles that desk_hmsvc/samothrace-tiles/
    itself also reads straight off disk with no computation; this
    service reads the SAME Data/mapTiles/ directories, read-only, no
    copy needed (nothing here ever writes to them).
  - "blank" -- a single pre-baked (255,255,255,255) tile
    (Data/mapTilesStatic/blank.png), served for any z/x/y -- a blank
    tile looks the same everywhere, see
    scripts/bake_static_tiles.py's own bake_blank_tile.

Deliberately NOT the full samothrace-tiles catalog: the two
"pipeline-topographic" debug layers (topographic-structures-raw,
topographic-structures-buffered -- intermediate steps in how
"topographic" itself gets computed) are debug-only and stay live-only
on desk_hmsvc/samothrace-tiles/, not duplicated here, since a public
deployment has no use for them.

desk_hmsvc/samothrace-tiles/ itself is left completely unmodified by
this split: desk_widgets/samothrace-map/'s own layer panel depends on
that service's full, unmodified `/layers` response, including all
seven of the ids this service also answers for. This service exists
ALONGSIDE it, as an additional, independent origin for the subset
aws_am_samothrace actually wants to deploy -- not a replacement, and
not the one-true-owner of these ids the way a from-scratch design might
prefer; see the originating ae-sam-requests doc for the full reasoning.

Run standalone for development: `uvicorn service:app --reload --port 8100`
(from this directory) -- DESK_PROJECT_DIR then needs to be set manually
since there's no Desk process to set it for you; see `_project_dir()`.
Requires `python3 scripts/bake_static_tiles.py` (run once from the
project root) to have already populated Data/mapTilesStatic/ -- the two
baked layers 404 until that's been run.
"""
import os
import re
from pathlib import Path

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware

TILE_SIZE = 256
MIN_ZOOM = 17
MAX_ZOOM = 22


def _project_dir() -> Path:
    raw = os.environ.get("DESK_PROJECT_DIR")
    return Path(raw).resolve() if raw else Path.cwd().resolve()


PROJECT_DIR = _project_dir()
TILES_DIR = PROJECT_DIR / "Data" / "mapTiles"
STATIC_DIR = PROJECT_DIR / "Data" / "mapTilesStatic"

# Passthrough layers -- the SAME on-disk directories
# desk_hmsvc/samothrace-tiles/service.py's own PLAN_DIRS/RAW_LAYER_DIRS
# point at, read here too (read-only, same files, no copy). TMS-style
# on disk (y counted from the south), same _tms_path flip that
# service's own copy uses.
PASSTHROUGH_DIRS = {
    "aerial": TILES_DIR / "SamoWebsite_AerialImagery_3857",
    "initial-map": TILES_DIR / "SamoWebsite_InitialMap_3857",
    "restored-monuments": TILES_DIR / "SamoWebsite_RestoredStateMonuments_3857",
    "restored-plan-raw": TILES_DIR / "SamoWebsite_RestoredStatePlan_3857",
}

# Pre-baked layers -- plain XYZ on disk (no TMS flip needed, see
# scripts/bake_static_tiles.py's own header comment), written once by
# that script.
BAKED_LAYER_IDS = {"topographic", "restored-structures"}

LAYER_IDS = set(PASSTHROUGH_DIRS) | BAKED_LAYER_IDS | {"blank"}

# Same shape (id/label/group/order/defaultVisible) as the matching
# entries in desk_hmsvc/samothrace-tiles/service.py's own LAYERS --
# kept byte-for-byte identical on purpose: desk_widgets/layer-stack/ and
# desk_widgets/layered-map/ merge this service's /layers response with
# that one's, and expect the same labels/grouping/compositing order for
# whichever ids live on each side.
LAYERS = [
    {"id": "aerial", "label": "Aerial Imagery", "group": "imagery", "order": 0, "defaultVisible": False},
    {"id": "topographic", "label": "Topographic", "group": "imagery", "order": 1, "defaultVisible": True},
    {"id": "blank", "label": "Blank", "group": "imagery", "order": 2, "defaultVisible": False},
    {"id": "initial-map", "label": "Initial Map", "group": "imagery", "order": 3, "defaultVisible": False},
    {"id": "restored-structures", "label": "Restored State — Structures", "group": "restored", "order": 21, "defaultVisible": False},
    {"id": "restored-monuments", "label": "Restored State — Monuments", "group": "restored", "order": 31, "defaultVisible": False},
    {"id": "restored-plan-raw", "label": "00 — Restored raw (unmasked)", "group": "pipeline-topographic", "order": 0, "defaultVisible": False},
]

# Real lon/lat extent per layer, read from each source tile set's own
# tilemapresource.xml -- same mechanism and rationale as
# desk_hmsvc/samothrace-tiles/service.py's own BOUNDS_SOURCE_DIR/
# _layer_bounds (see that module's own comment for the full "why" --
# Layered Map composites this alongside regional data from elsewhere
# entirely and has no other way to know where on earth any of this is).
# Omits "blank" (no real "where") and "initial-map" (no
# tilemapresource.xml on disk), same as that service's own omissions.
BOUNDS_SOURCE_DIR = {
    "aerial": PASSTHROUGH_DIRS["aerial"],
    "restored-monuments": PASSTHROUGH_DIRS["restored-monuments"],
    "restored-structures": PASSTHROUGH_DIRS["restored-plan-raw"],
    "topographic": PASSTHROUGH_DIRS["restored-plan-raw"],
    "restored-plan-raw": PASSTHROUGH_DIRS["restored-plan-raw"],
}

_BOUNDING_BOX_RE = re.compile(
    r'<BoundingBox\s+minx="([-0-9.]+)"\s+miny="([-0-9.]+)"\s+maxx="([-0-9.]+)"\s+maxy="([-0-9.]+)"'
)


def _parse_tilemapresource_bounds(source_dir: Path) -> dict | None:
    xml_path = source_dir / "tilemapresource.xml"
    if not xml_path.is_file():
        return None
    try:
        text = xml_path.read_text()
    except OSError:
        return None
    m = _BOUNDING_BOX_RE.search(text)
    if not m:
        return None
    west, south, east, north = (float(g) for g in m.groups())
    return {"west": west, "south": south, "east": east, "north": north}


def _layer_bounds(layer_id: str) -> dict | None:
    source_dir = BOUNDS_SOURCE_DIR.get(layer_id)
    if source_dir is None:
        return None
    return _parse_tilemapresource_bounds(source_dir)


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

PNG_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable"}


def _passthrough_tms_path(base: Path, z: int, x: int, y: int) -> Path:
    # Same TMS (y counted from the south) on-disk convention
    # desk_hmsvc/samothrace-tiles/service.py's own _tms_path uses --
    # these are literally the same files.
    y_tms = (2**z) - 1 - y
    return base / str(z) / str(x) / f"{y_tms}.png"


@app.get("/layers")
def layers():
    enriched = [{**entry, "bounds": _layer_bounds(entry["id"])} for entry in LAYERS]
    return {"layers": enriched, "minZoom": MIN_ZOOM, "maxZoom": MAX_ZOOM, "tileSize": TILE_SIZE}


@app.get("/tiles/{layer}/{z}/{x}/{y}.png")
def tile(layer: str, z: int, x: int, y: int):
    if layer not in LAYER_IDS or not (MIN_ZOOM <= z <= MAX_ZOOM):
        return Response(status_code=404)

    if layer == "blank":
        path = STATIC_DIR / "blank.png"
    elif layer in BAKED_LAYER_IDS:
        path = STATIC_DIR / layer / str(z) / str(x) / f"{y}.png"
    else:
        path = _passthrough_tms_path(PASSTHROUGH_DIRS[layer], z, x, y)

    if not path.is_file():
        return Response(status_code=404)
    return Response(content=path.read_bytes(), media_type="image/png", headers=PNG_HEADERS)
