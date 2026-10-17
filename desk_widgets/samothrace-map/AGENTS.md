# Samothrace Map — agent's guide

Written for a future Claude instance (or any agent) picking this widget
back up. This is the project's hub widget — per
`plans/samothrace-map-consolidation.md`, it absorbed what used to be five
separate widgets (TopoCompare, Minor Contour Review, Contour Label
Review, Pipeline Stage Viewer, Contour Connector) into one, on purpose.
Read that plan doc first for the *why* and the phase-by-phase history;
this doc is the *how* — what's actually in this directory, how to build
it, and the conventions/gotchas worth knowing before you touch it.

## This is a promoted widget — do not run `build_widget.py` on it

`desk_widgets/samothrace-map/` is **promoted** (its definition lives in
the project's own `.desk` file, not in a `.desk_temp/` `DefineWidget`
tempui file). Running `.desk_temp/build_widget.py` against this
directory produces a dead `DefineWidget` tempui file nobody should
click — promoted widgets aren't sourced from tempui files at all. (This
cost real time once already; see
`../../inadvisable-adventures/FEEDBACK/FEEDBACK-DESK-define-widget-placement-is-a-silent-second-step-*.md`
for the fuller story, though that report is about a different, related
gotcha — the two-step DefineWidget dance.)

**To check your edits compile**, just run `tsc` directly:

```
tsc -p desk_widgets/samothrace-map
```

**To actually see your changes live**, just save the files — Desk
watches `desk_widgets/<name>/` directly and marks the already-placed
instance `[STALE]` on its own; a human clicks that badge to trigger the
real rebuild and reload. You cannot trigger that reload yourself; you
can only confirm the source compiles.

## File manifest

Seven `.ts` files, compiled together as **one program** (`tsconfig.json`'s
`"files"` array, in this exact order — order matters for the
*compiled JS*, since these are global scripts with no `import`/`export`
and get concatenated in that order; it does **not** matter for *type
-checking*, which sees the whole program regardless of listed order):

1. **`samothrace-map-recording.ts`** — `RecordingController`. Wraps the
   `recording`/`stopped_recording` `desk.events` (Claude (Desk)'s record
   button) and the `desk.log` Bridge capability (a named, in-memory,
   agent-queryable log — see `tempui-widget-logs.md`). **Declares
   `Window.desk`'s entire Bridge-API shape in one place** — see the
   comment at the top of this file for why a second, partial
   `interface Window { desk?: ... }` in any other file doesn't work
   (TS requires every redeclaration of the same interface member to
   match exactly; it won't structurally merge two different inline
   object shapes for the same property). If a later phase needs a new
   Bridge capability, add it here, not in the file that uses it.

   **Why this exists at all**: recording is this widget's way of
   capturing *pointing* and other spatial-interaction data from the
   user, not just a generic activity log. While a recording is active,
   Desk is also writing a timecoded transcript of what the user says
   to `.desk_temp/timecoded-transcripts/<recording_id>.txt`. Every
   `this.recording.log(source, type, payload)` call this widget makes
   — hover, click, layer toggle, Q&A answer, connector drag, all of
   it — lands in `desk.log` with its own timestamp, in the same time
   base as that transcript. That pairing is the actual point: it lets
   a *future agent* reconstruct "the user said this, while pointing at
   that" after the fact, by lining up what the user was saying against
   where their cursor/clicks were on the map at the same moment —
   something neither the transcript nor the click log can convey
   alone. Concretely, this is what lets a user say something like "no,
   that one, the one near the stream bend" while moving the mouse, and
   have an agent reviewing the session afterward figure out which
   fragment "that one" actually meant. Keep this in mind when deciding
   whether a new interaction deserves a `recording.log(...)` call:
   the bar is "would knowing *where on the map* this happened, at
   *this moment*, help an agent reconstruct what the user meant,"
   not just "is this an event worth recording for its own sake."
2. **`samothrace-map-stage-layers.ts`** — `StageLayersController`. The
   pipeline-stage debug layers (14 of them: 7 stages × 2 plans), loaded
   lazily via `desk.documents` from `.desk_temp/pipeline-stages/<plan>/`.
3. **`samothrace-map-contours-layer.ts`** — `ContoursLayerController`.
   The real extracted contour fragments
   (`Data/mapFeatures/SamoWeb_<Plan>_Contours.geojson`), hover/click,
   the major/minor/unlabeled color palette, and the "Show me"
   highlight mechanism (`highlightFragments`/`strokeCandyCane`).
   `fragmentsFor(plan)` is the public entry point other controllers use
   to read the same already-loaded fragments without a second fetch.
4. **`samothrace-map-qa-panel.ts`** — `LabelReviewTabController` and
   `MinorBandsTabController`, the first two Q&A tabs.
5. **`samothrace-map-connector-tab.ts`** — `ContourConnectorTabController`,
   the third Q&A tab (drag-to-connect). Its confirmed-connections line
   (`drawConfirmed`, always drawn regardless of active tab) is, as of
   2026-10-17, gated behind its own layer-panel toggle — "Confirmed
   Connections," in a new "User Changes" group `samothrace-map.ts`'s own
   `buildLayersPanel` injects between "Restored State" and "Pipeline
   (Topographic)" (directly requested by name, via voice recording).
   `rowFor()` (parameterless, unlike `ContoursLayerController.rowFor`'s
   per-plan version — `confirmed` already spans both plans in one list)
   returns that row's id/label; replaces the tab's own former
   `showConfirmed` toggle, which only controlled visibility while
   sitting on this specific tab.
6. **`samothrace-map-agent-qa-tab.ts`** — `AgentQaTabController`, the
   fourth Q&A tab and the leftmost/default one. Unlike the other three
   (each driven by a pipeline-written queue file, loaded once at init),
   this one's questions are agent-authored at any time — appended with a
   uuid to `.desk_temp/samothrace-map-agent-questions.json`, polled
   (`AGENT_QA_POLL_INTERVAL_MS`, no Bridge file-watch capability exists
   yet — see the matching FEEDBACK report), answered into
   `.desk_temp/samothrace-map-agent-answers.json` keyed by that same
   uuid. Currently one question type, `'confirm-connection'` — confirm
   or reject a suggested (or already-applied) Contour Connector
   connection without opening that tab; a confirm/reject here writes the
   exact same `LogConnection`/`LogRejection` shape into that tab's own
   `CONNECTOR_LOG_PATH`, so the two tabs can never disagree about a
   connection's status. See that file's own header comment for the full
   story, including why its answer writes are deliberately NOT gated by
   the recording-vs-durable-file split every other tab uses (this
   widget's own `TODO.md` has the details).

   **Same file, a second mechanism (added 2026-10-16): AgentPatchChannel.**
   Not a question — no Confirm/Reject click. An agent that's already
   investigated and is confident appends a `reason`-bearing patch (one of
   `'confirm-connection'` / `'confirm-minor-band'`) to
   `.desk_temp/samothrace-map-agent-patches.json`; this tab applies it on
   the next poll — same durable-file write a human's own Confirm click
   would make (tagged `appliedBy: 'agent-autonomous'` on the written
   `LogConnection`/`MinorBandGroupAnswer` entry), same live-apply callback
   (`ContourConnectorTabController.applyExternalDecision` /
   `ContoursLayerController.setFragmentElevationOverrides`) — then acks
   into `.desk_temp/samothrace-map-agent-patches-applied.json`. Renders as
   a visible, timestamped "⚡ Applied automatically" row in this same tab
   (`renderAutoApplied`), with **OK / Undo** buttons instead of plain
   text — OK archives the row; Undo reverses the applied change
   (`ContourConnectorTabController.removeConfirmedById` /
   `ContoursLayerController.clearFragmentElevationOverrides`) and writes a
   brand-new pending question carrying the patch's own `data`/`reason`
   back into `AGENT_QUESTIONS_PATH` (`convertPatchToQuestion`), so nothing
   the agent found is lost, just handed back for a deliberate decision.
   `'confirm-minor-band'` is, as of the same addition, also a first-class
   QUESTION type (not just something Undo produces) — see
   `investigations/agent-autonomous-corrections-channel.md` for the full
   design reasoning.

   **A third patch type, `'retract-connection'`** (added 2026-10-17,
   same day, directly requested after a real — not hypothetical — gap
   showed up live: a user-caught wrong already-confirmed connection had
   no live retraction path). Reuses `ConfirmConnectionQuestionData`
   as-is and, on apply, calls the exact same `onUndoConnection` callback
   Undo already uses — no new wiring needed. `reverseAppliedDecision`'s
   own Undo-of-a-retraction branch re-confirms the same connection via
   `applyConfirmConnection`; `convertPatchToQuestion` maps it to the
   `'confirm-connection'` QUESTION type (there's no "should this be
   retracted" question — by the time Undo runs, the connection is
   already back).

   **A fourth question type, `'adjust-image-transform'`** (added
   2026-10-17, same day): interactive, not a yes/no judgment -- renders
   four live sliders (rotation/scale/two tilt axes) plus a draggable,
   semi-transparent `<img>` overlay positioned directly on the map
   canvas via a real CSS 3D `transform` (`SamothraceMapElement.
   positionImageOverlay`, not canvas-drawn), so a user can align an
   uploaded photo against the real map by eye, then "Lock In" to bake it
   via `desk-installed-jobs/map-import-from-photo/` (the exact math
   bridging the CSS preview to that job's own Python bake is documented
   in that job's own header comment). See this widget's own `TODO.md`
   for the fuller story, including the scrapped automatic-alignment
   attempt this replaced.

   **Archiving** (same addition): once a question is answered or an
   applied-patch row is resolved (OK/Undo), it shows a brief placeholder
   ("✓ Confirmed — archiving…" etc.), then — via a CSS `@keyframes`
   animation, not a `transition` (this renderer does a full `innerHTML`
   replace on every change, which a transition can't survive but a
   self-contained keyframe animation can) — fades out over 3s and
   collapses over 0.5s after an initial 5s hold, then stops rendering in
   the MAIN list. `QA_ARCHIVE_DELAY_MS` (the JS-side removal timer) and
   `widget.html`'s `qa-archive-away` keyframe percentages must be kept in
   sync by hand — see either one's own comment. "Archived" is a pure
   DERIVED status, not a separately-tracked flag — a question is archived
   once it has an answer and isn't mid-animation (`isQuestionResolved` +
   `archivingQuestions`); a patch row is archived once its durable
   `AppliedPatch.resolution` field is set (`'ok'` or `'undo'`) and isn't
   mid-animation. A question/patch already resolved the first time this
   tab loads (a prior session, or a different Desk instance) is simply
   already-archived from the first render, no animation — the animation
   is reserved for something resolved live.

   **Archive drawer** (added the same day, directly requested right
   after the above): a collapsed-by-default panel pinned toward the
   bottom of this tab (`renderArchiveDrawer`) listing every archived
   question and `'ok'`-resolved patch (an `'undo'`-resolved patch is
   excluded — its lineage continues via the question `convertPatchToQuestion`
   wrote, not as its own entry) with a **Reset** button each —
   `resetQuestion` removes the `AgentAnswer` (and reverses whatever it
   applied, via the same `reverseAppliedDecision` Undo uses, if it was a
   confirm); `resetPatch` just clears `resolution`/`resolvedAt`. Either
   way the item reappears in its main section. Sortable by question age
   (`createdAt`) or answer age (when resolved) — `ArchiveSortBy`, default
   `'answer-age'` ascending (most-recently-resolved first). The drawer's
   own open/close toggle is handled via direct `classList` manipulation
   in `attachHandlers`, not `onChanged()` — same "a transition needs an
   existing node, not a freshly re-rendered one" reasoning, except here
   the fix is a plain CSS `transition` since the node genuinely isn't
   recreated on toggle.
7. **`samothrace-map.ts`** — the custom element itself
   (`SamothraceMapElement`). Owns the canvas, the layer panel, the
   monument overlay (the original functionality, predating all of the
   above), and wires every controller above together.

   **Recording-mode toolbar: screenshots + an annotation layer**
   (2026-10-17). Top-center over the map, visible only while
   `this.recording.isRecording` (same `onChange` gating
   `.recording-indicator` already uses) — see `TODO.md`'s own entry for
   the fuller design story, including a real `canvas.toDataURL()`
   `SecurityError` bug this fixed along the way (`getTile()` now sets
   `img.crossOrigin = 'anonymous'` unconditionally). Short version:
   annotation strokes are plain screen-pixel coordinates (not lon/lat)
   because pan/zoom is deliberately disabled the whole time the layer is
   toggled on (`zoomBy`/`fitToBounds` both guard on `annotationLayerOn`);
   drawn as one more `redraw()` layer (`drawAnnotations`, last in the
   stack) so a screenshot is just the canvas's own pixels, nothing to
   composite. Screenshots save as self-contained base64-image `.html`
   files, not real `.png` — `desk.fs.writeFile` is text-only. Scoped
   STRICTLY to the current recording, not saved anywhere durable —
   `recording.onChange` clears every stroke and forces the layer back off
   the instant a recording stops (corrected 2026-10-17, see `TODO.md`'s
   own entry for the first version this replaced).

   **"Keys" layer-panel group** (2026-10-17, same day). A genuinely new
   layer KIND — not geo-projected/tiled like every other layer here,
   since a printed legend has no real-world lon/lat of its own. Drawn at
   a FIXED canvas position (`drawKeyLayers`, bottom-right, cleared above
   `.zoom-controls`) instead, last in `redraw()`'s stack (even after
   annotations) so a legend is never obscured — and still CANVAS-drawn
   rather than a positioned `<img>`, deliberately, so it composites into
   a screenshot for free too. `KeyLayerMeta` (own interface, NOT a
   `LayerMeta`) comes from `/layers`' new `keys` field, fully
   self-discovering across every slug's own `transform.json` — the panel
   group (`buildLayersPanel`) only renders at all if `keyLayers.length >
   0`. See `TODO.md`'s own entry for the full extraction story
   (`desk-installed-jobs/map-import-from-photo/`'s new `extract_keys()`)
   and a real operational lesson (don't `kill` a running hmsvc process
   hoping for an auto-restart).

`widget.html` holds the template markup + all CSS (one `<style>` block
inside the `<template>`); `widget.json` the manifest (keyword,
capabilities, state schema).

## Data this widget reads and writes

**2026-10-15: every `<Plan>`-templated row below is Restored-only in
practice now**, not literally both plans — `scripts/extract_vector_layers.py`
no longer runs the contour pipeline for Actual at all (only its mosaic +
stream/waterway extraction; see that script's own `main()` comment).
Actual's own `*.Contours.geojson`/`review_queue`/`minor_review_queue`/
`connections.suggested` files were deleted outright (no longer kept in
sync by anything) rather than left to go stale on disk. The path
TEMPLATES below are kept generic since nothing in the widget's own code
hardcodes "restored" for these reads -- Label/Minor/Connector will just
find nothing for `actual` and show Restored-only data.

| Path | Read/write | Notes |
|---|---|---|
| `Data/mapFeatures/SamoWeb_<Plan>_Overlay.geojson` | read | Monument polygons (pre-existing, not part of the consolidation work) |
| `Data/mapFeatures/SamoWeb_<Plan>_Contours.geojson` | read | Real extracted contours — `ContoursLayerController` |
| `.desk_temp/pipeline-stages/<plan>/NN_<stage>.png` + `bounds.json` | read | Pipeline debug snapshots — `StageLayersController`. `bounds.json` is written by `scripts/extract_vector_layers.py`'s `write_stage_bounds` (added alongside this widget; didn't exist before) |
| `Data/mapFeatures/SamoWeb_<Plan>_Contours.review_queue.json` | read | Label-review tab's question queue |
| `.desk_temp/contour-label-review-log.json` | read + write | Label-review tab's durable answers (shared with the old standalone widget — same shape, same file) |
| `Data/mapFeatures/SamoWeb_<Plan>_Contours.minor_review_queue.json` | read | Minor-bands tab's question queue |
| `.desk_temp/minor-contour-review-log.json` | read + write | Minor-bands tab's durable answers — **also written by** `AgentQaTabController` on a `'confirm-minor-band'` patch, same `MinorBandGroupAnswer` shape, `appliedBy: 'agent-autonomous'` tagged |
| `Data/mapFeatures/SamoWeb_<Plan>_Contours.connections.suggested.json` | read | Connector tab's suggestion source |
| `Data/mapFeatures/SamoWeb_<Plan>_Contours.connections.confirmed.json` | read | Connector tab's already-applied confirmations |
| `Data/mapFeatures/SamoWeb_ActualStatePlan_Streams.geojson` | read | Connector tab's stream-guide overlay (Actual plan's own streams, shown as a reference while working on the Restored plan) |
| `.desk_temp/contour-connector-log.json` | read + write | Connector tab's durable confirmations/rejections — **also written by** `AgentQaTabController` on a `'confirm-connection'` answer OR patch, same `LogConnection` shape either way (an autonomous patch's own entry additionally carries `appliedBy: 'agent-autonomous'`) |
| `.desk_temp/samothrace-map-agent-questions.json` | read | Agent Q&A tab's question queue — agent-authored, polled, not pipeline-written |
| `.desk_temp/samothrace-map-agent-answers.json` | read + write | Agent Q&A tab's durable answers, keyed by question uuid |
| `.desk_temp/samothrace-map-agent-patches.json` | read | AgentPatchChannel's patch queue — agent-authored, polled, applied live with no user confirmation |
| `.desk_temp/samothrace-map-agent-patches-applied.json` | read + write | AgentPatchChannel's ack log, keyed by patch uuid — append-only, never trimmed (`renderAutoApplied`'s own display cap only limits what's SHOWN, not what's kept) |
| `Data/mapSources/<slug>/transform.json` | write | `'adjust-image-transform'`'s own Lock In — the locked-in rotate/scale/tilt/position parameters; also read by `desk-installed-jobs/map-import-from-photo/` (a separate process, not this widget) |
| `desk.hmsvc.samothrace-tiles` (shared state, not a file) | read | Tile service URL discovery — **never hardcode the port**, it changes every launch |
| `<serviceUrl>/source/<slug>` (hmsvc HTTP, not `desk.fs`) | read | `'adjust-image-transform'`'s own live overlay `<img src>` — the raw uploaded photo, served by a small dedicated endpoint (not a tile) so the widget never has to shuttle binary image bytes through the Bridge API itself |
| `desk.installedJobs.run('map-import-from-photo', ...)` (Bridge, capability `installed_jobs`) | — | Triggered by Lock In to bake the locked-in transform into real tiles immediately — see `samothrace-map-recording.ts`'s own `Window.desk.installedJobs` |
| `desk.self.getManifest()` (Bridge, no capability needed) | read | Lock In's own `project_dir` for the job's `config_path` — an Installed Job gets neither a reliable `cwd` nor `DESK_PROJECT_DIR` (found the hard way 2026-10-17: the first real Lock In's auto-bake silently failed without this, see `TODO.md`) |
| `.desk_temp/samothrace-map-screenshots/<recordingId>/<mm-ss-mmm>.html` | write | Recording-mode toolbar's own "Screenshot now"/"Screenshot in 5s" — a self-contained base64-image HTML file (NOT a real `.png`; `desk.fs.writeFile` is text-only), timecoded the same `[mm:ss.mmm]` way the transcript file for the same `recordingId` already is |
| `Data/mapSources/<slug>/transform.json`'s own `keys` list | read | `extract_keys()`'s own input (a separate process, not this widget) — axis-aligned crop boxes, in the photo's own unwarped pixel space |
| `Data/mapSources/<slug>/keys/<id>.png` | write (job), read (hmsvc) | `extract_keys()`'s own output — never read directly by this widget, which only ever reaches it via `<serviceUrl>/key/<slug>/<id>.png` |
| `<serviceUrl>/key/<slug>/<id>.png` (hmsvc HTTP, not `desk.fs`) | read | The "Keys" layer-panel group's own canvas-drawn image source (`getKeyImage`/`drawKeyLayers`) — same reasoning `/source/<slug>` already documents for `/tiles/...` |

## Key conventions — follow these, don't reinvent them

- **Geometry lives in lon/lat, projected to screen space at draw/hit
  -test time, never stored pre-projected.** `this.toScreen` (an
  arrow-field on `SamothraceMapElement`, so it can be passed directly as
  a callback without losing its `this` binding) is the one projection
  function; every controller's `draw()`/`hitTest()` takes it as a
  parameter rather than reimplementing projection math.
- **`visibleLayers: Set<string>`** is shared across every layer kind
  (hmsvc tile layers, pipeline-stage layers, the contours layer) — the
  only thing keeping them from colliding is an id *prefix* convention
  (`stage:<plan>:<NN>`, `contours:<plan>`, vs. a bare hmsvc id like
  `"aerial"`). `onLayerToggle` is fully generic over all of them; don't
  special-case a layer kind there unless it genuinely needs different
  persistence/logging behavior.
- **Position-keyed persistence, not array-index-keyed.** Every durable
  answer file stores lon/lat (or a `reviewId`/`groupId`/`connectionId`
  string), never a bare array index into some `*.geojson` — array
  indices shift across pipeline re-runs. This bit the project hard
  before this widget existed; don't regress it.
- **Three-shade contour palette**, kept in sync across this widget,
  the (now-retired but still-present) standalone widgets, and
  `scripts/extract_vector_layers.py`'s own stage-PNG rendering:
  `#c026d3` major (index, `elevation_source` is `"ocr"` or
  `"review-confirmed"`), `#f59e0b` minor (`"interpolated"`), `#94a3b8`
  unlabeled. If you add a fourth category, update all three places.
- **Candy-cane (alternating two-color, no-gap) strokes** for anything
  that needs to read clearly over an unpredictable base layer — a solid
  color (tried first, both for "Show me" and for hover) didn't always
  show up well. `strokeCandyCane` in `samothrace-map-contours-layer.ts`
  is the shared implementation (same path drawn twice, second pass's
  dash offset shifted by one segment). Red/white for the "Show me"
  highlight, blue/white for plain hover.
- **A Q&A tab controller's shape**: `init(): Promise<void>`,
  `summary(): string`, `render(): string` (returns HTML, doesn't touch
  the DOM itself), `attachHandlers(container: HTMLElement): void`
  (re-run after every `render()`, since `innerHTML` replacement
  discards old listeners along with old elements). `renderQaPanel()` on
  the main element dispatches to whichever controller `activeQaTab`
  names. Follow this shape for a fourth tab rather than inventing a new
  one.
- **Recording-vs-durable-file answer split**: every tab's "submit an
  answer" path calls `this.recording.log(source, type, payload)`
  first; its return value (`true` if a recording was active and it
  actually logged, `false` otherwise) decides whether to *also* write
  the durable per-tab file. An answer given while recording does **not**
  get written to the durable file at the same time — see
  `plans/samothrace-map-consolidation.md` §5.2 and §8 for why that's a
  real, still-open gap (the recording log is memory-only; nothing folds
  it back into the durable files yet).
- **The Contour Connector tab is a real mode switch**, not just a
  different sidebar. `activeQaTab === 'contour-connector'` changes what
  `onPointerDown`/`onPointerMove`/`onPointerUp`/`onContextMenu` on the
  main canvas actually do (drag-to-connect instead of plain contour
  hover/click) — see those methods' own comments in `samothrace-map.ts`.
  If you add interaction to a future tab that also wants the canvas,
  follow this same explicit-mode-check pattern rather than letting two
  interaction models implicitly fight over the same pointer events.

## This project's pinned `tsc` is old (3.8.3) — known gaps to route around

- **`crypto.randomUUID()` and `ResizeObserver`** aren't in this `tsc`'s
  bundled DOM lib, even though real browsers have long supported both.
  Declaration-merge the missing member in rather than widening the
  whole type — see `samothrace-map-recording.ts`'s `interface Crypto`
  and `samothrace-map.ts`'s `declare class ResizeObserver` for the
  pattern.
- **`Promise.all([...])` with heterogeneous element types, destructured
  directly**, loses per-position typing — every destructured element
  comes back typed as the union of *all* the array's element types, not
  its own real type. Fix: assign each inner promise to its own `const`,
  await them separately, don't destructure from one combined
  `Promise.all`. Hit (and fixed the same way) in at least three places
  in this project now — `topo-compare.ts`, `contour-label-review.ts`,
  and `samothrace-map-connector-tab.ts`'s own `init()`.
- **A class field's type doesn't narrow through optional chaining** the
  way a local `const` does. `this.hoverTarget?.kind === 'fragment'` in
  an `if`/`else if` does **not** let you then access
  `this.hoverTarget.plan` in that branch — capture it into a local
  const first (`const hover = this.hoverTarget; if (hover &&
  hover.kind === 'fragment') { ... hover.plan ... }`).
- Every `ctx.save()` needs exactly one matching `ctx.restore()` — this
  project has already shipped (and caught, in review) one real bug from
  a leftover unmatched `ctx.restore()` left over after refactoring a
  draw call into a shared helper that did its own `save`/`restore`
  internally. If you refactor a draw path, grep for `save()`/`restore()`
  counts before and after.

## Further context

- `plans/samothrace-map-consolidation.md` — the design doc this whole
  build followed, including the still-open items in its own §8.
- `plans/incremental-pipeline-runs.md` — a related, deliberately
  deferred idea (targeted/incremental re-runs of the extraction
  pipeline) that isn't built yet.
- `scripts/extract_vector_layers.py`'s own module docstring — the
  pipeline that produces everything this widget reads from
  `Data/mapFeatures/`.
