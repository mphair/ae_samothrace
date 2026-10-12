// Samothrace Map -- a hand-written (no Leaflet, no external libraries)
// canvas tile viewer over the Samothrace site plan. Tiles are served by
// the `samothrace-tiles` hmsvc microservice (desk_hmsvc/samothrace-tiles/)
// over plain HTTP -- real browser caching, no per-tile Bridge round trip.
// Every raster layer (including two synthesized ones: a shared
// "topographic" base and each plan's own "structures" line work, derived
// by the service from the raw Actual/Restored State Plan tiles) is an
// independently toggleable layer, composited in a fixed stacking order.
//
// Selecting a monument (by click or from the dropdown) publishes it to
// Desk's shared, project-scoped state so the separate "Samothrace
// Monument Description" widget can display it -- unchanged from before.

interface Window {
  desk?: {
    self: {
      getLocalStorage(): Promise<{ data: Record<string, unknown> }>;
      setLocalStorage(data: Record<string, unknown>): Promise<{ ok: boolean }>;
      setSubtitle(text: string | null): Promise<{ ok: boolean }>;
    };
    fs: {
      readFile(path: string): Promise<{ contents: string }>;
    };
    state: {
      get(key: string): Promise<{ value: unknown; edit: unknown }>;
      set(key: string, value: unknown, edit?: unknown): Promise<{ ok: boolean }>;
    };
  };
}

// This project's bundled `tsc` (3.8.3) predates the DOM lib's
// ResizeObserver typings, even though real browsers have long supported it.
declare class ResizeObserver {
  constructor(callback: () => void);
  observe(target: Element): void;
  disconnect(): void;
}

// ── Constants ──

// The samothrace-tiles hmsvc service's URL is discovered at startup from
// Desk's shared state (mirrored to `desk.hmsvc.<name>` as {status, url}),
// rather than hard-coded -- the service gets a fresh random port on every
// launch, and this way the widget only needs the "state" capability it
// already holds (no "hmsvc" capability needed just to read one URL).
const TILE_SERVICE_NAME = 'samothrace-tiles';
const TILE_SERVICE_STATE_KEY = `desk.hmsvc.${TILE_SERVICE_NAME}`;
const STATE_KEY = 'samothrace.selectedMonument';
const INTRO_WEBCODE = '(0)Introduction';
const OVERLAY_PATHS: Record<'Actual' | 'Restored', string> = {
  Actual: 'Data/mapFeatures/SamoWeb_ActualStatePlan_Overlay.geojson',
  Restored: 'Data/mapFeatures/SamoWeb_RestoredStatePlan_Overlay.geojson',
};
// Which raster layer ids make a given plan's overlay "relevant" -- hover
// and click hit-testing for that plan's monument polygons are only live
// while at least one of its own layers is actually visible, so you can
// never select something you can't currently see.
const PLAN_RELEVANT_LAYERS: Record<'Actual' | 'Restored', string[]> = {
  Actual: ['actual-structures', 'actual-monuments'],
  Restored: ['restored-structures', 'restored-monuments'],
};

interface LayerMeta {
  id: string;
  label: string;
  group: string;
  order: number;
  defaultVisible: boolean;
}

interface SelectedMonument {
  webCode: string;
  label: string;
  name: string;
  plan: string;
}

interface LonLatBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface Feature {
  type: 'Feature';
  properties: { WebCode: string; Label: string; Name: string; [key: string]: unknown };
  geometry: { type: string; coordinates: unknown };
}

// ── Web Mercator tile math (EPSG:3857), standard slippy-map formulas --
// no library, just the well-known projection every XYZ tile scheme uses. ──

function clampLat(lat: number): number {
  return Math.max(-85.05112878, Math.min(85.05112878, lat));
}

function projectWorld(lon: number, lat: number, zoom: number, tileSize: number): { x: number; y: number } {
  const n = Math.pow(2, zoom) * tileSize;
  const x = ((lon + 180) / 360) * n;
  const latRad = (clampLat(lat) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

function unprojectWorld(x: number, y: number, zoom: number, tileSize: number): { lon: number; lat: number } {
  const n = Math.pow(2, zoom) * tileSize;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lon, lat: (latRad * 180) / Math.PI };
}

function collectRings(geometry: { type: string; coordinates: unknown }): number[][][] {
  if (geometry.type === 'Polygon') {
    return geometry.coordinates as number[][][];
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as number[][][][]).flat();
  }
  return [];
}

function featureBounds(feature: Feature): LonLatBounds {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const ring of collectRings(feature.geometry)) {
    for (const [lon, lat] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return { west, south, east, north };
}

function featureCenterLonLat(feature: Feature): { lon: number; lat: number } {
  const b = featureBounds(feature);
  return { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 };
}

function unionBounds(list: LonLatBounds[]): LonLatBounds {
  return list.reduce((acc, b) => ({
    west: Math.min(acc.west, b.west),
    south: Math.min(acc.south, b.south),
    east: Math.max(acc.east, b.east),
    north: Math.max(acc.north, b.north),
  }));
}

function padBounds(b: LonLatBounds, fraction: number): LonLatBounds {
  const w = (b.east - b.west) * fraction || 0.0005;
  const h = (b.north - b.south) * fraction || 0.0005;
  return { west: b.west - w, south: b.south - h, east: b.east + w, north: b.north + h };
}

// ── Monument "Label" sort key -- labels are plain numbers ("13"), ranges
// ("1-3", sorted by their first number) or lettered sub-parts ("11a",
// "11b", sorted just after/before their base number). ──
function sortKeyForLabel(label: string): number {
  const base = (label.split('-')[0] ?? label).replace('a', '.2').replace('b', '.5');
  const n = Number(base);
  return Number.isNaN(n) ? 0 : n;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

// ── Tile image cache ──

interface TileEntry {
  img: HTMLImageElement;
  status: 'loading' | 'loaded' | 'error';
}

// ── Overlay styling ──

type Style = { fillStyle: string; strokeStyle: string; lineWidth: number };
const BASE_STYLE: Style = { fillStyle: 'rgba(0,0,0,0)', strokeStyle: 'rgba(0,0,0,0)', lineWidth: 0 };
const HOVER_STYLE: Style = { fillStyle: 'rgba(255,255,255,0.25)', strokeStyle: 'rgba(255,255,255,0.9)', lineWidth: 2 };
const SELECTED_STYLE: Style = { fillStyle: 'rgba(255,216,77,0.35)', strokeStyle: 'rgba(255,216,77,0.95)', lineWidth: 2 };

interface OverlayPath {
  plan: 'Actual' | 'Restored';
  feature: Feature;
  path: Path2D;
}

// ── Element ──

class SamothraceMapElement extends HTMLElement {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private selectEl: HTMLSelectElement | null = null;
  private homeButtonEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private layersPanelEl: HTMLElement | null = null;
  private zoomLabelEl: HTMLElement | null = null;
  private debugHitTraceToggleEl: HTMLInputElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private debugHitTraceVisible = false;
  private debugHitTrace: Array<{ x: number; y: number; hit: boolean; click: boolean; webCode: string | null }> = [];

  private serviceUrl: string | null = null;
  private layerMetas: LayerMeta[] = [];
  private visibleLayers = new Set<string>();
  private tileCache = new Map<string, TileEntry>();

  private minZoom = 17;
  private maxZoom = 22;
  private tileSize = 256;
  private dpr = 1;
  private viewportWidth = 1;
  private viewportHeight = 1;

  private view = { lon: 25.526, lat: 40.495, zoom: 19 }; // overwritten once overlay data loads
  private actualFeatures: Feature[] = [];
  private restoredFeatures: Feature[] = [];
  private combinedBounds: LonLatBounds | null = null;

  private selectedWebCode: string | null = null;
  private hoverKey: string | null = null;
  private lastOverlayPaths: OverlayPath[] = [];

  private dragState: { startClientX: number; startClientY: number; startLon: number; startLat: number; moved: boolean } | null = null;
  private lastWheelAt = 0;
  private redrawScheduled = false;

  connectedCallback(): void {
    const template = document.getElementById('samothrace-map-template');
    if (!(template instanceof HTMLTemplateElement)) {
      throw new Error('samothrace-map-template not found');
    }
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(template.content.cloneNode(true));

    this.canvas = shadow.querySelector('.map-canvas');
    this.selectEl = shadow.querySelector('.monument-select');
    this.homeButtonEl = shadow.querySelector('.home-button');
    this.statusEl = shadow.querySelector('.status-overlay');
    this.layersPanelEl = shadow.querySelector('.layers-list');
    this.zoomLabelEl = shadow.querySelector('.zoom-label');
    this.debugHitTraceToggleEl = shadow.querySelector('.debug-hit-trace-toggle');
    this.ctx = this.canvas?.getContext('2d') ?? null;

    this.debugHitTraceToggleEl?.addEventListener('change', () => {
      this.debugHitTraceVisible = this.debugHitTraceToggleEl?.checked ?? false;
      this.scheduleRedraw();
    });
    shadow.querySelector('.debug-clear-button')?.addEventListener('click', () => {
      this.debugHitTrace = [];
      this.scheduleRedraw();
    });

    this.homeButtonEl?.addEventListener('click', () => this.selectFeature(null));
    this.selectEl?.addEventListener('change', () => {
      const v = this.selectEl?.value ?? INTRO_WEBCODE;
      this.selectFeature(v === INTRO_WEBCODE ? null : v);
    });
    shadow.querySelector('.zoom-in-button')?.addEventListener('click', () => this.zoomBy(1, this.viewportWidth / 2, this.viewportHeight / 2));
    shadow.querySelector('.zoom-out-button')?.addEventListener('click', () => this.zoomBy(-1, this.viewportWidth / 2, this.viewportHeight / 2));

    if (this.canvas) {
      this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
      this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
      this.canvas.addEventListener('pointerleave', () => {
        if (this.hoverKey) {
          this.hoverKey = null;
          this.scheduleRedraw();
        }
      });
      this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    }

    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    if (this.canvas) this.resizeObserver.observe(this.canvas);
    this.resizeCanvas();

    void this.init();
  }

  disconnectedCallback(): void {
    this.resizeObserver?.disconnect();
  }

  private setStatus(text: string | null): void {
    if (!this.statusEl) return;
    if (text) {
      this.statusEl.textContent = text;
      (this.statusEl as HTMLElement).style.display = 'flex';
    } else {
      (this.statusEl as HTMLElement).style.display = 'none';
    }
  }

  // ── Startup ──

  private async init(): Promise<void> {
    const desk = window.desk;
    try {
      if (!desk) throw new Error('Desk bridge unavailable');

      const tileService = await desk.state.get(TILE_SERVICE_STATE_KEY);
      const tileServiceValue = tileService.value as { status: string; url: string | null } | null;
      if (!tileServiceValue || !tileServiceValue.url) {
        throw new Error(
          `${TILE_SERVICE_NAME} tile service is not running -- start it from the Microservices widget`
        );
      }
      this.serviceUrl = tileServiceValue.url.replace(/\/+$/, '');

      this.setStatus('Loading layers…');
      await this.loadLayerMeta();
      this.buildLayersPanel();

      this.setStatus('Loading monument data…');
      await this.loadOverlays();
      this.buildDropdown();
      this.combinedBounds = unionBounds([...this.actualFeatures, ...this.restoredFeatures].map(featureBounds));

      const { data: localData } = await desk.self.getLocalStorage();
      const savedLayers = Array.isArray(localData.visibleLayers) ? (localData.visibleLayers as string[]) : null;
      if (savedLayers) {
        this.visibleLayers = new Set(savedLayers.filter((id) => this.layerMetas.some((m) => m.id === id)));
        this.syncLayerCheckboxes();
      }

      const existing = await desk.state.get(STATE_KEY);
      const value = existing.value as SelectedMonument | null;
      if (value && value.webCode && value.webCode !== INTRO_WEBCODE && this.findAllMatching(value.webCode).length > 0) {
        this.selectFeature(value.webCode, false);
      } else if (this.combinedBounds) {
        this.fitToBounds(this.combinedBounds, 0.08);
      }

      this.setStatus(null);
      this.scheduleRedraw();
    } catch (err) {
      this.setStatus(`Failed to load map: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadLayerMeta(): Promise<void> {
    if (!this.serviceUrl) throw new Error('tile service URL unknown');
    const res = await fetch(`${this.serviceUrl}/layers`);
    if (!res.ok) throw new Error(`/layers request failed: ${res.status}`);
    const data = (await res.json()) as { layers: LayerMeta[]; minZoom: number; maxZoom: number; tileSize: number };
    this.layerMetas = data.layers;
    this.minZoom = data.minZoom;
    this.maxZoom = data.maxZoom;
    this.tileSize = data.tileSize;
    this.view.zoom = Math.min(Math.max(this.view.zoom, this.minZoom), this.maxZoom);
    this.visibleLayers = new Set(this.layerMetas.filter((l) => l.defaultVisible).map((l) => l.id));
  }

  private async loadOverlays(): Promise<void> {
    const desk = window.desk;
    if (!desk) throw new Error('Desk bridge unavailable');
    const [actualRaw, restoredRaw] = await Promise.all([
      desk.fs.readFile(OVERLAY_PATHS.Actual),
      desk.fs.readFile(OVERLAY_PATHS.Restored),
    ]);
    this.actualFeatures = (JSON.parse(actualRaw.contents) as { features: Feature[] }).features;
    this.restoredFeatures = (JSON.parse(restoredRaw.contents) as { features: Feature[] }).features;
  }

  // ── Layers panel (checkboxes) ──

  private buildLayersPanel(): void {
    if (!this.layersPanelEl) return;
    const groupLabels: Record<string, string> = { imagery: 'Imagery', shared: 'Shared', actual: 'Actual State', restored: 'Restored State' };
    const groups = Array.from(new Set(this.layerMetas.map((l) => l.group)));
    const html: string[] = [];
    for (const group of groups) {
      html.push(`<div class="layer-group-title">${escapeHtml(groupLabels[group] ?? group)}</div>`);
      for (const layer of this.layerMetas.filter((l) => l.group === group).sort((a, b) => a.order - b.order)) {
        const checked = this.visibleLayers.has(layer.id) ? 'checked' : '';
        html.push(
          `<label class="layer-row"><input type="checkbox" data-layer-id="${escapeHtml(layer.id)}" ${checked} /> ${escapeHtml(layer.label)}</label>`,
        );
      }
    }
    this.layersPanelEl.innerHTML = html.join('\n');
    this.layersPanelEl.querySelectorAll('input[type="checkbox"]').forEach((el) => {
      el.addEventListener('change', (e) => {
        const input = e.currentTarget as HTMLInputElement;
        const id = input.dataset.layerId;
        if (!id) return;
        this.onLayerToggle(id, input.checked);
      });
    });
  }

  private syncLayerCheckboxes(): void {
    this.layersPanelEl?.querySelectorAll('input[type="checkbox"]').forEach((el) => {
      const input = el as HTMLInputElement;
      const id = input.dataset.layerId;
      if (id) input.checked = this.visibleLayers.has(id);
    });
  }

  private onLayerToggle(id: string, visible: boolean): void {
    if (visible) this.visibleLayers.add(id);
    else this.visibleLayers.delete(id);
    void window.desk?.self.setLocalStorage({ visibleLayers: Array.from(this.visibleLayers) });
    this.scheduleRedraw();
  }

  // ── Dropdown ──

  private buildDropdown(): void {
    if (!this.selectEl) return;
    const byWebCode = new Map<string, Feature>();
    for (const f of [...this.actualFeatures, ...this.restoredFeatures]) {
      if (!byWebCode.has(f.properties.WebCode)) byWebCode.set(f.properties.WebCode, f);
    }
    const sorted = Array.from(byWebCode.values()).sort(
      (a, b) => sortKeyForLabel(a.properties.Label) - sortKeyForLabel(b.properties.Label),
    );
    const options = [`<option value="${INTRO_WEBCODE}">Overview — About the Interactive Plan</option>`];
    for (const f of sorted) {
      const p = f.properties;
      options.push(`<option value="${escapeHtml(p.WebCode)}">(${escapeHtml(p.Label)}) ${escapeHtml(p.Name)}</option>`);
    }
    this.selectEl.innerHTML = options.join('');
    this.selectEl.value = INTRO_WEBCODE;
  }

  // ── Selection ──

  private isOverlayInteractive(plan: 'Actual' | 'Restored'): boolean {
    return PLAN_RELEVANT_LAYERS[plan].some((id) => this.visibleLayers.has(id));
  }

  private findAllMatching(webCode: string): Array<{ plan: 'Actual' | 'Restored'; feature: Feature }> {
    const out: Array<{ plan: 'Actual' | 'Restored'; feature: Feature }> = [];
    const a = this.actualFeatures.find((f) => f.properties.WebCode === webCode);
    if (a) out.push({ plan: 'Actual', feature: a });
    const r = this.restoredFeatures.find((f) => f.properties.WebCode === webCode);
    if (r) out.push({ plan: 'Restored', feature: r });
    return out;
  }

  private selectFeature(webCode: string | null, publish = true): void {
    if (!webCode || webCode === INTRO_WEBCODE) {
      this.selectedWebCode = null;
      if (this.combinedBounds) this.fitToBounds(this.combinedBounds, 0.08);
      if (this.selectEl) this.selectEl.value = INTRO_WEBCODE;
      this.scheduleRedraw();
      if (publish) {
        void window.desk?.state.set(STATE_KEY, { webCode: INTRO_WEBCODE, label: '', name: 'Overview', plan: 'Overview' });
      }
      return;
    }

    const matches = this.findAllMatching(webCode);
    if (matches.length === 0) return;
    this.selectedWebCode = webCode;
    this.fitToBounds(padBounds(unionBounds(matches.map((m) => featureBounds(m.feature))), 0.6), 0);
    if (this.selectEl) this.selectEl.value = webCode;
    this.scheduleRedraw();
    if (publish) {
      const primary = matches.find((m) => m.plan === 'Actual') ?? matches[0]!;
      const p = primary.feature.properties;
      void window.desk?.state.set(STATE_KEY, { webCode: p.WebCode, label: p.Label, name: p.Name, plan: primary.plan });
    }
  }

  // ── View (pan/zoom) ──

  private fitToBounds(bounds: LonLatBounds, extraPadFraction: number): void {
    const b = extraPadFraction > 0 ? padBounds(bounds, extraPadFraction) : bounds;
    let zoom = this.maxZoom;
    for (; zoom >= this.minZoom; zoom--) {
      const nw = projectWorld(b.west, b.north, zoom, this.tileSize);
      const se = projectWorld(b.east, b.south, zoom, this.tileSize);
      const w = se.x - nw.x;
      const h = se.y - nw.y;
      if (w <= this.viewportWidth && h <= this.viewportHeight) break;
    }
    zoom = Math.min(Math.max(zoom, this.minZoom), this.maxZoom);
    this.view = { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2, zoom };
    this.scheduleRedraw();
  }

  private zoomBy(delta: number, anchorScreenX: number, anchorScreenY: number): void {
    const oldZoom = this.view.zoom;
    const newZoom = Math.min(Math.max(oldZoom + delta, this.minZoom), this.maxZoom);
    if (newZoom === oldZoom) return;

    const centerWorldOld = projectWorld(this.view.lon, this.view.lat, oldZoom, this.tileSize);
    const anchorWorldOld = {
      x: centerWorldOld.x + (anchorScreenX - this.viewportWidth / 2),
      y: centerWorldOld.y + (anchorScreenY - this.viewportHeight / 2),
    };
    const anchorLonLat = unprojectWorld(anchorWorldOld.x, anchorWorldOld.y, oldZoom, this.tileSize);
    const anchorWorldNew = projectWorld(anchorLonLat.lon, anchorLonLat.lat, newZoom, this.tileSize);
    const centerWorldNew = {
      x: anchorWorldNew.x - (anchorScreenX - this.viewportWidth / 2),
      y: anchorWorldNew.y - (anchorScreenY - this.viewportHeight / 2),
    };
    const newCenter = unprojectWorld(centerWorldNew.x, centerWorldNew.y, newZoom, this.tileSize);
    this.view = { lon: newCenter.lon, lat: newCenter.lat, zoom: newZoom };
    this.scheduleRedraw();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const now = Date.now();
    if (now - this.lastWheelAt < 120) return;
    this.lastWheelAt = now;
    const rect = this.canvas?.getBoundingClientRect();
    const x = rect ? e.clientX - rect.left : this.viewportWidth / 2;
    const y = rect ? e.clientY - rect.top : this.viewportHeight / 2;
    this.zoomBy(e.deltaY < 0 ? 1 : -1, x, y);
  }

  private onPointerDown(e: PointerEvent): void {
    this.canvas?.setPointerCapture(e.pointerId);
    this.dragState = { startClientX: e.clientX, startClientY: e.clientY, startLon: this.view.lon, startLat: this.view.lat, moved: false };
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.dragState) {
      const dx = e.clientX - this.dragState.startClientX;
      const dy = e.clientY - this.dragState.startClientY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.dragState.moved = true;
      if (this.dragState.moved) {
        const startWorld = projectWorld(this.dragState.startLon, this.dragState.startLat, this.view.zoom, this.tileSize);
        const newCenterWorld = { x: startWorld.x - dx, y: startWorld.y - dy };
        const newCenter = unprojectWorld(newCenterWorld.x, newCenterWorld.y, this.view.zoom, this.tileSize);
        this.view.lon = newCenter.lon;
        this.view.lat = newCenter.lat;
        this.scheduleRedraw();
      }
      return;
    }

    const rect = this.canvas?.getBoundingClientRect();
    if (!rect) return;
    const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top, false);
    const key = hit ? `${hit.plan}:${hit.feature.properties.WebCode}` : null;
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      this.scheduleRedraw();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.dragState;
    this.dragState = null;
    this.canvas?.releasePointerCapture(e.pointerId);
    if (drag && !drag.moved) {
      const rect = this.canvas?.getBoundingClientRect();
      if (!rect) return;
      const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top, true);
      if (hit) this.selectFeature(hit.feature.properties.WebCode);
    }
  }

  private hitTest(screenX: number, screenY: number, isClick: boolean): { plan: 'Actual' | 'Restored'; feature: Feature } | null {
    if (!this.ctx) return null;
    this.syncCanvasSize();
    // Deliberately identity, NOT the dpr-scaled transform redraw() uses for
    // rendering: isPointInPath()'s query point is not reliably subject to
    // the current transformation matrix the same way fill()/stroke() are
    // (a known, easy-to-hit canvas gotcha), so testing it under a
    // non-identity transform compared CSS-pixel Path2D coordinates against
    // a query point that didn't get the same scaling applied -- an error
    // that grows with distance from the canvas origin, which is exactly
    // the offset this was chasing. Path2D coordinates were built from
    // toScreen() in raw CSS-pixel numbers (see drawOverlays), so comparing
    // them against screenX/screenY (also raw CSS pixels) under an identity
    // transform is correct with no scaling ambiguity on either side.
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    let result: { plan: 'Actual' | 'Restored'; feature: Feature } | null = null;
    // Last-drawn-on-top wins -- iterate back-to-front so a feature drawn
    // later (and thus visually in front) is preferred on overlapping clicks.
    for (let i = this.lastOverlayPaths.length - 1; i >= 0; i--) {
      const entry = this.lastOverlayPaths[i]!;
      if (!this.isOverlayInteractive(entry.plan)) continue;
      if (this.ctx.isPointInPath(entry.path, screenX, screenY)) {
        result = { plan: entry.plan, feature: entry.feature };
        break;
      }
    }

    if (this.debugHitTraceVisible) {
      // Recorded at exactly the (screenX, screenY) handed to isPointInPath
      // above -- the same numbers, same transform -- so replaying this
      // trace by drawing dots at these coordinates can only ever agree
      // with the hit-test outcome; what it's useful for is comparing
      // where those dots land against where the feature *looks* like it
      // is on screen, and against where your actual cursor was.
      this.debugHitTrace.push({
        x: screenX,
        y: screenY,
        hit: result !== null,
        click: isClick,
        webCode: result?.feature.properties.WebCode ?? null,
      });
      if (this.debugHitTrace.length > 4000) this.debugHitTrace.splice(0, this.debugHitTrace.length - 4000);
      this.scheduleRedraw();
    }

    return result;
  }

  // ── Rendering ──

  // Re-measures the canvas's own box (not the host element's -- see below)
  // and resyncs its backing-store size/devicePixelRatio. Called eagerly at
  // the top of both `redraw()` and `hitTest()`, not only from the
  // ResizeObserver callback below: Desk's own canvas zoom appears to change
  // `window.devicePixelRatio` as seen by an embedded widget's page without
  // necessarily changing that page's own CSS layout size, which a
  // size-only ResizeObserver would never notice -- leaving the canvas's
  // backing store mismatched against the live device pixel ratio, and
  // desyncing hit-testing from rendering by an amount that depends on the
  // (non-proportional) gap between the stale and current ratio, worse the
  // further Desk's canvas is zoomed. Always resyncing immediately before
  // every use, rather than relying on a cached value from the last resize
  // event, removes that whole class of staleness regardless of what
  // exactly triggers a devicePixelRatio change.
  private syncCanvasSize(): void {
    if (!this.canvas) return;
    // Must be the canvas's own box, not the host element's -- the host
    // (<samothrace-map>) spans the toolbar and layers-panel too, which
    // offsets it from the canvas. Using the host's rect here previously
    // desynced render-space math from the canvas-relative coordinates
    // every pointer handler below correctly uses, producing a systematic
    // up-left hit-test offset (hovering/clicking only "hit" a feature
    // when the pointer was actually down-left of it on screen).
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.viewportWidth = Math.max(1, rect.width);
    this.viewportHeight = Math.max(1, rect.height);
    const wantWidth = Math.max(1, Math.round(this.viewportWidth * dpr));
    const wantHeight = Math.max(1, Math.round(this.viewportHeight * dpr));
    if (dpr !== this.dpr || this.canvas.width !== wantWidth || this.canvas.height !== wantHeight) {
      this.dpr = dpr;
      this.canvas.width = wantWidth;
      this.canvas.height = wantHeight;
    }
  }

  private resizeCanvas(): void {
    this.syncCanvasSize();
    this.scheduleRedraw();
  }

  private scheduleRedraw(): void {
    if (this.redrawScheduled) return;
    this.redrawScheduled = true;
    requestAnimationFrame(() => {
      this.redrawScheduled = false;
      this.redraw();
    });
  }

  private tileUrl(layerId: string, z: number, x: number, y: number): string {
    return `${this.serviceUrl}/tiles/${layerId}/${z}/${x}/${y}.png`;
  }

  private getTile(url: string): TileEntry {
    let entry = this.tileCache.get(url);
    if (!entry) {
      const img = new Image();
      entry = { img, status: 'loading' };
      img.onload = () => {
        entry!.status = 'loaded';
        this.scheduleRedraw();
      };
      img.onerror = () => {
        entry!.status = 'error';
      };
      img.src = url;
      this.tileCache.set(url, entry);
    }
    return entry;
  }

  private redraw(): void {
    const ctx = this.ctx;
    if (!ctx || !this.canvas || !this.serviceUrl) return;
    this.syncCanvasSize();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.viewportWidth, this.viewportHeight);

    if (this.zoomLabelEl) this.zoomLabelEl.textContent = `z${this.view.zoom}`;

    const zoom = this.view.zoom;
    const centerWorld = projectWorld(this.view.lon, this.view.lat, zoom, this.tileSize);
    const toScreen = (lon: number, lat: number): { x: number; y: number } => {
      const w = projectWorld(lon, lat, zoom, this.tileSize);
      return { x: w.x - centerWorld.x + this.viewportWidth / 2, y: w.y - centerWorld.y + this.viewportHeight / 2 };
    };

    const sortedLayers = [...this.layerMetas].sort((a, b) => a.order - b.order);
    for (const layer of sortedLayers) {
      if (!this.visibleLayers.has(layer.id)) continue;
      this.drawLayer(ctx, layer.id, zoom, centerWorld);
    }

    this.drawOverlays(ctx, toScreen);
    if (this.debugHitTraceVisible) this.drawDebugHitTrace(ctx, toScreen);
  }

  // Debug aid: every hit-test this session (hover and click) plotted as a
  // dot at exactly the coordinates it was tested at -- green for a hit,
  // red for a miss, with click events drawn larger and outlined. Also
  // draws a blue crosshair + label at the true, freshly-computed on
  // -screen center of every feature that was EVER hit this session (via
  // the same toScreen() used to draw the overlays themselves) -- so a
  // cluster of green dots can be directly compared against where that
  // same feature actually, visibly is, in one screenshot, instead of
  // having to infer it from dot clustering alone. If a green cluster for
  // webCode X sits right on top of X's crosshair, the hit-test math
  // agrees with rendering and any reported offset is upstream of this
  // file (how mouse events reach the page at all, e.g. under Desk's own
  // canvas zoom). If the crosshair for X is somewhere else entirely, the
  // bug is in this file's own hit-test/draw coordinate math after all.
  private drawDebugHitTrace(ctx: CanvasRenderingContext2D, toScreen: (lon: number, lat: number) => { x: number; y: number }): void {
    for (const p of this.debugHitTrace) {
      const radius = p.click ? 6 : 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = p.hit ? 'rgba(40,200,80,0.85)' : 'rgba(230,50,50,0.65)';
      ctx.fill();
      if (p.click) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
      }
    }

    const hitWebCodes = new Set(this.debugHitTrace.map((p) => p.webCode).filter((w): w is string => w !== null));
    for (const webCode of hitWebCodes) {
      const matches = this.findAllMatching(webCode);
      if (matches.length === 0) continue;
      const center = featureCenterLonLat(matches[0]!.feature);
      const { x, y } = toScreen(center.lon, center.lat);
      ctx.strokeStyle = 'rgba(40,140,255,0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 10, y);
      ctx.lineTo(x + 10, y);
      ctx.moveTo(x, y - 10);
      ctx.lineTo(x, y + 10);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = '11px monospace';
      ctx.fillStyle = 'rgba(40,140,255,0.95)';
      ctx.fillText(webCode, x + 14, y - 14);
    }
  }

  private drawLayer(ctx: CanvasRenderingContext2D, layerId: string, zoom: number, centerWorld: { x: number; y: number }): void {
    const tileSize = this.tileSize;
    const topLeftWorldX = centerWorld.x - this.viewportWidth / 2;
    const topLeftWorldY = centerWorld.y - this.viewportHeight / 2;
    const bottomRightWorldX = centerWorld.x + this.viewportWidth / 2;
    const bottomRightWorldY = centerWorld.y + this.viewportHeight / 2;

    const minTx = Math.floor(topLeftWorldX / tileSize);
    const maxTx = Math.floor(bottomRightWorldX / tileSize);
    const minTy = Math.floor(topLeftWorldY / tileSize);
    const maxTy = Math.floor(bottomRightWorldY / tileSize);
    const maxIndex = Math.pow(2, zoom) - 1;

    for (let tx = minTx; tx <= maxTx; tx++) {
      if (tx < 0 || tx > maxIndex) continue;
      for (let ty = minTy; ty <= maxTy; ty++) {
        if (ty < 0 || ty > maxIndex) continue;
        const url = this.tileUrl(layerId, zoom, tx, ty);
        const entry = this.getTile(url);
        if (entry.status !== 'loaded') continue;
        const screenX = tx * tileSize - centerWorld.x + this.viewportWidth / 2;
        const screenY = ty * tileSize - centerWorld.y + this.viewportHeight / 2;
        ctx.drawImage(entry.img, screenX, screenY, tileSize, tileSize);
      }
    }
  }

  private drawOverlays(ctx: CanvasRenderingContext2D, toScreen: (lon: number, lat: number) => { x: number; y: number }): void {
    const paths: OverlayPath[] = [];
    const planSets: Array<['Actual' | 'Restored', Feature[]]> = [
      ['Actual', this.actualFeatures],
      ['Restored', this.restoredFeatures],
    ];
    for (const [plan, features] of planSets) {
      for (const feature of features) {
        const path = new Path2D();
        for (const ring of collectRings(feature.geometry)) {
          ring.forEach(([lon, lat], i) => {
            const { x, y } = toScreen(lon, lat);
            if (i === 0) path.moveTo(x, y);
            else path.lineTo(x, y);
          });
          path.closePath();
        }
        paths.push({ plan, feature, path });

        const webCode = feature.properties.WebCode;
        const key = `${plan}:${webCode}`;
        const style = webCode === this.selectedWebCode ? SELECTED_STYLE : key === this.hoverKey ? HOVER_STYLE : BASE_STYLE;
        if (style.lineWidth > 0 || style !== BASE_STYLE) {
          ctx.fillStyle = style.fillStyle;
          ctx.fill(path);
          if (style.lineWidth > 0) {
            ctx.strokeStyle = style.strokeStyle;
            ctx.lineWidth = style.lineWidth;
            ctx.stroke(path);
          }
        }
      }
    }
    this.lastOverlayPaths = paths;
  }
}

customElements.define('samothrace-map', SamothraceMapElement);
