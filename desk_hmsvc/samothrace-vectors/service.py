"""Samothrace Vectors hmsvc -- serves the vector-data/geolocation/
metadata in Data/samothraceVectors/ (see
scripts/build_samothrace_vectors.py) over plain HTTP, for the Layer
Stack and Layered Map widgets.

2026-10-20: built directly after a user asked why several Samothrace
Map layers (Extracted Contours, Restored State -- Waterway, the
Restored State Plan's own structure footprints) didn't show up in Layer
Stack -- the answer was that none of them were ever served by any
hmsvc at all; Samothrace Map reads them straight off disk via the
Bridge API's `fs` capability (contours/structures as real GeoJSON,
Waterway as a hand-curated raster PNG mask). This service is the fix
for that gap, SPECIFICALLY for those three -- see
scripts/build_samothrace_vectors.py's own header comment for exactly
what each one needed (a property-based 3-way split for Contours, a
one-time PNG-mask-to-best-effort-MultiPolygon conversion for Waterway,
a straight copy for Structures). Regios (Regio I so far) were added the
same day in a second pass, same PNG-mask-to-polygon conversion as
Waterway, after the user noticed one was missing from the first round
(a real oversight, not a deliberate exclusion -- see that script's own
header comment). Samothrace Map itself is NOT changed to read from this
service -- it keeps reading its own files directly, unaffected; this
service exists purely so Layer Stack/Layered Map can see this data too,
per that request's own explicit scope.

Same metadata.json-driven convention and endpoint shape as
desk_hmsvc/natural-earth-map/service.py (see that file's own header
comment for the full "why self-discovering, not hand-maintained"
reasoning) -- deliberately just ONE data directory here, not a
DATA_DIRS list, since unlike natural-earth-map (which merges a base
regional directory with a separately-grown OpenStreetMap-geocoding
directory) this service only ever has the one generating script and
the one output directory; a second directory can be added here the
same way natural-earth-map's own DATA_DIRS grew a second entry, if a
future layer source needs one.

Run standalone for development: `uvicorn service:app --reload --port 8097`
(from this directory) -- DESK_PROJECT_DIR then needs to be set manually
since there's no Desk process to set it for you; see `_project_dir()`.
"""
import json
import os
import re
from pathlib import Path

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware


def _project_dir() -> Path:
    raw = os.environ.get("DESK_PROJECT_DIR")
    return Path(raw).resolve() if raw else Path.cwd().resolve()


PROJECT_DIR = _project_dir()
DATA_DIR = PROJECT_DIR / "Data" / "samothraceVectors"

# Layer ids are filenames with no extension -- this pattern is just a
# defensive check before touching the filesystem with a
# request-supplied value, not a meaningful allowlist of its own (the
# real allowlist is "is this id present in metadata.json's own layers
# list right now," checked in `data` below) -- same convention
# desk_hmsvc/natural-earth-map/service.py's own VALID_LAYER_ID uses.
VALID_LAYER_ID = re.compile(r"^[a-zA-Z0-9_]+$")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

# Short, not "immutable" -- this data can be regenerated at any time by
# re-running scripts/build_samothrace_vectors.py, and this service
# doesn't restart (so doesn't get a fresh port) when that happens. A
# short cache still saves the browser from re-fetching the same small
# GeoJSON files on every pan/zoom redraw within one session. Same value
# natural-earth-map's own GEOJSON_HEADERS already uses.
GEOJSON_HEADERS = {"Cache-Control": "public, max-age=60"}


def _read_json(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _metadata() -> dict:
    """Re-read Data/samothraceVectors/metadata.json on every call --
    cheap (one small JSON file), means a fresh
    build_samothrace_vectors.py run is picked up immediately with no
    restart needed, same reasoning as every other metadata.json-driven
    hmsvc in this project."""
    metadata = _read_json(DATA_DIR / "metadata.json")
    if metadata is None:
        return {"layers": [], "bounds": None, "center": None}
    return {
        "layers": metadata.get("layers", []),
        "bounds": metadata.get("bounds"),
        "center": metadata.get("center"),
    }


@app.get("/layers")
def layers():
    return _metadata()


@app.get("/data/{layer_id}.geojson")
def data(layer_id: str):
    if not VALID_LAYER_ID.match(layer_id):
        return Response(status_code=404)
    metadata = _read_json(DATA_DIR / "metadata.json")
    if metadata is None or not any(entry["id"] == layer_id for entry in metadata.get("layers", [])):
        return Response(status_code=404)
    path = DATA_DIR / f"{layer_id}.geojson"
    if not path.is_file():
        return Response(status_code=404)
    return Response(content=path.read_bytes(), media_type="application/geo+json", headers=GEOJSON_HEADERS)
