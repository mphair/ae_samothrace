// Minor Contour Review -- for each group scripts/extract_vector_layers.py's
// minor-contour banding stage couldn't confidently auto-order (see
// "please take another pass at the 1m minor contours"), shows the
// candidate fragments color-coded and numbered over the real site raster,
// lets a human confirm or correct each fragment's elevation (or mark it
// as not actually a contour), and logs the answer for Claude to fold
// back into a *.corrections.json-style artifact on request.
//
// UX affordances asked for specifically ("when asking for my help"):
//   - zoom in/out on the main view (drag-to-zoom + reset, same pattern
//     topo-compare already uses)
//   - a minimap (small, always-full-extent, bottom-right corner of the
//     main canvas) showing the current zoomed viewRect highlighted, so
//     it's never unclear where on the site the current group is
//   - an on-demand HD panel: fetches zoom-22 tiles (the sharpest
//     resolution the source tile pyramid has -- ~0.028 m/px, vs. the
//     zoom-18 main view's ~0.45 m/px) for just the current group's
//     bounding box, since the main view's baked-in resolution doesn't
//     improve just from scaling it up further

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
    state: {
      get(key: string): Promise<{ value: unknown; edit: unknown }>;
    };
  };
}

const TILE_SERVICE_STATE_KEY = 'desk.hmsvc.samothrace-tiles';
const LOG_PATH = '.desk_temp/minor-contour-review-log.json';

type Plan = 'actual' | 'restored';
const PLAN_LABELS: Record<Plan, string> = { actual: 'Actual State Plan', restored: 'Restored State Plan' };
const QUEUE_PATHS: Record<Plan, string> = {
  actual: 'Data/mapFeatures/SamoWeb_ActualStatePlan_Contours.minor_review_queue.json',
  restored: 'Data/mapFeatures/SamoWeb_RestoredStatePlan_Contours.minor_review_queue.json',
};
const RAW_LAYER: Record<Plan, string> = { actual: 'actual-plan-raw', restored: 'restored-plan-raw' };

// Main overview: the same whole-site-in-one-mosaic zoom 18 grid
// topo-compare.ts already uses.
const MAIN_Z = 18;
const MAIN_X_MIN = 149661;
const MAIN_X_MAX = 149663;
const MAIN_Y_MIN = 98763;
const MAIN_Y_MAX = 98765;
const TILE = 256;
const MAIN_IMG_W = (MAIN_X_MAX - MAIN_X_MIN + 1) * TILE;
const MAIN_IMG_H = (MAIN_Y_MAX - MAIN_Y_MIN + 1) * TILE;

// HD crop: highest zoom the source tile pyramid actually has.
const HD_Z = 22;
const HD_WINDOW_PX = 480; // ~13.6m across at z22 -- generous for a single band group

const ENTRY_COLORS = ['#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#eab308', '#14b8a6', '#f97316', '#38bdf8', '#f43f5e', '#84cc16'];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function projectWorld(lon: number, lat: number, zoom: number, tileSize: number): { x: number; y: number } {
  const n = Math.pow(2, zoom) * tileSize;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

interface QueueFragment {
  fragmentId: number;
  coordinates: [number, number][];
}

interface QueueGroup {
  groupId: string;
  elevLow: number;
  elevHigh: number;
  fragments: QueueFragment[];
}

interface QueueFile {
  plan: Plan;
  contourIntervalM: number;
  generatedAt: string;
  groups: QueueGroup[];
}

interface FragmentAnswer {
  fragmentId: number;
  elevationM: number | null; // null means "not actually a contour"
}

interface GroupAnswer {
  groupId: string;
  plan: Plan;
  elevLow: number;
  elevHigh: number;
  decision: 'confirmed' | 'skipped';
  fragments: FragmentAnswer[];
  answeredAt: string;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

class MinorContourReviewElement extends HTMLElement {
  private planSelectEl: HTMLSelectElement | null = null;
  private groupSelectEl: HTMLSelectElement | null = null;
  private prevButtonEl: HTMLButtonElement | null = null;
  private nextButtonEl: HTMLButtonElement | null = null;
  private nextUnansweredButtonEl: HTMLButtonElement | null = null;
  private progressEl: HTMLElement | null = null;
  private groupInfoEl: HTMLElement | null = null;
  private mainCanvas: HTMLCanvasElement | null = null;
  private minimapCanvas: HTMLCanvasElement | null = null;
  private resetZoomButtonEl: HTMLButtonElement | null = null;
  private hdButtonEl: HTMLButtonElement | null = null;
  private hdCanvas: HTMLCanvasElement | null = null;
  private hdStatusEl: HTMLElement | null = null;
  private fragmentListEl: HTMLElement | null = null;
  private confirmButtonEl: HTMLButtonElement | null = null;
  private skipButtonEl: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;

  private serviceUrl: string | null = null;
  private plan: Plan = 'actual';
  private queue: QueueFile | null = null;
  private groupIndex = 0;
  private answers = new Map<string, GroupAnswer>(); // keyed by `${plan}:${groupId}`

  private rawCache = new Map<string, Promise<HTMLCanvasElement>>();
  private mainBase: HTMLCanvasElement | null = null;
  private viewRect: Rect = { x: 0, y: 0, width: MAIN_IMG_W, height: MAIN_IMG_H };
  private dragState: { startX: number; startY: number; curX: number; curY: number } | null = null;

  connectedCallback(): void {
    const template = document.getElementById('minor-contour-review-template');
    if (!(template instanceof HTMLTemplateElement)) {
      throw new Error('minor-contour-review-template not found');
    }
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(template.content.cloneNode(true));

    this.planSelectEl = shadow.querySelector('.plan-select');
    this.groupSelectEl = shadow.querySelector('.group-select');
    this.prevButtonEl = shadow.querySelector('.prev-button');
    this.nextButtonEl = shadow.querySelector('.next-button');
    this.nextUnansweredButtonEl = shadow.querySelector('.next-unanswered-button');
    this.progressEl = shadow.querySelector('.progress');
    this.groupInfoEl = shadow.querySelector('.group-info');
    this.mainCanvas = shadow.querySelector('.main-canvas');
    this.minimapCanvas = shadow.querySelector('.minimap-canvas');
    this.resetZoomButtonEl = shadow.querySelector('.reset-zoom-button');
    this.hdButtonEl = shadow.querySelector('.hd-button');
    this.hdCanvas = shadow.querySelector('.hd-canvas');
    this.hdStatusEl = shadow.querySelector('.hd-status');
    this.fragmentListEl = shadow.querySelector('.fragment-list');
    this.confirmButtonEl = shadow.querySelector('.confirm-button');
    this.skipButtonEl = shadow.querySelector('.skip-button');
    this.statusEl = shadow.querySelector('.status-overlay');

    if (this.mainCanvas) {
      this.mainCanvas.width = MAIN_IMG_W;
      this.mainCanvas.height = MAIN_IMG_H;
    }
    if (this.minimapCanvas) {
      this.minimapCanvas.width = 160;
      this.minimapCanvas.height = 160;
    }
    if (this.hdCanvas) {
      this.hdCanvas.width = HD_WINDOW_PX;
      this.hdCanvas.height = HD_WINDOW_PX;
    }

    if (this.planSelectEl) {
      this.planSelectEl.innerHTML = (Object.keys(PLAN_LABELS) as Plan[])
        .map((p) => `<option value="${p}">${PLAN_LABELS[p]}</option>`)
        .join('');
      this.planSelectEl.value = this.plan;
      this.planSelectEl.addEventListener('change', () => {
        this.plan = (this.planSelectEl?.value as Plan | undefined) ?? 'actual';
        this.groupIndex = 0;
        void this.loadPlan();
      });
    }

    this.prevButtonEl?.addEventListener('click', () => this.goToGroup(this.groupIndex - 1));
    this.nextButtonEl?.addEventListener('click', () => this.goToGroup(this.groupIndex + 1));
    this.nextUnansweredButtonEl?.addEventListener('click', () => this.goToNextUnanswered());
    this.groupSelectEl?.addEventListener('change', () => {
      const idx = Number(this.groupSelectEl?.value);
      if (Number.isFinite(idx)) this.goToGroup(idx);
    });
    this.resetZoomButtonEl?.addEventListener('click', () => {
      this.viewRect = { x: 0, y: 0, width: MAIN_IMG_W, height: MAIN_IMG_H };
      this.renderMain();
    });
    this.hdButtonEl?.addEventListener('click', () => void this.loadHdCrop());
    this.confirmButtonEl?.addEventListener('click', () => void this.submitCurrentGroup('confirmed'));
    this.skipButtonEl?.addEventListener('click', () => void this.submitCurrentGroup('skipped'));

    this.attachMainCanvasInteraction();

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
      this.setStatus('Finding tile service…');
      if (!desk) throw new Error('Desk bridge unavailable');
      const tileService = await desk.state.get(TILE_SERVICE_STATE_KEY);
      const value = tileService.value as { status: string; url: string | null } | null;
      if (!value || !value.url) {
        throw new Error('samothrace-tiles service is not running -- start it from the Microservices widget');
      }
      this.serviceUrl = value.url.replace(/\/+$/, '');

      const { data } = await desk.self.getLocalStorage();
      const savedAnswers = Array.isArray(data.answers) ? (data.answers as GroupAnswer[]) : [];
      for (const a of savedAnswers) this.answers.set(`${a.plan}:${a.groupId}`, a);

      await this.loadPlan();
    } catch (err) {
      this.setStatus(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadPlan(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    this.setStatus('Loading review queue…');
    try {
      const basePromise = this.loadStitched(RAW_LAYER[this.plan]);
      const queuePromise = desk.fs.readFile(QUEUE_PATHS[this.plan]).catch(() => null);
      const base = await basePromise;
      const queueResult = await queuePromise;
      this.mainBase = whiteBg(base);
      this.queue = queueResult ? (JSON.parse(queueResult.contents) as QueueFile) : { plan: this.plan, contourIntervalM: 5, generatedAt: '', groups: [] };
      this.populateGroupSelect();
      this.groupIndex = 0;
      this.viewRect = { x: 0, y: 0, width: MAIN_IMG_W, height: MAIN_IMG_H };
      this.setStatus(null);
      this.showCurrentGroup();
    } catch (err) {
      this.setStatus(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadStitched(layerId: string): Promise<HTMLCanvasElement> {
    const cacheKey = `${this.serviceUrl}:${layerId}`;
    let existing = this.rawCache.get(cacheKey);
    if (existing) return existing;
    const promise = (async () => {
      const canvas = document.createElement('canvas');
      canvas.width = MAIN_IMG_W;
      canvas.height = MAIN_IMG_H;
      const ctx = canvas.getContext('2d')!;
      const tasks: Promise<void>[] = [];
      for (let ty = MAIN_Y_MIN; ty <= MAIN_Y_MAX; ty++) {
        for (let tx = MAIN_X_MIN; tx <= MAIN_X_MAX; tx++) {
          const url = `${this.serviceUrl}/tiles/${layerId}/${MAIN_Z}/${tx}/${ty}.png`;
          const ox = (tx - MAIN_X_MIN) * TILE;
          const oy = (ty - MAIN_Y_MIN) * TILE;
          tasks.push(
            (async () => {
              try {
                const res = await fetch(url, { mode: 'cors', cache: 'reload' });
                if (!res.ok) return;
                const blob = await res.blob();
                const objectUrl = URL.createObjectURL(blob);
                try {
                  await new Promise<void>((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => {
                      ctx.drawImage(img, ox, oy, TILE, TILE);
                      resolve();
                    };
                    img.onerror = () => reject(new Error(`decode failed for ${url}`));
                    img.src = objectUrl;
                  });
                } finally {
                  URL.revokeObjectURL(objectUrl);
                }
              } catch {
                // leave that cell blank
              }
            })(),
          );
        }
      }
      await Promise.all(tasks);
      return canvas;
    })();
    this.rawCache.set(cacheKey, promise);
    return promise;
  }

  // ── Group navigation ──

  private populateGroupSelect(): void {
    if (!this.groupSelectEl || !this.queue) return;
    this.groupSelectEl.innerHTML = this.queue.groups
      .map((g, i) => {
        const answered = this.answers.has(`${this.plan}:${g.groupId}`);
        return `<option value="${i}">${answered ? '✓ ' : ''}${escapeHtml(g.groupId)} (${g.fragments.length} frag)</option>`;
      })
      .join('');
  }

  private goToGroup(index: number): void {
    if (!this.queue || this.queue.groups.length === 0) return;
    this.groupIndex = clamp(index, 0, this.queue.groups.length - 1);
    this.showCurrentGroup();
  }

  private goToNextUnanswered(): void {
    if (!this.queue) return;
    const n = this.queue.groups.length;
    for (let step = 1; step <= n; step++) {
      const idx = (this.groupIndex + step) % n;
      const g = this.queue.groups[idx]!;
      if (!this.answers.has(`${this.plan}:${g.groupId}`)) {
        this.goToGroup(idx);
        return;
      }
    }
  }

  private currentGroup(): QueueGroup | null {
    return this.queue?.groups[this.groupIndex] ?? null;
  }

  private showCurrentGroup(): void {
    const group = this.currentGroup();
    if (this.groupSelectEl) this.groupSelectEl.value = String(this.groupIndex);
    if (this.progressEl && this.queue) {
      const answered = this.queue.groups.filter((g) => this.answers.has(`${this.plan}:${g.groupId}`)).length;
      this.progressEl.textContent = `Group ${this.groupIndex + 1} of ${this.queue.groups.length} — ${answered} answered`;
    }
    if (!group) {
      if (this.groupInfoEl) this.groupInfoEl.textContent = 'No groups need review for this plan.';
      if (this.fragmentListEl) this.fragmentListEl.innerHTML = '';
      this.renderMain();
      return;
    }
    if (this.groupInfoEl) {
      this.groupInfoEl.textContent = `Between ${group.elevLow}m and ${group.elevHigh}m — ${group.fragments.length} candidate fragment(s)`;
    }
    this.fitViewToGroup(group);
    this.renderFragmentList(group);
    this.renderMain();
    if (this.hdCanvas) {
      const hctx = this.hdCanvas.getContext('2d');
      hctx?.clearRect(0, 0, this.hdCanvas.width, this.hdCanvas.height);
    }
    if (this.hdStatusEl) this.hdStatusEl.textContent = '';
  }

  private fitViewToGroup(group: QueueGroup): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const frag of group.fragments) {
      for (const [lon, lat] of frag.coordinates) {
        const w = projectWorld(lon, lat, MAIN_Z, TILE);
        const x = w.x - MAIN_X_MIN * TILE;
        const y = w.y - MAIN_Y_MIN * TILE;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (!Number.isFinite(minX)) return;
    const padding = Math.max((maxX - minX) * 0.6, (maxY - minY) * 0.6, 40);
    const x0 = clamp(minX - padding, 0, MAIN_IMG_W);
    const y0 = clamp(minY - padding, 0, MAIN_IMG_H);
    const x1 = clamp(maxX + padding, 0, MAIN_IMG_W);
    const y1 = clamp(maxY + padding, 0, MAIN_IMG_H);
    const size = Math.max(x1 - x0, y1 - y0, 24);
    this.viewRect = {
      x: clamp(x0, 0, MAIN_IMG_W - size),
      y: clamp(y0, 0, MAIN_IMG_H - size),
      width: Math.min(size, MAIN_IMG_W),
      height: Math.min(size, MAIN_IMG_H),
    };
  }

  // ── Fragment list / answering ──

  private renderFragmentList(group: QueueGroup): void {
    if (!this.fragmentListEl) return;
    const existingAnswer = this.answers.get(`${this.plan}:${group.groupId}`);
    this.fragmentListEl.innerHTML = group.fragments
      .map((frag, i) => {
        const color = ENTRY_COLORS[i % ENTRY_COLORS.length];
        const prior = existingAnswer?.fragments.find((f) => f.fragmentId === frag.fragmentId);
        const defaultValue = group.elevLow + i + 1;
        const value = prior ? prior.elevationM : defaultValue;
        const notAContour = prior ? prior.elevationM === null : false;
        return `<div class="fragment-row">
          <span class="swatch" style="background:${color}"></span>
          <span class="frag-id">#${frag.fragmentId}</span>
          <input type="number" class="elev-input" data-fragment-id="${frag.fragmentId}" value="${value ?? ''}" ${notAContour ? 'disabled' : ''} step="1" />
          <label class="not-contour-label"><input type="checkbox" class="not-contour-checkbox" data-fragment-id="${frag.fragmentId}" ${notAContour ? 'checked' : ''} /> not a contour</label>
        </div>`;
      })
      .join('');
    this.fragmentListEl.querySelectorAll<HTMLInputElement>('.not-contour-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.fragmentId;
        const input = this.fragmentListEl?.querySelector<HTMLInputElement>(`.elev-input[data-fragment-id="${CSS.escape(id ?? '')}"]`);
        if (input) input.disabled = cb.checked;
      });
    });
  }

  private async submitCurrentGroup(decision: 'confirmed' | 'skipped'): Promise<void> {
    const group = this.currentGroup();
    if (!group) return;
    const fragments: FragmentAnswer[] = group.fragments.map((frag) => {
      const notContour = this.fragmentListEl?.querySelector<HTMLInputElement>(`.not-contour-checkbox[data-fragment-id="${CSS.escape(String(frag.fragmentId))}"]`)?.checked ?? false;
      if (notContour) return { fragmentId: frag.fragmentId, elevationM: null };
      const raw = this.fragmentListEl?.querySelector<HTMLInputElement>(`.elev-input[data-fragment-id="${CSS.escape(String(frag.fragmentId))}"]`)?.value;
      const value = raw ? Number(raw) : null;
      return { fragmentId: frag.fragmentId, elevationM: value !== null && Number.isFinite(value) ? value : null };
    });
    const answer: GroupAnswer = {
      groupId: group.groupId,
      plan: this.plan,
      elevLow: group.elevLow,
      elevHigh: group.elevHigh,
      decision,
      fragments,
      answeredAt: new Date().toISOString(),
    };
    this.answers.set(`${this.plan}:${group.groupId}`, answer);
    this.populateGroupSelect();
    await this.persist();
    this.goToNextUnanswered();
  }

  private async persist(): Promise<void> {
    void window.desk?.self.setLocalStorage({ answers: Array.from(this.answers.values()) });
    const desk = window.desk;
    if (!desk) return;
    try {
      await desk.fs.writeFile(LOG_PATH, JSON.stringify({ answers: Array.from(this.answers.values()) }, null, 2));
    } catch (err) {
      this.setStatus(`Failed to write log: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Main canvas + minimap ──

  private attachMainCanvasInteraction(): void {
    const canvas = this.mainCanvas;
    if (!canvas) return;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const p = this.clientToImagePoint(e, canvas);
      this.dragState = { startX: p.x, startY: p.y, curX: p.x, curY: p.y };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragState) return;
      const p = this.clientToImagePoint(e, canvas);
      this.dragState.curX = p.x;
      this.dragState.curY = p.y;
      this.renderMain();
    });
    canvas.addEventListener('pointerup', (e) => {
      canvas.releasePointerCapture(e.pointerId);
      const drag = this.dragState;
      this.dragState = null;
      if (!drag) return;
      const x = Math.min(drag.startX, drag.curX);
      const y = Math.min(drag.startY, drag.curY);
      const width = Math.abs(drag.curX - drag.startX);
      const height = Math.abs(drag.curY - drag.startY);
      if (width > 4 && height > 4) {
        const minSize = 20;
        const w = clamp(width, minSize, MAIN_IMG_W);
        const h = clamp(height, minSize, MAIN_IMG_H);
        this.viewRect = { x: clamp(x, 0, MAIN_IMG_W - w), y: clamp(y, 0, MAIN_IMG_H - h), width: w, height: h };
      }
      this.renderMain();
    });
  }

  private clientToImagePoint(e: { clientX: number; clientY: number }, canvas: HTMLCanvasElement): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const cx = clamp(((e.clientX - rect.left) / rect.width) * canvas.width, 0, canvas.width);
    const cy = clamp(((e.clientY - rect.top) / rect.height) * canvas.height, 0, canvas.height);
    const x = this.viewRect.x + (cx / canvas.width) * this.viewRect.width;
    const y = this.viewRect.y + (cy / canvas.height) * this.viewRect.height;
    return { x, y };
  }

  private groupFragmentPoints(frag: QueueFragment): Array<{ x: number; y: number }> {
    return frag.coordinates.map(([lon, lat]) => {
      const w = projectWorld(lon, lat, MAIN_Z, TILE);
      return { x: w.x - MAIN_X_MIN * TILE, y: w.y - MAIN_Y_MIN * TILE };
    });
  }

  private renderMain(): void {
    const canvas = this.mainCanvas;
    const base = this.mainBase;
    if (!canvas || !base) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const v = this.viewRect;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, v.x, v.y, v.width, v.height, 0, 0, canvas.width, canvas.height);

    const toCanvas = (p: { x: number; y: number }) => ({
      x: ((p.x - v.x) / v.width) * canvas.width,
      y: ((p.y - v.y) / v.height) * canvas.height,
    });

    const group = this.currentGroup();
    if (group) {
      group.fragments.forEach((frag, i) => {
        const color = ENTRY_COLORS[i % ENTRY_COLORS.length]!;
        const pts = this.groupFragmentPoints(frag).map(toCanvas);
        if (pts.length < 2) return;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        pts.forEach((p, pi) => (pi === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
        const mid = pts[Math.floor(pts.length / 2)]!;
        ctx.font = 'bold 14px monospace';
        const label = String(i + 1);
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = color;
        ctx.fillRect(mid.x - tw / 2 - 3, mid.y - 10, tw + 6, 18);
        ctx.fillStyle = '#10151c';
        ctx.fillText(label, mid.x - tw / 2, mid.y + 4);
        ctx.restore();
      });
    }

    if (this.dragState) {
      const x = Math.min(this.dragState.startX, this.dragState.curX);
      const y = Math.min(this.dragState.startY, this.dragState.curY);
      const w = Math.abs(this.dragState.curX - this.dragState.startX);
      const h = Math.abs(this.dragState.curY - this.dragState.startY);
      const tl = toCanvas({ x, y });
      const br = toCanvas({ x: x + w, y: y + h });
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.restore();
    }

    this.renderMinimap();
  }

  private renderMinimap(): void {
    const mini = this.minimapCanvas;
    const base = this.mainBase;
    if (!mini || !base) return;
    const ctx = mini.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, mini.width, mini.height);
    ctx.drawImage(base, 0, 0, MAIN_IMG_W, MAIN_IMG_H, 0, 0, mini.width, mini.height);
    const sx = mini.width / MAIN_IMG_W;
    const sy = mini.height / MAIN_IMG_H;
    const v = this.viewRect;
    ctx.save();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.strokeRect(v.x * sx, v.y * sy, v.width * sx, v.height * sy);
    ctx.restore();
  }

  // ── HD (zoom-22) crop for the current group ──

  private async loadHdCrop(): Promise<void> {
    const group = this.currentGroup();
    if (!group || !this.hdCanvas || !this.serviceUrl) return;
    if (this.hdStatusEl) this.hdStatusEl.textContent = 'Loading HD crop…';

    let sumLon = 0;
    let sumLat = 0;
    let n = 0;
    for (const frag of group.fragments) {
      for (const [lon, lat] of frag.coordinates) {
        sumLon += lon;
        sumLat += lat;
        n++;
      }
    }
    if (n === 0) return;
    const centerLon = sumLon / n;
    const centerLat = sumLat / n;
    const centerWorld = projectWorld(centerLon, centerLat, HD_Z, TILE);
    const halfWindow = HD_WINDOW_PX / 2;
    const worldX0 = centerWorld.x - halfWindow;
    const worldY0 = centerWorld.y - halfWindow;

    const tileX0 = Math.floor(worldX0 / TILE);
    const tileY0 = Math.floor(worldY0 / TILE);
    const tileX1 = Math.floor((worldX0 + HD_WINDOW_PX) / TILE);
    const tileY1 = Math.floor((worldY0 + HD_WINDOW_PX) / TILE);

    const ctx = this.hdCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.hdCanvas.width, this.hdCanvas.height);
    const tasks: Promise<void>[] = [];
    for (let ty = tileY0; ty <= tileY1; ty++) {
      for (let tx = tileX0; tx <= tileX1; tx++) {
        const url = `${this.serviceUrl}/tiles/${RAW_LAYER[this.plan]}/${HD_Z}/${tx}/${ty}.png`;
        const destX = tx * TILE - worldX0;
        const destY = ty * TILE - worldY0;
        tasks.push(
          (async () => {
            try {
              const res = await fetch(url, { mode: 'cors', cache: 'reload' });
              if (!res.ok) return;
              const blob = await res.blob();
              const objectUrl = URL.createObjectURL(blob);
              try {
                await new Promise<void>((resolve, reject) => {
                  const img = new Image();
                  img.onload = () => {
                    ctx.save();
                    ctx.globalCompositeOperation = 'destination-over';
                    ctx.drawImage(img, destX, destY, TILE, TILE);
                    ctx.restore();
                    resolve();
                  };
                  img.onerror = () => reject(new Error('decode failed'));
                  img.src = objectUrl;
                });
              } finally {
                URL.revokeObjectURL(objectUrl);
              }
            } catch {
              // leave blank
            }
          })(),
        );
      }
    }
    await Promise.all(tasks);
    // white backdrop behind whatever tiles loaded
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, this.hdCanvas.width, this.hdCanvas.height);
    ctx.restore();

    // overlay the group's fragments, reprojected into this HD window
    group.fragments.forEach((frag, i) => {
      const color = ENTRY_COLORS[i % ENTRY_COLORS.length]!;
      const pts = frag.coordinates.map(([lon, lat]) => {
        const w = projectWorld(lon, lat, HD_Z, TILE);
        return { x: w.x - worldX0, y: w.y - worldY0 };
      });
      if (pts.length < 2) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, pi) => (pi === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.restore();
    });

    if (this.hdStatusEl) this.hdStatusEl.textContent = `HD crop at zoom ${HD_Z} (~0.028 m/px), centered on this group.`;
  }
}

function whiteBg(source: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = source.width;
  c.height = source.height;
  const cx = c.getContext('2d')!;
  cx.drawImage(source, 0, 0);
  cx.globalCompositeOperation = 'destination-over';
  cx.fillStyle = 'white';
  cx.fillRect(0, 0, c.width, c.height);
  cx.globalCompositeOperation = 'source-over';
  return c;
}

customElements.define('minor-contour-review', MinorContourReviewElement);
