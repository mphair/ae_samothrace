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
// First (and currently only) question type: 'confirm-connection' -- "is
// this suggested (or already-applied) contour connection correct?"
// Deliberately starting with exactly one type rather than a general
// schema -- see this widget's own TODO.md for the open design questions
// a second type should settle (generality of the question shape, etc.).
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

type AgentQuestionType = 'confirm-connection';

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
  data: ConfirmConnectionQuestionData;
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
  }

  // Re-reads both files and swaps in-memory state wholesale -- simpler
  // and safer than trying to diff/merge incrementally, and cheap enough
  // at this scale (a handful of open questions at a time, not hundreds)
  // to just do on every poll tick.
  private async reload(): Promise<void> {
    const [questionsFile, answersFile] = [await this.loadJson<AgentQuestionsFile>(AGENT_QUESTIONS_PATH), await this.loadJson<AgentAnswersFile>(AGENT_ANSWERS_PATH)];
    const nextQuestions = questionsFile?.questions ?? [];
    const nextAnswers = new Map<string, AgentAnswer>();
    for (const a of answersFile?.answers ?? []) nextAnswers.set(a.questionId, a);

    const changed =
      nextQuestions.length !== this.questions.length ||
      nextAnswers.size !== this.answers.size ||
      nextQuestions.some((q, i) => q.id !== this.questions[i]?.id);
    this.questions = nextQuestions;
    this.answers = nextAnswers;
    if (changed && this.loaded) this.onChanged();
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

  summary(): string {
    if (!this.loaded) return 'Loading…';
    const total = this.questions.length;
    if (total === 0) return 'No open questions from the agent right now.';
    const answered = this.questions.filter((q) => this.answers.has(q.id)).length;
    return `${answered}/${total} answered.`;
  }

  render(): string {
    if (!this.loaded) return '';
    if (this.questions.length === 0) {
      return '<div class="qa-empty">No open questions from the agent right now -- one posted mid-conversation shows up here within a few seconds, no reload needed.</div>';
    }
    // Most recent first -- an agent asking a fresh question mid-session
    // is more likely what you want to see than one from a while ago.
    const ordered = [...this.questions].reverse();
    return ordered
      .map((q) => {
        const answer = this.answers.get(q.id);
        const answeredBadge = answer ? `<div class="qa-answered-badge">✓ ${answer.decision === 'confirm' ? 'Confirmed' : 'Rejected'}</div>` : '';
        const busy = this.busyIds.has(q.id);
        const gapLine =
          q.data.distancePx !== null ? `${q.data.source} connection, ${q.data.distancePx.toFixed(1)}px gap` : `${q.data.source} connection`;
        return `<div class="qa-card${answer ? ' answered' : ''}" data-question-id="${escapeHtml(q.id)}">
          <div class="qa-card-header">
            <span class="qa-plan-chip">${escapeHtml(QA_PLAN_LABEL[q.data.plan])}</span>
            <button type="button" class="qa-show-me-button qa-agent-show-me-button" data-question-id="${escapeHtml(q.id)}">📍 Show me</button>
          </div>
          <div class="qa-reason-line">${escapeHtml(q.prompt)}</div>
          <div class="qa-ocr-line">${escapeHtml(gapLine)}${q.data.elevationM !== null ? ` — ${q.data.elevationM}m` : ''}</div>
          ${answeredBadge}
          <div class="qa-actions">
            <button type="button" class="qa-accept-button qa-agent-confirm-button" data-question-id="${escapeHtml(q.id)}" ${answer || busy ? 'disabled' : ''}>✅ Confirm</button>
            <button type="button" class="qa-reject-button qa-agent-reject-button" data-question-id="${escapeHtml(q.id)}" ${answer || busy ? 'disabled' : ''}>❌ Reject</button>
          </div>
        </div>`;
      })
      .join('');
  }

  attachHandlers(container: HTMLElement): void {
    container.querySelectorAll<HTMLButtonElement>('.qa-agent-show-me-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = this.questions.find((x) => x.id === btn.dataset.questionId);
        if (!q) return;
        this.recording.log('qa:agent', 'show-me', { questionId: q.id, connectionId: q.data.connectionId });
        const west = Math.min(q.data.aLon, q.data.bLon);
        const east = Math.max(q.data.aLon, q.data.bLon);
        const south = Math.min(q.data.aLat, q.data.bLat);
        const north = Math.max(q.data.aLat, q.data.bLat);
        const fragmentIds = [q.data.aFragmentId, q.data.bFragmentId].filter((id): id is number => id !== null);
        this.onShowMe(q.data.plan, { west, south, east, north }, fragmentIds);
        this.highlightGap(q.data);
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
  }

  private async answer(questionId: string, decision: AgentAnswerDecision): Promise<void> {
    if (this.busyIds.has(questionId)) return; // already mid-submit
    const q = this.questions.find((x) => x.id === questionId);
    if (!q || this.answers.has(questionId)) return; // unknown, or a stale re-click after it's already answered
    this.busyIds.add(questionId);
    this.onChanged(); // re-render immediately so the buttons disable right away
    try {
      const ans: AgentAnswer = { questionId, decision, answeredAt: new Date().toISOString() };
      this.answers.set(questionId, ans);
      await this.appendAnswer(ans);
      if (q.type === 'confirm-connection') await this.applyConfirmConnection(q.data, decision);
    } finally {
      this.busyIds.delete(questionId);
      this.onChanged();
    }
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

  private async applyConfirmConnection(data: ConfirmConnectionQuestionData, decision: AgentAnswerDecision): Promise<void> {
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
        });
      }
    } else if (!current.rejections.some((r) => r.connectionId === data.connectionId)) {
      current.rejections.push({ connectionId: data.connectionId, plan: data.plan, rejectedAt: new Date().toISOString() });
    }
    await desk.fs.writeFile(CONNECTOR_LOG_PATH, JSON.stringify(current, null, 2));
    this.onConnectionDecision(data, decision);
  }
}
