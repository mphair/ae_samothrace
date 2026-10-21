"""Builds the "Restored State -- Waterway" layer: a colorized,
number-free derivative of the Restored plan's own raw ink mask (the
"00 -- Raw ink mask" pipeline-debug stage), requested directly after the
user zoomed into that debug layer and liked what they saw there --
specifically the detailed "lining" linework along the waterway (a
hatched/tick-marked double-line convention this survey uses for a
built, channeled watercourse) and the platforms/bridges that cross it.

This is RASTER EDITING, not vector-line extraction: the channel's own
boundary ink is used to FLOOD-FILL the water area itself with a solid
color, not reduced to an abstracted centerline stroke -- preserving
exactly the hand-drawn "detail" the user said they liked (the fill's
own edges fall right where the real boundary ink was), which a plain
geojson line would lose.

**Corrected 2026-10-17, directly, after the first version shipped**:
that first version recolored the boundary ink itself blue and left the
water's own interior untouched -- "I was looking to fill in the
waterway itself, not color the ink blue... you're filling in the water
rather than the boundaries of the water." Fixed via a morphological
closing of the boundary-ink mask. The user also said the numbers still
weren't visibly cleared and that they want to reconsider that approach
separately -- `find_label_regions` is still computed below but NOT
applied to the output, left for a future pass.

**Corrected 2026-10-18, twice, from real ink-point-stream annotation
passes** (rec-1792376622614-0883 and rec-1792386103334-1fcc -- see
TODO.md's own entries for the full story, including the two earlier
passes that got lost before ink-logging existed/before the widget had
reloaded to pick it up, and the screen-px-to-mosaic-px calibration this
needed). These two passes hand-patched the original corridor-detection
pipeline (warp the Initial Map photo into this mosaic's pixel space,
detect its blue pixels, dilate into a corridor, intersect with thin
-only ink, close the gaps) with a growing pile of hand-traced
corrections: exclude loops for wrongly-filled areas, "tighten" zones
that only kept fill near a reference line, and a force-include segment
for a stretch the pipeline missed entirely. That pipeline, and all of
those corrections, are GONE as of the rewrite below -- replaced
wholesale by a completely different, much simpler technique. Kept only
for the historical record (not applied, not present in the code
anymore): the corridor pipeline periodically filled an unrelated nearby
line (an elevation contour) instead of the channel, or filled a
plausible-looking but wrong area near a fork, and needed per-mistake
hand correction to fix. See the next section for what replaced it and
why that whole class of mistake can't happen with the new technique.

## REWRITTEN 2026-10-18: seeded flood fill, not corridor detection

A third real annotation pass (rec-1792387641944-c56b) took a
deliberately different approach: instead of marking up what the
PIPELINE got wrong, the user turned the "Restored State -- Waterway"
layer off entirely, looked at just the raw ink mask, and placed BLUE
seed points directly inside the real channel: "put some spots, and in
those spots you should be able to do a normal flood fill... move out
from that blue spot... and keep growing that until it hits a line, or
some other color besides white." This is literally a seeded flood fill
("paint bucket") -- and it sidesteps the entire hard problem the
corridor pipeline was built to solve (telling the channel's own
"ladder" boundary convention apart from the SAME convention used for
stone-lined paths elsewhere in this drawing, with no shape-based signal
to do it automatically) by letting a human just point at the water
directly. Implemented as a real, reusable installed job --
`desk-installed-jobs/painting-technique/main.py` -- per the user's own
direct request ("please write something that can do that... build it
into the installed job"); its own header comment has the full algorithm
writeup (connected-components on the inverse of the ink mask, not a
hand-rolled pixel BFS) and is the canonical source for
`seeded_flood_fill` below, duplicated here rather than imported (same
reasoning as every other cross-script duplication in this project: an
installed job's own `main.py` calls its own `main()` unconditionally at
module scope, so importing it would re-run that job's config-reading
side effects instead of just getting the function).

**Tested head-to-head against the old corridor pipeline's hand
-corrected output before committing to the rewrite, not assumed
better**: a raw flood fill with no closing leaked catastrophically (2.6
million px filled -- about 44% of the entire canvas -- confirming
directly why the ORIGINAL design avoided a seeded flood fill in the
first place: hand-drawn ink has real gaps a naive fill pours straight
through). `FLOOD_FILL_CLOSING_ITERATIONS` of 1 still leaked almost as
badly (2.3M px); 2 dropped to ~101K px -- a cliff, not a gradual
improvement, meaning the real gaps that matter are small and a modest
closing closes all of them at once. 3 and 4 landed within a few hundred
px of each other (~100K), confirming 2 isn't a fragile, right-at-the
-edge value. Landed on 3 for a small safety margin past that cliff.
Visually re-verified against the SAME trouble spots the old pipeline's
hand corrections were built for -- structures 22/23's wrongly-filled
blob, structure 7's wrongly-filled rooms, structures 14/15's
missing-real-channel/filled-wrong-contour error -- and the new
technique gets every one of them right, with ZERO hand-maintained
exclude/tighten/force-include corrections. It also correctly leaves
every confirmed bridge crossing (building 26, and the three
`MANUAL_BRIDGE_LOOPS_PX` platforms) as a hard, disconnected break by
default, same as a real wall would be -- see "Bridges, under the new
technique" below for why that's expected and how the fainter-blue
fading is added back on top.

## Seed points

`SEED_POINTS_PX` are the user's own 7 BLUE annotation points from
rec-1792387641944-c56b, converted from the recording's own screen-px/
view-lon-lat log into this mosaic's pixel space (same calibration
approach as the old corridor-era corrections used, verified the same
way: see TODO.md's own entry for this pass). Each seed only needs to
land anywhere on open (non-ink) ground within the real channel --
`seeded_flood_fill` does the rest via connected-component labeling, so
small waypoint imprecision is a non-issue, unlike the old hand-traced
corridor centerline which needed real care. Expected to grow if a
future pass finds a reach of the channel with no seed in it at all (that
reach just wouldn't show up in the output -- nothing to exclude or
tighten, just a missing seed to add).

## Bridges, under the new technique

The corridor pipeline's closing operated on THIN boundary ink only, so
it could bridge a gap even where a thick structure wall ink sat between
two reaches of channel (the closing doesn't know or care what's
"under" the gap it bridges). The new technique closes the FULL ink mask
(thin boundary lines AND thick walls, uniformly -- there's no reason to
tell them apart anymore, since a human seed decides what's water, not a
shape heuristic), so a real structure's own wall ink is just as much of
a barrier to the flood as the channel's own boundary ink is. A genuine
bridge crossing -- confirmed by the dotted-line-between-two-end-caps
print convention `MANUAL_BRIDGE_LOOPS_PX`'s own comment describes --
therefore shows up as a hard, disconnected gap in the raw flood fill by
default, visually indistinguishable from a building merely adjacent to
the channel. `BRIDGE_LABELS`/`MANUAL_BRIDGE_LOOPS_PX` fix this exactly
as before: their union is added BACK into the rendered fill directly
(not intersected with the flood's own connectivity -- these are hand
-confirmed real crossings, added unconditionally), then recolored at
`WATER_ALPHA_UNDER_BRIDGE` instead of the full `WATER_ALPHA_OPEN`. Two
adjacent, otherwise-disconnected flood components end up visually
joined across the bridge even though they're never actually the same
connected component in the underlying mask -- which is fine, since
nothing downstream needs them to be.

## Why this can't just reuse Actual's own stream extraction

The Restored plan's own scan has ZERO saturated-blue ink anywhere
(confirmed: `00_blue-mask.png` for Restored is 100% white) -- the river
was "cleared, bordered, and in places built over" in this
interpretation, so it was never printed in color there. Asked the user
whether to borrow Actual's own already-extracted stream path instead;
they said no -- the waterway's own linework is already clearly visible
in Restored's own raw ink. (This reasoning predates the seeded-flood
-fill rewrite above and is kept for context, not because the new
technique still touches the Initial Map photo at all -- it doesn't;
`warp_initial_map_into_restored_px`/`detect_blue`/the whole corridor
concept are gone.)

## Number-label erasure (computed, NOT applied)

Elevation digits and building-ID numbers turn out to have nearly
identical connected-component statistics in this raw scan as the
survey's own decorative wall-ornament dots (confirmed directly -- a
single "20" building-ID digit and a decorative dot from building 29's
own wall ornamentation differ by only a few pixels in height/width/
area). Pure shape/size filtering can't reliably tell them apart. The
distinguishing signal used here instead: a decorative dot is one of
SEVERAL similarly-sized components clustered together in a tight,
repeating row; a label number is comparatively isolated. Components
with 0-1 similarly-sized neighbors within a small radius are erased;
components with 2+ are kept. This is a real, accepted compromise, not a
perfect classifier. The user is reconsidering the approach separately,
so this stays computed-but-unused until they raise it again.

## Compass/scale bar removal, and the contour lines that needed reconnecting

The Restored plan's own printed compass indicator and scale bar are
extracted into their own "Keys" entries by `scripts/
extract_restored_keys.py` (2026-10-19: "I don't want that in the
waterway layer that we're building") and blanked out of `ink_mask` here
via `RESTORED_KEY_MASK_BOXES` before anything else runs. Blanking a
rectangle necessarily cuts clean through any real elevation-contour line
passing underneath, leaving two dangling stubs -- confirmed directly the
very next pass ("that last extraction... left some weird hanging
situations here in terms of the contour lines"), and fixed by hand
-tracing each severed line back together across the gap
(`CONTOUR_RECONNECT_SEGMENTS_PX`, folded into `ink_mask` before
composing, same "duplicated rather than imported" reasoning as every
other hand-derived geometry constant in this file). See both constants'
own comments for the full story, including a stray ink fragment that
turned out to be the compass's own crosshair bar poking past the
original (now widened) mask box edge, not a contour at all.

## Output

`Data/mapFeatures/SamoWeb_RestoredStatePlan_WaterwayView.png` (RGBA,
transparent background, pixel-for-pixel aligned with the same mosaic
`.desk_temp/pipeline-stages/restored/00_raw-ink.png` already is) +
`.bounds.json` (a plain copy of that stage's own bounds.json -- this
derived image needs no new geometry computation for placement, it's
already in that exact pixel grid).

## Known limitations

- Numbers: not addressed, see this file's own header comment above --
  the user is reconsidering the approach.
- Number-label erasure is a best-effort heuristic (see above), not a
  perfect classifier.
- `MANUAL_BRIDGE_LOOPS_PX`/`BRIDGE_LABELS` are still hand-maintained --
  a real bridge crossing not yet annotated will show as a plain hard
  break rather than a faded one, same as structures 13/14's own
  deliberately-unresolved crossing (the user circled it but flagged
  their own uncertainty, so it's left alone).
- `SEED_POINTS_PX` only covers what the user actually seeded in one
  pass -- a reach of the channel with no seed anywhere in it simply
  won't appear in the output. Unlike the old corridor pipeline (which
  attempted the WHOLE channel automatically, then needed correcting),
  the new technique never guesses at all; a missing seed is a silent
  gap, not a wrong answer. Worth specifically checking the full output
  against the raw ink mask for any obviously-missed reach before
  assuming coverage is complete.
- The annotation-to-mosaic-pixel calibration depends on devicePixelRatio
  being 2 and on the pre-clear screenshot capturing the canvas at its
  full, un-cropped backing-store size -- true in every pass so far,
  re-verified each time against an independent reference (building 26's
  own Overlay-geojson footprint), not just assumed to still hold.

Run directly: `python3 scripts/style_restored_waterway.py` (reads from
this project's own Data/ and .desk_temp/, writes to Data/mapFeatures/;
no arguments).
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

PROJECT_DIR = Path(__file__).resolve().parent.parent
TILE = 256
ZOOM = 20

STAGE_DIR = PROJECT_DIR / ".desk_temp" / "pipeline-stages" / "restored"
OVERLAY_PATH = PROJECT_DIR / "Data" / "mapFeatures" / "SamoWeb_RestoredStatePlan_Overlay.geojson"
OUT_DIR = PROJECT_DIR / "Data" / "mapFeatures"
OUT_PNG = OUT_DIR / "SamoWeb_RestoredStatePlan_WaterwayView.png"
OUT_BOUNDS = OUT_DIR / "SamoWeb_RestoredStatePlan_WaterwayView.bounds.json"

# Sampled directly from the Initial Map's own painted river
# (Data/mapSources/initial-map/source.jpg) -- the "water fill style"
# the user asked to reuse. (The photo itself is no longer read by this
# script -- see this module's own header -- but the color it gave us
# stays.)
WATER_BLUE = (70, 130, 200)
WATER_ALPHA_OPEN = 235
# "Include the water under the bridge, but in a much lighter shade so
# it's clear what's going on" (2026-10-18, directly).
WATER_ALPHA_UNDER_BRIDGE = 90

# ─────────────────────────────────────────────────────────────────────
# Seeded flood fill (see this module's own header, "REWRITTEN 2026-10
# -18" section, for the full story and why this replaced the old
# corridor-detection pipeline wholesale).
# ─────────────────────────────────────────────────────────────────────

# `ink_rgb[:, :, 0] < this` is the same "is this pixel ink" threshold
# every stage-mask PNG in this project already uses.
BARRIER_THRESHOLD = 128

# See this module's own header for how this was tuned (0/1 leak
# catastrophically, 2 is a cliff down to ~101K px, 3/4 land within a few
# hundred px of each other) -- 3 for a small safety margin past that
# cliff, not right at its edge.
FLOOD_FILL_CLOSING_ITERATIONS = 3

# The user's own BLUE seed points (rec-1792387641944-c56b, 2026-10-18),
# converted from the recording's screen-px/view-lon-lat log into this
# mosaic's own pixel space -- see this module's own header, "Seed
# points" section. Each just needs to land on open ground somewhere
# inside the real channel; `seeded_flood_fill` (connected-component
# labeling, not a hand-rolled BFS) does the rest.
SEED_POINTS_PX: list[tuple[int, int]] = [
    (887, 227),
    (1203, 205),
    (1062, 901),
    (1028, 1236),
    (1047, 1464),
    (1618, 1982),
    (2129, 1260),
]

# The Restored plan's own printed compass indicator and scale bar
# (mosaic-pixel boxes, same grid as `00_raw-ink.png`) -- extracted into
# their own "Keys" entries by `scripts/extract_restored_keys.py`
# (rec-1792426059633-1b56, 2026-10-19: "I don't want that in the
# waterway layer that we're building"). Blanked out of `ink_mask` before
# anything else runs, so neither symbol survives into this script's own
# `other_ink` rendering. TIGHTER than that script's own crop boxes (same
# "generous crop, tighter mask" split its own header explains) -- kept
# as a separate hand-maintained copy here rather than read from
# `restored-plan/transform.json` at runtime, same "duplicated rather
# than imported, these scripts assume direct execution" reasoning every
# other hand-derived geometry constant in this file already follows.
RESTORED_KEY_MASK_BOXES: list[tuple[int, int, int, int]] = [
    # Left edge extended from 2085 to 2065, 2026-10-19 (rec-1792441616287
    # -d4c4): the compass's own crosshair bar runs slightly wider than
    # the original box -- "there's a little line segment there... that is
    # not actually part of a contour... that is part of the compass
    # key" -- confirmed directly against a crop: the crossbar's own left
    # tip was sticking out past the old boundary, reading as a stray,
    # unconnected ink fragment.
    (2065, 1760, 2230, 1980),  # compass (the "N" + arrow/crosshair)
    (1870, 2000, 2420, 2140),  # scale bar
]

# Hand-drawn reconnections for elevation-contour lines the two mask boxes
# above severed -- directly requested the same pass: "that last extraction
# of the compass and scale keys left some weird hanging situations here
# in terms of the... contour lines... I'm going to use purple here to
# extend these major lines... in green, these are minor ones... just
# drawing those connections there." Traced by the user along each real
# contour's own remaining stubs on either side of a mask box, not a
# generic bridge -- same "duplicated rather than imported" reasoning
# RESTORED_KEY_MASK_BOXES gives for living here rather than in
# `extract_restored_keys.py`'s own transform.json. One purple segment
# from the same pass was drawn, then immediately disclaimed by the user
# themselves ("I don't think that was actually correct") and crossed out
# in red -- not included here. Rendered as ordinary ink (folded into
# `ink_mask` below), no visual distinction between the "major"/"minor"
# labels the user used while narrating which real contour each one
# belongs to -- that distinction was about which line they were tracing,
# not how it should look once reconnected.
CONTOUR_RECONNECT_SEGMENTS_PX: list[list[tuple[int, int]]] = [
    [(2073, 1995), (2073, 2001), (2071, 2025), (2069, 2036), (2069, 2060), (2066, 2097), (2062, 2132), (2062, 2139), (2064, 2144)],
    [(1926, 2001), (1926, 2010), (1913, 2071), (1904, 2104), (1898, 2132), (1894, 2143)],
    [(1913, 1999), (1904, 2065), (1885, 2139), (1878, 2156)],
    [(1948, 1988), (1948, 1994), (1953, 2076), (1944, 2126), (1929, 2143), (1928, 2148)],
    [(1951, 2152), (1955, 2146), (1975, 2115), (1984, 2086), (1986, 2064), (1984, 2030), (1979, 1995), (1977, 1990)],
    [(2005, 1988), (2010, 1992), (2027, 2041), (2025, 2089), (2012, 2117), (2001, 2141), (1996, 2144)],
    [(2034, 1981), (2036, 1990), (2045, 2036), (2045, 2047), (2045, 2064), (2045, 2080), (2047, 2108), (2040, 2148), (2025, 2161), (2014, 2166)],
    [(2237, 1764), (2231, 1764), (2202, 1764), (2185, 1762), (2174, 1758)],
    [(2086, 1766), (2091, 1767), (2102, 1782), (2112, 1804), (2117, 1837), (2121, 1865), (2126, 1894), (2126, 1911), (2126, 1937), (2126, 1948), (2128, 1964), (2128, 1975), (2128, 1986)],
    [(2126, 1997), (2124, 2003), (2115, 2030), (2112, 2047), (2106, 2075), (2102, 2102), (2097, 2130), (2095, 2146)],
]
# Rasterized stroke width (px) for the segments above -- thin, matching
# this survey's own elevation-contour line weight (nowhere near
# BOUNDARY_STROKE_WIDTH_PX-style thicknesses, which are for a hand-drawn
# ANNOTATION boundary, not a redrawn printed contour).
CONTOUR_RECONNECT_WIDTH_PX = 2

# Structure Labels (Data/mapFeatures/SamoWeb_RestoredStatePlan_Overlay.geojson's
# own `properties.Label`) confirmed to be real bridges the channel
# passes under, as opposed to a building merely adjacent to it -- see
# this module's own "Bridges, under the new technique" section above.
# Hand-maintained rather than automatic (two different geometric
# heuristics were tried early on and both mis-classified structure 26,
# a real, visually confirmed bridge, before the user reconsidered it --
# see the next paragraph).
#
# Used to hold `{"26"}` (Propylon of Ptolemy II), added by direct visual
# inspection before any real annotation data existed for this feature.
# REVERTED 2026-10-18 (rec-1792376622614-0883): the user looked again
# and corrected themselves -- "as you noted, this part of 26 is over the
# water... I think actually on that one there's no dotted line there...
# so I think maybe actually just leave that one as a break even though
# we know water is going through there." Confirmed directly against a
# crop of structure 26's own crossing: no dotted-line-between-two-end
# -caps convention present there (contrast with MANUAL_BRIDGE_LOOPS_PX's
# own crops, which all show it plainly). Left as an empty, still-live
# set (rather than deleting the mechanism) since a future structure
# -based bridge may yet turn up a clean match.
BRIDGE_LABELS: set[str] = set()

# Real, confirmed bridge crossings that do NOT correspond to any single
# Overlay structure footprint -- found directly in rec-1792376622614
# -0883's own ink-point-stream log (2026-10-18). The user circled "the
# general area of the bridges in green... this is not the exact outline
# of the bridges, this is just where they are generally." Each circled
# spot was independently confirmed by cropping the raw ink mask there
# and looking for the print convention the user separately described:
# two solid end-caps (short bars perpendicular to the channel,
# connecting its two rails) bounding a gap in the solid wall ink, with a
# dotted line running between them -- a bridge/platform deck over the
# water, as distinct from the plain closed break seen at structure 26
# (see BRIDGE_LABELS' own comment above). All three crops here showed
# that pattern plainly. Stored as hand-traced mosaic-pixel polygons
# (same pixel grid as `00_raw-ink.png`/the output PNG), not tied to any
# structure Label, because none of these crossings sit inside a mapped
# structure's own footprint -- they're bare platforms spanning the
# channel on their own. One further green circle from the same pass,
# between structures 13 and 14, is deliberately NOT included here: the
# user circled it but immediately flagged it themselves -- "because of
# the water here, I can't quite tell if that's right" -- so it's left as
# a plain break rather than guessed at.
MANUAL_BRIDGE_LOOPS_PX: list[list[tuple[int, int]]] = [
    # Between structures 20 and 7/6, no single structure footprint overlaps it.
    [(1021, 684), (1021, 696), (1006, 863), (1044, 878), (1116, 867), (1116, 818), (1124, 726), (1124, 692), (1113, 673), (1040, 684), (1029, 688)],
    # Immediately next to structure 7's own corner.
    [(998, 1099), (998, 1111), (1006, 1172), (1052, 1172), (1082, 1160), (1075, 1099), (1040, 1096), (1006, 1096)],
    # Immediately next to structure 8's own corner.
    [(983, 1271), (983, 1293), (991, 1347), (1002, 1358), (1059, 1347), (1075, 1328), (1067, 1282), (1056, 1274), (1002, 1274), (980, 1274)],
]

# label_candidates' own size/shape filter (scripts/extract_vector_layers.py)
# -- duplicated rather than imported, same reasoning as `seeded_flood_fill`
# below gives for not importing the installed job: these scripts assume
# direct execution.
LABEL_MIN_H, LABEL_MAX_H = 6, 40
LABEL_MIN_W, LABEL_MAX_W = 5, 90
LABEL_MIN_AREA, LABEL_MAX_AREA = 15, 900
# Isolation test for telling a real label apart from a decorative dot
# -- see this file's own header comment.
LABEL_NEIGHBOR_RADIUS_PX = 45
LABEL_SIMILAR_SIZE_TOLERANCE = 0.35
LABEL_MAX_SIMILAR_NEIGHBORS = 1


def project_world(lon: float, lat: float) -> tuple[float, float]:
    n = 2**ZOOM * TILE
    x = (lon + 180) / 360 * n
    lat_rad = math.radians(lat)
    y = (1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n
    return x, y


def seeded_flood_fill(barrier_mask: np.ndarray, seeds: list[tuple[int, int]], closing_iterations: int = 0) -> tuple[np.ndarray, int, int]:
    """Canonical implementation lives in
    `desk-installed-jobs/painting-technique/main.py` (its own header
    comment has the full algorithm writeup) -- duplicated here rather
    than imported because that job's own `main.py` calls its own
    `main()` unconditionally at module scope (the convention every
    installed job in this project follows), so importing it would
    re-run that job's config-reading side effects instead of just
    getting this function. Keep the two copies in sync by hand if this
    logic ever changes."""
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


def find_label_regions(ink_mask: np.ndarray) -> np.ndarray:
    """Boolean mask of ink components judged to be number labels (see
    this file's own header comment for the isolation heuristic)."""
    labels, n = ndimage.label(ink_mask, structure=np.ones((3, 3), dtype=int))
    objs = ndimage.find_objects(labels)
    cands = []
    for i in range(1, n + 1):
        sl = objs[i - 1]
        if sl is None:
            continue
        h = sl[0].stop - sl[0].start
        w = sl[1].stop - sl[1].start
        if not (LABEL_MIN_H <= h <= LABEL_MAX_H and LABEL_MIN_W <= w <= LABEL_MAX_W):
            continue
        area = int((labels[sl] == i).sum())
        if not (LABEL_MIN_AREA <= area <= LABEL_MAX_AREA):
            continue
        cy = (sl[0].start + sl[0].stop) / 2
        cx = (sl[1].start + sl[1].stop) / 2
        cands.append({"i": i, "area": area, "cy": cy, "cx": cx})

    if not cands:
        return np.zeros_like(ink_mask)

    pts = np.array([[c["cy"], c["cx"]] for c in cands])
    tree = cKDTree(pts)
    erase_ids = []
    for idx, c in enumerate(cands):
        neighbor_idxs = tree.query_ball_point(pts[idx], r=LABEL_NEIGHBOR_RADIUS_PX)
        similar = 0
        for j in neighbor_idxs:
            if j == idx:
                continue
            other = cands[j]
            if abs(other["area"] - c["area"]) / max(c["area"], 1) < LABEL_SIMILAR_SIZE_TOLERANCE:
                similar += 1
        if similar <= LABEL_MAX_SIMILAR_NEIGHBORS:
            erase_ids.append(c["i"])

    return np.isin(labels, erase_ids)


def rasterize_loop_mask(shape: tuple[int, int], loop: list[tuple[int, int]]) -> np.ndarray:
    """Fills a single closed, hand-traced mosaic-pixel polygon
    (MANUAL_BRIDGE_LOOPS_PX) -- same PIL ImageDraw.polygon approach
    rasterize_structure_footprints already uses for Overlay geojson
    polygons, just fed hand-traced points instead of reprojected
    lon/lat ones."""
    img = Image.new("L", (shape[1], shape[0]), 0)
    ImageDraw.Draw(img).polygon(loop, fill=255)
    return np.asarray(img) > 0


def rasterize_structure_footprints(shape: tuple[int, int], origin: tuple[float, float]) -> tuple[np.ndarray, np.ndarray]:
    """Restored monument/structure footprints (same source every other
    layer in this project already reads), reprojected into this
    mosaic's own pixel space and filled, split into two masks by
    BRIDGE_LABELS. `non_bridge_mask` is subtracted from the flood fill
    as a safety net (the flood fill's own barrier mask already includes
    every structure's wall ink, so it shouldn't be able to enter a
    building's interior in the first place -- this just guards against
    a thin wall's own print gap getting bridged by
    FLOOD_FILL_CLOSING_ITERATIONS). `bridge_mask` is the opposite: added
    back into the fill unconditionally and rendered at
    WATER_ALPHA_UNDER_BRIDGE instead of being excluded -- see this
    module's own "Bridges, under the new technique" section."""
    data = json.loads(OVERLAY_PATH.read_text())
    non_bridge_img = Image.new("L", (shape[1], shape[0]), 0)
    bridge_img = Image.new("L", (shape[1], shape[0]), 0)
    non_bridge_draw = ImageDraw.Draw(non_bridge_img)
    bridge_draw = ImageDraw.Draw(bridge_img)
    for feature in data["features"]:
        draw = bridge_draw if feature["properties"].get("Label") in BRIDGE_LABELS else non_bridge_draw
        geom = feature["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            for ring in poly:
                pts = []
                for lon, lat in ring:
                    wx, wy = project_world(lon, lat)
                    pts.append((wx - origin[0], wy - origin[1]))
                if len(pts) >= 3:
                    draw.polygon(pts, fill=255)
    return np.asarray(non_bridge_img) > 0, np.asarray(bridge_img) > 0


def main() -> None:
    ink_rgb = np.asarray(Image.open(STAGE_DIR / "00_raw-ink.png").convert("RGB"))
    ink_mask = ink_rgb[:, :, 0] < BARRIER_THRESHOLD
    bounds = json.loads((STAGE_DIR / "bounds.json").read_text())
    origin = project_world(bounds["west"], bounds["north"])
    shape = ink_mask.shape  # (rows, cols) == (height, width)

    # See RESTORED_KEY_MASK_BOXES' own comment -- the compass/scale bar
    # now live in their own "Keys" entries, not here.
    removed_by_key_mask = 0
    for x0, y0, x1, y1 in RESTORED_KEY_MASK_BOXES:
        removed_by_key_mask += int(ink_mask[y0:y1, x0:x1].sum())
        ink_mask[y0:y1, x0:x1] = False

    # See CONTOUR_RECONNECT_SEGMENTS_PX's own comment -- real contour
    # lines the boxes above severed, redrawn by hand across the gap.
    reconnect_img = Image.new("L", (shape[1], shape[0]), 0)
    reconnect_draw = ImageDraw.Draw(reconnect_img)
    for segment in CONTOUR_RECONNECT_SEGMENTS_PX:
        reconnect_draw.line(segment, fill=255, width=CONTOUR_RECONNECT_WIDTH_PX)
    reconnect_mask = np.asarray(reconnect_img) > 0
    ink_mask |= reconnect_mask

    print(f"ink mask: {ink_mask.sum()} px, mosaic {shape[1]}x{shape[0]} (-{removed_by_key_mask}px compass/scale key, +{int(reconnect_mask.sum())}px contour reconnects)")

    water_fill_raw, n_open, n_barrier = seeded_flood_fill(ink_mask, SEED_POINTS_PX, FLOOD_FILL_CLOSING_ITERATIONS)
    print(f"seeds on open ground: {n_open}, seeds landed on a barrier pixel (skipped): {n_barrier}")
    if n_barrier:
        print(f"WARNING: {n_barrier} seed(s) landed on ink and were skipped -- check SEED_POINTS_PX")

    non_bridge_mask, bridge_struct_mask = rasterize_structure_footprints(shape, origin)
    water_fill = water_fill_raw & ~non_bridge_mask

    # Bridges (BRIDGE_LABELS + MANUAL_BRIDGE_LOOPS_PX) are added back in
    # unconditionally -- the flood fill itself can't cross a real
    # structure's own wall ink, so a genuine bridge crossing is a hard,
    # disconnected gap in `water_fill` by default, same as any other
    # adjacent building. See this module's own "Bridges, under the new
    # technique" section for why this union (not an intersection) is
    # what actually bridges the visual gap.
    manual_bridge_mask = np.zeros_like(bridge_struct_mask)
    for loop in MANUAL_BRIDGE_LOOPS_PX:
        manual_bridge_mask |= rasterize_loop_mask(shape, loop)
    bridge_mask = bridge_struct_mask | manual_bridge_mask
    water_fill = water_fill | bridge_mask

    under_bridge = water_fill & bridge_mask
    open_water = water_fill & ~bridge_mask
    print(f"water fill: {water_fill.sum()} px -- {under_bridge.sum()} under a bridge")

    # Numbers: left alone -- "I don't see any of the numbers removed...
    # I'm gonna have to think about how we want to go about that
    # instead" (2026-10-17) -- the user is reconsidering the approach,
    # not asking for a fix here. find_label_regions/LABEL_* constants
    # are kept below, unused by main() for now, rather than deleted,
    # since whatever comes next will likely still start from this same
    # isolated-vs-clustered heuristic.
    label_regions = find_label_regions(ink_mask)
    print(f"label regions (computed, not applied this round): {label_regions.sum()} px")

    # Compose: transparent background; all non-water ink stays as-is
    # (opaque near-black, same tone save_stage_mask already uses);
    # the flood-filled water area is solid blue, replacing whatever ink
    # was under it (the channel's own boundary lines) rather than
    # drawing both -- full opacity in the open, fainter under a
    # confirmed bridge.
    rgba = np.zeros((*shape, 4), dtype=np.uint8)
    other_ink = ink_mask & ~water_fill
    rgba[other_ink] = [20, 20, 20, 255]
    rgba[open_water] = [*WATER_BLUE, WATER_ALPHA_OPEN]
    rgba[under_bridge] = [*WATER_BLUE, WATER_ALPHA_UNDER_BRIDGE]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(OUT_PNG)
    OUT_BOUNDS.write_text(json.dumps(bounds, indent=2))
    print(f"wrote {OUT_PNG} + {OUT_BOUNDS}")


main()
