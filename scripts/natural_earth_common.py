"""Shared constants/helpers for the Natural Earth import pair:

  - fetch_natural_earth.py   downloads + unzips raw Shapefiles into
                             .desk_temp/ (never committed; see that
                             directory's own .gitignore handling)
  - clip_natural_earth.py    reads those raw Shapefiles, clips to the
                             Samothrace bounding box, strips unused
                             attributes, and writes GeoJSON into
                             Data/naturalEarth/ (committed)

Kept in one place so both scripts agree on the bounding box, the
dataset list, and where raw vs. stripped data live.

Why the bounding box is a flat lat/lon rectangle rather than a precise
geodesic square: "500 miles N/S/E/W of Samothrace" is computed as
independent offsets along each cardinal direction using the standard
degrees-of-latitude/longitude-per-mile approximation (1 deg latitude ~=
69.17 miles everywhere; 1 deg longitude ~= 69.17 * cos(latitude) miles,
shrinking toward the poles). This is the conventional approach for a
"radius in miles" bounding box and is accurate to a small fraction of a
percent at this radius -- a true geodesic offset (e.g. via pyproj's
Geod) would differ by at most a few miles here, not worth a new
dependency for.
"""

import math
import os

# Samothraki (Samothrace), Greece -- island centroid, not any single
# town on it.
SAMOTHRACE_LAT = 40.4833
SAMOTHRACE_LON = 25.5333

RADIUS_MILES = 500.0

# Derivation: circumference at Earth's mean radius (3958.8 mi) = 2*pi*3958.8
# = 24,873.0 mi; divided by 360 degrees = 69.09 mi/degree. Kept as a named
# constant, computed once, so the two scripts can't drift apart.
MILES_PER_DEGREE_LAT = 2 * math.pi * 3958.8 / 360.0


def compute_bbox(lat=SAMOTHRACE_LAT, lon=SAMOTHRACE_LON, radius_miles=RADIUS_MILES):
    """Returns (min_lon, min_lat, max_lon, max_lat) for a box whose N/S/E/W
    edges are each `radius_miles` from (lat, lon), independently."""
    dlat = radius_miles / MILES_PER_DEGREE_LAT
    miles_per_degree_lon = MILES_PER_DEGREE_LAT * math.cos(math.radians(lat))
    dlon = radius_miles / miles_per_degree_lon
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


BBOX = compute_bbox()

# (dataset name, Natural Earth theme subdir on the CDN)
#
# Two layers that look like obvious fits were tried and dropped after
# inspecting the actual downloaded data (see clip_natural_earth.py's own
# docstring for the full explanation):
#   - ne_10m_minor_islands_label_points -- despite the name, carries no
#     `name` attribute at all in this release (featurecla/min_zoom/
#     scalerank only). Useless for labeling.
#   - ne_10m_geography_regions_points -- a real point layer with names,
#     but curated for notable/remote islands worldwide (atolls, etc.);
#     it has zero features anywhere in the Samothrace bounding box.
# ne_10m_geography_regions_polys (added below) is the one that actually
# has Aegean-area named islands/island groups (Crete, Rhodes, Lesbos,
# Cyprus, Cyclades, Ionian Is.) in this box.
DATASETS = [
    ("ne_10m_coastline", "10m_physical"),
    ("ne_10m_land", "10m_physical"),
    ("ne_10m_minor_islands", "10m_physical"),
    ("ne_10m_rivers_lake_centerlines", "10m_physical"),
    ("ne_10m_populated_places", "10m_cultural"),
    ("ne_10m_geography_regions_polys", "10m_physical"),
    # Sea/strait/channel names (Aegean Sea, Black Sea, Dardanelles, ...) --
    # unlike the island-name search above, this one worked on the first
    # try: a real `name` field, real polygon coverage of this bbox. See
    # Data/naturalEarth/README.md's own "Seas" section for what's in it.
    ("ne_10m_geography_marine_polys", "10m_physical"),
]

NATURAL_EARTH_CDN = "https://naturalearth.s3.amazonaws.com"

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(PROJECT_ROOT, ".desk_temp", "natural-earth-raw")
OUT_DIR = os.path.join(PROJECT_ROOT, "Data", "naturalEarth")


def zip_path(name):
    return os.path.join(RAW_DIR, name + ".zip")


def shp_dir(name):
    return os.path.join(RAW_DIR, name)


def shp_path(name):
    return os.path.join(shp_dir(name), name + ".shp")
