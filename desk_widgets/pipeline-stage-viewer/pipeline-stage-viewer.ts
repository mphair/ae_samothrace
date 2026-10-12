// Pipeline Stage Viewer -- shows the intermediate mask/fragment-render
// PNG scripts/extract_vector_layers.py saves for each named stage of
// its contour-extraction pipeline (.desk_temp/pipeline-stages/<plan>/
// NN_<stage>.png), so any one stage's actual effect can be seen in
// isolation instead of only inferred from the final GeoJSON output.
// Built alongside that pipeline's reorganization into explicit stages
// (structure exclusion, circle-chain exclusion, label merge, minor
// -contour banding) -- see "please make a widget which visualizes the
// data produced by each stage of the pipeline."

interface Window {
  desk?: {
    documents: {
      open(path: string): Promise<{ handle: string }>;
      read(handle: string, opts: { offset: number; length: number }): Promise<{ data: string; eof: boolean }>;
      close(handle: string): Promise<{ closed: boolean }>;
    };
  };
}

type Plan = 'actual' | 'restored';
const PLAN_LABELS: Record<Plan, string> = { actual: 'Actual State Plan', restored: 'Restored State Plan' };

// Mirrors extract_vector_layers.py's own PIPELINE_STAGES list -- kept in
// sync by hand (small, stable list; see that constant's own comment).
const STAGES: Array<{ num: number; name: string; label: string }> = [
  { num: 0, name: 'raw-ink', label: 'Raw ink mask (ink/blue split)' },
  { num: 1, name: 'after-structure-exclusion', label: 'After structure (building) exclusion' },
  { num: 2, name: 'candidate-fragments', label: 'Candidate fragments (thin/thick split + length filter)' },
  { num: 3, name: 'after-border-exclusion', label: 'After border/survey-frame exclusion' },
  { num: 4, name: 'after-chain-exclusion', label: 'After decorative circle-chain exclusion' },
  { num: 5, name: 'labeled-contours', label: 'After label-gap merge (index contours get elevation)' },
  { num: 6, name: 'with-minor-bands', label: 'After minor-contour banding (1m interpolation)' },
];

function stagePath(plan: Plan, stage: { num: number; name: string }): string {
  const nn = String(stage.num).padStart(2, '0');
  return `.desk_temp/pipeline-stages/${plan}/${nn}_${stage.name}.png`;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// 8 MiB per desk.documents.read call -- see the Bridge API's own doc
// ("length is clamped to 8 MiB per call").
const DOCUMENT_READ_CHUNK = 8 * 1024 * 1024;

async function readFileAsBlobUrl(path: string): Promise<string> {
  const desk = window.desk;
  if (!desk) throw new Error('Desk bridge unavailable');
  const { handle } = await desk.documents.open(path);
  try {
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const { data, eof } = await desk.documents.read(handle, { offset, length: DOCUMENT_READ_CHUNK });
      if (data) {
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        parts.push(bytes);
        offset += bytes.length;
      }
      if (eof) break;
    }
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const combined = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
      combined.set(p, pos);
      pos += p.length;
    }
    const blob = new Blob([combined], { type: 'image/png' });
    return URL.createObjectURL(blob);
  } finally {
    await desk.documents.close(handle);
  }
}

class PipelineStageViewerElement extends HTMLElement {
  private planSelectEl: HTMLSelectElement | null = null;
  private stageListEl: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private resetZoomButtonEl: HTMLButtonElement | null = null;
  private zoomReadoutEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private captionEl: HTMLElement | null = null;

  private plan: Plan = 'actual';
  private stageIndex = 0;
  private imageCache = new Map<string, Promise<HTMLImageElement>>();
  private currentImage: HTMLImageElement | null = null;
  private viewRect: Rect = { x: 0, y: 0, width: 1, height: 1 };
  private imgW = 1;
  private imgH = 1;

  private dragState: { startX: number; startY: number; curX: number; curY: number } | null = null;

  connectedCallback(): void {
    const template = document.getElementById('pipeline-stage-viewer-template');
    if (!(template instanceof HTMLTemplateElement)) {
      throw new Error('pipeline-stage-viewer-template not found');
    }
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(template.content.cloneNode(true));

    this.planSelectEl = shadow.querySelector('.plan-select');
    this.stageListEl = shadow.querySelector('.stage-list');
    this.canvas = shadow.querySelector('.stage-canvas');
    this.resetZoomButtonEl = shadow.querySelector('.reset-zoom-button');
    this.zoomReadoutEl = shadow.querySelector('.zoom-readout');
    this.statusEl = shadow.querySelector('.status-overlay');
    this.captionEl = shadow.querySelector('.stage-caption');

    if (this.planSelectEl) {
      this.planSelectEl.innerHTML = (Object.keys(PLAN_LABELS) as Plan[])
        .map((p) => `<option value="${p}">${PLAN_LABELS[p]}</option>`)
        .join('');
      this.planSelectEl.value = this.plan;
      this.planSelectEl.addEventListener('change', () => {
        this.plan = (this.planSelectEl?.value as Plan | undefined) ?? 'actual';
        void this.loadCurrentStage(true);
      });
    }

    if (this.stageListEl) {
      this.stageListEl.innerHTML = STAGES.map(
        (s, i) => `<button type="button" class="stage-item${i === 0 ? ' active' : ''}" data-index="${i}">${String(s.num).padStart(2, '0')} — ${escapeHtml(s.label)}</button>`,
      ).join('');
      this.stageListEl.querySelectorAll<HTMLButtonElement>('.stage-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.index);
          if (Number.isFinite(idx)) {
            this.stageIndex = idx;
            this.updateStageButtons();
            void this.loadCurrentStage(true);
          }
        });
      });
    }

    this.resetZoomButtonEl?.addEventListener('click', () => {
      this.viewRect = { x: 0, y: 0, width: this.imgW, height: this.imgH };
      this.updateZoomReadout();
      this.render();
    });

    if (this.canvas) {
      this.canvas.width = 1024;
      this.canvas.height = 1024;
      this.canvas.addEventListener('pointerdown', (e) => {
        this.canvas?.setPointerCapture(e.pointerId);
        const p = this.clientToImagePoint(e);
        this.dragState = { startX: p.x, startY: p.y, curX: p.x, curY: p.y };
      });
      this.canvas.addEventListener('pointermove', (e) => {
        if (!this.dragState) return;
        const p = this.clientToImagePoint(e);
        this.dragState.curX = p.x;
        this.dragState.curY = p.y;
        this.render();
      });
      this.canvas.addEventListener('pointerup', (e) => {
        this.canvas?.releasePointerCapture(e.pointerId);
        const drag = this.dragState;
        this.dragState = null;
        if (!drag) return;
        const x = Math.min(drag.startX, drag.curX);
        const y = Math.min(drag.startY, drag.curY);
        const width = Math.abs(drag.curX - drag.startX);
        const height = Math.abs(drag.curY - drag.startY);
        if (width > 4 && height > 4) {
          const minSize = 16;
          const w = clamp(width, minSize, this.imgW);
          const h = clamp(height, minSize, this.imgH);
          this.viewRect = {
            x: clamp(x, 0, this.imgW - w),
            y: clamp(y, 0, this.imgH - h),
            width: w,
            height: h,
          };
          this.updateZoomReadout();
        }
        this.render();
      });
    }

    void this.loadCurrentStage(true);
  }

  private updateStageButtons(): void {
    this.stageListEl?.querySelectorAll<HTMLButtonElement>('.stage-item').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.index) === this.stageIndex);
    });
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

  private clientToImagePoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = this.canvas;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const cx = clamp(((e.clientX - rect.left) / rect.width) * canvas.width, 0, canvas.width);
    const cy = clamp(((e.clientY - rect.top) / rect.height) * canvas.height, 0, canvas.height);
    const x = this.viewRect.x + (cx / canvas.width) * this.viewRect.width;
    const y = this.viewRect.y + (cy / canvas.height) * this.viewRect.height;
    return { x, y };
  }

  private async loadCurrentStage(resetZoom: boolean): Promise<void> {
    const stage = STAGES[this.stageIndex];
    if (!stage) return;
    if (this.captionEl) this.captionEl.textContent = `${PLAN_LABELS[this.plan]} — ${stage.label}`;
    this.setStatus('Loading…');
    try {
      const path = stagePath(this.plan, stage);
      let pending = this.imageCache.get(path);
      if (!pending) {
        pending = (async () => {
          const url = await readFileAsBlobUrl(path);
          const img = new Image();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error(`failed to decode ${path}`));
            img.src = url;
          });
          return img;
        })();
        this.imageCache.set(path, pending);
      }
      const img = await pending;
      this.currentImage = img;
      this.imgW = img.naturalWidth;
      this.imgH = img.naturalHeight;
      if (resetZoom) {
        this.viewRect = { x: 0, y: 0, width: this.imgW, height: this.imgH };
        this.updateZoomReadout();
      }
      this.setStatus(null);
      this.render();
    } catch (err) {
      this.setStatus(`Failed to load stage image: ${err instanceof Error ? err.message : String(err)}. Has the pipeline been run since this widget was built? (python3 scripts/extract_vector_layers.py)`);
    }
  }

  private updateZoomReadout(): void {
    if (!this.zoomReadoutEl) return;
    const full = this.viewRect.width >= this.imgW && this.viewRect.height >= this.imgH;
    this.zoomReadoutEl.textContent = full
      ? 'Showing full extent'
      : `Zoomed to ${Math.round(this.viewRect.width)}×${Math.round(this.viewRect.height)} px`;
  }

  private render(): void {
    const canvas = this.canvas;
    const img = this.currentImage;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const v = this.viewRect;
    ctx.drawImage(img, v.x, v.y, v.width, v.height, 0, 0, canvas.width, canvas.height);

    if (this.dragState) {
      const x = Math.min(this.dragState.startX, this.dragState.curX);
      const y = Math.min(this.dragState.startY, this.dragState.curY);
      const w = Math.abs(this.dragState.curX - this.dragState.startX);
      const h = Math.abs(this.dragState.curY - this.dragState.startY);
      const scaleX = canvas.width / v.width;
      const scaleY = canvas.height / v.height;
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]);
      ctx.strokeRect((x - v.x) * scaleX, (y - v.y) * scaleY, w * scaleX, h * scaleY);
      ctx.restore();
    }
  }
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

customElements.define('pipeline-stage-viewer', PipelineStageViewerElement);
