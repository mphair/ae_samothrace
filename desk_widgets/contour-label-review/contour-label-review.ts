// Contour Label Review -- a small, deliberately narrow-scope widget for
// the handful of OCR readings scripts/extract_vector_layers.py wasn't
// confident enough to auto-apply (see that script's try_ocr_elevation:
// a digit reading in the plausible range but NOT a multiple of the
// site's established 5m contour interval -- e.g. the real bug this was
// built for, a small contour loop/switchback OCR misread as "09" / 9m).
//
// Deliberately NOT a general-purpose "ask the user lots of questions"
// tool -- it only ever shows what the extraction script itself queued
// as genuinely ambiguous (typically 0-3 items per plan), each with the
// exact cropped image OCR saw, so answering is quick: click the image
// (or "Accept") if the OCR reading looks right after all, "Reject" if
// it's not a real label, or type the correct value if you can read it
// yourself. Every answer is appended to
// `.desk_temp/contour-label-review-log.json` for Claude to read and
// (on request) turn into an actual *.corrections.json entry -- this
// widget only records the human's judgment, it never edits the
// extraction output or the corrections file itself.

interface Window {
  desk?: {
    self: {
      getLocalStorage(): Promise<{ data: Record<string, unknown> }>;
      setLocalStorage(data: Record<string, unknown>): Promise<{ ok: boolean }>;
    };
    fs: {
      readFile(path: string): Promise<{ contents: string }>;
      writeFile(path: string, contents: string): Promise<{ ok: boolean }>;
    };
  };
}

const LOG_PATH = '.desk_temp/contour-label-review-log.json';

type Plan = 'actual' | 'restored';
const PLAN_LABELS: Record<Plan, string> = { actual: 'Actual State Plan', restored: 'Restored State Plan' };
// scripts/extract_vector_layers.py's own write_review_queue output paths.
const QUEUE_PATHS: Record<Plan, string> = {
  actual: 'Data/mapFeatures/SamoWeb_ActualStatePlan_Contours.review_queue.json',
  restored: 'Data/mapFeatures/SamoWeb_RestoredStatePlan_Contours.review_queue.json',
};

interface QueueItem {
  reviewId: string;
  ocrText: string;
  ocrConfidence: number;
  parsedValue: number;
  reason: string;
  fragmentAId: number;
  fragmentBId: number;
  imageBase64: string;
}

interface QueueFile {
  plan: Plan;
  layer: string;
  contourIntervalM: number;
  generatedAt: string;
  items: QueueItem[];
}

type Decision = 'accept' | 'reject' | 'custom';

interface Answer {
  reviewId: string;
  plan: Plan;
  fragmentAId: number;
  fragmentBId: number;
  decision: Decision;
  value: number | null; // the elevation to apply, null for "reject"
  ocrText: string;
  ocrConfidence: number;
  parsedValue: number;
  reason: string;
  answeredAt: string;
}

interface WorkItem {
  plan: Plan;
  item: QueueItem;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

class ContourLabelReviewElement extends HTMLElement {
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;

  private workItems: WorkItem[] = [];
  private answers = new Map<string, Answer>(); // keyed by reviewId

  connectedCallback(): void {
    const template = document.getElementById('contour-label-review-template');
    if (!(template instanceof HTMLTemplateElement)) {
      throw new Error('contour-label-review-template not found');
    }
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(template.content.cloneNode(true));

    this.listEl = shadow.querySelector('.item-list');
    this.statusEl = shadow.querySelector('.status-overlay');
    this.summaryEl = shadow.querySelector('.summary');

    void this.init();
  }

  private setStatus(text: string | null): void {
    if (!this.statusEl) return;
    if (text) {
      this.statusEl.textContent = text;
      this.statusEl.style.display = 'flex';
    } else {
      this.statusEl.style.display = 'none';
    }
  }

  private async init(): Promise<void> {
    const desk = window.desk;
    try {
      this.setStatus('Loading review queue…');
      const plans: Plan[] = ['actual', 'restored'];
      const queues = await Promise.all(plans.map((plan) => this.loadQueue(plan)));
      this.workItems = queues.flatMap((q, i) => (q ? q.items.map((item) => ({ plan: plans[i]!, item })) : []));

      if (desk) {
        const { data } = await desk.self.getLocalStorage();
        const savedAnswers = Array.isArray(data.answers) ? (data.answers as Answer[]) : [];
        for (const a of savedAnswers) this.answers.set(a.reviewId, a);
      }

      this.setStatus(null);
      this.render();
      void this.writeLogFile(); // make sure the log reflects restored state even if nothing changes this session
    } catch (err) {
      this.setStatus(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadQueue(plan: Plan): Promise<QueueFile | null> {
    const desk = window.desk;
    if (!desk) return null;
    try {
      const { contents } = await desk.fs.readFile(QUEUE_PATHS[plan]);
      return JSON.parse(contents) as QueueFile;
    } catch {
      return null; // no queue file for this plan -- nothing to review there, not an error
    }
  }

  // ── Rendering ──

  private render(): void {
    if (this.summaryEl) {
      const total = this.workItems.length;
      const answered = this.workItems.filter((w) => this.answers.has(w.item.reviewId)).length;
      this.summaryEl.textContent =
        total === 0
          ? 'Nothing needs review right now — the extraction pipeline only queues a reading here when it genuinely cannot tell whether it is real.'
          : `${answered}/${total} answered.`;
    }
    if (!this.listEl) return;
    if (this.workItems.length === 0) {
      this.listEl.innerHTML = '';
      return;
    }
    this.listEl.innerHTML = this.workItems
      .map(({ plan, item }) => {
        const answer = this.answers.get(item.reviewId);
        const answeredBadge = answer ? `<div class="answered-badge">${escapeHtml(this.describeAnswer(answer))}</div>` : '';
        return `<div class="card${answer ? ' answered' : ''}" data-review-id="${escapeHtml(item.reviewId)}">
          <div class="card-header">
            <span class="plan-chip">${escapeHtml(PLAN_LABELS[plan])}</span>
            <span class="review-id">${escapeHtml(item.reviewId)}</span>
          </div>
          <img class="label-image" src="data:image/png;base64,${item.imageBase64}" title="Click to accept ${item.parsedValue}m as-is" />
          <div class="ocr-line">OCR read "<span class="ocr-text">${escapeHtml(item.ocrText)}</span>" (confidence ${(item.ocrConfidence * 100).toFixed(0)}%) → parsed as <strong>${item.parsedValue}m</strong></div>
          <div class="reason-line">${escapeHtml(item.reason)}</div>
          ${answeredBadge}
          <div class="actions">
            <button type="button" class="accept-button" data-review-id="${escapeHtml(item.reviewId)}">✅ Accept ${item.parsedValue}m</button>
            <button type="button" class="reject-button" data-review-id="${escapeHtml(item.reviewId)}">❌ Reject — not a label</button>
          </div>
          <div class="custom-row">
            <input type="number" class="custom-input" placeholder="Correct value (m)" data-review-id="${escapeHtml(item.reviewId)}" />
            <button type="button" class="custom-button" data-review-id="${escapeHtml(item.reviewId)}">Submit custom value</button>
          </div>
        </div>`;
      })
      .join('');

    this.listEl.querySelectorAll<HTMLImageElement>('.label-image').forEach((img) => {
      img.addEventListener('click', () => {
        const card = img.closest<HTMLElement>('.card');
        const reviewId = card?.dataset.reviewId;
        if (reviewId) void this.answer(reviewId, 'accept');
      });
    });
    this.listEl.querySelectorAll<HTMLButtonElement>('.accept-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const reviewId = btn.dataset.reviewId;
        if (reviewId) void this.answer(reviewId, 'accept');
      });
    });
    this.listEl.querySelectorAll<HTMLButtonElement>('.reject-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const reviewId = btn.dataset.reviewId;
        if (reviewId) void this.answer(reviewId, 'reject');
      });
    });
    this.listEl.querySelectorAll<HTMLButtonElement>('.custom-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const reviewId = btn.dataset.reviewId;
        if (!reviewId) return;
        const input = this.listEl?.querySelector<HTMLInputElement>(`.custom-input[data-review-id="${CSS.escape(reviewId)}"]`);
        const raw = input?.value.trim();
        if (!raw) return;
        const value = Number(raw);
        if (!Number.isFinite(value)) return;
        void this.answer(reviewId, 'custom', value);
      });
    });
  }

  private describeAnswer(answer: Answer): string {
    if (answer.decision === 'reject') return '✓ Answered: rejected (not a label)';
    if (answer.decision === 'custom') return `✓ Answered: custom value ${answer.value}m`;
    return `✓ Answered: accepted ${answer.value}m`;
  }

  // ── Answering ──

  private async answer(reviewId: string, decision: Decision, customValue?: number): Promise<void> {
    const work = this.workItems.find((w) => w.item.reviewId === reviewId);
    if (!work) return;
    const { plan, item } = work;
    const value = decision === 'reject' ? null : decision === 'custom' ? customValue ?? null : item.parsedValue;
    const ans: Answer = {
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
    this.render();
    await this.persist();
  }

  private async persist(): Promise<void> {
    void window.desk?.self.setLocalStorage({ answers: Array.from(this.answers.values()) });
    await this.writeLogFile();
  }

  private async writeLogFile(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const payload = {
      answers: Array.from(this.answers.values()),
    };
    try {
      await desk.fs.writeFile(LOG_PATH, JSON.stringify(payload, null, 2));
    } catch (err) {
      this.setStatus(`Failed to write log file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

customElements.define('contour-label-review', ContourLabelReviewElement);
