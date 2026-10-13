# SamothraceMap consolidation plan

Status: **draft, not yet implemented** — written to capture the design discussion
from chat before building anything. Update this doc as decisions change; don't
let it go stale once implementation starts.

## 1. Goal

We've built a fleet of standalone widgets this project (TopoCompare, Minor
Contour Review, Contour Label Review, Pipeline Stage Viewer, Contour
Connector), each good at one thing but splitting the user's attention across
separate canvases. The new direction: **stop growing that fleet** and instead
build tooling directly into `desk_widgets/samothrace-map/` (the one
already-promoted, permanent widget), consolidating:

- Pipeline Stage Viewer → hide/show-able layers on the map itself.
- TopoCompare's drag-select-and-comment → superseded by a recording session
  (pointing + narration while recording *is* the comment; no explicit
  select-a-rect-and-type-a-note step).
- Minor Contour Review + Contour Label Review → a right-side panel with
  tabbed "questions," each with a one-click "show me" and an answer that's
  logged either into the active recording or a durable fallback file.
- Contour Connector → its own tab in that same panel (kept self-contained
  rather than merged into the general hover/click contour layer, so its
  drag-to-connect interaction doesn't clash with plain hover/click
  elsewhere on the map).

The four now-superseded widgets (TopoCompare, Minor Contour Review, Contour
Label Review, Pipeline Stage Viewer) and the standalone Contour Connector
widget are **left in place, untouched, not actively developed further**
(TopoCompare in particular still holds two saved selection comments worth
keeping around). This plan only covers new work on SamothraceMap.

## 2. Recording model

**Confirmed, real contract** (landed as tempui tags `recording events +
timecoded transcripts #920929` and `named widget logs + log query MCP tools
#211800` — both verified working as of 2026-10-11, including a real
dictated transcript). This supersedes the placeholder contract this
section used to describe.

A **Record** button lives in the `claude_desk` chat widget (outside this
project's own code — built/owned elsewhere). Pressing it publishes a real
`desk.events` message:

- `recording` — `{ recording_id: string, started_at_ms: number }`, when
  capture begins.
- `stopped_recording` — `{ recording_id, started_at_ms, stopped_at_ms }`,
  when capture ends (fires even for a recording that captured no audio; a
  recording that never starts at all, e.g. no microphone, publishes
  neither).

SamothraceMap subscribes to both (capability `events`):

```ts
await desk.events.subscribe(['recording', 'stopped_recording']);
desk.events.onMessage((name, payload) => {
  if (name === 'recording') { this.activeRecordingId = payload.recording_id; /* show indicator */ }
  if (name === 'stopped_recording') { this.activeRecordingId = null; /* hide indicator */ }
});
```

- Shows a recording indicator in the top-right of its own UI, **above** the
  Q&A tab panel (see §4) — e.g. a small red dot + "Recording" label, visible
  only while `activeRecordingId` is set.
- Routes logged interactions (§3) to the active recording's log while one
  is running. Outside a recording, non-answer interactions (hover, click,
  show-me, layer toggles) simply aren't logged at all — they're only
  meaningful correlated against a transcript. Q&A **answers** specifically
  still need the durable fallback described in §5.2 regardless of
  recording state, since a decision must never be lost.

Once transcription finishes (after `stopped_recording`, not immediately),
Desk writes `.desk_temp/timecoded-transcripts/<recording_id>.txt` — one
`[mm:ss.mmm]`-prefixed line per speech segment, offsets from
`started_at_ms`, same epoch-ms clock the widget log entries use — and
pastes a note pointing at that file into the chat prompt. See
`tempui-widget-logs.md`'s "Recording events and timecoded transcripts" for
the full file format.

### 3. Recording log

Not a hand-rolled file anymore — use the real `log` Bridge capability
(capability `log` in `widget.json`) that landed alongside the above:

- `desk.log.append(name, entries)` / `desk.log.line(name, s)` — fire
  -and-forget (no promise, never throws), appends to a **named, in-memory**
  log. **Not durable**: logs live in Desk's own process memory only,
  cleared on a Desk switch or quit, never written to disk — this is new
  information that changes §5.2 and §8 below (an answer logged only here
  can be lost if Desk restarts before it's folded into a durable file).
- I (the agent) read it back with `desk_list_widget_logs` (discover log
  names) and `desk_query_widget_log` (inclusive start/end time-range
  query, ISO-8601 or epoch ms, `asc`/`desc`, paginated via `limit`) — real
  MCP tools, confirmed working, replacing the "future timerange-query MCP"
  this section used to describe speculatively.

**Log naming**: one log per SamothraceMap instance (not one per tab/event
-type — keeps the total log count low; Desk caps at 500 distinct logs
process-wide), named `"samothrace-map-" + shortId`, where `shortId` is
minted once with `crypto.randomUUID().slice(0, 8)` and persisted via
`desk.self.getLocalStorage()`/`setLocalStorage()` so it survives a reload
— the exact pattern `tempui-widget-logs.md`'s own worked example uses.

**Entry shape**: a log entry's `s` is a plain string (not structured JSON
natively), so encode the structured shape this plan has always wanted as a
JSON string in `s`:

```ts
interface RecordingLogEntry {
  recordingId: string; // from the 'recording' event's own payload -- include it even though desk_query_widget_log's own time range already correlates, per tempui-widget-logs.md's own suggestion
  source: string;       // e.g. "contours-layer", "qa:label-review", "qa:minor-bands", "qa:contour-connector"
  type: string;         // e.g. "hover", "click", "answer", "show-me", "layer-toggle"
  payload: unknown;     // keep this SMALL -- entry text is truncated at 4096 chars; ids/positions/short labels, never raw fragment geometry
}
// desk.log.line(logName, JSON.stringify(entry satisfies RecordingLogEntry))
```

`t` (the optional epoch-ms timestamp) can be omitted — Desk stamps arrival
time itself, which is what `desk_query_widget_log` returns anyway (ISO,
local zone).

**Granularity**: log discrete, meaningful interactions (hover-selected,
click, drag-start/end, answer submitted, show-me pressed, layer
toggled) — not raw continuous pointer-move events.

## 4. New layers on SamothraceMap

### 4.1 Pipeline stage layers

Source: the existing `.desk_temp/pipeline-stages/<plan>/NN_<stage-name>.png`
snapshots `scripts/extract_vector_layers.py` already writes (7 stages, 0–6,
per plan — see that script's own module docstring for the authoritative
list). One togglable layer per (plan, stage) pair, alongside the existing
raster layers in SamothraceMap's current layer panel.

**Implementation choice, recommend starting simple**: these PNGs are
single ~2560×2304 images already (not tiled), so the lowest-effort path is
loading them as one client-side image overlay (via `desk.documents` chunked
read → Blob → `<img>`, the same pattern Pipeline Stage Viewer already uses)
and positioning it with the same Web Mercator math SamothraceMap already
uses for its other content — no change to `desk_hmsvc/samothrace-tiles/`
needed. Registering them as real hmsvc tile layers (matching the existing
`layerMetas`/tile-pyramid system) is the more "native-feeling" long-term
option if these ever need real tiling, but isn't needed at this size —
revisit only if it turns out to matter.

### 4.2 Final contours layer

Source: `Data/mapFeatures/SamoWeb_<Plan>_Contours.geojson` (the pipeline's
real output — major/minor/unlabeled per `elevation_source`, same three-shade
palette already established in TopoCompare/Contour Connector/the pipeline
-stage PNGs: `#c026d3` major, `#f59e0b` minor, `#94a3b8` unlabeled).

Behavior:
- Hover highlights the nearest fragment (reuse the
  `distancePointToPolyline`-style hit-testing already written for Contour
  Connector).
- Click "registers" — logs a timestamped interaction (fragment id,
  position, plan) to the active recording log, or is simply a no-op outside
  a recording (TBD exactly what, beyond logging, a click should *do* — not
  specified yet; start with log-only and let usage reveal whether it needs
  to open something).

### 4.3 Existing layers

Unchanged — aerial, raw plan rasters, overlay/structures, etc. all keep
working as they do today.

## 5. Right-side Q&A panel

A new panel, right side of the widget, below the recording indicator (§2).
Tabbed, one tab per question type:

1. **Label review** — ports Contour Label Review's functionality: OCR'd
   elevation-label candidates that aren't a multiple of 5m. Source:
   `Data/mapFeatures/SamoWeb_<Plan>_Contours.review_queue.json`. Answer:
   accept / reject / custom value.
2. **Minor contour bands** — ports Minor Contour Review's functionality:
   groups of unlabeled fragments between two index contours that couldn't
   be auto-ordered. Source:
   `Data/mapFeatures/SamoWeb_<Plan>_Contours.minor_review_queue.json`.
   Answer: per-fragment elevation (or "not a contour"), confirm/skip per
   group.
3. **Contour connector** — ports the standalone Contour Connector widget's
   functionality as its own tab (kept separate from the general hover/click
   contour layer in §4.2 so drag-to-connect doesn't clash with plain
   hover/click elsewhere on the map — per chat decision). Source:
   `Data/mapFeatures/SamoWeb_<Plan>_Contours.connections.suggested.json`
   (plus the Actual-plan stream guide for the Restored plan). Keeps its own
   drag-to-connect canvas interaction (hover/anchor/drag-target states,
   live line, accept-by-click/reject-by-right-click on suggestions) — this
   tab is less a flat question *list* and more the existing mini-tool, but
   gets list-style entries too (one per suggested connection) so it has the
   same "show me" affordance as the other two tabs.

### 5.1 "Show me" button

Every question/entry in every tab gets a **Show me** button. On press, a
**one-time** (not persistent/locked-on) camera + layer change:

1. Ensure the relevant layer(s) are visible (switch on the final-contours
   layer and/or the correct plan if not already) and the correct plan is
   selected.
2. Pan/zoom the map to a viewport computed from the question's own
   geographic data (OCR candidate's centroid + padding; minor-band group's
   fragment bounding box + padding; connector suggestion's two endpoints +
   padding — same `fitViewToGroup`-style math Minor Contour Review already
   has, generalized).
3. Highlight the specific questioned feature(s) distinctly from normal
   hover styling — e.g. a brief pulsing outline/ring for a few seconds.
   Exact animation is an implementation-time detail, not pinned down here.

### 5.2 Answer persistence

- **While recording**: the answer is appended to the recording log (§3,
  `desk.log.line`), `source` set to the owning tab (`qa:label-review`,
  `qa:minor-bands`, `qa:contour-connector`), `type: "answer"`.
- **While not recording**: the answer is appended to that tab's own
  existing durable log file instead — **reuse the exact files already in
  use today**, so the already-written apply scripts keep working unchanged:
  - Label review → `.desk_temp/contour-label-review-log.json` →
    `scripts/apply_label_review.py`.
  - Contour connector → `.desk_temp/contour-connector-log.json` →
    `scripts/apply_contour_connections.py`.
  - Minor contour bands → `.desk_temp/minor-contour-review-log.json` (no
    apply script yet — `scripts/apply_minor_review.py` is still a known gap
    from before this plan; still pending, mirror the other two's pattern
    when it's written).

  An answer given **while recording** does *not* also get duplicated into
  these per-tab files at answer time — it lives in the recording log only,
  and folding recording-log answers back into the per-tab durable files
  (and from there into the pipeline via the apply scripts) is a separate,
  later step. **This is no longer just a "do it later" deferral** — now
  that the recording log is confirmed memory-only/non-durable (§3), an
  answer that only ever lived there is genuinely lost the moment Desk
  restarts, not just unprocessed. See §8's updated note on this.

## 6. Suggested build order

Each phase should leave SamothraceMap in a working, demoable state —
no big-bang integration at the end.

1. ✅ **Recording plumbing**: event subscription, indicator UI, recording-log
   writer (§2, §3) — foundational, lowest risk, nothing else depends on
   guessing its shape correctly later. Built 2026-10-12 in
   `samothrace-map-recording.ts`; confirmed working against a real
   recording (indicator showed up). Also logs layer-visibility changes
   and a full visible-layers snapshot the moment a recording starts
   (not originally spec'd in §3, added per request so an answer about
   "what was visible" doesn't depend on the narration mentioning it).
2. ✅ **Pipeline stage layers** (§4.1) — mechanical, reuses existing PNGs,
   no new interaction model. Built 2026-10-12 in
   `samothrace-map-stage-layers.ts`. Required one addition not foreseen
   when this plan was written: `extract_vector_layers.py` didn't persist
   the stitched mosaic's own geographic bounds anywhere, so there was no
   way to position a stage PNG on the map at all -- added
   `write_stage_bounds()`, writing one `bounds.json` per plan alongside
   the 7 stage PNGs (lon/lat box, not pixel/tile coordinates, so it's
   zoom-independent at render time the same way the monument overlay
   polygons already are).
3. ✅ **Final contours layer** (§4.2) — hover/click + recording-log
   integration, reuses Contour Connector's hit-testing code. Built
   2026-10-12 in `samothrace-map-contours-layer.ts`. Joins each plan's
   existing layer-panel group (real map content) rather than getting a
   separate section the way the stage debug layers do. Monument
   hover/click still takes precedence when both are hit (large, easy
   -to-hit polygon vs. a thin line) — contour hit-testing is the
   fallback when no monument is hit, for both hover and click.
   Refactored `redraw()`'s local `toScreen` closure into a shared
   `private readonly toScreen` arrow-field during this phase, since the
   pointer handlers (hover/click hit-testing) now need the same
   projection outside of a redraw pass too.
4. ✅ **Q&A panel shell** + **Label review tab** (§5, §5.1 item 1) — simplest
   of the three tabs (flat list, 3-way answer), proves out the tab
   framework, show-me, and the recording-vs-durable-file answer split
   (§5.2) end to end before the more complex tabs. Built 2026-10-12 in
   `samothrace-map-qa-panel.ts`. Answers are loaded from
   `.desk_temp/contour-label-review-log.json` itself (not this widget's
   own localStorage) as the source of truth on init, so anything already
   answered via the old standalone Contour Label Review widget is
   already accounted for, never re-asked. "Show me" highlight is a
   plain sustained highlight (bright yellow, thicker line), not an
   animated pulse -- §5.1 step 3 left the exact animation unspecified,
   and a non-animated highlight is simpler and still reads as clearly
   distinct from normal hover/selected styling. The recording indicator
   moved from the toolbar (its phase-1 placement, before the panel
   existed) into the new panel's own header, matching §2's original
   "above the Q&A tab panel" placement now that there's a panel to be
   above. Per a follow-up request, also made every layers-panel group
   header collapsible (native `<details>`/`<summary>`, same mechanism
   the Debug section already used) -- not originally part of this plan,
   but a small, low-risk UI improvement bundled in alongside this phase.
5. ✅ **Minor contour bands tab** (§5.1 item 2). Built 2026-10-12 in
   `samothrace-map-qa-panel.ts`. Unlike label review's flat card list,
   this one keeps the standalone widget's group-navigator shape
   (prev/next/dropdown/skip-to-unanswered) rather than rendering every
   group as its own card -- 100+ pending groups per plan is too many to
   usefully scroll through flat. Navigating to a group auto-triggers
   "Show me" (pans/zooms/highlights the real map as you browse), plus an
   explicit button of its own for re-centering after panning away.
   **One real simplification from the standalone widget**: that widget
   drew each fragment in its own distinct numbered color on the map, so
   a human could tell which highlighted line matched which elevation
   -input row; this port highlights the whole group as one solid block
   (the same red/white highlight every "Show me" uses) -- the sidebar's
   numbered color swatches are kept, but aren't matched on the map
   itself. Flagged as a possible regression to revisit if it turns out
   to matter in practice, not fixed speculatively up front.
6. ✅ **Contour connector tab** (§5.1 item 3) — the largest single port (full
   drag-to-connect canvas interaction inside a tab). Built 2026-10-12 in
   `samothrace-map-connector-tab.ts`. Drag-to-connect only engages while
   this tab is the active one -- the main canvas's pointer handlers
   switch modes based on `activeQaTab`, so it structurally can't clash
   with plain monument/contour hover-click on the other two tabs (the
   plan's own "kept self-contained" call). Reuses
   `ContoursLayerController`'s already-loaded fragments (added a public
   `fragmentsFor()`) rather than fetching a second copy of the same
   *.geojson. **Interpretation call on "gets list-style entries too...
   so it has the same 'show me' affordance"**: a flat list of every
   *suggested* connection isn't practical (thousands per plan -- the
   whole reason the drag/click/right-click canvas interaction exists
   instead of a list in the first place); the list this tab actually
   shows is of *confirmed* connections instead, each with its own "Show
   me" and a remove button -- naturally small since it starts empty and
   only grows as you actually connect things.
   All six phases of this plan are now built. See §8 for what's still
   genuinely open (mostly: `scripts/apply_minor_review.py` doesn't exist
   yet, and recording-log answers still need a real "fold back" step).

## 7. Implementation notes

- `samothrace-map.ts` is already ~830 lines before any of this. Recommend
  splitting into multiple `.ts` files compiled together via `tsconfig.json`
  `"files"` (base-class-before-subclass ordering, same mechanism the tempui
  custom-widget docs describe) rather than letting one file keep growing —
  e.g. `samothrace-map.ts` (main element), `samothrace-map-layers.ts`,
  `samothrace-map-qa-panel.ts`, `samothrace-map-recording.ts`. Not required,
  just recommended given the scale of what's landing here.
- Keep reusing the established conventions from this project's other
  widgets: state-based hmsvc URL discovery (never hardcode a port), the
  viewRect zoom/minimap pattern, the major/minor/unlabeled color palette,
  position-keyed (lon/lat) persistence rather than array-index-keyed.
- SamothraceMap's `widget.json` needs two new capabilities beyond today's
  `["fs", "state"]`: `events` (recording start/stop, §2) and `log`
  (recording log writes, §3).

## 8. Open questions (not yet answered, revisit before/while building)

- ~~Exact `desk.events` name(s) and payload shape for recording
  start/stop~~ — **resolved**, see §2.
- What a plain click on a final-contour fragment (§4.2) should do beyond
  logging — nothing specified yet.
- Exact "show me" highlight animation/duration (§5.1 step 3).
- **How soon** a recording-log answer gets folded into the per-tab durable
  files / the pipeline proper (§5.2) — now a real durability question, not
  just a sequencing one: the recording log is confirmed memory-only
  (cleared on Desk switch/quit, §3), so an answer given during a recording
  and never folded is genuinely gone, not just unprocessed. Leans toward
  "fold promptly after `stopped_recording` fires" rather than "whenever
  convenient" — worth deciding before this ships, not after a first real
  loss.
- `scripts/apply_minor_review.py` still doesn't exist — needed before the
  minor-contour-bands tab's "not recording" answers can reach the pipeline.
