// Contour Connector -- "we can be greedier with extending contours
// across gaps ... please provide a new widget which allows me to
// connect contour fragments by just dragging between them" (chat
// history). Renders a plan's real extracted contour fragments (solid,
// colored by major/minor/unlabeled -- see CONTOUR_COLOR) plus two kinds
// of NOT-real-data connection: scripts/extract_vector_layers.py's own
// auto-gap / stream-guided suggestions (thin, muted, dashed) and
// confirmed connections -- either accepted from a suggestion or drawn
// freehand here (bold dashed yellow, ALWAYS visually distinct from a
// real fragment, however the connection originated -- see "the need for
// a way to distinguish between in-the-data contour lines and the
// inferred connections between them").
//
// Interaction model (all on the main canvas):
//   - hover a fragment (not dragging): highlighted (cyan outline) --
//     "hover clearly visually distinguishes the hovered segment"
//   - click-drag starting on a fragment: that fragment is anchored
//     (white outline -- "clicking distinguishes it further"); a live
//     line follows the pointer ("start-anchors a line which follows the
//     mouse")
//   - while dragging, hovering a DIFFERENT fragment highlights it in yet
//     another way (green outline -- "visually distinguishes them in a
//     different way")
//   - releasing over that fragment commits a connection between the two
//     fragments' nearest endpoints ("releasing the drag while hovering
//     connects the two contour fragments")
//   - a plain CLICK (no real drag) on a suggested connection's own
//     dashed line accepts it outright, without needing to redraw it by
//     hand -- a faster path through the (potentially large) suggestion
//     set than dragging every one individually
//   - a plain click on a confirmed/inferred connection selects it for
//     removal (toolbar "Remove selected" button)
//
// UX affordances asked for specifically ("when asking for my help"):
//   zoom in/out (drag-to-zoom + reset), a minimap with the current
//   viewport highlighted, and an on-demand HD (zoom-22) crop -- same
//   pattern already established in topo-compare.ts / minor-contour
//   -review.ts.

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
const LOG_PATH = '.desk_temp/contour-connector-log.json';

type Plan = 'actual' | 'restored';
const PLAN_LABELS: Record<Plan, string> = { actual: 'Actual State Plan', restored: 'Restored State Plan' };
const PLAN_LABEL_PART: Record<Plan, string> = { actual: 'ActualStatePlan', restored: 'RestoredStatePlan' };
const RAW_LAYER: Record<Plan, string> = { actual: 'actual-plan-raw', restored: 'restored-plan-raw' };

function contoursPath(plan: Plan): string {
  return `Data/mapFeatures/SamoWeb_${PLAN_LABEL_PART[plan]}_Contours.geojson`;
}
function suggestedPath(plan: Plan): string {
  return `Data/mapFeatures/SamoWeb_${PLAN_LABEL_PART[plan]}_Contours.connections.suggested.json`;
}
function confirmedPath(plan: Plan): string {
  return `Data/mapFeatures/SamoWeb_${PLAN_LABEL_PART[plan]}_Contours.connections.confirmed.json`;
}
const ACTUAL_STREAMS_PATH = 'Data/mapFeatures/SamoWeb_ActualStatePlan_Streams.geojson';

// Whole-site zoom-18 grid -- same tiles topo-compare.ts / minor-contour
// -review.ts already stitch for their own main view.
const MAIN_Z = 18;
const MAIN_X_MIN = 149661;
const MAIN_X_MAX = 149663;
const MAIN_Y_MIN = 98763;
const MAIN_Y_MAX = 98765;
const TILE = 256;
const MAIN_IMG_W = (MAIN_X_MAX - MAIN_X_MIN + 1) * TILE;
const MAIN_IMG_H = (MAIN_Y_MAX - MAIN_Y_MIN + 1) * TILE;

// HD crop: highest zoom the source tile pyramid actually has (~0.028 m/px).
const HD_Z = 22;
const HD_WINDOW_PX = 480;

// Three shades for real data -- kept in sync with topo-compare.ts's
// CONTOUR_COLOR and extract_vector_layers.py's save_stage_fragments.
const CONTOUR_COLOR = { major: '#c026d3', minor: '#f59e0b', unlabeled: '#94a3b8' } as const;
// Connections are NEVER drawn in any of the above three -- always this
// one color, dashed, regardless of how the connection originated
// (manual drag, accepted auto-gap suggestion, accepted stream-guided
// suggestion) -- see this file's own header comment for why that
// distinction is load-bearing.
const INFERRED_COLOR = '#facc15';
const SUGGESTED_COLOR: Record<'auto-gap' | 'stream-guided', string> = {
  'auto-gap': '#64748b',
  'stream-guided': '#0ea5e9',
};
// this.suggested only ever actually holds 'auto-gap' | 'stream-guided'
// entries (see loadPlan), but Connection.source is typed as the wider
// ConnectionSource (it's also reused for 'manual' confirmed
// connections) -- this helper covers that gap for TS without a bogus
// 'manual' key in the lookup table above.
function suggestedColorFor(source: ConnectionSource): string {
  return source === 'auto-gap' || source === 'stream-guided' ? SUGGESTED_COLOR[source] : '#64748b';
}
const HOVER_COLOR = '#38bdf8'; // plain hover (not dragging)
const ANCHOR_COLOR = '#ffffff'; // the fragment a drag started from
const DRAG_TARGET_COLOR = '#22c55e'; // a different fragment hovered WHILE dragging
const STREAM_GUIDE_COLOR = '#0ea5e9';

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

function unprojectWorld(x: number, y: number, zoom: number, tileSize: number): { lon: number; lat: number } {
  const n = Math.pow(2, zoom) * tileSize;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lon, lat: (latRad * 180) / Math.PI };
}

function mainPoint(lon: number, lat: number): { x: number; y: number } {
  const w = projectWorld(lon, lat, MAIN_Z, TILE);
  return { x: w.x - MAIN_X_MIN * TILE, y: w.y - MAIN_Y_MIN * TILE };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distancePointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return pointDistance(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq, 0, 1);
  return pointDistance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function distancePointToPolyline(p: Point, points: Point[]): number {
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const d = distancePointToSegment(p, points[i]!, points[i + 1]!);
    if (d < min) min = d;
  }
  return min;
}

// ── Data model ──

interface ContourFeature {
  id: number;
  points: Point[];
  elevationM: number | null;
  elevationSource: string | null;
}

function contourColorFor(f: ContourFeature): string {
  if (f.elevationSource === 'ocr' || f.elevationSource === 'review-confirmed') return CONTOUR_COLOR.major;
  if (f.elevationSource === 'interpolated') return CONTOUR_COLOR.minor;
  return CONTOUR_COLOR.unlabeled;
}

type ConnectionSource = 'auto-gap' | 'stream-guided' | 'manual';

interface Connection {
  connectionId: string;
  source: ConnectionSource;
  aLon: number;
  aLat: number;
  bLon: number;
  bLat: number;
  a: Point; // MAIN_Z pixel space, derived from aLon/aLat
  b: Point;
  elevationM: number | null;
}

interface GeoJsonLineFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  properties: { elevation_m: number | null; elevation_source?: string | null };
}

interface SuggestedConnectionFile {
  plan: Plan;
  connections: Array<{
    connectionId: string;
    source: 'auto-gap' | 'stream-guided';
    aLon: number;
    aLat: number;
    bLon: number;
    bLat: number;
    distancePx: number;
    elevationM: number | null;
  }>;
}

interface ConfirmedConnectionFile {
  plan: Plan;
  connections: Array<{
    connectionId: string;
    source: ConnectionSource;
    aLon: number;
    aLat: number;
    bLon: number;
    bLat: number;
    elevationM: number | null;
  }>;
}

interface LogConnection {
  connectionId: string;
  plan: Plan;
  source: ConnectionSource;
  aLon: number;
  aLat: number;
  bLon: number;
  bLat: number;
  elevationM: number | null;
  confirmedAt: string;
}

interface LogRejection {
  connectionId: string;
  plan: Plan;
  rejectedAt: string;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

type HoverTarget =
  | { kind: 'fragment'; idx: number }
  | { kind: 'suggested'; idx: number }
  | { kind: 'confirmed'; idx: number }
  | null;

class ContourConnectorElement extends HTMLElement {
  private planSelectEl: HTMLSelectElement | null = null;
  private mainCanvas: HTMLCanvasElement | null = null;
  private minimapCanvas: HTMLCanvasElement | null = null;
  private resetZoomButtonEl: HTMLButtonElement | null = null;
  private hdButtonEl: HTMLButtonElement | null = null;
  private hdCanvas: HTMLCanvasElement | null = null;
  private hdStatusEl: HTMLElement | null = null;
  private showSuggestedEl: HTMLInputElement | null = null;
  private showConfirmedEl: HTMLInputElement | null = null;
  private showStreamGuideEl: HTMLInputElement | null = null;
  private maxSuggestDistEl: HTMLInputElement | null = null;
  private maxSuggestDistReadoutEl: HTMLElement | null = null;
  private removeSelectedButtonEl: HTMLButtonElement | null = null;
  private progressEl: HTMLElement | null = null;
  private infoEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  private serviceUrl: string | null = null;
  private plan: Plan = 'actual';

  private rawCache = new Map<string, Promise<HTMLCanvasElement>>();
  private mainBase: HTMLCanvasElement | null = null;
  private viewRect: Rect = { x: 0, y: 0, width: MAIN_IMG_W, height: MAIN_IMG_H };
  private zoomDragState: { startX: number; startY: number; curX: number; curY: number } | null = null;

  private fragments: ContourFeature[] = [];
  private suggested: Connection[] = [];
  private confirmed: Connection[] = [];
  private streamGuide: Point[][] = []; // restored plan only -- Actual plan's own stream polylines, reprojected
  private rejectedIds = new Set<string>(); // this session's rejected suggestion ids, per plan (see rejectedKey)
  // `removed` is tracked separately from simply omitting an id from
  // `connections` -- scripts/apply_contour_connections.py needs to tell
  // "never confirmed" apart from "confirmed in a PRIOR session/apply
  // run, then explicitly removed here" so a removal actually deletes
  // the matching entry from *.connections.confirmed.json instead of
  // silently leaving it behind (a fresh/cleared local session's log has
  // no memory of what it never saw).
  private log: { connections: LogConnection[]; rejections: LogRejection[]; removed: string[] } = {
    connections: [],
    rejections: [],
    removed: [],
  };

  private hoverTarget: HoverTarget = null;
  private selectedConfirmedIdx: number | null = null;
  private connectDrag: { anchorFragIdx: number; anchorPoint: Point; curPoint: Point; hoverFragIdx: number | null } | null = null;
  private maxSuggestDistPx = 140;

  connectedCallback(): void {
    const template = document.getElementById('contour-connector-template');
    if (!(template instanceof HTMLTemplateElement)) {
      throw new Error('contour-connector-template not found');
    }
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(template.content.cloneNode(true));

    this.planSelectEl = shadow.querySelector('.plan-select');
    this.mainCanvas = shadow.querySelector('.main-canvas');
    this.minimapCanvas = shadow.querySelector('.minimap-canvas');
    this.resetZoomButtonEl = shadow.querySelector('.reset-zoom-button');
    this.hdButtonEl = shadow.querySelector('.hd-button');
    this.hdCanvas = shadow.querySelector('.hd-canvas');
    this.hdStatusEl = shadow.querySelector('.hd-status');
    this.showSuggestedEl = shadow.querySelector('.show-suggested');
    this.showConfirmedEl = shadow.querySelector('.show-confirmed');
    this.showStreamGuideEl = shadow.querySelector('.show-stream-guide');
    this.maxSuggestDistEl = shadow.querySelector('.max-suggest-dist');
    this.maxSuggestDistReadoutEl = shadow.querySelector('.max-suggest-dist-readout');
    this.removeSelectedButtonEl = shadow.querySelector('.remove-selected-button');
    this.progressEl = shadow.querySelector('.progress');
    this.infoEl = shadow.querySelector('.info-bar');
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
        void this.loadPlan();
      });
    }

    this.resetZoomButtonEl?.addEventListener('click', () => {
      this.viewRect = { x: 0, y: 0, width: MAIN_IMG_W, height: MAIN_IMG_H };
      this.render();
    });
    this.hdButtonEl?.addEventListener('click', () => void this.loadHdCrop());
    this.showSuggestedEl?.addEventListener('change', () => this.render());
    this.showConfirmedEl?.addEventListener('change', () => this.render());
    this.showStreamGuideEl?.addEventListener('change', () => this.render());
    this.maxSuggestDistEl?.addEventListener('input', () => {
      this.maxSuggestDistPx = Number(this.maxSuggestDistEl?.value ?? 140);
      if (this.maxSuggestDistReadoutEl) this.maxSuggestDistReadoutEl.textContent = `${this.maxSuggestDistPx}px`;
      this.render();
    });
    this.removeSelectedButtonEl?.addEventListener('click', () => void this.removeSelectedConnection());

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
      const connections = Array.isArray((data.log as { connections?: unknown })?.connections)
        ? ((data.log as { connections: LogConnection[] }).connections)
        : [];
      const rejections = Array.isArray((data.log as { rejections?: unknown })?.rejections)
        ? ((data.log as { rejections: LogRejection[] }).rejections)
        : [];
      const removed = Array.isArray((data.log as { removed?: unknown })?.removed) ? ((data.log as { removed: string[] }).removed) : [];
      this.log = { connections, rejections, removed };

      await this.loadPlan();
    } catch (err) {
      this.setStatus(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private rejectedKey(plan: Plan, id: string): string {
    return `${plan}:${id}`;
  }

  private async loadPlan(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    this.setStatus('Loading plan…');
    this.hoverTarget = null;
    this.selectedConfirmedIdx = null;
    this.connectDrag = null;
    try {
      const basePromise = this.loadStitched(RAW_LAYER[this.plan]);
      const contoursPromise = this.loadContours(this.plan);
      const suggestedPromise = desk.fs.readFile(suggestedPath(this.plan)).catch(() => null);
      const confirmedPromise = desk.fs.readFile(confirmedPath(this.plan)).catch(() => null);
      const streamsPromise = this.plan === 'restored' ? desk.fs.readFile(ACTUAL_STREAMS_PATH).catch(() => null) : Promise.resolve(null);

      const base = await basePromise;
      this.mainBase = whiteBg(base);
      this.fragments = await contoursPromise;

      const suggestedResult = await suggestedPromise;
      const fileSuggested: Connection[] = suggestedResult
        ? (JSON.parse(suggestedResult.contents) as SuggestedConnectionFile).connections.map((c) => ({
            connectionId: c.connectionId,
            source: c.source,
            aLon: c.aLon,
            aLat: c.aLat,
            bLon: c.bLon,
            bLat: c.bLat,
            a: mainPoint(c.aLon, c.aLat),
            b: mainPoint(c.bLon, c.bLat),
            elevationM: c.elevationM,
          }))
        : [];
      this.suggested = fileSuggested.filter((c) => !this.rejectedIds.has(this.rejectedKey(this.plan, c.connectionId)));
      // apply this session's OWN prior rejections too (persisted across reload)
      for (const r of this.log.rejections) this.rejectedIds.add(this.rejectedKey(r.plan, r.connectionId));
      this.suggested = this.suggested.filter((c) => !this.rejectedIds.has(this.rejectedKey(this.plan, c.connectionId)));

      const confirmedResult = await confirmedPromise;
      const fileConfirmed: Connection[] = confirmedResult
        ? (JSON.parse(confirmedResult.contents) as ConfirmedConnectionFile).connections.map((c) => ({
            connectionId: c.connectionId,
            source: c.source,
            aLon: c.aLon,
            aLat: c.aLat,
            bLon: c.bLon,
            bLat: c.bLat,
            a: mainPoint(c.aLon, c.aLat),
            b: mainPoint(c.bLon, c.bLat),
            elevationM: c.elevationM,
          }))
        : [];
      // This session's own not-yet-applied confirmations (from .desk_temp's
      // log, via scripts/apply_contour_connections.py) render too, so a
      // human sees immediately what they've already connected even before
      // asking Claude to fold the log into *.connections.confirmed.json.
      const sessionConfirmed: Connection[] = this.log.connections
        .filter((c) => c.plan === this.plan)
        .map((c) => ({
          connectionId: c.connectionId,
          source: c.source,
          aLon: c.aLon,
          aLat: c.aLat,
          bLon: c.bLon,
          bLat: c.bLat,
          a: mainPoint(c.aLon, c.aLat),
          b: mainPoint(c.bLon, c.bLat),
          elevationM: c.elevationM,
        }));
      const seen = new Set(fileConfirmed.map((c) => c.connectionId));
      const removedSet = new Set(this.log.removed);
      this.confirmed = [...fileConfirmed, ...sessionConfirmed.filter((c) => !seen.has(c.connectionId))].filter(
        (c) => !removedSet.has(c.connectionId),
      );

      const streamsResult = await streamsPromise;
      this.streamGuide = streamsResult
        ? (JSON.parse(streamsResult.contents) as { features: GeoJsonLineFeature[] }).features.map((f) =>
            f.geometry.coordinates.map(([lon, lat]) => mainPoint(lon, lat)),
          )
        : [];
      if (this.showStreamGuideEl) {
        this.showStreamGuideEl.disabled = this.plan !== 'restored';
      }

      this.viewRect = { x: 0, y: 0, width: MAIN_IMG_W, height: MAIN_IMG_H };
      this.updateInfo();
      this.setStatus(null);
      this.render();
      if (this.hdCanvas) this.hdCanvas.getContext('2d')?.clearRect(0, 0, this.hdCanvas.width, this.hdCanvas.height);
      if (this.hdStatusEl) this.hdStatusEl.textContent = '';
    } catch (err) {
      this.setStatus(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadContours(plan: Plan): Promise<ContourFeature[]> {
    const desk = window.desk;
    if (!desk) return [];
    const { contents } = await desk.fs.readFile(contoursPath(plan));
    const geojson = JSON.parse(contents) as { features: GeoJsonLineFeature[] };
    return geojson.features.map((f, id) => ({
      id,
      points: f.geometry.coordinates.map(([lon, lat]) => mainPoint(lon, lat)),
      elevationM: f.properties.elevation_m,
      elevationSource: f.properties.elevation_source ?? null,
    }));
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

  // ── Hit testing ──

  private visibleSuggested(): Connection[] {
    if (!this.showSuggestedEl?.checked) return [];
    return this.suggested.filter((c) => pointDistance(c.a, c.b) <= this.maxSuggestDistPx);
  }

  private hitTest(p: Point, excludeFragIdx: number | null): HoverTarget {
    const TOL = 6 * (this.viewRect.width / MAIN_IMG_W); // scale tolerance with zoom -- easier to hit at zoom-in
    let best: HoverTarget = null;
    let bestDist = Math.max(TOL, 4);
    this.fragments.forEach((f, idx) => {
      if (idx === excludeFragIdx) return;
      const d = distancePointToPolyline(p, f.points);
      if (d < bestDist) {
        bestDist = d;
        best = { kind: 'fragment', idx };
      }
    });
    if (this.showConfirmedEl?.checked ?? true) {
      this.confirmed.forEach((c, idx) => {
        const d = distancePointToSegment(p, c.a, c.b);
        if (d < bestDist) {
          bestDist = d;
          best = { kind: 'confirmed', idx };
        }
      });
    }
    if (!this.connectDrag) {
      // Suggested connections are only directly clickable (quick-accept)
      // outside of an active drag -- while dragging, a click target
      // should always resolve to a FRAGMENT (what the drag is meant to
      // connect), not an unrelated suggestion line that happens to pass
      // near the cursor.
      this.visibleSuggested().forEach((c, idx) => {
        const d = distancePointToSegment(p, c.a, c.b);
        if (d < bestDist) {
          bestDist = d;
          best = { kind: 'suggested', idx };
        }
      });
    }
    return best;
  }

  // ── Main canvas interaction ──

  private attachMainCanvasInteraction(): void {
    const canvas = this.mainCanvas;
    if (!canvas) return;
    let downPoint: Point | null = null;
    let moved = false;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const p = this.clientToImagePoint(e, canvas);
      downPoint = p;
      moved = false;
      const hit = this.hitTest(p, null);
      if (hit && hit.kind === 'fragment') {
        const frag = this.fragments[hit.idx]!;
        const startPt = frag.points[0]!;
        const endPt = frag.points[frag.points.length - 1]!;
        const anchorPoint = pointDistance(p, startPt) <= pointDistance(p, endPt) ? startPt : endPt;
        this.connectDrag = { anchorFragIdx: hit.idx, anchorPoint, curPoint: p, hoverFragIdx: null };
        this.hoverTarget = { kind: 'fragment', idx: hit.idx };
      } else {
        this.zoomDragState = { startX: p.x, startY: p.y, curX: p.x, curY: p.y };
      }
      this.render();
    });

    canvas.addEventListener('pointermove', (e) => {
      const p = this.clientToImagePoint(e, canvas);
      if (downPoint && pointDistance(p, downPoint) > 3) moved = true;

      if (this.connectDrag) {
        this.connectDrag.curPoint = p;
        const hit = this.hitTest(p, this.connectDrag.anchorFragIdx);
        this.connectDrag.hoverFragIdx = hit && hit.kind === 'fragment' ? hit.idx : null;
        this.render();
        return;
      }
      if (this.zoomDragState) {
        this.zoomDragState.curX = p.x;
        this.zoomDragState.curY = p.y;
        this.render();
        return;
      }
      // plain hover (nothing pressed)
      const hit = this.hitTest(p, null);
      if (JSON.stringify(hit) !== JSON.stringify(this.hoverTarget)) {
        this.hoverTarget = hit;
        this.render();
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      canvas.releasePointerCapture(e.pointerId);
      const p = this.clientToImagePoint(e, canvas);

      if (this.connectDrag) {
        const drag = this.connectDrag;
        this.connectDrag = null;
        if (drag.hoverFragIdx !== null) {
          void this.commitConnection(drag.anchorFragIdx, drag.hoverFragIdx);
        }
        this.render();
        downPoint = null;
        return;
      }

      if (this.zoomDragState) {
        const drag = this.zoomDragState;
        this.zoomDragState = null;
        const x = Math.min(drag.startX, drag.curX);
        const y = Math.min(drag.startY, drag.curY);
        const width = Math.abs(drag.curX - drag.startX);
        const height = Math.abs(drag.curY - drag.startY);
        if (width > 4 && height > 4) {
          const minSize = 20;
          const w = clamp(width, minSize, MAIN_IMG_W);
          const h = clamp(height, minSize, MAIN_IMG_H);
          this.viewRect = { x: clamp(x, 0, MAIN_IMG_W - w), y: clamp(y, 0, MAIN_IMG_H - h), width: w, height: h };
          this.render();
        } else if (!moved) {
          // a plain click (no drag) that didn't land on a fragment -- check
          // suggested/confirmed connections for click-to-accept / click-to-select
          const hit = this.hitTest(p, null);
          this.handleClick(hit);
        }
      }
      downPoint = null;
    });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = this.clientToImagePoint(e, canvas);
      const hit = this.hitTest(p, null);
      if (hit && hit.kind === 'suggested') {
        void this.rejectSuggestion(hit.idx);
      } else if (this.connectDrag) {
        this.connectDrag = null;
        this.render();
      }
    });
  }

  private handleClick(hit: HoverTarget): void {
    if (!hit) {
      this.selectedConfirmedIdx = null;
      this.updateInfo();
      this.render();
      return;
    }
    if (hit.kind === 'suggested') {
      void this.acceptSuggestion(hit.idx);
      return;
    }
    if (hit.kind === 'confirmed') {
      this.selectedConfirmedIdx = hit.idx;
      this.updateInfo();
      this.render();
      return;
    }
  }

  private clientToImagePoint(e: { clientX: number; clientY: number }, canvas: HTMLCanvasElement): Point {
    const rect = canvas.getBoundingClientRect();
    const cx = clamp(((e.clientX - rect.left) / rect.width) * canvas.width, 0, canvas.width);
    const cy = clamp(((e.clientY - rect.top) / rect.height) * canvas.height, 0, canvas.height);
    const x = this.viewRect.x + (cx / canvas.width) * this.viewRect.width;
    const y = this.viewRect.y + (cy / canvas.height) * this.viewRect.height;
    return { x, y };
  }

  // ── Connection actions ──

  private nearestEndpoint(frag: ContourFeature, to: Point): Point {
    const startPt = frag.points[0]!;
    const endPt = frag.points[frag.points.length - 1]!;
    return pointDistance(to, startPt) <= pointDistance(to, endPt) ? startPt : endPt;
  }

  private async commitConnection(anchorFragIdx: number, targetFragIdx: number): Promise<void> {
    if (anchorFragIdx === targetFragIdx) return;
    const anchorFrag = this.fragments[anchorFragIdx]!;
    const targetFrag = this.fragments[targetFragIdx]!;
    const anchorStart = anchorFrag.points[0]!;
    const anchorEnd = anchorFrag.points[anchorFrag.points.length - 1]!;
    // Re-pick the anchor's own nearest endpoint to the TARGET fragment
    // (not to wherever the drag happened to start) so the connection
    // always spans the true shortest gap between the two fragments.
    const targetNearStart = distancePointToPolyline(anchorStart, targetFrag.points);
    const targetNearEnd = distancePointToPolyline(anchorEnd, targetFrag.points);
    const anchorPoint = targetNearStart <= targetNearEnd ? anchorStart : anchorEnd;
    const targetPoint = this.nearestEndpoint(targetFrag, anchorPoint);

    const aWorld = { x: anchorPoint.x + MAIN_X_MIN * TILE, y: anchorPoint.y + MAIN_Y_MIN * TILE };
    const bWorld = { x: targetPoint.x + MAIN_X_MIN * TILE, y: targetPoint.y + MAIN_Y_MIN * TILE };
    const a = unprojectWorld(aWorld.x, aWorld.y, MAIN_Z, TILE);
    const b = unprojectWorld(bWorld.x, bWorld.y, MAIN_Z, TILE);
    const elevationM = anchorFrag.elevationM ?? targetFrag.elevationM ?? null;

    const entry: LogConnection = {
      connectionId: `manual-${this.plan}-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      plan: this.plan,
      source: 'manual',
      aLon: a.lon,
      aLat: a.lat,
      bLon: b.lon,
      bLat: b.lat,
      elevationM,
      confirmedAt: new Date().toISOString(),
    };
    this.log.connections.push(entry);
    this.confirmed.push({
      connectionId: entry.connectionId,
      source: 'manual',
      aLon: a.lon,
      aLat: a.lat,
      bLon: b.lon,
      bLat: b.lat,
      a: anchorPoint,
      b: targetPoint,
      elevationM,
    });
    await this.persist();
    this.updateInfo();
    this.render();
  }

  private async acceptSuggestion(idx: number): Promise<void> {
    const visible = this.visibleSuggested();
    const c = visible[idx];
    if (!c) return;
    const entry: LogConnection = {
      connectionId: c.connectionId,
      plan: this.plan,
      source: c.source,
      aLon: c.aLon,
      aLat: c.aLat,
      bLon: c.bLon,
      bLat: c.bLat,
      elevationM: c.elevationM,
      confirmedAt: new Date().toISOString(),
    };
    this.log.connections.push(entry);
    this.confirmed.push({ ...c });
    this.suggested = this.suggested.filter((s) => s.connectionId !== c.connectionId);
    await this.persist();
    this.updateInfo();
    this.render();
  }

  private async rejectSuggestion(idx: number): Promise<void> {
    const visible = this.visibleSuggested();
    const c = visible[idx];
    if (!c) return;
    this.rejectedIds.add(this.rejectedKey(this.plan, c.connectionId));
    this.log.rejections.push({ connectionId: c.connectionId, plan: this.plan, rejectedAt: new Date().toISOString() });
    this.suggested = this.suggested.filter((s) => s.connectionId !== c.connectionId);
    await this.persist();
    this.updateInfo();
    this.render();
  }

  private async removeSelectedConnection(): Promise<void> {
    if (this.selectedConfirmedIdx === null) return;
    const c = this.confirmed[this.selectedConfirmedIdx];
    if (!c) return;
    this.confirmed = this.confirmed.filter((x) => x.connectionId !== c.connectionId);
    this.log.connections = this.log.connections.filter((x) => x.connectionId !== c.connectionId);
    if (!this.log.removed.includes(c.connectionId)) this.log.removed.push(c.connectionId);
    this.selectedConfirmedIdx = null;
    await this.persist();
    this.updateInfo();
    this.render();
  }

  private async persist(): Promise<void> {
    void window.desk?.self.setLocalStorage({ log: this.log });
    const desk = window.desk;
    if (!desk) return;
    try {
      await desk.fs.writeFile(LOG_PATH, JSON.stringify(this.log, null, 2));
    } catch (err) {
      this.setStatus(`Failed to write log: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => this.setStatus(null), 2500);
    }
  }

  private updateInfo(): void {
    if (this.progressEl) {
      const planConfirmed = this.confirmed.length;
      const planSuggested = this.visibleSuggested().length;
      this.progressEl.textContent = `${planConfirmed} connection(s) confirmed · ${planSuggested} suggestion(s) shown (of ${this.suggested.length})`;
    }
    if (this.infoEl) {
      if (this.connectDrag) {
        this.infoEl.textContent = 'Drag to a different contour fragment, then release to connect. Right-click to cancel.';
      } else if (this.selectedConfirmedIdx !== null) {
        this.infoEl.textContent = 'Connection selected — click "Remove selected" to delete it, or click empty space to deselect.';
      } else {
        this.infoEl.textContent =
          'Drag from one contour fragment to another to connect them. Click a dashed suggestion to accept it (right-click to dismiss). Click a confirmed connection to select it.';
      }
    }
    if (this.removeSelectedButtonEl) this.removeSelectedButtonEl.disabled = this.selectedConfirmedIdx === null;
  }

  // ── Rendering ──

  private toCanvas(p: Point): Point {
    const v = this.viewRect;
    const canvas = this.mainCanvas!;
    return { x: ((p.x - v.x) / v.width) * canvas.width, y: ((p.y - v.y) / v.height) * canvas.height };
  }

  private strokePolyline(ctx: CanvasRenderingContext2D, points: Point[], color: string, width: number, dash: number[] = []): void {
    if (points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(dash);
    ctx.beginPath();
    points.forEach((p, i) => {
      const cp = this.toCanvas(p);
      if (i === 0) ctx.moveTo(cp.x, cp.y);
      else ctx.lineTo(cp.x, cp.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  private render(): void {
    this.updateInfo();
    const canvas = this.mainCanvas;
    const base = this.mainBase;
    if (!canvas || !base) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const v = this.viewRect;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, v.x, v.y, v.width, v.height, 0, 0, canvas.width, canvas.height);

    // Stream guide (Restored plan only) -- faint, non-interactive reference
    if (this.plan === 'restored' && (this.showStreamGuideEl?.checked ?? true)) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      for (const line of this.streamGuide) this.strokePolyline(ctx, line, STREAM_GUIDE_COLOR, 2, [2, 3]);
      ctx.restore();
    }

    // Real fragments (solid, major/minor/unlabeled)
    this.fragments.forEach((f, idx) => {
      const isAnchor = this.connectDrag?.anchorFragIdx === idx;
      const isDragTarget = this.connectDrag?.hoverFragIdx === idx;
      const isHover = !this.connectDrag && this.hoverTarget?.kind === 'fragment' && this.hoverTarget.idx === idx;
      const major = f.elevationSource === 'ocr' || f.elevationSource === 'review-confirmed';
      let color = contourColorFor(f);
      let width = major ? 1.8 : 1;
      if (isAnchor) {
        color = ANCHOR_COLOR;
        width = 3.5;
      } else if (isDragTarget) {
        color = DRAG_TARGET_COLOR;
        width = 3.5;
      } else if (isHover) {
        color = HOVER_COLOR;
        width = 2.6;
      }
      this.strokePolyline(ctx, f.points, color, width);
    });

    // Suggested connections -- thin, muted, dashed, color by source
    if (this.showSuggestedEl?.checked ?? true) {
      this.visibleSuggested().forEach((c, idx) => {
        const isHover = !this.connectDrag && this.hoverTarget?.kind === 'suggested' && this.hoverTarget.idx === idx;
        ctx.save();
        ctx.globalAlpha = isHover ? 0.95 : 0.55;
        this.strokePolyline(ctx, [c.a, c.b], suggestedColorFor(c.source), isHover ? 2.5 : 1.4, c.source === 'stream-guided' ? [2, 6] : [4, 4]);
        ctx.restore();
      });
    }

    // Confirmed / inferred connections -- ALWAYS the one distinct
    // dashed color, regardless of source, so "this is inferred, not
    // real data" reads at a glance.
    if (this.showConfirmedEl?.checked ?? true) {
      this.confirmed.forEach((c, idx) => {
        const isHover = !this.connectDrag && this.hoverTarget?.kind === 'confirmed' && this.hoverTarget.idx === idx;
        const isSelected = this.selectedConfirmedIdx === idx;
        this.strokePolyline(ctx, [c.a, c.b], INFERRED_COLOR, isSelected ? 4 : isHover ? 3 : 2.2, [10, 6]);
      });
    }

    // Live drag line
    if (this.connectDrag) {
      this.strokePolyline(ctx, [this.connectDrag.anchorPoint, this.connectDrag.curPoint], '#ffffff', 2, [6, 4]);
    }

    // Zoom-drag selection box
    if (this.zoomDragState) {
      const x = Math.min(this.zoomDragState.startX, this.zoomDragState.curX);
      const y = Math.min(this.zoomDragState.startY, this.zoomDragState.curY);
      const w = Math.abs(this.zoomDragState.curX - this.zoomDragState.startX);
      const h = Math.abs(this.zoomDragState.curY - this.zoomDragState.startY);
      const tl = this.toCanvas({ x, y });
      const br = this.toCanvas({ x: x + w, y: y + h });
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

  // ── HD (zoom-22) crop, centered on the current view ──

  private async loadHdCrop(): Promise<void> {
    if (!this.hdCanvas || !this.serviceUrl) return;
    if (this.hdStatusEl) this.hdStatusEl.textContent = 'Loading HD crop…';

    const centerMain = { x: this.viewRect.x + this.viewRect.width / 2, y: this.viewRect.y + this.viewRect.height / 2 };
    const centerWorldMain = { x: centerMain.x + MAIN_X_MIN * TILE, y: centerMain.y + MAIN_Y_MIN * TILE };
    const { lon: centerLon, lat: centerLat } = unprojectWorld(centerWorldMain.x, centerWorldMain.y, MAIN_Z, TILE);
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
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, this.hdCanvas.width, this.hdCanvas.height);
    ctx.restore();

    const toHd = (p: Point): Point => {
      const world = { x: p.x + MAIN_X_MIN * TILE, y: p.y + MAIN_Y_MIN * TILE };
      const ll = unprojectWorld(world.x, world.y, MAIN_Z, TILE);
      const w = projectWorld(ll.lon, ll.lat, HD_Z, TILE);
      return { x: w.x - worldX0, y: w.y - worldY0 };
    };
    const strokeHd = (points: Point[], color: string, width: number, dash: number[] = []): void => {
      if (points.length < 2) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      points.forEach((p, i) => {
        const hp = toHd(p);
        if (i === 0) ctx.moveTo(hp.x, hp.y);
        else ctx.lineTo(hp.x, hp.y);
      });
      ctx.stroke();
      ctx.restore();
    };
    if (this.plan === 'restored' && (this.showStreamGuideEl?.checked ?? true)) {
      for (const line of this.streamGuide) strokeHd(line, STREAM_GUIDE_COLOR, 2, [2, 3]);
    }
    for (const f of this.fragments) strokeHd(f.points, contourColorFor(f), f.elevationSource === 'ocr' || f.elevationSource === 'review-confirmed' ? 2.2 : 1.4);
    if (this.showSuggestedEl?.checked ?? true) {
      for (const c of this.visibleSuggested()) strokeHd([c.a, c.b], suggestedColorFor(c.source), 1.6, c.source === 'stream-guided' ? [2, 6] : [4, 4]);
    }
    if (this.showConfirmedEl?.checked ?? true) {
      for (const c of this.confirmed) strokeHd([c.a, c.b], INFERRED_COLOR, 2.4, [10, 6]);
    }

    if (this.hdStatusEl) this.hdStatusEl.textContent = `HD crop at zoom ${HD_Z} (~0.028 m/px), centered on the current view.`;
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

customElements.define('contour-connector', ContourConnectorElement);
