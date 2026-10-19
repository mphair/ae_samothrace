#!/usr/bin/env python3
"""Finds every island in the Samothrace bounding box that isn't much
smaller than Samothrace itself, and looks up each one's name via
OpenStreetMap (Nominatim) -- answering "does Natural Earth's
minor-islands-only naming gap (see Data/naturalEarth/README.md) also
apply to islands Samothrace's own size, and if not, where do their
names actually live?"

## Why this enumerates from Natural Earth, not from OpenStreetMap

The obvious tool for "find every OSM feature tagged place=island in a
bounding box" is the Overpass API -- but every Overpass endpoint tried
(overpass-api.de directly, and five public mirrors: kumi.systems,
private.coffee, monicz.dev, openstreetmap.fr, openstreetmap.ru,
nchc.org.tw) was unreachable or actively rejected requests (406/500/
timeout) from this environment. Nominatim (nominatim.openstreetmap.org)
*is* reachable, but it has no "enumerate everything of type X in this
box" endpoint -- only forward search (by name) and reverse geocoding
(by point).

So the enumeration step here uses Natural Earth's own already-fetched,
already-validated land + minor_islands polygons (Data/naturalEarth/) --
not OSM -- to answer "what distinct landmasses exist in this box, and
how big is each one." This is arguably *more* robust than an
Overpass-based enumeration would have been anyway: it can't miss an
island because an OSM mapper forgot to tag place=island on it, and it
reuses geometry already vetted for this project. OpenStreetMap's only
job in this script is the thing Natural Earth genuinely can't do:
supply each landmass's *name*.

## Method

1. Decompose every polygon *part* of ne_10m_land.geojson and
   ne_10m_minor_islands.geojson (a MultiPolygon's each element is one
   contiguous landmass -- mainland Europe is lumped with every
   connected bit of Europe into one giant part, each separate island is
   its own part) and compute each part's area in km^2 via a local
   equirectangular-projected shoelace formula (same approximation
   family natural_earth_common.py's bounding-box math already uses --
   not survey-grade, but it reproduced Samothrace's real-world area
   (~178 km^2) to within 4%, which is what calibration below checks).
2. Drop any part whose bounding box touches the Samothrace bbox's own
   edge (within EDGE_TOUCH_EPS_DEG) -- a proxy for "this is mainland
   Europe/Anatolia/Africa, clipped by the box," not a real island.
   Confirmed directly: this step's biggest excluded parts are ~956,000
   km^2 and ~377,000 km^2 -- obviously continents, not islands -- while
   nothing resembling a real island got excluded by it.
3. Find Samothrace's own part (the one containing its centroid) and use
   its computed area as the reference size. Keep every other
   non-edge-touching part with area >= MIN_AREA_FRACTION_OF_SAMOTHRACE
   of that -- "not much smaller than Samothrace."
4. For each kept part, resolve a name via Nominatim, in priority order
   (each tier only tried if the previous one failed), with the result's
   own `name_source` field recording which tier actually won -- this
   project's established convention for not collapsing different
   confidence levels into one undifferentiated "name" field (see
   Data/naturalEarth's own cartography-domain writeup on elevation
   provenance for the same idea applied to a different pipeline):
   a. **`osm_search_seed_island`** -- a forward /search for a
      hand-supplied candidate common name (SEED_NAMES below, built from
      general geographic knowledge of this region -- *not* asserted as
      the output name itself, only as a search query), accepted because
      a result came back tagged `category=place`, `type` in (island,
      islet), inside or near this part's own bounding box.
   b. **`osm_search_seed_administrative`** -- same seed query, but the
      only in-bounds match Nominatim returned was a
      `category=boundary`/`type=administrative` record (a country or
      region), not a place=island/islet tag. Real, confirmed finding
      for this run, not a guess: Cyprus is the clearest example --
      searched directly, OSM's only record actually named "Cyprus" is
      its own country-administrative boundary; there is no separate
      place=island tag for it at all.
   c. **`osm_search_admin_derived_island`** / **`..._administrative`**
      -- same two outcomes as (a)/(b), but the query is derived from
      this part's own reverse-geocoded administrative name (see below,
      with "Municipality"/"Municipal Unit"/"Community"/"Regional Unit"
      stripped) instead of a hand-supplied seed -- covers any part
      SEED_NAMES has no entry for, or whose seed was simply wrong (this
      tier is what actually resolved several parts during development
      where a hand-guessed seed named the wrong nearby island).
   d. **`osm_administrative_fallback`** -- neither tier above found
      anything, in bounds or not. Falls back to whatever administrative
      unit Nominatim's plain /reverse returns at this part's
      representative point, explicitly flagged as administrative rather
      than the island's own name -- for an island that's its own
      single-island municipality this is usually still the right word,
      but it is NOT guaranteed to be, and the flag says so rather than
      silently asserting it.
   e. **`unresolved`** -- reverse geocoding itself returned nothing
      usable. Kept in the output with `name: null` rather than dropped
      -- a silent drop would misrepresent this as "no large island
      here," when the real situation is "a real landmass is here and
      OSM lookup for it failed."

## Nominatim usage

One request at a time, >=1.1s apart (Nominatim's usage policy caps
general use at 1 request/second), with a descriptive User-Agent
identifying this project and a contact address, per that same policy.
Expect this script to take a few minutes to run.
"""

import json
import math
import os
import re
import sys
import time

import requests
from shapely.geometry import Point, shape

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts"))
from natural_earth_common import BBOX, SAMOTHRACE_LAT, SAMOTHRACE_LON  # noqa: E402

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
NATURAL_EARTH_DIR = os.path.join(OUT_DIR, "..", "naturalEarth")

EDGE_TOUCH_EPS_DEG = 0.02
MIN_AREA_FRACTION_OF_SAMOTHRACE = 0.5

# Display metadata for the one layer this script produces -- read
# directly by desk_hmsvc/natural-earth-map/service.py (via
# metadata.json, written below alongside osm_island_names.geojson),
# same self-discovering convention scripts/clip_natural_earth.py's own
# LAYER_STYLES already uses for Data/naturalEarth/. `order` sits between
# that script's "Named Islands & Regions" (4) and "Cities" (5) layers --
# this one is conceptually the same kind of thing (named islands), just
# from a different, size-filtered source.
LAYER_META = {
    "id": "osm_island_names",
    "label": "Named Islands (OpenStreetMap, large)",
    "group": "Named Islands",
    "order": 4.5,
    "defaultVisible": True,
    "render": "dot-label",
    "color": "#5fd4a0",
    "radius": 2.5,
    "labelField": "name",
    "extraField": "area_km2",
    "extraLabel": "km²",
}

NOMINATIM_BASE = "https://nominatim.openstreetmap.org"
USER_AGENT = "ae_samothrace-island-name-lookup/1.0 (research project; contact mphair@gmail.com)"
REQUEST_INTERVAL_SEC = 1.1

# Candidate common names per landmass, keyed by that part's own
# representative point (lat, lon rounded to 2dp -- stable across runs
# since shapely's representative_point() is deterministic for a given
# geometry). Built from general knowledge of this region's geography
# AFTER computing the candidate list below, matched back to it by
# location -- used ONLY as a search seed for step 4a above; the actual
# recorded name always comes from OSM's own response, never from this
# dict directly.
SEED_NAMES = {
    (35.13, 33.23): "Cyprus",
    (35.31, 24.47): "Crete",
    (38.50, 23.92): "Euboea",
    (39.17, 26.00): "Lesbos",
    (36.17, 27.91): "Rhodes",
    (38.38, 26.07): "Chios",
    (38.27, 20.54): "Kefalonia",
    (39.59, 19.85): "Corfu",
    (39.91, 25.14): "Lemnos",
    (37.73, 26.81): "Samos",
    (37.07, 25.48): "Naxos",
    (37.78, 20.79): "Zakynthos",
    (40.69, 24.65): "Thasos",
    (43.33, 16.64): "Brac",
    (37.83, 24.88): "Andros",
    (38.72, 20.65): "Lefkada",
    (35.62, 27.12): "Karpathos",
    (36.80, 27.09): "Kos",
    (40.17, 25.83): "Imbros Gokceada",
    (43.18, 16.57): "Hvar",
    (36.27, 23.00): "Kythira",
    (37.59, 26.14): "Ikaria",
    (42.95, 16.91): "Korcula",
    (38.87, 24.53): "Skyros",
    (37.60, 25.16): "Paros",
    (37.07, 25.20): "Amorgos",
    (40.46, 25.58): "Samothraki",
    (36.71, 24.51): "Ios",
    (36.87, 25.93): "Astypalaia",
    (37.61, 24.33): "Kea",
    (37.01, 26.97): "Kalymnos",
    (40.62, 27.63): "Marmara Adasi",
    (36.73, 25.34): "Sikinos",
    (37.40, 24.44): "Kythnos",
    (37.95, 23.52): "Salamis",
    (36.57, 26.30): "Tilos",
    (39.14, 23.68): "Skopelos",
    (43.05, 16.16): "Vis",
    (38.41, 20.67): "Ithaca",
    (42.75, 17.54): "Peljesac",
}


def km2_area(poly):
    coords = list(poly.exterior.coords)
    lat0 = sum(c[1] for c in coords) / len(coords)
    r = 6371.0088

    def to_xy(lon, lat):
        return math.radians(lon) * r * math.cos(math.radians(lat0)), math.radians(lat) * r

    def ring_area(ring_coords):
        pts = [to_xy(lon, lat) for lon, lat in ring_coords]
        total = 0.0
        for i in range(len(pts)):
            x1, y1 = pts[i]
            x2, y2 = pts[(i + 1) % len(pts)]
            total += x1 * y2 - x2 * y1
        return abs(total) / 2

    area = ring_area(coords)
    for interior in poly.interiors:
        area -= ring_area(list(interior.coords))
    return area


def touches_bbox_edge(poly):
    minx, miny, maxx, maxy = poly.bounds
    return (
        minx <= BBOX[0] + EDGE_TOUCH_EPS_DEG
        or maxx >= BBOX[2] - EDGE_TOUCH_EPS_DEG
        or miny <= BBOX[1] + EDGE_TOUCH_EPS_DEG
        or maxy >= BBOX[3] - EDGE_TOUCH_EPS_DEG
    )


def load_land_parts():
    parts = []
    for fname in ["ne_10m_land.geojson", "ne_10m_minor_islands.geojson"]:
        with open(os.path.join(NATURAL_EARTH_DIR, fname)) as f:
            fc = json.load(f)
        for feat in fc["features"]:
            geom = shape(feat["geometry"])
            polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
            for poly in polys:
                if poly.is_empty or poly.area == 0:
                    continue
                parts.append((poly, fname))
    return parts


_last_request_at = 0.0


def _nominatim_get(path, params):
    global _last_request_at
    wait = REQUEST_INTERVAL_SEC - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    try:
        resp = requests.get(
            f"{NOMINATIM_BASE}{path}",
            params=params,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:  # noqa: BLE001 -- best-effort lookup, never fatal to the whole run
        print(f"    (Nominatim request failed: {exc})")
        data = None
    _last_request_at = time.monotonic()
    return data


def reverse_lookup(lat, lon):
    return _nominatim_get(
        "/reverse",
        {"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 10, "accept-language": "en"},
    )


def _point_in_expanded_bounds(lat, lon, bounds, pad_x, pad_y):
    minx, miny, maxx, maxy = bounds
    return (minx - pad_x) <= lon <= (maxx + pad_x) and (miny - pad_y) <= lat <= (maxy + pad_y)


def search_for_island(query, bounds):
    """Two tiers, both tried before giving up on this query:

    1. A **bounded** search (Nominatim's own `viewbox`+`bounded=1`,
       padded 10%) for a `category=place`, `type` in (island, islet)
       result -- the strong case: a real island/islet record, and
       Nominatim itself already agrees it's roughly in the right place.
    2. An **unbounded** search for the same query (first tier can miss a
       real record whose own label point -- e.g. an administrative
       relation's centroid -- sits further from our polygon's own
       bounds than the tight viewbox allows, which happened for Cyprus
       during development: the only OSM record actually named "Cyprus"
       is the country's own administrative boundary, not a place=island
       tag, and its centroid point didn't fall inside the padded
       viewbox). Scans the top results for the same `place:
       island/islet` match first, falling back to a `boundary:
       administrative` match -- both required to land inside a much
       more generous padding (half this landmass's own bounding-box
       size) so a true mismatch (a same-named place somewhere else
       entirely) still gets rejected.

    Returns `(result, tier)` where `tier` is `'island'` or
    `'administrative'` (so the caller can record which kind of match it
    actually was), or `(None, None)`.
    """
    minx, miny, maxx, maxy = bounds
    pad_x = max(0.05, (maxx - minx) * 0.1)
    pad_y = max(0.05, (maxy - miny) * 0.1)
    viewbox = f"{minx - pad_x},{maxy + pad_y},{maxx + pad_x},{miny - pad_y}"
    bounded_results = _nominatim_get(
        "/search",
        {"q": query, "format": "jsonv2", "viewbox": viewbox, "bounded": 1, "limit": 5, "accept-language": "en"},
    )
    for r in bounded_results or []:
        if r.get("category") == "place" and r.get("type") in ("island", "islet"):
            return r, "island"

    # Calibrated against two real cases found during development: Cyprus
    # (a big, isolated island -- its only OSM match is its own country
    # -administrative boundary, whose centroid sits ~0.15 deg from this
    # landmass's own representative point, well inside the proportional
    # term here) versus Amorgos (a small Cyclades island whose
    # NEIGHBORING island Astypalaia sits only ~0.3-0.4 deg away --
    # an earlier, more generous floor (0.3 deg flat) wrongly matched
    # Amorgos to Astypalaia's own administrative boundary). A small
    # floor plus a modest proportional term handles both: generous
    # enough for a big island's own administrative centroid to drift
    # from its geometric representative point, tight enough not to
    # reach a real neighboring island in a densely-packed archipelago.
    wide_pad_x = max(0.12, (maxx - minx) * 0.3)
    wide_pad_y = max(0.12, (maxy - miny) * 0.3)
    unbounded_results = _nominatim_get(
        "/search", {"q": query, "format": "jsonv2", "limit": 5, "accept-language": "en"}
    )
    for r in unbounded_results or []:
        if not _point_in_expanded_bounds(float(r["lat"]), float(r["lon"]), bounds, wide_pad_x, wide_pad_y):
            continue
        if r.get("category") == "place" and r.get("type") in ("island", "islet"):
            return r, "island"
    for r in unbounded_results or []:
        if not _point_in_expanded_bounds(float(r["lat"]), float(r["lon"]), bounds, wide_pad_x, wide_pad_y):
            continue
        if r.get("category") == "boundary" and r.get("type") == "administrative":
            return r, "administrative"
    return None, None


# Matches both "Municipality of X" and "X Municipality" (Nominatim
# returns either shape depending on language/region), plus the other
# generic administrative-unit words seen in this bbox's own results
# during development -- stripped wherever they appear, not just at a
# fixed position, then whitespace is collapsed. Applied before using an
# admin name as a search query (a literal "Paros Municipality" search
# missed the real place=island record; a plain "Paros" search found it
# -- see this module's own docstring, step 4b).
_ADMIN_WORD_RE = re.compile(
    r"\b(Municipality of|Municipal Unit of|Community of|Regional Unit of|Municipality|Municipal Unit|Community|Regional Unit)\b",
    re.IGNORECASE,
)


def strip_admin_words(name):
    cleaned = _ADMIN_WORD_RE.sub("", name)
    return re.sub(r"\s+", " ", cleaned).strip(" ,")


def resolve_name(rep_point, bounds):
    key = (round(rep_point.y, 2), round(rep_point.x, 2))
    seed = SEED_NAMES.get(key)

    if seed:
        print(f"    trying seed '{seed}'...")
        hit, tier = search_for_island(seed, bounds)
        if hit:
            hit_name = strip_admin_words(hit["name"]) if tier == "administrative" else hit.get("name")
            return {
                "name": hit_name,
                "name_source": "osm_search_seed_island" if tier == "island" else "osm_search_seed_administrative",
                "osm_type": hit.get("osm_type"),
                "osm_id": hit.get("osm_id"),
                "place": hit.get("type"),
                "lat": float(hit["lat"]),
                "lon": float(hit["lon"]),
            }

    admin = reverse_lookup(rep_point.y, rep_point.x)
    admin_name = admin.get("name") if admin else None
    country = (admin.get("address") or {}).get("country") if admin else None

    if admin_name:
        derived_query = strip_admin_words(admin_name)
        print(f"    trying admin-derived '{derived_query}'...")
        hit, tier = search_for_island(derived_query, bounds)
        if hit:
            hit_name = strip_admin_words(hit["name"]) if tier == "administrative" else hit.get("name")
            return {
                "name": hit_name,
                "name_source": "osm_search_admin_derived_island" if tier == "island" else "osm_search_admin_derived_administrative",
                "osm_type": hit.get("osm_type"),
                "osm_id": hit.get("osm_id"),
                "place": hit.get("type"),
                "lat": float(hit["lat"]),
                "lon": float(hit["lon"]),
                "country": country,
            }

    if admin_name:
        return {
            "name": strip_admin_words(admin_name),
            "name_source": "osm_administrative_fallback",
            "osm_type": admin.get("osm_type"),
            "osm_id": admin.get("osm_id"),
            "place": admin.get("addresstype"),
            "lat": rep_point.y,
            "lon": rep_point.x,
            "country": country,
        }

    return {
        "name": None,
        "name_source": "unresolved",
        "osm_type": None,
        "osm_id": None,
        "place": None,
        "lat": rep_point.y,
        "lon": rep_point.x,
        "country": None,
    }


def main():
    parts = load_land_parts()
    print(f"{len(parts)} total land/minor-island polygon parts in the full Natural Earth bbox clip")

    sam_point = Point(SAMOTHRACE_LON, SAMOTHRACE_LAT)
    samothrace_area = None
    for poly, _src in parts:
        if poly.distance(sam_point) < 0.01:
            samothrace_area = km2_area(poly)
            break
    if samothrace_area is None:
        raise RuntimeError("Could not locate Samothrace's own polygon part for calibration")
    print(f"Samothrace calibration area: {samothrace_area:.1f} km^2 (real-world ~178 km^2)")

    min_area = samothrace_area * MIN_AREA_FRACTION_OF_SAMOTHRACE
    print(f"Minimum area threshold ({MIN_AREA_FRACTION_OF_SAMOTHRACE} x Samothrace): {min_area:.1f} km^2")

    candidates = []
    for poly, src in parts:
        if touches_bbox_edge(poly):
            continue
        area = km2_area(poly)
        if area < min_area:
            continue
        candidates.append((area, poly, src))
    candidates.sort(key=lambda c: -c[0])
    print(f"{len(candidates)} candidate landmasses (including Samothrace itself)\n")

    features = []
    for i, (area, poly, src) in enumerate(candidates, 1):
        rep = poly.representative_point()
        print(f"[{i}/{len(candidates)}] area={area:.1f} km^2 at ({rep.y:.3f},{rep.x:.3f})")
        resolved = resolve_name(rep, poly.bounds)
        print(f"    -> {resolved['name']!r} ({resolved['name_source']})")
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [resolved["lon"], resolved["lat"]]},
                "properties": {
                    "name": resolved["name"],
                    "name_source": resolved["name_source"],
                    "area_km2": round(area, 1),
                    "osm_type": resolved.get("osm_type"),
                    "osm_id": resolved.get("osm_id"),
                    "osm_place_type": resolved.get("place"),
                    "country": resolved.get("country"),
                    "natural_earth_source": src,
                },
            }
        )

    out_path = os.path.join(OUT_DIR, "osm_island_names.geojson")
    with open(out_path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {out_path} ({len(features)} features)")

    meta_path = os.path.join(OUT_DIR, "metadata.json")
    layer_entry = dict(LAYER_META, url=f"/data/{LAYER_META['id']}.geojson", featureCount=len(features))
    with open(meta_path, "w") as f:
        json.dump({"layers": [layer_entry]}, f, indent=2)
    print(f"Wrote {meta_path}")

    resolved_count = sum(1 for f in features if f["properties"]["name"])
    by_source = {}
    for f in features:
        src = f["properties"]["name_source"]
        by_source[src] = by_source.get(src, 0) + 1
    print(f"Resolved: {resolved_count}/{len(features)}")
    for src, count in sorted(by_source.items()):
        print(f"  {src}: {count}")


if __name__ == "__main__":
    sys.exit(main())
