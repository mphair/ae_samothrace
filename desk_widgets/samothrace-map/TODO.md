# Samothrace Map — known gaps / future work

See `AGENTS.md` for the full picture of this widget; this file just
tracks specific open items worth picking up later.

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
