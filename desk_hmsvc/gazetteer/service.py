"""Gazetteer hmsvc -- geocoding queries over Data/gazetteer/gazetteer.geojson
(see that directory's own build_gazetteer.py for how the 304 named
places/seas/islands/rivers in it were assembled from
Data/naturalEarth/ and Data/OpenStreetMap-geocoding/).

Three query shapes, the three things "geocoding" is usually taken to
mean plus the one this project specifically asked for:

- **Forward geocoding** (`GET /geocode?q=...`): name -> location(s).
- **Reverse geocoding** (`GET /reverse?lon=...&lat=...`): location ->
  nearest named thing(s), with real (haversine) distance in km.
- **"Things [of a type] in this polygon"** (`GET /within` for a plain
  bbox, `POST /within` for an arbitrary GeoJSON polygon): spatial
  containment, optionally filtered by `type`.

This is a *local* gazetteer service -- every query runs entirely over
the already-vendored, already-cited data this project gathered (see
Data/naturalEarth/README.md and Data/OpenStreetMap-geocoding/README.md
for where each entry's name actually came from and what license
applies), not a live proxy to Nominatim or any other third-party
geocoder. No network calls, no rate limit, works offline, and every
answer traces back to a `source_layer` property any caller can follow
to the underlying data's own README.

Run standalone for development: `uvicorn service:app --reload --port 8097`
(from this directory) -- DESK_PROJECT_DIR then needs to be set manually
since there's no Desk process to set it for you; see `_project_dir()`.
"""
import json
import math
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from shapely.geometry import Point, shape


def _project_dir() -> Path:
    raw = os.environ.get("DESK_PROJECT_DIR")
    return Path(raw).resolve() if raw else Path.cwd().resolve()


PROJECT_DIR = _project_dir()
GAZETTEER_PATH = PROJECT_DIR / "Data" / "gazetteer" / "gazetteer.geojson"

EARTH_RADIUS_KM = 6371.0088

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def _load_entries() -> list[dict]:
    """Re-read on every call -- same "cheap, not worth caching" reasoning
    as desk_hmsvc/natural-earth-map/service.py's own _read_metadata: a
    fresh build_gazetteer.py run is picked up immediately, and this file
    is small (a few hundred point features)."""
    if not GAZETTEER_PATH.is_file():
        return []
    try:
        fc = json.loads(GAZETTEER_PATH.read_text())
    except (OSError, ValueError):
        return []
    entries = []
    for feat in fc.get("features", []):
        lon, lat = feat["geometry"]["coordinates"]
        entries.append({**feat["properties"], "lon": lon, "lat": lat})
    return entries


def _haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1, math.sqrt(a)))


@app.get("/types")
def types():
    """Distinct `type` values currently in the gazetteer, with counts --
    lets a caller (the Gazetteer widget, or anyone else) build a type
    filter without hardcoding the vocabulary build_gazetteer.py happens
    to produce today."""
    counts: dict[str, int] = {}
    for entry in _load_entries():
        counts[entry["type"]] = counts.get(entry["type"], 0) + 1
    return {"types": [{"type": t, "count": c} for t, c in sorted(counts.items())]}


@app.get("/list")
def list_entries(type: Optional[str] = None):
    entries = _load_entries()
    if type:
        entries = [e for e in entries if e["type"] == type]
    return {"entries": entries, "count": len(entries)}


@app.get("/geocode")
def geocode(q: str = Query(..., min_length=1), type: Optional[str] = None, limit: int = 20):
    """Forward geocoding: name -> location(s). Case-insensitive
    substring match, ranked exact-match first, then starts-with, then
    plain contains -- each tier alphabetical within itself. Good enough
    for a few hundred entries with no index; revisit if this gazetteer
    ever grows enough for that to matter."""
    needle = q.strip().lower()
    entries = _load_entries()
    if type:
        entries = [e for e in entries if e["type"] == type]

    def rank(entry):
        name = entry["name"].lower()
        if name == needle:
            return (0, name)
        if name.startswith(needle):
            return (1, name)
        return (2, name)

    matches = [e for e in entries if needle in e["name"].lower()]
    matches.sort(key=rank)
    return {"query": q, "entries": matches[:limit], "count": len(matches)}


@app.get("/reverse")
def reverse(lon: float, lat: float, limit: int = 5, type: Optional[str] = None):
    """Reverse geocoding: location -> nearest named thing(s), with real
    (haversine great-circle) distance in km -- not the equirectangular
    approximation scripts/natural_earth_common.py's own bounding-box
    math uses (that approximation is fine for a one-off "is this bbox
    about right" check; a per-query distance a caller might actually
    sort or display deserves the real formula, and it's cheap enough to
    compute per-request over a few hundred entries)."""
    entries = _load_entries()
    if type:
        entries = [e for e in entries if e["type"] == type]
    for e in entries:
        e["distance_km"] = round(_haversine_km(lon, lat, e["lon"], e["lat"]), 3)
    entries.sort(key=lambda e: e["distance_km"])
    return {"lon": lon, "lat": lat, "entries": entries[:limit]}


class WithinBody(BaseModel):
    polygon: dict
    type: Optional[str] = None


def _within_polygon(poly_geojson: dict, type_filter: Optional[str]) -> list[dict]:
    try:
        poly = shape(poly_geojson)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid polygon geometry: {exc}")
    if not poly.is_valid:
        poly = poly.buffer(0)
    entries = _load_entries()
    if type_filter:
        entries = [e for e in entries if e["type"] == type_filter]
    return [e for e in entries if poly.contains(Point(e["lon"], e["lat"]))]


@app.post("/within")
def within_polygon(body: WithinBody):
    """'Things [of a type] in this polygon' -- the general case, an
    arbitrary GeoJSON Polygon/MultiPolygon geometry in the request body
    (not query-string friendly, hence POST). `polygon` is a bare
    geometry object (`{"type": "Polygon", "coordinates": [...]}`), not
    a full Feature/FeatureCollection."""
    matches = _within_polygon(body.polygon, body.type)
    return {"entries": matches, "count": len(matches)}


@app.get("/within")
def within_bbox(west: float, south: float, east: float, north: float, type: Optional[str] = None):
    """'Things [of a type] in this polygon' -- the common-case
    convenience form, a plain axis-aligned box via four query params
    instead of a POSTed geometry. Internally just a rectangular
    polygon through the same `_within_polygon` the general POST
    endpoint uses, so both stay consistent by construction."""
    rect = {
        "type": "Polygon",
        "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    }
    matches = _within_polygon(rect, type)
    return {"entries": matches, "count": len(matches)}
