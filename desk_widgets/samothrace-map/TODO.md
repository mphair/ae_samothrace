# Samothrace Map — known gaps / future work

See `AGENTS.md` for the full picture of this widget; this file just
tracks specific open items worth picking up later.

- **New "Restored State — Waterway" layer — a colorized, number-free
  derivative of the Restored plan's own "00 — Raw ink mask" pipeline
  -debug stage (2026-10-17, requested live: the user zoomed into that
  debug layer and liked "the detail... this sort of platform with
  these bridges that go over the waterways... the kind of lining
  that's along the waterways," asked for a real, permanent, named view
  built from it — numbers cleared out, waterway filled in blue, a
  "slightly faded blue... when it's going underneath a platform").**

  **Raster editing, not vector-line extraction** — the channel's own
  boundary ink is used to FLOOD-FILL the water area itself with a solid
  color (see `scripts/style_restored_waterway.py`'s own header comment
  for the full story), preserving the authentic hand-drawn "lining"
  texture — the fill's own edges land right where the real boundary ink
  was — a plain geojson line would lose. The Restored plan's own scan
  has ZERO
  saturated-blue ink anywhere (confirmed: its own `00_blue-mask.png` is
  100% white — the river was "cleared, bordered, and in places built
  over" in this interpretation, never printed in color) — asked the
  user whether to borrow Actual's own already-extracted stream path
  instead; they said no, the waterway's own linework is already clearly
  visible in Restored's own raw ink, use the Initial Map photo's own
  painted river only as a style/color reference and rough positional
  guide.

  **How the waterway's own ink is told apart from a similarly-drawn
  stone path** (confirmed directly: the channel's distinctive double
  -line-with-ticks "ladder" motif is ALSO used for paths elsewhere in
  the same drawing — not safely automatable by shape alone): the
  Initial Map photo is warped into the Restored mosaic's own pixel
  space (reusing `map-import-from-photo`'s own `corner_to_world`
  homography math, reimplemented rather than imported — same reasoning
  that job's own header comment gives), its blue pixels detected and
  dilated into a corridor, intersected with a THIN-STROKE-ONLY ink mask
  (`extract_vector_layers.py`'s own `classify_ink` — the same thin/
  thick split that pipeline already uses to keep contour lines separate
  from structure walls, reused here to keep building outlines from
  being swept in even where the corridor brushes against one).

  **Number-label erasure, a real, accepted compromise (no longer
  applied to the shipped output as of the same-day fix below — see
  that entry's own last paragraph)**: a building-ID
  digit and a decorative wall-ornament dot turn out to have nearly
  identical connected-component statistics in this raw scan (confirmed
  directly — building "20"'s own digit and a dot from building 29's own
  wall ornamentation differ by only a few px). Told apart instead by
  ISOLATION: a decorative dot is one of several similarly-sized
  components in a tight repeating row; a label is comparatively alone.
  Not perfect — some real numbers sitting close to another real number
  survive uncleaned, confirmed in spot checks (e.g. "9", "20", "28",
  "16", "14", "13", "25" all still visible in the shipped first pass).

  **Fixed, same day — the first version colored the ink, not the
  water.** The user tried it and came back: "I was looking to fill in
  the waterway itself, not color the ink blue... you're filling in the
  water rather than the boundaries of the water" — the shipped-first
  version had just recolored the channel's own boundary ink (the "rail"
  lines), leaving the water's own interior untouched. Fixed with a
  morphological CLOSING of the boundary-ink mask (`ndimage.
  binary_closing`, iterated 3×3 — `WATER_FILL_CLOSE_ITERATIONS`) that
  bridges the real gap between the channel's two rails (and across its
  own periodic tick marks) into one solid filled band — a deliberately
  different technique from a seeded flood-fill, which would leak
  straight through the many genuine gaps in this hand-drawn boundary
  ink with no guaranteed-closed outline to contain it. Capped back to
  the blue-paint corridor, with every known structure FOOTPRINT
  subtracted out (not just that structure's own wall ink — an empty
  room reachable through a narrow gap was bleeding fill into it during
  testing, confirmed directly in buildings 7 and 32's own small rooms,
  both just downhill of the main channel, before this was added).
  Originally also dropped the first version's "fainter blue going
  underneath a platform" distinction as a direct consequence — once
  every structure footprint had to be subtracted (to stop the
  interior-bleed above), the same geometric test could no longer tell
  "genuinely passing under a real bridge" apart from "merely adjacent to
  a building the closing step bridged past." **Restored 2026-10-18,
  directly requested again**: "I think include the water under the
  bridge, but in a much lighter shade so it is clear what is going on."
  Tried two different automatic ways to tell a real bridge apart from a
  merely-adjacent building first — overlap fraction (bridge area ÷ the
  structure's OWN total footprint) and a graph-connectivity test (does
  excluding this one structure split the water into more pieces) — and
  BOTH mis-classified a real, visually obvious bridge: building 26
  (Propylon of Ptolemy II), confirmed directly by eye (the channel
  enters one corner and exits the opposite one), scored low on both
  metrics because the crossing is a thin diagonal sliver of a large
  rectangular footprint, not a dead-center pass-through. Landed on a
  hand-maintained set instead (`BRIDGE_LABELS`, currently just `{"26"}`,
  confirmed by direct visual inspection) rather than keep chasing a
  classifier that doesn't actually work — expected to grow once the
  user's own green-circled bridge annotations (from their "circle
  generally around the bridges in green" pass) land as a real point
  stream. Structures in that set stay IN the fill (not subtracted at
  all) and get recolored at `WATER_ALPHA_UNDER_BRIDGE` (90, vs. 235 in
  the open) instead. The user also said they still don't see the numbers
  cleared and want to reconsider that approach separately — left
  completely alone this round (`find_label_regions` is still computed,
  just not applied to the output), not a regression, a deliberate "fix
  the water now, numbers later" split per their own request.

  **A real workflow gap, discovered 2026-10-18, fixed the same day**:
  the user came back with extensive, detailed annotation-tool markup
  (purple strokes on spots that should be filled, red circles on spots
  that shouldn't) and a long verbal walkthrough of each one — but by the
  time that recording stopped and this agent could look, the
  annotations were already gone. This was a direct, real consequence of
  the earlier "scope annotations to the recording's lifetime" fix
  (`recording.onChange` clears every stroke the instant `recordingId`
  goes back to `null`) colliding with a genuinely different use case
  than the one that fix was written for: marking something up *for the
  agent to look at afterward* needs the markup to survive at least long
  enough to be captured, which "cleared the instant the recording ends"
  didn't allow for.

  **The real fix, directly requested**: "those interactions should be
  recorded, not just in pixels, but as a timecoded stream of points" —
  the actual goal of this whole tool was always to let the user point
  at things precisely WHILE narrating, the same "what was said, while
  pointing at what" correlation `RecordingController`'s own header
  comment has described since phase 1. The gap was that drawing a
  stroke never called `recording.log(...)` at all — purely an in-memory/
  on-canvas thing until now. Fixed: `onPointerDown`'s own annotation
  branch logs `'ink-start'` (`color`, `x`, `y`, and the current `view` —
  once per stroke, not per point, since pan/zoom is locked for as long
  as annotating is possible at all, so one view snapshot covers the
  whole stroke and lets a later read of this log convert its screen-px
  points back to real lon/lat); `onPointerMove`'s own branch logs
  `'ink-point'` entries on a SEPARATE, coarser time-based throttle
  (`INK_LOG_THROTTLE_MS`, 300ms — deliberately coarser than the
  existing 2px-distance throttle that governs the drawn path's own
  visual smoothness, which would otherwise fire several times a second);
  `onPointerUp` logs `'ink-end'`; `clearAnnotations` logs `'ink-clear'`.
  Together these make a real, durable, timecoded point stream that
  survives regardless of whether the canvas itself ever gets
  screenshotted — `desk_query_widget_log` against this widget's own log,
  time-ranged against the transcript, now reconstructs exactly where the
  pointer was at each moment, the same way every other interaction this
  widget logs already does.

  **Also added, as a belt-and-suspenders safety net** ("just in case it
  is useful, take a screenshot immediately before clearing the ink"):
  `recording.onChange`'s own stop-handling now grabs one screenshot
  first, IF there was actually something inked, before wiping the
  slate — using two new fields, `lastRecordingId`/
  `lastRecordingStartedAtMs`, kept one step stale relative to
  `RecordingController`'s own copies specifically because
  `RecordingController` has already nulled ITS OWN copies by the time
  this callback runs (confirmed directly in its own stop-event
  handling) — this callback would otherwise have nothing to stamp the
  screenshot's filename/timecode with. `captureScreenshot` was split
  into a thin public wrapper (reads current state, used by the toolbar
  button) and `captureScreenshotFor(recordingId, elapsedMs)` (the actual
  work, callable with explicit values from either call site). Known,
  accepted quirk: `recording.log('screenshot', 'captured', ...)` inside
  that shared helper is ALSO a silent no-op for this specific call site
  (same already-nulled-state reason) — the screenshot file itself still
  gets written correctly, it just has no matching log entry; not worth
  fixing, the file's own existence is the record.

  **Improved anyway, same day, from a careful by-hand re-comparison**
  against the same Initial-Map-warped-onto-the-ink-mask reference image
  used to build the corridor in the first place (since the user's own
  markup wasn't recoverable, re-examining that reference critically was
  the best available substitute): found two concrete, fixable problems.
  (1) `WATER_FILL_CLOSE_ITERATIONS` of 10 left real, visible gaps WITHIN
  what should have been one continuous filled band (confirmed directly,
  zoomed in) — raised to 20, and the fill is no longer re-intersected
  with the corridor afterward (that re-intersection was itself
  reintroducing the corridor's own small internal gaps as holes in the
  output). (2) A small, fully-isolated blob near the "Chronology" legend
  area turned out to be a real, confirmed false positive — the warped
  Initial Map photo still carries its own legend swatches off to the
  side of the real river, and one of their colors occasionally trips the
  same blue-ink detector used to build the corridor. Fixed with a new
  `MIN_WATER_COMPONENT_PX` connected-component-size filter: a real
  channel segment is always part of one long connected run, so anything
  below 6000px that ends up fully disconnected from the main channel
  gets dropped. This likely accounts for at least some of what the user
  circled in red ("these three blobs... are not in the waterway") —
  without their own markup to check against directly, this can't be
  fully confirmed, which is exactly what the workflow-gap note above is
  about.

  **Known limitation**: one stretch of the left/western branch (south
  of the theater, near building 12) uses a different, single-row-of
  -dots ink convention instead of the "ladder" pattern used everywhere
  else — the flood-fill still reaches it (the closing step helps here
  too) but a bit more unevenly/blockier than the rest of the channel.

  **First real annotation pass actually captured end-to-end, 2026-10-18**
  (`rec-1792376622614-0883`) — third attempt at this; the first two were
  lost (feature didn't exist yet, then the widget hadn't reloaded to pick
  it up — see the workflow-gap entry above). This time `desk_query_widget_log`
  returned the full ink-point stream, so corrections came from the user's
  own precise markup instead of a guess. Converting the logged screen-px
  points into this script's own mosaic-pixel space meant reimplementing
  `samothrace-map.ts`'s exact `toScreen`/`projectWorld`/`unprojectWorld`
  math in reverse, with the canvas's CSS viewport size recovered from the
  pre-clear screenshot's own pixel size ÷ devicePixelRatio (2) — then
  SELF-VERIFIED (not just assumed correct) by projecting the green circle
  around structure 26 through the whole pipeline and checking it landed
  within ~30px of that structure's own independently-rasterized Overlay
  footprint. Four concrete fixes came out of it, all in
  `scripts/style_restored_waterway.py`: two hand-drawn RED loops force-
  excluded outright (water that was "just not correct... way off path",
  near structures 22/23 and structure 7); two ORANGE loops "tightened"
  against the user's own nearby PURPLE reference marks (fill kept only
  within `TIGHTEN_RADIUS_PX` of the true line inside each loop, dropped
  elsewhere in the loop); three GREEN-circled bridge crossings added as
  `MANUAL_BRIDGE_LOOPS_PX` (confirmed by cropping the raw ink mask at
  each one and finding the dotted-line-between-two-end-caps convention
  the user separately described — none of the three sits inside a mapped
  structure footprint, so they're free-standing hand-traced polygons, not
  `BRIDGE_LABELS` entries); and `BRIDGE_LABELS` itself reverted to empty
  — the user looked at structure 26 again and corrected themselves ("I
  think actually on that one there's no dotted line there... leave that
  one as a break"), confirmed directly against a crop showing no such
  convention there, unlike the three new manual bridges' own crops.
  A fourth green circle (between structures 13/14) was deliberately left
  unresolved — the user flagged their own uncertainty about it in the
  same breath as circling it, so it stays a plain break rather than being
  guessed at. See `style_restored_waterway.py`'s own header comment for
  the full calibration story and its "Known limitations" section for what
  this pass does and doesn't cover (the underlying corridor-tracing logic
  itself is unchanged — these are point corrections, not a general fix,
  so the same class of error can still show up anywhere not yet
  annotated).

  **Separately noticed while investigating this pass, not yet fixed**:
  `recording.onChange`'s stop-handling clears `annotationStrokes` directly
  (see the workflow-gap entry above) without going through
  `clearAnnotations()`, so no `'ink-clear'` log entry is ever written when
  a recording simply stops with ink still on screen (only the explicit
  "Clear" button path logs one). Harmless this round — the pre-clear
  screenshot plus the ink-point stream's own last `'ink-end'` timestamp
  were enough to reconstruct everything — but worth fixing for symmetry:
  a reader of this log currently can't tell "stroke ended" apart from
  "stroke ended AND the recording stopped right after" without also
  cross-referencing the recording's own stop time.

  **Second real annotation pass, same day** (`rec-1792386103334-1fcc`) —
  this time zoomed in much closer (the log's own `view.zoom` was 20, not
  18 — confirmed the screen↔mosaic conversion has to read zoom fresh per
  `ink-start` rather than assume the first pass's value). Found near
  structures 14/15: a stretch where the pipeline had filled the WRONG
  line entirely (almost certainly a nearby elevation contour caught by
  the blue-paint corridor) while the real channel, running right
  alongside it, was never filled at all — a different failure mode than
  anything the first pass surfaced. The user traced the real line
  directly in PURPLE across five paused-and-resumed strokes, circled the
  wrong line in RED, and circled a run of small boundary-marker dots
  flanking their own trace in YELLOW (confirms the trace is right,
  informational only — not acted on programmatically). Two fixes in
  `scripts/style_restored_waterway.py`: three more `EXCLUDE_LOOPS_PX`
  entries (the wrong line's own loop plus a small isolated blob next to
  it), and a brand new `FORCE_INCLUDE_SEGMENTS` mechanism — unlike every
  earlier correction, which corrects existing fill, there was nothing to
  correct here, just a gap to add, so the purple trace is unioned in
  directly as a buffered line (`FORCE_INCLUDE_HALF_WIDTH_PX`, picked from
  the existing channel's own measured typical half-width via
  `ndimage.distance_transform_edt`, not guessed). Two small leftover
  specks survived the first pass of this fix, both sitting at a concave
  pinch in the user's own hand-drawn loop boundary — the user had
  directly anticipated this ("I missed some corners and edges and
  things, but like, that's outside") — closed with two small
  supplementary rectangles rather than re-tracing the whole loop. Full
  story, including why this failure mode (filling a contour instead of
  the channel) is worth specifically checking for elsewhere, is in
  `style_restored_waterway.py`'s own header and "Known limitations".

  **Third pass, same day, a completely different technique** (`rec-1792387641944-c56b`)
  — instead of marking up what the pipeline got wrong again, the user
  turned the waterway layer off, looked at just the raw ink mask, and
  said: "put some spots, and in those spots you should be able to do a
  normal flood fill... move out from that blue spot... and keep growing
  that until it hits a line, or some other color besides white." A
  literal seeded flood fill, sidestepping the whole hard problem the
  corridor pipeline existed to solve (telling the channel's "ladder"
  convention apart from the same convention used for stone paths
  elsewhere, with no automatable shape signal). Directly requested as a
  **real, reusable installed job**, not a one-off script change: "please
  write something that can do that... build it into the installed job...
  call it painting technique." Built `desk-installed-jobs/
  painting-technique/main.py` — generalized over any line-art image +
  seed points, not hardcoded to Samothrace or to water (same "generalized
  over `<slug>`" convention `map-import-from-photo` already follows).
  Algorithm: `scipy.ndimage.label` on the INVERSE of the ink mask
  partitions the open area into connected components in one pass; a
  seed's fill is just "every pixel sharing that seed's component id" —
  equivalent to a real paint-bucket fill, computed without a hand-rolled
  pixel BFS. An optional closing pre-pass (off by default) bridges real
  gaps in hand-drawn boundary ink, same idea the old corridor pipeline's
  own closing step used.

  **Tested head-to-head against the old pipeline's hand-corrected output
  before adopting it, not assumed better**: raw (no closing) leaked
  catastrophically — 2.6M px filled, ~44% of the entire canvas — directly
  confirming why the original design avoided a seeded flood fill in the
  first place. Closing=1 barely helped (2.3M px); closing=2 fell off a
  cliff to ~101K px; 3 and 4 landed within a few hundred px of 2,
  confirming it wasn't a fragile right-at-the-edge value. Landed on 3.
  Visually re-verified against the EXACT trouble spots the old pipeline's
  hand corrections existed for (structures 22/23's wrong blob, structure
  7's wrong rooms, structures 14/15's missing-channel/wrong-contour
  error) — the new technique gets every one right, with ZERO hand
  -maintained corrections. Result: **rewrote `style_restored_waterway.py`
  wholesale** — `warp_initial_map_into_restored_px`/`detect_blue`/the
  whole corridor concept, plus every `EXCLUDE_LOOPS_PX`/`TIGHTEN_ZONES`/
  `FORCE_INCLUDE_SEGMENTS` hand correction from the two passes just
  above, are gone from the code entirely (kept only as history in this
  file and the script's own header). `SEED_POINTS_PX` holds the user's 7
  converted seed points; `BRIDGE_LABELS`/`MANUAL_BRIDGE_LOOPS_PX` carry
  over unchanged (a confirmed bridge is still a hard break by default
  under the new technique too — the flood fill can't cross a structure's
  own wall ink either — so the same "add the bridge region back in,
  recolor fainter" fix still applies, now unioned in explicitly rather
  than relying on a corridor-era closing step that happened to bridge
  the gap incidentally). Full story, including exactly why bridges behave
  differently now, is in the script's own header.

  Wired into `samothrace-map.ts` as a flat, lazily-loaded image (reusing
  `readFileAsBlobUrl`, same `desk.documents`-backed, same-origin-safe
  approach `StageLayersController` already uses for every pipeline
  -stage PNG — never at risk of the crossOrigin/canvas-tainting issue
  tile images needed `crossOrigin` for), drawn at its own real-world box
  exactly like `StageLayersController.drawVisible` already does.
  Deliberately NOT a `LayerMeta` (no hmsvc tile layer backs it) and NOT
  a `StageLayersController` row either (that mechanism is tightly
  coupled to the fixed 7-stage debug pipeline, off-by-default
  diagnostic content) — joins the "Restored State" layer-panel group
  instead, same injection pattern Extracted Contours already uses, same
  "real, session-confirmed map content" reasoning.

- **New "Regios" layer-panel category — translucent sanctuary-zone
  tints, starting with "Regio I" (2026-10-19, requested directly via
  recording, including the category's own name: "let's add some more
  layers. This next layer is the regio... there's a few regios on here
  that we're concerned with. For now, let's just talk about the first
  level main regio").** The underlying term had actually already
  surfaced once before, unrelated to this feature: fixing the
  Chronology-mask over-clip (see that entry above) found a "regio"
  arrow+label printed on the Initial Map photo, in the margin next to
  the legend — noticed then, acted on now.

  **How the boundary was built**: the user turned the Waterway layer OFF
  and looked at just the raw ink mask, then drew ONE long purple
  polyline tracing the Restored mosaic's own top, left, and bottom edges
  (and partway up the right edge) — explicitly NOT a closed loop by
  itself: "this purple line here, is the boundary of the first regio...
  the other boundaries... going up to the waterway there." A few GREEN
  marks confirmed different stretches of the Waterway as the remaining
  (northeast) edge; a handful of short purple "hash mark" strokes across
  the interior confirmed which side is "in" (not used programmatically,
  same confirmation-only role yellow dots played in an earlier Waterway
  annotation pass). "I would like it to smooth out that purple line so
  it's not so jagged" — the raw points are resampled to even arc-length
  spacing, then Gaussian-smoothed.

  **New script, `scripts/style_restored_regio.py`** — reuses
  `seeded_flood_fill` (same technique, same installed job,
  `desk-installed-jobs/painting-technique/`, as the Waterway layer's own
  2026-10-18 rewrite) with the barrier being the smoothed purple line
  UNIONED with the Waterway's own already-generated output PNG, flood
  -filled from one interior seed point. Sounds sealed; wasn't, three
  times, each found by actually running it and looking at the result
  rather than trusting the logic on paper:
  1. The polyline's own two ends don't touch the water (confirmed: ~22
     -32px short) — unclosed, 97% of the canvas filled on the first run.
     Fixed by snapping each endpoint to its exact nearest water pixel
     (`ndimage.distance_transform_edt`'s own `return_indices`).
  2. The Waterway isn't one connected shape — 4 separate components,
     split by both a genuine hard break and simple un-seeded stretches
     between two of the Waterway's own seed points. A first attempt
     plugged this with the FULL ink mask instead — technically sealed,
     but fragmented the interior into disconnected pockets a single seed
     couldn't reach (confirmed: several whole building clusters the
     user's own hash marks crossed came out unfilled). Replaced with a
     targeted bridge between water components under a measured distance
     threshold (a real gap in the clustering, not a guess: ~164-205px for
     genuine same-river gaps vs. ~778-946px for unrelated stretches).
  3. Nearest-pixel snapping doesn't always pick the RIGHT piece of water
     — the polyline's own start point snapped to a nearby branch (32px
     away) instead of the actual main channel (159px away, but what the
     user was standing next to when they started drawing). Confirmed
     directly: the main channel was never connected to anything, and the
     flood slipped around behind it, filling the entire northeast half
     of the map instead of just the southwest. Fixed by checking every
     water component against the WHOLE polyline, not just its two
     endpoints.

  Final visual check (not just a plausible pixel count) confirmed a
  clean southwest tint stopping exactly at the main channel, with
  structures 20/22/23/24/25/26/30 and the northeast terrain correctly
  excluded. Rendered at `REGIO_ALPHA` (64/255, "three-quarters
  transparent") in the purple the user actually drew with. Full story in
  that script's own header.

  Wired into `samothrace-map.ts` as `REGIO_LAYERS` — a real array, not
  one flat constant the way `WATERWAY_VIEW_*` is, since the user named
  this a category they expect to grow (`drawRegioLayers`/
  `loadRegioImage`/`loadRegioBounds`, keyed by id in
  `regioEntries`/`regioBounds` maps). Drawn in `redraw()` just before
  `drawWaterwayView` — underneath the Waterway's own more opaque blue
  wherever the two would otherwise overlap. Joins its own new "Regios"
  layer-panel group (not an hmsvc group, same "can't fall out of the
  main groups loop" treatment "Keys" already gets).

  **Known limitation**: the boundary line and bridge logic are specific
  to Regio I's own geometry (its polyline, its one interior seed) — a
  future Regio 2+ will need its own polyline/seed captured the same way,
  not a parameter on this one.

  **Corrected same day, a recording later** (`rec-1792398286794-268c`):
  "the regio also includes the area between the two rivers, the two
  waterways... [the branch past structures 20/22/23/24/25/26] is the
  actual eastern border of the regio" — the "clean stop at the main
  channel" above was itself wrong. The user drew BLUE approximately where
  the main channel and the branch connect, and YELLOW directly on the
  branch (confirming THAT one, not the main channel, is the real eastern
  edge). Root cause: `bridge_water_components`/
  `bridge_components_to_polyline` treated every water component as
  potential boundary material, including the main channel — exactly how
  it got sealed into the outer loop as a boundary in the first place.
  Fixed by excluding the main channel's own component (found by LABEL at
  a known reference point, `MAIN_CHANNEL_REFERENCE_PX`, not a hardcoded
  component number) from both bridging functions — with nothing sealing
  it anymore, the flood naturally wraps around both its ends into the
  between-rivers area, stopping only at the branch. Confirmed by a second
  visual check: structures 20/22/23/24/25/30 now correctly inside the
  tint, structure 26 and the terrain past the branch still correctly
  outside. Full story in the script's own header.

- **New "Keys" layer-panel category — the "Initial Map" photo's own
  printed Chronology legend, extracted (2026-10-17, requested live while
  trying out the new annotation tool: drew a purple box around it, "this
  part here, the chronology key, let's... extract that into its own
  layer... new category of layers, called keys... in the same spot, but
  not tied to the map").**

  **A genuinely new layer KIND, not a variant of the tile-layer system**:
  a printed legend has no real-world lon/lat of its own, so unlike every
  other layer in this widget it is never geo-projected/tiled — it's
  drawn at a FIXED canvas position instead (`drawKeyLayers`, bottom
  -right corner, cleared above `.zoom-controls`), same corner it
  occupied in the source photo. Deliberately still CANVAS-drawn (not a
  plain positioned `<img>`, which would've been simpler) for the same
  reason the annotation layer is: it composites into a screenshot for
  free, no special-casing needed in `captureScreenshot`.

  **Generalized, not hardcoded to "chronology"** — same "first of many
  such map data extractions" framing the whole `map-import-from-photo`
  job already carries. `transform.json` gains an optional `"keys"` list
  (axis-aligned boxes in the photo's own UNWARPED pixel space — simplest
  possible thing to specify, no homography involved since this runs
  before that's built): `desk-installed-jobs/map-import-from-photo/
  main.py`'s new `extract_keys()` does both halves of the job in one
  pass — crops each box to its own standalone
  `Data/mapSources/<slug>/keys/<id>.png`, AND flat-fills that same box
  (color sampled from just above it, not hardcoded white, so the cutout
  blends into the surrounding paper tone) on a COPY of the photo that
  actually gets warped/tiled, so the main raster doesn't show it twice.
  `desk_hmsvc/samothrace-tiles/service.py` gets a new
  `/key/<slug>/<id>.png` endpoint (same shape as the existing
  `/source/<slug>`) plus a new, fully self-discovering `keys` field on
  `/layers` (`_discover_keys()` scans every slug's own `transform.json`
  — a future second photo import's own keys need zero widget-side code
  changes to show up). The widget's own "Keys" `<details>` group in
  `buildLayersPanel` only renders at all if at least one key has ever
  been extracted anywhere — a complete no-op otherwise.

  **The exact crop box** — `(1180, 1570)` to `(1790, 2110)` in the
  source photo's own 1975×2262 pixel space — was determined by directly
  viewing `Data/mapSources/initial-map/source.jpg` and iterating a test
  crop (`PIL`) until the margins were clean, not by reconstructing the
  on-screen annotation the user actually drew (that would need inverting
  the full homography+CSS-transform math back from a specific screen
  rectangle at a specific pan/zoom to original photo pixels — doable
  with the exact same math `main.py` already has, but a materially
  bigger lift than just looking at the photo directly; worth considering
  if a FUTURE extraction wants "turn any annotation box into a crop
  region" as a real tool rather than an agent eyeballing it once).

  **Fixed, same day: the first mask was too generous.** The user came
  back after trying it (next recording) and asked to "restore the
  waterway, the arrow on the waterway, and... the little annotation with
  the arrow pointing out of the waterway with the label... and the top
  of this labeled square" — the single `(1180,1570)-(1790,2110)` box
  used for BOTH the key's own crop AND the main-raster mask happened to
  also swallow a real stretch of river, a "regio" arrow+label pointing
  at it, and the top edge of an unrelated "onimus" square, all sitting
  in the margin/gap around the actual legend text (the legend itself is
  an L-shape — a narrower title line, then a wider swatch block below a
  gap — not a clean rectangle, and the regio label happens to sit
  exactly in that gap). Fixed by generalizing `extract_keys()`: the
  single box is still what's CROPPED into the key's own thumbnail
  (unchanged — the user explicitly liked that part, "I like the
  extraction," so no reason to touch it), but what's MASKED off the main
  raster is now a separate, optional `maskBoxes` list — here, two
  tighter sub-rectangles (title line, swatch block) verified by directly
  masking the source photo locally and LOOKING at the result (not just
  eyeballing an outline overlaid on the original — a first attempt at
  tighter boxes, checked only by eye against an outline, still clipped
  letters at the bottom; the real fix came from iterating against the
  actual masked-and-cropped output each time). Verify any future
  `maskBoxes` change the same way: mask the real photo, crop the region
  in question, and look, don't just eyeball a rectangle on top of the
  unmasked original.

  **A real operational mistake worth flagging**: re-running the Python
  job required `desk_install_job` to re-approve it (source changed) and
  a fresh run via `desk_run_installed_job` — routine. But hmsvc itself
  needed a restart to pick up `service.py`'s own changes (same "a code
  edit doesn't auto-restart an already-running hmsvc" gap noted earlier
  this session), and the first attempt to fix that — `kill <pid>` on the
  live process, assuming Desk's own supervisor would relaunch it the way
  "supervises... and restarts for you" (`tempui-hmsvc.md`) suggested —
  did NOT auto-recover within ~35s of waiting. Recovered by directly
  launching `python3 -m desk.hmsvc_host <service-dir> <port> 127.0.0.1`
  using `desk-stable`'s own `.venv` interpreter (the one with `desk`
  actually importable) on the SAME port, which came back up seamlessly
  (zero widget-side disruption, since `serviceUrl` never changed). This
  likely leaves Desk's own Microservices widget showing this service as
  "crashed"/stale even though it's actually fine — a real Restart click
  there, whenever convenient, would reconcile that bookkeeping cleanly
  (fresh port, live `desk.state.changed` event, widget already listens
  for exactly that via `watchTileServiceState`). **Lesson for next
  time**: don't `kill` a running hmsvc process speculatively hoping for
  an auto-restart — there wasn't one within any reasonable wait, and
  recovering required knowing which Python environment actually has
  `desk` importable, which isn't obvious from `ps aux` alone.

- **A second "Keys" extraction source — the Restored plan's own printed
  compass indicator and scale bar** (2026-10-19, requested directly via
  recording: "there's a huge N here, and next to it there is an
  arrow over a... plus sign... those together are the compass
  indicator... I'd like to extract that out into its own layer, and I
  don't want that in the waterway layer that we're building...
  similarly, down below that, there is a distance key... I would also
  like that to be its own layer... I want them to be in keys... remain
  aligned to the spot").

  **Proved the "Keys" mechanism's own "fully self-discovering" design
  claim for real**, not just in the abstract: `scripts/
  extract_restored_keys.py` creates a brand-new `Data/mapSources/
  restored-plan/` slug (whose own `transform.json` has NOTHING but a
  `keys` list — no homography/photo-size fields, since nothing ever
  bakes this slug into real tiles) and needed ZERO changes to either
  `desk_hmsvc/samothrace-tiles/service.py` or this widget — confirmed
  live by curling a running hmsvc instance's own `/layers` endpoint
  directly and seeing both new keys already present, no restart
  required (unlike an actual code change, this is just new data files on
  disk, which `_discover_keys()` reads fresh on every call).

  **Crops directly from the Restored mosaic's own raw ink, not a
  photo**: `extract_keys()` (the original, `initial-map`-only version)
  crops from a PHOTO in its own unwarped pixel space, before any
  homography exists. The Restored plan has no equivalent photo — its own
  `.desk_temp/pipeline-stages/restored/00_raw-ink.png` (`scripts/
  extract_vector_layers.py`'s own output) IS already the final pixel
  grid, so this script crops directly from that instead, no warping
  needed either way.

  **Same generous-crop/tighter-mask split `extract_keys()` already
  established**, found the same way (crop, look at the actual masked
  -and-cropped result, iterate) — connected-component analysis was tried
  first to find the tight mask boxes automatically and failed the same
  way this project's other ink-classification problems have: both
  symbols sit close enough to real elevation-contour ink that
  8-connectivity merges them into one blob. `style_restored_waterway.py`
  gained `RESTORED_KEY_MASK_BOXES` (hand-maintained, duplicated rather
  than read from `restored-plan/transform.json` at runtime — same
  reasoning every other hand-derived geometry constant in that script
  already follows) and blanks both boxes out of its own `ink_mask`
  before anything else runs — confirmed directly: the compass/scale
  symbols are completely gone from the Waterway layer's own output, with
  only a couple of short, visually negligible contour-line stubs lost
  where they happened to cross through the (necessarily not-pixel
  -perfect) mask boxes, same trade-off the original Chronology fix
  already made peace with.

  **"Only a couple of negligible stubs" turned out to actually bother the
  user** — corrected the very next pass (rec-1792441616287-d4c4): "that
  last extraction of the compass and scale keys left some weird hanging
  situations here in terms of the... contour lines." Not a vector
  -contour problem (the unrelated "Extracted Contours"/Contour Connector
  system operates on a completely different dataset,
  `SamoWeb_RestoredStatePlan_Contours.geojson`'s own fragments, never
  touched by this layer) — purely a raster one: real contour lines the
  mask boxes had cut clean through, now dangling two stubs apiece.
  Traced by hand across each gap, PURPLE for ones the user called out as
  a "major" line and GREEN for "minor" ones (no actual rendering
  difference between the two — both just become ordinary ink, the colors
  were only about which real line the user was tracing). One purple
  attempt was disclaimed by the user mid-recording ("I don't think that
  was actually correct") and crossed out in red — excluded. A second red
  mark (a small square) flagged a genuinely stray ink fragment, confirmed
  directly: the compass's own crosshair bar ran slightly past the
  original mask box's left edge, so a connected-but-cropped piece of it
  was reading as an orphaned "contour" stub — fixed by widening that
  box's own left edge (2085→2065) rather than drawing a patch over it.
  New `CONTOUR_RECONNECT_SEGMENTS_PX` in `style_restored_waterway.py`
  (thin `CONTOUR_RECONNECT_WIDTH_PX`, matching real contour weight, NOT
  the thicker hand-drawn-annotation widths elsewhere in that file) folds
  the kept segments into `ink_mask` before composing. Confirmed directly:
  every contour line through both mask boxes now reads as one continuous
  curve, and the stray fragment is gone.

- **Recording-mode toolbar: timecoded screenshots + a quick annotation
  layer (2026-10-17).** A small 3-button toolbar, top-center over the
  map canvas, visible only while a recording is active (same
  `RecordingController.onChange` gating `.recording-indicator` already
  uses): **Screenshot now**, **Screenshot in 5s** (second click cancels
  the countdown instead of queuing another one), and an **Annotate**
  toggle (7-color pen palette + Clear, shown only while toggled on).

  **Confirmed with the user**: pan/zoom is deliberately DISABLED the
  whole time the annotation layer is toggled on (not "pinned to the
  map," not "fixed to the screen either" in the sense of tracking a view
  that can change — the view literally can't change while annotating).
  Guarded at the two canonical camera-mutating entry points,
  `zoomBy`/`fitToBounds`, rather than scattered across call sites — this
  transparently blocks the zoom buttons, wheel-zoom, "Show me" jumps,
  monument selection, and the home/Overview button with no
  special-casing needed. The pointer-drag pan is blocked separately, by
  a guard at the very top of `onPointerDown`/`onPointerMove`/
  `onPointerUp` that redirects to stroke-drawing instead. Because the
  view can't change while drawing, strokes are stored as plain
  screen-pixel coordinates (`{color, points: {x,y}[]}`) — no lon/lat
  projection math needed at all, unlike every other canvas-drawn layer
  in this widget.

  Annotations are drawn as one more layer directly on the shared
  `map-canvas` inside `redraw()` (`drawAnnotations`, last in the stack,
  gated on `annotationLayerOn` alone) rather than a separate overlay
  canvas, so a screenshot is just `this.canvas.toDataURL('image/png')`
  with nothing else to composite.

  **"Persistent" corrected, 2026-10-17, directly by the user**: the
  first version of this saved `annotationLayerOn`/`annotationStrokes`
  via `desk.self.getLocalStorage`/`setLocalStorage` (same blob `view`/
  `visibleLayers`/`collapsedGroups` live in), surviving a widget reload
  and even a later, unrelated recording. That's not what was meant —
  "persistent" meant "survives toggling off/on **for the duration of the
  current recording**," full stop. Now: `recording.onChange` clears
  `annotationStrokes`/`annotationDrawState` and forces `annotationLayerOn`
  back to `false` the instant `recordingId` goes back to `null` (pan/zoom
  unlocks again at the same moment, via the same flag `zoomBy`/
  `fitToBounds` already guard on) — neither field is saved to local
  storage at all any more, there being nothing left worth persisting past
  that point. "Clearable" still means the explicit Clear button can empty
  it early, before the recording itself ends.

  **A real, easy-to-miss bug fixed along the way**: `canvas.toDataURL()`
  throws a `SecurityError` on a "tainted" canvas — and the map's own
  tile images were already being tainting it, silently, before this
  feature ever existed, because `getTile()`'s `new Image()` never set
  `img.crossOrigin = 'anonymous'` before assigning `src` to a
  cross-origin hmsvc tile URL (a different port = a different origin,
  even though hmsvc's own `CORSMiddleware` already sends
  `Access-Control-Allow-Origin: *`, which allows the fetch but doesn't
  by itself keep a plain `<img>` load from tainting the canvas it's
  drawn onto). Fixed by setting `crossOrigin` unconditionally in
  `getTile()`, not just while screenshotting — this was a latent bug
  that happened to never matter until something actually called
  `toDataURL()`. The one other place this widget draws a bitmap onto the
  canvas, `StageLayersController`'s pipeline-stage snapshots, loads via
  a `blob:` URL (`desk.documents` + `URL.createObjectURL`), which is
  always same-origin and was never at risk.

  **A second, immediate fallout from that same `crossOrigin` fix**: the
  very next reload, the user reported Blank and Initial Map (whichever
  layers happened to already be sitting in the browser's own HTTP cache
  from earlier in the session) now failing with a real CORS error in the
  console, even though a live `curl -H "Origin: ..."` against the same
  tile URL (and its OPTIONS preflight) confirmed hmsvc's own
  `CORSMiddleware` was returning completely correct headers either way.
  Root cause: those exact tile URLs had already been cached by an
  earlier, plain (non-`crossorigin`) `<img>` load, with no CORS
  validation recorded against that cache entry — and because tiles are
  served `Cache-Control: ..., immutable` (`PNG_HEADERS`, service.py),
  the browser treats a cached entry as never needing revalidation,
  so re-requesting the SAME url in `crossorigin="anonymous"` mode hits
  that stale, mode-incompatible entry and fails outright instead of
  quietly re-fetching over the network. Fixed by giving `tileUrl()` a
  fixed `?e=1` cache-epoch marker (`TILE_CORS_CACHE_EPOCH`), so every
  tile request becomes a URL the browser has never cached under the old,
  incompatible mode — a one-time fix that covers every Desk session
  loading this updated code, not a manual cache-clear only the one user
  who hit it first would know to do. Bump this constant again if a
  similar crossOrigin/caching mismatch ever resurfaces.

  **`desk.fs.writeFile` is text-only** (confirmed against
  `desk-stable/src/desk/server/app.py`'s own `fs_write_file`: it calls
  Python's `Path.write_text(body.contents)`, which UTF-8-encodes a
  string) — there is no binary-write Bridge call a widget can use
  instead. So a screenshot is saved as a small self-contained `.html`
  file (`<img src="data:image/png;base64,...">`), not a real `.png` —
  directly double-click-viewable by a human with no decode tooling
  needed, and still trivially machine-extractable (grep the base64
  payload out, `base64 -d`) when an agent needs to look at one. Saved to
  `.desk_temp/samothrace-map-screenshots/<recordingId>/<mm-ss-mmm>.html`
  — `.desk_temp/` since this is ephemeral output (already fully
  gitignored), not `Data/`. The timecode matches
  `.desk_temp/timecoded-transcripts/<recording_id>.txt`'s own
  `[mm:ss.mmm]` convention (`RecordingController` gained a
  `recordingStartedAtMs` getter for this — it previously only tracked
  `activeRecordingId`, nothing needed `started_at_ms` before now).

  **Known, accepted gap**: the live `adjust-image-transform` `<img>`
  overlay (a real DOM element with a CSS 3D transform, not canvas-drawn)
  would NOT appear in a screenshot taken while it's visible — a narrow,
  rare overlap between two features added the same day, not worth
  solving now.

- **New "Initial Map" imagery layer, from a user-uploaded photo — now
  interactive, user-driven (2026-10-17, same day as the first,
  automatic-alignment attempt that didn't work well enough).** The user
  dropped a photo of a DIFFERENT, hand-annotated chronology plan of the
  sanctuary (own numbering scheme, black-ink identifications like
  "Diana"/"Palace"/"Hall of Dancers, summer festival" added on top of
  the printed building outlines/chronology key/north-arrow/scale-bar)
  and asked for it georeferenced and added as a 4th "imagery" radio
  option.

  **~~First attempt: automatic control-point/piecewise-affine
  georeferencing~~ — didn't work well enough, scrapped same day.**
  `desk-installed-jobs/samothrace-initial-map/` (now deleted) matched 11
  structures by shape/position, fit a global homography + a
  `skimage.transform.PiecewiseAffineTransform`, and baked the result
  automatically -- verified with small numeric residuals (worst ~11m
  across a ~250m scene) but the user's own live-eyes judgment was "it
  really didn't work very well." Direct lesson: small numeric residuals
  on hand-picked control points don't necessarily translate to a result
  that reads as correct by eye -- worth remembering before trusting a
  "the math checks out" result over direct visual feedback again.

  **Second approach, current: the USER aligns it, live, by eye.** No
  automatic control-point picking at all. The photo is imported with a
  simple initial guess (roughly the sanctuary's own real-world size,
  centered on it, zero rotation/tilt -- computed once from
  `SamoWeb_RestoredStatePlan_Overlay.geojson`'s own combined bounding
  box), then a new Agent Q&A question type,
  **`'adjust-image-transform'`** (`samothrace-map-agent-qa-tab.ts`),
  gives the user real interactive tools: a semi-transparent, draggable
  `<img>` overlaid directly on the map canvas (a real CSS 3D
  `transform`, not canvas-drawn -- the browser renders rotate/tilt/
  perspective natively, see `SamothraceMapElement.positionImageOverlay`)
  plus four live sliders (Rotation, Scale, Tilt X, Tilt Y -- "photo
  -angle distortion" as a genuine 3D camera tilt, confirmed directly
  with the user rather than a 2D approximation). Drag to reposition,
  adjust until it visually lines up against the real map underneath,
  then **Lock In**.

  **Exact math bridge, not an approximation of it**: a CSS 3D transform
  on a flat element is mathematically a real projective transform --
  the renamed, generalized installed job,
  **`desk-installed-jobs/map-import-from-photo/`**, reconstructs the
  IDENTICAL 4x4 matrix pipeline in Python (same composition order CSS
  itself uses) over the photo's own 4 corners, then
  `cv2.getPerspectiveTransform` (exact for 4 points, not a
  least-squares fit) + `cv2.warpPerspective` bakes EXACTLY what the user
  saw into real tiles. Full math in that job's own header comment.

  **Reusable data layout, not hardcoded to this one photo** (explicitly
  the first of a planned series): `Data/mapSources/<slug>/source.<ext>`
  + `Data/mapSources/<slug>/transform.json`
  (`{centerLon, centerLat, metersPerPhotoPx, userScale, rotateDeg,
  tiltXDeg, tiltYDeg, photoWidth, photoHeight}` -- zero-independent by
  design) -- both committed to source control. The job takes
  `{"slug": "..."}` via its own `config_path`, so a future import reuses
  it unchanged. `desk_hmsvc/samothrace-tiles/service.py` gets one more
  tiny endpoint, `/source/{slug}`, serving the raw photo so the overlay
  `<img>` has something to point its own `src` at (same reasoning every
  tile already goes through hmsvc instead of the widget reading file
  bytes itself over the Bridge API).

  **Lock In runs the bake live**: writes `transform.json`, writes the
  normal `AgentAnswer`, then calls
  `desk.installedJobs.run('map-import-from-photo', ...)` directly from
  the widget (new `installed_jobs` capability in `widget.json` +
  `Window.desk.installedJobs` in `samothrace-map-recording.ts`) --
  no agent round-trip needed for the common case. `transform.json` is
  ALREADY saved before that call regardless of how it goes -- nothing is
  lost even if the bake itself fails, the job can always be run again
  afterward. Tile URLs get a `?v=N` cache-buster per layer after a
  successful run (`SamothraceMapElement.bustTileCache`) since hmsvc's
  own tile responses are aggressively cached (`max-age=31536000,
  immutable`) -- without it the browser would keep serving pre-Lock-In
  tiles forever.

  **Found and fixed, 2026-10-17 — the first real Lock In's auto-bake
  silently failed.** The user locked in real values (rotateDeg -10,
  tiltYDeg -10, userScale 1.31, recentered) but the tile directory's own
  mtime stayed older than the answer -- `applyImageTransform`'s
  `config_path` only wrote `{"slug": ...}`, omitting `project_dir`,
  exactly the gap flagged (but left unverified) above: an Installed Job
  gets neither a reliable `cwd` nor a reliable `DESK_PROJECT_DIR`, so
  `map-import-from-photo`'s own `_project_dir_and_slug()` raised. The
  error was real but easy to miss in the moment -- `imageTransformError`
  does get set and rendered, but `startArchiving` fires right after
  regardless of `ok`, so the card (and its error line) animates away on
  the normal archive timer either way. Worked around for that one run by
  running the job directly via the agent-facing MCP tool with an
  explicit `project_dir`, which did produce correct tiles (spot-checked
  by fetching and stitching several zoom-19 tiles directly over HTTP --
  photo visibly rotated, hand annotations/chronology key/N
  arrow/scale bar all intact). **Root-cause fixed**: added
  `desk.self.getManifest()` to `Window.desk` (capability-free, returns
  `{directory: ...}` — confirmed against `desk/server/app.py`'s own
  `self_get_manifest` handler) and `applyImageTransform` now reads
  `manifest.directory` and includes it as `project_dir` in the written
  config, same shape the MCP-tool path already used successfully. Not
  yet re-exercised through a real Lock In click (no pointer-simulation
  tool available this session) — next real adjustment + Lock In should
  be watched to confirm the auto-bake actually completes now.

  **Known, accepted simplification**: Reset (from the archive drawer) on
  an answered `'adjust-image-transform'` question clears the answer and
  re-shows the adjustment card (a reasonable "redo this" action) but does
  NOT attempt to revert the tiles a previous Lock In already baked --
  there's no real "undo" concept for a generative bake without keeping a
  full history, not solved now.

  Wiring (both attempts, unchanged by the rewrite):
  `desk_hmsvc/samothrace-tiles/service.py`'s `RAW_LAYER_DIRS["initial-map"]`
  + `LAYERS` entry (group `"imagery"`, between `"blank"` and
  `"restored"`) -- no widget-side layer-panel changes needed, same
  reasoning as the "Blank" layer, the imagery radio group is already
  fully generic over whatever `/layers` returns.

- **Confirmed-connection lines ("amber and dashed") moved from
  always-on to a real layer toggle — 2026-10-17, requested by voice
  recording.** `ContourConnectorTabController.drawConfirmed()` used to
  draw every confirmed connection unconditionally, every redraw,
  regardless of tab — the only way to hide it was a "Show confirmed"
  checkbox local to the Connector tab's own toolbar (easy to miss, only
  usable while that tab happened to be open). Replaced with a proper
  layer-panel row, **"Confirmed Connections,"** in a brand-new
  **"User Changes"** group — both names taken directly from the
  recording ("there should be a new category which is like, user
  changes... one of those layers should be these expected ones or
  accepted ones"). `samothrace-map.ts`'s `buildLayersPanel` injects this
  group right between "Restored State" and "Pipeline (Topographic),"
  same position named in the recording; `ContourConnectorTabController.
  rowFor()` (new, parameterless — `confirmed` already spans both plans
  in one list, unlike `ContoursLayerController.rowFor`'s per-plan
  version) supplies the row. The old `showConfirmed` field, its
  checkbox, and its own `hitTestAll` gating are gone — `drawConfirmed`
  and `hitTestAll` both now check `visibleLayers.has('connector:confirmed')`
  directly, same mechanism (and same "can't select what you can't see"
  principle) every other layer kind in this widget already uses. Starts
  OFF by default (nothing seeds it into `visibleLayers` at init, same as
  every other non-hmsvc layer row) — matches "I would like them to not
  be always shown." The Connector tab's own "Show me" button on a
  confirmed-connection row now also auto-enables this layer first if
  it's off, same pattern `showMeContourFragments` already uses, so
  clicking "Show me" can't pan/zoom to a line that then doesn't actually
  render.

- **~~Investigate: a confirmed minor-band session-local override may not
  always be live.~~ Resolved 2026-10-16 — stale-instance artifact, not a
  bug.** Fragment 103 was confirmed (band-35-40-2, 36m, 2026-10-14) but
  hovered as "unlabeled" in a later recording (2026-10-16). After a fresh
  hmsvc restart + widget refresh, pixel-color-sampled the live render
  (same `#f59e0b` amber `effectiveColorFor` draws for an override, no
  pointer-simulation tool available to re-trigger the hover log directly)
  against independently-computed screen positions for all 7
  currently-confirmed override fragments (35/36/37/38/45/103/134) plus 8
  unconfirmed controls — amber present at every confirmed fragment,
  absent at every control. The mechanism works; the original symptom was
  a pre-restart stale widget instance. See
  `investigations/session-local-override-not-live.md` §6 for the full
  method and result.

- **Channel for the agent to apply corrections live, without per-item
  user confirmation — first slice shipped 2026-10-16.** Requested
  directly after the agent resolved the 134/89/45 minor-band
  fragmentation by hand-writing JSON into the two durable log files and
  telling the user to reload -- "you should have been able to have those
  changes show up in the UI immediately, as if I had confirmed it in an
  item in the Q/A tab." Built as "AgentPatchChannel," folded into
  `samothrace-map-agent-qa-tab.ts` (same file, same poll loop as the
  question/answer mechanism, since that tab is already the one visible
  place "the agent telling you something" shows up): an agent appends a
  `reason`-bearing patch (`'confirm-connection'` or
  `'confirm-minor-band'`) to
  `.desk_temp/samothrace-map-agent-patches.json`; the next poll writes
  the exact same durable-log shape a human's own Confirm click would
  (tagged `appliedBy: 'agent-autonomous'`), calls the same live-apply
  path, and acks into
  `.desk_temp/samothrace-map-agent-patches-applied.json`. Renders as a
  visible, timestamped "⚡ Applied automatically" row in the Q&A tab —
  deliberately not silent, per the investigation doc's own
  "visibility/trust" open question.

  **Open questions resolved for this first slice** (see
  `investigations/agent-autonomous-corrections-channel.md` for the
  reasoning): provenance via `appliedBy`, visibility via the always
  -visible "applied automatically" list (no camera pan, just an optional
  highlight flash if that spot happens to already be on screen), scope
  limited to the same two confirm-only actions the existing tabs already
  know how to apply (no reject/undo patch type).

  **Still open**:
  - Still polling (`AGENT_QA_POLL_INTERVAL_MS`), same unresolved FEEDBACK
    gap as the question/answer side of this file.
  - `investigations/session-local-override-not-live.md` (the thing this
    channel was flagged as amplifying) is now resolved — see that doc's
    own §6 — so that particular risk is cleared.
  - **~~Exercised with a real agent-authored patch~~ — done 2026-10-16
    night, via `rec-1792220036379-20fa`.** User flagged an already
    -confirmed connection (`restored-auto-gap-309`, fragment #92↔#62) as
    wrong — narration + hover correlation showed #92 should instead
    connect to #72. The correct #92↔#72 connection went in live via a
    real `'confirm-connection'` patch, confirmed end-to-end via a
    screenshot of the resulting "⚡ Applied automatically" card.

    This surfaced a real, concrete gap, not a hypothetical one — no patch
    type existed for RETRACTING an already-confirmed connection, only for
    adding one — and `restored-auto-gap-309` kept visibly branching off
    fragment #92 (a direct file edit removed it from
    `contour-connector-log.json` on disk, but `drawConfirmed()` draws
    straight from the already-running widget's own in-memory `confirmed`
    array, loaded at init, before that edit).

    **~~Patch type gap~~ — closed minutes later, same session, directly
    requested** ("Build a live retract-connection patch type now," picked
    from an explicit choice between that and just reloading). A third
    `AgentPatchType`, `'retract-connection'`, reuses
    `ConfirmConnectionQuestionData` as-is (kept whole, not trimmed to
    just `connectionId`/`plan`, so Undo-of-a-retraction can re-confirm
    the exact same connection symmetrically via
    `reverseAppliedDecision`'s new third branch) and calls the exact same
    `onUndoConnection` callback Undo already used — no new callback, no
    new wiring in `samothrace-map.ts` needed. `convertPatchToQuestion`
    maps it to the `'confirm-connection'` QUESTION type (there's no
    "should this be retracted" question, and by the time Undo runs the
    connection's already been re-confirmed, so "is this correct?" is the
    right follow-up). Real end-to-end gotcha hit applying the actual fix:
    the code change that ADDS `'retract-connection'` support itself marks
    the widget `[STALE]` — a `retract-connection` patch written before
    the user clicks that badge gets processed by the still-running OLD
    code, which doesn't recognize the type yet and logs it as an error
    (harmless -- once acked, errored or not, it's done; retried via a
    fresh patch with a new id after the reload, same "an agent that wants
    to retry writes a new patch" design already documented above).

  **~~No undo UI for an autonomously-applied minor-band confirmation~~
  — fixed same day, folded in before anything above got committed.**
  Requested directly after seeing the first version of this feature:
  *"I'd like to add an archive to the Q/A panel... With
  automatically-applied changes, instead of a confirm/reject, it should
  be ok/undo, and clicking undo should undo it and convert it into a
  question instead, so as not to lose the agent's change."* Scoped (the
  user's own explicit choice, offered three options) to **the Agent Q&A
  tab only** — Label Review/Minor Bands/Connector untouched.

  Applied-patch rows now get **OK / Undo** instead of plain text. OK
  archives the row. Undo reverses the live change —
  `ContourConnectorTabController.removeConfirmedById` (new; delegates to
  the same `removeConfirmed(idx)` the tab's own "Remove" button already
  calls) for a connection patch, `ContoursLayerController.
  clearFragmentElevationOverrides` (new; exact reverse of
  `setFragmentElevationOverrides`) plus a direct `MINOR_BAND_LOG_PATH`
  entry removal for a minor-band patch — then writes a fresh
  `AgentQuestion` carrying the original patch's own `data`/`reason` back
  into `AGENT_QUESTIONS_PATH`, so it reappears as an ordinary pending
  question. This required `'confirm-minor-band'` becoming a real
  first-class **question** type too (previously patch-only) —
  `AgentQuestion.data` is now `ConfirmConnectionQuestionData |
  ConfirmMinorBandPatchData`, `render()`/`answer()` branch per type.
  `applyConfirmMinorBandPatch` was generalized into
  `applyMinorBandDecision(data, decision, appliedBy?)` to serve both the
  patch-apply and the real-human-Confirm/Reject paths (reject writes a
  `'skipped'` answer, nothing visual to undo since nothing was ever
  applied).

  **Archiving**, same request's first half: once a question is
  answered or an applied-patch row is OK'd/undone, it shows a brief
  placeholder, then fades (3s) and collapses (0.5s) after a 5s hold, then
  stops rendering — via a CSS `@keyframes animation` (`qa-archive-away`
  in `widget.html`), deliberately NOT a `transition`, since this
  renderer's full-`innerHTML`-replace-on-every-change approach gives a
  `transition` no "previous style" to animate from on a freshly-created
  node. A question already answered the first time this tab loads (prior
  session, or a different instance) is pre-archived with no animation —
  only something resolved live, in THIS instance, gets the placeholder
  -then-fade treatment (see `seenAnsweredIds`'s own comment for the race
  this guards against: a poll landing between the durable write and the
  animation starting).

  **Known limitation, accepted rather than fixed**: if the whole panel
  re-renders for an unrelated reason (another patch/question arriving)
  while a row is mid-animation, that row's DOM node is recreated and the
  animation visually restarts from the top (the underlying removal timer
  still fires on its original schedule regardless) — this widget has no
  DOM diffing anywhere, full `innerHTML` replace is how every tab's
  `render()` already works, not worth building real diffing just for
  this. Rare in practice since a poll only triggers a re-render on an
  actual change, not every tick.

  **Archive drawer + Reset — added same day, directly requested right
  after archiving above landed.** A collapsed-by-default panel pinned
  toward the bottom of the tab (`renderArchiveDrawer`, slides open via a
  plain CSS `transition` on its own existing node, toggled by direct
  `classList` manipulation in `attachHandlers` rather than `onChanged()`)
  listing every archived question and `'ok'`-resolved applied-patch row,
  each with a **Reset** button. Reset undoes the original decision and
  returns the item to its main section: for a question, removes the
  `AgentAnswer` (and reverses whatever it applied, via the same
  `reverseAppliedDecision` helper Undo uses, if it was a confirm); for a
  patch, just clears the durable `resolution`/`resolvedAt` fields
  `AppliedPatch` now carries (added specifically so OK/archived-ness
  survives a reload — previously it was going to be in-memory-only,
  which would have meant "archived" patches reappearing fresh after every
  reload with no way back for an already-reset one). Sortable by question
  age (`createdAt`) or answer age (when resolved) via a `<select>`,
  default **ascending by answer age** (most-recently-resolved item
  first — "ascending age" = smallest elapsed time first, same "most
  recent first" convention the main question list already uses).
  `'undo'`-resolved patches are deliberately excluded from the drawer —
  their lineage continues via the question `convertPatchToQuestion`
  wrote, which becomes its own separately-archivable/resettable item once
  answered.

  This required reworking "archived" from a separately-tracked
  in-memory `Set` into a pure DERIVED status (answered-and-not-animating
  for a question; `resolution`-set-and-not-animating for a patch) — the
  old sets (`archivedQuestionIds`/`archivedPatchIds`/`seenAnsweredIds`)
  are gone. This is both simpler (no "have we seen this before" tracking
  needed) and more correct (durable for patches, survives a reload,
  which the old purely-in-memory approach never would have for Reset to
  work at all).

- **Investigate: proactive, unprompted efficiency suggestions.**
  Requested directly 2026-10-16: ways the agent could notice and flag
  pipeline/widget/MCP efficiency improvements on its own, the way the
  ~12s->~5.3s Actual-plan pipeline reduction only happened because the
  user happened to ask about it. See
  `investigations/proactive-efficiency-suggestions.md` for candidate
  mechanisms and open questions -- exploratory only, no design decided.

- **2026-10-15: added a "Pipeline (Topographic)" staged-reveal debug
  group** (`00 Restored raw` → `01 Structure footprints (ground truth)`
  → `02 Exclusion mask (buffered)` → the real "Topographic" imagery
  layer itself) — asked for directly, hovering a masked-out area on the
  new Restored-only Topographic layer and asking to see how it got that
  way, mirroring the existing Restored/Waterways pipeline-stage layers.
  Unlike those, these are **live hmsvc tile layers**
  (`desk_hmsvc/samothrace-tiles/service.py`'s new
  `_topographic_structures_raw_png`/`_topographic_structures_buffered_png`),
  not static per-mosaic PNGs — this computation is genuinely per-tile/
  per-zoom, so a one-shot batch snapshot would mean re-deriving it at one
  fixed zoom rather than showing what actually runs. `restored-plan-raw`
  (already existed, used internally by other standalone widgets) got a
  LAYERS entry here too, as stage 00, for the same "see the whole chain"
  reason. Widget side needed no new code beyond a `groupLabels` entry --
  `buildLayersPanel`'s group loop is already fully generic over whatever
  groups `/layers` returns.

- **2026-10-15: pipeline scope reduced to Restored + Actual's waterways
  only — done, documented here for the historical "why."** Measured
  directly that `extract_contours("actual", ...)` (structure/border
  /circle-chain exclusion, OCR, minor-banding) cost ~7.8s of the full
  ~12s two-plan run for output nothing downstream read any more — the
  only thing Restored's own processing genuinely needs FROM Actual is
  its dashed stream path (`suggest_stream_guided_connections`). Real
  re-run after the change: **5.3s** (both plans). `scripts/
  extract_vector_layers.py`'s `main()` now only runs Actual's mosaic
  load + `extract_streams`; Actual's own `*.Contours.{geojson,
  review_queue,minor_review_queue,connections.suggested}` are no longer
  written at all (deleted outright rather than left stale — see
  `AGENTS.md`'s own data-table note).

  Widget side, same change: the "Actual State" layer-panel category
  (Structures/Monuments/Extracted-contours checkboxes) is gone —
  `desk_hmsvc/samothrace-tiles/service.py`'s `LAYERS` no longer lists
  `actual-structures`/`actual-monuments` (the underlying tile
  computation/endpoint is untouched, since the standalone `topo-compare`
  widget still references `actual-structures` directly by hardcoded id —
  only the main widget's own panel lost the checkboxes). "Pipeline
  (Actual)" renamed to **"Pipeline (Waterways)"** and its stage list
  replaced wholesale — 3 new stages (`00 blue-mask`, `01 bridged`, `02
  stream-fragments`, via a new `save_stage_stream_fragments` drawing in
  the project's established stream-blue `#0ea5e9`) instead of the old
  7 contour stages, which no longer get computed for Actual at all.
  `samothrace-map-stage-layers.ts` now keys its stage-definition list
  per plan (`STAGE_DEFS_BY_PLAN`) instead of one shared list, since the
  two plans' own debug pipelines are now genuinely different, not just
  differently-named copies of each other.

  **Not touched, worth knowing**: Label/Minor Bands/Connector tabs still
  iterate `['actual', 'restored']` internally and will keep trying to
  load Actual's (now-deleted) queue/suggestion files — their existing
  try/catch-to-null fallback means this just silently shows nothing for
  Actual rather than erroring, but if Actual ever needs fully stripped
  out of those tabs too (not just made empty), that's a separate,
  not-yet-done follow-up.

- **Recording-log answers never reach the durable per-tab files.**
  Right now a Q&A answer goes to *either* the active recording's
  `desk.log` (while recording) *or* the durable per-tab file
  (`.desk_temp/contour-label-review-log.json`,
  `.desk_temp/minor-contour-review-log.json`,
  `.desk_temp/contour-connector-log.json`) — never both. The recording
  log is memory-only (cleared on Desk switch/quit), so an answer given
  while recording is genuinely lost if nothing folds it back before
  then. Fix: always write the answer to its durable per-tab file too,
  even when a recording is active and it's also going to
  `recording.log(...)`. See `plans/samothrace-map-consolidation.md`
  §5.2 and §8 for the fuller history of this gap.

- **~~Layer visibility and zoom/pan don't persist across a widget
  reload.~~ Fixed 2026-10-15.** View (lon/lat/zoom) and selection
  (`selectedWebCode`) now save to local storage too, debounced
  (`scheduleSaveUiState`, 400ms) and restored at init alongside layer
  visibility — all best-effort (a stale/malformed saved value is just
  skipped, never thrown) per explicit request. Falls back to the
  existing shared-state last-selected-monument / full-overview behavior
  only if nothing was saved locally yet (a brand-new instance).

  **~~Layer-category collapse/expand state didn't persist either~~ —
  fixed 2026-10-17, directly requested.** Each `<details class="layer
  -group">` section (Imagery, Restored State, Pipeline (Topographic),
  the two pipeline-stage groups) now saves/restores open-vs-closed the
  same way, via a new `collapsedGroups: Set<string>` field and the same
  `saveUiState()`/restore-block plumbing everything else above already
  uses. Keyed by a synthetic `hmsvc:<group>` / `stage:<group>` string
  (`data-group-key` on the `<details>` element), NOT the raw hmsvc
  `group` string alone — the hmsvc "restored" group (labelled "Restored
  State") and the stage-layers "restored" group (labelled "Pipeline
  (Restored)") share the same raw `group` value, and collapsing one
  would otherwise also collapse the other. Listens for the native
  `<details>` element's own `toggle` event (fires on both open and
  close, no custom click-handling needed) rather than inventing a
  separate interaction model. `syncGroupCollapse()` (new, mirrors the
  existing `syncLayerCheckboxes()` pattern) reconciles the DOM's `open`
  attribute against the restored set once `init()`'s localStorage read
  completes — `buildLayersPanel()` itself still renders every group
  `open` by default first (same "defaults, then reconcile" ordering
  `visibleLayers` already follows), so there's no new ordering
  dependency introduced into `init()`.

  Two real, pre-existing bugs turned up implementing this, both fixed
  alongside it:
  - Layer-visibility persistence already existed before this session but
    saved via a **blind `setLocalStorage({ visibleLayers: [...] })`
    overwrite**, not a read-modify-write — toggling a layer after
    `RecordingController` had minted its own `recordingLogId` into the
    same local-storage blob would have silently wiped that key, handing
    the recording log a fresh name (and losing continuity with any
    earlier log entries under the old name) on the next reload. All
    saves now go through one `saveUiState()` that reads-modifies-writes.
  - The saved-layers restore filter (`savedLayers.filter(...)`) only
    ever checked against `this.layerMetas` — which **only ever holds
    hmsvc-provided layers** (aerial/topographic/structures/monuments).
    A saved contours-layer or pipeline-stage-layer id was silently
    dropped on every single restore, pre-dating this session. Fixed via
    a proper `isKnownLayerId()` check spanning `layerMetas` +
    `contoursLayer.rowFor()` + `stageLayers.allLayerRows()`.

  Also added, same request ("if the microservice restarts, the widget
  should probably do so, as well"): `watchTileServiceState()` subscribes
  to `desk.state.changed` (same `events` channel `RecordingController`
  already uses — confirmed additive, doesn't disturb that subscription)
  and detects a genuinely new `samothrace-tiles` url (hmsvc gets a fresh
  random port every restart), refreshing `serviceUrl` +  re-fetching
  `/layers` + redrawing in place instead of silently pointing at a dead
  port until a human manually reloads the whole widget. `refreshLayerMeta`
  (the live-refresh path) preserves current layer visibility rather than
  resetting to defaults the way init-time `loadLayerMeta` does.

- **~~Hover isn't logged to the recording log — only click.~~ Fixed
  2026-10-13.** AGENTS.md describes the recording log as capturing
  "hover, click, layer toggle, Q&A answer, connector drag, all of it,"
  but `samothrace-map-contours-layer.ts` only called `recording.log(...)`
  from its click handler — plain pointing at a fragment while narrating
  left no trace at all. Confirmed this the hard way 2026-10-13: a ~3.5
  min recording where the user pointed at and described several specific
  contour fragments by voice ("this one", "that one", "this segment
  here") produced exactly one log entry total — the automatic
  layers-snapshot taken at recording start — because the user was
  hovering/pointing, not clicking, the whole time. Reconstructing which
  fragments were meant required manually reverse-engineering screen
  position from a post-hoc screenshot and cross-referencing candidate
  geometry — exactly the workflow this logging exists to avoid. Fix:
  `ContoursLayerController.updateHover` now starts a
  `HOVER_LOG_DWELL_MS` (400ms) timer on every hover-target change and
  logs a `'hover'` entry (same payload shape as `'click'`) if the
  pointer is still on that fragment when it fires — settled pointing
  gets logged, a fast sweep across many fragments doesn't flood the log.
  Monument hover (`samothrace-map.ts`'s own `hoverKey`) and the Contour
  Connector tab's hover (`samothrace-map-connector-tab.ts`) still don't
  log hover at all — same gap, just not hit by this particular incident
  since the recording had the contours layer active, not those. Worth
  the same treatment if it turns out to matter in practice.

- **Give the agent a way to ask a confirmable question through the Q&A
  panel, not just in chat text.** Concrete motivating case, 2026-10-13:
  after reconstructing a likely-intended fragment group from a recording
  (see the hover-logging item above), the agent needed to ask "is
  `band-35-40-3` (fragments 104/108/109/110, Restored plan) actually the
  spot you meant?" — and could only ask it as plain chat text, disconnected
  from the map itself.

  **First slice shipped 2026-10-13**: a fourth, leftmost/default Q&A tab
  — `AgentQaTabController` in `samothrace-map-agent-qa-tab.ts` — driven
  by a polled file pair
  (`.desk_temp/samothrace-map-agent-questions.json` /
  `.desk_temp/samothrace-map-agent-answers.json`, tied together by a
  question uuid) instead of a pipeline-written queue. Exactly one
  question type so far, `'confirm-connection'`: confirm/reject a
  suggested (or already-applied) Contour Connector connection without
  opening that tab — the real worked example being
  `restored-auto-gap-100` (see the gap-suggestion-instrumentation work
  earlier this session). A confirm/reject answer writes the same
  `LogConnection`/`LogRejection` shape into the Connector tab's own
  `CONNECTOR_LOG_PATH`, so the two tabs can't disagree about a
  connection's status, and `scripts/apply_contour_connections.py` keeps
  working unchanged. See `samothrace-map-agent-qa-tab.ts`'s own header
  comment for the full design, including why its writes are
  deliberately NOT gated by the recording-vs-durable split (the item
  above already flags that split as a real unfixed bug; this tab just
  doesn't reproduce it).

  **Still open**:
  - Only one question type exists. The original design questions this
    item started with — generality (a flat ad hoc list vs. injecting
    into whichever existing tab a question most resembles), and whether
    a second type should look structurally different — are still
    unresolved, just deferred until a second real question type shows up
    to design against instead of guessing.
  - Delivery is poll-based (`AGENT_QA_POLL_INTERVAL_MS`, 4s), because no
    Bridge capability exists for an agent to push into a running widget
    or for a widget to watch a file for changes. Wrote
    `FEEDBACK-DESK-agent-qa-file-polling-2026-10-13-1845.md` in
    `../../inadvisable-adventures/FEEDBACK/` proposing a real MCP tool
    pair to replace this.
  - No delivery/read confirmation back to the agent — it has to poll
    `samothrace-map-agent-answers.json` itself to find out whether/when
    a question got answered (same FEEDBACK report covers this).

- **`scripts/apply_minor_review.py` still doesn't exist** (known gap
  since before this widget, see `plans/samothrace-map-consolidation.md`
  §8) — a confirmed Minor Bands answer gets recorded correctly to
  `.desk_temp/minor-contour-review-log.json` but nothing folds it back
  into the real `*.geojson`'s `elevation_m`/`elevation_source` fields.
  2026-10-14 made this bite for real: confirming `band-35-40-0`,
  `band-35-40-1`, and `band-35-40-2` (fragments 35+103 — the connection
  confirmed earlier that session, merged into one logical contour — plus
  36/37/38, now 4 real contours instead of 5 raw fragments, matching the
  pipeline's own "exactly 4 well-separated members" auto-accept pattern)
  would otherwise have recorded correctly but stayed visually grey.
  Stopgap, same shape as `setConfirmedConnections`:
  `ContoursLayerController.setFragmentElevationOverrides` /
  `effectiveColorFor` session-locally force the confirmed color to amber,
  called by `MinorBandsTabController` both for a brand-new confirmation
  and (via `applyOverridesFor` in `init()`) for every answer already on
  disk, so a reload reflects prior confirmations too. Still only a
  color override, not a real elevation fix in the data a re-run of
  `extract_vector_layers.py` would see — the real apply script is still
  the actual fix needed here.
