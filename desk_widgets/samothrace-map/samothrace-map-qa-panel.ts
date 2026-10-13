// Q&A panel -- phase 4 of plans/samothrace-map-consolidation.md §5. Ports
// the standalone Contour Label Review widget's functionality as the
// first of three tabs (Minor Contour Bands and Contour Connector follow
// in later phases) in a new right-side panel, each with a "Show me"
// button (§5.1) and the recording-vs-durable-file answer split (§5.2).
//
// Concatenated after samothrace-map-contours-layer.ts, before
// samothrace-map.ts (global scripts, no import/export). Window.desk's
// shape is declared once, in samothrace-map-recording.ts.

type QaPlan = 'actual' | 'restored';
const QA_PLAN_LABEL: Record<QaPlan, string> = { actual: 'Actual State Plan', restored: 'Restored State Plan' };
const QA_PLAN_FILE_PART: Record<QaPlan, string> = { actual: 'ActualStatePlan', restored: 'RestoredStatePlan' };

// escapeHtml is already declared in samothrace-map.ts -- global scripts
// share one scope once concatenated, and function DECLARATIONS (unlike
// const/let) hoist across the whole combined script regardless of each
// file's own position in tsconfig.json's "files" order, so it's usable
// here even though that file is listed after this one.

// ── Label review tab -- ports contour-label-review.ts's own logic ──
// (same queue file, same durable log file/answer shape, so
// scripts/apply_label_review.py keeps working completely unchanged, and
// anything already answered via the old standalone widget still counts
// -- see LabelReviewTabController.init's own comment below).

const LABEL_REVIEW_LOG_PATH = '.desk_temp/contour-label-review-log.json';

function labelReviewQueuePath(plan: QaPlan): string {
  return `Data/mapFeatures/SamoWeb_${QA_PLAN_FILE_PART[plan]}_Contours.review_queue.json`;
}

interface LabelReviewQueueItem {
  reviewId: string;
  ocrText: string;
  ocrConfidence: number;
  parsedValue: number;
  reason: string;
  fragmentAId: number;
  fragmentBId: number;
  imageBase64: string;
}

interface LabelReviewQueueFile {
  plan: QaPlan;
  layer: string;
  contourIntervalM: number;
  generatedAt: string;
  items: LabelReviewQueueItem[];
}

type LabelDecision = 'accept' | 'reject' | 'custom';

interface LabelReviewAnswer {
  reviewId: string;
  plan: QaPlan;
  fragmentAId: number;
  fragmentBId: number;
  decision: LabelDecision;
  value: number | null;
  ocrText: string;
  ocrConfidence: number;
  parsedValue: number;
  reason: string;
  answeredAt: string;
}

interface LabelReviewWorkItem {
  plan: QaPlan;
  item: LabelReviewQueueItem;
}

class LabelReviewTabController {
  private workItems: LabelReviewWorkItem[] = [];
  private answers = new Map<string, LabelReviewAnswer>(); // keyed by reviewId -- loaded FROM the durable log file itself, not a widget-local cache; see init()
  private loaded = false;

  constructor(
    private readonly recording: RecordingController,
    private readonly onChanged: () => void,
    private readonly onShowMe: (plan: QaPlan, fragmentIds: number[]) => void,
  ) {}

  async init(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const plans: QaPlan[] = ['actual', 'restored'];
    const queues = await Promise.all(plans.map((p) => this.loadQueue(p)));
    this.workItems = queues.flatMap((q, i) => (q ? q.items.map((item) => ({ plan: plans[i]!, item })) : []));
    // Loaded from the log file itself, not this widget's own
    // localStorage -- that file is the actual durable, authoritative
    // record (what scripts/apply_label_review.py reads), and this way
    // anything already answered via the old standalone Contour Label
    // Review widget is already accounted for, not re-asked.
    try {
      const { contents } = await desk.fs.readFile(LABEL_REVIEW_LOG_PATH);
      const parsed = JSON.parse(contents) as { answers: LabelReviewAnswer[] };
      for (const a of parsed.answers ?? []) this.answers.set(a.reviewId, a);
    } catch {
      // no log file yet -- fine, nothing answered so far
    }
    this.loaded = true;
    this.onChanged();
  }

  private async loadQueue(plan: QaPlan): Promise<LabelReviewQueueFile | null> {
    const desk = window.desk;
    if (!desk) return null;
    try {
      const { contents } = await desk.fs.readFile(labelReviewQueuePath(plan));
      return JSON.parse(contents) as LabelReviewQueueFile;
    } catch {
      return null; // no queue file for this plan -- nothing to review there, not an error
    }
  }

  summary(): string {
    if (!this.loaded) return 'Loading…';
    const total = this.workItems.length;
    if (total === 0) return 'Nothing needs review right now.';
    const answered = this.workItems.filter((w) => this.answers.has(w.item.reviewId)).length;
    return `${answered}/${total} answered.`;
  }

  render(): string {
    if (!this.loaded) return '';
    if (this.workItems.length === 0) return '<div class="qa-empty">No ambiguous elevation labels queued for either plan right now.</div>';
    return this.workItems
      .map(({ plan, item }) => {
        const answer = this.answers.get(item.reviewId);
        const answeredBadge = answer ? `<div class="qa-answered-badge">${escapeHtml(this.describeAnswer(answer))}</div>` : '';
        return `<div class="qa-card${answer ? ' answered' : ''}" data-review-id="${escapeHtml(item.reviewId)}">
          <div class="qa-card-header">
            <span class="qa-plan-chip">${escapeHtml(QA_PLAN_LABEL[plan])}</span>
            <button type="button" class="qa-show-me-button" data-review-id="${escapeHtml(item.reviewId)}">📍 Show me</button>
          </div>
          <img class="qa-label-image" src="data:image/png;base64,${item.imageBase64}" title="Click to accept ${item.parsedValue}m as-is" data-review-id="${escapeHtml(item.reviewId)}" />
          <div class="qa-ocr-line">OCR read "<span class="qa-ocr-text">${escapeHtml(item.ocrText)}</span>" (${(item.ocrConfidence * 100).toFixed(0)}%) → <strong>${item.parsedValue}m</strong></div>
          <div class="qa-reason-line">${escapeHtml(item.reason)}</div>
          ${answeredBadge}
          <div class="qa-actions">
            <button type="button" class="qa-accept-button" data-review-id="${escapeHtml(item.reviewId)}">✅ Accept ${item.parsedValue}m</button>
            <button type="button" class="qa-reject-button" data-review-id="${escapeHtml(item.reviewId)}">❌ Reject</button>
          </div>
          <div class="qa-custom-row">
            <input type="number" class="qa-custom-input" placeholder="Correct value (m)" data-review-id="${escapeHtml(item.reviewId)}" />
            <button type="button" class="qa-custom-button" data-review-id="${escapeHtml(item.reviewId)}">Submit</button>
          </div>
        </div>`;
      })
      .join('');
  }

  attachHandlers(container: HTMLElement): void {
    container.querySelectorAll<HTMLImageElement>('.qa-label-image').forEach((img) => {
      img.addEventListener('click', () => {
        const reviewId = img.dataset.reviewId;
        if (reviewId) void this.answer(reviewId, 'accept');
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-accept-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const reviewId = btn.dataset.reviewId;
        if (reviewId) void this.answer(reviewId, 'accept');
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-reject-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const reviewId = btn.dataset.reviewId;
        if (reviewId) void this.answer(reviewId, 'reject');
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-custom-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const reviewId = btn.dataset.reviewId;
        if (!reviewId) return;
        const input = container.querySelector<HTMLInputElement>(`.qa-custom-input[data-review-id="${CSS.escape(reviewId)}"]`);
        const raw = input?.value.trim();
        if (!raw) return;
        const value = Number(raw);
        if (!Number.isFinite(value)) return;
        void this.answer(reviewId, 'custom', value);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-show-me-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const reviewId = btn.dataset.reviewId;
        const work = this.workItems.find((w) => w.item.reviewId === reviewId);
        if (!work) return;
        this.recording.log('qa:label-review', 'show-me', { reviewId: work.item.reviewId, plan: work.plan });
        this.onShowMe(work.plan, [work.item.fragmentAId, work.item.fragmentBId]);
      });
    });
  }

  private describeAnswer(answer: LabelReviewAnswer): string {
    if (answer.decision === 'reject') return '✓ Rejected (not a label)';
    if (answer.decision === 'custom') return `✓ Custom value ${answer.value}m`;
    return `✓ Accepted ${answer.value}m`;
  }

  private async answer(reviewId: string, decision: LabelDecision, customValue?: number): Promise<void> {
    const work = this.workItems.find((w) => w.item.reviewId === reviewId);
    if (!work) return;
    const { plan, item } = work;
    const value = decision === 'reject' ? null : decision === 'custom' ? customValue ?? null : item.parsedValue;
    const ans: LabelReviewAnswer = {
      reviewId,
      plan,
      fragmentAId: item.fragmentAId,
      fragmentBId: item.fragmentBId,
      decision,
      value,
      ocrText: item.ocrText,
      ocrConfidence: item.ocrConfidence,
      parsedValue: item.parsedValue,
      reason: item.reason,
      answeredAt: new Date().toISOString(),
    };
    this.answers.set(reviewId, ans);
    this.onChanged();
    // §5.2: while recording, the answer lives in the recording log only;
    // while not recording, it goes straight to the same durable file the
    // standalone widget already used, so apply_label_review.py keeps
    // working unchanged either way.
    const loggedToRecording = this.recording.log('qa:label-review', 'answer', ans);
    if (!loggedToRecording) await this.writeLogFile();
  }

  private async writeLogFile(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    await desk.fs.writeFile(LABEL_REVIEW_LOG_PATH, JSON.stringify({ answers: Array.from(this.answers.values()) }, null, 2));
  }
}

// ── Minor contour bands tab -- ports minor-contour-review.ts's own
// logic ── (same queue files, same durable log shape, so a future
// scripts/apply_minor_review.py can read it exactly the way
// apply_label_review.py already reads the label-review one -- see
// plans/samothrace-map-consolidation.md §8's own note that that script
// still doesn't exist yet).
//
// Unlike label review's flat card list, this one keeps the original
// widget's group-navigator shape (prev/next/dropdown/skip-to
// -unanswered) rather than rendering every group as its own card --
// there can be 100+ pending groups per plan (most 1-3 fragments each;
// see band_minor_contours's own header comment in
// scripts/extract_vector_layers.py for why so many land here
// unconfident), too many to usefully scroll through as a flat list.
// Navigating to a group auto-triggers the same "Show me" zoom
// /highlight the label-review tab's button does (plus an explicit
// button of its own, for re-centering after panning away) -- browsing
// groups this way pans/zooms the real map as you go, nicer than the
// standalone widget's own separate raster view ever could be.
//
// One simplification versus the standalone widget, worth knowing: that
// widget drew each fragment in its own distinct numbered color on the
// map so a human could tell which highlighted line matched which
// elevation-input row. This port highlights the whole group as one
// solid block (the same red/white ContoursLayerController.
// highlightFragments every "Show me" uses) -- the sidebar's own numbered
// color swatches are preserved, but they're not matched on the map
// itself. Revisit if that turns out to actually matter in practice,
// rather than guessing up front.

const MINOR_BAND_LOG_PATH = '.desk_temp/minor-contour-review-log.json';

function minorBandQueuePath(plan: QaPlan): string {
  return `Data/mapFeatures/SamoWeb_${QA_PLAN_FILE_PART[plan]}_Contours.minor_review_queue.json`;
}

const MINOR_BAND_ENTRY_COLORS = ['#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#eab308', '#14b8a6', '#f97316', '#38bdf8', '#f43f5e', '#84cc16'];

interface MinorBandQueueFragment {
  fragmentId: number;
  coordinates: [number, number][];
}

interface MinorBandQueueGroup {
  groupId: string;
  elevLow: number;
  elevHigh: number;
  fragments: MinorBandQueueFragment[];
}

interface MinorBandQueueFile {
  plan: QaPlan;
  contourIntervalM: number;
  generatedAt: string;
  groups: MinorBandQueueGroup[];
}

interface MinorBandFragmentAnswer {
  fragmentId: number;
  elevationM: number | null; // null means "not actually a contour"
}

interface MinorBandGroupAnswer {
  groupId: string;
  plan: QaPlan;
  elevLow: number;
  elevHigh: number;
  decision: 'confirmed' | 'skipped';
  fragments: MinorBandFragmentAnswer[];
  answeredAt: string;
}

interface MinorBandWorkGroup {
  plan: QaPlan;
  group: MinorBandQueueGroup;
}

class MinorBandsTabController {
  private workGroups: MinorBandWorkGroup[] = [];
  private answers = new Map<string, MinorBandGroupAnswer>(); // keyed by `${plan}:${groupId}`, same convention the standalone widget already used
  private currentIndex = 0;
  private loaded = false;

  constructor(
    private readonly recording: RecordingController,
    private readonly onChanged: () => void,
    private readonly onShowMe: (plan: QaPlan, fragmentIds: number[]) => void,
  ) {}

  async init(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const plans: QaPlan[] = ['actual', 'restored'];
    const queues = await Promise.all(plans.map((p) => this.loadQueue(p)));
    this.workGroups = queues.flatMap((q, i) => (q ? q.groups.map((group) => ({ plan: plans[i]!, group })) : []));
    try {
      const { contents } = await desk.fs.readFile(MINOR_BAND_LOG_PATH);
      const parsed = JSON.parse(contents) as { answers: MinorBandGroupAnswer[] };
      for (const a of parsed.answers ?? []) this.answers.set(`${a.plan}:${a.groupId}`, a);
    } catch {
      // no log file yet -- fine, nothing answered so far
    }
    this.loaded = true;
    this.onChanged();
  }

  private async loadQueue(plan: QaPlan): Promise<MinorBandQueueFile | null> {
    const desk = window.desk;
    if (!desk) return null;
    try {
      const { contents } = await desk.fs.readFile(minorBandQueuePath(plan));
      return JSON.parse(contents) as MinorBandQueueFile;
    } catch {
      return null; // no queue file for this plan -- nothing to review there, not an error
    }
  }

  summary(): string {
    if (!this.loaded) return 'Loading…';
    const total = this.workGroups.length;
    if (total === 0) return 'Nothing needs review right now.';
    const answered = this.workGroups.filter((w) => this.answers.has(`${w.plan}:${w.group.groupId}`)).length;
    return `Group ${Math.min(this.currentIndex + 1, total)} of ${total} — ${answered} answered.`;
  }

  private currentWork(): MinorBandWorkGroup | null {
    return this.workGroups[this.currentIndex] ?? null;
  }

  render(): string {
    if (!this.loaded) return '';
    if (this.workGroups.length === 0) return '<div class="qa-empty">No ambiguous minor-contour bands queued for either plan right now.</div>';
    const work = this.currentWork();
    if (!work) return '';
    const { plan, group } = work;
    const answer = this.answers.get(`${plan}:${group.groupId}`);
    const answeredBadge = answer
      ? `<div class="qa-answered-badge">✓ ${answer.decision === 'skipped' ? 'Skipped' : 'Confirmed'}${answer.decision === 'confirmed' ? ` (${answer.fragments.filter((f) => f.elevationM !== null).length}/${answer.fragments.length} assigned)` : ''}</div>`
      : '';

    const nav = `<div class="qa-mb-nav">
      <button type="button" class="qa-mb-prev-button" ${this.currentIndex === 0 ? 'disabled' : ''}>◀</button>
      <select class="qa-mb-group-select">
        ${this.workGroups
          .map((w, i) => {
            const a = this.answers.has(`${w.plan}:${w.group.groupId}`) ? '✓ ' : '';
            return `<option value="${i}" ${i === this.currentIndex ? 'selected' : ''}>${a}${escapeHtml(w.plan)}: ${escapeHtml(w.group.groupId)}</option>`;
          })
          .join('')}
      </select>
      <button type="button" class="qa-mb-next-button" ${this.currentIndex === this.workGroups.length - 1 ? 'disabled' : ''}>▶</button>
    </div>
    <button type="button" class="qa-mb-skip-unanswered-button">Skip to next unanswered</button>`;

    const fragmentRows = group.fragments
      .map((frag, i) => {
        const color = MINOR_BAND_ENTRY_COLORS[i % MINOR_BAND_ENTRY_COLORS.length];
        const prior = answer?.fragments.find((f) => f.fragmentId === frag.fragmentId);
        const defaultValue = group.elevLow + i + 1;
        const value = prior ? prior.elevationM : defaultValue;
        const notAContour = prior ? prior.elevationM === null : false;
        return `<div class="qa-mb-fragment-row">
          <span class="qa-mb-swatch" style="background:${color}"></span>
          <span class="qa-mb-frag-id">#${frag.fragmentId}</span>
          <input type="number" class="qa-mb-elev-input" data-fragment-id="${frag.fragmentId}" value="${value ?? ''}" ${notAContour ? 'disabled' : ''} step="1" />
          <label class="qa-mb-not-contour-label"><input type="checkbox" class="qa-mb-not-contour-checkbox" data-fragment-id="${frag.fragmentId}" ${notAContour ? 'checked' : ''} /> not a contour</label>
        </div>`;
      })
      .join('');

    return `${nav}
      <div class="qa-card">
        <div class="qa-card-header">
          <span class="qa-plan-chip">${escapeHtml(QA_PLAN_LABEL[plan])}</span>
          <button type="button" class="qa-show-me-button qa-mb-show-me-button">📍 Show me</button>
        </div>
        <div class="qa-reason-line">Between ${group.elevLow}m and ${group.elevHigh}m — ${group.fragments.length} candidate fragment(s)</div>
        ${answeredBadge}
        <div class="qa-mb-fragment-list">${fragmentRows}</div>
        <div class="qa-actions">
          <button type="button" class="qa-accept-button qa-mb-confirm-button">✅ Confirm</button>
          <button type="button" class="qa-mb-skip-button">Skip</button>
        </div>
      </div>`;
  }

  attachHandlers(container: HTMLElement): void {
    if (!this.currentWork()) return;
    container.querySelector<HTMLButtonElement>('.qa-mb-prev-button')?.addEventListener('click', () => this.goTo(this.currentIndex - 1));
    container.querySelector<HTMLButtonElement>('.qa-mb-next-button')?.addEventListener('click', () => this.goTo(this.currentIndex + 1));
    container.querySelector<HTMLSelectElement>('.qa-mb-group-select')?.addEventListener('change', (e) => {
      const idx = Number((e.currentTarget as HTMLSelectElement).value);
      if (Number.isFinite(idx)) this.goTo(idx);
    });
    container.querySelector<HTMLButtonElement>('.qa-mb-skip-unanswered-button')?.addEventListener('click', () => this.goToNextUnanswered());
    container.querySelector<HTMLButtonElement>('.qa-mb-show-me-button')?.addEventListener('click', () => this.showCurrentGroup());
    container.querySelector<HTMLButtonElement>('.qa-mb-confirm-button')?.addEventListener('click', () => void this.submit('confirmed', container));
    container.querySelector<HTMLButtonElement>('.qa-mb-skip-button')?.addEventListener('click', () => void this.submit('skipped', container));
    container.querySelectorAll<HTMLInputElement>('.qa-mb-not-contour-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.fragmentId;
        const input = container.querySelector<HTMLInputElement>(`.qa-mb-elev-input[data-fragment-id="${CSS.escape(id ?? '')}"]`);
        if (input) input.disabled = cb.checked;
      });
    });
  }

  private goTo(index: number): void {
    if (this.workGroups.length === 0) return;
    this.currentIndex = Math.max(0, Math.min(index, this.workGroups.length - 1));
    this.onChanged();
    this.showCurrentGroup();
  }

  private goToNextUnanswered(): void {
    const n = this.workGroups.length;
    for (let step = 1; step <= n; step++) {
      const idx = (this.currentIndex + step) % n;
      const w = this.workGroups[idx]!;
      if (!this.answers.has(`${w.plan}:${w.group.groupId}`)) {
        this.goTo(idx);
        return;
      }
    }
  }

  // Shared by navigation (goTo) and the card's own explicit "Show me"
  // button -- same underlying action either way (pan/zoom/highlight the
  // real map to this group), logged the same way regardless of trigger.
  private showCurrentGroup(): void {
    const work = this.currentWork();
    if (!work) return;
    this.recording.log('qa:minor-bands', 'group-shown', { groupId: work.group.groupId, plan: work.plan });
    this.onShowMe(
      work.plan,
      work.group.fragments.map((f) => f.fragmentId),
    );
  }

  private async submit(decision: 'confirmed' | 'skipped', container: HTMLElement): Promise<void> {
    const work = this.currentWork();
    if (!work) return;
    const { plan, group } = work;
    const fragments: MinorBandFragmentAnswer[] = group.fragments.map((frag) => {
      const notContour = container.querySelector<HTMLInputElement>(`.qa-mb-not-contour-checkbox[data-fragment-id="${CSS.escape(String(frag.fragmentId))}"]`)?.checked ?? false;
      if (notContour) return { fragmentId: frag.fragmentId, elevationM: null };
      const raw = container.querySelector<HTMLInputElement>(`.qa-mb-elev-input[data-fragment-id="${CSS.escape(String(frag.fragmentId))}"]`)?.value;
      const value = raw ? Number(raw) : null;
      return { fragmentId: frag.fragmentId, elevationM: value !== null && Number.isFinite(value) ? value : null };
    });
    const answer: MinorBandGroupAnswer = {
      groupId: group.groupId,
      plan,
      elevLow: group.elevLow,
      elevHigh: group.elevHigh,
      decision,
      fragments,
      answeredAt: new Date().toISOString(),
    };
    this.answers.set(`${plan}:${group.groupId}`, answer);
    this.onChanged();
    // §5.2, same split as label review: recording log while recording,
    // the durable file otherwise.
    const loggedToRecording = this.recording.log('qa:minor-bands', 'answer', answer);
    if (!loggedToRecording) await this.writeLogFile();
    this.goToNextUnanswered();
  }

  private async writeLogFile(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    await desk.fs.writeFile(MINOR_BAND_LOG_PATH, JSON.stringify({ answers: Array.from(this.answers.values()) }, null, 2));
  }
}
