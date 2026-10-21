// Layer Stack -- a drag-and-drop layer picker/orderer for the companion
// desk_widgets/layered-map/ widget. Every layer exposed by any of the
// `natural-earth-map`, `samothrace-tiles`, or `samothrace-vectors`
// (added 2026-10-20 -- see desk_hmsvc/samothrace-vectors/service.py's
// own header comment) hmsvcs shows up here as a small labelled "chip." Chips not currently in use sit in a free-form
// palette area (drop them anywhere; position is purely cosmetic, saved
// to this widget INSTANCE's own persisted local data, never shared).
// Chips dragged into the central Stack column are the layers Layered Map
// actually draws, ordered top-to-bottom = closest-to-the-viewer-first
// in z-order -- written to the shared state key
// `samothrace.mapLayerStack` (STACK_STATE_KEY below) on every change,
// which is what Layered Map reads (once at its own startup, and live via
// the shared platform's own change notifications -- see
// `desk_widgets/_shared/platform.ts`). See that widget's own
// layered-map.ts header comment for the reader's half of this contract.
//
// Drag-and-drop here is custom, pointer-event-based (pointerdown/
// setPointerCapture/pointermove/pointerup) rather than native HTML5
// drag-and-drop -- matching this project's own established convention
// (samothrace-map.ts's image-overlay reposition drag uses the same
// pattern; there is no native-HTML5-DnD code anywhere else in this
// project). Native DnD's own drag-image/dataTransfer machinery would
// also make "drop in the neutral area at exactly wherever you let go"
// (a real, literal request, not a loose paraphrase) more awkward to
// implement than simply reading the pointer's own final position.

// This project's bundled `tsc` (3.8.3) predates the DOM lib's
// ResizeObserver typings -- same workaround every other widget in this
// project already uses; not actually needed by this widget's own logic
// (no canvas/no size-dependent redraw), but harmless to omit entirely.
// (Left out here since this widget truly has no use for it.)

// ── Constants ──
//
// Service URLs are resolved through the shared platform module (see
// `desk_widgets/_shared/platform.ts`) by plain service name -- no
// host-specific key format is known here at all.

const NE_SERVICE_NAME = 'natural-earth-map';
const TILES_SERVICE_NAME = 'samothrace-tiles';
const VECTORS_SERVICE_NAME = 'samothrace-vectors';

// See desk_widgets/layered-map/layered-map.ts's own header comment for
// the full contract this key is part of -- this widget is the WRITER.
const STACK_STATE_KEY = 'samothrace.mapLayerStack';

type MapSource = 'natural-earth-map' | 'samothrace-tiles' | 'samothrace-vectors';

function makeLayerKey(source: MapSource, id: string): string {
  return `${source}|${id}`;
}

function parseLayerKey(key: string): { source: MapSource; id: string } | null {
  const i = key.indexOf('|');
  if (i < 0) return null;
  const source = key.slice(0, i);
  const id = key.slice(i + 1);
  if (source !== 'natural-earth-map' && source !== 'samothrace-tiles' && source !== 'samothrace-vectors') return null;
  if (!id) return null;
  return { source, id };
}

// A per-group fallback color for samothrace-tiles' own raster layers,
// which (unlike natural-earth-map's vector layers) carry no `color`
// field of their own -- there's nothing per-layer to show a swatch of,
// so this is purely a visual grouping cue in this widget's own chip
// list, picked by eye, not meaningful outside this UI.
const RASTER_GROUP_COLORS: Record<string, string> = {
  imagery: '#8ab4f8',
  restored: '#f2b134',
  'pipeline-topographic': '#9aa5b5',
};
const RASTER_DEFAULT_COLOR = '#5fd4a0';

function rasterColorForGroup(group: string): string {
  return RASTER_GROUP_COLORS[group] ?? RASTER_DEFAULT_COLOR;
}

const SOURCE_BADGE: Record<MapSource, string> = {
  'natural-earth-map': 'NE',
  'samothrace-tiles': 'Tiles',
  'samothrace-vectors': 'Vectors',
};

interface CatalogLayer {
  source: MapSource;
  id: string;
  label: string;
  group: string;
  order: number;
  color: string;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

// ── Startup load retry -- byte-for-byte the same class as
// layered-map.ts/samothrace-map.ts/natural-earth-map.ts/gazetteer.ts's
// own copies (see any of those for the full "why"), duplicated per
// this project's established convention. ──
const RETRY_BACKOFF_SEC = [1, 5, 10, 60, 300];

class RetryingLoader {
  private attemptIndex = 0;
  private countdownTimer: number | null = null;
  private remainingSec = 0;
  private gaveUp = false;
  private running = false;

  constructor(private readonly container: HTMLElement, private readonly attempt: () => Promise<void>) {}

  start(): void {
    void this.runAttempt();
  }

  setMessage(text: string): void {
    if (!this.running) return;
    this.container.innerHTML = `<div class="retry-box"><div class="retry-message">${escapeHtml(text)}</div></div>`;
    this.container.style.display = 'flex';
  }

  retryNow(): void {
    this.clearCountdown();
    if (this.gaveUp) {
      this.attemptIndex = 0;
      this.gaveUp = false;
    }
    void this.runAttempt();
  }

  private clearCountdown(): void {
    if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private async runAttempt(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.clearCountdown();
    this.setMessage('Loading…');
    try {
      await this.attempt();
      this.attemptIndex = 0;
      this.gaveUp = false;
      this.container.style.display = 'none';
    } catch (err) {
      this.scheduleRetry(err);
    } finally {
      this.running = false;
    }
  }

  private scheduleRetry(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (this.attemptIndex >= RETRY_BACKOFF_SEC.length) {
      this.gaveUp = true;
      this.render(message, null);
      return;
    }
    const delaySec = RETRY_BACKOFF_SEC[this.attemptIndex]!;
    this.attemptIndex++;
    this.remainingSec = delaySec;
    this.render(message, this.remainingSec);
    this.countdownTimer = window.setInterval(() => {
      this.remainingSec--;
      if (this.remainingSec <= 0) {
        this.clearCountdown();
        void this.runAttempt();
      } else {
        this.render(message, this.remainingSec);
      }
    }, 1000);
  }

  private render(message: string, countdownSec: number | null): void {
    const countdownHtml = countdownSec !== null
      ? `<div class="retry-countdown">Retrying in ${countdownSec}s…</div>`
      : `<div class="retry-countdown">Giving up after repeated failures.</div>`;
    this.container.innerHTML =
      `<div class="retry-box">` +
      `<div class="retry-message">${escapeHtml(message)}</div>` +
      countdownHtml +
      `<button type="button" class="retry-button">Retry now</button>` +
      `</div>`;
    this.container.style.display = 'flex';
    this.container.querySelector('.retry-button')?.addEventListener('click', () => this.retryNow());
  }
}

// ── Element ──

const CHIP_WIDTH = 160;
const CHIP_HEIGHT = 32;
const CHIP_GAP = 8;

interface DragState {
  pointerId: number;
  key: string;
  chip: HTMLElement;
  offsetX: number;
  offsetY: number;
  pendingPaletteXY: { x: number; y: number } | null; // last computed drop position while hovering the palette, used on pointerup if the chip ends up NOT in the stack
}

class LayerStackElement extends HTMLElement {
  private statusEl: HTMLElement | null = null;
  private stackColumnEl: HTMLElement | null = null;
  private paletteAreaEl: HTMLElement | null = null;
  // A plain, render()-untouched overlay the dragged chip is reparented
  // into for the duration of a drag -- see onChipPointerDown's own
  // comment for why this is required, not just tidy: `renderStack`/
  // `renderPalette` rebuild their own container via `innerHTML =`,
  // which would destroy the dragged chip outright if it were still a
  // DOM child of either container when that runs.
  private dragLayerEl: HTMLElement | null = null;
  private loader: RetryingLoader | null = null;

  private catalog = new Map<string, CatalogLayer>(); // keyed by makeLayerKey(source,id)
  private stack: string[] = []; // keys, closest-to-viewer first
  private palettePositions = new Map<string, { x: number; y: number }>(); // keys not currently in `stack`

  private saveLocalTimer: number | null = null;
  private saveStackTimer: number | null = null;
  private drag: DragState | null = null;

  connectedCallback(): void {
    const template = document.getElementById('layer-stack-template') as HTMLTemplateElement | null;
    if (!template) return;
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(template.content.cloneNode(true));

    this.statusEl = shadow.querySelector('.status-overlay');
    this.stackColumnEl = shadow.querySelector('.stack-column');
    this.paletteAreaEl = shadow.querySelector('.palette-area');
    this.dragLayerEl = shadow.querySelector('.drag-layer');

    void this.init();
  }

  // ── Startup ──

  private async init(): Promise<void> {
    this.watchState();
    if (!this.statusEl) return;
    this.loader = new RetryingLoader(this.statusEl, () => this.attemptLoad());
    this.loader.start();
  }

  private async attemptLoad(): Promise<void> {
    this.loader?.setMessage('Finding map services…');
    const [neServiceUrl, tilesServiceUrl, vectorsServiceUrl] = await Promise.all([
      sharedPlatform.getServiceUrl(NE_SERVICE_NAME),
      sharedPlatform.getServiceUrl(TILES_SERVICE_NAME),
      sharedPlatform.getServiceUrl(VECTORS_SERVICE_NAME),
    ]);
    if (!neServiceUrl) {
      throw new Error(`${NE_SERVICE_NAME} service is not running yet -- start it from the Microservices widget if this persists`);
    }
    if (!tilesServiceUrl) {
      throw new Error(`${TILES_SERVICE_NAME} service is not running yet -- start it from the Microservices widget if this persists`);
    }
    if (!vectorsServiceUrl) {
      throw new Error(`${VECTORS_SERVICE_NAME} service is not running yet -- start it from the Microservices widget if this persists`);
    }

    this.loader?.setMessage('Loading layer catalogs…');
    const catalog = new Map<string, CatalogLayer>();
    // natural-earth-map and samothrace-vectors are both already-colored
    // vector sources (their own /layers response includes a per-layer
    // `color`) -- shared by one small helper rather than writing out
    // the same fetch-and-populate block twice.
    const loadVectorCatalog = async (source: MapSource, serviceName: string, serviceUrl: string): Promise<void> => {
      const res = await fetch(`${serviceUrl}/layers`);
      if (!res.ok) throw new Error(`${serviceName} /layers request failed: ${res.status}`);
      const data = (await res.json()) as {
        layers: { id: string; label: string; group: string; order: number; color: string }[];
      };
      for (const m of data.layers) {
        catalog.set(makeLayerKey(source, m.id), {
          source,
          id: m.id,
          label: m.label,
          group: m.group,
          order: m.order,
          color: m.color,
        });
      }
    };
    await Promise.all([
      loadVectorCatalog('natural-earth-map', NE_SERVICE_NAME, neServiceUrl),
      loadVectorCatalog('samothrace-vectors', VECTORS_SERVICE_NAME, vectorsServiceUrl),
      (async () => {
        const res = await fetch(`${tilesServiceUrl}/layers`);
        if (!res.ok) throw new Error(`${TILES_SERVICE_NAME} /layers request failed: ${res.status}`);
        const data = (await res.json()) as { layers: { id: string; label: string; group: string; order: number }[] };
        for (const m of data.layers) {
          catalog.set(makeLayerKey('samothrace-tiles', m.id), {
            source: 'samothrace-tiles',
            id: m.id,
            label: m.label,
            group: m.group,
            order: m.order,
            color: rasterColorForGroup(m.group),
          });
        }
      })(),
    ]);
    this.catalog = catalog;

    this.loader?.setMessage('Loading layer stack…');
    const stackValue = await sharedPlatform.getSharedValue(STACK_STATE_KEY);
    this.stack = this.sanitizeStack(stackValue);

    try {
      const localData = await sharedPlatform.getLocalData();
      const rawPositions = localData.palettePositions;
      if (rawPositions && typeof rawPositions === 'object') {
        for (const [key, value] of Object.entries(rawPositions as Record<string, unknown>)) {
          const v = value as { x?: unknown; y?: unknown } | null;
          if (v && typeof v.x === 'number' && typeof v.y === 'number' && Number.isFinite(v.x) && Number.isFinite(v.y)) {
            this.palettePositions.set(key, { x: v.x, y: v.y });
          }
        }
      }
    } catch (err) {
      console.warn('restoring saved palette positions failed (best-effort, using defaults):', err);
    }

    this.assignDefaultPositions();
    this.render();
  }

  // Minimal shape validation only -- see layered-map.ts's own
  // sanitizeStack for why catalog-existence is deliberately NOT
  // enforced here either (a stale/unknown id is simply never rendered
  // as a stack chip -- see render()'s own filter -- and is preserved,
  // not silently dropped, so it reappears correctly once its catalog
  // entry exists again).
  private sanitizeStack(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string' || seen.has(entry)) continue;
      if (!parseLayerKey(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
    return out;
  }

  // Every catalog layer not currently on the stack and with no saved
  // palette position yet gets one, laid out in a simple row-major grid
  // across the palette area's own current width -- just enough so a
  // first-ever load doesn't show a pile of chips stacked at (0,0).
  private assignDefaultPositions(): void {
    const paletteWidth = Math.max(CHIP_WIDTH, this.paletteAreaEl?.clientWidth ?? 600);
    const cols = Math.max(1, Math.floor(paletteWidth / (CHIP_WIDTH + CHIP_GAP)));
    const stackSet = new Set(this.stack);
    let i = 0;
    for (const key of this.catalog.keys()) {
      if (stackSet.has(key) || this.palettePositions.has(key)) continue;
      const col = i % cols;
      const row = Math.floor(i / cols);
      this.palettePositions.set(key, {
        x: CHIP_GAP + col * (CHIP_WIDTH + CHIP_GAP),
        y: CHIP_GAP + row * (CHIP_HEIGHT + CHIP_GAP),
      });
      i++;
    }
  }

  private watchState(): void {
    sharedPlatform.onSharedValueChanged((key, value) => {
      if (key !== STACK_STATE_KEY) return;
      // Another Layer Stack instance (or any other writer) changed the
      // shared stack -- stay in sync, but only if we're not mid-drag
      // ourselves (don't yank the stack out from under an in-progress
      // local reorder).
      if (this.drag) return;
      this.stack = this.sanitizeStack(value);
      this.assignDefaultPositions();
      this.render();
    });
    for (const serviceName of [NE_SERVICE_NAME, TILES_SERVICE_NAME, VECTORS_SERVICE_NAME]) {
      sharedPlatform.onServiceUrlChanged(serviceName, () => {
        console.warn(`${serviceName} service URL changed -- reloading catalog`);
        this.loader?.retryNow();
      });
    }
  }

  // ── Persistence ──

  private scheduleSaveLocal(): void {
    if (this.saveLocalTimer !== null) return;
    this.saveLocalTimer = window.setTimeout(() => {
      this.saveLocalTimer = null;
      const positions: Record<string, { x: number; y: number }> = {};
      for (const [key, pos] of this.palettePositions) positions[key] = pos;
      void sharedPlatform.setLocalData({ palettePositions: positions });
    }, 400);
  }

  private scheduleSaveStack(): void {
    if (this.saveStackTimer !== null) return;
    this.saveStackTimer = window.setTimeout(() => {
      this.saveStackTimer = null;
      void sharedPlatform.setSharedValue(STACK_STATE_KEY, this.stack);
    }, 200);
  }

  // ── Rendering ──

  private render(): void {
    this.renderStack(null);
    this.renderPalette(null);
  }

  // `excludeKey` omits one chip from the static re-render -- used
  // during a live drag, where the dragged chip is a separate,
  // independently pointer-tracked element (see onChipPointerDown)
  // rather than part of the normal flow/grid being rebuilt here.
  // `excludeKey`'s own slot renders a `.drop-target` placeholder instead
  // of being skipped (2026-10-20) -- `this.stack` already holds the
  // dragged key at its own live, continuously-updated insertion index
  // while a drag is hovering this column (see onChipPointerMove's own
  // stack-splice), so rendering AT that position, rather than omitting
  // it, is exactly "where the item will be inserted." If `excludeKey`
  // isn't currently in `this.stack` at all (the drag is hovering the
  // palette instead, or hasn't moved yet, or came from the palette and
  // hasn't crossed into the stack column yet), the loop below simply
  // never hits it -- no placeholder appears, correctly, since there's
  // no insertion position to show.
  private renderStack(excludeKey: string | null): void {
    if (!this.stackColumnEl) return;
    const parts: string[] = [];
    for (const key of this.stack) {
      if (key === excludeKey) {
        parts.push('<div class="drop-target"></div>');
        continue;
      }
      const layer = this.catalog.get(key);
      if (!layer) continue; // stale/unknown id -- see sanitizeStack's own comment; skipped, not dropped
      parts.push(this.chipHtml(key, layer));
    }
    this.stackColumnEl.innerHTML = parts.join('');
    this.wireChips(this.stackColumnEl);
  }

  private renderPalette(excludeKey: string | null): void {
    if (!this.paletteAreaEl) return;
    const parts: string[] = [];
    const paletteWidth = Math.max(CHIP_WIDTH + CHIP_GAP * 2, this.paletteAreaEl.clientWidth || 600);
    const paletteHeight = Math.max(CHIP_HEIGHT + CHIP_GAP * 2, this.paletteAreaEl.clientHeight || 400);
    const stackSet = new Set(this.stack);
    for (const [key, layer] of this.catalog) {
      if (stackSet.has(key) || key === excludeKey) continue;
      const pos = this.palettePositions.get(key) ?? { x: CHIP_GAP, y: CHIP_GAP };
      // Clamp on every render -- self-heals a position that's drifted
      // outside the palette's current size (e.g. after a widget
      // resize) rather than letting a chip go permanently off-screen.
      const x = Math.min(Math.max(pos.x, 0), Math.max(0, paletteWidth - CHIP_WIDTH));
      const y = Math.min(Math.max(pos.y, 0), Math.max(0, paletteHeight - CHIP_HEIGHT));
      parts.push(this.chipHtml(key, layer, { x, y }));
    }
    this.paletteAreaEl.innerHTML = parts.join('');
    this.wireChips(this.paletteAreaEl);
  }

  private chipHtml(key: string, layer: CatalogLayer, absoluteXY?: { x: number; y: number }): string {
    const style = absoluteXY
      ? ` style="position:absolute; left:${absoluteXY.x}px; top:${absoluteXY.y}px; width:${CHIP_WIDTH}px;"`
      : '';
    return (
      `<div class="layer-chip" data-key="${escapeHtml(key)}" title="${escapeHtml(layer.label)} (${escapeHtml(SOURCE_BADGE[layer.source])})"${style}>` +
      `<span class="chip-swatch" style="background:${escapeHtml(layer.color)}"></span>` +
      `<span class="chip-label">${escapeHtml(layer.label)}</span>` +
      `<span class="chip-source">${escapeHtml(SOURCE_BADGE[layer.source])}</span>` +
      `</div>`
    );
  }

  private wireChips(container: HTMLElement): void {
    container.querySelectorAll<HTMLElement>('.layer-chip').forEach((chip) => {
      chip.addEventListener('pointerdown', (e) => this.onChipPointerDown(e, chip));
    });
  }

  // ── Drag-and-drop ──
  //
  // The dragged chip stays the SAME DOM element for the whole gesture
  // (no clone/placeholder) -- on pointerdown it switches to
  // `position: fixed` and follows the pointer directly; every OTHER
  // chip is re-rendered live around it (renderStack/renderPalette with
  // `excludeKey` set) as the in-memory `stack`/`palettePositions` state
  // changes. On pointerup, the dragged chip's inline position styles
  // are cleared and a full render() puts it back in normal flow at its
  // final place -- this also re-attaches a fresh pointerdown listener
  // to it (the old one closed over a `chip` HTMLElement reference,
  // which is a bit wasteful to keep after a full render() replaces
  // every chip element anyway, but harmless -- the detached element is
  // simply garbage-collected once nothing references it).

  private onChipPointerDown(e: PointerEvent, chip: HTMLElement): void {
    const key = chip.dataset.key;
    if (!key) return;
    e.preventDefault();
    // Capture the chip's current on-screen box BEFORE touching the DOM
    // at all -- reparenting below doesn't itself move it visually (no
    // layout change yet), but do this first regardless so there's never
    // any ambiguity about which box is being read.
    const rect = chip.getBoundingClientRect();
    // Reparent the dragged chip itself out of its origin container
    // (.stack-column or .palette-area) and into .drag-layer, a plain
    // overlay `render()`/`renderStack()`/`renderPalette()` never write
    // into. This MUST happen before the renderStack/renderPalette calls
    // below: both rebuild their own container via `innerHTML = ...`,
    // which -- before this fix -- destroyed the live, pointer-captured
    // chip outright the instant a drag began (it was still a DOM child
    // of the container being overwritten), silently losing pointer
    // capture and leaving the drag permanently stuck with no further
    // pointermove/pointerup ever firing. Moving it here first means
    // neither container's rebuild ever touches it.
    this.dragLayerEl?.appendChild(chip);
    chip.setPointerCapture(e.pointerId);
    chip.classList.add('dragging');
    chip.style.position = 'fixed';
    chip.style.left = `${rect.left}px`;
    chip.style.top = `${rect.top}px`;
    chip.style.width = `${rect.width}px`;
    chip.style.zIndex = '1000';

    this.drag = {
      pointerId: e.pointerId,
      key,
      chip,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      pendingPaletteXY: null,
    };

    // Re-render everything ELSE now (excluding this chip) so the stack
    // column immediately reflows without this chip's old slot, whether
    // it came from the stack or the palette.
    this.renderStack(key);
    this.renderPalette(key);

    chip.addEventListener('pointermove', this.onChipPointerMoveBound);
    chip.addEventListener('pointerup', this.onChipPointerUpBound);
    chip.addEventListener('pointercancel', this.onChipPointerCancelBound);
  }

  // Bound once per instance (not per chip) so add/removeEventListener
  // reference the same function identity -- a fresh arrow function per
  // call-site would never actually unregister.
  private readonly onChipPointerMoveBound = (e: PointerEvent) => this.onChipPointerMove(e);
  private readonly onChipPointerUpBound = (e: PointerEvent) => this.onChipPointerUp(e);
  private readonly onChipPointerCancelBound = () => this.onChipPointerCancel();

  private onChipPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag.chip.style.left = `${e.clientX - drag.offsetX}px`;
    drag.chip.style.top = `${e.clientY - drag.offsetY}px`;

    const stackRect = this.stackColumnEl?.getBoundingClientRect();
    const overStack = !!stackRect &&
      e.clientX >= stackRect.left && e.clientX <= stackRect.right &&
      e.clientY >= stackRect.top && e.clientY <= stackRect.bottom;

    if (overStack) {
      const index = this.computeStackInsertionIndex(e.clientY, drag.key);
      const withoutKey = this.stack.filter((k) => k !== drag.key);
      withoutKey.splice(index, 0, drag.key);
      this.stack = withoutKey;
      this.renderStack(drag.key);
      this.renderPalette(drag.key);
    } else {
      if (this.stack.includes(drag.key)) {
        this.stack = this.stack.filter((k) => k !== drag.key);
        this.renderStack(drag.key);
      }
      const paletteRect = this.paletteAreaEl?.getBoundingClientRect();
      if (paletteRect) {
        drag.pendingPaletteXY = {
          x: e.clientX - paletteRect.left - drag.offsetX,
          y: e.clientY - paletteRect.top - drag.offsetY,
        };
      }
      this.renderPalette(drag.key);
    }
  }

  private computeStackInsertionIndex(clientY: number, excludeKey: string): number {
    if (!this.stackColumnEl) return 0;
    const rows = Array.from(this.stackColumnEl.querySelectorAll<HTMLElement>('.layer-chip')).filter(
      (el) => el.dataset.key !== excludeKey
    );
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length;
  }

  private onChipPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag.chip.releasePointerCapture(e.pointerId);
    drag.chip.removeEventListener('pointermove', this.onChipPointerMoveBound);
    drag.chip.removeEventListener('pointerup', this.onChipPointerUpBound);
    drag.chip.removeEventListener('pointercancel', this.onChipPointerCancelBound);

    if (!this.stack.includes(drag.key) && drag.pendingPaletteXY) {
      const paletteWidth = Math.max(CHIP_WIDTH + CHIP_GAP * 2, this.paletteAreaEl?.clientWidth || 600);
      const paletteHeight = Math.max(CHIP_HEIGHT + CHIP_GAP * 2, this.paletteAreaEl?.clientHeight || 400);
      this.palettePositions.set(drag.key, {
        x: Math.min(Math.max(drag.pendingPaletteXY.x, 0), Math.max(0, paletteWidth - CHIP_WIDTH)),
        y: Math.min(Math.max(drag.pendingPaletteXY.y, 0), Math.max(0, paletteHeight - CHIP_HEIGHT)),
      });
    }

    // Drop the now-finished drag copy -- the upcoming full render()
    // creates a brand-new, normally-parented chip element for this key
    // from scratch; leaving this one behind in .drag-layer would be an
    // invisible (but real) duplicate DOM node for this key.
    drag.chip.remove();
    this.drag = null;
    this.scheduleSaveLocal();
    this.scheduleSaveStack();
    this.render();
  }

  private onChipPointerCancel(): void {
    // Treat a cancelled gesture the same as a drop at its current
    // position -- simplest correct behavior, and pointercancel is rare
    // in practice (a browser-level gesture interruption, not a normal
    // user action).
    const drag = this.drag;
    if (!drag) return;
    drag.chip.removeEventListener('pointermove', this.onChipPointerMoveBound);
    drag.chip.removeEventListener('pointerup', this.onChipPointerUpBound);
    drag.chip.removeEventListener('pointercancel', this.onChipPointerCancelBound);
    drag.chip.remove(); // see onChipPointerUp's own comment -- same cleanup
    this.drag = null;
    this.scheduleSaveLocal();
    this.scheduleSaveStack();
    this.render();
  }
}

customElements.define('layer-stack', LayerStackElement);
