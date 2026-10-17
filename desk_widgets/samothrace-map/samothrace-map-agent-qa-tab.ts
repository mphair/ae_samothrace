// Agent Q&A tab -- the leftmost, default Q&A panel tab, added per the
// widget's own TODO.md "Give the agent a way to ask a confirmable
// question through the Q&A panel, not just in chat text" item. Unlike
// the other three tabs (each driven by a *.review_queue.json /
// *.suggested.json file this project's own extraction pipeline writes
// once per run), this tab's questions come from an AGENT, appended at
// any time -- a real Claude session, mid-conversation, asking something
// like "is this suggested connection actually correct?" without typing
// it as plain chat text disconnected from the map.
//
// Mechanism (the worked example this was built from: confirming
// restored-auto-gap-100 without opening the Contour Connector tab):
//   1. An agent appends a question (with its own uuid) to
//      AGENT_QUESTIONS_PATH.
//   2. This tab polls that file (see AGENT_QA_POLL_INTERVAL_MS's own
//      comment for why polling, not a push) and renders any question
//      with no matching answer yet.
//   3. The user clicks Confirm/Reject (optionally after "Show me"). The
//      answer is appended to AGENT_ANSWERS_PATH, keyed by the question's
//      own id -- tying the two files together the same way
//      *.review_queue.json / *-review-log.json pairs already do
//      elsewhere in this widget, just agent-authored on one side instead
//      of pipeline-authored.
// See FEEDBACK-DESK-agent-qa-file-polling-* in
// ../../inadvisable-adventures/FEEDBACK/ for why this is a stopgap --
// a real MCP tool pair would replace the polling/file-drop round trip
// entirely.
//
// Second mechanism in this same file, added 2026-10-16 per
// investigations/agent-autonomous-corrections-channel.md -- "AgentPatchChannel"
// (not a separate class; folded into this controller since it shares
// this tab's own poll loop and this tab is already the one visible place
// "the agent telling you something" shows up). Unlike the question/answer
// flow above, a PATCH is not a question -- there is no Confirm/Reject
// click, no AgentAnswer. An agent that has already investigated and is
// confident appends a patch (own uuid, a `reason` string, one of the two
// types below) to AGENT_PATCHES_PATH; this tab applies it immediately on
// the next poll, writes the correction into the SAME durable per-tab log
// file the matching manual UI action would have (tagged `appliedBy:
// 'agent-autonomous'` for provenance -- see LogConnection's and
// MinorBandGroupAnswer's own comments), and acks it into
// AGENT_PATCHES_APPLIED_PATH. Per that investigation doc's own
// "visibility/trust" open question, this deliberately does NOT apply
// silently: every applied patch renders as a visible "⚡ Applied
// automatically" row with **OK / Undo** buttons (added the same day,
// folded in per direct request before this work got committed) -- OK
// just archives the row (see the archiving section below); Undo reverses
// the applied change (removes the connection / clears the elevation
// override, same code paths `ContourConnectorTabController`'s own
// "Remove" button and `clearFragmentElevationOverrides` use) and --
// "so as not to lose the agent's change" -- writes a brand-new
// AgentQuestion carrying the exact same `data` and `reason` back into
// AGENT_QUESTIONS_PATH (see convertPatchToQuestion), so it reappears as
// an ordinary pending question for a real, deliberate Confirm/Reject
// instead of just vanishing. Started scoped to the same two actions this
// tab (and MinorBandsTabController) already knew how to apply:
// 'confirm-connection' (reuses ConfirmConnectionQuestionData as-is) and
// 'confirm-minor-band' (mirrors MinorBandGroupAnswer's own `fragments`
// shape) -- which, as of the same day, is now ALSO a real question type
// a human can be asked directly (see the next paragraph), not just
// something Undo produces.
//
// A third patch type, 'retract-connection', followed within the hour --
// not a hypothetical gap, a real one hit live: a user caught an
// already-confirmed connection as wrong, the correcting
// 'confirm-connection' patch landed fine, but the OLD wrong one had no
// live retraction path (only Undo-of-a-just-applied-patch could remove a
// confirmed connection, and that one predated this whole channel, so
// there was no AppliedPatch record for it to Undo). 'retract-connection'
// reuses ConfirmConnectionQuestionData too (kept whole, not trimmed to
// just connectionId/plan, so Undo-of-a-retraction can re-confirm the
// exact same connection symmetrically) and, on apply, calls the exact
// same onUndoConnection callback Undo already used.
//
// A fourth, structurally very different question type,
// 'adjust-image-transform', followed the same day: a photo of a
// different, hand-annotated plan of the sanctuary got georeferenced
// automatically first (desk-installed-jobs/samothrace-initial-map/, a
// control-point/piecewise-affine warp) -- it didn't work well enough.
// This type drops automatic alignment entirely: the question's own card
// renders four LIVE sliders (rotation, scale, and two tilt axes --
// "photo-angle distortion," confirmed directly as a real 3D tilt, not a
// 2D approximation) plus a draggable `<img>` overlay positioned directly
// on the map canvas (not canvas-drawn -- a real CSS 3D `transform`,
// rendered natively by the browser; see SamothraceMapElement's own
// positionImageOverlay), so the user can dial the alignment in BY EYE
// against the real map underneath, then "Lock In" (semantically this
// file's own Confirm path, see applyImageTransform) to write the final
// numbers to Data/mapSources/<slug>/transform.json and bake them into
// real tiles via desk-installed-jobs/map-import-from-photo/ (the
// renamed, generalized successor to the scrapped piecewise-affine job --
// see that job's own header comment for the exact CSS-transform
// <-> homography math bridging what the user saw to what gets baked).
// No `plan` concept, no reused ConfirmConnectionQuestionData/
// ConfirmMinorBandPatchData shape -- different enough (own working
// -state model, own card renderer, own apply/cancel methods) that it's
// noted in full here rather than folded into the "scope" framing the
// first three paragraphs above share.
//
// Two question types now: 'confirm-connection' (the original, "is this
// suggested/already-applied contour connection correct?") and
// 'confirm-minor-band' (added 2026-10-16, both as Undo's own "convert
// back to a question" target AND as a first-class type an agent can post
// directly -- "is this minor-band elevation grouping correct?", read-only
// summary of the agent's own fragment/elevation choices, no per-fragment
// re-editing UI here -- that's what the Minor Bands tab is for).
//
// **Archiving** (added 2026-10-16, same request as OK/Undo above): once
// a question is answered (confirm/reject) or an applied-patch row is
// resolved (OK/undo), it doesn't just sit there forever -- it shows a
// brief "how it was resolved" placeholder, then animates away and stops
// rendering in the MAIN list, decluttering this tab back down to just
// what's still actually pending. See QA_ARCHIVE_DELAY_MS's own comment
// and widget.html's `qa-archive-away` keyframes for the exact timeline (a
// CSS `@keyframes animation`, not a `transition` -- this renderer does a
// full innerHTML replace on every change, which a transition can't
// survive but a self-contained keyframe animation can). "Archived" here
// is a pure DERIVED status, not a separately-tracked flag -- a question
// is archived precisely when it has an answer and isn't currently mid
// -animation (`archivingQuestions`); an applied-patch row is archived
// precisely when its durable record has a `resolution` ('ok' or 'undo')
// and isn't currently mid-animation. Nothing needs separate bookkeeping
// for "already archived," which also means a question/patch resolved
// before this tab ever loaded (a prior session, or a different Desk
// instance) is simply already archived from the first render -- no
// animation plays, there's nothing live to show a placeholder for.
//
// **Archive drawer** (added the same day, directly requested right
// after OK/Undo/archiving above): a collapsed-by-default panel pinned to
// the bottom of this tab (`renderArchiveDrawer`) listing every archived
// question/patch with a **Reset** button -- reverses whatever the
// original decision did (same reversal logic Undo already uses, see
// `reverseAppliedDecision`) and returns the item to the main section:
// an answer gets removed so the question is pending again; an OK'd patch
// loses its `resolution` so it reappears in the live "applied
// automatically" list. Sortable by question age (`createdAt`) or answer
// age (when it was resolved), default ascending-by-answer-age --
// "ascending age" meaning the SMALLEST elapsed time first, i.e. the most
// recently resolved item at the top, same "most recent first" convention
// the main question list already uses. The drawer's own open/closed
// toggle is handled via direct DOM manipulation in attachHandlers
// (classList.toggle), NOT by calling onChanged() and letting a fresh
// render() emit it already-open -- same "a transition needs an existing
// node to animate FROM" reasoning as the archiving animation above,
// except here the node genuinely isn't being recreated on toggle, so a
// plain CSS `transition` (not a `@keyframes` animation) works correctly.
//
// A confirm/reject answer on a 'confirm-connection' question does
// double duty: besides the generic AGENT_ANSWERS_PATH record above, it
// writes the EXACT SAME LogConnection/LogRejection shape the Contour
// Connector tab's own acceptSuggestion/rejectSuggestion already write,
// into that tab's own CONNECTOR_LOG_PATH -- so
// scripts/apply_contour_connections.py keeps working completely
// unchanged, and the two tabs can never disagree about a given
// connectionId's own status. This is the actual point of the whole
// feature: confirming here has to be as real as confirming via the
// Connector tab's own UI, not a second, disconnected record that still
// needs a trip through that tab later to actually count.
//
// Unlike every other answer path in this widget, this tab's writes are
// NOT gated behind the recording-vs-durable-file split
// (plans/samothrace-map-consolidation.md §5.2) -- always written to
// disk immediately, recording-log entry or not. Two reasons: (1) that
// split exists to correlate an answer against a narration transcript,
// which doesn't apply here -- a question like this has nothing to do
// with "where was the user pointing when they said this"; (2) this
// widget's own TODO.md already flags the existing split as a real,
// unfixed data-loss bug (an answer given while recording can be lost
// for good) -- reproducing that bug in brand-new code the same day it
// was documented would be worse than just not having the split at all
// here. `recording.log(...)` is still called, unconditionally, purely
// as an informational entry for transcript correlation if a recording
// happens to be active -- it never gates whether the durable write
// happens.
//
// Concatenated after samothrace-map-connector-tab.ts (reuses its
// ConnectionSource/LogConnection/LogRejection interfaces and
// CONNECTOR_LOG_PATH) and samothrace-map-qa-panel.ts (reuses QaPlan/
// QA_PLAN_LABEL), before samothrace-map.ts, in tsconfig.json's own
// "files" array.

const AGENT_QUESTIONS_PATH = '.desk_temp/samothrace-map-agent-questions.json';
const AGENT_ANSWERS_PATH = '.desk_temp/samothrace-map-agent-answers.json';

// No Bridge file-watch capability exists yet (see this file's own header
// comment and the matching FEEDBACK report) -- polling is the stand-in.
// Short enough that a question posted mid-session shows up without a
// widget reload, long enough not to hammer desk.fs for a file that
// usually isn't changing between polls.
const AGENT_QA_POLL_INTERVAL_MS = 4000;

// Same duration every other "Show me" sustained highlight in this widget
// uses (ContoursLayerController.highlightFragments's own call sites).
const AGENT_QA_HIGHLIGHT_DURATION_MS = 3000;

const AGENT_PATCHES_PATH = '.desk_temp/samothrace-map-agent-patches.json';
const AGENT_PATCHES_APPLIED_PATH = '.desk_temp/samothrace-map-agent-patches-applied.json';
// How many of the most recently-applied patches render in the "applied
// automatically" list -- purely a display cap. The ack file itself is
// never trimmed; every patch ever applied stays in
// AGENT_PATCHES_APPLIED_PATH for good, this just limits how much of the
// sidebar a long session's worth of history would otherwise fill.
const AGENT_PATCH_VISIBLE_HISTORY = 8;

// Total lifetime of an archiving question/applied-patch row, start to
// gone: 5000ms static placeholder + 3000ms fade + 500ms vertical
// collapse. MUST stay in sync with widget.html's own `qa-archive-away`
// @keyframes percentages (5/8.5 = 58.8%, 8/8.5 = 94.1%) -- this constant
// drives WHEN the row actually stops rendering (via a plain setTimeout);
// the keyframes drive what it visually looks like doing up to that
// moment. Two independent things that happen to need the same number,
// not something one could derive from the other automatically given this
// is a hand-authored CSS block, not generated from this file.
const QA_ARCHIVE_DELAY_MS = 8500;

type AgentQuestionType = 'confirm-connection' | 'confirm-minor-band' | 'adjust-image-transform';

// 'adjust-image-transform' (added 2026-10-17, same day as its own
// predecessor's control-point/piecewise-affine approach was scrapped for
// not working well enough) -- an interactive tool, not a yes/no
// judgment. The user rotates/scales/tilts (and drags to reposition) a
// live overlay of an uploaded photo directly against the real map,
// confirmed by eye, then "Lock In" (semantically this file's own
// Confirm path, just relabeled -- see applyImageTransform) writes the
// final numbers into Data/mapSources/<slug>/transform.json and calls
// desk.installedJobs.run('map-import-from-photo', ...) to bake them into
// real tiles immediately. See desk-installed-jobs/map-import-from-photo/
// main.py's own header comment for the exact math (a real CSS 3D
// transform on a plain <img>, not canvas-drawn -- the browser renders
// the live preview natively; the job reconstructs the IDENTICAL 4x4
// matrix pipeline in Python so what was seen is exactly what gets
// baked, not an approximation of it).
//
// Zoom-independent by design (same reasoning transform.json's own shape
// documents in that job's header comment) -- `metersPerPhotoPx` /
// `userScale` describe a REAL-WORLD size, not a screen size; converting
// to an actual on-screen CSS pixel size for the live preview (which
// DOES depend on current zoom) is SamothraceMapElement's own job
// (positionImageOverlay), not this controller's.
interface AdjustImageTransformQuestionData {
  slug: string; // Data/mapSources/<slug>/ -- also the hmsvc /source/<slug> endpoint's own path segment
  layerId: string; // which "imagery" layer to refresh after Lock In (desk_hmsvc/samothrace-tiles/service.py's own LAYERS id)
  centerLon: number;
  centerLat: number;
  metersPerPhotoPx: number;
  userScale: number;
  rotateDeg: number;
  tiltXDeg: number;
  tiltYDeg: number;
  photoWidth: number;
  photoHeight: number;
}

interface ConfirmConnectionQuestionData {
  connectionId: string;
  plan: ContourPlan;
  source: ConnectionSource;
  aLon: number;
  aLat: number;
  bLon: number;
  bLat: number;
  distancePx: number | null;
  elevationM: number | null;
  // The two real fragments this connection would join, if the question
  // -author (an agent) resolved them -- optional because the suggested
  // -connections files themselves are position-keyed, not fragment-id
  // -keyed (see this project's own "never index-keyed" convention), so
  // they're not always at hand. When present, "Show me" highlights both
  // fragments alongside the gap itself -- "closes the semantic loop" per
  // the user's own framing: fragment + gap + fragment reads as the one
  // continuous corrected line this connection is proposing.
  aFragmentId: number | null;
  bFragmentId: number | null;
}

interface AgentQuestion {
  id: string;
  type: AgentQuestionType;
  prompt: string;
  createdAt: string;
  // ConfirmMinorBandPatchData is declared further down (the "AgentPatch
  // -Channel types" section) -- fine to reference here anyway, these are
  // all global-script interfaces in one compiled program; declaration
  // order only matters for the compiled JS of CONCRETE code, never for
  // type-checking (see this widget's own AGENTS.md).
  data: ConfirmConnectionQuestionData | ConfirmMinorBandPatchData | AdjustImageTransformQuestionData;
}

interface AgentQuestionsFile {
  questions: AgentQuestion[];
}

type AgentAnswerDecision = 'confirm' | 'reject';

interface AgentAnswer {
  questionId: string;
  decision: AgentAnswerDecision;
  answeredAt: string;
}

interface AgentAnswersFile {
  answers: AgentAnswer[];
}

// ── AgentPatchChannel types -- see this file's own header comment's
// second section for the full design. ──

// 'retract-connection' added 2026-10-17: a real gap surfaced live, not
// hypothetically -- a user caught an already-confirmed connection as
// wrong (restored-auto-gap-309), the correcting 'confirm-connection'
// patch landed fine, but there was no way to retract the OLD wrong one
// short of a direct file edit + a full widget reload (the exact pattern
// this whole channel exists to replace), because 'confirm-connection'
// patches only ever ADD. This closes that: a 'retract-connection' patch
// reuses ConfirmConnectionQuestionData as-is (same connectionId/plan a
// human's own "Remove" button needs, kept whole rather than trimmed to
// just those two fields so Undo-of-a-retraction can re-confirm the
// EXACT same connection symmetrically -- see reverseAppliedDecision's
// own 'retract-connection' branch) and, on apply, calls the exact same
// onUndoConnection callback Undo already uses -- same removal path a
// human's own "Remove" button in the Connector tab calls.
type AgentPatchType = 'confirm-connection' | 'confirm-minor-band' | 'retract-connection';

// Mirrors MinorBandGroupAnswer's own `fragments` shape (samothrace-map
// -qa-panel.ts) rather than inventing a new one -- a confirm-minor-band
// patch's (or question's) `data` becomes that exact answer shape, just
// with `decision`/`answeredAt`/`appliedBy` filled in at apply time (see
// applyMinorBandDecision). Also used, unchanged, as an AgentQuestion's
// own `data` for this same type -- see AgentQuestion's own comment.
interface ConfirmMinorBandPatchData {
  groupId: string;
  plan: QaPlan;
  elevLow: number;
  elevHigh: number;
  fragments: MinorBandFragmentAnswer[];
}

interface AgentPatch {
  id: string;
  type: AgentPatchType;
  // A short, human-readable note on WHY the agent is confident enough to
  // apply this without asking first -- rendered in the "applied
  // automatically" list so a human skimming it later can judge whether
  // it was reasonable, not just see THAT something happened. Required,
  // not optional: a patch with no reason defeats the legibility this
  // whole channel exists to preserve (see the investigation doc's own
  // "visibility/trust" open question).
  reason: string;
  createdAt: string;
  data: ConfirmConnectionQuestionData | ConfirmMinorBandPatchData;
}

interface AgentPatchesFile {
  patches: AgentPatch[];
}

type AgentPatchStatus = 'applied' | 'error';

interface AppliedPatch {
  patchId: string;
  status: AgentPatchStatus;
  appliedAt: string;
  detail?: string; // set only when status === 'error' -- the caught error's own message
  // Set once a human has clicked OK or Undo on this row (see
  // resolvePatchOk/undoPatch) -- absent means it's still showing live in
  // the "applied automatically" list with OK/Undo buttons. This field
  // (not an in-memory flag) is what makes "is this patch archived"
  // survive a reload -- see this file's own header comment's "Archiving"
  // section. `resolution: 'undo'` rows are never re-shown anywhere as
  // their own item again (see computeArchivedItems's own comment) --
  // their lineage continues via the question convertPatchToQuestion
  // wrote instead.
  resolution?: 'ok' | 'undo';
  resolvedAt?: string; // when `resolution` was set -- the "answer age" sort basis in the archive drawer
}

interface AppliedPatchesFile {
  applied: AppliedPatch[];
}

// In-memory only, never itself written to disk -- derived fresh each
// poll from an AppliedPatch (the durable record) plus whatever AgentPatch
// data is still around to describe it, so render() has a ready-made
// summary string without re-deriving one from `this.patches` every call.
interface AppliedPatchDisplay {
  patchId: string;
  type: AgentPatchType;
  summary: string;
  reason: string;
  status: AgentPatchStatus;
  appliedAt: string;
  createdAt: string; // the original AgentPatch's own createdAt -- "question age" basis in the archive drawer; falls back to appliedAt if the source patch is no longer available (see describeAppliedPatch)
  resolution?: 'ok' | 'undo';
  resolvedAt?: string;
}

type ArchiveSortBy = 'question-age' | 'answer-age';

// One row in the archive drawer -- a question and an applied-patch row
// have almost nothing in common shape-wise, so this is the unified,
// display-only type renderArchiveDrawer actually sorts/renders, built
// fresh each render() call by computeArchivedItems from whichever of
// `this.questions`/`this.answers`/`this.archivedPatches` applies.
interface ArchivedItemDisplay {
  kind: 'question' | 'patch';
  id: string; // questionId or patchId -- which one is implied by `kind`, used by the Reset button's own click handler to dispatch correctly
  summary: string;
  resolutionLabel: string; // "Confirmed" / "Rejected" / "OK'd"
  createdAt: string;
  resolvedAt: string;
}

// Shared by describeAppliedPatch (applied-patch rows) and
// computeArchivedItems (archived questions) -- both need the exact same
// "turn a confirm-connection/confirm-minor-band `data` payload into one
// readable line" conversion, and they'd drift if each reimplemented it.
function summarizeDecisionData(type: AgentPatchType, data: ConfirmConnectionQuestionData | ConfirmMinorBandPatchData): string {
  if (type === 'confirm-connection' || type === 'retract-connection') {
    const d = data as ConfirmConnectionQuestionData;
    const frags = d.aFragmentId !== null && d.bFragmentId !== null ? ` (#${d.aFragmentId}/#${d.bFragmentId})` : '';
    return `${d.source} gap on ${QA_PLAN_LABEL[d.plan]}${frags}`;
  }
  const d = data as ConfirmMinorBandPatchData;
  return `minor band ${d.groupId} on ${QA_PLAN_LABEL[d.plan]} (${d.fragments.length} fragment(s), ${d.elevLow}-${d.elevHigh}m)`;
}

class AgentQaTabController {
  private questions: AgentQuestion[] = [];
  private answers = new Map<string, AgentAnswer>(); // keyed by questionId
  private loaded = false;
  private pollTimer: number | null = null;
  private busyIds = new Set<string>(); // questionIds mid-submit -- guards a double click against a double append
  // The gap itself has no geometry of its own to highlight (that's the
  // whole point of a 'confirm-connection' question -- it's empty space
  // between two real fragments), so unlike ContoursLayerController's
  // highlightFragments (which overdraws an EXISTING fragment), "Show me"
  // here needs its own tiny highlight: a candy-cane line drawn directly
  // between the question's own aLon/aLat/bLon/bLat, same red/white
  // HIGHLIGHT_COLOR/strokeCandyCane every other "Show me" in this widget
  // uses, auto-clearing the same way (see ContoursLayerController.
  // highlightFragments's own comment for why a plain sustained highlight
  // rather than an animated pulse).
  private highlight: { aLon: number; aLat: number; bLon: number; bLat: number; clearTimer: number } | null = null;

  // ── Archiving state -- see this file's own header comment's
  // "Archiving" section for why "archived" itself is a DERIVED status,
  // not tracked in a set below. Both maps hold a question/patch id
  // ONLY while its placeholder is mid-animation; the value is which
  // decision to show. Removed by the matching startArchiving timer once
  // QA_ARCHIVE_DELAY_MS elapses (for a patch, that timer also fires the
  // durable `resolution` write that actually makes "archived" true --
  // see resolvePatchOk/undoPatch).
  private archivingQuestions = new Map<string, AgentAnswerDecision>();
  private archivingPatches = new Map<string, 'ok' | 'undo'>();

  // One shared timer map for both of the above (keys never collide --
  // caller passes the question's OR the patch's own id, each already
  // globally unique within this tab) -- cleared wholesale in dispose()
  // so a torn-down widget instance never fires a stray onChanged() later.
  private archiveTimers = new Map<string, number>();

  // ── Archive drawer state -- see this file's own header comment's
  // "Archive drawer" section. Both are pure UI preferences, deliberately
  // NOT persisted anywhere -- a fresh widget load reasonably starts
  // collapsed/default-sorted, same as every other per-session UI default
  // in this widget that isn't explicitly covered by the saved-UI-state
  // mechanism (view/layers/selection only, see samothrace-map.ts's own
  // saveUiState).
  private archiveDrawerOpen = false;
  private archiveSortBy: ArchiveSortBy = 'answer-age';

  // ── 'adjust-image-transform' working state ──
  // Working (not-yet-locked-in) parameter copies, keyed by questionId --
  // seeded lazily from the question's own `data` (the initial guess) the
  // first time it's touched (slider input, drag, or just rendered), kept
  // SEPARATE from `data` itself so the original guess survives a Cancel.
  // In practice there's realistically 0 or 1 of these pending at once
  // (a deliberate, rare per-import action, not a queue), but keyed by id
  // rather than a single slot anyway -- cheap, and avoids any ambiguity
  // if that assumption's ever wrong.
  private imageAdjustments = new Map<string, AdjustImageTransformQuestionData>();
  private imageTransformError: string | null = null; // last Lock In failure message, if any -- cleared on next attempt

  // ── AgentPatchChannel state ──
  private patches: AgentPatch[] = [];
  private recentApplied: AppliedPatchDisplay[] = []; // newest first, capped at AGENT_PATCH_VISIBLE_HISTORY, resynced from disk every poll -- UNRESOLVED patches only (see reload()'s own split)
  private archivedPatches: AppliedPatchDisplay[] = []; // RESOLVED ('ok' only, see this field's own reload()-time comment) patches, for the archive drawer -- resynced the same way
  // Guards against an overlapping poll tick double-applying: reload()'s
  // own setInterval doesn't await the previous call, so if applying a
  // patch (a few awaited file read/writes) ever took longer than
  // AGENT_QA_POLL_INTERVAL_MS, the next tick could otherwise start a
  // second pass over the same not-yet-acked patch. Each patch is ALSO
  // deduped against the durable ack file itself inside
  // appendAppliedPatch, so even a genuine double-call is harmless, just
  // redundant work -- this flag is purely about skipping that redundant
  // work, not a correctness requirement.
  private applyingPatches = false;

  constructor(
    private readonly recording: RecordingController,
    private readonly onChanged: () => void,
    private readonly onShowMe: (plan: ContourPlan, bounds: { west: number; south: number; east: number; north: number }, fragmentIds: number[]) => void,
    private readonly scheduleRedraw: () => void,
    // Called right after a 'confirm-connection' answer is durably
    // written to CONNECTOR_LOG_PATH -- lets the main element tell
    // ContourConnectorTabController's own already-loaded in-memory
    // suggested/confirmed/rejected state about it immediately, so
    // switching to that tab afterward (or hovering/clicking the real
    // fragments elsewhere) reflects the decision right away rather than
    // only after a reload. See samothrace-map-connector-tab.ts's own
    // applyExternalDecision for the other half of this.
    private readonly onConnectionDecision: (data: ConfirmConnectionQuestionData, decision: AgentAnswerDecision) => void,
    // Called by BOTH a 'confirm-minor-band' patch's own auto-apply AND a
    // 'confirm-minor-band' QUESTION's own Confirm click -- mirrors
    // MinorBandsTabController's own constructor param of the same name/
    // shape in samothrace-map-qa-panel.ts; samothrace-map.ts wires both
    // to the same underlying
    // ContoursLayerController.setFragmentElevationOverrides.
    private readonly onBandConfirmed: (plan: QaPlan, overrides: Array<{ fragmentId: number; elevationM: number }>) => void,
    // 'confirm-minor-band' question/patch "Show me" -- unlike a
    // connection's gap (which has no existing geometry, see highlightGap
    // below), a minor-band group IS a set of real fragments already on
    // the map, so this reuses the exact same pan/zoom/highlight path
    // every OTHER tab's own fragment-based "Show me" already uses
    // (samothrace-map.ts's own showMeContourFragments), rather than
    // reinventing a bounds calculation here.
    private readonly onShowMeFragments: (plan: QaPlan, fragmentIds: number[]) => void,
    // Undo-only (added 2026-10-16 alongside archiving/OK-Undo) -- reverts
    // a 'confirm-connection' patch's applied connection. Wired to
    // ContourConnectorTabController.removeConfirmedById, which shares
    // this exact same removal path with that tab's own manual "Remove"
    // button -- undoing an autonomous patch is as real as a human
    // removing a connection themselves, same standard every other
    // apply/undo path in this file already holds to.
    private readonly onUndoConnection: (connectionId: string, plan: ContourPlan) => void,
    // Undo-only, minor-band side -- reverts the session-local color
    // override ContoursLayerController.setFragmentElevationOverrides
    // applied. The durable MINOR_BAND_LOG_PATH entry itself is removed
    // directly by this file (see removeMinorBandAnswer), not through a
    // callback -- unlike the connection case, there's no OTHER
    // controller's own "remove" method to delegate to; MinorBandsTabController
    // has no undo UI of its own yet (see this widget's own TODO.md).
    private readonly onBandUndo: (plan: QaPlan, fragmentIds: number[]) => void,
    // 'adjust-image-transform' Lock In -- called right after
    // map-import-from-photo finishes regenerating a layer's real tiles,
    // so the main element can bust its own tile-URL cache (hmsvc's
    // responses are aggressively cached, see that method's own comment)
    // and redraw. Not called on failure -- see applyImageTransform's own
    // comment on why a failed auto-run is still a safe, recoverable
    // state (transform.json is already saved by then regardless).
    private readonly onImageTransformApplied: (layerId: string) => void,
  ) {}

  async init(): Promise<void> {
    await this.reload();
    this.loaded = true;
    this.onChanged();
    this.pollTimer = (setInterval(() => void this.reload(), AGENT_QA_POLL_INTERVAL_MS) as unknown) as number;
  }

  // Called from the main element's own disconnectedCallback (same place
  // it tears down its ResizeObserver) -- stops polling once this widget
  // instance is gone rather than leaking an interval that keeps calling
  // desk.fs.readFile against a detached element forever.
  dispose(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const t of this.archiveTimers.values()) clearTimeout(t);
    this.archiveTimers.clear();
  }

  // Re-reads both files and swaps in-memory state wholesale -- simpler
  // and safer than trying to diff/merge incrementally, and cheap enough
  // at this scale (a handful of open questions at a time, not hundreds)
  // to just do on every poll tick.
  private async reload(): Promise<void> {
    // Four separate awaited reads, not one Promise.all -- same
    // heterogeneous-destructure gotcha this project's pinned tsc 3.8.3
    // already has three other documented instances of (see this
    // widget's own AGENTS.md).
    const questionsFile = await this.loadJson<AgentQuestionsFile>(AGENT_QUESTIONS_PATH);
    const answersFile = await this.loadJson<AgentAnswersFile>(AGENT_ANSWERS_PATH);
    const patchesFile = await this.loadJson<AgentPatchesFile>(AGENT_PATCHES_PATH);
    const appliedFile = await this.loadJson<AppliedPatchesFile>(AGENT_PATCHES_APPLIED_PATH);

    const nextQuestions = questionsFile?.questions ?? [];
    const nextAnswers = new Map<string, AgentAnswer>();
    for (const a of answersFile?.answers ?? []) nextAnswers.set(a.questionId, a);
    const nextPatches = patchesFile?.patches ?? [];
    const appliedMap = new Map<string, AppliedPatch>();
    for (const a of appliedFile?.applied ?? []) appliedMap.set(a.patchId, a);

    const changed =
      nextQuestions.length !== this.questions.length ||
      nextAnswers.size !== this.answers.size ||
      nextQuestions.some((q, i) => q.id !== this.questions[i]?.id) ||
      nextPatches.length !== this.patches.length;
    this.questions = nextQuestions;
    this.answers = nextAnswers;
    this.patches = nextPatches;

    // Apply any patch not yet acked -- see `applyingPatches`'s own
    // comment for why this is guarded.
    let appliedSomething = false;
    if (!this.applyingPatches) {
      const toApply = nextPatches.filter((p) => !appliedMap.has(p.id));
      if (toApply.length > 0) {
        this.applyingPatches = true;
        try {
          for (const patch of toApply) {
            const record = await this.applyPatch(patch);
            appliedMap.set(record.patchId, record);
            appliedSomething = true;
          }
        } finally {
          this.applyingPatches = false;
        }
      }
    }

    // Always resynced wholesale from (the now possibly-just-updated)
    // appliedMap, not incrementally appended -- so a patch acked (or
    // resolved via OK/Undo/Reset) by a DIFFERENT widget instance between
    // polls shows up here too, same "re-read rather than trust in-memory
    // state alone" reasoning appendAnswer's own comment already
    // documents for the question/answer side of this file. Split into
    // two lists by `resolution`, not filtered in one shared list and
    // branched at render time, so both reload() and render() stay simple
    // -- live ('ok'-resolved and unresolved both still show live? no:
    // ONLY unresolved) vs archived ('ok'-resolved) vs retired
    // ('undo'-resolved, shown nowhere as its own item -- see this file's
    // own header comment).
    const described = Array.from(appliedMap.values()).map((a) => this.describeAppliedPatch(a, nextPatches));
    this.recentApplied = described
      .filter((a) => !a.resolution)
      .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
      .slice(0, AGENT_PATCH_VISIBLE_HISTORY);
    this.archivedPatches = described.filter((a) => a.resolution === 'ok');

    if ((changed || appliedSomething) && this.loaded) this.onChanged();
  }

  private async loadJson<T>(path: string): Promise<T | null> {
    const desk = window.desk;
    if (!desk) return null;
    try {
      const { contents } = await desk.fs.readFile(path);
      return JSON.parse(contents) as T;
    } catch {
      return null; // no file yet, or unreadable -- treated as "nothing there," not an error
    }
  }

  // ── Sidebar ──

  // A question is "resolved" once it has an answer -- used both to
  // decide which list (main vs archive) it belongs in and, combined with
  // `archivingQuestions`, exactly when the animated placeholder shows
  // instead of either. See this file's own header comment's "Archiving"
  // section for why there's no separately-tracked archived flag.
  private isQuestionResolved(q: AgentQuestion): boolean {
    return this.answers.has(q.id);
  }

  summary(): string {
    if (!this.loaded) return 'Loading…';
    const pending = this.questions.filter((q) => !this.isQuestionResolved(q) || this.archivingQuestions.has(q.id));
    const total = pending.length;
    const autoNote = this.recentApplied.length > 0 ? ` ${this.recentApplied.length} applied automatically.` : '';
    if (total === 0) return `No open questions from the agent right now.${autoNote}`;
    const answered = pending.filter((q) => this.answers.has(q.id)).length; // mid-archive-animation ones only, see `pending`'s own filter
    return `${answered}/${total} answered.${autoNote}`;
  }

  // The "applied automatically" list -- see this file's own header
  // comment's AgentPatchChannel section for why this exists at all
  // (nothing here applies silently). Rendered above the question list
  // regardless of whether any questions are pending, so it's never
  // hidden behind an empty-state message. Each row is either mid-archive
  // (a placeholder, see archivingPatches) or a normal summary row with
  // OK/Undo buttons -- a row that failed to apply (status === 'error')
  // gets neither, nothing to OK or undo for a change that never happened.
  private renderAutoApplied(): string {
    if (this.recentApplied.length === 0) return '';
    const rows = this.recentApplied
      .map((a) => {
        const archivingKind = this.archivingPatches.get(a.patchId);
        if (archivingKind) {
          const message = archivingKind === 'ok' ? '⚡ OK’d — archiving…' : '↩ Undone — converted to a pending question.';
          return `<div class="qa-auto-row qa-archiving" data-patch-id="${escapeHtml(a.patchId)}">
            <div class="qa-archiving-message">${message}</div>
          </div>`;
        }
        const ok = a.status === 'applied';
        const time = new Date(a.appliedAt).toLocaleTimeString();
        const actions = ok
          ? `<div class="qa-actions">
              <button type="button" class="qa-ok-button qa-patch-ok-button" data-patch-id="${escapeHtml(a.patchId)}">✓ OK</button>
              <button type="button" class="qa-undo-button qa-patch-undo-button" data-patch-id="${escapeHtml(a.patchId)}">↩ Undo</button>
            </div>`
          : '';
        return `<div class="qa-auto-row${ok ? '' : ' qa-auto-row-error'}" data-patch-id="${escapeHtml(a.patchId)}">
          <div class="qa-auto-summary">${ok ? '⚡' : '⚠️'} ${escapeHtml(a.summary)}</div>
          ${a.reason ? `<div class="qa-auto-reason">${escapeHtml(a.reason)}</div>` : ''}
          <div class="qa-auto-time">${escapeHtml(time)}</div>
          ${actions}
        </div>`;
      })
      .join('');
    return `<div class="qa-auto-applied-section">
      <div class="qa-auto-applied-title">⚡ Applied automatically -- no confirmation needed</div>
      ${rows}
    </div>`;
  }

  render(): string {
    if (!this.loaded) return '';
    const autoSection = this.renderAutoApplied();
    const pending = this.questions.filter((q) => !this.isQuestionResolved(q) || this.archivingQuestions.has(q.id));
    const questionsSection =
      pending.length === 0
        ? '<div class="qa-empty">No open questions from the agent right now -- one posted mid-conversation shows up here within a few seconds, no reload needed.</div>'
        : // Most recent first -- an agent asking a fresh question mid
          // -session is more likely what you want to see than one from a
          // while ago.
          [...pending].reverse().map((q) => this.renderQuestionCard(q)).join('');
    return autoSection + questionsSection + this.renderArchiveDrawer();
  }

  // One question card -- either the archiving placeholder (see
  // archivingQuestions) or the real card body, branched per `q.type`
  // (renderConnectionCardBody / renderMinorBandCardBody) since the two
  // question types' own `data` shapes share almost nothing beyond
  // `plan`.
  private renderQuestionCard(q: AgentQuestion): string {
    const archivingDecision = this.archivingQuestions.get(q.id);
    if (archivingDecision) {
      const message = archivingDecision === 'confirm' ? '✓ Confirmed — archiving…' : '✗ Rejected — archiving…';
      return `<div class="qa-card qa-archiving" data-question-id="${escapeHtml(q.id)}">
        <div class="qa-archiving-message">${message}</div>
      </div>`;
    }
    // 'adjust-image-transform' has no `plan` chip (no concept of one)
    // and its own Lock In/Cancel footer instead of Confirm/Reject --
    // different enough from the other two types' shared card shape that
    // it builds its own whole card rather than slotting into this one.
    if (q.type === 'adjust-image-transform') return this.renderImageAdjustCard(q);

    const answer = this.answers.get(q.id);
    const answeredBadge = answer ? `<div class="qa-answered-badge">✓ ${answer.decision === 'confirm' ? 'Confirmed' : 'Rejected'}</div>` : '';
    const busy = this.busyIds.has(q.id);
    const body = q.type === 'confirm-connection' ? this.renderConnectionCardBody(q) : this.renderMinorBandCardBody(q);
    return `<div class="qa-card${answer ? ' answered' : ''}" data-question-id="${escapeHtml(q.id)}">
      <div class="qa-card-header">
        <span class="qa-plan-chip">${escapeHtml(QA_PLAN_LABEL[(q.data as ConfirmConnectionQuestionData | ConfirmMinorBandPatchData).plan])}</span>
        <button type="button" class="qa-show-me-button qa-agent-show-me-button" data-question-id="${escapeHtml(q.id)}">📍 Show me</button>
      </div>
      ${body}
      ${answeredBadge}
      <div class="qa-actions">
        <button type="button" class="qa-accept-button qa-agent-confirm-button" data-question-id="${escapeHtml(q.id)}" ${answer || busy ? 'disabled' : ''}>✅ Confirm</button>
        <button type="button" class="qa-reject-button qa-agent-reject-button" data-question-id="${escapeHtml(q.id)}" ${answer || busy ? 'disabled' : ''}>❌ Reject</button>
      </div>
    </div>`;
  }

  private renderConnectionCardBody(q: AgentQuestion): string {
    const data = q.data as ConfirmConnectionQuestionData;
    const gapLine = data.distancePx !== null ? `${data.source} connection, ${data.distancePx.toFixed(1)}px gap` : `${data.source} connection`;
    return `<div class="qa-reason-line">${escapeHtml(q.prompt)}</div>
      <div class="qa-ocr-line">${escapeHtml(gapLine)}${data.elevationM !== null ? ` — ${data.elevationM}m` : ''}</div>`;
  }

  // Read-only summary of the agent's own fragment/elevation choices --
  // confirming here accepts them as-is; re-editing individual fragment
  // elevations is the Minor Bands tab's own job, not duplicated here.
  private renderMinorBandCardBody(q: AgentQuestion): string {
    const data = q.data as ConfirmMinorBandPatchData;
    const fragLabels = data.fragments.map((f) => `#${f.fragmentId}${f.elevationM !== null ? ` (${f.elevationM}m)` : ''}`).join(', ');
    return `<div class="qa-reason-line">${escapeHtml(q.prompt)}</div>
      <div class="qa-ocr-line">Between ${data.elevLow}m and ${data.elevHigh}m — ${data.fragments.length} fragment(s): ${escapeHtml(fragLabels)}</div>`;
  }

  // ── 'adjust-image-transform' ──

  // Lazily seeds a working (not-yet-locked-in) copy from the question's
  // own `data` (the initial guess) the first time it's touched --
  // SEPARATE from `data` itself so Cancel can just drop the working copy
  // and the original guess is still there next time. See this
  // controller's own "working state" class-field comment.
  private workingImageDataFor(q: AgentQuestion): AdjustImageTransformQuestionData {
    let working = this.imageAdjustments.get(q.id);
    if (!working) {
      working = { ...(q.data as AdjustImageTransformQuestionData) };
      this.imageAdjustments.set(q.id, working);
    }
    return working;
  }

  // SamothraceMapElement's own read side -- called every redraw
  // (positionImageOverlay) to know whether/where/how to show the live
  // `<img>` overlay. At most one UNANSWERED 'adjust-image-transform'
  // question is ever "active" at a time (the first one found) -- see
  // this controller's own "working state" field comment on why that's a
  // safe assumption to make here rather than threading a questionId
  // through from the caller.
  getActiveImageAdjustment(): { questionId: string; data: AdjustImageTransformQuestionData } | null {
    const q = this.questions.find((x) => x.type === 'adjust-image-transform' && !this.answers.has(x.id));
    if (!q) return null;
    return { questionId: q.id, data: this.workingImageDataFor(q) };
  }

  // SamothraceMapElement's own drag handler calls this directly (not a
  // constructor callback -- this is main-element-initiated, not
  // tab-initiated, same shape as e.g. contoursLayer's own public setters
  // other controllers already call directly).
  updateImageAdjustmentPosition(questionId: string, centerLon: number, centerLat: number): void {
    const working = this.imageAdjustments.get(questionId);
    if (!working) return;
    working.centerLon = centerLon;
    working.centerLat = centerLat;
    this.scheduleRedraw();
  }

  private renderImageAdjustCard(q: AgentQuestion): string {
    const answer = this.answers.get(q.id);
    if (answer) {
      return `<div class="qa-card answered" data-question-id="${escapeHtml(q.id)}">
        <div class="qa-card-header"><span class="qa-plan-chip">Imagery</span></div>
        <div class="qa-reason-line">${escapeHtml(q.prompt)}</div>
        <div class="qa-answered-badge">✓ Locked in</div>
      </div>`;
    }
    const working = this.workingImageDataFor(q);
    const busy = this.busyIds.has(q.id);
    const errorLine = this.imageTransformError
      ? `<div class="qa-img-status qa-img-status-error">⚠️ ${escapeHtml(this.imageTransformError)}</div>`
      : '';
    const sliderRow = (field: string, label: string, min: number, max: number, step: number, value: number, suffix: string, decimals: number): string => `
      <div class="qa-img-slider-row" data-field="${field}">
        <label>${label} <span class="qa-img-readout">${value.toFixed(decimals)}${suffix}</span></label>
        <input type="range" class="qa-img-slider" data-field="${field}" data-question-id="${escapeHtml(q.id)}" min="${min}" max="${max}" step="${step}" value="${value}" ${busy ? 'disabled' : ''} />
      </div>`;
    return `<div class="qa-card" data-question-id="${escapeHtml(q.id)}">
      <div class="qa-card-header"><span class="qa-plan-chip">Imagery</span></div>
      <div class="qa-reason-line">${escapeHtml(q.prompt)}</div>
      <div class="qa-img-hint">Drag the image directly on the map to reposition it. Adjust below until it lines up, then Lock In.</div>
      ${errorLine}
      ${sliderRow('rotateDeg', 'Rotation', -180, 180, 1, working.rotateDeg, '°', 0)}
      ${sliderRow('userScale', 'Scale', 0.3, 3, 0.01, working.userScale, '×', 2)}
      ${sliderRow('tiltXDeg', 'Tilt X (left/right)', -60, 60, 1, working.tiltXDeg, '°', 0)}
      ${sliderRow('tiltYDeg', 'Tilt Y (up/down)', -60, 60, 1, working.tiltYDeg, '°', 0)}
      <div class="qa-actions">
        <button type="button" class="qa-accept-button qa-img-lock-in-button" data-question-id="${escapeHtml(q.id)}" ${busy ? 'disabled' : ''}>🔒 Lock In</button>
        <button type="button" class="qa-reject-button qa-img-cancel-button" data-question-id="${escapeHtml(q.id)}" ${busy ? 'disabled' : ''}>Cancel</button>
      </div>
    </div>`;
  }

  attachHandlers(container: HTMLElement): void {
    container.querySelectorAll<HTMLButtonElement>('.qa-agent-show-me-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = this.questions.find((x) => x.id === btn.dataset.questionId);
        if (!q) return;
        if (q.type === 'confirm-connection') {
          const data = q.data as ConfirmConnectionQuestionData;
          this.recording.log('qa:agent', 'show-me', { questionId: q.id, connectionId: data.connectionId });
          const west = Math.min(data.aLon, data.bLon);
          const east = Math.max(data.aLon, data.bLon);
          const south = Math.min(data.aLat, data.bLat);
          const north = Math.max(data.aLat, data.bLat);
          const fragmentIds = [data.aFragmentId, data.bFragmentId].filter((id): id is number => id !== null);
          this.onShowMe(data.plan, { west, south, east, north }, fragmentIds);
          this.highlightGap(data);
        } else {
          const data = q.data as ConfirmMinorBandPatchData;
          this.recording.log('qa:agent', 'show-me', { questionId: q.id, groupId: data.groupId });
          this.onShowMeFragments(
            data.plan,
            data.fragments.map((f) => f.fragmentId),
          );
        }
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-agent-confirm-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.questionId;
        if (id) void this.answer(id, 'confirm');
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-agent-reject-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.questionId;
        if (id) void this.answer(id, 'reject');
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-patch-ok-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.patchId;
        if (id) void this.resolvePatchOk(id);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-patch-undo-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.patchId;
        if (id) void this.undoPatch(id);
      });
    });

    // ── 'adjust-image-transform' sliders ──
    // Direct DOM mutation on `input` (not this.onChanged()) -- same
    // reasoning the Connector tab's own "Max suggested gap" slider
    // already follows: re-rendering the whole card on every tick would
    // recreate the slider mid-drag, which browsers handle badly (focus/
    // drag state lost). The working copy (this.imageAdjustments) is the
    // actual source of truth; the DOM readout text is just kept in sync
    // alongside it.
    container.querySelectorAll<HTMLInputElement>('.qa-img-slider').forEach((input) => {
      input.addEventListener('input', () => {
        const questionId = input.dataset.questionId;
        const field = input.dataset.field;
        if (!questionId || !field) return;
        const working = this.imageAdjustments.get(questionId);
        if (!working) return;
        const value = Number(input.value);
        if (field === 'rotateDeg') working.rotateDeg = value;
        else if (field === 'userScale') working.userScale = value;
        else if (field === 'tiltXDeg') working.tiltXDeg = value;
        else if (field === 'tiltYDeg') working.tiltYDeg = value;
        const readout = input.closest('.qa-img-slider-row')?.querySelector('.qa-img-readout');
        if (readout) readout.textContent = field === 'userScale' ? `${value.toFixed(2)}×` : `${value.toFixed(0)}°`;
        this.scheduleRedraw();
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-img-lock-in-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.questionId;
        if (id) void this.applyImageTransform(id);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-img-cancel-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.questionId;
        if (id) this.cancelImageAdjustment(id);
      });
    });

    // ── Archive drawer ──
    const drawerBody = container.querySelector<HTMLElement>('.qa-archive-body');
    const chevron = container.querySelector<HTMLElement>('.qa-archive-chevron');
    container.querySelector<HTMLButtonElement>('.qa-archive-toggle')?.addEventListener('click', () => {
      this.archiveDrawerOpen = !this.archiveDrawerOpen;
      // Direct DOM manipulation, NOT this.onChanged() -- see this file's
      // own header comment's "Archive drawer" section on why a plain CSS
      // `transition` needs this element to stay the SAME node across the
      // toggle, not be recreated by a fresh innerHTML replace.
      drawerBody?.classList.toggle('open', this.archiveDrawerOpen);
      chevron?.classList.toggle('open', this.archiveDrawerOpen);
    });
    container.querySelector<HTMLSelectElement>('.qa-archive-sort-select')?.addEventListener('change', (e) => {
      const value = (e.currentTarget as HTMLSelectElement).value;
      this.archiveSortBy = value === 'question-age' ? 'question-age' : 'answer-age';
      this.onChanged();
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-archive-reset-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (!id) return;
        if (btn.dataset.kind === 'question') void this.resetQuestion(id);
        else void this.resetPatch(id);
      });
    });
  }

  // Confirm/Reject path -- 'confirm-connection' and 'confirm-minor-band'
  // only. 'adjust-image-transform' has its own Lock In/Cancel path
  // (applyImageTransform/cancelImageAdjustment below) with no Confirm/
  // Reject buttons rendered for it at all (see renderImageAdjustCard),
  // so this should never actually be called for one -- guarded anyway,
  // rather than relying purely on "no button exists to trigger it."
  private async answer(questionId: string, decision: AgentAnswerDecision): Promise<void> {
    if (this.busyIds.has(questionId)) return; // already mid-submit
    const q = this.questions.find((x) => x.id === questionId);
    if (!q || this.answers.has(questionId) || q.type === 'adjust-image-transform') return;
    this.busyIds.add(questionId);
    this.onChanged(); // re-render immediately so the buttons disable right away
    try {
      const ans: AgentAnswer = { questionId, decision, answeredAt: new Date().toISOString() };
      this.answers.set(questionId, ans);
      await this.appendAnswer(ans);
      if (q.type === 'confirm-connection') await this.applyConfirmConnection(q.data as ConfirmConnectionQuestionData, decision);
      else await this.applyMinorBandDecision(q.data as ConfirmMinorBandPatchData, decision);
      this.startArchiving(questionId, this.archivingQuestions, decision);
    } finally {
      this.busyIds.delete(questionId);
      this.onChanged();
    }
  }

  // Lock In -- semantically this file's own Confirm path (see the
  // comment above), just with a different label and different side
  // effects: besides the normal AgentAnswer, this ALSO writes the final
  // parameters into Data/mapSources/<slug>/transform.json (durable,
  // source-controllable -- the whole point, per the user's own framing
  // of this as "the first of many such map data extractions to come")
  // and calls desk.installedJobs.run('map-import-from-photo', ...) to
  // bake them into real tiles immediately.
  //
  // Best-effort on the job-run half specifically: transform.json is
  // already saved by the time that call happens, so even if
  // desk.installedJobs.run itself fails (see this method's own
  // worry about whether that Bridge-triggered path reliably gets a
  // usable project directory, same gotcha
  // desk-installed-jobs/map-import-from-photo/main.py's own header
  // comment documents for the agent-triggered MCP path), nothing is
  // lost -- the parameters are safely on disk either way, and the job
  // can always be run again afterward (by the agent, or by Lock-In-ing
  // again).
  private async applyImageTransform(questionId: string): Promise<void> {
    if (this.busyIds.has(questionId)) return;
    const q = this.questions.find((x) => x.id === questionId);
    if (!q || this.answers.has(questionId) || q.type !== 'adjust-image-transform') return;
    const working = this.workingImageDataFor(q);
    this.busyIds.add(questionId);
    this.imageTransformError = null;
    this.onChanged();
    try {
      const desk = window.desk;
      if (!desk) throw new Error('Desk bridge unavailable');
      await desk.fs.writeFile(`Data/mapSources/${working.slug}/transform.json`, JSON.stringify(working, null, 2));

      const ans: AgentAnswer = { questionId, decision: 'confirm', answeredAt: new Date().toISOString() };
      this.answers.set(questionId, ans);
      await this.appendAnswer(ans);

      // An Installed Job gets neither a reliable cwd nor a reliable
      // DESK_PROJECT_DIR env var (confirmed by real failed runs -- see
      // map-import-from-photo/main.py's own _project_dir_and_slug
      // comment), so project_dir must be passed explicitly here, same as
      // the agent's own MCP-tool-triggered runs already do.
      // self.getManifest() needs no capability declaration of its own.
      const manifest = await desk.self.getManifest();
      const configPath = `.desk_temp/map-import-from-photo-config-${working.slug}.json`;
      await desk.fs.writeFile(
        configPath,
        JSON.stringify({ project_dir: manifest.directory, slug: working.slug }, null, 2)
      );
      const result = await desk.installedJobs.run('map-import-from-photo', configPath);
      this.recording.log('qa:agent', 'image-transform-locked-in', { questionId, slug: working.slug, ok: result.ok, data: working });
      if (result.ok) {
        this.onImageTransformApplied(working.layerId);
      } else {
        // Not fatal -- see this method's own header comment. Surfaced
        // in the card (re-rendered below, archiving hasn't started yet
        // so the error line is still visible) rather than only in the
        // recording log, since there's no guarantee anyone's watching
        // that log right now.
        this.imageTransformError = `Tiles weren't regenerated automatically (${result.stderr || result.traceback || 'unknown error'}) -- parameters are saved; ask the agent to run map-import-from-photo manually.`;
      }
      this.startArchiving(questionId, this.archivingQuestions, 'confirm');
    } catch (err) {
      this.imageTransformError = err instanceof Error ? err.message : String(err);
    } finally {
      this.imageAdjustments.delete(questionId);
      this.busyIds.delete(questionId);
      this.onChanged();
    }
  }

  // Cancel -- abandons the current working adjustment (reverts to the
  // original guess next time this question is touched) WITHOUT
  // answering the question; it stays pending. Nothing durable to undo
  // (transform.json is only ever written by a successful Lock In).
  private cancelImageAdjustment(questionId: string): void {
    this.imageAdjustments.delete(questionId);
    this.imageTransformError = null;
    this.onChanged();
    this.scheduleRedraw();
  }

  // Shared by both archiving flavors (questions and applied-patch rows) --
  // just the placeholder-timing mechanics (set the phase-map entry, show
  // it, clear it again after QA_ARCHIVE_DELAY_MS). `value` is whatever
  // the placeholder render needs to know (which decision, or 'ok'/'undo')
  // to word itself correctly; this method itself doesn't interpret it.
  // Does NOT itself make anything "archived" -- that's a derived status
  // (see isQuestionResolved / AppliedPatch.resolution); the CALLER is
  // responsible for whatever durable state change makes the derived
  // status true BEFORE calling this (resolvePatchOk/undoPatch both write
  // `resolution` first) or AS a side effect already completed (answer()
  // already wrote the AgentAnswer before calling this).
  private startArchiving<V>(id: string, phaseMap: Map<string, V>, value: V): void {
    const existingTimer = this.archiveTimers.get(id);
    if (existingTimer !== undefined) clearTimeout(existingTimer);
    phaseMap.set(id, value);
    this.onChanged();
    const timer = (setTimeout(() => {
      phaseMap.delete(id);
      this.archiveTimers.delete(id);
      this.onChanged();
    }, QA_ARCHIVE_DELAY_MS) as unknown) as number;
    this.archiveTimers.set(id, timer);
  }

  // Reverses whichever live change a confirm-connection/confirm-minor
  // -band/retract-connection decision made -- shared by undoPatch (an
  // applied-patch row's own Undo button) and resetQuestion (the archive
  // drawer's own Reset button, for a question that was CONFIRMED -- a
  // rejected one never applied anything, nothing to reverse; questions
  // are never 'retract-connection', only patches are, so resetQuestion
  // only ever actually exercises the first two branches). Delegates to
  // the exact same callbacks/methods either caller would use directly:
  // onUndoConnection (shares ContourConnectorTabController's own
  // "Remove" path) for confirm-connection, removeMinorBandAnswer +
  // onBandUndo for confirm-minor-band, or a straight re-apply via
  // applyConfirmConnection for retract-connection -- "reversing a
  // retraction" IS a confirmation, the exact same one that was retracted,
  // same `data` either way.
  private async reverseAppliedDecision(type: AgentPatchType, data: ConfirmConnectionQuestionData | ConfirmMinorBandPatchData): Promise<void> {
    if (type === 'confirm-connection') {
      const d = data as ConfirmConnectionQuestionData;
      this.onUndoConnection(d.connectionId, d.plan);
      return;
    }
    if (type === 'retract-connection') {
      await this.applyConfirmConnection(data as ConfirmConnectionQuestionData, 'confirm', 'agent-autonomous');
      return;
    }
    const d = data as ConfirmMinorBandPatchData;
    await this.removeMinorBandAnswer(d.plan, d.groupId);
    this.onBandUndo(
      d.plan,
      d.fragments.map((f) => f.fragmentId),
    );
  }

  // Undo button on an applied-patch row -- reverses whichever live
  // change that patch made (reverseAppliedDecision above), then converts
  // it into a brand-new pending question carrying the original patch's
  // own `data`/`reason` (see convertPatchToQuestion) so nothing the agent
  // found is actually lost, just handed back for a real human decision.
  // Best-effort end to end, same standard applyPatch already holds to --
  // a failure here still archives the row (nothing worse than "stuck
  // showing stale OK/Undo buttons forever" would come from NOT archiving
  // it) rather than leaving the user staring at buttons that already
  // tried and failed. `resolution: 'undo'` is written durably BEFORE the
  // archive animation starts, not after, so a reload mid-animation still
  // reflects the undo having happened -- see AppliedPatch.resolution's
  // own comment.
  private async undoPatch(patchId: string): Promise<void> {
    if (this.archivingPatches.has(patchId)) return; // already resolving
    const patch = this.patches.find((p) => p.id === patchId);
    if (patch) {
      try {
        await this.reverseAppliedDecision(patch.type, patch.data);
        await this.convertPatchToQuestion(patch);
      } catch (err) {
        console.warn('undoing agent patch failed (best-effort, archiving anyway):', err);
      }
    }
    await this.writePatchResolution(patchId, 'undo');
    this.startArchiving(patchId, this.archivingPatches, 'undo');
  }

  // OK button on an applied-patch row -- purely a dismiss, no live state
  // to touch (unlike Undo). `resolution: 'ok'` written durably up front,
  // same reload-safety reasoning as undoPatch's own comment.
  private async resolvePatchOk(patchId: string): Promise<void> {
    if (this.archivingPatches.has(patchId)) return;
    await this.writePatchResolution(patchId, 'ok');
    this.startArchiving(patchId, this.archivingPatches, 'ok');
  }

  // Read-modify-write, same pattern every other durable log/ack file in
  // this widget uses. Finds the existing AppliedPatch record (written
  // once, durably, by appendAppliedPatch back when the patch itself was
  // first applied) and stamps `resolution`/`resolvedAt` onto it -- this
  // is an UPDATE, not an append; if the record is somehow already gone
  // (shouldn't happen, patches are never deleted from the ack file),
  // this silently does nothing rather than fabricate a new record with
  // no `status`/`appliedAt` of its own.
  private async writePatchResolution(patchId: string, resolution: 'ok' | 'undo'): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const current = (await this.loadJson<AppliedPatchesFile>(AGENT_PATCHES_APPLIED_PATH)) ?? { applied: [] };
    const existing = current.applied.find((a) => a.patchId === patchId);
    if (!existing) return;
    existing.resolution = resolution;
    existing.resolvedAt = new Date().toISOString();
    await desk.fs.writeFile(AGENT_PATCHES_APPLIED_PATH, JSON.stringify(current, null, 2));
  }

  // Archive drawer's own Reset button, patch side -- the exact inverse
  // of resolvePatchOk: clears `resolution`/`resolvedAt` so the row goes
  // back to being derived as "live" again (see reload()'s own
  // recentApplied/archivedPatches split) and reappears in the "applied
  // automatically" list with OK/Undo buttons. Only meaningful for an
  // 'ok'-resolved row -- an 'undo'-resolved one is never shown in the
  // archive drawer in the first place (see computeArchivedItems), so
  // there's no Reset button that could call this for one.
  private async resetPatch(patchId: string): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const current = (await this.loadJson<AppliedPatchesFile>(AGENT_PATCHES_APPLIED_PATH)) ?? { applied: [] };
    const existing = current.applied.find((a) => a.patchId === patchId);
    if (!existing) return;
    delete existing.resolution;
    delete existing.resolvedAt;
    await desk.fs.writeFile(AGENT_PATCHES_APPLIED_PATH, JSON.stringify(current, null, 2));
    this.onChanged();
  }

  // Archive drawer's own Reset button, question side -- undoes the
  // original Confirm/Reject: reverses whatever got applied (only if the
  // answer was 'confirm' -- a 'reject' never applied anything) via the
  // same reverseAppliedDecision Undo uses, then removes the AgentAnswer
  // entirely so the question is pending again, full stop -- no "convert
  // to a question" step needed here (unlike undoPatch), since this
  // question never stopped existing in AGENT_QUESTIONS_PATH in the first
  // place, only its ANSWER is being retracted.
  private async resetQuestion(questionId: string): Promise<void> {
    const q = this.questions.find((x) => x.id === questionId);
    const ans = this.answers.get(questionId);
    if (!q || !ans) return;
    try {
      // 'adjust-image-transform' has no live-state reversal of its own
      // (see this widget's own TODO.md on this being a known,
      // deliberately-accepted simplification for this first version) --
      // Reset still removes the answer below either way, which for THIS
      // type just means "show the adjustment card again, re-adjust and
      // Lock In whenever" -- a perfectly reasonable "I want to redo
      // this" interpretation, so no special-casing needed beyond
      // skipping the reversal call itself.
      if (ans.decision === 'confirm' && q.type !== 'adjust-image-transform') {
        await this.reverseAppliedDecision(q.type as AgentPatchType, q.data as ConfirmConnectionQuestionData | ConfirmMinorBandPatchData);
      }
    } catch (err) {
      console.warn('reversing answer during reset failed (best-effort, resetting anyway):', err);
    }
    this.answers.delete(questionId);
    await this.removeAnswer(questionId);
    this.onChanged();
  }

  private async removeAnswer(questionId: string): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const current = (await this.loadJson<AgentAnswersFile>(AGENT_ANSWERS_PATH)) ?? { answers: [] };
    current.answers = current.answers.filter((a) => a.questionId !== questionId);
    await desk.fs.writeFile(AGENT_ANSWERS_PATH, JSON.stringify(current, null, 2));
  }

  // ── Archive drawer ──

  // Unifies archived questions and archived ('ok'-resolved) patches into
  // one sortable list -- see ArchivedItemDisplay's own comment. An
  // 'undo'-resolved patch is deliberately excluded (not just filtered at
  // render time but never computed here at all) -- its lineage continues
  // via the question convertPatchToQuestion wrote; showing the old
  // applied-row too would just be a confusing duplicate of that new,
  // separately-archivable question.
  private computeArchivedItems(): ArchivedItemDisplay[] {
    const items: ArchivedItemDisplay[] = [];
    for (const q of this.questions) {
      const ans = this.answers.get(q.id);
      if (!ans || this.archivingQuestions.has(q.id)) continue;
      // 'adjust-image-transform' doesn't fit summarizeDecisionData's own
      // connection/minor-band-shaped fields (no .source/.groupId etc.) --
      // its own short summary instead.
      const summary =
        q.type === 'adjust-image-transform'
          ? `Image layer "${(q.data as AdjustImageTransformQuestionData).slug}" adjustment`
          : summarizeDecisionData(q.type as AgentPatchType, q.data as ConfirmConnectionQuestionData | ConfirmMinorBandPatchData);
      items.push({
        kind: 'question',
        id: q.id,
        summary,
        resolutionLabel: ans.decision === 'confirm' ? 'Confirmed' : 'Rejected',
        createdAt: q.createdAt,
        resolvedAt: ans.answeredAt,
      });
    }
    for (const p of this.archivedPatches) {
      items.push({
        kind: 'patch',
        id: p.patchId,
        summary: p.summary,
        resolutionLabel: 'OK’d',
        createdAt: p.createdAt,
        resolvedAt: p.resolvedAt ?? p.appliedAt, // resolvedAt is always set for anything in archivedPatches (that's what the 'ok' filter means) -- the fallback is just to satisfy the type, never actually exercised
      });
    }
    return items;
  }

  // "Ascending age" = smallest elapsed-time-since first -- i.e. the most
  // RECENTLY created/resolved item sorts first, same "most recent first"
  // convention the main question list's own ordering already uses.
  // ISO-8601 timestamps sort correctly as plain strings (lexicographic
  // order matches chronological order), so no Date parsing needed.
  private sortArchivedItems(items: ArchivedItemDisplay[]): ArchivedItemDisplay[] {
    const key: keyof Pick<ArchivedItemDisplay, 'createdAt' | 'resolvedAt'> = this.archiveSortBy === 'question-age' ? 'createdAt' : 'resolvedAt';
    return [...items].sort((a, b) => b[key].localeCompare(a[key]));
  }

  // Always rendered (even with zero archived items -- a collapsed
  // "Archive (0)" bar is simpler and more predictable than conditionally
  // showing/hiding the whole drawer). Pinned toward the bottom of the
  // tab via CSS (`margin-top: auto` inside the flex column, `position:
  // sticky` so it stays visible while scrolling a long question list) --
  // see widget.html's own `.qa-archive-drawer` rule.
  private renderArchiveDrawer(): string {
    const items = this.sortArchivedItems(this.computeArchivedItems());
    const openClass = this.archiveDrawerOpen ? ' open' : '';
    const rows =
      items.length === 0
        ? '<div class="qa-empty">Nothing archived yet.</div>'
        : items
            .map(
              (it) => `<div class="qa-archive-row">
                <div class="qa-archive-row-summary">${escapeHtml(it.resolutionLabel)} — ${escapeHtml(it.summary)}</div>
                <div class="qa-archive-row-time">Asked ${escapeHtml(new Date(it.createdAt).toLocaleString())} · Resolved ${escapeHtml(new Date(it.resolvedAt).toLocaleString())}</div>
                <button type="button" class="qa-reset-button qa-archive-reset-button" data-kind="${it.kind}" data-id="${escapeHtml(it.id)}">↺ Reset</button>
              </div>`,
            )
            .join('');
    return `<div class="qa-archive-drawer">
      <button type="button" class="qa-archive-toggle">
        <span>📦 Archive (${items.length})</span>
        <span class="qa-archive-chevron${openClass}">▲</span>
      </button>
      <div class="qa-archive-body${openClass}">
        <div class="qa-archive-controls">
          Sort by
          <select class="qa-archive-sort-select">
            <option value="answer-age" ${this.archiveSortBy === 'answer-age' ? 'selected' : ''}>Answer age</option>
            <option value="question-age" ${this.archiveSortBy === 'question-age' ? 'selected' : ''}>Question age</option>
          </select>
        </div>
        ${rows}
      </div>
    </div>`;
  }

  // Removes one answer from MINOR_BAND_LOG_PATH by its `${plan}:${groupId}`
  // key -- the minor-band side of Undo. No equivalent "remove" method to
  // delegate to elsewhere (unlike the connection case's
  // ContourConnectorTabController.removeConfirmedById) since
  // MinorBandsTabController has no undo UI of its own yet -- this file
  // already writes MINOR_BAND_LOG_PATH directly elsewhere
  // (applyMinorBandDecision), same read-modify-write pattern here.
  private async removeMinorBandAnswer(plan: QaPlan, groupId: string): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const current = (await this.loadJson<{ answers: MinorBandGroupAnswer[] }>(MINOR_BAND_LOG_PATH)) ?? { answers: [] };
    const key = `${plan}:${groupId}`;
    current.answers = current.answers.filter((a) => `${a.plan}:${a.groupId}` !== key);
    await desk.fs.writeFile(MINOR_BAND_LOG_PATH, JSON.stringify(current, null, 2));
  }

  // The "so as not to lose the agent's change" half of Undo -- writes a
  // fresh AgentQuestion (own uuid, so it can never collide with the
  // original patch's own id even though that one's now fully resolved)
  // carrying the SAME `data` and a prompt built from the SAME `reason`
  // the patch originally had, into AGENT_QUESTIONS_PATH. The next poll
  // (within AGENT_QA_POLL_INTERVAL_MS) picks it up the exact same way
  // any other agent-authored question would -- no special-casing needed
  // on the read side, it's indistinguishable from a question an agent
  // asked directly in the first place. `'retract-connection'` maps to
  // the `'confirm-connection'` QUESTION type -- there's no
  // "retract-connection" question type (questions ask "should this be
  // confirmed," never "should this be retracted"), and by the time this
  // runs reverseAppliedDecision has already RE-CONFIRMED the connection
  // (undoing the retraction), so "is this connection correct?" is
  // exactly the right question to leave pending.
  private async convertPatchToQuestion(patch: AgentPatch): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const question: AgentQuestion = {
      id: crypto.randomUUID(),
      type: patch.type === 'retract-connection' ? 'confirm-connection' : patch.type,
      prompt: `Previously applied automatically — undone. Original reasoning: ${patch.reason}`,
      createdAt: new Date().toISOString(),
      data: patch.data,
    };
    const current = (await this.loadJson<AgentQuestionsFile>(AGENT_QUESTIONS_PATH)) ?? { questions: [] };
    current.questions.push(question);
    await desk.fs.writeFile(AGENT_QUESTIONS_PATH, JSON.stringify(current, null, 2));
  }

  private async appendAnswer(ans: AgentAnswer): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    // Read-modify-write, same pattern every other durable log file in
    // this widget already uses -- re-reads from disk rather than
    // trusting in-memory state alone, so an answer appended by a
    // DIFFERENT Desk instance/session between this tab's last poll and
    // now isn't clobbered.
    const current = (await this.loadJson<AgentAnswersFile>(AGENT_ANSWERS_PATH)) ?? { answers: [] };
    if (!current.answers.some((a) => a.questionId === ans.questionId)) current.answers.push(ans);
    await desk.fs.writeFile(AGENT_ANSWERS_PATH, JSON.stringify(current, null, 2));
    this.recording.log('qa:agent', 'answer', ans); // informational only -- see this file's own header comment on why this never gates the write above
  }

  // Highlights the gap a 'confirm-connection' question is asking about --
  // a straight candy-cane line directly between its own two endpoints,
  // since (unlike a real fragment) the gap has no existing geometry on
  // the map to overdraw. Auto-clears after AGENT_QA_HIGHLIGHT_DURATION_MS,
  // same pattern as ContoursLayerController.highlightFragments.
  private highlightGap(data: ConfirmConnectionQuestionData): void {
    if (this.highlight) clearTimeout(this.highlight.clearTimer);
    const clearTimer = (setTimeout(() => {
      this.highlight = null;
      this.scheduleRedraw();
    }, AGENT_QA_HIGHLIGHT_DURATION_MS) as unknown) as number;
    this.highlight = { aLon: data.aLon, aLat: data.aLat, bLon: data.bLon, bLat: data.bLat, clearTimer };
    this.scheduleRedraw();
  }

  // Called unconditionally every redraw (see samothrace-map.ts's own
  // render method, right after ContoursLayerController.draw) -- not
  // gated on this being the active Q&A tab, same precedent the other
  // tabs' own "Show me" highlights already set (a short-lived, timer
  // -cleared highlight staying visible across a tab switch is harmless,
  // and simpler than threading an extra visibility check through).
  draw(ctx: CanvasRenderingContext2D, toScreen: (lon: number, lat: number) => { x: number; y: number }): void {
    if (!this.highlight) return;
    const h = this.highlight;
    strokeCandyCane(ctx, [{ lon: h.aLon, lat: h.aLat }, { lon: h.bLon, lat: h.bLat }], toScreen, 4, HIGHLIGHT_COLOR);
  }

  // `appliedBy` is undefined for every call from the question/answer flow
  // above (a real user clicked Confirm/Reject) -- only AgentPatchChannel's
  // own applyPatch passes 'agent-autonomous', tagging the written
  // LogConnection entry per that field's own provenance comment in
  // samothrace-map-connector-tab.ts.
  private async applyConfirmConnection(data: ConfirmConnectionQuestionData, decision: AgentAnswerDecision, appliedBy?: 'agent-autonomous'): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const current = (await this.loadJson<{ connections: LogConnection[]; rejections: LogRejection[]; removed: string[] }>(CONNECTOR_LOG_PATH)) ?? {
      connections: [],
      rejections: [],
      removed: [],
    };
    if (decision === 'confirm') {
      if (!current.connections.some((c) => c.connectionId === data.connectionId)) {
        current.connections.push({
          connectionId: data.connectionId,
          plan: data.plan,
          source: data.source,
          aLon: data.aLon,
          aLat: data.aLat,
          bLon: data.bLon,
          bLat: data.bLat,
          elevationM: data.elevationM,
          confirmedAt: new Date().toISOString(),
          ...(appliedBy ? { appliedBy } : {}),
        });
      }
    } else if (!current.rejections.some((r) => r.connectionId === data.connectionId)) {
      current.rejections.push({ connectionId: data.connectionId, plan: data.plan, rejectedAt: new Date().toISOString() });
    }
    await desk.fs.writeFile(CONNECTOR_LOG_PATH, JSON.stringify(current, null, 2));
    this.onConnectionDecision(data, decision);
  }

  // ── AgentPatchChannel ──

  // Applies one patch end to end: the type-specific durable write +
  // live-apply callback, then an ack record (always written, success or
  // failure -- a patch that fails once is never silently retried forever;
  // an agent that wants to retry writes a NEW patch with a new id). Never
  // throws -- same "best-effort, don't throw errors if something doesn't
  // quite line up" standard this widget's own UI-state persistence
  // already follows; a bad patch becomes a visible "⚠️ Failed to apply"
  // row in renderAutoApplied, not a broken poll loop.
  private async applyPatch(patch: AgentPatch): Promise<AppliedPatch> {
    let status: AgentPatchStatus = 'applied';
    let detail: string | undefined;
    try {
      if (patch.type === 'confirm-connection') {
        const data = patch.data as ConfirmConnectionQuestionData;
        await this.applyConfirmConnection(data, 'confirm', 'agent-autonomous');
        this.highlightGap(data);
      } else if (patch.type === 'confirm-minor-band') {
        await this.applyMinorBandDecision(patch.data as ConfirmMinorBandPatchData, 'confirm', 'agent-autonomous');
      } else if (patch.type === 'retract-connection') {
        // Same removal path ContourConnectorTabController's own "Remove"
        // button and Undo (of a confirm-connection patch) already use --
        // see onUndoConnection's own constructor comment.
        const data = patch.data as ConfirmConnectionQuestionData;
        this.onUndoConnection(data.connectionId, data.plan);
      } else {
        status = 'error';
        detail = `unknown patch type "${String((patch as { type: unknown }).type)}"`;
      }
    } catch (err) {
      status = 'error';
      detail = err instanceof Error ? err.message : String(err);
    }
    const record: AppliedPatch = { patchId: patch.id, status, appliedAt: new Date().toISOString(), ...(detail ? { detail } : {}) };
    await this.appendAppliedPatch(record);
    // Informational only, same as every other recording.log call in this
    // file -- never gates whether the durable write above happened.
    this.recording.log('qa:agent-patch', 'applied', { patchId: patch.id, type: patch.type, status, reason: patch.reason });
    this.scheduleRedraw();
    return record;
  }

  // A 'confirm-minor-band' question OR patch's own apply path -- shared
  // by a real human Confirm/Reject click (answer(), `appliedBy`
  // undefined) and AgentPatchChannel's own auto-apply (applyPatch,
  // `appliedBy: 'agent-autonomous'`). Confirm writes the exact same
  // MinorBandGroupAnswer shape MinorBandsTabController.submit() would,
  // into the SAME MINOR_BAND_LOG_PATH (declared in samothrace-map-qa
  // -panel.ts, visible here the same way every other global-script
  // constant in this project is), then calls onBandConfirmed with the
  // same minorBandOverridesFrom conversion applyOverridesFor itself
  // uses, so ContoursLayerController's session-local color override goes
  // live immediately. Reject writes a 'skipped' answer with every
  // fragment's own elevationM nulled out -- same semantics
  // MinorBandsTabController's own Skip button already has -- and applies
  // nothing (there is nothing to visually undo, since nothing was ever
  // shown as a contour).
  private async applyMinorBandDecision(data: ConfirmMinorBandPatchData, decision: AgentAnswerDecision, appliedBy?: 'agent-autonomous'): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const current = (await this.loadJson<{ answers: MinorBandGroupAnswer[] }>(MINOR_BAND_LOG_PATH)) ?? { answers: [] };
    const key = `${data.plan}:${data.groupId}`;
    if (!current.answers.some((a) => `${a.plan}:${a.groupId}` === key)) {
      const answer: MinorBandGroupAnswer = {
        groupId: data.groupId,
        plan: data.plan,
        elevLow: data.elevLow,
        elevHigh: data.elevHigh,
        decision: decision === 'confirm' ? 'confirmed' : 'skipped',
        fragments: decision === 'confirm' ? data.fragments : data.fragments.map((f) => ({ fragmentId: f.fragmentId, elevationM: null })),
        answeredAt: new Date().toISOString(),
        ...(appliedBy ? { appliedBy } : {}),
      };
      current.answers.push(answer);
      await desk.fs.writeFile(MINOR_BAND_LOG_PATH, JSON.stringify(current, null, 2));
    }
    if (decision === 'confirm') {
      const overrides = minorBandOverridesFrom(data.fragments);
      if (overrides.length > 0) this.onBandConfirmed(data.plan, overrides);
    }
  }

  // Read-modify-write, same pattern every other durable log/ack file in
  // this widget uses -- re-reads from disk rather than trusting
  // in-memory state, so an ack written by a DIFFERENT widget instance
  // between this tab's last poll and now isn't clobbered.
  private async appendAppliedPatch(record: AppliedPatch): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const current = (await this.loadJson<AppliedPatchesFile>(AGENT_PATCHES_APPLIED_PATH)) ?? { applied: [] };
    if (!current.applied.some((a) => a.patchId === record.patchId)) current.applied.push(record);
    await desk.fs.writeFile(AGENT_PATCHES_APPLIED_PATH, JSON.stringify(current, null, 2));
  }

  // Builds the display row renderAutoApplied() shows for one acked
  // patch -- looks the source AgentPatch up in whatever patch list is
  // handed in (the caller passes the freshly-reloaded list, not
  // necessarily `this.patches`, so this works correctly mid-reload())
  // to recover a human-readable summary; falls back gracefully if the
  // patch itself is somehow no longer available (patches aren't expected
  // to ever be deleted from AGENT_PATCHES_PATH, but nothing here assumes
  // that holds forever).
  private describeAppliedPatch(record: AppliedPatch, patches: AgentPatch[]): AppliedPatchDisplay {
    const patch = patches.find((p) => p.id === record.patchId);
    const type: AgentPatchType = patch?.type ?? 'confirm-connection';
    const reason = patch?.reason ?? '';
    let summary = 'Patch details no longer available.';
    if (patch) {
      const verb = patch.type === 'confirm-connection' ? 'Connected a' : patch.type === 'retract-connection' ? 'Retracted a' : 'Confirmed';
      summary = `${verb} ${summarizeDecisionData(patch.type, patch.data)}`;
    }
    if (record.status === 'error') summary = `Failed to apply: ${record.detail ?? 'unknown error'}`;
    return {
      patchId: record.patchId,
      type,
      summary,
      reason,
      status: record.status,
      appliedAt: record.appliedAt,
      createdAt: patch?.createdAt ?? record.appliedAt,
      resolution: record.resolution,
      resolvedAt: record.resolvedAt,
    };
  }
}
