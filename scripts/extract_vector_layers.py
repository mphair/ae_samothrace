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

1. Stitch every zoom-20 tile for a plan into one RGBA mosaic (0.11 m/px
   at this site's latitude -- enough resolution to resolve individual
   contour strokes and OCR the small elevation labels, while staying to
   a single ~2560x2304px image per plan instead of zoom 22's ~9200x8960).
2. Classify ink by *local stroke width* (a per-pixel distance-transform
   threshold, not a per-component one -- see the long comment on
   classify_ink below for why): thin strokes are contour-line
   candidates, thick strokes are structure walls (discarded).
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
4. Elevation labels interrupt their contour line with a genuine gap (no
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
5. Reproject pixel coordinates to lon/lat with the same Web Mercator
   math every other widget/service in this project already uses.
6. Write one GeoJSON FeatureCollection per plan/layer to
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


def merge_labeled_fragments(
    fragments: list[Fragment],
    ink_mask: np.ndarray,
    thick_px_dilated: np.ndarray,
    rgba: np.ndarray,
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
        readout = try_ocr_elevation(rgba, cand["bbox"])
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
        frag_a, frag_b = fragments[a[1]], fragments[b[1]]
        path_a = frag_a.path if not a[2] else frag_a.path[::-1]
        path_b = frag_b.path if b[2] else frag_b.path[::-1]
        merged_path = path_a + path_b
        merged = Fragment(
            frag_id=frag_a.frag_id,
            path=merged_path,
            elevation_m=readout.value,
            elevation_source="ocr",
            merged_from=[frag_a.frag_id, frag_b.frag_id],
        )
        # Consume BOTH originals (rather than overwriting fragments[a[1]]
        # in place) and append the merged result as a fresh entry with
        # its own endpoints registered in endpoint_index. Overwriting in
        # place left endpoint_index's two stale entries for a[1]
        # pointing at coordinates that were no longer real endpoints of
        # the (now longer) fragment at that index -- a later candidate
        # could still match against that stale "near" coordinate (it's
        # still in endpoint_index, un-consumed) and splice using an
        # is_start flag computed for the ORIGINAL short fragment's
        # orientation, which silently produces the wrong splice point
        # against the current merged path and a long bogus straight
        # jump in the output geometry. Treating every merge as
        # consume-two-make-one-new avoids the staleness entirely.
        consumed.add(a[1])
        consumed.add(b[1])
        new_idx = len(fragments)
        fragments.append(merged)
        endpoint_index.append((merged.path[0], new_idx, True))
        endpoint_index.append((merged.path[-1], new_idx, False))
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


# ── Per-plan extraction ──


def extract_contours(plan: str, mosaic: Mosaic) -> tuple[dict, list[ReviewItem]]:
    blue_mask, ink_mask = color_masks(mosaic.rgba)
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

    print(f"  [{plan}] {len(fragments)} contour fragments before label merge")
    fragments, merged, review_items = merge_labeled_fragments(fragments, ink_mask, thick_px_dilated, mosaic.rgba)
    labeled = sum(1 for f in fragments if f.elevation_source == "ocr")
    print(f"  [{plan}] merged {merged} label gaps -> {labeled}/{len(fragments)} fragments have an elevation")
    if review_items:
        print(
            f"  [{plan}] {len(review_items)} OCR reading(s) need human review "
            f"(not a multiple of {CONTOUR_INTERVAL_M}m) -- not auto-applied, see the review queue file"
        )

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
    if not review_items:
        return None
    plan_label = "ActualStatePlan" if plan == "actual" else "RestoredStatePlan"
    out_path = FEATURES_DIR / f"SamoWeb_{plan_label}_Contours.review_queue.json"
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
