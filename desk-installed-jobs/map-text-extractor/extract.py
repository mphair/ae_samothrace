"""Splits a line-art-style map image into separate same-dimensions layers
-- text labels, realm-border dashed lines, mountain hachures, the title
block, city markers + names, realm names, and everything else
(coastlines, rivers, islands, compass rose, scale bar, legend glyphs) --
each with the removed content filled by a locally-detected background
color (via OpenCV inpainting) rather than a flat placeholder.

This file deliberately never writes any of this particular map's own
text content (title, city names, realm names, ...) as a literal string
anywhere in its source -- every text-aware step here (title detection,
realm-vs-city text separation) works from shape, position, and OCR
-detected geometry, not from matching known words. Keep it that way in
any edit: if a fix needs to reference what a label actually SAYS, that's
a sign that step needs to move to NOTES.md or a runtime check instead of
a code constant.

Runs as a plain subprocess under this job's own dedicated venv (see
../main.py, which creates that venv and invokes this script in it) --
deliberately NOT importing anything from Desk itself, so it can also be
run standalone for debugging:

    <venv>/bin/python extract.py <source_image> <output_dir>

## Why this is hard, and the approach taken

This kind of map (hand-drawn-style, mostly two flat fill tones -- white
sea, grey land -- with black ink on top) has ONE color for everything
that isn't flat fill: text, coastlines, realm borders, rivers, mountain
hachures, the legend glyphs, the compass rose, the scale bar. There's no
color-based way to separate these -- it has to be shape-based, and
different features need different shape cues:

1. Threshold on grayscale value to get a binary "ink" mask (anything
   darker than INK_THRESHOLD -- both flat-fill tones sit well above it,
   confirmed empirically on this image: land fill ~222, sea ~254, ink
   mostly under ~200 including antialiased edges).
2. Label connected components (8-connectivity). Anything bigger than
   MAX_TEXT_DIM/MAX_TEXT_AREA is immediately long-sprawling line art
   (coastlines, rivers, the compass rose, the scale bar) -- parked in
   `other_mask` right away, never considered for the finer passes below.
3. Of what's left (small, text-sized ink blobs), four passes run IN
   ORDER, each claiming components the next pass never sees:

   a. **Islands** -- a component that looks like a closed ring enclosing
      a big chunk of its own bounding box (a thin outline looping back
      on itself around mostly-empty interior space, the way a small
      island's coastline is drawn). Detected via contour hierarchy: does
      it have a child contour (hole) whose area is a large fraction of
      the bbox area? Guarded by also requiring overall fill ratio to be
      LOW first, so a letter with an open counter (a blackletter "C", a
      digit "0") doesn't also qualify -- real letter-holes are small
      relative to their own bbox; island holes are most of it. Runs
      FIRST specifically so a small island/lake ring never gets
      mistaken for a realm-border chain in the next pass (topologically
      both are "a thin loop of small segments").
   b. **Realm-border chains** -- the legend's own "Realm Border" glyph is
      a dash-dot line, visually distinct from the solid lines used for
      coastlines/rivers. Three real properties, each measured directly
      against this image's own border ink (not just the legend swatch,
      and not just inferred from shape):

      - **Shade**: every real dash sampled across four different border
        stretches (a straight one, a tightly-curving one, two others)
        has the SAME narrow ink signature -- area 69-80px^2, mean gray
        107-119, major-axis length 12-16px -- essentially a fixed-size
        stamp used uniformly for every realm border on the map,
        regardless of which border or how curvy. Histogrammed the full
        dash-sized candidate pool to confirm this is a real, separable
        cluster (not just the hand-picked samples): a dominant peak at
        mean-gray 96-125 (the real dashes) versus a separate hump at
        130-170 (hachure-sized fragments and other non-border ink).
        `DASH_*` below encode this signature as a PRE-FILTER, applied
        BEFORE any graph/chain logic even runs -- only components that
        already look like an individual border dash are eligible to be
        considered for a chain at all. This cleans up the candidate
        pool enough that the chain thresholds below could be relaxed
        from the previous (more conservative, recall-sacrificing)
        version without reintroducing the text-contamination problems
        that motivated the conservative thresholds in the first place.
      - **Consistent segment length and spacing**: consecutive dash
        centers sit ~19-22px apart with near-identical dash size, and --
        the part that actually generalizes, including around tight
        curves -- a border is topologically a thin CHAIN (each dash has
        ~2 neighbors: one ahead, one behind) where a mountain hachure
        field is a 2D MESH (many ticks within a short radius of several
        others). Built as a proximity graph (edges between component
        centroids within BORDER_LINK_RADIUS) over the dash-like
        candidates; each graph-connected "raw chain" gets its own
        per-node area-outlier prune (catches a stray look-alike that
        slipped through the shade/size pre-filter) and a branching check
        (rejects anything mesh-shaped, not chain-shaped).
      - **Endpoints are real, not arbitrary stops**: a border's own
        drawn endpoint is at a coastline, another border, or the map
        edge -- never just trailing off in open water or mid-label. In
        particular, a border crossing under a text label is NOT a real
        endpoint on either side of that label, even though the ink
        itself doesn't connect through the gap. Implemented as a
        BRIDGING step over the raw chains: two raw chains (each already
        >=2 nodes on their own -- a lone single dash never bridges on
        its own, to avoid chaining onto incidental noise) within
        BRIDGE_MAX_GAP of each other get unioned into one border line
        IF there's a real other ink component (area >=
        MIN_CROSSING_COMPONENT_AREA, roughly letter-sized) physically
        between their two nearest ends -- i.e., something is actually
        interrupting the dash pattern there, not just blank space where
        a real border would have genuinely ended. Final acceptance
        (BORDER_MIN_NODES/BORDER_MIN_SPAN) is checked against the
        MERGED line's total node count and span, not each raw chain
        piece individually, so a real border that's cut into three
        short text-interrupted fragments is evaluated as the one line
        it actually is.

      The surviving members of each accepted (and now possibly bridged
      -together) chain, not the whole original graph-component, are
      what gets claimed as border ink.
   c. **Mountain hachures** -- per-component shape (size, aspect ratio,
      fill ratio) turns out NOT to reliably separate a hachure tick from
      a letter in general; they genuinely overlap (verified directly
      against this image). What DOES work, pointed out by direct human
      review of this map's own drawing convention rather than inferred
      statistically: every hachure mark on this map is drawn as a single
      mostly-horizontal line (sometimes a shallow curve, sometimes two
      touching segments -- which is still one connected ink component,
      so no special-casing needed for that), and every one is within
      about 20% of the size of one of the two sample strokes shown in
      the map's own "Mountains" legend-key row. Both are measured
      directly from that legend swatch (`MOUNTAIN_SAMPLE_*` below) rather
      than guessed. A component's orientation is its ink pixels' own PCA
      major-axis angle, NOT `cv2.minAreaRect`'s angle -- minAreaRect
      reports the tightest bounding rectangle's rotation, which for a
      shallow arc or chevron is frequently way off from the shape's
      actual visual tilt (confirmed directly: the legend's own single
      -hump mountain sample measured -90 DEGREES by minAreaRect's own
      angle convention despite being, by eye and by PCA, a 3-degree-off
      -horizontal stroke). An earlier version of this pass used
      minAreaRect-angle variance among NEARBY components as a proxy for
      "scattered orientation = mountain" -- it calibrated fine on a
      handful of hand-picked regions but, run over the whole map, pulled
      in huge amounts of unrelated text (the title block, "Lydia",
      "Bithynia", the legend labels). The current PCA-angle +
      legend-relative-size approach replaced it after that regression
      and checks out cleanly at full-map scale -- see NOTES.md in the
      output directory for the before/after.

      A second cue was added after that, pointed out by direct human
      review again: this map draws "physical" ink (hachures, rivers,
      and -- it turns out -- physical-feature NAME text: mountain-range,
      river, and sea labels) in a lighter GRAY, while "political" ink
      (city/realm text, realm-border dashes, the compass-rose arrow) is
      true black. Confirmed directly against this image: every real
      hachure's darkest pixel sits around 88-142 (never below 88 in
      anything sampled), while every confirmed-text/border/arrow false
      positive's darkest pixel sits around 26-29. A component is only
      accepted as mountain if its own darkest pixel is at or above
      MOUNTAIN_MIN_GRAY_VALUE -- this is a genuinely clean, bimodal
      separation (see NOTES.md for the histogram), not a soft rule. It
      does NOT help against a physical-feature-name label sitting this
      close in size/shape/shade to a real hachure (confirmed: "Sa" off
      "Salambria", a river name, stays misclassified) -- shade only
      distinguishes political ink from physical ink, not labels from
      symbols within the same physical-ink category.
   d. Whatever's left is **text**.
4. **Border endpoint extension**, after the border/mountain passes but
   using only the dash-like candidate pool from pass (b) -- reaches from
   each accepted border line's own endpoint for one more unclaimed
   dash-like candidate at a time (EXTEND_RADIUS), repeating until
   nothing is close enough. Recovers isolated single dashes that were
   too far from any neighbor to form their own raw chain (so they never
   got a chance to bridge in pass (b)) but are clearly a continuation of
   an already-real chain right next to them. Lower-risk than it sounds:
   every candidate still has to have already passed the full DASH_*
   shade+size signature to be in the pool at all.
5. **Border endpoint diagnosis**, over whatever's STILL not resolved
   after extension (not at the map edge): checks the now-final `other`
   and `mountain` layers near each dangling endpoint and records why it
   likely stops there (coincident with a coastline/river, running into a
   mountain hachure field, both, or genuinely unclear) in
   `extraction_report.json`'s `border_endpoint_diagnostics` -- per this
   map's own drawing convention, a border is expected to sometimes have
   no further separate ink once it meets one of those features, which
   isn't the same thing as an unexplained gap worth chasing further.
6. **Title block**, found by real OCR (`easyocr`) over a generous
   top-center SEARCH WINDOW (`TITLE_SEARCH_BBOX`), not by matching known
   words -- this map's own title text is never written into this file
   (see the module-level note above). First inpaints away mountain
   hachures and border dashes within that window (per instructions, so
   they don't confuse OCR), then recognizes the title by SHAPE: multiple
   lines, stacked, whose combined bounding boxes all share close to the
   same horizontal center -- a title is conventionally centered, an
   incidental nearby map label isn't centered on that same axis.
   Confirmed directly: the real title's 3 lines landed within a few px
   of a common center, while an unrelated physical-feature-name row just
   above them (caught by the same search window) sat ~120px off and was
   correctly excluded by this rule alone, with no need to know what
   either one actually said. `title_mask.png`/`title_only.png` are built
   from the REAL ink within the found lines (padded), not a blank
   rectangle; the title's own ink is then removed from `text` entirely
   (it's its own layer now).
   - **Title-crossing border reconnection**, using the now-precise title
     geometry: a border line can run directly under/through the title
     block (confirmed: two chain endpoints sitting right at the title's
     own edges, same height as its text, nothing recoverable in
     between -- unlike the river/mountain case, border ink and title
     text are the SAME shade, both political black, so there's no
     hidden dash to find by shade here). Per instructions, this draws an
     EXPLICITLY APPROXIMATED connector between such a pair -- styled as
     a dashed line at the real measured dash pitch, but written to its
     own separate `border_approximated_mask.png` (shown as orange in
     `debug_overlay.png`), never silently merged into "detected" ink
     indistinguishably. `title_crossing_border_connections` in
     `extraction_report.json` lists every endpoint pair connected this
     way.
7. **City squares**: the small solid "Major City" marker, measured from
   this map's own legend-key square. Most real ones on the map TOUCH
   their own city name's first letter (same fused-by-raw-8-connectivity
   issue as border/river), so a plain connected-components pass over the
   unmodified ink mask only finds a few in isolation -- morphological
   OPENING (erode then dilate with a kernel too big for any letter
   stroke to survive) reconstructs each square's rough shape while
   stripping the attached letter off. A square touching something
   THICKER than a letter (a coastline, confirmed on one real case near a
   bay) can still come out oversized/under-filled from that -- retried
   locally with progressively stronger kernels just for that one
   candidate (`CITY_SQUARE_RESCUE_KERNELS`), which peeled the coastline
   sliver off and isolated it cleanly. Each square's name is found by
   taking the single nearest text component as a seed, then GROWING
   outward (`_grow_label_cluster`) to the rest of that same label --
   not a blind per-fragment radius, which was confirmed directly to
   split a wider-font name in half across the radius boundary and, once,
   wrongly pull a different nearby label's own word in because it
   happened to be the physically nearest fragment to some other square.
8. **Realm map**: border ink plus "realm name" text -- political-black
   text (same darkest-pixel shade test the mountain pass already
   validated) that ISN'T a city name (excluded via the city-square pass
   above) and isn't this map's own title (excluded via the OCR-found
   `title_mask` above, not a fixed bbox) or legend/scale-bar (excluded
   by fixed bounding boxes specific to this one image).
9. Inpaint (cv2.INPAINT_TELEA) over each mask to produce isolated,
   same-dimensions images per layer -- inpainting naturally samples the
   LOCAL surrounding pixels, so a label sitting on grey land fills back
   to grey, one sitting on white sea fills back to white, without having
   to special-case the two backdrop tones anywhere in this code.

## Known limitations (expect to refine with human review)

- **City-square false positives**: bold blackletter-font letter corners
  and junctions can be LOCALLY as solid and roughly square-shaped as a
  real city marker after morphological opening -- a fill-ratio check
  doesn't discriminate (junctions are often just as solid), and mean
  -gray doesn't either (checked directly: known-real squares and the
  likely false positives both span the same ~66-100 range, no clean
  separating gap the way mountains-vs-text or political-vs-physical ink
  had one). Confirmed directly: of 27 squares detected on this map, only
  ~8 match known real city positions by eye. CITY_NAME_SEARCH_RADIUS is
  kept tight (55px, real names sit right next to their square) partly
  to limit the damage a false-positive square does -- it'll still show
  up as a small, likely-nameless square in `city_only.png`, not drag in
  an unrelated chunk of nearby text. No further geometric tightening
  attempted after finding no separating signal; this is a first pass
  meant for human review (city squares are a small, countable thing to
  check by eye against `city_mask.png`), not a chase for a perfect
  threshold.

- **Mountain-range NAME labels sitting inside their own hachure
  symbol** (e.g. "Pindos Mtns.", "Taurus Mtns.") are the hardest
  remaining case and often still read as mountain, not text -- this
  isn't really a tuning bug, the two features are intentionally drawn
  overlapping on a map like this.
- A rare false positive: this map draws physical-feature-name text
  (mountain-range, river, sea labels) in the SAME gray ink as hachures
  and rivers -- so the MOUNTAIN_MIN_GRAY_VALUE check (see above) can't
  tell a gray river-name letter-cluster from a real hachure the way it
  cleanly tells black political text apart. Confirmed: "Sa" at the
  start of "Salambria" (a river name, merged two-letter blob ~20x17px)
  still reads as mountain -- its area (150) is smaller than even the
  SMALLER legend sample's own area (160), so it's not an oversized
  match being let through, it's a genuine, near-exact size/shade/shape
  coincidence with a real hachure. Tightening further risks cutting
  real hachures the two-sample calibration may already be at the edge
  of covering -- an adjacency-based rule (demote a candidate if a
  non-mountain neighbor sits immediately beside it) was tried and
  reverted: it over-fired broadly, since a real hachure's own near-miss
  neighbor (one that just barely failed the mountain test) would
  wrongly veto it too, losing real mountain coverage across most of the
  map's ranges.
- The smallest islets (a handful of px across) draw with a stroke thick
  relative to their own tiny bounding box, which can exclude them from
  the "looks like an island" check -- they sometimes end up as text or
  mountain instead.
- Realm-border recall is better than the first version (the dash shade
  -shape pre-filter plus text-interruption bridging recovered real
  border mileage that used to fall back to "text" or "other"), but
  still not complete -- a border stretch with fewer than
  BRIDGE_MIN_RAW_CHAIN_LEN (2) dashes on either side of a gap can't
  bridge at all (a lone isolated dash deliberately never bridges on its
  own, to avoid chaining onto incidental noise), and a gap wider than
  BRIDGE_MAX_GAP (110px, roughly 1-2 word widths) won't bridge even
  with a real interrupting label in between. If you need fuller
  coverage, BRIDGE_MAX_GAP is the first thing to try loosening -- but
  check debug_overlay.png afterward, since a wider gap also means more
  distance for a coincidental, non-border crossing component to
  wrongly justify a bridge.
- Legend swatch glyphs (the little dashed-border/river/hachure icons in
  the map key) mostly land in whichever bucket matches their own real
  counterpart (the border icon as border, the mountain icon as
  mountain), which is arguably correct, just worth knowing going in.
- A solid horizontal bar at the very top edge of the specific source
  screenshot this was built against (likely a UI/crop artifact, not map
  art) always lands in `other` -- harmless, just noting it so it isn't
  mistaken for something real.

None of these are fixed in code (yet) -- they're surfaced in
debug_overlay.png (red = text, green = realm border, magenta = mountain,
blue = other line art) and extraction_report.json specifically so a
human reviewing the output can say which of these actually matter for
what they need, and which constant below to retune in response.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

# -- Tunable constants -------------------------------------------------
# All calibrated against the one "Theban Tribunal, 1220 A.D." map this
# job was first built for (1542x1506, mostly-flat two-tone fill). Revisit
# if run against a map with a different drawing style, resolution, or
# font scale.

INK_THRESHOLD = 210          # grayscale value below which a pixel counts as "ink" (vs. flat background fill)
MAX_TEXT_DIM = 150           # px -- a component wider or taller than this is treated as big line art outright
MIN_TEXT_DIM = 4             # px -- drop antialiasing specks smaller than this
MAX_TEXT_AREA = 6000         # px^2 -- an upper bound on a single small component's ink area

HOLE_FRACTION_THRESHOLD = 0.18        # hole_area / bbox_area above this looks like a closed ring (island), not a letter
MAX_FILL_RATIO_FOR_HOLE_CHECK = 0.33  # only run the hole check on components inked LESS than this fraction of their own bbox

# Measured directly across four different real border stretches (a
# straight one, a tightly-curving one, two others) -- every single real
# dash fell inside these bounds; see this module's docstring for the
# full histogram story. This is a PRE-FILTER: a component must look
# like an individual border dash before it's even considered for the
# chain-building graph below.
DASH_MIN_AREA = 55
DASH_MAX_AREA = 95
DASH_MIN_MAJOR_DIM = 10
DASH_MAX_MAJOR_DIM = 20
DASH_MIN_MEAN_GRAY = 90
DASH_MAX_MEAN_GRAY = 125

BORDER_LINK_RADIUS = 28      # px -- proximity-graph edge radius; measured real dash pitch is ~19-22px center-to-center
BORDER_MIN_NODES = 3         # an accepted (post-bridging) border line needs at least this many total dash components
BORDER_MAX_BRANCHY_FRACTION = 0.35   # fraction of nodes allowed to have 3+ neighbors before it reads as a 2D mesh, not a chain
BORDER_MIN_SPAN = 30         # px -- an accepted (post-bridging) border line's own bounding diagonal must reach at least this far
BORDER_AREA_OUTLIER_RATIO = 2.5      # a node whose area differs from its own raw chain's median by more than this is pruned (catches a stray look-alike)

# Bridging: two raw chains separated by a real interrupting component
# (typically text) get unioned into one border line before the
# BORDER_MIN_NODES/BORDER_MIN_SPAN check above, so a border cut into
# several text-interrupted fragments is evaluated as the one line it
# actually is. See this module's docstring for why each of these exists.
BRIDGE_MAX_GAP = 110                 # px -- max distance between two raw chains' nearest ends to even consider bridging (~1-2 word widths)
BRIDGE_MIN_RAW_CHAIN_LEN = 2         # a raw chain needs at least this many of its OWN members before it's eligible to bridge at all (blocks a lone dash from bridging onto incidental noise)
MIN_CROSSING_COMPONENT_AREA = 30     # px^2 -- the gap must contain a real other ink component at least this big (roughly letter-sized), not just incidental pixels

# Endpoint extension: a validated chain's own endpoint reaches for ONE
# more unclaimed dash-like candidate at a time, repeating until nothing
# is close enough -- recovers isolated single dashes that were too far
# from any neighbor to form their own raw chain (so they never got a
# chance to bridge) but are clearly a continuation of an already-real
# chain right next to them. See this module's docstring for why this
# turned out to be lower-risk than it sounds (every extension candidate
# still has to pass the full DASH_* shade+size signature on its own).
EXTEND_RADIUS = 42           # px -- a bit more than BORDER_LINK_RADIUS, to bridge one slightly-larger-than-usual gap
MAX_EXTEND_STEPS = 15        # safety cap per endpoint, not expected to be reached in practice

# Endpoint diagnosis: after extension, a chain endpoint that still isn't
# near the map edge gets checked against the (by-then-already-computed)
# `other` and `mountain` layers to explain WHY it stops there, rather
# than just leaving it unexplained -- a border running coincident with a
# river or through a mountain hachure field is expected to sometimes
# have no further separate border ink at all once it meets one of those
# features, per this map's own drawing convention.
ENDPOINT_EDGE_MARGIN = 20            # px -- within this of the image border counts as "reaches the map edge"
ENDPOINT_FEATURE_SEARCH_RADIUS = 45  # px -- how far to look for a coincident river/coastline or mountain field near a dangling endpoint

# Measured directly from this map's own "Mountains" legend-key row (two
# sample strokes shown side by side: a single shallow curve, and a
# two-touching-segment variant) -- not inferred or guessed. See
# NOTES.md in the output directory for how these were measured.
MOUNTAIN_SAMPLE_WIDTHS = (34, 43)
MOUNTAIN_SAMPLE_HEIGHTS = (12, 19)
MOUNTAIN_SAMPLE_AREAS = (112, 160)
MOUNTAIN_MAX_WIDTH = 1.2 * max(MOUNTAIN_SAMPLE_WIDTHS)    # "not more than 20% larger than either sample"
MOUNTAIN_MAX_HEIGHT = 1.2 * max(MOUNTAIN_SAMPLE_HEIGHTS)
# AREA ceiling too, not just width/height independently: a w/h-only bound
# let through components with up to ~1.44x either sample's actual ink
# area (1.2 * 1.2) as long as each dimension individually stayed under
# its own 1.2x cap -- confirmed as the exact gap that let a merged
# multi-letter cursive-script blob ("erbia", tail of "Kingdom of
# Serbia") through at area=566 against samples of 112/160. This is the
# more literal reading of "not more than 20% larger" anyway (one ceiling
# on actual drawn size, not two independent ones that compound).
MOUNTAIN_MAX_AREA = 1.2 * max(MOUNTAIN_SAMPLE_AREAS)
MOUNTAIN_MIN_AREA = 0.25 * min(MOUNTAIN_SAMPLE_AREAS)     # floor against antialiasing specks; not part of the 20% rule itself
MOUNTAIN_ANGLE_TOLERANCE = 20        # degrees off horizontal a component's own PCA major axis may sit (both legend samples measured within ~11 degrees)
# "Physical" ink (hachures, rivers, physical-feature-name text) is a
# lighter grey on this map; "political" ink (city/realm text, realm
# -border dashes, the compass arrow) is true black. Measured directly:
# every real hachure's darkest pixel was >=88; every confirmed text/
# border/arrow false positive's darkest pixel was <=29 -- a clean,
# bimodal split (see NOTES.md for the histogram), with this threshold
# sitting comfortably in the gap between the two clusters.
MOUNTAIN_MIN_GRAY_VALUE = 80

# -- City squares -------------------------------------------------------
# Measured from this map's own "Major City" legend-key square (13x13,
# area 166, fill ratio 0.98, mean gray 67.9) and cross-checked against a
# couple of isolated real city markers found directly (12x12, area
# ~143-144, mean 81.9-84.2). A solid filled square survives morphological
# OPENING (erode then dilate) with a kernel too big for any letter
# stroke or dash to survive -- opening also reconstructs the square's
# rough original shape, unlike plain erosion. This matters because most
# real city squares turned out to be TOUCHING their own city name's
# first letter (same "two different features fused by raw 8-connectivity"
# problem as the border/river case above), so a plain connected
# -components pass over the unmodified ink mask only found 3 of the real
# squares in isolation -- opening recovers the rest without needing to
# separately detect and discount the attached letter.
CITY_SQUARE_MIN_DIM = 8
CITY_SQUARE_MAX_DIM = 18
CITY_SQUARE_MAX_DIM_DELTA = 4         # |width - height| must be within this (roughly square, not a letter fragment)
CITY_SQUARE_MIN_AREA = 50
CITY_SQUARE_MIN_FILL_RATIO = 0.85
CITY_SQUARE_MAX_MEAN_GRAY = 95        # generous margin above the darkest/lightest real squares measured (67.9-84.2)
CITY_SQUARE_OPEN_KERNEL_PX = 7
# A square touching a thick coastline stroke (not just a letter) can
# survive the normal opening kernel fused with a sliver of that
# coastline -- oversized and under-filled as one blob. Confirmed
# directly on one real case (a square right against the Sea of Marmara
# coastline): re-opening just that one candidate's own local region with
# progressively stronger kernels peels the coastline sliver off and
# isolates the square cleanly (fill ratio 0.99) once the kernel is big
# enough. Only tried on candidates already in a plausible "oversized,
# probably fused" range, not applied blanket -- a stronger kernel would
# just as easily erase a real, smaller square entirely.
CITY_SQUARE_RESCUE_MAX_AREA_RATIO = 3.0   # a first-pass blob up to this many times CITY_SQUARE_MIN_AREA's upper neighborhood is worth retrying
CITY_SQUARE_RESCUE_KERNELS = (9, 11, 13, 15)
CITY_NAME_SEARCH_RADIUS = 55          # px -- ceiling distance from a city square to even consider text for its name; the real grouping is done by _grow_label_cluster below, not a blind per-fragment radius (see its own docstring for why)
CITY_NAME_GROW_GAP = 22               # px -- max bbox edge-to-edge gap for two text components to count as "the same label" when growing a name cluster from a square's nearest text (roughly the inter-word gap measured in this map's own political-text font)

# -- Realm map exclusion zones ------------------------------------------
# This map's own legend key and scale bar use political-black text too,
# and would otherwise read as "realm name" text just like a real one.
# Their positions are specific to THIS map image (not a general rule),
# (x0, y0, x1, y1) in source-image pixels. The title block used to be a
# third fixed bbox here too -- it's now found by OCR instead (see
# TITLE_* below), specifically so this file doesn't need to name its own
# words to recognize it.
LEGEND_BBOX = (30, 1080, 420, 1370)
SCALE_BAR_BBOX = (0, 1400, 1542, 1506)

# -- Title block (found by OCR, not hardcoded) ---------------------------
# TITLE_SEARCH_BBOX is only a SEARCH WINDOW -- a generous region where a
# title conventionally sits on a map like this (top-center) -- not an
# assertion about what's there or its exact bounds; OCR's own results
# determine the real boundary. Deliberately wide/tall enough to also
# catch neighboring, unrelated map labels (confirmed directly: this
# search window also picks up a physical-feature-name row above the
# real title), which is exactly why the detection logic below doesn't
# just trust "found some text in this box" -- see TITLE_CENTER_X_TOLERANCE.
TITLE_SEARCH_BBOX = (400, 0, 1300, 320)
TITLE_OCR_MIN_CONFIDENCE = 0.3        # easyocr's own per-box confidence; low-confidence noise is dropped before line-grouping
TITLE_LINE_Y_GROUP_TOLERANCE = 18     # px -- OCR boxes within this of each other in y are treated as the same line
# A real title block is recognized by shape, not content: multiple
# lines, STACKED, whose combined bounding boxes all share close to the
# same horizontal CENTER (a title is conventionally centered; an
# unrelated nearby label isn't centered on the same axis) -- confirmed
# directly against this map: three real title lines' own combined
# -bbox centers landed within a few px of each other, while an
# unrelated physical-feature-name row's center sat ~120px off and was
# correctly excluded.
TITLE_CENTER_X_TOLERANCE = 40         # px -- max center-x difference between consecutive lines to count as the same centered block
TITLE_MAX_LINE_GAP = 80               # px -- max vertical gap between consecutive centered lines to still count as one block
TITLE_MIN_LINES = 2                   # minimum consecutive centered lines required to call it a real title block
TITLE_MASK_PAD = 6                    # px -- padding around each OCR line box when building the title mask

# How close a border endpoint must be to the title block's own bounding
# box to be considered for the title-crossing reconnection below.
TITLE_BORDER_RECONNECT_RADIUS = 70
# Two endpoints crossing under one horizontal row of title text should
# sit at close to the same height -- caps how far apart in y two
# endpoints may be and still be considered the same crossing (see the
# reconnection function's own docstring for the real case this fixed).
TITLE_BORDER_MAX_Y_MISALIGNMENT = 30

MASK_DILATE_PX = 3           # structuring-element size for dilating a mask before inpainting, to cover antialiased fringes
INPAINT_RADIUS = 3           # cv2.inpaint's own neighborhood radius


def _component_crop_mask(labels: np.ndarray, label_id: int, x: int, y: int, w: int, h: int, pad: int = 2) -> np.ndarray:
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(labels.shape[1], x + w + pad), min(labels.shape[0], y + h + pad)
    return (labels[y0:y1, x0:x1] == label_id).astype(np.uint8) * 255


def _looks_like_island(labels: np.ndarray, stats_row, label_id: int) -> bool:
    x, y, w, h, area = stats_row
    bbox_area = w * h
    if bbox_area == 0:
        return False
    if area / bbox_area >= MAX_FILL_RATIO_FOR_HOLE_CHECK:
        return False
    crop = _component_crop_mask(labels, label_id, x, y, w, h)
    contours, hierarchy = cv2.findContours(crop, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return False
    for cnt, hinfo in zip(contours, hierarchy[0]):
        if hinfo[3] == -1:
            continue  # not a hole (child) contour
        hole_area = cv2.contourArea(cnt)
        if hole_area / bbox_area > HOLE_FRACTION_THRESHOLD:
            return True
    return False


def _pca_angle(labels: np.ndarray, label_id: int) -> float:
    """Angle (degrees, folded to (-90, 90]) of this component's own ink
    pixels' PCA major axis -- 0 is horizontal. Deliberately NOT
    cv2.minAreaRect's angle: that's the tightest bounding rectangle's own
    rotation, which for a shallow arc or chevron is frequently way off
    from the shape's actual visual tilt (see this module's docstring)."""
    pts = cv2.findNonZero((labels == label_id).astype(np.uint8)).reshape(-1, 2).astype(np.float64)
    centered = pts - pts.mean(axis=0)
    eigvals, eigvecs = np.linalg.eigh(np.cov(centered.T))
    major_axis = eigvecs[:, np.argmax(eigvals)]
    angle = np.degrees(np.arctan2(major_axis[1], major_axis[0]))
    angle = (angle + 180) % 180
    return angle - 180 if angle > 90 else angle


def _crossing_component_area(labels: np.ndarray, stats: np.ndarray, p1: np.ndarray, p2: np.ndarray, exclude_label_ids: set[int]) -> int:
    """Largest area of any OTHER ink component (not in exclude_label_ids)
    found near the midsection of the p1-p2 segment -- a real letter/text
    component actually sitting between two border-dash chain ends, as
    opposed to incidental antialiasing pixels. Sampled as a small
    neighborhood around several points along the middle 40% of the
    segment (skipping close to p1/p2 themselves, which are the dash ink
    being bridged FROM, not the interruption being bridged OVER)."""
    best_area = 0
    for t in np.linspace(0.3, 0.7, 9):
        point = p1 + (p2 - p1) * t
        xi, yi = int(round(point[0])), int(round(point[1]))
        y0, y1 = max(0, yi - 4), min(labels.shape[0], yi + 5)
        x0, x1 = max(0, xi - 4), min(labels.shape[1], xi + 5)
        for found_label in np.unique(labels[y0:y1, x0:x1]):
            if found_label != 0 and found_label not in exclude_label_ids:
                best_area = max(best_area, int(stats[found_label, 4]))
    return best_area


class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def _group_by_proximity(member_idx: set[int], centroids: np.ndarray, radius: float) -> list[list[int]]:
    """Groups a flat set of candidate-pool indices into connected chains
    by simple proximity (not a fresh chain-detection pass -- just enough
    to tell which already-accepted border components belong to the same
    physical line, so each line's own two endpoints can be found)."""
    members = list(member_idx)
    if not members:
        return []
    pts = centroids[members]
    dist = np.sqrt(((pts[:, None, :] - pts[None, :, :]) ** 2).sum(-1))
    adjacency = (dist > 0) & (dist <= radius)
    visited = [False] * len(members)
    groups = []
    for i in range(len(members)):
        if visited[i]:
            continue
        stack, component = [i], []
        visited[i] = True
        while stack:
            u = stack.pop()
            component.append(u)
            for v in np.nonzero(adjacency[u])[0]:
                if not visited[v]:
                    visited[v] = True
                    stack.append(v)
        groups.append([members[c] for c in component])
    return groups


def _chain_endpoints(chain: list[int], centroids: np.ndarray) -> list[int]:
    """The two (or one, for a singleton) candidate-pool indices in `chain`
    that sit furthest apart -- a simple but effective proxy for "the two
    ends of this line" given these chains are built to be thin and
    roughly linear, not meshy (branchy chains were already rejected
    before this is ever called)."""
    if len(chain) <= 1:
        return list(chain)
    pts = centroids[chain]
    dist = np.sqrt(((pts[:, None, :] - pts[None, :, :]) ** 2).sum(-1))
    i, j = np.unravel_index(np.argmax(dist), dist.shape)
    return [chain[i], chain[j]]


def classify_layers(ink_mask: np.ndarray, gray: np.ndarray) -> tuple[dict[str, np.ndarray], dict]:
    """Returns ({"text","border","mountain","other"} -> mask, stats_summary)."""
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(ink_mask, connectivity=8)

    other_mask = np.zeros_like(ink_mask, dtype=np.uint8)

    # Small-component candidate pool -- everything bigger is immediately "other" (big line art).
    cand_label_ids: list[int] = []
    cand_centroids: list[tuple[float, float]] = []
    cand_areas: list[int] = []
    for label_id in range(1, num_labels):
        x, y, w, h, area = stats[label_id]
        size_ok = MIN_TEXT_DIM <= max(w, h) <= MAX_TEXT_DIM and 3 <= area <= MAX_TEXT_AREA
        if not size_ok:
            other_mask[labels == label_id] = 255
            continue
        cand_label_ids.append(label_id)
        cand_centroids.append(tuple(centroids[label_id]))
        cand_areas.append(int(area))

    n = len(cand_label_ids)
    C = np.array(cand_centroids) if n else np.zeros((0, 2))
    AREA = np.array(cand_areas)
    dist = np.sqrt(((C[:, None, :] - C[None, :, :]) ** 2).sum(-1)) if n else np.zeros((0, 0))

    # -- pass 1: islands (run first, so a small closed loop never gets mistaken for a border chain) --
    island_idx: set[int] = set()
    for k in range(n):
        label_id = cand_label_ids[k]
        if _looks_like_island(labels, stats[label_id], label_id):
            island_idx.add(k)
    for k in island_idx:
        other_mask[labels == cand_label_ids[k]] = 255

    # -- pass 2: realm-border chains, over everything islands didn't claim --
    remaining = [k for k in range(n) if k not in island_idx]

    # pre-filter to dash-shaped, dash-shaded candidates before any chain/graph logic
    dash_like: list[int] = []
    for k in remaining:
        label_id = cand_label_ids[k]
        _, _, w, h, area = stats[label_id]
        major_dim = max(w, h)
        if not (DASH_MIN_AREA <= area <= DASH_MAX_AREA and DASH_MIN_MAJOR_DIM <= major_dim <= DASH_MAX_MAJOR_DIM and min(w, h) >= 3):
            continue
        mean_gray = gray[labels == label_id].mean()
        if DASH_MIN_MEAN_GRAY <= mean_gray <= DASH_MAX_MEAN_GRAY:
            dash_like.append(k)
    dash_like_set = np.zeros(n, dtype=bool)
    dash_like_set[dash_like] = True
    adjacency = (dist > 0) & (dist <= BORDER_LINK_RADIUS) & dash_like_set[:, None] & dash_like_set[None, :]

    # raw chains: connected components of the dash-proximity graph, each pruned of area outliers and branching
    raw_chains: list[list[int]] = []
    visited = np.zeros(n, dtype=bool)
    for start in dash_like:
        if visited[start]:
            continue
        stack, component = [start], []
        visited[start] = True
        while stack:
            u = stack.pop()
            component.append(u)
            for v in np.nonzero(adjacency[u])[0]:
                if not visited[v]:
                    visited[v] = True
                    stack.append(v)
        areas = AREA[component]
        median_area = np.median(areas)
        if median_area <= 0:
            continue
        pruned = [c for c, a in zip(component, areas) if max(a / median_area, median_area / max(a, 1)) <= BORDER_AREA_OUTLIER_RATIO]
        if not pruned:
            continue
        sub_adjacency = adjacency[np.ix_(pruned, pruned)]
        branchy_fraction = (sub_adjacency.sum(axis=1) >= 3).mean()
        if branchy_fraction <= BORDER_MAX_BRANCHY_FRACTION:
            raw_chains.append(pruned)

    # bridge raw chains across a real interrupting component (typically text)
    chain_points = [C[chain] for chain in raw_chains]
    chain_label_sets = [{cand_label_ids[k] for k in chain} for chain in raw_chains]
    uf = _UnionFind(len(raw_chains))
    for i in range(len(raw_chains)):
        if len(raw_chains[i]) < BRIDGE_MIN_RAW_CHAIN_LEN:
            continue
        for j in range(i + 1, len(raw_chains)):
            if len(raw_chains[j]) < BRIDGE_MIN_RAW_CHAIN_LEN:
                continue
            pairwise_dist = np.sqrt(((chain_points[i][:, None, :] - chain_points[j][None, :, :]) ** 2).sum(-1))
            nearest = np.unravel_index(np.argmin(pairwise_dist), pairwise_dist.shape)
            if pairwise_dist[nearest] > BRIDGE_MAX_GAP:
                continue
            p1, p2 = chain_points[i][nearest[0]], chain_points[j][nearest[1]]
            excluded = chain_label_sets[i] | chain_label_sets[j]
            if _crossing_component_area(labels, stats, p1, p2, excluded) >= MIN_CROSSING_COMPONENT_AREA:
                uf.union(i, j)

    merged_groups: dict[int, list[int]] = {}
    for i in range(len(raw_chains)):
        merged_groups.setdefault(uf.find(i), []).extend(raw_chains[i])

    border_idx: set[int] = set()
    for members in merged_groups.values():
        if len(members) < BORDER_MIN_NODES:
            continue
        pts = C[members]
        span = np.sqrt(((pts[:, None, :] - pts[None, :, :]) ** 2).sum(-1)).max() if len(members) > 1 else 0
        if span >= BORDER_MIN_SPAN:
            border_idx.update(members)

    # -- endpoint extension: reach for one more unclaimed dash-like candidate at a time --
    unclaimed_dash_like = [k for k in dash_like if k not in border_idx]
    extended_count = 0
    for chain in _group_by_proximity(border_idx, C, BORDER_LINK_RADIUS):
        for endpoint in _chain_endpoints(chain, C):
            current = endpoint
            for _ in range(MAX_EXTEND_STEPS):
                current_point = C[current]
                nearest_k, nearest_dist = None, None
                for k in unclaimed_dash_like:
                    if k in border_idx:
                        continue
                    d = float(np.linalg.norm(C[k] - current_point))
                    if d <= EXTEND_RADIUS and (nearest_dist is None or d < nearest_dist):
                        nearest_k, nearest_dist = k, d
                if nearest_k is None:
                    break
                border_idx.add(nearest_k)
                extended_count += 1
                current = nearest_k

    border_mask = np.zeros_like(ink_mask, dtype=np.uint8)
    for k in border_idx:
        border_mask[labels == cand_label_ids[k]] = 255

    # -- pass 3: mountain hachures, over what neither islands nor borders claimed --
    # Per the map's own drawing convention (see this module's docstring):
    # a hachure mark is a near-horizontal single stroke (occasionally two
    # touching segments, already one connected component by definition of
    # "touching"), sized within 20% of one of the two legend-key samples.
    remaining2 = [k for k in remaining if k not in border_idx]
    mountain_idx: set[int] = set()
    for k in remaining2:
        label_id = cand_label_ids[k]
        _, _, w, h, area = stats[label_id]
        if w > MOUNTAIN_MAX_WIDTH or h > MOUNTAIN_MAX_HEIGHT:
            continue
        if area > MOUNTAIN_MAX_AREA or area < MOUNTAIN_MIN_AREA:
            continue
        if abs(_pca_angle(labels, label_id)) > MOUNTAIN_ANGLE_TOLERANCE:
            continue
        if gray[labels == label_id].min() < MOUNTAIN_MIN_GRAY_VALUE:
            continue
        mountain_idx.add(k)

    mountain_mask = np.zeros_like(ink_mask, dtype=np.uint8)
    for k in mountain_idx:
        mountain_mask[labels == cand_label_ids[k]] = 255

    # -- endpoint diagnosis: explain each remaining dangling border endpoint --
    # Runs here (not earlier) specifically so it can check against the
    # now-final `other` and `mountain` layers -- per this map's own
    # drawing convention, a border is expected to sometimes have no
    # further separate ink once it meets a coastline/river or runs
    # through a mountain hachure field, which isn't the same thing as an
    # unexplained gap. See this module's docstring.
    height, width = ink_mask.shape
    endpoint_diagnostics = []
    for chain in _group_by_proximity(border_idx, C, BORDER_LINK_RADIUS):
        for endpoint in _chain_endpoints(chain, C):
            x, y = C[endpoint]
            if x < ENDPOINT_EDGE_MARGIN or x > width - ENDPOINT_EDGE_MARGIN or y < ENDPOINT_EDGE_MARGIN or y > height - ENDPOINT_EDGE_MARGIN:
                continue  # reaches the map edge -- a real, self-explaining endpoint
            r = ENDPOINT_FEATURE_SEARCH_RADIUS
            y0, y1 = max(0, int(y - r)), min(height, int(y + r))
            x0, x1 = max(0, int(x - r)), min(width, int(x + r))
            near_other = (other_mask[y0:y1, x0:x1] > 0).sum() > 20
            near_mountain = (mountain_mask[y0:y1, x0:x1] > 0).sum() > 10
            if near_other and near_mountain:
                likely_cause = "coastline_or_river_and_mountain"
            elif near_other:
                likely_cause = "coastline_or_river"
            elif near_mountain:
                likely_cause = "mountain_hachures"
            else:
                likely_cause = "unclear"
            endpoint_diagnostics.append({"x": int(x), "y": int(y), "likely_cause": likely_cause})

    # -- pass 4: whatever's left is text --
    text_idx = [k for k in remaining2 if k not in mountain_idx]
    text_mask = np.zeros_like(ink_mask, dtype=np.uint8)
    for k in text_idx:
        text_mask[labels == cand_label_ids[k]] = 255

    summary = {
        "total_ink_components": int(num_labels - 1),
        "small_candidate_components": n,
        "island_like_components": len(island_idx),
        "border_chain_components": len(border_idx),
        "border_dashes_recovered_by_extension": extended_count,
        "border_endpoint_diagnostics": endpoint_diagnostics,
        "mountain_like_components": len(mountain_idx),
        "text_components": len(text_idx),
        "text_ink_pixels": int((text_mask > 0).sum()),
        "border_ink_pixels": int((border_mask > 0).sum()),
        "mountain_ink_pixels": int((mountain_mask > 0).sum()),
        "other_ink_pixels": int((other_mask > 0).sum()),
    }
    return {"text": text_mask, "border": border_mask, "mountain": mountain_mask, "other": other_mask}, summary


def detect_title_block(img: np.ndarray, gray: np.ndarray, mountain_mask: np.ndarray, border_mask: np.ndarray) -> tuple[np.ndarray, tuple[int, int, int, int] | None, dict]:
    """Finds this map's own title block via real OCR (easyocr) -- NOT by
    matching known words (this map's own title text is never written
    into this file, deliberately, per instructions). Recognized by
    SHAPE instead: multiple lines, stacked, whose combined bounding
    boxes all share close to the same horizontal center -- a title is
    conventionally centered on the page; an incidental nearby map label
    isn't centered on that same axis. Confirmed directly against this
    map: three real title lines' own combined-bbox centers landed within
    a few px of each other, while an unrelated physical-feature-name row
    just above them (caught by the same search window) sat ~120px off
    and was correctly excluded by this rule alone.

    TITLE_SEARCH_BBOX is only a search window, cleaned of mountain
    hachures and border dashes (inpainted away first, per instructions)
    before OCR runs on it -- not an assertion about what's actually
    there. Returns (title_mask, title_bbox, debug_info); title_bbox is
    None if no qualifying centered multi-line block was found."""
    import easyocr  # local import -- only needed (and only installed) inside this job's own dedicated venv

    height, width = gray.shape
    x0, y0, x1, y1 = TITLE_SEARCH_BBOX
    x1, y1 = min(x1, width), min(y1, height)

    remove = mountain_mask[y0:y1, x0:x1] | border_mask[y0:y1, x0:x1]
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (MASK_DILATE_PX, MASK_DILATE_PX))
    remove = cv2.dilate(remove, kernel, iterations=1)
    cleaned_crop = cv2.inpaint(img[y0:y1, x0:x1], remove, INPAINT_RADIUS, cv2.INPAINT_TELEA)

    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    ocr_results = reader.readtext(cleaned_crop)

    boxes = []
    for bbox, _text, confidence in ocr_results:
        if confidence < TITLE_OCR_MIN_CONFIDENCE:
            continue
        xs = [point[0] for point in bbox]
        ys = [point[1] for point in bbox]
        boxes.append({"x0": x0 + min(xs), "x1": x0 + max(xs), "y0": y0 + min(ys), "y1": y0 + max(ys)})

    title_mask = np.zeros((height, width), dtype=np.uint8)
    debug_info = {"ocr_boxes_found": len(boxes), "lines_found": 0, "title_lines_used": 0}
    if not boxes:
        return title_mask, None, debug_info

    # group OCR boxes into lines by vertical proximity
    boxes.sort(key=lambda b: (b["y0"] + b["y1"]) / 2)
    lines = []
    for b in boxes:
        cy = (b["y0"] + b["y1"]) / 2
        for line in lines:
            if abs(cy - (line["y0"] + line["y1"]) / 2) <= TITLE_LINE_Y_GROUP_TOLERANCE:
                line["x0"], line["x1"] = min(line["x0"], b["x0"]), max(line["x1"], b["x1"])
                line["y0"], line["y1"] = min(line["y0"], b["y0"]), max(line["y1"], b["y1"])
                break
        else:
            lines.append(dict(b))
    lines.sort(key=lambda line: line["y0"])
    for line in lines:
        line["center_x"] = (line["x0"] + line["x1"]) / 2
    debug_info["lines_found"] = len(lines)

    # longest run of consecutive lines sharing a close horizontal center, reasonably spaced
    best_run: list[dict] = []
    current_run: list[dict] = []
    for line in lines:
        if current_run:
            prev = current_run[-1]
            same_center = abs(line["center_x"] - prev["center_x"]) <= TITLE_CENTER_X_TOLERANCE
            close_enough = (line["y0"] - prev["y1"]) <= TITLE_MAX_LINE_GAP
            if not (same_center and close_enough):
                if len(current_run) > len(best_run):
                    best_run = current_run
                current_run = []
        current_run.append(line)
    if len(current_run) > len(best_run):
        best_run = current_run
    debug_info["title_lines_used"] = len(best_run)

    if len(best_run) < TITLE_MIN_LINES:
        return title_mask, None, debug_info

    for line in best_run:
        lx0 = max(0, int(line["x0"] - TITLE_MASK_PAD))
        lx1 = min(width, int(line["x1"] + TITLE_MASK_PAD))
        ly0 = max(0, int(line["y0"] - TITLE_MASK_PAD))
        ly1 = min(height, int(line["y1"] + TITLE_MASK_PAD))
        region_ink = (gray[ly0:ly1, lx0:lx1] < INK_THRESHOLD).astype(np.uint8) * 255
        title_mask[ly0:ly1, lx0:lx1] = np.maximum(title_mask[ly0:ly1, lx0:lx1], region_ink)

    title_bbox = (
        int(min(line["x0"] for line in best_run)) - TITLE_MASK_PAD,
        int(min(line["y0"] for line in best_run)) - TITLE_MASK_PAD,
        int(max(line["x1"] for line in best_run)) + TITLE_MASK_PAD,
        int(max(line["y1"] for line in best_run)) + TITLE_MASK_PAD,
    )
    return title_mask, title_bbox, debug_info


def reconnect_border_across_title(border_mask: np.ndarray, title_mask: np.ndarray, title_bbox: tuple[int, int, int, int] | None) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """A border line can pass directly under/through the title block --
    confirmed directly: two border-chain endpoints were sitting right at
    the title block's own left/right edges, at the same height as its
    own text, with no ink in between (it's covered by the title's own
    letters, which are the SAME shade as the border -- both political
    black -- so unlike the river/mountain case earlier, shade can't
    separate them; there's no recoverable hidden dash ink to find here,
    only two real chains that genuinely stop where the title starts).

    Per instructions, this draws an EXPLICITLY APPROXIMATED connector
    between such a pair, styled as a dashed line matching the real
    border's own dash pitch -- returned as its own separate mask
    (`border_approximated_mask.png`), not silently merged into the
    "detected" border_mask, specifically so a reader of the outputs can
    always tell real detections apart from this interpolation. Returns
    (updated_border_mask, approximated_mask, connections) where
    connections is a list of endpoint-pairs for the report."""
    approximated_mask = np.zeros_like(border_mask)
    connections: list[dict] = []
    if title_bbox is None:
        return border_mask, approximated_mask, connections

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(border_mask, connectivity=8)
    if num_labels <= 1:
        return border_mask, approximated_mask, connections

    tx0, ty0, tx1, ty1 = title_bbox

    def dist_to_title_bbox(point: np.ndarray) -> float:
        dx = max(tx0 - point[0], 0, point[0] - tx1)
        dy = max(ty0 - point[1], 0, point[1] - ty1)
        return float(np.hypot(dx, dy))

    chains = _group_by_proximity(set(range(1, num_labels)), centroids, BORDER_LINK_RADIUS)
    candidate_endpoints = []
    for chain in chains:
        for endpoint in _chain_endpoints(chain, centroids):
            point = centroids[endpoint]
            if dist_to_title_bbox(point) <= TITLE_BORDER_RECONNECT_RADIUS:
                candidate_endpoints.append((endpoint, point, id(chain)))

    # Score every valid pair (same requirements as before -- different
    # chains, straddling the title, i.e. the midpoint actually falls
    # inside its bbox -- PLUS a close enough y-alignment to each other,
    # since a line crossing under one horizontal row of title text should
    # connect two endpoints at close to the same height, not just
    # whichever other endpoint happens to be nearest in raw distance.
    # Confirmed directly this second condition was needed: without it, a
    # naive greedy-nearest match on this map paired each of the two
    # correct (same-height, directly-under-the-text) endpoints with a
    # DIFFERENT, unrelated, lower chain instead of with each other,
    # because those happened to be individually closer -- a locally
    # -greedy but globally wrong pair of choices. Collecting and sorting
    # ALL valid pairs by distance first, instead of deciding per-endpoint
    # in whatever order they were discovered, fixes that.
    all_pairs = []
    for i in range(len(candidate_endpoints)):
        label_a, point_a, chain_a = candidate_endpoints[i]
        for j in range(i + 1, len(candidate_endpoints)):
            label_b, point_b, chain_b = candidate_endpoints[j]
            if chain_b == chain_a:
                continue
            if abs(float(point_a[1] - point_b[1])) > TITLE_BORDER_MAX_Y_MISALIGNMENT:
                continue
            midpoint = (point_a + point_b) / 2
            crosses_title = (tx0 - TITLE_MASK_PAD <= midpoint[0] <= tx1 + TITLE_MASK_PAD) and (ty0 - TITLE_MASK_PAD <= midpoint[1] <= ty1 + TITLE_MASK_PAD)
            if not crosses_title:
                continue
            d = float(np.linalg.norm(point_a - point_b))
            all_pairs.append((d, label_a, point_a, label_b, point_b))
    all_pairs.sort(key=lambda p: p[0])

    used = set()
    for _dist, label_a, point_a, label_b, point_b in all_pairs:
        if label_a in used or label_b in used:
            continue
        used.add(label_a)
        used.add(label_b)
        connections.append({"from": [round(float(point_a[0]), 1), round(float(point_a[1]), 1)], "to": [round(float(point_b[0]), 1), round(float(point_b[1]), 1)]})

        # draw an approximated dash-style line between the two endpoints
        segment = point_b - point_a
        length = float(np.linalg.norm(segment))
        if length < 1:
            continue
        direction = segment / length
        pitch = 20.0           # matches the real measured dash pitch (~19-22px)
        dash_fraction = 0.7    # leaves a visible gap, matching the real dash-dot style
        t = 0.0
        while t < length:
            seg_end = min(t + pitch * dash_fraction, length)
            p1 = point_a + direction * t
            p2 = point_a + direction * seg_end
            cv2.line(approximated_mask, (int(round(p1[0])), int(round(p1[1]))), (int(round(p2[0])), int(round(p2[1]))), 255, thickness=2)
            t += pitch

    if connections:
        updated_border_mask = border_mask | approximated_mask
    else:
        updated_border_mask = border_mask
    return updated_border_mask, approximated_mask, connections


def _is_city_square(x: int, y: int, w: int, h: int, area: int, mean_gray: float) -> bool:
    if not (CITY_SQUARE_MIN_DIM <= w <= CITY_SQUARE_MAX_DIM and CITY_SQUARE_MIN_DIM <= h <= CITY_SQUARE_MAX_DIM):
        return False
    if abs(int(w) - int(h)) > CITY_SQUARE_MAX_DIM_DELTA or area < CITY_SQUARE_MIN_AREA:
        return False
    if area / (w * h) < CITY_SQUARE_MIN_FILL_RATIO:
        return False
    return mean_gray <= CITY_SQUARE_MAX_MEAN_GRAY


def detect_city_squares(ink_mask: np.ndarray, gray: np.ndarray) -> list[dict]:
    """Finds the small solid "Major City" marker squares. Most of them
    TOUCH their own city name's first letter (same fused-by-raw
    -8-connectivity problem as the border/river case above), so a plain
    connected-components pass over the unmodified ink mask only finds a
    few in isolation -- morphological OPENING (erode then dilate with a
    kernel too big for any letter stroke or dash to survive) reconstructs
    each square's own rough shape while stripping the attached letter
    off, without needing to separately detect and discount it."""
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (CITY_SQUARE_OPEN_KERNEL_PX, CITY_SQUARE_OPEN_KERNEL_PX))
    opened = cv2.morphologyEx(ink_mask, cv2.MORPH_OPEN, kernel)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(opened, connectivity=8)
    squares = []
    rescue_max_area = CITY_SQUARE_RESCUE_MAX_AREA_RATIO * CITY_SQUARE_MAX_DIM * CITY_SQUARE_MAX_DIM
    for label_id in range(1, num_labels):
        x, y, w, h, area = (int(v) for v in stats[label_id])
        mean_gray = float(gray[labels == label_id].mean())
        if _is_city_square(x, y, w, h, area, mean_gray):
            squares.append({"x": x, "y": y, "w": w, "h": h})
            continue
        # a square fused with a thicker touching feature (a coastline, not
        # just a letter) can survive opening oversized/under-filled --
        # retry just this one candidate's own local region with
        # progressively stronger kernels before giving up on it
        if area > CITY_SQUARE_MAX_DIM * CITY_SQUARE_MAX_DIM and area <= rescue_max_area:
            pad = 6
            x0, y0 = max(0, x - pad), max(0, y - pad)
            x1, y1 = min(ink_mask.shape[1], x + w + pad), min(ink_mask.shape[0], y + h + pad)
            local_ink = ink_mask[y0:y1, x0:x1]
            for rescue_kernel_px in CITY_SQUARE_RESCUE_KERNELS:
                rescue_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (rescue_kernel_px, rescue_kernel_px))
                rescue_opened = cv2.morphologyEx(local_ink, cv2.MORPH_OPEN, rescue_kernel)
                r_num, r_labels, r_stats, _ = cv2.connectedComponentsWithStats(rescue_opened, connectivity=8)
                for r_label_id in range(1, r_num):
                    rx, ry, rw, rh, rarea = (int(v) for v in r_stats[r_label_id])
                    r_mean = float(gray[y0:y1, x0:x1][r_labels == r_label_id].mean())
                    if _is_city_square(rx, ry, rw, rh, rarea, r_mean):
                        squares.append({"x": x0 + rx, "y": y0 + ry, "w": rw, "h": rh})
                        break
                else:
                    continue
                break
    return squares


def _bbox_gap(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    """Edge-to-edge gap between two (x, y, w, h) boxes -- 0 if they
    overlap in both axes, else the straight-line distance between their
    nearest edges/corners."""
    ax0, ay0, ax1, ay1 = a[0], a[1], a[0] + a[2], a[1] + a[3]
    bx0, by0, bx1, by1 = b[0], b[1], b[0] + b[2], b[1] + b[3]
    dx = max(bx0 - ax1, ax0 - bx1, 0)
    dy = max(by0 - ay1, ay0 - by1, 0)
    return float(np.hypot(dx, dy))


def _grow_label_cluster(seed_label_id: int, text_labels: np.ndarray, text_stats: np.ndarray, gap_tolerance: float) -> set[int]:
    """Grows a set of text-component label ids outward from one seed,
    repeatedly adding any component within `gap_tolerance` (bbox
    edge-to-edge) of an already-included one -- i.e. "the rest of this
    same label" (its other letters, its other words), not a blind
    radius from a single point. Confirmed this is the fix a pure
    per-fragment radius check was missing: a wider font's own outer
    letters, or a second word in a multi-word label, can sit further
    than any reasonable single-point radius from a city square while
    still being unambiguously "the same name" by proximity to its own
    neighboring letters."""
    all_boxes = {label_id: tuple(int(v) for v in text_stats[label_id, :4]) for label_id in range(1, text_stats.shape[0])}
    cluster = {seed_label_id}
    frontier = [seed_label_id]
    while frontier:
        current = frontier.pop()
        current_box = all_boxes[current]
        for other_id, other_box in all_boxes.items():
            if other_id in cluster:
                continue
            if _bbox_gap(current_box, other_box) <= gap_tolerance:
                cluster.add(other_id)
                frontier.append(other_id)
    return cluster


def build_city_layer(img: np.ndarray, ink_mask: np.ndarray, gray: np.ndarray, layers: dict[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """Returns (city_square_mask, city_name_mask, city_squares) -- the
    squares themselves, the text ink judged to be each one's name, and
    the square list itself (for the report).

    Each name is found by: taking the single nearest text component to
    that square (within CITY_NAME_SEARCH_RADIUS, as a seed), then
    GROWING outward to include the rest of that same label (see
    _grow_label_cluster) -- not a blind per-fragment radius check, which
    was confirmed directly to both split a wider-font name across the
    radius boundary (its outer letters landing just past it) AND, in one
    case, wrongly pull a nearby but unrelated label's own word in simply
    because that one fragment happened to be the physically nearest
    thing to some other square."""
    height, width = ink_mask.shape
    squares = detect_city_squares(ink_mask, gray)

    city_square_mask = np.zeros((height, width), dtype=np.uint8)
    for sq in squares:
        city_square_mask[sq["y"]:sq["y"] + sq["h"], sq["x"]:sq["x"] + sq["w"]] = 255

    text_num_labels, text_labels, text_stats, text_centroids = cv2.connectedComponentsWithStats(layers["text"], connectivity=8)
    city_name_mask = np.zeros((height, width), dtype=np.uint8)
    claimed_label_ids: set[int] = set()
    for sq in squares:
        square_center = np.array([sq["x"] + sq["w"] / 2, sq["y"] + sq["h"] / 2])
        seed_id, seed_dist = None, None
        for label_id in range(1, text_num_labels):
            cx, cy = text_centroids[label_id]
            d = float(np.linalg.norm(np.array([cx, cy]) - square_center))
            if d <= CITY_NAME_SEARCH_RADIUS and (seed_dist is None or d < seed_dist):
                seed_id, seed_dist = label_id, d
        if seed_id is None:
            continue
        cluster = _grow_label_cluster(seed_id, text_labels, text_stats, CITY_NAME_GROW_GAP)
        claimed_label_ids |= cluster

    for label_id in claimed_label_ids:
        city_name_mask[text_labels == label_id] = 255

    return city_square_mask, city_name_mask, squares


def build_realm_text_layer(gray: np.ndarray, layers: dict[str, np.ndarray], city_name_mask: np.ndarray, title_mask: np.ndarray) -> np.ndarray:
    """Realm names use the same political-black, fancier font as city
    names (per direct report) -- so "realm text" is political-black text
    minus city names minus this map's own title (found by OCR, see
    detect_title_block) minus its legend/scale-bar (LEGEND_BBOX/
    SCALE_BAR_BBOX, fixed boxes specific to this one image, not a
    general rule). "Political" reuses the same darkest-pixel shade test
    the mountain pass already validated (a physical-feature-name label's
    own ink never goes below MOUNTAIN_MIN_GRAY_VALUE; political text
    always does)."""
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(layers["text"], connectivity=8)
    realm_mask = np.zeros_like(layers["text"])
    exclusion_zones = [LEGEND_BBOX, SCALE_BAR_BBOX]
    for label_id in range(1, num_labels):
        if gray[labels == label_id].min() >= MOUNTAIN_MIN_GRAY_VALUE:
            continue  # physical-feature-name text (gray), not political
        component = labels == label_id
        if (city_name_mask[component] > 0).any():
            continue  # already claimed as a city name
        if (title_mask[component] > 0).any():
            continue  # already claimed as title text
        cx, cy = centroids[label_id]
        if any(x0 <= cx <= x1 and y0 <= cy <= y1 for (x0, y0, x1, y1) in exclusion_zones):
            continue
        realm_mask[labels == label_id] = 255
    return realm_mask


def _isolate(img: np.ndarray, keep_mask: np.ndarray, remove_mask: np.ndarray) -> np.ndarray:
    """Inpaints away everything in remove_mask, leaving keep_mask's own
    pixels (and the flat background) untouched."""
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (MASK_DILATE_PX, MASK_DILATE_PX))
    dilated = cv2.dilate(remove_mask, kernel, iterations=1)
    return cv2.inpaint(img, dilated, INPAINT_RADIUS, cv2.INPAINT_TELEA)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(f"usage: {sys.argv[0]} <source_image> <output_dir>")
    source_path = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    output_dir.mkdir(parents=True, exist_ok=True)

    if not source_path.is_file():
        raise FileNotFoundError(f"source image not found: {source_path}")

    img = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"OpenCV could not read image: {source_path}")
    height, width = img.shape[:2]
    print(f"loaded {source_path.name}: {width}x{height}")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ink_mask = (gray < INK_THRESHOLD).astype(np.uint8)

    layers, summary = classify_layers(ink_mask, gray)
    print(f"layer classification: {summary}")

    # -- title block (OCR-found) + title-crossing border reconnection --
    print("running OCR for title detection ...")
    title_mask, title_bbox, title_debug = detect_title_block(img, gray, layers["mountain"], layers["border"])
    print(f"title detection: {title_debug} bbox={title_bbox}")
    layers["border"], approximated_border_mask, title_connections = reconnect_border_across_title(layers["border"], title_mask, title_bbox)
    print(f"title-crossing border connections approximated: {len(title_connections)}")
    layers["text"] = layers["text"] & ~title_mask
    layers["title"] = title_mask

    everything_else = {
        "text": lambda: layers["border"] | layers["mountain"] | layers["other"] | layers["title"],
        "border": lambda: layers["text"] | layers["mountain"] | layers["other"] | layers["title"],
        "mountain": lambda: layers["text"] | layers["border"] | layers["other"] | layers["title"],
        "title": lambda: layers["text"] | layers["border"] | layers["mountain"] | layers["other"],
    }
    outputs = ["text_mask.png", "debug_overlay.png", "extraction_report.json"]
    for name, mask in layers.items():
        cv2.imwrite(str(output_dir / f"{name}_mask.png"), mask)
    cv2.imwrite(str(output_dir / "border_approximated_mask.png"), approximated_border_mask)
    outputs.append("border_approximated_mask.png")

    for name, remove_fn in everything_else.items():
        isolated = _isolate(img, layers[name], remove_fn())
        assert isolated.shape[:2] == (height, width)
        filename = f"{name}_only.png"
        cv2.imwrite(str(output_dir / filename), isolated)
        outputs.append(filename)

    # kept for continuity with the first pass of this job: "non_text" = border + mountain + other + title, text removed
    non_text = _isolate(img, layers["border"] | layers["mountain"] | layers["other"] | layers["title"], layers["text"])
    cv2.imwrite(str(output_dir / "non_text.png"), non_text)
    outputs.append("non_text.png")

    debug_overlay = img.copy()
    debug_overlay[layers["text"] > 0] = (0, 0, 255)         # red (BGR) = text
    debug_overlay[layers["border"] > 0] = (0, 200, 0)       # green (BGR) = realm border (detected)
    debug_overlay[layers["mountain"] > 0] = (255, 0, 255)   # magenta (BGR) = mountain hachures
    debug_overlay[layers["other"] > 0] = (255, 0, 0)        # blue (BGR) = everything else
    debug_overlay[layers["title"] > 0] = (0, 255, 255)      # yellow (BGR) = title block
    debug_overlay[approximated_border_mask > 0] = (0, 140, 255)  # orange (BGR) = APPROXIMATED border connection (not detected ink)
    cv2.imwrite(str(output_dir / "debug_overlay.png"), debug_overlay)

    # -- city layer: squares + their name text --
    city_square_mask, city_name_mask, city_squares = build_city_layer(img, ink_mask, gray, layers)
    city_keep = city_square_mask | city_name_mask
    city_remove = layers["border"] | layers["mountain"] | layers["other"] | layers["title"] | (layers["text"] & ~city_name_mask)
    city_only = _isolate(img, city_keep, city_remove)
    assert city_only.shape[:2] == (height, width)
    cv2.imwrite(str(output_dir / "city_mask.png"), city_keep)
    cv2.imwrite(str(output_dir / "city_only.png"), city_only)
    outputs.extend(["city_mask.png", "city_only.png"])
    print(f"city squares detected: {len(city_squares)}")

    # -- realm map: border lines + realm-name text (built from the city layer above) --
    realm_text_mask = build_realm_text_layer(gray, layers, city_name_mask, layers["title"])
    realm_keep = layers["border"] | realm_text_mask
    realm_remove = layers["mountain"] | layers["other"] | layers["title"] | city_square_mask | (layers["text"] & ~realm_text_mask)
    realm_map = _isolate(img, realm_keep, realm_remove)
    assert realm_map.shape[:2] == (height, width)
    cv2.imwrite(str(output_dir / "realm_mask.png"), realm_keep)
    cv2.imwrite(str(output_dir / "realm_map.png"), realm_map)
    outputs.extend(["realm_mask.png", "realm_map.png"])

    report = {
        "source_image": str(source_path),
        "dimensions": {"width": width, "height": height},
        "params": {
            "ink_threshold": INK_THRESHOLD,
            "max_text_dim": MAX_TEXT_DIM,
            "min_text_dim": MIN_TEXT_DIM,
            "max_text_area": MAX_TEXT_AREA,
            "hole_fraction_threshold": HOLE_FRACTION_THRESHOLD,
            "max_fill_ratio_for_hole_check": MAX_FILL_RATIO_FOR_HOLE_CHECK,
            "dash_min_area": DASH_MIN_AREA,
            "dash_max_area": DASH_MAX_AREA,
            "dash_min_major_dim": DASH_MIN_MAJOR_DIM,
            "dash_max_major_dim": DASH_MAX_MAJOR_DIM,
            "dash_min_mean_gray": DASH_MIN_MEAN_GRAY,
            "dash_max_mean_gray": DASH_MAX_MEAN_GRAY,
            "border_link_radius": BORDER_LINK_RADIUS,
            "border_min_nodes": BORDER_MIN_NODES,
            "border_max_branchy_fraction": BORDER_MAX_BRANCHY_FRACTION,
            "border_min_span": BORDER_MIN_SPAN,
            "border_area_outlier_ratio": BORDER_AREA_OUTLIER_RATIO,
            "bridge_max_gap": BRIDGE_MAX_GAP,
            "bridge_min_raw_chain_len": BRIDGE_MIN_RAW_CHAIN_LEN,
            "min_crossing_component_area": MIN_CROSSING_COMPONENT_AREA,
            "mountain_sample_widths": MOUNTAIN_SAMPLE_WIDTHS,
            "mountain_sample_heights": MOUNTAIN_SAMPLE_HEIGHTS,
            "mountain_sample_areas": MOUNTAIN_SAMPLE_AREAS,
            "mountain_max_width": MOUNTAIN_MAX_WIDTH,
            "mountain_max_height": MOUNTAIN_MAX_HEIGHT,
            "mountain_max_area": MOUNTAIN_MAX_AREA,
            "mountain_min_area": MOUNTAIN_MIN_AREA,
            "mountain_angle_tolerance": MOUNTAIN_ANGLE_TOLERANCE,
            "mountain_min_gray_value": MOUNTAIN_MIN_GRAY_VALUE,
            "extend_radius": EXTEND_RADIUS,
            "max_extend_steps": MAX_EXTEND_STEPS,
            "endpoint_edge_margin": ENDPOINT_EDGE_MARGIN,
            "endpoint_feature_search_radius": ENDPOINT_FEATURE_SEARCH_RADIUS,
            "city_square_min_dim": CITY_SQUARE_MIN_DIM,
            "city_square_max_dim": CITY_SQUARE_MAX_DIM,
            "city_square_min_fill_ratio": CITY_SQUARE_MIN_FILL_RATIO,
            "city_square_max_mean_gray": CITY_SQUARE_MAX_MEAN_GRAY,
            "city_name_search_radius": CITY_NAME_SEARCH_RADIUS,
            "legend_bbox": LEGEND_BBOX,
            "scale_bar_bbox": SCALE_BAR_BBOX,
            "title_search_bbox": TITLE_SEARCH_BBOX,
            "title_ocr_min_confidence": TITLE_OCR_MIN_CONFIDENCE,
            "title_line_y_group_tolerance": TITLE_LINE_Y_GROUP_TOLERANCE,
            "title_center_x_tolerance": TITLE_CENTER_X_TOLERANCE,
            "title_max_line_gap": TITLE_MAX_LINE_GAP,
            "title_min_lines": TITLE_MIN_LINES,
            "title_border_reconnect_radius": TITLE_BORDER_RECONNECT_RADIUS,
            "title_border_max_y_misalignment": TITLE_BORDER_MAX_Y_MISALIGNMENT,
            "city_square_rescue_max_area_ratio": CITY_SQUARE_RESCUE_MAX_AREA_RATIO,
            "city_square_rescue_kernels": CITY_SQUARE_RESCUE_KERNELS,
            "city_name_grow_gap": CITY_NAME_GROW_GAP,
            "mask_dilate_px": MASK_DILATE_PX,
            "inpaint_radius": INPAINT_RADIUS,
        },
        "component_summary": summary,
        "city_squares": city_squares,
        "title_detection": {"bbox": title_bbox, **title_debug},
        "title_crossing_border_connections": title_connections,
        "outputs": outputs,
    }
    (output_dir / "extraction_report.json").write_text(json.dumps(report, indent=2))
    print(f"wrote outputs to {output_dir}")


main()
