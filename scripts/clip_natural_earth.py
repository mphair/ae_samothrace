#!/usr/bin/env python3
"""Reads the raw, full-world Natural Earth Shapefiles fetched by
fetch_natural_earth.py (in .desk_temp/, not committed), clips each one
to the Samothrace bounding box, strips every attribute this project
doesn't need, and writes small GeoJSON files to Data/naturalEarth/
(committed).

## What's included and why

- `ne_10m_coastline.geojson` / `ne_10m_land.geojson` /
  `ne_10m_minor_islands.geojson` -- water boundaries: where the
  mainland coast and islands actually are. `land` carries the
  mainland and larger islands (confirmed Samothrace's own outline is
  in here, as part of a larger multi-part record -- Natural Earth
  does not give it, or almost any Aegean island, its own named
  record); `minor_islands` adds smaller islets `land` generalizes
  away. Neither layer carries a usable name attribute (see below).
- `ne_10m_rivers_lake_centerlines.geojson` -- rivers; the only dataset
  here where nearly every in-box feature already has a `name`.
- `ne_10m_populated_places.geojson` -- cities, filtered to "major"
  (population >= 50,000 or a national/regional capital) -- see
  POPULATED_PLACE_MIN_POP below.
- `ne_10m_geography_regions_polys.geojson` -- named islands and island
  groups (filtered to FEATURECLA "Island"/"Island group"): the only
  Natural Earth layer that actually carries island *names* in this
  area (Crete, Rhodes, Lesbos, Cyprus, Cyclades, Ionian Is. all fall
  in the box). This is a curated, sparse "notable islands" list, not
  a gazetteer -- see the gap noted next.
- `ne_10m_geography_marine_polys.geojson` -- sea/strait/channel names
  (Aegean Sea, Black Sea, Mediterranean Sea, Adriatic Sea, Ionian Sea,
  Sea of Crete, Sea of Marmara, Sea of Azov, Tyrrhenian Sea, Bosporus,
  Dardanelles). Unlike the island-naming gap above, this one worked on
  the first try -- a real `name` field, and real clipped polygon
  coverage confirmed by actually intersecting each candidate against
  the bbox (not just a bbox-vs-bbox pre-check): the one false positive
  a bbox-only check would have kept, "North Pacific Ocean" (its raw
  bbox spans the full -180..180 because its real geometry wraps the
  antimeridian), correctly clips to an empty intersection and is
  dropped. Seas nest (Mediterranean Sea's own polygon fully contains
  Aegean Sea's, which contains Sea of Crete's) -- that's real Natural
  Earth data, not a bug, and is left as-is; the widget's own label
  -declutter logic (see that layer's own `render: "centroid-label"`)
  is what actually decides which overlapping name wins a spot on
  screen at a given zoom.

## A real gap, worth stating plainly rather than silently dropping

Two layers that look purpose-built for "island names" were tried and
rejected after inspecting the actual data (see
natural_earth_common.DATASETS's own comment for the full story):
`ne_10m_minor_islands_label_points` has no name field at all, and
`ne_10m_geography_regions_points` (the point version of the layer
used above) has zero features anywhere in this bounding box. Natural
Earth, at any scale, does not carry a name for Samothrace itself, or
for most individual Aegean islands (Lemnos, Thasos, Samos, Imbros/
Gokceada, ...) -- only the handful of islands/island-groups notable
enough for its curated regions layer. `ne_10m_populated_places` was
also checked directly for a "Samothraki" town entry (the settlement
sharing the island's name) and has none -- it's too small. If a named
Samothrace-area island layer is wanted later, it will have to come
from a different, non-Natural-Earth source (e.g. OpenStreetMap, with
its own separate license/citation).

## Attribution

Natural Earth is public domain; attribution is requested, not
required. See Data/naturalEarth/README.md (written alongside this
script's output) for the credit line, source version note, and this
same gap called out for whoever reads that directory next.

## metadata.json

Alongside the per-layer `.geojson` files, this script also writes
`Data/naturalEarth/metadata.json`: the bounding box/center, and a
`layers` array carrying each layer's display metadata (group, draw
order, default visibility, color/fill/line-width, which property (if
any) to use as a label, and a feature count). This is what
`desk_hmsvc/natural-earth-map/service.py` actually reads to build its
own `/layers` response -- self-discovering off this one file (same
"read a data file, don't hardcode a second copy of the same list"
convention `desk_hmsvc/samothrace-tiles/service.py`'s own
`_discover_keys` already uses) rather than duplicating LAYER_STYLES as
a second, hand-synced list inside that service. Re-running this script
with a different bbox, filter, or style regenerates metadata.json too
-- the hmsvc service and the widget it serves never need their own
edits for that.
"""

import json
import os
import sys

import shapefile
from shapely.geometry import box, shape
from shapely.geometry import mapping as shapely_mapping

from natural_earth_common import BBOX, OUT_DIR, shp_path

BBOX_POLY = box(*BBOX)

POPULATED_PLACE_MIN_POP = 50_000

# Display metadata for each output layer -- read directly by
# desk_hmsvc/natural-earth-map/service.py (via metadata.json, written by
# main() below), not duplicated there. `order` controls compositing stack
# order (ascending = bottom to top), same convention
# desk_hmsvc/samothrace-tiles/service.py's own LAYERS list documents.
# `render` tells the widget how to draw a feature of this layer:
#   - "fill-stroke": filled polygon with an outline (land, minor islands)
#   - "stroke":      line only, no fill (coastline, rivers)
#   - "dot-label":   a small filled circle marker + an optional text label
#                    (cities)
#   - "centroid-label": no geometry drawn at all, just a text label at
#                    the feature's centroid (named island/region polygons
#                    -- drawing their fill would visually duplicate the
#                    land layer underneath, which already covers the same
#                    ground)
# `labelField`, if set, names the (already-lowercased) GeoJSON property
# to draw as a text label -- omitted for the two layers with no usable
# name (land, minor_islands; see this module's own "a real gap" note).
LAYER_STYLES = {
    "ne_10m_land": {
        "label": "Land",
        "group": "Land & Water",
        "order": 0,
        "defaultVisible": True,
        "render": "fill-stroke",
        "color": "#45566e",
        "fillColor": "#2f3b4d",
        "fillOpacity": 1,
        "weight": 0.75,
    },
    "ne_10m_minor_islands": {
        "label": "Minor Islands",
        "group": "Land & Water",
        "order": 1,
        "defaultVisible": True,
        "render": "fill-stroke",
        "color": "#53657e",
        "fillColor": "#3a4a60",
        "fillOpacity": 1,
        "weight": 0.75,
    },
    "ne_10m_coastline": {
        "label": "Coastline",
        "group": "Land & Water",
        "order": 2,
        "defaultVisible": True,
        "render": "stroke",
        "color": "#8fb0dd",
        "weight": 1.1,
    },
    "ne_10m_rivers_lake_centerlines": {
        "label": "Rivers",
        "group": "Rivers",
        "order": 3,
        "defaultVisible": True,
        "render": "stroke",
        "color": "#3f8fd1",
        "weight": 1.25,
        "labelField": "name",
    },
    "ne_10m_geography_regions_polys": {
        "label": "Named Islands & Regions",
        "group": "Named Islands",
        "order": 4,
        "defaultVisible": True,
        "render": "centroid-label",
        "color": "#c9a9e0",
        "labelField": "name",
    },
    "ne_10m_geography_marine_polys": {
        "label": "Seas",
        "group": "Seas",
        "order": 4.2,
        "defaultVisible": True,
        "render": "centroid-label",
        "color": "#6fc8e0",
        "labelField": "name",
    },
    "ne_10m_populated_places": {
        "label": "Cities",
        "group": "Cities",
        "order": 5,
        "defaultVisible": True,
        "render": "dot-label",
        "color": "#f2b134",
        "radius": 3,
        "labelField": "name",
        "extraField": "pop_max",
        "extraLabel": "population",
    },
}


def record_dict(shaperecord):
    """pyshp field names are lowercase in some NE layers, uppercase in
    others (confirmed by inspection: physical layers are lowercase,
    ne_10m_populated_places is uppercase) -- normalize to lowercase keys
    so the rest of this script can use one casing throughout."""
    return {k.lower(): v for k, v in shaperecord.record.as_dict().items()}


def clip_feature(shaperecord):
    """Returns a clipped shapely geometry, or None if it doesn't survive
    clipping (fully outside the box, or clips down to an empty/
    degenerate shape). pyshp's own `.bbox` isn't available on Point
    shapes, so the cheap reject below uses shapely's `.bounds` on every
    shape type uniformly instead of pyshp's attribute."""
    if not shaperecord.shape.points:
        return None
    geom = shape(shaperecord.shape.__geo_interface__)
    minx, miny, maxx, maxy = geom.bounds
    if maxx < BBOX[0] or minx > BBOX[2] or maxy < BBOX[1] or miny > BBOX[3]:
        return None  # cheap bbox-vs-bbox reject before the real geometry op
    if not geom.is_valid:
        geom = geom.buffer(0)  # standard shapely fix for minor self-intersections
    clipped = geom.intersection(BBOX_POLY)
    if clipped.is_empty:
        return None
    return clipped


def write_geojson(name, features):
    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, f"{name}.geojson")
    fc = {"type": "FeatureCollection", "features": features}
    with open(out_path, "w") as f:
        json.dump(fc, f)
    print(f"  wrote {out_path} ({len(features)} features)")


def process(name, keep_fields, record_filter=None, add_label_point=False):
    """`add_label_point`: for a `render: "centroid-label"` layer, add
    `label_lon`/`label_lat` properties holding shapely's own
    `representative_point()` -- a point GUARANTEED to fall inside the
    (possibly concave, possibly multi-part, possibly clipped-to-a-sliver)
    polygon, unlike a plain bounds-midpoint. Matters most for this
    script's two biggest/most irregular clipped polygons
    (ne_10m_geography_marine_polys' "Mediterranean Sea" and "Aegean
    Sea" -- the whole bbox's own coastline cuts deep into both): a
    bounds-midpoint for either would have a real chance of landing on
    dry land. The widget's own `centroid-label` renderer prefers these
    properties when present, falling back to its own bounds-midpoint
    otherwise (see natural-earth-map.ts's own `geometryCenterLonLat`)."""
    print(f"{name}:")
    reader = shapefile.Reader(shp_path(name))
    features = []
    total = 0
    for sr in reader.iterShapeRecords():
        total += 1
        rec = record_dict(sr)
        if record_filter is not None and not record_filter(rec):
            continue
        clipped = clip_feature(sr)
        if clipped is None:
            continue
        props = {k: rec.get(k) for k in keep_fields}
        if add_label_point:
            label_point = clipped.representative_point()
            props["label_lon"] = label_point.x
            props["label_lat"] = label_point.y
        features.append(
            {
                "type": "Feature",
                "geometry": shapely_mapping(clipped),
                "properties": props,
            }
        )
    print(f"  {total} source records -> {len(features)} in Samothrace bbox")
    write_geojson(name, features)
    return len(features)


def is_major_place(rec):
    if (rec.get("pop_max") or 0) >= POPULATED_PLACE_MIN_POP:
        return True
    if rec.get("adm0cap") == 1:
        return True
    return "capital" in (rec.get("featurecla") or "").lower()


def is_named_island_region(rec):
    return (rec.get("featurecla") or "").lower() in ("island", "island group")


def write_metadata(feature_counts):
    out_path = os.path.join(OUT_DIR, "metadata.json")
    west, south, east, north = BBOX
    layers = []
    for name, style in LAYER_STYLES.items():
        entry = {"id": name, "url": f"/data/{name}.geojson", "featureCount": feature_counts[name]}
        entry.update(style)
        layers.append(entry)
    layers.sort(key=lambda entry: entry["order"])
    metadata = {
        "bounds": {"west": west, "south": south, "east": east, "north": north},
        "center": {"lon": (west + east) / 2, "lat": (south + north) / 2},
        "layers": layers,
    }
    with open(out_path, "w") as f:
        json.dump(metadata, f, indent=2)
    print(f"  wrote {out_path}")


def main():
    counts = {}
    counts["ne_10m_coastline"] = process("ne_10m_coastline", keep_fields=["featurecla", "scalerank"])
    counts["ne_10m_land"] = process("ne_10m_land", keep_fields=["featurecla", "scalerank"])
    counts["ne_10m_minor_islands"] = process("ne_10m_minor_islands", keep_fields=["featurecla", "scalerank"])
    counts["ne_10m_rivers_lake_centerlines"] = process(
        "ne_10m_rivers_lake_centerlines",
        keep_fields=["name", "name_en", "featurecla", "scalerank"],
    )
    counts["ne_10m_populated_places"] = process(
        "ne_10m_populated_places",
        keep_fields=["name", "pop_max", "featurecla", "adm0name"],
        record_filter=is_major_place,
    )
    counts["ne_10m_geography_regions_polys"] = process(
        "ne_10m_geography_regions_polys",
        keep_fields=["name", "featurecla"],
        record_filter=is_named_island_region,
        add_label_point=True,
    )
    counts["ne_10m_geography_marine_polys"] = process(
        "ne_10m_geography_marine_polys",
        keep_fields=["name", "featurecla", "scalerank"],
        add_label_point=True,
    )
    write_metadata(counts)
    print(f"\nDone. Stripped, clipped GeoJSON + metadata.json is under {OUT_DIR}/ (committed).")


if __name__ == "__main__":
    sys.exit(main())
