"""Builds the "Regio I" layer: a translucent purple tint over the
southwest portion of the Restored plan, marking the sanctuary's first
Regio (a sanctuary-zone designation printed on the original survey --
the Initial Map photo carries a "regio" arrow+label pointing at the
waterway, noticed during an earlier, unrelated fix -- see
`desk-installed-jobs/map-import-from-photo/main.py`'s own `extract_keys`
and this project's TODO.md for that earlier mention). Requested directly
(rec-1792394660953-1831, 2026-10-19): "let's add some more layers. This
next layer is the regio... there's a few regios on here that we're
concerned with. For now, let's just talk about the first level main
regio." More Regios are expected to follow as separate layers in the
same new "Regios" panel group this one is the first member of.

## How the boundary was built

The user drew ONE long, hand-traced purple polyline tracing the Restored
mosaic's own top, left, and bottom edges (and partway up the right edge)
-- NOT a closed loop on its own: "this purple line here, is the... the
boundary of the first regio... the other boundaries... going up to the
waterway there." The remaining edge (northeast) is the Restored
Waterway's own course, confirmed separately with a few GREEN marks
pointing at different stretches of it ("everything southwest of this
border, the waterway, is regio one"). A handful of short PURPLE "hash
mark" strokes across the interior were drawn last, purely as a visual
confirmation of which side is "in" -- not used programmatically here,
same role YELLOW boundary-dot marks played in an earlier Waterway
annotation pass (confirmation only, not an instruction).

This closure (hand-drawn line + the real waterway's own shape, not a
straight line or a simplifying assumption) is exactly the kind of
"bounded region, give me everything connected to one interior point"
problem `seeded_flood_fill` (see `scripts/style_restored_waterway.py`'s
own header, and the canonical implementation in
`desk-installed-jobs/painting-technique/main.py`) already solves --
reused here verbatim rather than reinvented: the barrier is the
hand-drawn purple line, rasterized with some real stroke width, UNIONED
with the Restored Waterway's own already-generated output PNG (so the
flood can't cross the river either) -- then flood-filled from one
interior seed point (picked from the middle of one of the user's own
hash-mark strokes, verified to land on neither piece of the barrier).

## Closing the gaps -- three real leaks, found and fixed in order

"Line + water" sounds sealed but wasn't, three separate times, each
confirmed by actually running it and looking at the result rather than
trusting the logic on paper:

1. **The polyline's own two ends don't touch the water.** Confirmed
   directly: ~32px and ~22px short. Unclosed, the flood escaped around
   both ends into the entire unbounded canvas (97% filled on the first
   run). Fixed by `snap_endpoints_to_water`: find each endpoint's exact
   nearest water pixel (`ndimage.distance_transform_edt`'s own
   `return_indices`) and prepend/append a connector segment to it.

2. **The Waterway isn't one connected shape.** It's whatever a handful
   of independently-seeded flood fills produced (see
   `style_restored_waterway.py`) -- 4 separate components here, split by
   both genuine hard breaks (a confirmed non-bridge structure) and
   simple un-seeded stretches between two seeds. A first attempt plugged
   this with the FULL ink mask instead (every structure wall) -- sealed,
   but fragmented the interior into disconnected pockets the single seed
   couldn't reach (confirmed: several whole building clusters the user's
   own hash marks crossed came out unfilled). Replaced with
   `bridge_water_components`: bridge only the water-to-water gaps
   smaller than `WATER_BRIDGE_DISTANCE_PX`, leaving everything else
   (buildings, contours, paths) untouched as a barrier.

3. **Nearest-pixel snapping doesn't always pick the RIGHT piece of
   water.** Confirmed directly: the polyline's own start point snapped
   to the upper-east branch (32px away) instead of the main north-south
   channel (159px away) -- slightly closer, but not what the user was
   actually standing next to. The main channel was never connected to
   anything, and the flood slipped around behind it, filling the entire
   northeast half of the map instead of just the southwest. Fixed by
   `bridge_components_to_polyline`: check every water component against
   the WHOLE smoothed polyline (not just its two endpoints), and bridge
   any that come close enough anywhere along its length.

Final visual check (not just a plausible-looking pixel count) confirmed
the result: a clean southwest tint stopping exactly at the main channel,
with structures 20/22/23/24/25/26/30 and the northeast terrain correctly
left out.

## Corrected 2026-10-19: the main channel is interior, not a boundary

That "clean stop at the main channel" was itself wrong -- directly
corrected the same day, a recording later (rec-1792398286794-268c): "the
regio also includes the area between the two rivers, the two waterways
[the main channel and the branch past structures 20/22/23/24/25/26]...
[the branch] is the actual eastern border of the regio." The user drew
BLUE at approximately where the two branches connect (confirming they
read as one continuous "northeastern waterway"), and YELLOW directly on
that branch in two places to mark it, specifically, as the real eastern
edge -- not the main channel, which is now understood to run THROUGH the
regio's own interior.

Mechanically: `bridge_water_components`/`bridge_components_to_polyline`
had been treating every water component as potential boundary material,
including the main channel -- which is exactly how fix #3 above got the
main channel bridged into the sealed outer loop in the first place.
Fixed by excluding the main channel's own component from both bridging
functions (`MAIN_CHANNEL_REFERENCE_PX`, a point looked up by LABEL at
runtime via `label_at` -- not a hardcoded component number, since
`ndimage.label`'s own numbering isn't guaranteed stable run to run). With
the main channel no longer sealed against anything, the flood fill
naturally wraps around both its ends into the between-rivers area,
stopping only once it actually reaches the branch (now the one real
sealed edge) -- exactly the "everything between the two rivers" the user
asked for, confirmed by a second visual check.

## Smoothing

"I would like it to smooth out that purple line so it's not so jagged"
-- the raw hand-drawn polyline is resampled to even arc-length spacing
then Gaussian-smoothed (`scipy.ndimage.gaussian_filter1d` on the x and y
coordinate sequences independently) before rasterizing it as the
barrier. Endpoints are NOT pinned/preserved specially -- smoothing both
ends in is fine here since neither endpoint needs to land on an exact
pixel (the flood fill only cares that the barrier is a continuous,
ungapped line, not where precisely it starts/stops).

## Output

`Data/mapFeatures/SamoWeb_RestoredStatePlan_Regio1.png` (RGBA,
transparent outside the region, translucent purple inside --
`REGIO_ALPHA` is "three-quarters transparent," i.e. about a quarter
opaque, so the base map stays legible underneath) + `.bounds.json` (a
plain copy of the Restored stage's own bounds.json, same mosaic pixel
grid the Waterway layer already uses).

Run directly: `python3 scripts/style_restored_regio.py` (reads from
this project's own Data/ and .desk_temp/, writes to Data/mapFeatures/;
no arguments). Must be run AFTER `style_restored_waterway.py` -- it
reads that script's own output PNG directly rather than recomputing the
water mask itself.
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

PROJECT_DIR = Path(__file__).resolve().parent.parent
STAGE_DIR = PROJECT_DIR / ".desk_temp" / "pipeline-stages" / "restored"
WATERWAY_PNG = PROJECT_DIR / "Data" / "mapFeatures" / "SamoWeb_RestoredStatePlan_WaterwayView.png"
OUT_DIR = PROJECT_DIR / "Data" / "mapFeatures"
OUT_PNG = OUT_DIR / "SamoWeb_RestoredStatePlan_Regio1.png"
OUT_BOUNDS = OUT_DIR / "SamoWeb_RestoredStatePlan_Regio1.bounds.json"

# Same purple the user drew with (annotation palette's own "Purple"
# swatch, #911eb4) -- "I'd like a purple... shape there."
REGIO_PURPLE = (145, 30, 180)
# "A purple, three-quarters transparent shape" -- 255 * 0.25, rounded.
REGIO_ALPHA = 64

# The user's own hand-drawn boundary polyline (rec-1792394660953-1831,
# 2026-10-19), converted from the recording's screen-px/view-lon-lat log
# into this mosaic's own pixel space (same calibration approach every
# annotation pass in this project uses) -- traces the mosaic's own top,
# left, and bottom edges, partway up the right edge. See this module's
# own header for how the remaining (northeast) edge is closed.
BOUNDARY_POLYLINE_PX: list[tuple[float, float]] = [
    (1070.8, 77.8), (1067.0, 66.3), (1044.2, 43.5), (1009.9, 24.5), (949.0, 24.5), (880.5, 13.1), (804.4, -2.2), (678.8, -6.0), (549.3, -2.2), (461.8, 9.2), (389.5, 24.5), (305.7, 85.4), (290.5, 203.4), (271.5, 382.3), (256.2, 504.1), (256.2, 644.9), (252.4, 740.1), (252.4, 861.9), (260.1, 976.1), (267.7, 1006.5), (263.9, 1010.3), (267.7, 1139.7), (267.7, 1341.5), (263.9, 1493.7), (260.1, 1482.3), (252.4, 1497.5), (256.2, 1649.8), (256.2, 1821.1), (248.6, 1889.6), (241.0, 1904.8), (241.0, 2000.0), (244.8, 2102.7), (271.5, 2159.8), (317.2, 2186.5), (362.8, 2190.3), (408.5, 2194.1), (492.2, 2197.9), (568.4, 2197.9), (678.8, 2205.5), (827.2, 2213.1), (933.8, 2209.3), (1059.4, 2220.7), (1108.9, 2213.1), (1196.4, 2201.7), (1249.7, 2209.3), (1261.1, 2213.1), (1360.1, 2220.7), (1478.1, 2232.2), (1527.6, 2228.4), (1577.1, 2232.2), (1756.0, 2228.4), (1896.8, 2243.6), (1942.5, 2239.8), (1953.9, 2236.0), (1992.0, 2228.4), (2049.1, 2216.9), (2140.4, 2224.6), (2197.5, 2239.8), (2269.8, 2247.4), (2361.2, 2255.0), (2441.1, 2243.6), (2483.0, 2201.7), (2452.5, 2098.9), (2429.7, 2060.9), (2429.7, 2045.7), (2441.1, 1969.5), (2452.5, 1870.6), (2448.7, 1836.3), (2429.7, 1752.6), (2418.3, 1706.9), (2414.5, 1684.0), (2410.7, 1672.6), (2406.9, 1649.8),
]

# One interior point (picked from the middle of one of the user's own
# purple "hash mark" strokes, same pass -- verified to land on neither
# the boundary ink nor the waterway) -- the only thing `seeded_flood_fill`
# needs to know which side of the boundary is "in."
INTERIOR_SEED_PX = (762, 804)

# A point known to sit on the main north-south channel (one of
# `style_restored_waterway.py`'s own `SEED_POINTS_PX`) -- used to find
# that channel's own water component at runtime, by label, rather than
# hardcoding a component NUMBER (`ndimage.label`'s own numbering isn't
# guaranteed stable run to run). See "Corrected 2026-10-19" below for why
# this specific component needs identifying at all.
MAIN_CHANNEL_REFERENCE_PX = (887, 227)

# Rasterized stroke width (px, mosaic-pixel space) for the smoothed
# boundary polyline -- wide enough that the flood fill can't sneak
# through a diagonal-line antialiasing gap (PIL's own line rasterizer
# can leave single-pixel diagonal gaps at width 1).
BOUNDARY_STROKE_WIDTH_PX = 8

# Arc-length resampling step (px) before smoothing -- the raw hand-drawn
# points are unevenly spaced (denser where the user drew slowly/curved),
# which would bias a naive index-based smoothing filter toward
# over-smoothing dense stretches and under-smoothing sparse ones.
RESAMPLE_STEP_PX = 5.0
# Gaussian smoothing sigma, in resampled points -- "I would like it to
# smooth out that purple line so it's not so jagged." Tuned by looking
# at the result (see this module's own verification), not a universal
# constant.
SMOOTH_SIGMA = 4.0


def smooth_polyline(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Resamples to even arc-length spacing, then Gaussian-smooths the x
    and y coordinate sequences independently. See this module's own
    header, "Smoothing" section."""
    pts = np.array(points, dtype=float)
    deltas = np.diff(pts, axis=0)
    seg_lens = np.hypot(deltas[:, 0], deltas[:, 1])
    cum = np.concatenate([[0.0], np.cumsum(seg_lens)])
    total_len = cum[-1]
    if total_len <= 0:
        return points

    n_samples = max(2, int(total_len / RESAMPLE_STEP_PX))
    sample_at = np.linspace(0, total_len, n_samples)
    rx = np.interp(sample_at, cum, pts[:, 0])
    ry = np.interp(sample_at, cum, pts[:, 1])

    sx = ndimage.gaussian_filter1d(rx, sigma=SMOOTH_SIGMA, mode="nearest")
    sy = ndimage.gaussian_filter1d(ry, sigma=SMOOTH_SIGMA, mode="nearest")
    return list(zip(sx.tolist(), sy.tolist()))


def snap_endpoints_to_water(polyline: list[tuple[float, float]], is_water: np.ndarray) -> list[tuple[float, float]]:
    """The hand-drawn boundary polyline's own two ends don't land exactly
    ON the waterway (confirmed directly: ~32px and ~22px short) -- "the
    other boundaries... going up to the waterway there" was always meant
    loosely, not pixel-precise. Without closing these, the flood leaks
    out around both ends into the entire rest of the (unbounded)
    whitespace -- confirmed directly on the first run, which filled 97%
    of the canvas. `ndimage.distance_transform_edt`'s own
    `return_indices` gives the exact nearest water pixel to each
    endpoint; an explicit connector segment is prepended/appended to
    reach it, so the rasterized line is a single unbroken barrier from
    water to water."""
    _, indices = ndimage.distance_transform_edt(~is_water, return_indices=True)
    h, w = is_water.shape

    def nearest_water(pt: tuple[float, float]) -> tuple[float, float]:
        xi = min(max(int(round(pt[0])), 0), w - 1)
        yi = min(max(int(round(pt[1])), 0), h - 1)
        ny, nx = indices[0][yi, xi], indices[1][yi, xi]
        return float(nx), float(ny)

    start_anchor = nearest_water(polyline[0])
    end_anchor = nearest_water(polyline[-1])
    return [start_anchor, *polyline, end_anchor]


#  Pairwise nearest-distance between the Waterway's own 4 components,
# computed directly: {1-2: 193, 1-4: 205, 2-3: 164} vs. {1-3: 946,
# 2-4: 946, 3-4: 778} -- a clean split, not a judgment call. The three
# short pairs read as un-seeded stretches of the SAME continuous river
# (confirmed visually: each sits right where two reaches of one
# connected-looking channel meet); the three long ones are genuinely
# separate, unrelated stretches that just happen to both be somewhere on
# this map. Anything under this threshold gets bridged; anything over it
# doesn't.
WATER_BRIDGE_DISTANCE_PX = 250


def label_at(is_water: np.ndarray, pt: tuple[float, float]) -> int:
    """The water-component id (`ndimage.label`'s own numbering) at a
    given mosaic-pixel point -- used to find a specific component (e.g.
    the main channel, via `MAIN_CHANNEL_REFERENCE_PX`) at runtime rather
    than hardcoding a label number, which isn't guaranteed stable run to
    run."""
    labels, _ = ndimage.label(is_water, structure=np.ones((3, 3), dtype=int))
    h, w = is_water.shape
    xi = min(max(int(round(pt[0])), 0), w - 1)
    yi = min(max(int(round(pt[1])), 0), h - 1)
    return int(labels[yi, xi])


def bridge_water_components(is_water: np.ndarray, exclude_labels: set[int] = frozenset()) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    """The Restored Waterway isn't one single connected shape -- it's
    whatever a handful of independently-seeded flood fills produced, so
    it has real gaps wherever two seeds' own reaches never happened to
    touch (not just at a genuine hard break like structure 26 -- any
    un-seeded stretch between two seeds splits it too). Confirmed
    directly: 4 separate components here.

    Two earlier, narrower attempts both failed: (1) the full ink mask as
    an additional barrier technically sealed the loop but fragmented the
    interior into disconnected pockets a single seed couldn't reach
    (confirmed: several whole building clusters the user's own hash
    marks crossed came out unfilled); (2) bridging only the specific pair
    of components the boundary polyline's own two endpoints touch left
    OTHER real gaps elsewhere along the river open, letting the flood
    escape around a different, unbridged gap entirely (confirmed: the
    whole northeast area past the river filled in instead).

    This version bridges every component pair under
    `WATER_BRIDGE_DISTANCE_PX`, regardless of whether the boundary
    polyline touches them -- stitching the Waterway's own real pieces
    back into the one continuous river the map actually shows, not just
    patching the two spots this particular Regio boundary happens to
    reach. `exclude_labels` skips any pair involving one of those
    components entirely -- see "Corrected 2026-10-19" in this module's
    own header for why the main channel needs excluding here. Returns one
    (point_a, point_b) segment per bridged pair."""
    labels, n = ndimage.label(is_water, structure=np.ones((3, 3), dtype=int))

    comps = {}
    for i in range(1, n + 1):
        if i in exclude_labels:
            continue
        pts = np.argwhere(labels == i)[:, ::-1]  # (x, y)
        if len(pts) > 2000:
            pts = pts[np.random.choice(len(pts), 2000, replace=False)]
        comps[i] = pts

    segments = []
    label_list = sorted(comps)
    for i in range(len(label_list)):
        for j in range(i + 1, len(label_list)):
            pts_a, pts_b = comps[label_list[i]], comps[label_list[j]]
            tree = cKDTree(pts_b)
            dists, idxs = tree.query(pts_a)
            k = int(np.argmin(dists))
            dist = float(dists[k])
            if dist <= WATER_BRIDGE_DISTANCE_PX:
                segments.append((tuple(pts_a[k].astype(float)), tuple(pts_b[idxs[k]].astype(float))))
    return segments


def bridge_components_to_polyline(is_water: np.ndarray, polyline: list[tuple[float, float]], exclude_labels: set[int] = frozenset()) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    """`snap_endpoints_to_water` only connects the polyline's own two
    ENDS to their single nearest water pixel -- which, confirmed
    directly, isn't necessarily the piece of water the user actually
    meant to close against. Here: the boundary's own start point snapped
    to the upper-east branch (32px away) because it's slightly closer
    than the main north-south channel (159px away) -- but the main
    channel is what the user was actually standing next to when they
    started drawing. Confirmed directly: even after bridging every water
    -to-water gap under `WATER_BRIDGE_DISTANCE_PX`, the regio fill still
    leaked across the ENTIRE northeast half of the map, because the main
    channel was never connected to anything and the flood could slip
    around behind it. This checks every water component against the
    WHOLE polyline (not just its two endpoints) and bridges any that come
    within `WATER_BRIDGE_DISTANCE_PX` of it anywhere along its length.
    `exclude_labels` -- see "Corrected 2026-10-19" in this module's own
    header -- skips bridging specific components to the polyline at all
    (the main channel, once the user clarified it's no longer a boundary
    edge but the regio's own interior)."""
    labels, n = ndimage.label(is_water, structure=np.ones((3, 3), dtype=int))
    poly_pts = np.array(polyline)
    poly_tree = cKDTree(poly_pts)

    segments = []
    for i in range(1, n + 1):
        if i in exclude_labels:
            continue
        comp_pts = np.argwhere(labels == i)[:, ::-1]  # (x, y)
        if len(comp_pts) > 2000:
            comp_pts = comp_pts[np.random.choice(len(comp_pts), 2000, replace=False)]
        dists, idxs = poly_tree.query(comp_pts)
        k = int(np.argmin(dists))
        dist = float(dists[k])
        if dist <= WATER_BRIDGE_DISTANCE_PX:
            segments.append((tuple(comp_pts[k].astype(float)), tuple(poly_pts[idxs[k]].tolist())))
    return segments


def seeded_flood_fill(barrier_mask: np.ndarray, seeds: list[tuple[int, int]], closing_iterations: int = 0) -> tuple[np.ndarray, int, int]:
    """Same function as `scripts/style_restored_waterway.py`'s own copy
    -- canonical implementation is `desk-installed-jobs/
    painting-technique/main.py`'s own `seeded_flood_fill`, duplicated
    here for the same reason that script's own copy gives (an installed
    job's `main.py` runs its config-reading side effects unconditionally
    at import time, so it can't just be imported for this function
    alone)."""
    if closing_iterations > 0:
        barrier_mask = ndimage.binary_closing(barrier_mask, structure=np.ones((3, 3), dtype=bool), iterations=closing_iterations)
    open_mask = ~barrier_mask
    labels, _ = ndimage.label(open_mask, structure=np.ones((3, 3), dtype=int))

    h, w = barrier_mask.shape
    seed_label_ids = set()
    n_open = 0
    n_barrier = 0
    for x, y in seeds:
        xi, yi = int(round(x)), int(round(y))
        if not (0 <= xi < w and 0 <= yi < h):
            n_barrier += 1
            continue
        label_id = labels[yi, xi]
        if label_id == 0:
            n_barrier += 1
            continue
        seed_label_ids.add(int(label_id))
        n_open += 1

    filled = np.isin(labels, list(seed_label_ids)) if seed_label_ids else np.zeros_like(barrier_mask)
    return filled, n_open, n_barrier


def main() -> None:
    bounds = json.loads((STAGE_DIR / "bounds.json").read_text())
    waterway = np.asarray(Image.open(WATERWAY_PNG).convert("RGBA"))
    shape = waterway.shape[:2]
    is_water = (waterway[:, :, 2].astype(int) > waterway[:, :, 0].astype(int) + 20) & (waterway[:, :, 3] > 0)
    print(f"mosaic {shape[1]}x{shape[0]}, water barrier: {is_water.sum()} px")

    smoothed = smooth_polyline(BOUNDARY_POLYLINE_PX)
    smoothed = snap_endpoints_to_water(smoothed, is_water)
    boundary_img = Image.new("L", (shape[1], shape[0]), 0)
    ImageDraw.Draw(boundary_img).line(smoothed, fill=255, width=BOUNDARY_STROKE_WIDTH_PX)
    boundary_mask = np.asarray(boundary_img) > 0
    print(f"smoothed boundary ({len(smoothed)} pts): {boundary_mask.sum()} px")

    # See this module's own header, "Corrected 2026-10-19": the main
    # channel is the regio's own INTERIOR now, not a boundary edge, so it
    # must never get bridged into the sealed outer loop -- only the
    # northeastern branch (everything else) does.
    main_channel_label = label_at(is_water, MAIN_CHANNEL_REFERENCE_PX)
    exclude = {main_channel_label}

    # See `bridge_water_components`/`bridge_components_to_polyline`'s own
    # docstrings for the two distinct gap kinds these close: water-to
    # -water (un-seeded stretches of the same river) and polyline-to
    # -water (the boundary's own nearest-pixel snap not always picking
    # the piece of water the user actually meant).
    bridge_segments = bridge_water_components(is_water, exclude) + bridge_components_to_polyline(is_water, smoothed, exclude)
    bridge_img = Image.new("L", (shape[1], shape[0]), 0)
    bridge_draw = ImageDraw.Draw(bridge_img)
    for p1, p2 in bridge_segments:
        bridge_draw.line([p1, p2], fill=255, width=BOUNDARY_STROKE_WIDTH_PX)
    bridge_mask = np.asarray(bridge_img) > 0
    print(f"bridges: {len(bridge_segments)}, {bridge_mask.sum()} px")

    barrier = boundary_mask | is_water | bridge_mask
    regio_fill, n_open, n_barrier = seeded_flood_fill(barrier, [INTERIOR_SEED_PX])
    print(f"seed on open ground: {n_open}, on barrier (skipped): {n_barrier}")
    print(f"regio fill: {regio_fill.sum()} px")

    rgba = np.zeros((*shape, 4), dtype=np.uint8)
    rgba[regio_fill] = [*REGIO_PURPLE, REGIO_ALPHA]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(OUT_PNG)
    OUT_BOUNDS.write_text(json.dumps(bounds, indent=2))
    print(f"wrote {OUT_PNG} + {OUT_BOUNDS}")


main()
