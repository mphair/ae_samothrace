#!/usr/bin/env python3
"""Extracts semantic vector layers from the raw Actual/Restored State Plan
raster tiles in Data/mapTiles/ -- specifically:

  - Topographic contour lines, per plan (Actual, Restored), as LineString
    features with an elevation (meters) attribute where a nearby contour
    label could be read via OCR.
  - The blue dashed stream-path lines in the Actual State Plan, as
    LineString features (per TODO in topo-compare-log.json entry #2).

Why this exists: the samothrace-tiles hmsvc service's "topographic" layer
(see desk_hmsvc/samothrace-tiles/service.py) is a *raster* diff between
the two plans, which turned out to be unreliable (non-terrain content
leaking in, apparent misalignment between the two source plans -- see
the topo-compare widget). This script instead extracts the contour lines
directly from each plan's own raster, independently, as real vector
geometry -- no cross-plan diffing involved, so each plan's own contours
are only as good as that plan's own linework.

## Approach

Reorganized (see "please take another pass at the 1m minor contours" in
the chat history) into explicit, named stages -- each one's output is
snapshotted as a PNG under .desk_temp/pipeline-stages/<plan>/ for the
Pipeline Stage Viewer widget, so the effect of any one stage can be
seen in isolation rather than only inferred from the final result:

0. Stitch every zoom-20 tile for a plan into one RGBA mosaic (0.11 m/px
   at this site's latitude -- enough resolution to resolve individual
   contour strokes and OCR the small elevation labels, while staying to
   a single ~2560x2304px image per plan instead of zoom 22's ~9200x8960).
   Split into blue_mask (stream paths) / ink_mask (everything else).
1. STRUCTURE EXCLUSION (new): rasterize + buffer every mapped building
   /monument footprint polygon (Data/mapFeatures/SamoWeb_<Plan>_Overlay
   .geojson -- ground truth, the same vectors the main SamothraceMap
   widget already uses for hit-testing) and remove that ink entirely.
   Catches not just each building's own wall stroke (the thick/thin
   split below already handled that) but the decorative tick/comb
   hachure some retaining-wall edges are drawn with just outside the
   wall line itself, which a stroke-width threshold alone can't tell
   apart from contour linework. See build_structure_exclusion_mask.
2. Classify the REMAINING ink by *local stroke width* (a per-pixel
   distance-transform threshold, not a per-component one -- see the
   long comment on classify_ink below for why): thin strokes are
   contour-line candidates, thick strokes are structure walls
   (discarded -- a backstop for anything not caught by stage 1, e.g. a
   wall not in the Overlay file).
3. Skeletonize the thin-stroke mask, then cut it at branch points. Two
   contour lines that visually cross/touch merge into one connected
   component with a real branch point at the crossing -- cutting there
   (rather than rejecting the whole component) keeps each individual
   arc between crossings as its own clean, unbranched path, which is
   also what text/symbol strokes become -- so a plain *length* filter
   on these cut fragments turns out to cleanly separate "long smooth
   arcs" (contours) from "short branchy strokes" (digits, tick-mark
   symbols) without needing any text-specific logic. See
   `.desk_temp` chat history / commit message for the prototyping that
   led here (classify_check.png through classify_check5.png in /tmp).
4. CIRCLE-CHAIN EXCLUSION (new): "stretches of lines made of circles"
   (confirmed by direct inspection -- a chain of touching/overlapping
   open rings, likely a stone-alignment or reinforcement convention,
   distinct from the solid filled dots inside mapped footprints that
   stage 1 already removes). Per-fragment circle-fit quality alone
   wasn't a safe discriminator (real sharp terrain curvature mimics a
   small circle just as often) -- only a CLUSTER of several similarly
   -sized round fragments close together gets excluded. See
   find_circular_chain_fragments's own header comment.
5. Elevation labels interrupt their contour line with a genuine gap (no
   ink at all) rather than touching it -- so the label text ends up as
   its own small, isolated connected component in the *original* ink
   mask. For each such small isolated component, look for a pair of
   nearby contour-fragment endpoints roughly straddling it; if found,
   crop + upscale that region and OCR it (via `ocrmac`, which wraps
   macOS's built-in Vision text recognizer -- no external OCR binary
   needed). try_ocr_elevation then classifies the reading:
     - a plausible-range value that's a multiple of CONTOUR_INTERVAL_M
       (5m, confirmed -- see CONTOUR_INTERVAL_M's own comment) is
       auto-accepted: the two fragments merge into one feature carrying
       that elevation, same as before.
     - a plausible-range value that ISN'T a multiple of 5 is suspicious
       -- neither accepted nor discarded, but queued in a per-plan
       `*.review_queue.json` file (written by write_review_queue) for a
       human to judge via the contour-label-review widget, complete with
       the exact cropped image OCR saw. This is how a real bug got
       caught in the first place: OCR misread a small contour
       loop/switchback as "09" (9m) at confidence 0.5, indistinguishable
       by confidence alone from genuine labels also read at 0.5-1.0 --
       but multiple-of-5 cleanly flags it. Confidence and text
       -cleanliness were both tried and dropped as the primary gate: real
       labels routinely OCR "messy" (e.g. "-45-", "55-") because the
       source draws small leader ticks flanking the digits.
     - no digit-bearing text, or a value way outside the plausible
       range, is neither accepted nor queued -- not even worth asking a
       human about (the overwhelming majority of label-shaped candidates
       are non-label symbols: tick marks, scree-pattern dots, ...);
       keeping this bucket silent is what keeps the review queue small.
6. MINOR-CONTOUR BANDING (new): between two adjacent (5m-apart) labeled
   index contours there should be CONTOUR_INTERVAL_M - 1 = 4 unlabeled
   1m contours (confirmed by direct visual inspection -- a labeled
   index contour is visibly drawn bolder than the minor contours
   between it and its neighbor). Groups unlabeled fragments by nearest
   -adjacent-index-pair, splits each pairing back into its own separate
   real-world occurrences by spatial proximity (the same pairing can
   recur on unrelated hillsides), and only commits actual 1m elevations
   when a group looks unambiguous (exactly 4 well-separated members) --
   everything else is queued in `*.minor_review_queue.json` instead of
   guessed at. See band_minor_contours's own header comment for why
   this is a real heuristic over genuinely ambiguous terrain, not a
   solved problem -- expect a substantial share of groups to need
   human review, by design.
7. Reproject pixel coordinates to lon/lat with the same Web Mercator
   math every other widget/service in this project already uses.
8. Write one GeoJSON FeatureCollection per plan/layer to
   Data/mapFeatures/, 2D LineString geometries (not 3D/XYZ) with the
   elevation as a feature property -- this matches the real-world GIS
   convention (gdal_contour's own default output shape: 2D geometry +
   an "ELEV"-style attribute field, '-3d' is the non-default opt-in for
   embedding elevation in the geometry itself) rather than GeoJSON's
   *possible* but less common third-coordinate-per-vertex convention.

## Known limitations (this is an exploratory first pass, not a
verified survey-grade digitization)

- Only contour lines with a *legible, OCR-readable, nearby* label (and,
  since the review-queue stage was added, one that's a multiple of 5m)
  get a real elevation value; everything else is written with
  `"elevation_m": null` and `"elevation_source": "unlabeled"`. Typically
  20-35 fragments per plan end up labeled out of ~950-1800 total -- see
  the printed summary at the end of a run. A genuinely-real non-multiple
  -of-5 elevation would currently always land in the review queue rather
  than ever being auto-accepted; given every confirmed label on this
  site so far has been a multiple of 5, that trade-off seems right for
  now, but it's a real assumption baked into the classifier, not a law
  of nature.
- A contour line that crosses another contour (or a stream, or a
  structure wall) is cut into separate features at each crossing,
  rather than reconstructed as one continuous line -- each piece is
  geometrically correct, just not merged across the crossing.
- The long dash-dot *survey boundary* line around the whole plan is
  thin enough to pass the stroke-width filter and can leak into the
  contour output as a few extra features; it's visually distinctive
  (runs along the plan's own border) and was not specifically filtered
  out.
- Resolution is zoom-20 (~0.11 m/pixel); never re-reads the original
  CAD/GIS source (if one still exists outside this exported repo), so
  this can't be more accurate than that pixel grid allows.
- Re-running this script after a prior run's output already has human
  corrections/review-answers applied (via the TopoCompare widget's edit
  mode, or the contour-label-review widget) can shift which array index
  refers to which fragment -- those corrections key off array position
  (see *.corrections.json), not a geometry-stable id. A re-run that
  changes auto-merge behavior anywhere in a plan can silently invalidate
  existing corrections for that plan. There's no automatic reconciliation
  for this yet; a re-run needs a manual recheck of existing
  *.corrections.json entries against the new output.
- Minor-contour banding (stage 6) currently auto-accepts only a small
  minority of groups -- most real terrain here doesn't offer a clean
  "exactly 4 well-separated fragments" between two index contours
  (crossings/structures/gaps fragment what's really one 1m line into
  several pieces more often than not), so most groups land in
  *.minor_review_queue.json. That's a large number of groups (dozens to
  ~150+ per plan at current tuning), most of them small (1-3
  fragments) -- genuinely more review volume than the label-review
  queue ever produced, flagged here rather than hidden.

Usage:
    python3 scripts/extract_vector_layers.py
    (run from the project root; paths below are project-relative)
"""
from __future__ import annotations

import base64
import io
import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree
from skimage.morphology import skeletonize

PROJECT_DIR = Path(__file__).resolve().parent.parent
TILES_DIR = PROJECT_DIR / "Data" / "mapTiles"
FEATURES_DIR = PROJECT_DIR / "Data" / "mapFeatures"

ZOOM = 20
TILE = 256

PLAN_TILE_DIRS = {
    "actual": TILES_DIR / "SamoWebsite_ActualStatePlan_3857",
    "restored": TILES_DIR / "SamoWebsite_RestoredStatePlan_3857",
}

# ── Web Mercator (EPSG:3857), same formula as samothrace-map.ts /
# topo-compare.ts's unprojectWorld. ──


def unproject_world(x: float, y: float, zoom: int, tile_size: int) -> tuple[float, float]:
    n = 2**zoom * tile_size
    lon = (x / n) * 360 - 180
    lat_rad = math.atan(math.sinh(math.pi * (1 - (2 * y) / n)))
    return lon, math.degrees(lat_rad)


# ── Mosaic loading ──


@dataclass
class Mosaic:
    rgba: np.ndarray  # (H, W, 4) uint8
    x_min_tile: int  # XYZ tile x of the mosaic's left edge
    y_min_tile: int  # XYZ tile y of the mosaic's top edge


def load_plan_mosaic(plan: str) -> Mosaic:
    base = PLAN_TILE_DIRS[plan] / str(ZOOM)
    x_dirs = sorted(int(p.name) for p in base.iterdir() if p.is_dir())
    x_min, x_max = x_dirs[0], x_dirs[-1]
    # y on disk is TMS (south-origin); every .png under the first x dir
    # gives us the TMS y range, which we convert to XYZ below.
    first_dir = base / str(x_min)
    y_tms_vals = sorted(int(p.stem) for p in first_dir.glob("*.png"))
    y_tms_min, y_tms_max = y_tms_vals[0], y_tms_vals[-1]
    max_index = 2**ZOOM - 1
    y_xyz_min = max_index - y_tms_max  # northernmost row -> top of mosaic
    y_xyz_max = max_index - y_tms_min

    cols = x_max - x_min + 1
    rows = y_xyz_max - y_xyz_min + 1
    mosaic = Image.new("RGBA", (cols * TILE, rows * TILE), (0, 0, 0, 0))
    missing = 0
    for yi, y_xyz in enumerate(range(y_xyz_min, y_xyz_max + 1)):
        y_tms = max_index - y_xyz
        for xi, x in enumerate(range(x_min, x_max + 1)):
            p = base / str(x) / f"{y_tms}.png"
            if p.is_file():
                with Image.open(p) as im:
                    mosaic.paste(im.convert("RGBA"), (xi * TILE, yi * TILE))
            else:
                missing += 1
    if missing:
        print(f"  ({missing} missing tiles left blank)")
    return Mosaic(rgba=np.array(mosaic), x_min_tile=x_min, y_min_tile=y_xyz_min)


def pixel_to_lonlat(mosaic: Mosaic, px: float, py: float) -> tuple[float, float]:
    world_x = mosaic.x_min_tile * TILE + px
    world_y = mosaic.y_min_tile * TILE + py
    return unproject_world(world_x, world_y, ZOOM, TILE)


def lonlat_to_pixel(mosaic: Mosaic, lon: float, lat: float) -> tuple[float, float]:
    """Inverse of pixel_to_lonlat -- forward Web Mercator projection,
    same formula as project_world in samothrace-map.ts/topo-compare.ts."""
    n = 2**ZOOM * TILE
    world_x = (lon + 180) / 360 * n
    lat_rad = math.radians(lat)
    world_y = (1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n
    return world_x - mosaic.x_min_tile * TILE, world_y - mosaic.y_min_tile * TILE


# ── Structure (building/monument footprint) exclusion ──
# Ground truth, not inferred from the raster at all: the same
# Overlay.geojson polygons the main SamothraceMap widget already uses
# for hit-testing. Rasterizing and buffering them lets contour
# extraction simply never consider ink inside or near a mapped
# footprint, which is both more reliable than the stroke-width-based
# thick/thin split alone (that catches a building's own wall stroke,
# but not decorative hachure drawn just outside it -- confirmed by
# direct inspection: the "stepped retaining wall" tick/comb pattern on
# monument 30 and others runs right alongside the wall line, within a
# few pixels of the polygon boundary) and a useful cross-check on it.


def load_structure_polygons(plan: str) -> list[list[tuple[float, float]]]:
    """Every building/monument footprint ring (lon, lat) for `plan`.
    MultiPolygon holes aren't modeled (every ring is treated as a solid
    fill) -- none of this project's monument footprints are annotated
    with one, so this is a simplification with no actual effect here,
    not a silently-wrong approximation."""
    plan_label = "ActualStatePlan" if plan == "actual" else "RestoredStatePlan"
    path = FEATURES_DIR / f"SamoWeb_{plan_label}_Overlay.geojson"
    if not path.is_file():
        return []
    data = json.loads(path.read_text())
    rings: list[list[tuple[float, float]]] = []
    for feature in data["features"]:
        geom = feature["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            for ring in poly:
                rings.append([(lon, lat) for lon, lat in ring])
    return rings


# How far (px) beyond a mapped building's own footprint outline to also
# exclude -- wide enough to cover the decorative tick/comb hachure some
# retaining-wall edges are drawn with, without being so wide it eats
# real contour lines that happen to pass near a building.
STRUCTURE_BUFFER_PX = 14


def build_structure_exclusion_mask(plan: str, mosaic: Mosaic) -> np.ndarray:
    from PIL import ImageDraw

    rings = load_structure_polygons(plan)
    h, w = mosaic.rgba.shape[:2]
    img = Image.new("1", (w, h), 0)
    draw = ImageDraw.Draw(img)
    for ring in rings:
        pts = [lonlat_to_pixel(mosaic, lon, lat) for lon, lat in ring]
        if len(pts) >= 3:
            draw.polygon(pts, fill=1)
    mask = np.array(img, dtype=bool)
    if STRUCTURE_BUFFER_PX > 0:
        mask = ndimage.binary_dilation(mask, iterations=STRUCTURE_BUFFER_PX)
    return mask


# ── Decorative circle-chain exclusion ──
# "Stretches of lines made of circles" (confirmed by direct inspection:
# a chain of touching/overlapping open rings, e.g. between the
# buildings near monuments 4/6 -- likely a stone alignment or
# reinforcement convention, distinct from the solid filled dots used
# elsewhere, which are inside mapped footprints and already handled by
# the structure exclusion above). Two things were tried and rejected as
# the sole per-fragment discriminator before this: stroke-width
# variance (real contour fragments can have genuinely variable local
# width too, confounded the same way the index/minor stroke-width
# measurement was) and arc-to-chord ratio (a legitimately closed
# contour loop around a small hilltop/pit has a high ratio too, for the
# same structural reason a decorative circle does). What calibration
# against real data DID show cleanly: an individual fragment that fits
# a small circle well is just as often genuine sharp terrain curvature
# as it is a decoration -- but a CLUSTER of several similarly-sized
# round fragments close together essentially never happens by terrain
# coincidence. Only clusters are excluded; an isolated round-ish
# fragment is left alone.


def fit_circle(path: list[tuple[int, int]]) -> tuple[float, float] | None:
    """Kasa algebraic circle fit. Returns (radius_px, normalized_rms)
    where normalized_rms is the fit residual as a fraction of the
    radius (0 = perfect circle). None if the fit is degenerate (path
    too short, or points too close to collinear to fit uniquely)."""
    pts = np.array(path, dtype=float)
    if len(pts) < 6:
        return None
    y, x = pts[:, 0], pts[:, 1]
    u, v = x - x.mean(), y - y.mean()
    suu, svv, suv = (u * u).sum(), (v * v).sum(), (u * v).sum()
    suuu, svvv = (u**3).sum(), (v**3).sum()
    suvv, svuu = (u * v * v).sum(), (v * u * u).sum()
    a_mat = np.array([[suu, suv], [suv, svv]])
    b_vec = 0.5 * np.array([suuu + suvv, svvv + svuu])
    try:
        uc, vc = np.linalg.solve(a_mat, b_vec)
    except np.linalg.LinAlgError:
        return None
    r_sq = uc**2 + vc**2 + (suu + svv) / len(pts)
    if r_sq <= 0:
        return None
    r = math.sqrt(r_sq)
    cx, cy = x.mean() + uc, y.mean() + vc
    resid = np.hypot(x - cx, y - cy) - r
    return r, math.sqrt((resid**2).mean()) / r


CIRCULARITY_MAX_RADIUS_PX = 25.0
CIRCULARITY_MAX_NORMALIZED_RMS = 0.14
CIRCULARITY_CLUSTER_RADIUS_PX = 40.0
MIN_CHAIN_CLUSTER_SIZE = 3


def cluster_by_proximity(points: list[tuple[int, float, float]], radius: float) -> list[list[int]]:
    """Single-link spatial clustering: (id, x, y) points within `radius`
    of each other -- possibly transitively, through a chain of other
    points -- end up in the same cluster. Shared by
    find_circular_chain_fragments (clustering candidate circle
    fragments into actual chains) and band_minor_contours (splitting a
    same-elevation-pair group back into its separate local occurrences,
    e.g. the same "40-45m" band on two different, unrelated hillsides).
    O(n^2) -- fine at the scales this script calls it at (tens to low
    hundreds of points per call)."""
    parent = {pid: pid for pid, _, _ in points}

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    for a in range(len(points)):
        ia, xa, ya = points[a]
        for b in range(a + 1, len(points)):
            ib, xb, yb = points[b]
            if math.hypot(xa - xb, ya - yb) <= radius:
                union(ia, ib)

    clusters: dict[int, list[int]] = {}
    for pid, _, _ in points:
        clusters.setdefault(find(pid), []).append(pid)
    return list(clusters.values())


def find_circular_chain_fragments(fragments: list[Fragment]) -> set[int]:
    """Returns the set of indices into `fragments` that look like part
    of a decorative chain-of-circles symbol -- see this section's own
    header comment for the detection strategy and why it's cluster
    -based rather than per-fragment."""
    round_candidates: list[tuple[int, float, float]] = []  # (frag index, cx, cy)
    for idx, frag in enumerate(fragments):
        fit = fit_circle(frag.path)
        if fit is None:
            continue
        r, nrms = fit
        if r <= CIRCULARITY_MAX_RADIUS_PX and nrms <= CIRCULARITY_MAX_NORMALIZED_RMS:
            rows = [p[0] for p in frag.path]
            cols = [p[1] for p in frag.path]
            round_candidates.append((idx, sum(cols) / len(cols), sum(rows) / len(rows)))

    excluded: set[int] = set()
    for members in cluster_by_proximity(round_candidates, CIRCULARITY_CLUSTER_RADIUS_PX):
        if len(members) >= MIN_CHAIN_CLUSTER_SIZE:
            excluded.update(members)
    return excluded


# ── Color / stroke-width classification ──


def color_masks(rgba: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Returns (blue_mask, ink_mask). blue_mask is the stream-path line
    color (sampled directly off the tiles: a saturated sky blue, roughly
    RGB(0,153,255) at full opacity, antialiased toward white at edges).
    ink_mask is everything else non-transparent and dark enough to be
    linework/text (deliberately excludes the sampled blue so the two
    never overlap)."""
    r = rgba[..., 0].astype(int)
    g = rgba[..., 1].astype(int)
    b = rgba[..., 2].astype(int)
    a = rgba[..., 3]
    blue_mask = (a > 0) & (b > 150) & ((b - r) > 50) & ((b - g) > 10)
    luminance = 0.299 * r + 0.587 * g + 0.114 * b
    ink_mask = (a > 0) & ~blue_mask & (luminance < 200)
    return blue_mask, ink_mask


# Local stroke half-width (px) at or below which ink counts as "thin"
# (contour-line-like) rather than "thick" (structure-wall-like). This is
# a PER-PIXEL threshold on the distance transform, deliberately not a
# per-connected-component one: a contour line that happens to touch a
# thick wall (common -- contours often run right up to a building's
# footprint) would otherwise drag its entire component over a
# per-component threshold and get discarded wholesale. Per-pixel keeps
# the genuinely-thin parts even when they touch something thick.
THIN_HALF_WIDTH_PX = 2.0
# After the thin/thick split, strip any thin pixels within this many px
# of a thick region -- these are the antialiased edge-halo of the thick
# stroke itself (locally "thin" by the distance transform, but not a
# separate line), not real contour ink.
THICK_HALO_STRIP_PX = 2
# Minimum length (px) for a cut skeleton fragment to count as a genuine
# contour-line arc rather than a digit stroke or tick-mark symbol
# fragment -- see the module docstring for why length-after-cutting is
# an effective discriminator here.
MIN_FRAGMENT_LEN_PX = 18
# Max pixel distance allowed between the two fragment endpoints a label
# gap is allowed to bridge -- see the comment at its use in
# merge_labeled_fragments for why this is needed in addition to the
# per-endpoint search radius.
MAX_LABEL_GAP_PX = 45

# The site's index (labeled) contours run every 5m, confirmed two ways:
# every OCR-read label across both plans' extractions is a multiple of
# 5 (25, 30, 35, ... 60 -- never anything else), AND a direct visual
# check at full zoom (see topo-compare-log.json entry #4 / the chat
# that investigated it) shows the labeled contours are drawn with a
# visibly bolder stroke than the ~4 unlabeled intermediate contours
# between each pair -- the standard index/minor-contour cartographic
# convention, meaning those in-between lines are real, deliberate 1m
# contours, not an extraction artifact. (A per-fragment stroke-width
# *measurement*, to directly tag minor vs. index fragments, was tried
# and abandoned -- see classify_ink's own distance-transform approach:
# it measures distance to the nearest background pixel, which in
# crowded hillside areas is frequently capped by a *neighboring*
# contour line rather than by this line's own pen width, so index and
# minor fragments came out statistically indistinguishable (93% of all
# fragments bottomed out at the same minimum measured half-width
# regardless of their true drawn weight). The multiple-of-5 check below
# doesn't need that measurement anyway -- it's a direct, much more
# reliable consequence of the same confirmed convention.)
CONTOUR_INTERVAL_M = 5


def classify_ink(ink_mask: np.ndarray) -> np.ndarray:
    """Returns thin_px: the stroke-width-filtered mask that
    skeletonize()/fragment-tracing runs on next."""
    dist = ndimage.distance_transform_edt(ink_mask)
    thin_px = ink_mask & (dist <= THIN_HALF_WIDTH_PX)
    thick_px = ink_mask & (dist > THIN_HALF_WIDTH_PX)
    thick_dilated = ndimage.binary_dilation(thick_px, iterations=THICK_HALO_STRIP_PX)
    return thin_px & ~thick_dilated


_NEIGHBOR_KERNEL = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]])


def neighbor_count(skel: np.ndarray) -> np.ndarray:
    return ndimage.convolve(skel.astype(np.uint8), _NEIGHBOR_KERNEL, mode="constant") * skel


def skeleton_fragments(thin_px: np.ndarray, min_len: int) -> tuple[np.ndarray, int, np.ndarray]:
    """Skeletonizes thin_px, cuts it at branch points, and labels the
    resulting simple-path fragments. Returns (frag_labels, n_frags,
    kept_mask) where kept_mask flags which fragment ids are >= min_len
    (frag_labels uses the same ids for both kept and dropped -- caller
    filters by kept_mask[id])."""
    skel = skeletonize(thin_px)
    branch_pts = neighbor_count(skel) >= 3
    cut_skel = skel & ~branch_pts
    frag_labels, n_frags = ndimage.label(cut_skel, structure=np.ones((3, 3), dtype=int))
    sizes = ndimage.sum(np.ones_like(frag_labels), frag_labels, index=np.arange(1, n_frags + 1))
    kept = sizes >= min_len  # index 0 == fragment id 1
    return frag_labels, n_frags, kept


# ── Fragment -> ordered polyline tracing ──


def _neighbors8(p: tuple[int, int]):
    r, c = p
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr or dc:
                yield (r + dr, c + dc)


def trace_pixel_path(coords: set[tuple[int, int]]) -> list[tuple[int, int]]:
    """Orders a simple-path (or simple-loop) pixel set into a walked
    sequence. coords must have max degree 2 within itself (guaranteed by
    skeleton_fragments's branch-point cut) -- a plain greedy walk is
    then unambiguous except for which of the (up to 2) directions to
    start in, which doesn't matter for an open path and only affects
    where a closed loop's seam falls."""
    degree = {p: sum(1 for n in _neighbors8(p) if n in coords) for p in coords}
    endpoints = [p for p, d in degree.items() if d <= 1]
    start = endpoints[0] if endpoints else next(iter(coords))
    path = [start]
    visited = {start}
    current = start
    while True:
        nxt = next((n for n in _neighbors8(current) if n in coords and n not in visited), None)
        if nxt is None:
            break
        path.append(nxt)
        visited.add(nxt)
        current = nxt
    return path


# ── Label (elevation digit) detection + OCR ──


@dataclass
class Fragment:
    frag_id: int
    path: list[tuple[int, int]]  # ordered (row, col), local to nothing -- already global
    elevation_m: float | None = None
    elevation_source: str = "unlabeled"
    merged_from: list[int] = field(default_factory=list)


def label_candidates(ink_mask: np.ndarray, thick_px_dilated: np.ndarray) -> list[dict]:
    """Small, compact, isolated components of the ORIGINAL ink mask --
    candidate elevation-label text. Text sits in a genuine gap in its
    contour line (not touching it), so it's naturally its own component
    here, distinct from the thin/thick stroke split used for contour
    tracing. Filters out anything touching a thick (structure) region,
    since those are much more likely wall ornamentation than a
    free-floating elevation label."""
    labels, n = ndimage.label(ink_mask, structure=np.ones((3, 3), dtype=int))
    objs = ndimage.find_objects(labels)
    out = []
    for i in range(1, n + 1):
        sl = objs[i - 1]
        if sl is None:
            continue
        h = sl[0].stop - sl[0].start
        w = sl[1].stop - sl[1].start
        if not (6 <= h <= 40 and 5 <= w <= 90):
            continue
        area = int((labels[sl] == i).sum())
        if not (15 <= area <= 900):
            continue
        comp = labels[sl] == i
        if thick_px_dilated[sl][comp].any():
            continue  # touches a structure wall -- unlikely to be an elevation label
        cy = (sl[0].start + sl[0].stop) / 2
        cx = (sl[1].start + sl[1].stop) / 2
        out.append({"bbox": sl, "centroid": (cy, cx), "diag": (h**2 + w**2) ** 0.5})
    return out


def _crop_label_image(rgba: np.ndarray, bbox, pad: int = 6, upscale: int = 4) -> Image.Image:
    """The exact image handed to OCR -- also reused (base64-encoded) as
    the visual evidence shown in the contour-label-review widget for a
    "review" reading, so a human sees literally the same crop the OCR
    engine saw."""
    y0 = max(bbox[0].start - pad, 0)
    y1 = min(bbox[0].stop + pad, rgba.shape[0])
    x0 = max(bbox[1].start - pad, 0)
    x1 = min(bbox[1].stop + pad, rgba.shape[1])
    crop = Image.fromarray(rgba[y0:y1, x0:x1]).convert("RGBA")
    bg = Image.new("RGBA", crop.size, (255, 255, 255, 255))
    bg.alpha_composite(crop)
    return bg.convert("RGB").resize((bg.width * upscale, bg.height * upscale), Image.LANCZOS)


def _image_to_base64_png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


@dataclass
class OcrReadout:
    status: str  # "accept" | "review" -- see try_ocr_elevation's docstring
    value: float
    raw_text: str
    confidence: float
    image_base64: str  # only populated for "review" -- no need to carry image bytes for the common "accept" case


def try_ocr_elevation(rgba: np.ndarray, bbox) -> OcrReadout | None:
    """Runs OCR on the label candidate's own cropped image (see
    _crop_label_image) and classifies the result:

    - "accept": a digit reading in the plausible range AND a multiple of
      CONTOUR_INTERVAL_M. Every confirmed-real label across both plans
      satisfies this, regardless of OCR confidence or whether the
      surrounding text is "clean" -- real labels often read messy (e.g.
      "-45-", "55-") because the source draws small leader ticks
      flanking the digits, so confidence and text-cleanliness both
      turned out to be unreliable accept/reject signals on their own
      (calibrated against every OCR hit across both plans -- see the
      chat history around "please incorporate these findings into the
      design"). Multiple-of-5 alone cleanly separates every real hit
      from every garbage one in that calibration.
    - "review": a digit reading in the plausible range but NOT a
      multiple of CONTOUR_INTERVAL_M -- suspicious. This is exactly how
      a real bug was first caught: OCR misread a small contour
      loop/switchback as "09" (-> 9m) at confidence 0.5, sitting right
      next to genuine 45/50/55 reads *also* at confidence 0.5-1.0 --
      confidence alone could never have told them apart, but
      multiple-of-5 does. Queued for a human via the
      contour-label-review widget instead of being silently accepted OR
      silently discarded.
    - None: no digit-bearing text found, or the value is wildly out of
      plausible range -- not even worth asking about. The overwhelming
      majority of label candidates are this case (non-label symbols:
      tick marks, scree-pattern dots, ...), so keeping this bucket
      non-reviewable is what keeps the review queue small.
    """
    from ocrmac import ocrmac

    img = _crop_label_image(rgba, bbox)
    tmp_path = "/tmp/_elev_ocr_crop.png"
    img.save(tmp_path)
    try:
        results = ocrmac.OCR(tmp_path).recognize()
    except Exception:
        return None
    for text, confidence, _box in results:
        digits = "".join(ch for ch in text if ch.isdigit())
        if not digits:
            continue
        try:
            value = float(digits)
        except ValueError:
            continue
        if not (0 < value < 300):  # plausible elevation range for this site (meters)
            continue
        status = "accept" if value % CONTOUR_INTERVAL_M == 0 else "review"
        image_b64 = _image_to_base64_png(img) if status == "review" else ""
        return OcrReadout(status=status, value=value, raw_text=text, confidence=confidence, image_base64=image_b64)
    return None


@dataclass
class ReviewItem:
    ocr_text: str
    ocr_confidence: float
    parsed_value: float
    reason: str
    # Populated in two phases: initially the two fragments' positions in
    # merge_labeled_fragments's own working `fragments` list (valid only
    # during that function), then overwritten at the end of that
    # function with their real positions in the FINAL output array --
    # i.e. the same "array index is the id" convention
    # fragments_to_geojson / the TopoCompare widget's corrections system
    # already uses. Never touch these before that translation has run.
    fragment_a_id: int
    fragment_b_id: int
    image_base64: str


# ── Review decisions (human answers, fed back into extraction) ──
# A human's answer to a ReviewItem, via the contour-label-review widget
# and scripts/apply_label_review.py, is persisted per plan at
# Data/mapFeatures/SamoWeb_<Plan>_Contours.review_decisions.json --
# DELIBERATELY keyed by the label candidate's own geographic position
# (lon/lat), not by fragment id: fragment ids are array positions that
# shift across re-runs (see the "Known limitations" note on this very
# topic), but the candidate's position in the source raster obviously
# doesn't. apply_label_review.py is the only thing that WRITES this
# file (translating .desk_temp/contour-label-review-log.json's
# fragment-id-keyed answers into position-keyed ones using the geojson
# that was current when the answer was given); extraction only ever
# READS it.
REVIEW_DECISION_MATCH_RADIUS_M = 10.0


def review_decisions_path(plan: str) -> Path:
    plan_label = "ActualStatePlan" if plan == "actual" else "RestoredStatePlan"
    return FEATURES_DIR / f"SamoWeb_{plan_label}_Contours.review_decisions.json"


def load_review_decisions(plan: str) -> list[dict]:
    path = review_decisions_path(plan)
    if not path.is_file():
        return []
    return json.loads(path.read_text()).get("decisions", [])


def _approx_meters(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    # Equirectangular approximation -- fine at this site's scale (tens of
    # meters) and latitude; not meant for anything farther-reaching.
    return math.hypot((lon2 - lon1) * 85000, (lat2 - lat1) * 111000)


def find_review_decision(decisions: list[dict], lon: float, lat: float) -> dict | None:
    best, best_d = None, REVIEW_DECISION_MATCH_RADIUS_M
    for d in decisions:
        dist = _approx_meters(lon, lat, d["lon"], d["lat"])
        if dist <= best_d:
            best, best_d = d, dist
    return best


def _apply_merge(
    fragments: list[Fragment],
    endpoint_index: list[tuple[tuple[int, int], int, bool]],
    consumed: set[int],
    a: tuple[tuple[int, int], int, bool],
    b: tuple[tuple[int, int], int, bool],
    elevation_m: float | None,
    elevation_source: str,
) -> None:
    """Shared by both the (script-decided) OCR auto-accept path and the
    (human-decided) review-decision accept/custom path -- the actual
    splice-two-fragments-into-one mechanics don't care which one asked
    for it, only what elevation/source to tag the result with."""
    frag_a, frag_b = fragments[a[1]], fragments[b[1]]
    path_a = frag_a.path if not a[2] else frag_a.path[::-1]
    path_b = frag_b.path if b[2] else frag_b.path[::-1]
    merged = Fragment(
        frag_id=frag_a.frag_id,
        path=path_a + path_b,
        elevation_m=elevation_m,
        elevation_source=elevation_source,
        merged_from=[frag_a.frag_id, frag_b.frag_id],
    )
    # See the long comment in the (former) inline version of this code --
    # preserved below at its call site -- for why both originals are
    # consumed and the merge is appended fresh rather than overwriting
    # fragments[a[1]] in place.
    consumed.add(a[1])
    consumed.add(b[1])
    new_idx = len(fragments)
    fragments.append(merged)
    endpoint_index.append((merged.path[0], new_idx, True))
    endpoint_index.append((merged.path[-1], new_idx, False))


def merge_labeled_fragments(
    fragments: list[Fragment],
    ink_mask: np.ndarray,
    thick_px_dilated: np.ndarray,
    mosaic: Mosaic,
    review_decisions: list[dict],
) -> tuple[list[Fragment], int, list[ReviewItem]]:
    """For each label-candidate blob, find the two nearest fragment
    endpoints roughly straddling it and run OCR (see try_ocr_elevation
    for the accept/review/ignore classification). An "accept" merges the
    two fragments and tags the result with the read elevation, same as
    before. A "review" leaves both fragments alone (separate,
    unlabeled) and records a ReviewItem instead -- a human decides via
    the contour-label-review widget; nothing here guesses on their
    behalf."""
    endpoint_index: list[tuple[tuple[int, int], int, bool]] = []  # (coord, frag list-index, is_start)
    for idx, frag in enumerate(fragments):
        endpoint_index.append((frag.path[0], idx, True))
        endpoint_index.append((frag.path[-1], idx, False))

    merged_count = 0
    consumed: set[int] = set()
    review_items: list[ReviewItem] = []
    for cand in label_candidates(ink_mask, thick_px_dilated):
        cy, cx = cand["centroid"]
        radius = max(cand["diag"] * 2.5, 40)
        nearby = [
            (coord, idx, is_start)
            for coord, idx, is_start in endpoint_index
            if idx not in consumed and math.dist(coord, (cy, cx)) <= radius
        ]
        if len(nearby) < 2:
            continue
        # pick the two closest endpoints that belong to DIFFERENT fragments
        nearby.sort(key=lambda t: math.dist(t[0], (cy, cx)))
        a = nearby[0]
        b = next((t for t in nearby[1:] if t[1] != a[1]), None)
        if b is None:
            continue
        # The actual gap a label interrupts is small (a couple of
        # characters' width, ~10-30px at this resolution) -- a search
        # radius wide enough to catch labels near sparse contours can
        # otherwise pick up a *second*, unrelated fragment that just
        # happens to be the next-closest thing to the label, producing
        # a long bogus straight-line "bridge" between two lines that
        # were never actually the same contour. Capping the endpoint
        # -to-endpoint gap itself (not just each endpoint's distance to
        # the label) catches that case even when both endpoints pass
        # the centroid-radius check individually.
        if math.dist(a[0], b[0]) > MAX_LABEL_GAP_PX:
            continue

        # A human may have already judged THIS specific candidate (by
        # position) via a previous run's review queue -- check before
        # spending an OCR call on it. "reject" means permanently treat
        # as if OCR found nothing here; "accept"/"custom" means apply
        # the human-confirmed value directly, bypassing the
        # multiple-of-5 auto-accept gate entirely (a human already
        # looked at the image, which is a stronger signal than any
        # heuristic here).
        cand_lon, cand_lat = pixel_to_lonlat(mosaic, cx, cy)
        decision = find_review_decision(review_decisions, cand_lon, cand_lat)
        if decision is not None:
            if decision["decision"] == "reject":
                continue
            _apply_merge(fragments, endpoint_index, consumed, a, b, decision["value"], "review-confirmed")
            merged_count += 1
            continue

        readout = try_ocr_elevation(mosaic.rgba, cand["bbox"])
        if readout is None:
            continue
        if readout.status == "review":
            review_items.append(
                ReviewItem(
                    ocr_text=readout.raw_text,
                    ocr_confidence=readout.confidence,
                    parsed_value=readout.value,
                    reason=(
                        f"OCR read {readout.value:g}, which is not a multiple of the "
                        f"established {CONTOUR_INTERVAL_M}m contour interval"
                    ),
                    fragment_a_id=a[1],
                    fragment_b_id=b[1],
                    image_base64=readout.image_base64,
                )
            )
            continue  # leave both fragments separate and unlabeled -- see docstring
        # Consuming BOTH originals (rather than overwriting fragments[a[1]]
        # in place) and appending the merge as a fresh entry, inside
        # _apply_merge, is deliberate: overwriting in place left
        # endpoint_index's two stale entries for a[1] pointing at
        # coordinates that were no longer real endpoints of the (now
        # longer) fragment at that index -- a later candidate could
        # still match against that stale "near" coordinate (it's still
        # in endpoint_index, un-consumed) and splice using an is_start
        # flag computed for the ORIGINAL short fragment's orientation,
        # which silently produces the wrong splice point against the
        # current merged path and a long bogus straight jump in the
        # output geometry. Treating every merge as
        # consume-two-make-one-new avoids the staleness entirely.
        _apply_merge(fragments, endpoint_index, consumed, a, b, readout.value, "ocr")
        merged_count += 1

    # Phase 2 of ReviewItem.fragment_{a,b}_id: translate from "index into
    # this function's own `fragments` list" to "index into the final
    # output array" (i.e. position within kept_fragments). Both of a
    # review item's fragments are guaranteed present in kept_fragments
    # (never consumed -- a review item is never merged).
    output_index: dict[int, int] = {}
    out_idx = 0
    for idx in range(len(fragments)):
        if idx not in consumed:
            output_index[idx] = out_idx
            out_idx += 1
    for item in review_items:
        item.fragment_a_id = output_index[item.fragment_a_id]
        item.fragment_b_id = output_index[item.fragment_b_id]

    kept_fragments = [f for idx, f in enumerate(fragments) if idx not in consumed]
    return kept_fragments, merged_count, review_items


# ── GeoJSON writing ──

# Tracing walks every single skeleton pixel, so raw output has a vertex
# roughly every 0.1m (one per pixel at this zoom) -- far denser than the
# line actually needs for its visual/geometric fidelity, and it bloats
# the file substantially (a few thousand single-pixel-long contour arcs
# turn into a multi-MB GeoJSON). Simplifying with a tolerance well under
# a pixel's own real-world size removes collinear-ish points without
# perceptibly changing the curve.
SIMPLIFY_TOLERANCE_DEG = 0.4 / 85000  # ~0.4m, in degrees-of-longitude at this latitude


def fragments_to_geojson(mosaic: Mosaic, fragments: list[Fragment], plan: str, layer: str) -> dict:
    from shapely.geometry import LineString

    features = []
    for frag in fragments:
        coords = [list(pixel_to_lonlat(mosaic, px, py)) for py, px in frag.path]
        if len(coords) < 2:
            continue
        if len(coords) > 2:
            simplified = LineString(coords).simplify(SIMPLIFY_TOLERANCE_DEG, preserve_topology=False)
            coords = [list(c) for c in simplified.coords]
            if len(coords) < 2:
                continue
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {
                    "layer": layer,
                    "plan": plan,
                    "elevation_m": frag.elevation_m,
                    "elevation_source": frag.elevation_source,
                    "pixel_zoom": ZOOM,
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


# ── Pipeline stage snapshots (for the Pipeline Stage Viewer widget) ──
# Purely a debugging/visualization artifact, not canonical GIS output --
# lives under .desk_temp (ephemeral, regenerated every run), never
# Data/mapFeatures. Each stage gets one white-background PNG; a fragment
# -list stage also draws anything that stage just REMOVED in red, so the
# viewer can show what each step actually changed, not just its output.

STAGE_DIR = PROJECT_DIR / ".desk_temp" / "pipeline-stages"

# (stage_num, stage_name, human label) -- the Pipeline Stage Viewer widget
# reads this same list (duplicated in its own TS source -- see that
# widget's own comment) to build its stage picker in the right order.
PIPELINE_STAGES = [
    (0, "raw-ink", "Raw ink mask (ink/blue split)"),
    (1, "after-structure-exclusion", "After structure (building) exclusion"),
    (2, "candidate-fragments", "Candidate fragments (thin/thick split + length filter)"),
    (3, "after-chain-exclusion", "After decorative circle-chain exclusion"),
    (4, "labeled-contours", "After label-gap merge (index contours get elevation)"),
    (5, "with-minor-bands", "After minor-contour banding (1m interpolation)"),
]


def save_stage_mask(plan: str, stage_num: int, stage_name: str, mask: np.ndarray) -> None:
    out_dir = STAGE_DIR / plan
    out_dir.mkdir(parents=True, exist_ok=True)
    img = np.full((*mask.shape, 3), 255, dtype=np.uint8)
    img[mask] = [20, 20, 20]
    Image.fromarray(img).save(out_dir / f"{stage_num:02d}_{stage_name}.png")


def save_stage_fragments(
    plan: str,
    stage_num: int,
    stage_name: str,
    shape: tuple[int, int],
    fragments: list[Fragment],
    excluded: list[Fragment] | None = None,
) -> None:
    from PIL import ImageDraw

    out_dir = STAGE_DIR / plan
    out_dir.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (shape[1], shape[0]), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    for frag in fragments:
        color = (180, 20, 170) if frag.elevation_m is not None else (30, 30, 30)
        if len(frag.path) >= 2:
            draw.line([(c, r) for r, c in frag.path], fill=color, width=1)
    if excluded:
        for frag in excluded:
            if len(frag.path) >= 2:
                draw.line([(c, r) for r, c in frag.path], fill=(220, 30, 30), width=2)
    img.save(out_dir / f"{stage_num:02d}_{stage_name}.png")


# ── Minor (1m) contour interpolation ──
# Between two adjacent (5m-apart) labeled index contours there should be
# CONTOUR_INTERVAL_M - 1 = 4 unlabeled 1m contours (confirmed by direct
# visual inspection -- topo-compare-log.json entry #4 / the chat that
# investigated it). This stage groups unlabeled fragments by which pair
# of adjacent index contours they fall between (nearest-neighbor against
# a KD-tree of every labeled fragment's own points, which is fast enough
# to query per-fragment without ever walking a labeled fragment's full
# path by hand), estimates each one's position between that pair by
# inverse-distance fraction, and only commits an actual elevation when a
# group looks CLEANLY like 4 well-separated fragments -- anything else
# (wrong count, fragments too close together to order confidently) is
# left unlabeled and queued in *.minor_review_queue.json instead of
# guessed at. This is a real heuristic over genuinely ambiguous terrain
# (saddles, ridges, multiple same-elevation contours in different
# hollows can all confuse the nearest-two-neighbors assumption) -- expect
# a real share of groups to need human review, by design, not as a bug.


@dataclass
class MinorBandGroup:
    group_id: str
    elev_low: float
    elev_high: float
    fragment_order: list[int]  # indices into `fragments`, best-guess low-to-high
    confident: bool


MINOR_BAND_MAX_SEARCH_PX = 320.0
# How far apart (in the 0..1 position-within-band sense, roughly px/40
# at typical index-contour spacing here) two fragments need to be to
# trust their relative order -- too close together usually means the
# nearest-neighbor position estimate is noisy, not that they're
# genuinely almost co-located.
MINOR_BAND_MIN_SEPARATION = 0.3


def band_minor_contours(fragments: list[Fragment]) -> list[MinorBandGroup]:
    labeled_idx = [i for i, f in enumerate(fragments) if f.elevation_m is not None]
    unlabeled_idx = [i for i, f in enumerate(fragments) if f.elevation_m is None]
    if not labeled_idx or not unlabeled_idx:
        return []

    # One KD-tree PER DISTINCT labeled elevation value, not one combined
    # tree over every labeled point: with a single tree, a top-k query
    # can come back entirely from the single nearest fragment's own many
    # path-points and never surface a SECOND elevation value at all --
    # especially now that the search radius has to be wide enough to
    # span this terrain's actual index-contour spacing (confirmed by
    # direct measurement across real labeled pairs here: adjacent-index
    # midpoint distances range from ~85px to ~400px, nowhere near
    # uniform). Querying each elevation's own tree for its single
    # nearest point is both more robust and cheap (at most ~8 distinct
    # elevations per plan).
    trees_by_elev: dict[float, cKDTree] = {}
    for elev in {fragments[i].elevation_m for i in labeled_idx}:
        pts = [p for i in labeled_idx if fragments[i].elevation_m == elev for p in fragments[i].path]
        trees_by_elev[elev] = cKDTree(np.array(pts))

    # (idx, value, x, y) per elevation-pair -- value is the position
    # estimate used for ordering, (x, y) is kept alongside purely for the
    # spatial sub-clustering step below.
    groups: dict[tuple[float, float], list[tuple[int, float, float, float]]] = {}
    for idx in unlabeled_idx:
        frag = fragments[idx]
        p = frag.path[len(frag.path) // 2]
        per_elev: list[tuple[float, float]] = []  # (distance, elevation)
        for elev, tree in trees_by_elev.items():
            d, _ = tree.query(p, k=1, distance_upper_bound=MINOR_BAND_MAX_SEARCH_PX)
            if np.isfinite(d):
                per_elev.append((float(d), elev))
        if len(per_elev) < 2:
            continue
        per_elev.sort(key=lambda t: t[0])
        (d1, e1), (d2, e2) = per_elev[0], per_elev[1]
        if abs(e2 - e1) != CONTOUR_INTERVAL_M:
            continue  # not two adjacent index contours -- don't guess across a bigger gap
        lo, hi = (e1, e2) if e1 < e2 else (e2, e1)
        # Position estimate: inverse-distance fraction toward e2 (NOT a
        # physically-rigorous interpolation -- terrain isn't linear
        # between two arbitrary nearby points -- but good enough to
        # ORDER fragments within a band, which is all auto-accept
        # actually depends on).
        value = e1 + (d1 / (d1 + d2)) * (e2 - e1)
        groups.setdefault((lo, hi), []).append((idx, value, p[1], p[0]))

    # A raw (lo, hi) group can span the WHOLE site -- the same
    # "40-45m" pairing can legitimately recur on several unrelated
    # hillsides, and without this step they'd all get dumped into one
    # enormous, meaningless "group" (confirmed: before this step, a
    # single pairing collected 383 fragments site-wide on this data).
    # Sub-clustering by proximity splits each pairing back into its
    # separate real-world occurrences, each a sensible size to review
    # (or auto-accept) on its own.
    BAND_SPATIAL_CLUSTER_RADIUS_PX = 55.0
    result: list[MinorBandGroup] = []
    for (lo, hi), raw_members in sorted(groups.items()):
        points = [(idx, x, y) for idx, _value, x, y in raw_members]
        value_by_idx = {idx: value for idx, value, _x, _y in raw_members}
        for ci, cluster_ids in enumerate(cluster_by_proximity(points, BAND_SPATIAL_CLUSTER_RADIUS_PX)):
            members = sorted(((idx, value_by_idx[idx]) for idx in cluster_ids), key=lambda t: t[1])
            confident = len(members) == CONTOUR_INTERVAL_M - 1 and all(
                (members[k + 1][1] - members[k][1]) > MINOR_BAND_MIN_SEPARATION for k in range(len(members) - 1)
            )
            for order, (idx, _pos) in enumerate(members, start=1):
                if confident:
                    fragments[idx].elevation_m = lo + order
                    fragments[idx].elevation_source = "interpolated"
            result.append(MinorBandGroup(f"band-{lo:g}-{hi:g}-{ci}", lo, hi, [m[0] for m in members], confident))
    return result


def write_minor_review_queue(plan: str, groups: list[MinorBandGroup], fragments: list[Fragment], mosaic: Mosaic) -> Path | None:
    plan_label = "ActualStatePlan" if plan == "actual" else "RestoredStatePlan"
    out_path = FEATURES_DIR / f"SamoWeb_{plan_label}_Contours.minor_review_queue.json"
    pending = [g for g in groups if not g.confident]
    if not pending:
        out_path.unlink(missing_ok=True)  # see write_review_queue's own comment on why this matters
        return None
    payload = {
        "plan": plan,
        "contourIntervalM": CONTOUR_INTERVAL_M,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "groups": [
            {
                "groupId": g.group_id,
                "elevLow": g.elev_low,
                "elevHigh": g.elev_high,
                "fragments": [
                    {
                        "fragmentId": idx,
                        "coordinates": [list(pixel_to_lonlat(mosaic, c, r)) for r, c in fragments[idx].path],
                    }
                    for idx in g.fragment_order
                ],
            }
            for g in pending
        ],
    }
    out_path.write_text(json.dumps(payload, indent=2))
    return out_path


# ── Per-plan extraction ──


def extract_contours(plan: str, mosaic: Mosaic) -> tuple[dict, list[ReviewItem]]:
    blue_mask, ink_mask_raw = color_masks(mosaic.rgba)
    save_stage_mask(plan, 0, "raw-ink", ink_mask_raw)

    structure_mask = build_structure_exclusion_mask(plan, mosaic)
    ink_mask = ink_mask_raw & ~structure_mask
    save_stage_mask(plan, 1, "after-structure-exclusion", ink_mask)
    n_structure_rings = len(load_structure_polygons(plan))
    print(
        f"  [{plan}] structure exclusion removed {int((ink_mask_raw & ~ink_mask).sum())} ink px "
        f"({STRUCTURE_BUFFER_PX}px buffer around {n_structure_rings} mapped footprint ring(s))"
    )

    thin_px = classify_ink(ink_mask)
    dist = ndimage.distance_transform_edt(ink_mask)
    thick_px_dilated = ndimage.binary_dilation(
        ink_mask & (dist > THIN_HALF_WIDTH_PX), iterations=THICK_HALO_STRIP_PX
    )

    frag_labels, n_frags, kept = skeleton_fragments(thin_px, MIN_FRAGMENT_LEN_PX)
    objs = ndimage.find_objects(frag_labels)
    fragments: list[Fragment] = []
    for i in range(1, n_frags + 1):
        if not kept[i - 1]:
            continue
        sl = objs[i - 1]
        if sl is None:
            continue
        comp = frag_labels[sl] == i
        local_coords = {(r + sl[0].start, c + sl[1].start) for r, c in zip(*np.nonzero(comp))}
        path = trace_pixel_path(local_coords)
        fragments.append(Fragment(frag_id=i, path=path))
    save_stage_fragments(plan, 2, "candidate-fragments", ink_mask.shape, fragments)
    print(f"  [{plan}] {len(fragments)} contour-candidate fragments after thin/thick split + length filter")

    chain_excluded = find_circular_chain_fragments(fragments)
    excluded_frags = [fragments[i] for i in sorted(chain_excluded)]
    fragments = [f for i, f in enumerate(fragments) if i not in chain_excluded]
    save_stage_fragments(plan, 3, "after-chain-exclusion", ink_mask.shape, fragments, excluded=excluded_frags)
    if chain_excluded:
        print(f"  [{plan}] excluded {len(chain_excluded)} fragment(s) as decorative circle-chain clusters")

    review_decisions = load_review_decisions(plan)
    if review_decisions:
        print(f"  [{plan}] loaded {len(review_decisions)} prior human review decision(s)")
    fragments, merged, review_items = merge_labeled_fragments(fragments, ink_mask, thick_px_dilated, mosaic, review_decisions)
    labeled = sum(1 for f in fragments if f.elevation_source in ("ocr", "review-confirmed"))
    print(f"  [{plan}] merged {merged} label gaps -> {labeled}/{len(fragments)} fragments have an elevation")
    save_stage_fragments(plan, 4, "labeled-contours", ink_mask.shape, fragments)
    if review_items:
        print(
            f"  [{plan}] {len(review_items)} OCR reading(s) need human review "
            f"(not a multiple of {CONTOUR_INTERVAL_M}m) -- not auto-applied, see the review queue file"
        )

    minor_groups = band_minor_contours(fragments)
    confident_groups = [g for g in minor_groups if g.confident]
    pending_groups = [g for g in minor_groups if not g.confident]
    newly_labeled = sum(len(g.fragment_order) for g in confident_groups)
    print(
        f"  [{plan}] minor-contour banding: {len(minor_groups)} band(s) found, "
        f"{len(confident_groups)} confident (+{newly_labeled} fragments now interpolated), "
        f"{len(pending_groups)} need review"
    )
    save_stage_fragments(plan, 5, "with-minor-bands", ink_mask.shape, fragments)
    minor_queue_path = write_minor_review_queue(plan, minor_groups, fragments, mosaic)
    if minor_queue_path:
        print(f"  [{plan}] wrote {minor_queue_path}")

    return fragments_to_geojson(mosaic, fragments, plan, "contours"), review_items


def extract_streams(plan: str, mosaic: Mosaic) -> dict | None:
    blue_mask, _ink_mask = color_masks(mosaic.rgba)
    if blue_mask.sum() < 50:
        return None
    # Bridge dash gaps, then skeletonize+trace the same way as contours
    # (minus the elevation-label step -- streams aren't labeled).
    bridged = ndimage.binary_dilation(blue_mask, iterations=4)
    bridged = ndimage.binary_erosion(bridged, iterations=3)  # shrink back near original width
    frag_labels, n_frags, kept = skeleton_fragments(bridged, min_len=8)
    objs = ndimage.find_objects(frag_labels)
    fragments: list[Fragment] = []
    for i in range(1, n_frags + 1):
        if not kept[i - 1]:
            continue
        sl = objs[i - 1]
        if sl is None:
            continue
        comp = frag_labels[sl] == i
        local_coords = {(r + sl[0].start, c + sl[1].start) for r, c in zip(*np.nonzero(comp))}
        path = trace_pixel_path(local_coords)
        fragments.append(Fragment(frag_id=i, path=path, elevation_source="n/a"))
    print(f"  [{plan}] {len(fragments)} stream-line fragments")
    return fragments_to_geojson(mosaic, fragments, plan, "streams")


# ── Review queue writing ──
# A SEPARATE file from both the extractor's own *.geojson output and the
# TopoCompare widget's *.corrections.json -- this one holds OCR readings
# the script itself wasn't confident enough to auto-apply (see
# try_ocr_elevation's "review" status). A human answers these via the
# contour-label-review widget, which writes its own
# .desk_temp/contour-label-review-log.json; turning an accepted answer
# into an actual correction is a deliberate separate step (translating a
# ReviewItem's fragment_a_id/fragment_b_id into a *.corrections.json
# merge entry), not something either of those two pieces does on its
# own -- keeps "what the extractor shipped," "what a human was asked,"
# and "what a human decided to change" each in their own artifact.


def write_review_queue(plan: str, review_items: list[ReviewItem]) -> Path | None:
    plan_label = "ActualStatePlan" if plan == "actual" else "RestoredStatePlan"
    out_path = FEATURES_DIR / f"SamoWeb_{plan_label}_Contours.review_queue.json"
    if not review_items:
        # Every run writes an authoritative queue -- including "there is
        # currently nothing to review" -- rather than leaving a PRIOR
        # run's file sitting there stale. Without this, a candidate a
        # human already resolved (via review_decisions.json, so it no
        # longer generates a ReviewItem at all) would leave its old
        # queue entry on disk forever, looking like a still-pending
        # question to anything reading this file later.
        out_path.unlink(missing_ok=True)
        return None
    payload = {
        "plan": plan,
        "layer": "contours",
        "contourIntervalM": CONTOUR_INTERVAL_M,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "items": [
            {
                "reviewId": f"{plan}-contours-{i}",
                "ocrText": item.ocr_text,
                "ocrConfidence": item.ocr_confidence,
                "parsedValue": item.parsed_value,
                "reason": item.reason,
                "fragmentAId": item.fragment_a_id,
                "fragmentBId": item.fragment_b_id,
                "imageBase64": item.image_base64,
            }
            for i, item in enumerate(review_items)
        ],
    }
    out_path.write_text(json.dumps(payload, indent=2))
    return out_path


def main() -> None:
    FEATURES_DIR.mkdir(parents=True, exist_ok=True)
    for plan in ("actual", "restored"):
        print(f"Loading {plan} mosaic (zoom {ZOOM})...")
        mosaic = load_plan_mosaic(plan)
        print(f"  mosaic size: {mosaic.rgba.shape[1]}x{mosaic.rgba.shape[0]}px")

        print(f"Extracting contours ({plan})...")
        contours_geojson, review_items = extract_contours(plan, mosaic)
        plan_label = "ActualStatePlan" if plan == "actual" else "RestoredStatePlan"
        out_path = FEATURES_DIR / f"SamoWeb_{plan_label}_Contours.geojson"
        out_path.write_text(json.dumps(contours_geojson, indent=2))
        print(f"  wrote {out_path} ({len(contours_geojson['features'])} features)")
        review_path = write_review_queue(plan, review_items)
        if review_path:
            print(f"  wrote {review_path} ({len(review_items)} item(s) need review)")

        print(f"Extracting streams ({plan})...")
        streams_geojson = extract_streams(plan, mosaic)
        if streams_geojson and streams_geojson["features"]:
            out_path = FEATURES_DIR / f"SamoWeb_{plan_label}_Streams.geojson"
            out_path.write_text(json.dumps(streams_geojson, indent=2))
            print(f"  wrote {out_path} ({len(streams_geojson['features'])} features)")
        else:
            print(f"  no stream lines detected in {plan} -- skipped")


if __name__ == "__main__":
    main()
