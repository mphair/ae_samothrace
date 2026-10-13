# Cartography — domain knowledge

General, transferable knowledge about reading and digitizing
hand-/CAD-illustrated topographic site plans, learned while building
the Samothrace contour-extraction pipeline and the widgets that review
its output. This is written for *other* topographic-map-digitization
projects, not just as a recap of Samothrace trivia — each point below
is a convention or technique worth expecting on a *different* map,
with the specific Samothrace evidence that surfaced it kept as a
concrete example rather than the point itself.

This directory (`desk_domains/`) is new and currently holds only this
one file. It's meant to accumulate general subject-matter knowledge
discovered in the course of project work, as opposed to
project-specific implementation notes (which belong in the relevant
widget's own doc, plan doc, or code comments instead).

## Contour lines: index vs. minor, and why color is the wrong signal

Topographic plans conventionally draw two tiers of contour line at a
fixed interval ratio (commonly every 5th line is an "index" contour,
the rest "minor" / "intermediate") so a reader can count intervals
quickly without reading every single label. The *intended*
distinguishing signal between the two tiers, on a well-drafted plan, is
almost always **stroke width** (index lines drawn heavier) —
**not color**. Index contours are also conventionally the ones that
carry an elevation label; minor contours in between are usually
unlabeled and their elevation has to be *interpolated* from the
surrounding index lines' known values and the stated contour interval.

This matters enormously for automated extraction: on a scanned or
rasterized plan, color is the first signal you'll be tempted to key
on, and it's the first one that breaks — anti-aliasing, scan
compression artifacts, and overlapping ink all corrupt color far more
than they corrupt measured stroke width. On the Samothrace plans, the
working extraction pipeline (`scripts/extract_vector_layers.py`)
ultimately classifies index-vs-minor by measured line thickness in the
vectorized output, with OCR'd elevation labels used only to assign a
*value* to already-classified index lines, and linear interpolation
along connected minor-contour chains used to assign values to the
rest. Elevation provenance is tracked per-fragment as one of
`"ocr"` / `"review-confirmed"` / `"interpolated"`, not inferred fresh
every time — worth doing on any similar pipeline, since OCR confidence
and interpolation confidence are genuinely different kinds of
uncertainty and collapsing them loses information a human reviewer
would want back.

## Elevation labels break contour lines, and the gap is diagnostic

A drafted elevation label is conventionally placed directly *on* its
contour line with the line broken to make room for the text (sometimes
with small leader ticks bridging the gap), rather than floating beside
the line. Two consequences worth expecting on any similar plan:

- The break itself is a strong **index-contour detector** independent
  of stroke width: a minor contour with no label has no reason to ever
  have a gap in it, so "this traced line has a short, label-sized gap
  somewhere along its length" is a free second signal to cross-check
  stroke-width classification against.
- Those leader ticks (small stub marks bridging the label to the line)
  are exactly the kind of mark OCR tends to pick up as spurious extra
  characters or to merge into neighboring digits, producing
  OCR noise that's systematic (always near a label, always small,
  always near a line break) rather than random. A review UI that lets
  a human quickly accept/reject/correct individual OCR'd elevation
  values (this project's "Label Review" tab) is worth having for
  exactly this reason — don't expect OCR confidence thresholds alone
  to catch this class of error, since the misread is often a
  plausible-looking number, not obvious garbage.

## Streams and other watercourses: dashed, not solid

Watercourses (streams, seasonal drainage) on topographic plans are
conventionally drawn as a **dashed** line, often in blue, distinct from
the solid contour lines they cross. This is useful two ways in an
extraction pipeline: it's a cheap way to *exclude* watercourse ink from
contour extraction in the first place (dash pattern is a fairly
reliable discriminator from solid contour strokes), and — more
interesting — a stream's path is a legitimate **guide** for resolving
ambiguous contour connections, since contours and the watercourses that
cross them have a real geometric relationship (contours typically form
a "V" pointing upstream where they cross a stream). Samothrace's
Contour Connector tooling uses exactly this: a `stream-guided` category
of auto-suggested connection, alongside a simpler `auto-gap` (pure
nearest-endpoint) category, each tracked with its own suggestion source
so a human reviewer can tell which heuristic produced which
suggestion.

## Structures: hachures, stippling, and the ambiguity of "is this a wall"

Built structures (building footprints, walls, monument bases) on this
kind of plan are typically distinguished from bare terrain by fill
texture rather than outline alone — solid fill, hachure (short parallel
tick marks), or stippling (dots) are all conventional ways to indicate
"this polygon is a constructed surface, not ground," and different
symbol choices on the same plan can mean genuinely different things
(e.g. a *standing* wall vs. a *inferred/reconstructed* wall boundary
that's archaeologically uncertain) rather than just being inconsistent
drafting. Don't assume every closed polygon that looks like a
structure is drawn the same way, and don't assume a stippled boundary
is "the same kind of thing, just a different artist's pen."

Concretely: this project found that one feature (internally tracked as
fid 27, informally "South Nekropolis") used a stippled boundary
specifically because its status was more uncertain than the plan's
other, solid-boundary structures — which is exactly the kind of
semantic distinction that's invisible to a naive "fill the inside of
closed polygons" extraction rule and has to be special-cased
(`STRUCTURE_EXCLUSION_SKIP_FIDS` in the Samothrace pipeline).  More
generally: **structure fill/hachure patterns are themselves data**, not
just decoration to strip away before getting to the contours
underneath — budget review time for a human to confirm what each
distinct symbol actually means on a *given* plan, since it isn't
standardized across illustrators or even necessarily consistent within
one plan.

## Decorative/unclear symbols: don't force an interpretation you can't justify

Not every mark on a historical or hand-drafted plan has a legend entry,
and not every mark needs to be forced into a semantic bucket before a
pipeline can proceed. Samothrace's plans include a recurring
circle-chain motif whose precise archaeological meaning was never
pinned down with confidence; rather than guessing at a meaning and
risking silently-wrong classification, the pipeline detects it purely
structurally (as a geometric cluster of small circles meeting
calibrated size/spacing thresholds) and tags it as its own category,
leaving the *interpretation* of what it represents as an open question
for a human. The general lesson: when a symbol's meaning is genuinely
unclear, it is better for an automated pipeline to detect-and-flag by
shape than to force a semantic label that isn't actually justified by
available evidence — a false "we figured out what this symbol means"
is worse than an honest "unclear, flagged for review."

In the same spirit: this project never fully investigated what the
plans' outer border/frame lines (a neatline-style rectangular border
running around the whole drawn plan) are *for* beyond the obvious
"frame the page" — whether they encode anything like a coordinate grid
reference, a scale bar tie-in, or anything else conventionally found
inside a cartographic neatline was never checked. Flagging this
explicitly as **uninvestigated** rather than letting it quietly read as
"we looked and there's nothing there" — a border-fragment detector
(`find_border_frame_fragments`) exists in the pipeline purely to
*exclude* border ink from contour extraction, which is a different
and much lower bar than actually understanding what the border is for.

## Geometry + elevation as separate concerns, matching GIS convention

Storing each contour as a 2D polyline (lon/lat vertices) with elevation
kept as a separate scalar *attribute* on the feature — rather than
encoding elevation into the geometry itself as a Z coordinate — matches
the long-standing default behavior of mainstream contour-generation
tooling (e.g. GDAL's `gdal_contour`, which by default emits 2D
LineStrings with elevation as an attribute field, only emitting 3D
geometry if explicitly asked to). Matching that convention rather than
inventing a bespoke alternative paid off directly: it meant every
review/editing tool in this project (which all operate purely in 2D
screen/lon-lat space — see
`desk_widgets/samothrace-map/AGENTS.md`'s note on projecting geometry
to screen space at render time) never had to think about elevation at
all when doing geometric work like hit-testing or connection-dragging;
elevation only enters as a label to display and a value to assign, via
a clean `elevationM`/`elevationSource` pair of fields alongside the
plain 2D point list. Worth defaulting to on any similar project unless
there's a specific reason downstream tooling needs true 3D geometry.

## The general methodological takeaway

Across all of the above, the recurring shape of the problem is the
same: **a historical/hand-drafted plan's conventions are usually real
and usually legible, but the signal that actually carries the
convention is often not the one that looks easiest to extract
first** (stroke width beats color for index/minor; label-gap position
beats trying to parse the label text cleanly; dash pattern beats
spatial proximity for separating streams from contours; fill texture
is itself meaningful data, not noise to be stripped). When starting
extraction work on a new plan, it's worth deliberately inventorying
what visual conventions the *specific* plan actually uses before
picking which signal to key an automated detector on — and it's
equally worth explicitly flagging, rather than quietly resolving, any
symbol whose meaning isn't actually confirmed.
