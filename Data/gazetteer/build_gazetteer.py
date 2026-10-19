#!/usr/bin/env python3
"""Builds Data/gazetteer/gazetteer.geojson -- one Point feature per
*named* thing already gathered in Data/naturalEarth/ and
Data/OpenStreetMap-geocoding/, normalized to one flat shape
(`id`/`name`/`type`/`lon`/`lat` + a few source-specific extras) so a
single list can be sorted, searched, and grouped without caring which
of the two source directories (or which of their five underlying
layers) a given entry came from. Read directly by
`desk_hmsvc/gazetteer/service.py` (geocode/reverse/within-polygon
queries) and, through that service, by the Gazetteer widget.

Every source layer here already went through its own real-vs-bbox
clipping, attribute stripping, and (where relevant) representative
-point label placement -- see Data/naturalEarth/README.md and
Data/OpenStreetMap-geocoding/README.md for all of that. This script
does exactly three more things none of those source layers needed:

1. **Reduces every geometry to one point.** A gazetteer entry is a
   place you look up and jump to, not a shape you render -- a river
   becomes the point at the exact middle of its longest clipped
   segment (`shapely`'s own `interpolate(0.5, normalized=True)`,
   guaranteed to fall ON the line, unlike an average-of-endpoints
   approximation); every polygon layer already has its own
   `label_lon`/`label_lat` (see clip_natural_earth.py's own
   `add_label_point`) and that's reused directly.
2. **Normalizes `type` to one flat, cross-source vocabulary** --
   `city`, `island`, `island_group`, `sea`, `strait`, `channel`,
   `river` -- instead of each source's own `featurecla`/layer-id
   shape. "island" deliberately covers both Data/naturalEarth/'s
   `ne_10m_geography_regions_polys` (fame-curated) entries AND
   Data/OpenStreetMap-geocoding/'s (size-curated) entries -- see the
   dedup step next for why that's safe to merge into one bucket rather
   than keeping two parallel "island" types.
3. **Dedupes the real overlap between those two island sources.**
   Natural Earth's curated regions layer and the OpenStreetMap lookup
   were built independently, for different reasons, in different
   sessions -- and, confirmed directly, **4 of the 7 Natural Earth
   island entries (Crete, Rhodes, Lesbos, Cyprus) are the same real
   islands already present in the OpenStreetMap list** (all four are
   large enough to clear that list's own "not much smaller than
   Samothrace" threshold). Kept once each, preferring the
   OpenStreetMap entry (it carries richer, independently-verified
   provenance -- `name_source`, `area_km2`, `country` -- see that
   directory's own README) -- matched by proximity (within
   DEDUP_DISTANCE_DEG of each other), not by exact name string, since
   the two sources don't always use the same transliteration. The
   other 3 Natural Earth entries (Pelopónnisos, Cyclades, Ionian Is.)
   have no OpenStreetMap-list counterpart (the first is a
   peninsula, correctly excluded from that list's own land/mainland
   -exclusion rule; the other two are island *groups*, not single
   landmasses that list ever represents) and are kept as-is.
"""

import json
import os

from shapely.geometry import shape

NATURAL_EARTH_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "naturalEarth")
OSM_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "OpenStreetMap-geocoding")
OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gazetteer.geojson")

# How close two islands' own points need to be to treat them as the
# same real landmass, named independently by two different sources --
# calibrated against the four real matches found (Cyprus/Crete/Lesbos/
# Rhodes, each within ~0.2 deg of its own OpenStreetMap-list point; see
# this module's own docstring) with headroom before it could plausibly
# reach a genuinely different nearby island instead.
DEDUP_DISTANCE_DEG = 0.3

# Natural Earth's own featurecla values -> this gazetteer's flat `type`
# vocabulary. Lowercased, spaces to underscores.
FEATURECLA_TYPE = {
    "island": "island",
    "island group": "island_group",
    "sea": "sea",
    "strait": "strait",
    "channel": "channel",
}


def load_geojson(path):
    with open(path) as f:
        return json.load(f)


def near(lon1, lat1, lon2, lat2, threshold=DEDUP_DISTANCE_DEG):
    return abs(lon1 - lon2) <= threshold and abs(lat1 - lat2) <= threshold


def main():
    entries = []
    next_id = [0]

    def add(name, type_, lon, lat, source_layer, extra=None):
        entry = {
            "id": f"gaz-{next_id[0]}",
            "name": name,
            "type": type_,
            "lon": lon,
            "lat": lat,
            "source_layer": source_layer,
        }
        if extra:
            entry.update(extra)
        entries.append(entry)
        next_id[0] += 1

    # -- Cities (Data/naturalEarth/ne_10m_populated_places.geojson) --
    places = load_geojson(os.path.join(NATURAL_EARTH_DIR, "ne_10m_populated_places.geojson"))
    for feat in places["features"]:
        p = feat["properties"]
        lon, lat = feat["geometry"]["coordinates"]
        add(p["name"], "city", lon, lat, "ne_10m_populated_places", {"population": p.get("pop_max")})
    print(f"cities: {len(places['features'])}")

    # -- Islands from OpenStreetMap (already size-filtered, already
    # named via Nominatim -- see that directory's own README) --
    osm_islands = load_geojson(os.path.join(OSM_DIR, "osm_island_names.geojson"))
    osm_points = []  # (lon, lat) for the dedup pass below
    for feat in osm_islands["features"]:
        p = feat["properties"]
        if not p.get("name"):
            continue  # the 'unresolved' tier, if it ever occurs -- no name to list
        lon, lat = feat["geometry"]["coordinates"]
        osm_points.append((lon, lat))
        add(
            p["name"],
            "island",
            lon,
            lat,
            "osm_island_names",
            {"area_km2": p.get("area_km2"), "country": p.get("country"), "name_source": p.get("name_source")},
        )
    print(f"islands (OpenStreetMap): {len(osm_points)}")

    # -- Named islands/regions from Natural Earth -- only the ones NOT
    # already covered by the OpenStreetMap list above (see this
    # module's own docstring, point 3). --
    regions = load_geojson(os.path.join(NATURAL_EARTH_DIR, "ne_10m_geography_regions_polys.geojson"))
    kept, skipped = 0, []
    for feat in regions["features"]:
        p = feat["properties"]
        lon, lat = p["label_lon"], p["label_lat"]
        # Dedup-by-proximity only makes sense for a single *island*
        # against another single island -- an "Island group"'s own
        # representative point can easily land within DEDUP_DISTANCE_DEG
        # of one of its OWN member islands (confirmed directly: "Ionian
        # Is."'s point is ~0.13 deg from Lefkada, one of the islands
        # that group actually contains), which would wrongly drop the
        # group entry entirely as if it were a duplicate of that one
        # member, rather than the distinct, broader thing it is.
        is_single_island = p["featurecla"].lower() == "island"
        if is_single_island and any(near(lon, lat, ox, oy) for ox, oy in osm_points):
            skipped.append(p["name"])
            continue
        type_ = FEATURECLA_TYPE.get(p["featurecla"].lower(), "island")
        add(p["name"], type_, lon, lat, "ne_10m_geography_regions_polys")
        kept += 1
    print(f"named regions (Natural Earth): {kept} kept, {len(skipped)} deduped against OpenStreetMap ({', '.join(skipped)})")

    # -- Seas/straits/channels (Natural Earth only -- see that
    # directory's own README, "a success, unlike islands") --
    marine = load_geojson(os.path.join(NATURAL_EARTH_DIR, "ne_10m_geography_marine_polys.geojson"))
    for feat in marine["features"]:
        p = feat["properties"]
        type_ = FEATURECLA_TYPE.get(p["featurecla"].lower(), "sea")
        add(p["name"], type_, p["label_lon"], p["label_lat"], "ne_10m_geography_marine_polys")
    print(f"seas/straits/channels: {len(marine['features'])}")

    # -- Rivers (named only; a river's own "point" is the midpoint of
    # its longest clipped line part) --
    rivers = load_geojson(os.path.join(NATURAL_EARTH_DIR, "ne_10m_rivers_lake_centerlines.geojson"))
    river_count = 0
    for feat in rivers["features"]:
        p = feat["properties"]
        if not p.get("name"):
            continue
        geom = shape(feat["geometry"])
        lines = list(geom.geoms) if geom.geom_type == "MultiLineString" else [geom]
        longest = max(lines, key=lambda line: line.length)
        mid = longest.interpolate(0.5, normalized=True)
        add(p["name"], "river", mid.x, mid.y, "ne_10m_rivers_lake_centerlines")
        river_count += 1
    print(f"rivers: {river_count} (of {len(rivers['features'])}, unnamed skipped)")

    entries.sort(key=lambda e: (e["type"], e["name"]))
    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [e["lon"], e["lat"]]},
                "properties": {k: v for k, v in e.items() if k not in ("lon", "lat")},
            }
            for e in entries
        ],
    }
    with open(OUT_PATH, "w") as f:
        json.dump(fc, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {OUT_PATH} ({len(entries)} entries)")

    by_type = {}
    for e in entries:
        by_type[e["type"]] = by_type.get(e["type"], 0) + 1
    for t, c in sorted(by_type.items()):
        print(f"  {t}: {c}")


if __name__ == "__main__":
    main()
