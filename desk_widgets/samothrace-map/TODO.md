# Samothrace Map — known gaps / future work

See `AGENTS.md` for the full picture of this widget; this file just
tracks specific open items worth picking up later.

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
