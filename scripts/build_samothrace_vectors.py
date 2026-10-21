"""Builds Data/samothraceVectors/ -- real vector data for things
desk_widgets/samothrace-map/ already draws but, unlike every layer
desk_hmsvc/samothrace-tiles/ and desk_hmsvc/natural-earth-map/ serve,
were never exposed over HTTP at all: Extracted Contours, the Restored
State -- Waterway, the Restored State Plan's own structure footprints,
and the Regios. 2026-10-20, requested directly after a user asked why
those layers (among others) didn't show up in the new Layer Stack
widget -- see desk_domains/cartography/natural-earth-and-openstreetmap
.md's own section on this for the fuller story. Regios were added in a
second pass the same day, after the user noticed Regio I specifically
was still missing ("did I forget to ask for that?") -- yes, genuinely
forgotten the first time around, not a deliberate exclusion.

Served by desk_hmsvc/samothrace-vectors/ (a new, separate hmsvc, same
metadata.json-driven convention scripts/clip_natural_earth.py already
established for desk_hmsvc/natural-earth-map/ -- see that script's own
write_metadata for the shape this one's own write_metadata matches).

Four kinds of source, three different shapes of "not previously
servable":

1. **Extracted Contours** (Data/mapFeatures/SamoWeb_RestoredStatePlan_
   Contours.geojson) -- already real vector data, no conversion needed,
   just split into three files by `elevation_source` (major/minor/
   unlabeled) since this hmsvc's own LayerMeta has one color per layer,
   not per-feature -- see desk_widgets/samothrace-map/samothrace-map
   -contours-layer.ts's own CONTOUR_COLOR for the three shades this
   mirrors exactly. Restored-plan-only: there is no ActualStatePlan
   Contours.geojson on disk (confirmed directly) -- same gap that
   file's own buildLayersPanel already works around.

2. **Restored State -- Waterway** and **Regios** -- both genuinely
   raster-only before this: seeded-flood-fill PNGs
   (scripts/style_restored_waterway.py, scripts/style_restored_regio.py)
   with no vector form at all. Converted here by color-matching each
   fill's own solid RGB back out of its final PNG (cheaper and just as
   correct as re-running the flood fill itself, since the PNG's own
   colored pixels ARE that mask) and tracing it into a best-effort
   (Multi)Polygon capped at a per-layer point budget -- see
   `vectorize_mask`'s own comment for the simplification approach. This
   is a real, visible approximation of a hand-curated raster shape, not
   the shape itself; fine for "where roughly is this" at low zoom
   (which is this new hmsvc's whole purpose -- see Layered Map's own
   recenter-target logic for samothrace-tiles, which this doesn't need
   since even the larger budgets here are cheap to just always draw, no
   "too small to bother" cutoff required the way a raster tile set
   needs one). Waterway and Regio I get different budgets (see
   VECTORIZE_SOURCES below) -- requested directly, per-layer: 250 points
   for Waterway ("add more points... 10x the point budget" after an
   initial 25-point pass read as too coarse), ~10 for Regio I (a much
   simpler, mostly-convex shape where a user explicitly said ~10 "is
   acceptable").

3. **Restored State Plan's structures** (Data/mapFeatures/SamoWeb_
   RestoredStatePlan_Overlay.geojson) -- the real monument/building
   footprint polygons (25 features, MultiPolygon, Name/Label/WebCode
   properties) already used for desk_hmsvc/samothrace-tiles' own
   ground-truth structure-exclusion mask AND for samothrace-map.ts's own
   always-on monument overlay -- copied through as-is, no conversion
   needed, just a metadata.json entry so it's independently toggleable
   and geo-queryable the way nothing in that file currently is outside
   the Samothrace Map widget itself.

Run from the project root: `python3 scripts/build_samothrace_vectors.py`
Requires numpy, opencv-python (cv2), Pillow -- all already available in
this project's own Python environment (confirmed directly: cv2 5.0.0 is
already importable here, same interpreter desk_hmsvc/samothrace-tiles/
service.py's own PIL usage already runs under).
"""
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

PROJECT_DIR = Path(__file__).resolve().parent.parent
MAP_FEATURES_DIR = PROJECT_DIR / "Data" / "mapFeatures"
OUT_DIR = PROJECT_DIR / "Data" / "samothraceVectors"

CONTOURS_SRC = MAP_FEATURES_DIR / "SamoWeb_RestoredStatePlan_Contours.geojson"
STRUCTURES_SRC = MAP_FEATURES_DIR / "SamoWeb_RestoredStatePlan_Overlay.geojson"
WATERWAY_PNG = MAP_FEATURES_DIR / "SamoWeb_RestoredStatePlan_WaterwayView.png"
WATERWAY_BOUNDS = MAP_FEATURES_DIR / "SamoWeb_RestoredStatePlan_WaterwayView.bounds.json"

# ── Layer styles -- same field shape as scripts/clip_natural_earth.py's
# own LAYER_STYLES (label/group/order/defaultVisible/render/color/
# fillColor/fillOpacity/weight/labelField), consumed the same way by
# write_metadata below. All start `defaultVisible: False` -- this
# hmsvc's own layers are opt-in extras for Layer Stack to add to the
# shared stack, not shown by default anywhere (unlike natural-earth
# -map's own base coastline/land, which the Natural Earth Map widget
# still shows by default on its own, independent of this project). ──
LAYER_STYLES = {
    "extracted_contours_major": {
        "label": "Extracted Contours — Major",
        "group": "Contours",
        "order": 0,
        "defaultVisible": False,
        "render": "stroke",
        "color": "#c026d3",
        "weight": 1.1,
    },
    "extracted_contours_minor": {
        "label": "Extracted Contours — Minor",
        "group": "Contours",
        "order": 1,
        "defaultVisible": False,
        "render": "stroke",
        "color": "#f59e0b",
        "weight": 1,
    },
    "extracted_contours_unlabeled": {
        "label": "Extracted Contours — Unlabeled",
        "group": "Contours",
        "order": 2,
        "defaultVisible": False,
        "render": "stroke",
        "color": "#94a3b8",
        "weight": 0.85,
    },
    "restored_waterway": {
        "label": "Restored State — Waterway",
        "group": "Waterway",
        "order": 3,
        "defaultVisible": False,
        "render": "fill-stroke",
        "color": "#4682c8",
        "fillColor": "#4682c8",
        "fillOpacity": 0.65,
        "weight": 1,
    },
    "restored_structures": {
        "label": "Restored State — Structures",
        "group": "Structures",
        "order": 4,
        "defaultVisible": False,
        "render": "fill-stroke",
        "color": "#f2b134",
        "fillColor": "#f2b134",
        "fillOpacity": 0.3,
        "weight": 1.25,
        "labelField": "Name",
    },
    "regio_1": {
        "label": "Regio I",
        "group": "Regios",
        "order": 5,
        "defaultVisible": False,
        "render": "fill-stroke",
        # Same purple the user drew with -- see
        # scripts/style_restored_regio.py's own REGIO_PURPLE/REGIO_ALPHA
        # comment ("a purple, three-quarters transparent shape" -- 0.25
        # opacity matches that 64/255 alpha almost exactly).
        "color": "#911eb4",
        "fillColor": "#911eb4",
        "fillOpacity": 0.25,
        "weight": 1,
    },
    "restored_waterway_bridges": {
        "label": "Restored State — Waterway Bridges",
        "group": "Waterway",
        "order": 3.5,
        "defaultVisible": False,
        "render": "stroke",
        # Pale, close-to-white -- reads as "a crossing," distinct from
        # the water's own blue, against either the water fill or the
        # dark base background.
        "color": "#dce6f0",
        "weight": 1.5,
        # Rendered dashed (layered-map.ts's own drawVectorLayer
        # consults this) specifically because these are NOT a real
        # traced edge the way every other stroke layer's lines are --
        # see build_waterway_bridges_and_regio's own header comment for
        # what they actually represent (a raster "lighter shade of
        # blue" area, deliberately excluded from the Waterway fill
        # itself and replaced with this marker instead).
        "dashed": True,
    },
}

# ── Extracted Contours: real data already, just a 3-way split ──


def build_contours() -> dict:
    data = json.loads(CONTOURS_SRC.read_text())
    buckets: dict[str, list] = {"major": [], "minor": [], "unlabeled": []}
    for feature in data["features"]:
        src = feature.get("properties", {}).get("elevation_source")
        if src in ("ocr", "review-confirmed"):
            bucket = "major"
        elif src == "interpolated":
            bucket = "minor"
        else:
            bucket = "unlabeled"
        buckets[bucket].append(feature)

    counts = {}
    for bucket, features in buckets.items():
        layer_id = f"extracted_contours_{bucket}"
        fc = {"type": "FeatureCollection", "features": features}
        (OUT_DIR / f"{layer_id}.geojson").write_text(json.dumps(fc))
        counts[layer_id] = len(features)
    return counts


# ── Restored State Plan's structures: real data already, straight copy ──


def build_structures() -> dict:
    data = json.loads(STRUCTURES_SRC.read_text())
    (OUT_DIR / "restored_structures.geojson").write_text(json.dumps(data))
    return {"restored_structures": len(data["features"])}


# ── Waterway / Bridges / Regio I: PNG mask -> best-effort vector data ──
#
# Waterway and Regio I are both a seeded-flood-fill PNG (see
# scripts/style_restored_waterway.py / scripts/style_restored_regio.py)
# painted in one solid, known RGB with no other feature in the mosaic
# sharing it -- color-matching that RGB back out of the final PNG
# recovers each one's own fill mask directly, cheaper and just as
# correct as re-running its own flood fill. The two are also COUPLED,
# in two separate ways (2026-10-20, both requested directly in the same
# message), which is why they're built together below rather than as
# two independent, order-independent conversions:
#
# 1. **Bridges are a real, deliberate visual distinction in the raster
#    that the vector form was silently erasing.** The Waterway PNG
#    paints "open water" and "water under a bridge" in the exact same
#    RGB, different alpha only (WATER_ALPHA_OPEN=235 vs
#    WATER_ALPHA_UNDER_BRIDGE=90 -- confirmed directly: these are the
#    ONLY two alpha values present among matched-blue pixels, a clean
#    split). The original vectorize_mask()-based pass matched on RGB
#    alone, so it silently merged both into one seamless fill -- fine
#    for the raster view (alpha blending over the base map IS the
#    visual distinction), wrong for the vector one once bridges stopped
#    being an incidental rendering detail and became something this
#    data format needed to represent on purpose. Fixed here by
#    splitting on alpha too: `open_mask` (fill, kept) vs `bridge_mask`
#    (excluded from the fill entirely, replaced by a short dashed
#    connector line per bridge -- see restored_waterway_bridges below).
# 2. **Regio I's own right-hand boundary is DEFINED as the Waterway's
#    own left edge**, not an independently-traced shape of its own --
#    see style_restored_regio.py's own header ("the boundary of the
#    first regio... going up to the waterway there"). The original
#    6-point convex-hexagon pass (previous round) traced Regio I's own
#    raster mask directly, which is a reasonable, honest approximation
#    on three sides but never actually USES the real Waterway vector
#    data it's conceptually supposed to follow on the fourth. Fixed
#    here by splicing the real, simplified left edge of the two
#    Waterway pieces nearest Regio I's own right side into its own
#    boundary, replacing whichever 2 of the hexagon's own 6 vertices
#    that stretch covered -- see build_waterway_bridges_and_regio's own
#    body for exactly how the splice point is chosen (by the dropped
#    vertices' own higher mean longitude -- "more easterly," i.e.
#    actually on the right) -- and bridging the one real gap between
#    those two Waterway pieces (an un-seeded stretch, same as every
#    other gap in this data -- see style_restored_waterway.py's own
#    header) with a single straight line, exactly as asked: "there is a
#    gap in the vectors, a straight line should be drawn between the
#    two segments."
MIN_COMPONENT_AREA_PX = 200  # below this, a matched blob is almost certainly anti-aliasing noise, not a real separate region
MIN_POINTS_PER_RING = 4  # a closed ring needs at least a triangle (3 distinct points) + its own closing repeat

WATER_BLUE = (70, 130, 200)
WATER_COLOR_TOLERANCE = 10  # sum of per-channel abs difference
WATER_ALPHA_OPEN = 235
WATER_ALPHA_UNDER_BRIDGE = 90
WATERWAY_POINT_BUDGET = 250  # bumped 10x from an initial 25-point pass, requested directly, after the user said that read as too coarse

REGIO_PURPLE = (145, 30, 180)  # see style_restored_regio.py
REGIO_COLOR_TOLERANCE = 10
REGIO_HEXAGON_POINTS = 6  # "an irregular hexagon" -- requested directly
REGIO_TRACE_POINT_BUDGET = 20  # the real Waterway-derived chain replacing 2 of those 6 vertices -- enough to hug the real curve without being absurd at this scale

# One reference pixel INSIDE each of the two Waterway components that
# make up "the right waterway" Regio I's own boundary should follow --
# identified directly (not guessed) by rendering a labelled debug
# composite of the open-water mask and reading off a point inside each
# of the two pieces a real ~160px gap separates (the upper piece's own
# bounding box ends around y=985; the lower resumes around y=1143).
# Same "hand-picked, directly-confirmed reference point" convention
# style_restored_regio.py's own MAIN_CHANNEL_REFERENCE_PX /
# style_restored_waterway.py's own SEED_POINTS_PX already use for this
# same mosaic. NOTE a real mistake this went through: a first pass
# picked each bounding box's own CENTER as the reference point, which
# failed outright (`cv2.pointPolygonTest` confirmed both centers sit
# OUTSIDE their own contour) -- a thin, curving channel's bounding box
# is mostly empty space, nothing like its own filled area. Fixed by
# picking each contour's own most-interior point instead
# (`cv2.distanceTransform` peak -- the filled-mask pixel farthest from
# any edge), confirmed inside both times before committing to these
# two values.
RIGHT_WATERWAY_REFERENCE_PX = [(1204, 208), (2348, 1552)]


def _approx_to_budget(contour: np.ndarray, target_points: int) -> np.ndarray:
    """The most-detailed cv2.approxPolyDP simplification of `contour`
    that still has at most `target_points` vertices -- binary search
    over approxPolyDP's own epsilon parameter (monotonic: a larger
    epsilon can only ever produce fewer or equal points, never more),
    rather than guessing a single epsilon value and hoping it lands
    close to the target. Does NOT guarantee convexity -- a faithful
    simplification of a real (possibly concave) boundary, which is
    correct for Waterway but not for Regio's own `convex: True` path
    (see `_convex_simplify` below for that one instead)."""
    peri = cv2.arcLength(contour, True)
    lo, hi = 0.0, max(peri, 1.0)
    best = cv2.approxPolyDP(contour, hi, True)
    for _ in range(40):
        mid = (lo + hi) / 2
        approx = cv2.approxPolyDP(contour, mid, True)
        if len(approx) <= target_points:
            best = approx
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-4:
            break
    return best


def _dedupe_adjacent_px(points: list, eps: float = 8.0) -> list:
    """Drops any point within Euclidean `eps` pixels of the PREVIOUS
    kept point, consecutive-only (not an all-pairs check) -- including
    the wrap-around edge (closed-ring last-point-vs-first-point), since
    this is always applied to a CLOSED ring's own point list here.
    Checked directly against this module's own real "near-duplicate"
    case (two independently-constructed points landing ~6.3px apart,
    both approximating the same real corner) before picking 8px --
    comfortably above that, comfortably below the shortest real,
    intentional edge anywhere in this data."""
    out: list = []
    for p in points:
        if out and math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) < eps:
            continue
        out.append(p)
    if len(out) > 1 and math.hypot(out[-1][0] - out[0][0], out[-1][1] - out[0][1]) < eps:
        out.pop()
    return out


def _triangle_area(a: tuple, b: tuple, c: tuple) -> float:
    return abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2.0


def _reduce_to_n_vertices(points: list, n: int) -> list:
    """Visvalingam-Whyatt-style reduction of a CLOSED polygon's own
    ordered vertex list down to at most `n` vertices (a no-op if
    already that few) -- repeatedly drops whichever vertex currently
    contributes the least triangular area relative to its two
    immediate neighbors, recomputing neighbors after each removal,
    until `n` remain. Chosen over "every Kth point" or a fixed-epsilon
    cut because it keeps whichever vertices most define the shape's own
    silhouette and drops whichever are closest to redundant, regardless
    of where in the original ordering they fall.

    Only ever called here on an ALREADY-CONVEX point set (the output of
    `cv2.convexHull`, see `_convex_simplify` below) -- that's what makes
    the result's own convexity guaranteed, not just likely: any ordered
    subsequence of a convex polygon's own vertices is itself convex (an
    interior angle can only stay the same or get straighter/wider as
    intermediate vertices are cut, never flip into a reflex angle), so
    which vertex this function chooses to drop at each step is purely a
    "best approximation" heuristic -- it can't be the thing that
    introduces a concavity."""
    pts = list(points)
    while len(pts) > n:
        m = len(pts)
        best_i, best_area = 0, None
        for i in range(m):
            a, b, c = pts[(i - 1) % m], pts[i], pts[(i + 1) % m]
            area = _triangle_area(a, b, c)
            if best_area is None or area < best_area:
                best_area, best_i = area, i
        pts.pop(best_i)
    return pts


def _convex_simplify(contour: np.ndarray, target_points: int) -> np.ndarray:
    """Convex hull of `contour` first (which, for a mask boundary
    that's convex except for a small number of stray/jittery points,
    drops exactly those points for free -- a hull vertex is by
    definition one the boundary actually reaches furthest outward on,
    so an inward jitter is never selected), then reduced to
    `target_points` vertices via `_reduce_to_n_vertices` -- see that
    function's own comment for why the result is guaranteed convex, not
    merely usually."""
    hull = cv2.convexHull(contour)
    pts = [tuple(p[0]) for p in hull]
    if len(pts) > target_points:
        pts = _reduce_to_n_vertices(pts, target_points)
    return np.array(pts, dtype=contour.dtype).reshape(-1, 1, 2)


def _mask_from_color(png_path: Path, target_rgb: tuple, tolerance: int, alpha_min: int = 1, alpha_max: int = 255) -> np.ndarray:
    img = Image.open(png_path).convert("RGBA")
    arr = np.asarray(img)
    rgb = arr[:, :, :3].astype(int)
    diff = np.abs(rgb - np.array(target_rgb)).sum(axis=2)
    alpha = arr[:, :, 3]
    return (diff < tolerance) & (alpha >= alpha_min) & (alpha <= alpha_max)


def _kept_components(mask: np.ndarray) -> tuple:
    """Every non-hole contour of `mask` above MIN_COMPONENT_AREA_PX,
    largest first, plus the raw (pre-filter) contour count for logging
    -- the same filtering the original single-purpose vectorize_mask()
    used, factored out since this module now needs it from more than
    one place (open water, bridges, Regio I)."""
    mask_u8 = mask.astype(np.uint8) * 255
    contours, hierarchy = cv2.findContours(mask_u8, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    kept = []
    for contour, h in zip(contours, hierarchy[0]):
        if h[3] != -1:
            continue  # a hole -- see the original vectorize_mask's own comment on why these are always dropped, not represented
        area = cv2.contourArea(contour)
        if area < MIN_COMPONENT_AREA_PX:
            continue
        kept.append((contour, area))
    kept.sort(key=lambda t: -t[1])
    return kept, len(contours)


def _allocate_points(areas: list, total_budget: int) -> list:
    """Same proportional-by-area, floored-at-MIN_POINTS_PER_RING,
    trim-the-largest-until-it-fits allocation the original
    vectorize_mask used -- factored out unchanged."""
    total_area = sum(areas)
    raw = [total_budget * a / total_area for a in areas] if total_area else []
    alloc = [max(MIN_POINTS_PER_RING, int(r)) for r in raw]
    while sum(alloc) > total_budget:
        i = alloc.index(max(alloc))
        if alloc[i] <= MIN_POINTS_PER_RING:
            break
        alloc[i] -= 1
    return alloc


def _component_containing(kept: list, px: float, py: float):
    for contour, area in kept:
        if cv2.pointPolygonTest(contour, (float(px), float(py)), False) >= 0:
            return contour, area
    raise ValueError(f"no kept component contains ({px}, {py}) -- reference point stale?")


def _west_facing_chain(contour: np.ndarray) -> list:
    """For a channel-like (long, thin, roughly-vertical) contour, the
    subset of its own boundary points that face west (toward Regio I),
    ordered top-to-bottom -- found by splitting the closed ring at its
    topmost and bottommost points into its two constituent arcs, then
    keeping whichever arc has the smaller mean x (further west/left in
    pixel space, i.e. smaller longitude once converted)."""
    pts = [tuple(p[0]) for p in contour]
    n = len(pts)
    top_i = min(range(n), key=lambda i: pts[i][1])
    bot_i = min(range(n), key=lambda i: -pts[i][1])

    def arc(i: int, j: int) -> list:
        out, k = [], i
        while True:
            out.append(pts[k])
            if k == j:
                return out
            k = (k + 1) % n

    arc_a = arc(top_i, bot_i)
    arc_b = list(reversed(arc(bot_i, top_i)))  # also top-to-bottom, the other way around the ring
    mean_x_a = sum(p[0] for p in arc_a) / len(arc_a)
    mean_x_b = sum(p[0] for p in arc_b) / len(arc_b)
    return arc_a if mean_x_a < mean_x_b else arc_b


def _simplify_open_chain(chain_px: list, target_points: int) -> list:
    """Same binary-search-over-approxPolyDP-epsilon approach as
    `_approx_to_budget`, but for an OPEN polyline (closed=False in both
    the arc-length and approx calls) -- a west-facing chain has two
    real, distinct endpoints, not a loop back to its own start."""
    arr = np.array(chain_px, dtype=np.float32).reshape(-1, 1, 2)
    peri = cv2.arcLength(arr, False)
    lo, hi = 0.0, max(peri, 1.0)
    best = cv2.approxPolyDP(arr, hi, False)
    for _ in range(40):
        mid = (lo + hi) / 2
        approx = cv2.approxPolyDP(arr, mid, False)
        if len(approx) <= target_points:
            best = approx
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-4:
            break
    return [tuple(p[0]) for p in best]


def build_waterway_bridges_and_regio() -> dict:
    bounds = json.loads(WATERWAY_BOUNDS.read_text())

    def px_to_lonlat(x: float, y: float) -> list:
        lon = bounds["west"] + (x / bounds["widthPx"]) * (bounds["east"] - bounds["west"])
        lat = bounds["north"] - (y / bounds["heightPx"]) * (bounds["north"] - bounds["south"])
        # float(...) explicitly -- `x`/`y` can arrive as numpy.float32
        # (from _simplify_open_chain's own cv2.approxPolyDP output,
        # which inherits the float32 dtype its input array was built
        # with), and numpy scalar types aren't JSON-serializable.
        return [float(lon), float(lat)]

    # ── Waterway: open water only -- bridges excluded, see this
    # section's own header comment. ──
    open_mask = _mask_from_color(WATERWAY_PNG, WATER_BLUE, WATER_COLOR_TOLERANCE, alpha_min=150)
    open_kept, open_raw_count = _kept_components(open_mask)
    open_alloc = _allocate_points([area for _, area in open_kept], WATERWAY_POINT_BUDGET)

    polygon_parts = []
    waterway_total_points = 0
    for (contour, area), target in zip(open_kept, open_alloc):
        approx = _approx_to_budget(contour, target)
        pts = [px_to_lonlat(float(p[0][0]), float(p[0][1])) for p in approx]
        if len(pts) < 3:
            continue
        pts.append(pts[0])
        polygon_parts.append([pts])
        waterway_total_points += len(pts) - 1

    waterway_feature = {
        "type": "Feature",
        "properties": {"layer": "waterway", "plan": "restored", "source_components": len(open_kept), "vertex_count": waterway_total_points},
        "geometry": {"type": "MultiPolygon", "coordinates": polygon_parts},
    }
    (OUT_DIR / "restored_waterway.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [waterway_feature]}))
    print(
        f"  restored_waterway: kept {len(open_kept)} open-water region(s) of {open_raw_count} raw contours "
        f"(bridges excluded), {waterway_total_points} total vertices (budget {WATERWAY_POINT_BUDGET})"
    )

    # ── Bridges: one short dashed connector per bridge blob, spanning
    # its own bounding box vertically -- confirmed directly: every real
    # bridge in this dataset crosses a roughly-vertical stretch of the
    # left channel, so "top of its own bbox" to "bottom of its own
    # bbox" is a faithful, not just convenient, connector endpoint
    # choice here (not a generic assumption this function makes for an
    # arbitrarily-oriented future bridge). ──
    bridge_mask = _mask_from_color(WATERWAY_PNG, WATER_BLUE, WATER_COLOR_TOLERANCE, alpha_min=1, alpha_max=150)
    bridge_kept, bridge_raw_count = _kept_components(bridge_mask)
    bridge_features = []
    for i, (contour, area) in enumerate(bridge_kept):
        x, y, w, h = cv2.boundingRect(contour)
        cx = x + w / 2
        bridge_features.append({
            "type": "Feature",
            "properties": {"layer": "waterway_bridge", "plan": "restored", "bridge_index": i, "area_px": area},
            "geometry": {"type": "LineString", "coordinates": [px_to_lonlat(cx, y), px_to_lonlat(cx, y + h)]},
        })
    (OUT_DIR / "restored_waterway_bridges.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": bridge_features})
    )
    print(f"  restored_waterway_bridges: {len(bridge_features)} bridge connector(s) of {bridge_raw_count} raw contours")

    # ── Regio I: hexagon-ish hull on 3 sides, a real Waterway-derived
    # trace on the 4th -- see this section's own header comment. ──
    regio_mask = _mask_from_color(
        MAP_FEATURES_DIR / "SamoWeb_RestoredStatePlan_Regio1.png", REGIO_PURPLE, REGIO_COLOR_TOLERANCE
    )
    regio_kept, regio_raw_count = _kept_components(regio_mask)
    regio_contour, regio_area = regio_kept[0]  # confirmed directly: exactly one real region
    hexagon_px = [tuple(p[0]) for p in _convex_simplify(regio_contour, REGIO_HEXAGON_POINTS)]

    upper_contour, upper_area = _component_containing(open_kept, *RIGHT_WATERWAY_REFERENCE_PX[0])
    lower_contour, lower_area = _component_containing(open_kept, *RIGHT_WATERWAY_REFERENCE_PX[1])
    trace_alloc = _allocate_points([upper_area, lower_area], REGIO_TRACE_POINT_BUDGET)
    upper_chain = _simplify_open_chain(_west_facing_chain(upper_contour), trace_alloc[0])
    lower_chain = _simplify_open_chain(_west_facing_chain(lower_contour), trace_alloc[1])
    # Concatenating the two chains directly, with nothing in between, IS
    # the "straight line between the two segments" the gap needs --
    # a polygon's own edges are already straight between whichever
    # vertices are listed consecutively, so upper_chain's own last point
    # connecting straight to lower_chain's own first point requires no
    # separate connector geometry of its own.
    trace_px = upper_chain + lower_chain

    # Which 2 of the hexagon's own 6 vertices does this trace replace?
    # Nearest-vertex-to-each-trace-endpoint, then whichever of the two
    # possible paths BETWEEN those vertices (a hexagon has two: "the
    # short way" is ambiguous here since the replaced span is roughly a
    # half-hexagon) has the higher mean longitude -- i.e. is actually
    # the EASTERLY/right side, matching "the regio bounds on the
    # right" -- is the one dropped. The other path's own vertices are
    # kept unchanged.
    def nearest_hexagon_index(point: tuple) -> int:
        return min(range(len(hexagon_px)), key=lambda i: (hexagon_px[i][0] - point[0]) ** 2 + (hexagon_px[i][1] - point[1]) ** 2)

    idx_top = nearest_hexagon_index(trace_px[0])
    idx_bottom = nearest_hexagon_index(trace_px[-1])
    n = len(hexagon_px)

    # `path_indices(start, end, step)` walks the hexagon's own cyclic
    # index space from `start`, stepping by `step` (mod n) each time,
    # INCLUDING `end` as its own last element but never `start` itself
    # -- e.g. with a 6-vertex hexagon, idx_top=0, idx_bottom=3, step=1:
    # returns [1, 2, 3].
    def path_indices(start: int, end: int, step: int) -> list:
        out, k = [], start
        while k != end:
            k = (k + step) % n
            out.append(k)
        return out

    def strictly_between(start: int, end: int, step: int) -> list:
        """Same walk, but with `end` itself dropped from the result --
        the vertices strictly between `start` and `end`, used only to
        decide which direction's intermediate vertices to replace
        (idx_top/idx_bottom themselves are never candidates to drop --
        see below)."""
        full = path_indices(start, end, step)
        return full[:-1] if full else full

    forward_mid = strictly_between(idx_top, idx_bottom, 1)
    backward_mid = strictly_between(idx_top, idx_bottom, -1)

    def mean_lon(indices: list) -> float:
        return sum(hexagon_px[i][0] for i in indices) / len(indices) if indices else float("-inf")

    # Drop whichever path's own intermediate vertices are the more
    # easterly (the real "right side") -- idx_top/idx_bottom themselves
    # always stay, as the splice points the trace connects into.
    if mean_lon(forward_mid) > mean_lon(backward_mid):
        drop_path, keep_step = forward_mid, 1
    else:
        drop_path, keep_step = backward_mid, -1
    # Continuing the SAME rotational step from idx_bottom (not idx_top)
    # walks the COMPLEMENTARY arc -- the one that was never visited by
    # strictly_between(idx_top, idx_bottom, keep_step) above, which is
    # exactly the kept side (e.g. bottom -> ...left-side vertices... ->
    # top, for a 6-vertex hexagon where the dropped arc ran top -> ...
    # right-side vertices... -> bottom the other way).
    kept_sequence_px = [hexagon_px[idx_bottom]] + [hexagon_px[i] for i in path_indices(idx_bottom, idx_top, keep_step)]

    # `hexagon_px[idx_bottom]` (and, in principle, `hexagon_px[idx_top]`)
    # was chosen specifically for being the hexagon's own NEAREST vertex
    # to the trace's corresponding endpoint -- confirmed directly, that
    # can mean "nearest" is "the same real point to within sub-pixel
    # noise" (idx_bottom's own position and trace_px[-1] landed ~2px
    # apart here), not just "closest among 6 options." Left undeduped,
    # that's a near-zero-length edge shapely correctly flags as a
    # self-intersection (`is_valid` was checked directly, not assumed)
    # -- `_dedupe_adjacent_px` drops either point of any such
    # near-duplicate pair, consecutive-only (including the wrap-around
    # closing edge), rather than only special-casing idx_top/idx_bottom
    # specifically.
    final_ring_px = _dedupe_adjacent_px(kept_sequence_px + trace_px)
    final_ring_lonlat = [px_to_lonlat(x, y) for x, y in final_ring_px]
    final_ring_lonlat.append(final_ring_lonlat[0])

    regio_feature = {
        "type": "Feature",
        "properties": {
            "layer": "regio",
            "regio": "I",
            "plan": "restored",
            "vertex_count": len(final_ring_lonlat) - 1,
        },
        "geometry": {"type": "MultiPolygon", "coordinates": [[final_ring_lonlat]]},
    }
    (OUT_DIR / "regio_1.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [regio_feature]}))
    print(
        f"  regio_1: {REGIO_HEXAGON_POINTS}-vertex hull with {len(drop_path)} vertex/vertices replaced by a "
        f"{len(trace_px)}-point Waterway-derived trace ({len(upper_chain)}+{len(lower_chain)}), "
        f"{len(final_ring_lonlat) - 1} total vertices"
    )

    # restored_waterway/regio_1 are each ONE Feature (a MultiPolygon
    # whose own coordinate array holds every disconnected piece) --
    # featureCount: 1 is correct for both, same convention every other
    # layer's own featureCount already follows (Feature count, not
    # geometry-part count). restored_waterway_bridges is genuinely
    # multiple Features (one LineString per bridge), so its own count
    # needs to reflect that for real, not be hardcoded alongside the
    # other two.
    return {"restored_waterway": 1, "restored_waterway_bridges": len(bridge_features), "regio_1": 1}


# ── metadata.json -- same shape as clip_natural_earth.py's own
# write_metadata, consumed identically by desk_hmsvc/samothrace-vectors/
# service.py. ──


def write_metadata(feature_counts: dict) -> None:
    bounds = json.loads(WATERWAY_BOUNDS.read_text())
    west, south, east, north = bounds["west"], bounds["south"], bounds["east"], bounds["north"]
    layers = []
    for layer_id, style in LAYER_STYLES.items():
        entry = {"id": layer_id, "url": f"/data/{layer_id}.geojson", "featureCount": feature_counts[layer_id]}
        entry.update(style)
        layers.append(entry)
    layers.sort(key=lambda entry: entry["order"])
    metadata = {
        "bounds": {"west": west, "south": south, "east": east, "north": north},
        "center": {"lon": (west + east) / 2, "lat": (south + north) / 2},
        "layers": layers,
    }
    (OUT_DIR / "metadata.json").write_text(json.dumps(metadata, indent=2))
    print(f"  wrote {OUT_DIR / 'metadata.json'}")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    print("Extracted Contours...")
    counts.update(build_contours())
    print("Restored State -- Structures...")
    counts.update(build_structures())
    print("Restored State -- Waterway + Bridges + Regio I...")
    counts.update(build_waterway_bridges_and_regio())
    write_metadata(counts)
    print(f"done -- {sum(counts.values())} features across {len(counts)} layers in {OUT_DIR}")


if __name__ == "__main__":
    main()
