// Natural Earth Map -- a hand-written (no Leaflet, no external
// libraries) canvas pan/zoom viewer over the clipped Natural Earth
// vector data in Data/naturalEarth/ (see scripts/clip_natural_earth.py
// and scripts/fetch_natural_earth.py for how that data was produced).
// Data is served by the `natural-earth-map` hmsvc microservice
// (desk_hmsvc/natural-earth-map/) over plain HTTP -- see that
// service's own module docstring for why it's much simpler than
// samothrace-tiles (whole small GeoJSON files, not tiled raster).
//
// Deliberately kept parallel in shape to desk_widgets/samothrace-map/
// (same Web Mercator projection formulas, same pan/zoom/resize
// mechanics, same hmsvc-URL-discovery-via-desk.state pattern, same
// `visibleLayers: Set<string>` + `/layers` metadata convention) so that
// if this widget and that one are ever merged into one (e.g. a single
// map that can show both the Samothrace site plan AND the surrounding
// regional geography), the merge is mostly "combine two already
// -compatible layer lists," not "reconcile two different pan/zoom
// implementations." See this file's own README neighbor,
// desk_hmsvc/natural-earth-map/service.py's header comment, for the
// matching rationale on the service side.

// This project's bundled `tsc` (3.8.3) predates the DOM lib's
// ResizeObserver typings, even though real browsers have long
// supported it -- same gap samothrace-map.ts's own declaration works
// around.
declare class ResizeObserver {
  constructor(callback: () => void);
  observe(target: Element): void;
  disconnect(): void;
}

// Only the Bridge members this widget actually calls -- see
// tempui-custom-widgets.md's "The Desk Bridge API" for the full list.
interface Window {
  desk?: {
    self: {
      getLocalStorage(): Promise<{ data: Record<string, unknown> }>;
      setLocalStorage(data: Record<string, unknown>): Promise<{ ok: boolean }>;
    };
    state: {
      get(key: string): Promise<{ value: unknown; edit: unknown }>;
    };
    events: {
      subscribe(names: string[]): Promise<{ ok: boolean }>;
      onMessage(callback: (name: string, payload: unknown, senderInstanceId: string) => void): void;
    };
  };
}

// ── Constants ──

// Same reasoning as samothrace-map.ts's own TILE_SERVICE_NAME: the
// hmsvc service gets a fresh random port every launch, discovered via
// Desk's shared state rather than hardcoded.
const SERVICE_NAME = 'natural-earth-map';
const SERVICE_STATE_KEY = `desk.hmsvc.${SERVICE_NAME}`;

const MIN_ZOOM = 2;
const MAX_ZOOM = 14;
const TILE_SIZE = 256; // world-pixel-at-zoom unit, same convention as samothrace-map.ts -- no actual tiling happens, this data is never split into tiles.

// Minimum on-screen gap (CSS px) kept between two drawn point labels --
// see drawPointLabels' own comment for why this exists and how ties
// are broken.
const LABEL_MIN_GAP_PX = 3;

// Cross-widget "jump to this place" message name -- see
// handleFocusMessage's own comment for the full contract. Used by the
// Gazetteer widget's own publish call; kept here (not duplicated with
// a different literal string on that side) by that widget's own code
// importing nothing from this one -- the two widgets agree on this
// string purely by convention, same as any other desk.events channel
// name.
const FOCUS_EVENT_NAME = 'natural-earth-map.focus';
// Close enough to see the immediate surroundings of a single
// point-sized gazetteer entry without the caller needing to pick a
// zoom level itself.
const FOCUS_DEFAULT_ZOOM = 9;

interface LonLatBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

type RenderKind = 'fill-stroke' | 'stroke' | 'dot-label' | 'centroid-label';

interface LayerMeta {
  id: string;
  url: string;
  label: string;
  group: string;
  order: number;
  defaultVisible: boolean;
  render: RenderKind;
  color: string;
  fillColor?: string;
  fillOpacity?: number;
  weight?: number;
  radius?: number;
  labelField?: string;
  // Optional second hover-bar line, generic over any numeric property --
  // e.g. `{extraField: "pop_max", extraLabel: "pop."}` for cities,
  // `{extraField: "area_km2", extraLabel: "km²"}` for the OpenStreetMap
  // named-islands layer. Replaces an earlier version of this file that
  // hardcoded `meta.id === 'ne_10m_populated_places'` here -- a second
  // numeric-property layer (added without any widget-side change, since
  // this whole widget is metadata-driven) would have needed its own
  // hardcoded id check without this.
  extraField?: string;
  extraLabel?: string;
  featureCount: number;
}

interface LayersResponse {
  bounds: LonLatBounds | null;
  center: { lon: number; lat: number } | null;
  layers: LayerMeta[];
}

interface GeoJsonFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

// ── Web Mercator tile math (EPSG:3857) -- byte-for-byte the same
// formulas as samothrace-map.ts's own projectWorld/unprojectWorld, kept
// in sync deliberately (see this file's own header comment). ──

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

function padBounds(b: LonLatBounds, fraction: number): LonLatBounds {
  const w = (b.east - b.west) * fraction || 0.0005;
  const h = (b.north - b.south) * fraction || 0.0005;
  return { west: b.west - w, south: b.south - h, east: b.east + w, north: b.north + h };
}

// ── Geometry helpers -- generic over every GeoJSON type this data
// actually uses (Point, LineString, MultiLineString, Polygon,
// MultiPolygon), unlike samothrace-map.ts's collectRings/featureBounds
// (which only ever need Polygon/MultiPolygon, since that widget's own
// monument overlays are polygons-only). ──

function isCoordPair(x: unknown): x is [number, number] {
  return Array.isArray(x) && x.length >= 2 && typeof x[0] === 'number' && typeof x[1] === 'number';
}

// Recursively descends GeoJSON `coordinates` of any nesting depth
// (Point: depth 0, LineString/MultiPoint: 1, Polygon/MultiLineString:
// 2, MultiPolygon: 3) down to the [lon, lat] pairs at the bottom.
function flattenCoords(coords: unknown): [number, number][] {
  if (isCoordPair(coords)) return [coords];
  if (Array.isArray(coords)) return (coords as unknown[]).flatMap(flattenCoords);
  return [];
}

// Rings for a Polygon/MultiPolygon, flattened to one list -- ring 0 of
// each polygon part is its exterior, any further rings are holes. Used
// by both polygon fill drawing (Path2D, even-odd fill rule naturally
// handles the holes) and hit-testing (ray-casting across every ring,
// hole or not -- see pointInRings' own comment for why that's correct).
function polygonRings(geometry: { type: string; coordinates: unknown }): [number, number][][] {
  if (geometry.type === 'Polygon') {
    return (geometry.coordinates as unknown[]).map((ring) => flattenCoords(ring));
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as unknown[]).flatMap((poly) => (poly as unknown[]).map((ring) => flattenCoords(ring)));
  }
  return [];
}

// Lines for a LineString/MultiLineString, flattened to one list of
// point-sequences (one per line part).
function lineParts(geometry: { type: string; coordinates: unknown }): [number, number][][] {
  if (geometry.type === 'LineString') return [flattenCoords(geometry.coordinates)];
  if (geometry.type === 'MultiLineString') return (geometry.coordinates as unknown[]).map((line) => flattenCoords(line));
  return [];
}

function geometryBounds(geometry: { type: string; coordinates: unknown }): LonLatBounds | null {
  const points = flattenCoords(geometry.coordinates);
  if (points.length === 0) return null;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

function unionBounds(list: LonLatBounds[]): LonLatBounds | null {
  if (list.length === 0) return null;
  return list.reduce((acc, b) => ({
    west: Math.min(acc.west, b.west),
    south: Math.min(acc.south, b.south),
    east: Math.max(acc.east, b.east),
    north: Math.max(acc.north, b.north),
  }));
}

// A plain bounds-midpoint, same approximation samothrace-map.ts's own
// featureCenterLonLat uses -- not a true area centroid, but good
// enough for label placement on the handful of named-region polygons
// this layer actually has (Crete, Cyclades, ...), none of which are a
// shape where that distinction would visibly matter.
function geometryCenterLonLat(geometry: { type: string; coordinates: unknown }): { lon: number; lat: number } | null {
  const b = geometryBounds(geometry);
  if (!b) return null;
  return { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 };
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

// ── Hit-testing, all in plain CSS-pixel screen space (the same space
// toScreen() returns) -- no canvas transform is ever involved, so none
// of samothrace-map.ts's own isPointInPath-vs-current-transform gotcha
// (see tempui-custom-widgets.md's "Debugging a widget's own
// rendering/geometry visually") applies here at all. ──

// Standard even-odd ray-casting point-in-polygon, summed across EVERY
// ring handed in (not just the first/exterior one). This is correct
// for holes (a hole ring toggles the inside/outside parity once, same
// as any other ring) AND for a MultiPolygon's separate parts (a ray
// that happens to also cross a distant, unrelated part crosses its
// closed boundary an even number of times, which cannot flip the final
// parity) -- see this file's own development notes for the full
// argument; no special-casing by geometry type is needed as a result.
function pointInRings(px: number, py: number, rings: { x: number; y: number }[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if (a.y === b.y) continue;
      if (py < Math.min(a.y, b.y) || py >= Math.max(a.y, b.y)) continue;
      const xCross = a.x + ((py - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (xCross > px) inside = !inside;
    }
  }
  return inside;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function minDistToLines(px: number, py: number, lines: { x: number; y: number }[][]): number {
  let best = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!, b = line[i]!;
      const d = distToSegment(px, py, a.x, a.y, b.x, b.y);
      if (d < best) best = d;
    }
  }
  return best;
}

// ── Startup load retry ──
//
// The hmsvc this widget depends on is a separate process Desk starts
// independently -- there's a real, not-hypothetical race where this
// widget's own page finishes loading and asks `desk.state` for the
// service's URL before that service has actually started and
// published it (confirmed directly: seen in practice on this project).
// RetryingLoader wraps a single async "attempt" callback with a
// backing-off auto-retry schedule (1s, 5s, 10s, 60s, 300s, then give
// up) plus a manual "Retry now" button that always works, whether an
// auto-retry is currently pending or the schedule has already been
// exhausted -- rendering its own status/countdown/button markup
// directly into a container element the widget already has on screen
// (here, `.status-overlay`), so no second overlay element is needed.
//
// Generic over what "attempt" actually does -- this class knows
// nothing about hmsvc URLs, layers, or GeoJSON, only "run this async
// function; if it throws, show the error and retry on a schedule." A
// future consumer with a different startup dependency could reuse this
// unchanged.
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

  // Lets the wrapped `attempt` callback report progress ("Loading
  // layers…", then "Loading map data…") while it's still in flight --
  // a no-op if called outside an active attempt (e.g. stale timing
  // from a previous attempt), so callers don't need to guard every call
  // site themselves.
  setMessage(text: string): void {
    if (!this.running) return;
    this.container.innerHTML = `<div class="retry-box"><div class="retry-message">${escapeHtml(text)}</div></div>`;
    this.container.style.display = 'flex';
  }

  // The manual "Retry now" button's own handler -- also safe to call
  // from outside this class entirely (nothing currently does, but nor
  // does anything prevent it) since it fully resets whatever retry
  // state was pending first.
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
    if (this.running) return; // a manual Retry click while an attempt is already in flight -- ignore, it'll resolve on its own
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

interface HoverInfo {
  layerLabel: string;
  name: string | null;
  extra: string | null;
}

class NaturalEarthMapElement extends HTMLElement {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private layersListEl: HTMLElement | null = null;
  private hoverBarEl: HTMLElement | null = null;
  private zoomLabelEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private loader: RetryingLoader | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private serviceUrl: string | null = null;
  private layerMetas: LayerMeta[] = [];
  private bounds: LonLatBounds | null = null;
  private visibleLayers = new Set<string>();
  private featureCache = new Map<string, GeoJsonFeature[]>();

  // Set by handleFocusMessage, drawn as a persistent marker (distinct
  // from the mouse-driven `hover`/`hoverScreenPoint` pair above, which
  // only reflects the current cursor position) until the user manually
  // pans -- see onPointerMove's own drag branch -- so a place jumped to
  // from the Gazetteer widget stays visibly marked while the user looks
  // around it, not just for one redraw.
  private focusedPoint: { lon: number; lat: number; label: string | null } | null = null;

  private view = { lon: 25.5333, lat: 40.4833, zoom: 5 };
  private viewportWidth = 1;
  private viewportHeight = 1;
  private dpr = 1;

  private dragState: { startClientX: number; startClientY: number; startLon: number; startLat: number; moved: boolean } | null = null;
  private lastWheelAt = 0;
  private hover: HoverInfo | null = null;
  private hoverScreenPoint: { x: number; y: number } | null = null;
  private redrawScheduled = false;
  private saveUiStateTimer: number | null = null;

  private readonly toScreen = (lon: number, lat: number): { x: number; y: number } => {
    const centerWorld = projectWorld(this.view.lon, this.view.lat, this.view.zoom, TILE_SIZE);
    const w = projectWorld(lon, lat, this.view.zoom, TILE_SIZE);
    return { x: w.x - centerWorld.x + this.viewportWidth / 2, y: w.y - centerWorld.y + this.viewportHeight / 2 };
  };

  connectedCallback(): void {
    const template = document.getElementById('natural-earth-map-template') as HTMLTemplateElement | null;
    if (!template) return;
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(template.content.cloneNode(true));

    this.canvas = shadow.querySelector('.map-canvas');
    this.ctx = this.canvas?.getContext('2d') ?? null;
    this.layersListEl = shadow.querySelector('.layers-list');
    this.hoverBarEl = shadow.querySelector('.hover-bar');
    this.zoomLabelEl = shadow.querySelector('.zoom-label');
    this.statusEl = shadow.querySelector('.status-overlay');

    shadow.querySelector('.home-button')?.addEventListener('click', () => {
      if (this.bounds) this.fitToBounds(this.bounds, 0.06);
    });
    shadow.querySelector('.zoom-in-button')?.addEventListener('click', () => this.zoomBy(1, this.viewportWidth / 2, this.viewportHeight / 2));
    shadow.querySelector('.zoom-out-button')?.addEventListener('click', () => this.zoomBy(-1, this.viewportWidth / 2, this.viewportHeight / 2));

    if (this.canvas) {
      this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
      this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
      this.canvas.addEventListener('pointercancel', () => { this.dragState = null; });
      this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    }

    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    if (this.canvas) this.resizeObserver.observe(this.canvas);
    this.resizeCanvas();

    void this.init();
  }

  disconnectedCallback(): void {
    this.resizeObserver?.disconnect();
  }


  // ── Startup ──

  private async init(): Promise<void> {
    // Best-effort, same "never block/fail the map on a restart-watch
    // setup failure" treatment samothrace-map.ts's own
    // watchTileServiceState call site uses. Not part of the retried
    // attempt below -- this is a one-time subscription, not a
    // dependency that can be "not ready yet."
    this.watchServiceState().catch((err) => {
      console.warn('watching natural-earth-map service state failed to start:', err);
    });

    if (!this.statusEl) return;
    // See RetryingLoader's own header comment for the full "why" --
    // short version: the natural-earth-map hmsvc is a separate process
    // Desk starts independently, and this widget's own page can finish
    // loading and ask desk.state for its URL before that service has
    // actually published it. Backs off 1s/5s/10s/60s/300s, then gives
    // up with a manual Retry button that keeps working indefinitely.
    this.loader = new RetryingLoader(this.statusEl, () => this.attemptLoad());
    this.loader.start();
  }

  // The actual "try to get the map loaded" attempt -- everything in
  // here either succeeds completely or throws, so RetryingLoader can
  // retry the whole thing uniformly on failure. Safe to re-run: every
  // step either overwrites its own previous result (serviceUrl,
  // layerMetas, featureCache) or is naturally idempotent (restoring the
  // same saved localStorage state a second time changes nothing).
  private async attemptLoad(): Promise<void> {
    const desk = window.desk;
    if (!desk) throw new Error('Desk bridge unavailable');

    const serviceState = await desk.state.get(SERVICE_STATE_KEY);
    const serviceValue = serviceState.value as { status: string; url: string | null } | null;
    if (!serviceValue || !serviceValue.url) {
      throw new Error(`${SERVICE_NAME} service is not running yet -- start it from the Microservices widget if this persists`);
    }
    this.serviceUrl = serviceValue.url.replace(/\/+$/, '');

    this.loader?.setMessage('Loading layers…');
    await this.loadLayerMeta();
    this.buildLayersPanel();

    this.loader?.setMessage('Loading map data…');
    await this.loadAllFeatures();

    let restoredView = false;
    try {
      const { data: localData } = await desk.self.getLocalStorage();
      const savedLayers = Array.isArray(localData.visibleLayers) ? (localData.visibleLayers as string[]) : null;
      if (savedLayers) {
        const known = new Set(this.layerMetas.map((m) => m.id));
        this.visibleLayers = new Set(savedLayers.filter((id) => known.has(id)));
        this.syncLayerCheckboxes();
      }
      const rawView = localData.view;
      if (rawView && typeof rawView === 'object') {
        const v = rawView as { lon?: unknown; lat?: unknown; zoom?: unknown };
        if (
          typeof v.lon === 'number' && Number.isFinite(v.lon) &&
          typeof v.lat === 'number' && Number.isFinite(v.lat) &&
          typeof v.zoom === 'number' && Number.isFinite(v.zoom)
        ) {
          this.view = { lon: v.lon, lat: v.lat, zoom: Math.min(Math.max(v.zoom, MIN_ZOOM), MAX_ZOOM) };
          restoredView = true;
        }
      }
    } catch (err) {
      console.warn('restoring saved UI state failed (best-effort, using defaults):', err);
    }

    if (!restoredView && this.bounds) this.fitToBounds(this.bounds, 0.06);

    this.scheduleRedraw();
  }

  private async loadLayerMeta(): Promise<void> {
    if (!this.serviceUrl) throw new Error('service URL unknown');
    const res = await fetch(`${this.serviceUrl}/layers`);
    if (!res.ok) throw new Error(`/layers request failed: ${res.status}`);
    const data = (await res.json()) as LayersResponse;
    this.layerMetas = data.layers;
    this.bounds = data.bounds;
    this.visibleLayers = new Set(data.layers.filter((l) => l.defaultVisible).map((l) => l.id));
  }

  // Every layer here is a small, already-clipped GeoJSON file (<500 KB
  // each, ~1.3 MB total as of this writing) -- unlike samothrace-tiles'
  // per-tile lazy raster fetches, there is no reason not to just fetch
  // every layer once, up front, and keep it all in memory for the rest
  // of this widget instance's life. A toggled-off layer's data is still
  // held (cheap) so re-enabling it is instant, with no re-fetch.
  private async loadAllFeatures(): Promise<void> {
    if (!this.serviceUrl) throw new Error('service URL unknown');
    await Promise.all(
      this.layerMetas.map(async (meta) => {
        const res = await fetch(`${this.serviceUrl}${meta.url}`);
        if (!res.ok) throw new Error(`${meta.url} request failed: ${res.status}`);
        const fc = (await res.json()) as GeoJsonFeatureCollection;
        this.featureCache.set(meta.id, fc.features);
      })
    );
  }

  // Detects a natural-earth-map hmsvc restart (a genuinely new URL
  // published to desk.hmsvc.natural-earth-map) and refreshes in place --
  // same mechanism and reasoning as samothrace-map.ts's own
  // watchTileServiceState/handleTileServiceStateChanged. Also the one
  // place this widget subscribes to events generally, so the Gazetteer
  // widget's own "jump here" message (see handleFocusMessage's own
  // comment for the full cross-widget contract) is wired up alongside
  // it rather than via a second, separate subscribe call.
  private async watchServiceState(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    await desk.events.subscribe(['desk.state.changed', FOCUS_EVENT_NAME]);
    desk.events.onMessage((name, payload) => {
      if (name === 'desk.state.changed') {
        void this.handleServiceStateChanged(payload);
      } else if (name === FOCUS_EVENT_NAME) {
        this.handleFocusMessage(payload);
      }
    });
  }

  // Cross-widget "jump to this place" contract, the Gazetteer widget's
  // own half: `desk.events.publish(FOCUS_EVENT_NAME, {lon, lat, zoom?,
  // label?})`, broadcast to every OTHER widget instance currently
  // subscribed to that name (see tempui-custom-widgets.md's "Sending
  // and receiving named messages" -- a publisher never gets its own
  // message echoed back, and this is a named channel, not a targeted
  // call at one specific instance id, so this works correctly whether
  // zero, one, or several Gazetteer/NaturalEarthMap instances are
  // placed). No capability negotiation beyond `events` (already held)
  // on either side -- intentionally not coupled to this widget's own
  // internal LayerMeta/feature-cache shape, so either widget's own
  // internals can keep changing independently as long as this flat
  // {lon, lat, zoom?, label?} shape is kept.
  private handleFocusMessage(payload: unknown): void {
    const p = payload as { lon?: unknown; lat?: unknown; zoom?: unknown; label?: unknown } | null;
    if (!p || typeof p.lon !== 'number' || typeof p.lat !== 'number' || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) return;
    const zoom = typeof p.zoom === 'number' && Number.isFinite(p.zoom) ? p.zoom : FOCUS_DEFAULT_ZOOM;
    this.view = { lon: p.lon, lat: p.lat, zoom: Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM) };
    this.focusedPoint = { lon: p.lon, lat: p.lat, label: typeof p.label === 'string' ? p.label : null };
    this.scheduleSaveUiState();
    this.scheduleRedraw();
  }

  private async handleServiceStateChanged(payload: unknown): Promise<void> {
    try {
      const p = payload as { key?: unknown; value?: unknown } | null;
      if (!p || p.key !== SERVICE_STATE_KEY) return;
      const value = p.value as { status?: unknown; url?: unknown } | null;
      const newUrl = typeof value?.url === 'string' ? value.url.replace(/\/+$/, '') : null;
      if (!newUrl || newUrl === this.serviceUrl) return;
      console.warn(`${SERVICE_NAME} restarted (new url) -- refreshing`);
      this.serviceUrl = newUrl;
      await this.loadLayerMeta();
      await this.loadAllFeatures();
      this.buildLayersPanel();
      this.scheduleRedraw();
    } catch (err) {
      console.warn('handling service restart failed (best-effort, map may need a manual reload):', err);
    }
  }

  // ── Layers panel ──

  private buildLayersPanel(): void {
    if (!this.layersListEl) return;
    const groups = new Map<string, LayerMeta[]>();
    for (const meta of [...this.layerMetas].sort((a, b) => a.order - b.order)) {
      const list = groups.get(meta.group) ?? [];
      list.push(meta);
      groups.set(meta.group, list);
    }
    const parts: string[] = [];
    for (const [group, metas] of groups) {
      parts.push(`<div class="layer-group"><div class="layer-group-title">${escapeHtml(group)}</div>`);
      for (const meta of metas) {
        const checked = this.visibleLayers.has(meta.id) ? ' checked' : '';
        const swatchColor = meta.fillColor ?? meta.color;
        parts.push(
          `<label class="layer-row"><input type="checkbox" data-layer-id="${escapeHtml(meta.id)}"${checked} />` +
            `<span class="layer-swatch" style="background:${escapeHtml(swatchColor)}"></span>` +
            `<span>${escapeHtml(meta.label)}</span>` +
            `<span class="layer-count">${meta.featureCount}</span></label>`
        );
      }
      parts.push('</div>');
    }
    this.layersListEl.innerHTML = parts.join('');
    this.layersListEl.querySelectorAll<HTMLInputElement>('input[data-layer-id]').forEach((input) => {
      input.addEventListener('change', () => {
        const id = input.dataset.layerId;
        if (!id) return;
        if (input.checked) this.visibleLayers.add(id);
        else this.visibleLayers.delete(id);
        this.scheduleSaveUiState();
        this.scheduleRedraw();
      });
    });
  }

  private syncLayerCheckboxes(): void {
    this.layersListEl?.querySelectorAll<HTMLInputElement>('input[data-layer-id]').forEach((input) => {
      const id = input.dataset.layerId;
      if (id) input.checked = this.visibleLayers.has(id);
    });
  }

  // ── Persistence (view + layer toggles only -- this widget has no
  // selection/Q&A state to restore the way samothrace-map.ts does) ──

  private scheduleSaveUiState(): void {
    if (this.saveUiStateTimer !== null) return;
    this.saveUiStateTimer = window.setTimeout(() => {
      this.saveUiStateTimer = null;
      void window.desk?.self.setLocalStorage({
        visibleLayers: Array.from(this.visibleLayers),
        view: this.view,
      });
    }, 400);
  }

  // ── View (pan/zoom) -- same algorithms as samothrace-map.ts's own
  // fitToBounds/zoomBy, just without that widget's annotation-layer
  // guard (this widget has no such mode to guard against). ──

  private fitToBounds(bounds: LonLatBounds, extraPadFraction: number): void {
    const b = extraPadFraction > 0 ? padBounds(bounds, extraPadFraction) : bounds;
    let zoom = MAX_ZOOM;
    for (; zoom >= MIN_ZOOM; zoom--) {
      const nw = projectWorld(b.west, b.north, zoom, TILE_SIZE);
      const se = projectWorld(b.east, b.south, zoom, TILE_SIZE);
      if (se.x - nw.x <= this.viewportWidth && se.y - nw.y <= this.viewportHeight) break;
    }
    zoom = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
    this.view = { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2, zoom };
    this.scheduleSaveUiState();
    this.scheduleRedraw();
  }

  private zoomBy(delta: number, anchorScreenX: number, anchorScreenY: number): void {
    const oldZoom = this.view.zoom;
    const newZoom = Math.min(Math.max(oldZoom + delta, MIN_ZOOM), MAX_ZOOM);
    if (newZoom === oldZoom) return;

    const centerWorldOld = projectWorld(this.view.lon, this.view.lat, oldZoom, TILE_SIZE);
    const anchorWorldOld = {
      x: centerWorldOld.x + (anchorScreenX - this.viewportWidth / 2),
      y: centerWorldOld.y + (anchorScreenY - this.viewportHeight / 2),
    };
    const anchorLonLat = unprojectWorld(anchorWorldOld.x, anchorWorldOld.y, oldZoom, TILE_SIZE);
    const anchorWorldNew = projectWorld(anchorLonLat.lon, anchorLonLat.lat, newZoom, TILE_SIZE);
    const centerWorldNew = {
      x: anchorWorldNew.x - (anchorScreenX - this.viewportWidth / 2),
      y: anchorWorldNew.y - (anchorScreenY - this.viewportHeight / 2),
    };
    const newCenter = unprojectWorld(centerWorldNew.x, centerWorldNew.y, newZoom, TILE_SIZE);
    this.view = { lon: newCenter.lon, lat: newCenter.lat, zoom: newZoom };
    this.scheduleSaveUiState();
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

  private onDoubleClick(e: MouseEvent): void {
    const rect = this.canvas?.getBoundingClientRect();
    if (!rect) return;
    this.zoomBy(1, e.clientX - rect.left, e.clientY - rect.top);
  }

  private onPointerDown(e: PointerEvent): void {
    this.canvas?.setPointerCapture(e.pointerId);
    this.dragState = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startLon: this.view.lon,
      startLat: this.view.lat,
      moved: false,
    };
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.dragState) {
      const dx = e.clientX - this.dragState.startClientX;
      const dy = e.clientY - this.dragState.startClientY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.dragState.moved = true;
      if (this.dragState.moved) {
        this.focusedPoint = null; // user is looking elsewhere now -- see this field's own comment
        const startWorld = projectWorld(this.dragState.startLon, this.dragState.startLat, this.view.zoom, TILE_SIZE);
        const newCenterWorld = { x: startWorld.x - dx, y: startWorld.y - dy };
        const newCenter = unprojectWorld(newCenterWorld.x, newCenterWorld.y, this.view.zoom, TILE_SIZE);
        this.view.lon = newCenter.lon;
        this.view.lat = newCenter.lat;
        this.scheduleRedraw();
      }
      return;
    }

    const rect = this.canvas?.getBoundingClientRect();
    if (!rect) return;
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    this.hoverScreenPoint = { x: screenX, y: screenY };
    const hit = this.hitTest(screenX, screenY);
    const changed = JSON.stringify(hit) !== JSON.stringify(this.hover);
    this.hover = hit;
    if (changed) this.updateHoverBar();
    this.scheduleRedraw();
  }

  private onPointerUp(e: PointerEvent): void {
    this.canvas?.releasePointerCapture(e.pointerId);
    if (this.dragState && !this.dragState.moved) {
      this.scheduleSaveUiState();
    } else if (this.dragState) {
      this.scheduleSaveUiState();
    }
    this.dragState = null;
  }

  private updateHoverBar(): void {
    if (!this.hoverBarEl) return;
    if (!this.hover) {
      (this.hoverBarEl as HTMLElement).style.display = 'none';
      return;
    }
    const parts = [this.hover.name ?? this.hover.layerLabel];
    if (this.hover.extra) parts.push(this.hover.extra);
    this.hoverBarEl.textContent = parts.join(' — ');
    (this.hoverBarEl as HTMLElement).style.display = 'block';
  }

  // ── Hit-testing -- topmost visible layer (by draw order) wins, same
  // "last drawn, first hit" convention samothrace-map.ts's own layered
  // hit-testing follows. ──

  private hitTest(screenX: number, screenY: number): HoverInfo | null {
    const sorted = [...this.layerMetas].filter((m) => this.visibleLayers.has(m.id)).sort((a, b) => b.order - a.order);
    for (const meta of sorted) {
      const features = this.featureCache.get(meta.id);
      if (!features) continue;
      for (const feature of features) {
        if (this.featureHit(feature, meta, screenX, screenY)) {
          const name = meta.labelField ? (feature.properties[meta.labelField] as string | undefined) ?? null : null;
          const extraValue = meta.extraField ? feature.properties[meta.extraField] : undefined;
          const extra = typeof extraValue === 'number'
            ? `${extraValue.toLocaleString()}${meta.extraLabel ? ` ${meta.extraLabel}` : ''}`
            : null;
          return { layerLabel: meta.label, name, extra };
        }
      }
    }
    return null;
  }

  private featureHit(feature: GeoJsonFeature, meta: LayerMeta, screenX: number, screenY: number): boolean {
    const geom = feature.geometry;
    if (geom.type === 'Point') {
      const [lon, lat] = geom.coordinates as [number, number];
      const p = this.toScreen(lon, lat);
      const r = (meta.radius ?? 3) + 5;
      return Math.hypot(screenX - p.x, screenY - p.y) <= r;
    }
    if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
      const lines = lineParts(geom).map((line) => line.map(([lon, lat]) => this.toScreen(lon, lat)));
      const tolerance = Math.max(4, (meta.weight ?? 1) * 2 + 2);
      return minDistToLines(screenX, screenY, lines) <= tolerance;
    }
    if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
      const rings = polygonRings(geom).map((ring) => ring.map(([lon, lat]) => this.toScreen(lon, lat)));
      return pointInRings(screenX, screenY, rings);
    }
    return false;
  }

  // ── Rendering ──

  private syncCanvasSize(): void {
    if (!this.canvas) return;
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

  private redraw(): void {
    this.syncCanvasSize();
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.viewportWidth, this.viewportHeight);
    ctx.fillStyle = '#0d1420';
    ctx.fillRect(0, 0, this.viewportWidth, this.viewportHeight);

    const occupied: { x: number; y: number; w: number; h: number }[] = [];
    const sorted = [...this.layerMetas].filter((m) => this.visibleLayers.has(m.id)).sort((a, b) => a.order - b.order);
    for (const meta of sorted) {
      const features = this.featureCache.get(meta.id);
      if (!features) continue;
      this.drawLayer(ctx, meta, features, occupied);
    }

    if (this.hover && this.hoverScreenPoint) this.drawHoverMarker(ctx, this.hoverScreenPoint);
    if (this.focusedPoint) this.drawFocusMarker(ctx, this.focusedPoint);

    if (this.zoomLabelEl) this.zoomLabelEl.textContent = `zoom ${this.view.zoom.toFixed(1)}`;
  }

  private drawHoverMarker(ctx: CanvasRenderingContext2D, p: { x: number; y: number }): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // The "jumped here from the Gazetteer widget" marker -- visually
  // distinct from the plain hover ring (a filled amber ring + crosshair
  // + the entry's own name, rather than a thin outline) since it's
  // meant to stay visible and findable after the initial jump, not just
  // flash under the cursor for a moment. Persists across redraws (see
  // this.focusedPoint's own comment for when it's cleared) rather than
  // auto-expiring on a timer -- simpler, and there's no real harm in it
  // staying until the user moves on themselves.
  private drawFocusMarker(ctx: CanvasRenderingContext2D, focus: { lon: number; lat: number; label: string | null }): void {
    const p = this.toScreen(focus.lon, focus.lat);
    if (p.x < -20 || p.x > this.viewportWidth + 20 || p.y < -20 || p.y > this.viewportHeight + 20) return;
    ctx.save();
    ctx.strokeStyle = '#f2b134';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x - 16, p.y);
    ctx.lineTo(p.x - 12, p.y);
    ctx.moveTo(p.x + 12, p.y);
    ctx.lineTo(p.x + 16, p.y);
    ctx.moveTo(p.x, p.y - 16);
    ctx.lineTo(p.x, p.y - 12);
    ctx.moveTo(p.x, p.y + 12);
    ctx.lineTo(p.x, p.y + 16);
    ctx.stroke();
    if (focus.label) {
      ctx.font = '600 12px Arial, Helvetica, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#11151c';
      const w = ctx.measureText(focus.label).width;
      ctx.fillRect(p.x - w / 2 - 4, p.y + 14, w + 8, 18);
      ctx.fillStyle = '#f2b134';
      ctx.fillText(focus.label, p.x - w / 2, p.y + 23);
    }
    ctx.restore();
  }

  private drawLayer(
    ctx: CanvasRenderingContext2D,
    meta: LayerMeta,
    features: GeoJsonFeature[],
    occupied: { x: number; y: number; w: number; h: number }[]
  ): void {
    if (meta.render === 'fill-stroke') {
      ctx.save();
      ctx.fillStyle = meta.fillColor ?? meta.color;
      ctx.globalAlpha = meta.fillOpacity ?? 1;
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = meta.weight ?? 1;
      for (const feature of features) {
        const rings = polygonRings(feature.geometry);
        if (rings.length === 0) continue;
        const path = new Path2D();
        for (const ring of rings) {
          ring.forEach(([lon, lat], i) => {
            const p = this.toScreen(lon, lat);
            if (i === 0) path.moveTo(p.x, p.y);
            else path.lineTo(p.x, p.y);
          });
          path.closePath();
        }
        ctx.fill(path, 'evenodd');
        ctx.globalAlpha = 1;
        ctx.stroke(path);
        ctx.globalAlpha = meta.fillOpacity ?? 1;
      }
      ctx.restore();
      return;
    }

    if (meta.render === 'stroke') {
      ctx.save();
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = meta.weight ?? 1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const feature of features) {
        const lines = lineParts(feature.geometry);
        for (const line of lines) {
          if (line.length < 2) continue;
          ctx.beginPath();
          line.forEach(([lon, lat], i) => {
            const p = this.toScreen(lon, lat);
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          });
          ctx.stroke();
        }
      }
      ctx.restore();
      if (meta.labelField) this.drawLineLabels(ctx, meta, features, occupied);
      return;
    }

    if (meta.render === 'dot-label') {
      this.drawPointLabels(ctx, meta, features, occupied);
      return;
    }

    if (meta.render === 'centroid-label') {
      ctx.save();
      ctx.fillStyle = meta.color;
      ctx.font = '600 11px Arial, Helvetica, sans-serif';
      ctx.textBaseline = 'middle';
      for (const feature of features) {
        // Prefer a precomputed label point (clip_natural_earth.py's own
        // `representative_point()`, guaranteed to fall inside the real
        // polygon -- important for a large, irregular, bbox-clipped
        // shape like "Mediterranean Sea" or "Aegean Sea," where a plain
        // bounds-midpoint has a real chance of landing on dry land).
        // Falls back to the bounds-midpoint approximation for a layer
        // that doesn't supply one (e.g. an older cached response).
        const labelLon = feature.properties['label_lon'];
        const labelLat = feature.properties['label_lat'];
        const center = typeof labelLon === 'number' && typeof labelLat === 'number'
          ? { lon: labelLon, lat: labelLat }
          : geometryCenterLonLat(feature.geometry);
        if (!center) continue;
        const name = meta.labelField ? (feature.properties[meta.labelField] as string | undefined) : undefined;
        if (!name) continue;
        const p = this.toScreen(center.lon, center.lat);
        if (p.x < -40 || p.x > this.viewportWidth + 40 || p.y < -20 || p.y > this.viewportHeight + 20) continue;
        const rect = this.textRect(ctx, name, p.x, p.y);
        if (this.overlapsAny(rect, occupied)) continue;
        occupied.push(rect);
        ctx.fillText(name, p.x - ctx.measureText(name).width / 2, p.y);
      }
      ctx.restore();
    }
  }

  // Draws each city dot unconditionally (so the map still shows where
  // every kept city is, even when its label is skipped for being too
  // close to a bigger one) but only draws a TEXT label where it fits
  // without overlapping an already-placed one -- a simple greedy
  // declutter, most-populous city first (`pop_max` descending), so a
  // crowded cluster at low zoom keeps its biggest city's name legible
  // instead of an unreadable pile of overlapping text. `occupied` is
  // shared across every layer drawn this frame (passed down from
  // redraw()), so a city label can also yield to an already-placed
  // named-island label drawn earlier in the stack, not just to other
  // cities.
  private drawPointLabels(
    ctx: CanvasRenderingContext2D,
    meta: LayerMeta,
    features: GeoJsonFeature[],
    occupied: { x: number; y: number; w: number; h: number }[]
  ): void {
    const radius = meta.radius ?? 3;
    const ordered = meta.labelField
      ? [...features].sort((a, b) => ((b.properties.pop_max as number) ?? 0) - ((a.properties.pop_max as number) ?? 0))
      : features;

    ctx.save();
    ctx.fillStyle = meta.color;
    for (const feature of features) {
      if (feature.geometry.type !== 'Point') continue;
      const [lon, lat] = feature.geometry.coordinates as [number, number];
      const p = this.toScreen(lon, lat);
      if (p.x < -10 || p.x > this.viewportWidth + 10 || p.y < -10 || p.y > this.viewportHeight + 10) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    if (!meta.labelField) return;
    ctx.save();
    ctx.fillStyle = '#e6e9ef';
    ctx.font = '11px Arial, Helvetica, sans-serif';
    ctx.textBaseline = 'middle';
    for (const feature of ordered) {
      if (feature.geometry.type !== 'Point') continue;
      const name = feature.properties[meta.labelField] as string | undefined;
      if (!name) continue;
      const [lon, lat] = feature.geometry.coordinates as [number, number];
      const p = this.toScreen(lon, lat);
      if (p.x < -10 || p.x > this.viewportWidth + 10 || p.y < -10 || p.y > this.viewportHeight + 10) continue;
      const labelX = p.x + radius + 4;
      const rect = this.textRect(ctx, name, labelX + ctx.measureText(name).width / 2, p.y);
      if (this.overlapsAny(rect, occupied)) continue;
      occupied.push(rect);
      ctx.fillText(name, labelX, p.y);
    }
    ctx.restore();
  }

  private drawLineLabels(
    ctx: CanvasRenderingContext2D,
    meta: LayerMeta,
    features: GeoJsonFeature[],
    occupied: { x: number; y: number; w: number; h: number }[]
  ): void {
    ctx.save();
    ctx.fillStyle = meta.color;
    ctx.font = '10.5px Arial, Helvetica, sans-serif';
    ctx.textBaseline = 'middle';
    for (const feature of features) {
      const name = meta.labelField ? (feature.properties[meta.labelField] as string | undefined) : undefined;
      if (!name) continue;
      const lines = lineParts(feature.geometry);
      const longest = lines.reduce((best, l) => (l.length > best.length ? l : best), lines[0] ?? []);
      if (longest.length === 0) continue;
      const [lon, lat] = longest[Math.floor(longest.length / 2)]!;
      const p = this.toScreen(lon, lat);
      if (p.x < -40 || p.x > this.viewportWidth + 40 || p.y < -20 || p.y > this.viewportHeight + 20) continue;
      const rect = this.textRect(ctx, name, p.x, p.y);
      if (this.overlapsAny(rect, occupied)) continue;
      occupied.push(rect);
      ctx.fillText(name, p.x - ctx.measureText(name).width / 2, p.y);
    }
    ctx.restore();
  }

  private textRect(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number): { x: number; y: number; w: number; h: number } {
    const w = ctx.measureText(text).width;
    const h = 12;
    return { x: cx - w / 2 - LABEL_MIN_GAP_PX, y: cy - h / 2 - LABEL_MIN_GAP_PX, w: w + LABEL_MIN_GAP_PX * 2, h: h + LABEL_MIN_GAP_PX * 2 };
  }

  private overlapsAny(rect: { x: number; y: number; w: number; h: number }, occupied: { x: number; y: number; w: number; h: number }[]): boolean {
    return occupied.some(
      (o) => rect.x < o.x + o.w && rect.x + rect.w > o.x && rect.y < o.y + o.h && rect.y + rect.h > o.y
    );
  }
}

customElements.define('natural-earth-map', NaturalEarthMapElement);
