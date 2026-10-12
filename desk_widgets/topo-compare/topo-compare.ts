// build-marker v3: adds a 4th panel (extracted vector contour/stream
// layers), collapsible sections, a left-hand table of contents, and a
// denser layout -- see "let's start with a 4th panel in TopoCompare"
// and the UI requests alongside it.
//
// Topographic Source Comparison -- a debugging/triage widget for the
// `samothrace-tiles` hmsvc service's topographic extraction (see
// desk_hmsvc/samothrace-tiles/service.py): it diffs the raw Actual State
// Plan and Restored State Plan tiles to synthesize a shared "topographic"
// base layer, on the theory that whatever's identical between the two
// plans must be terrain, not architecture. The result looked wrong
// (non-terrain content on it, apparent "echoes" suggesting the two source
// plans aren't pixel-aligned) -- this widget exists purely to *look* at
// the inputs and output together, and to let a human mark regions of
// interest with a comment, rather than to fix anything itself.
//
// Four views of the same fixed 3x3 tile grid (zoom 18, the whole site):
//   (a) side by side  -- the two raw, undecomposed source plans
//   (b) overlay       -- both sources tinted (red/cyan) and multiply
//                        -blended, so any misalignment between them shows
//                        up as colored ghosting/double lines
//   (c) combined       -- the service's actual computed output (pick
//                        among topographic / actual-structures /
//                        restored-structures)
//   (d) vectors        -- scripts/extract_vector_layers.py's output:
//                        contour lines + stream lines extracted directly
//                        from one plan's own raster (no cross-plan
//                        diffing), reprojected and drawn over a faint
//                        backdrop of that same plan for context
// All four canvases share one pixel space (the same 768x768 stitched
// image), so a selection rectangle's coordinates mean the same thing on
// every panel. Drag a rectangle on any image, write a comment, Save --
// it's appended to an on-canvas log *and* written to
// `.desk_temp/topo-compare-log.json` so Claude can read it back directly.

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
    popups: {
      show(title: string, message: string, buttons: string[], defaultButton?: string | null): Promise<string | null>;
    };
    state: {
      get(key: string): Promise<{ value: unknown; edit: unknown }>;
    };
  };
}

// ── Constants ──

// TEMPORARY WORKAROUND: see the identical comment in
// desk_widgets/samothrace-map/samothrace-map.ts -- the samothrace-tiles
// hmsvc service's own URL is discovered at startup from Desk's shared
// state (mirrored to `desk.hmsvc.<name>` as {status, url}), the same
// way samothrace-map.ts does it, rather than hard-coded: the service
// gets a fresh random port on every launch (confirmed the hard way --
// this constant went stale three separate times before switching to
// this), and this way the widget only needs the "state" capability it
// already holds (no "hmsvc" capability needed just to read one URL).
const TILE_SERVICE_NAME = 'samothrace-tiles';
const TILE_SERVICE_STATE_KEY = `desk.hmsvc.${TILE_SERVICE_NAME}`;

const LOG_PATH = '.desk_temp/topo-compare-log.json';

// The whole Samothrace site fits exactly in this 3x3 tile grid at zoom
// 18 (confirmed against Data/mapTiles/*/18/ on disk) -- picked so this
// widget can show the entire plan as one static stitched image with no
// pan/zoom UI to build.
const Z = 18;
const X_MIN = 149661;
const X_MAX = 149663;
const Y_MIN = 98763; // XYZ (north), not the TMS convention the tiles are stored on disk under
const Y_MAX = 98765;
const TILE = 256;
const COLS = X_MAX - X_MIN + 1;
const ROWS = Y_MAX - Y_MIN + 1;
const IMG_W = COLS * TILE;
const IMG_H = ROWS * TILE;

type CombinedLayerId = 'topographic' | 'actual-structures' | 'restored-structures';
const COMBINED_LAYERS: Array<{ id: CombinedLayerId; label: string }> = [
  { id: 'topographic', label: 'Topographic Base' },
  { id: 'actual-structures', label: 'Actual State — Structures' },
  { id: 'restored-structures', label: 'Restored State — Structures' },
];

type VectorPlan = 'actual' | 'restored';
const VECTOR_PLANS: Array<{ id: VectorPlan; label: string }> = [
  { id: 'actual', label: 'Actual State Plan' },
  { id: 'restored', label: 'Restored State Plan' },
];
// scripts/extract_vector_layers.py's own output paths.
const VECTOR_PATHS: Record<VectorPlan, { contours: string; streams: string }> = {
  actual: {
    contours: 'Data/mapFeatures/SamoWeb_ActualStatePlan_Contours.geojson',
    streams: 'Data/mapFeatures/SamoWeb_ActualStatePlan_Streams.geojson',
  },
  restored: {
    contours: 'Data/mapFeatures/SamoWeb_RestoredStatePlan_Contours.geojson',
    streams: 'Data/mapFeatures/SamoWeb_RestoredStatePlan_Streams.geojson', // doesn't exist -- restored has no marked streams; loadGeoJsonLines tolerates a missing file
  },
};

type SourceId = 'actual' | 'restored' | 'overlay' | 'combined' | 'vectors';
const SOURCE_LABELS: Record<SourceId, string> = {
  actual: 'Side by side — Actual State Plan (source)',
  restored: 'Side by side — Restored State Plan (source)',
  overlay: 'Overlay (red = Actual, cyan = Restored)',
  combined: 'Combined result',
  vectors: 'Extracted vector layers',
};

const ENTRY_COLORS = ['#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#eab308', '#14b8a6', '#f97316', '#38bdf8'];

// Every section a PendingSelection/DragState/LogEntry might belong to,
// in TOC/DOM order -- used for matching an overlay draw call to the
// right panel and for the clickable table of contents.
const SECTION_IDS = ['side-by-side', 'overlay', 'combined', 'vectors', 'log'] as const;
type SectionId = (typeof SECTION_IDS)[number];

// ── Web Mercator (EPSG:3857) projection -- same formulas as
// samothrace-map.ts. Both directions are needed here: unproject (pixel
// -> lon/lat) to record a saved rectangle's geographic bounds, project
// (lon/lat -> pixel) to place the extracted GeoJSON vector features
// (which are stored as lon/lat) back into this widget's own tile-pixel
// space. ──
function unprojectWorld(x: number, y: number, zoom: number, tileSize: number): { lon: number; lat: number } {
  const n = Math.pow(2, zoom) * tileSize;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lon, lat: (latRad * 180) / Math.PI };
}

function projectWorld(lon: number, lat: number, zoom: number, tileSize: number): { x: number; y: number } {
  const n = Math.pow(2, zoom) * tileSize;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function normalizeRect(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

// A pending/dragged/saved selection's "which sub-view" is one of these,
// never both -- kept as two separate optional fields (rather than one
// unityped slot) so each stays strongly typed against the option list
// that's actually valid for it.
interface SubSelector {
  combinedLayer: CombinedLayerId | null;
  vectorPlan: VectorPlan | null;
}

function subSelectorsEqual(a: SubSelector, b: SubSelector): boolean {
  return a.combinedLayer === b.combinedLayer && a.vectorPlan === b.vectorPlan;
}

function subSelectorLabelSuffix(sub: SubSelector): string {
  if (sub.combinedLayer) {
    return `: ${COMBINED_LAYERS.find((l) => l.id === sub.combinedLayer)?.label ?? sub.combinedLayer}`;
  }
  if (sub.vectorPlan) {
    return `: ${VECTOR_PLANS.find((p) => p.id === sub.vectorPlan)?.label ?? sub.vectorPlan}`;
  }
  return '';
}

interface LogEntry {
  id: number;
  source: SourceId;
  sub: SubSelector;
  rect: Rect;
  lonLatBounds: { west: number; south: number; east: number; north: number };
  comment: string;
  savedAt: string;
}

interface PendingSelection {
  source: SourceId;
  sub: SubSelector;
  rect: Rect;
}

interface DragState {
  source: SourceId;
  sub: SubSelector;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
}

type PickMode = 'comment' | 'zoom';

// Smallest a zoomed-in view is allowed to get (in full-image pixels) --
// stops an accidental sliver drag from zooming into a degenerate,
// unreadable crop.
const MIN_VIEW_SIZE = 24;

function fullExtentRect(): Rect {
  return { x: 0, y: 0, width: IMG_W, height: IMG_H };
}

function clampViewRect(rect: Rect): Rect {
  const width = clamp(rect.width, MIN_VIEW_SIZE, IMG_W);
  const height = clamp(rect.height, MIN_VIEW_SIZE, IMG_H);
  const x = clamp(rect.x, 0, IMG_W - width);
  const y = clamp(rect.y, 0, IMG_H - height);
  return { x, y, width, height };
}

// ── Extracted vector layers (scripts/extract_vector_layers.py output) ──

type VectorLayerKind = 'contours' | 'streams';

interface VectorFeature {
  id: number; // the feature's array index at load time (stable within one extraction run, not across re-runs) -- or, for a manually-merged feature, a synthetic id >= SYNTHETIC_ID_BASE
  points: Array<{ x: number; y: number }>; // local pixel space (0..IMG_W, 0..IMG_H), already projected
  elevationM: number | null;
  // scripts/extract_vector_layers.py's own elevation_source property:
  // "ocr" / "review-confirmed" (a real labeled INDEX contour) vs
  // "interpolated" (a MINOR 1m band, stage 7's banding) vs "unlabeled"
  // / null. Used purely to pick a different shade per kind -- see
  // CONTOUR_COLOR below -- never for anything else.
  elevationSource: string | null;
}

interface VectorPlanData {
  contours: VectorFeature[];
  streams: VectorFeature[];
}

interface GeoJsonLineFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  properties: { elevation_m: number | null; elevation_source?: string | null };
}

// Three shades, not two -- a labeled INDEX contour (OCR'd/human
// -confirmed elevation label) and an INTERPOLATED minor (1m) contour
// used to be drawn the same color, which was confusing (see "please use
// different shades to distinguish between recognized major and minor
// contours" in the chat history). Kept in sync with the same palette
// save_stage_fragments (extract_vector_layers.py) and the
// ContourConnector widget use.
const CONTOUR_COLOR = {
  major: '#c026d3', // index contour, OCR'd/confirmed label -- magenta
  minor: '#f59e0b', // interpolated 1m band -- amber
  unlabeled: '#94a3b8', // no elevation at all -- muted slate, recedes visually
} as const;

function contourColorFor(feat: VectorFeature): string {
  if (feat.elevationSource === 'ocr' || feat.elevationSource === 'review-confirmed') return CONTOUR_COLOR.major;
  if (feat.elevationSource === 'interpolated') return CONTOUR_COLOR.minor;
  return CONTOUR_COLOR.unlabeled;
}

// ── Manual corrections (entry #3 in the selection log: disconnected
// fragments that should join, contours cut by a building, digit labels
// misdetected as contour lines -- a point-and-click way to fix all
// three by eye rather than tuning the extraction heuristics further).
// Kept entirely separate from scripts/extract_vector_layers.py's own
// output files (never edited in place) so re-running the extractor
// can't silently clobber a human's corrections, and so corrections are
// visibly their own artifact. Scoped per (plan, layer) -- a contour
// correction and a stream correction are never related. ──

// Synthetic ids for a merged feature start here, comfortably above any
// real extraction's feature count (low thousands), so they can never
// collide with a real feature's array-index id.
const SYNTHETIC_ID_BASE = 1_000_000;

// How close (in full-image pixels) a click needs to land to the
// nearest line segment of a feature to select it. Deliberately small --
// zooming in first (the widget's existing Zoom mode) is how a human is
// expected to get precision for a crowded area, the same way the rest
// of this widget already works.
const EDIT_CLICK_TOLERANCE_PX = 5;

interface CorrectionsState {
  deletedIds: Set<number>;
  merged: VectorFeature[];
}

function cloneCorrectionsState(state: CorrectionsState): CorrectionsState {
  return {
    deletedIds: new Set(state.deletedIds),
    merged: state.merged.map((f) => ({ ...f, points: f.points.map((p) => ({ ...p })) })),
  };
}

function pointDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distancePointToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return pointDistance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return pointDistance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function distancePointToFeature(p: { x: number; y: number }, feature: VectorFeature): number {
  let min = Infinity;
  for (let i = 0; i < feature.points.length - 1; i++) {
    const d = distancePointToSegment(p, feature.points[i]!, feature.points[i + 1]!);
    if (d < min) min = d;
  }
  return min;
}

// Joins two features end-to-end, choosing whichever of the 4 possible
// endpoint pairings has the smallest gap (the same "closest pair of
// endpoints" idea extract_vector_layers.py's own label-gap merge uses)
// so the human doesn't have to think about which ends to click in
// which order.
function mergeVectorFeatures(a: VectorFeature, b: VectorFeature, newId: number): VectorFeature {
  const aStart = a.points[0]!;
  const aEnd = a.points[a.points.length - 1]!;
  const bStart = b.points[0]!;
  const bEnd = b.points[b.points.length - 1]!;
  const options = [
    { dist: pointDistance(aEnd, bStart), aRev: false, bRev: false },
    { dist: pointDistance(aEnd, bEnd), aRev: false, bRev: true },
    { dist: pointDistance(aStart, bStart), aRev: true, bRev: false },
    { dist: pointDistance(aStart, bEnd), aRev: true, bRev: true },
  ];
  options.sort((x, y) => x.dist - y.dist);
  const best = options[0]!;
  const aPts = best.aRev ? [...a.points].reverse() : a.points;
  const bPts = best.bRev ? [...b.points].reverse() : b.points;
  return {
    id: newId,
    points: [...aPts, ...bPts],
    elevationM: a.elevationM ?? b.elevationM,
    elevationSource: a.elevationSource ?? b.elevationSource ?? null,
  };
}

// ── Canvas compositing helpers ──
// whiteBg: paint white *behind* the source (via destination-over) so a
// layer shows in its own original colors against a plain white
// background instead of the widget's dark page background -- works
// regardless of whether the source's "background" is transparent or
// already-opaque-white, since destination-over is a no-op wherever the
// source is already opaque. tintByDarkness (below, used for the overlay
// panel) is the recolor counterpart -- see its own comment for why it
// keys off per-pixel darkness rather than alpha.

function whiteBg(source: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = IMG_W;
  c.height = IMG_H;
  const cx = c.getContext('2d')!;
  cx.drawImage(source, 0, 0);
  cx.globalCompositeOperation = 'destination-over';
  cx.fillStyle = 'white';
  cx.fillRect(0, 0, IMG_W, IMG_H);
  cx.globalCompositeOperation = 'source-over';
  return c;
}

// tintOnWhite (an earlier version of this function) recolored via a
// source-atop fill, which assumes "ink" is the only opaque content and
// everything else is transparent background -- true for the *computed*
// topographic/structures layers (service.py explicitly alpha-masks
// those down to ink-only silhouettes), but FALSE for these raw source
// plan tiles: within the surveyed extent they're fully opaque (a real
// white background, not transparent), and only transparent *outside*
// that extent (confirmed by compositing a raw tile over magenta -- the
// drawn area stayed solid white+black, not see-through). source-atop
// against a fully-opaque image tints the *entire* drawn area, not just
// the ink, which is why the overlay below used to render as one flat
// dark block (red tint * cyan tint, uniformly) instead of showing
// individual lines. Tinting by per-pixel darkness instead -- white
// stays white, black ink becomes the full tint color, antialiased
// grays interpolate between -- works regardless of which kind of
// "background" (opaque white vs. transparent) a given source uses.
function tintByDarkness(source: HTMLCanvasElement, color: [number, number, number]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = IMG_W;
  c.height = IMG_H;
  const cx = c.getContext('2d')!;
  cx.drawImage(source, 0, 0);
  const imgData = cx.getImageData(0, 0, IMG_W, IMG_H);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 0) continue; // fully transparent (outside the surveyed extent) -- leave it, filled white below
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b; // 0 (black) .. 255 (white)
    const darkness = (255 - luminance) / 255; // 0 (background) .. 1 (fully inked)
    data[i] = Math.round(255 - darkness * (255 - color[0]));
    data[i + 1] = Math.round(255 - darkness * (255 - color[1]));
    data[i + 2] = Math.round(255 - darkness * (255 - color[2]));
  }
  cx.putImageData(imgData, 0, 0);
  // Outside-the-extent pixels are still transparent at this point (skipped
  // above) -- fill white behind them, same convention whiteBg() uses.
  cx.globalCompositeOperation = 'destination-over';
  cx.fillStyle = 'white';
  cx.fillRect(0, 0, IMG_W, IMG_H);
  cx.globalCompositeOperation = 'source-over';
  return c;
}

function buildOverlay(actual: HTMLCanvasElement, restored: HTMLCanvasElement): HTMLCanvasElement {
  const tintedActual = tintByDarkness(actual, [227, 52, 47]); // red
  const tintedRestored = tintByDarkness(restored, [14, 165, 233]); // cyan/sky blue
  const c = document.createElement('canvas');
  c.width = IMG_W;
  c.height = IMG_H;
  const cx = c.getContext('2d')!;
  cx.fillStyle = 'white';
  cx.fillRect(0, 0, IMG_W, IMG_H);
  cx.globalCompositeOperation = 'multiply';
  cx.drawImage(tintedActual, 0, 0);
  cx.drawImage(tintedRestored, 0, 0);
  cx.globalCompositeOperation = 'source-over';
  return c;
}

// ── Element ──

class TopoCompareElement extends HTMLElement {
  private actualCanvas: HTMLCanvasElement | null = null;
  private restoredCanvas: HTMLCanvasElement | null = null;
  private overlayCanvas: HTMLCanvasElement | null = null;
  private combinedCanvas: HTMLCanvasElement | null = null;
  private vectorsCanvas: HTMLCanvasElement | null = null;
  private combinedSelectEl: HTMLSelectElement | null = null;
  private vectorPlanSelectEl: HTMLSelectElement | null = null;
  private vectorShowContoursEl: HTMLInputElement | null = null;
  private vectorShowStreamsEl: HTMLInputElement | null = null;
  private editToggleButtonEl: HTMLButtonElement | null = null;
  private editStatusEl: HTMLElement | null = null;
  private editDeleteButtonEl: HTMLButtonElement | null = null;
  private editMergeButtonEl: HTMLButtonElement | null = null;
  private editCancelButtonEl: HTMLButtonElement | null = null;
  private editUndoButtonEl: HTMLButtonElement | null = null;
  private editSaveButtonEl: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;

  private pendingLabelEl: HTMLElement | null = null;
  private commentEl: HTMLTextAreaElement | null = null;
  private saveButtonEl: HTMLButtonElement | null = null;
  private discardButtonEl: HTMLButtonElement | null = null;
  private logListEl: HTMLElement | null = null;

  private modeCommentButtonEl: HTMLButtonElement | null = null;
  private modeZoomButtonEl: HTMLButtonElement | null = null;
  private resetZoomButtonEl: HTMLButtonElement | null = null;
  private zoomReadoutEl: HTMLElement | null = null;
  private mainScrollEl: HTMLElement | null = null;

  private rawCache = new Map<string, Promise<HTMLCanvasElement>>();
  private actualWhite: HTMLCanvasElement | null = null;
  private restoredWhite: HTMLCanvasElement | null = null;
  private overlayComposited: HTMLCanvasElement | null = null;
  private combinedWhiteCache = new Map<CombinedLayerId, HTMLCanvasElement>();
  private serviceUrl: string | null = null;
  private vectorDataCache = new Map<VectorPlan, Promise<VectorPlanData>>();
  private vectorDataByPlan = new Map<VectorPlan, VectorPlanData>();
  // Keyed by `${plan}:${layer}` (see correctionsKeyFor) -- entries are
  // created lazily by getCorrections() the first time either plan/layer
  // combination is touched, so an untouched one is simply absent rather
  // than present-but-empty.
  private corrections = new Map<string, CorrectionsState>();
  private undoStack: Array<{ plan: VectorPlan; layer: VectorLayerKind; snapshot: CorrectionsState }> = [];
  private nextSyntheticId = SYNTHETIC_ID_BASE;

  private combinedLayer: CombinedLayerId = 'topographic';
  private vectorPlan: VectorPlan = 'actual';
  private showVectorContours = true;
  private showVectorStreams = true;
  private editVectorsActive = false;
  private editSelectedFeature: { plan: VectorPlan; layer: VectorLayerKind; feature: VectorFeature } | null = null;
  private editMergeSource: { plan: VectorPlan; layer: VectorLayerKind; feature: VectorFeature } | null = null;

  private entries: LogEntry[] = [];
  private nextId = 1;
  private pending: PendingSelection | null = null;
  private dragState: DragState | null = null;
  private hoveredEntryId: number | null = null;
  private collapsedSections = new Set<SectionId>();

  private mode: PickMode = 'comment';
  private viewRect: Rect = fullExtentRect();

  connectedCallback(): void {
    const template = document.getElementById('topo-compare-template');
    if (!(template instanceof HTMLTemplateElement)) {
      throw new Error('topo-compare-template not found');
    }
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(template.content.cloneNode(true));

    this.actualCanvas = shadow.querySelector('.panel-actual');
    this.restoredCanvas = shadow.querySelector('.panel-restored');
    this.overlayCanvas = shadow.querySelector('.panel-overlay');
    this.combinedCanvas = shadow.querySelector('.panel-combined');
    this.vectorsCanvas = shadow.querySelector('.panel-vectors');
    this.combinedSelectEl = shadow.querySelector('.combined-select');
    this.vectorPlanSelectEl = shadow.querySelector('.vector-plan-select');
    this.vectorShowContoursEl = shadow.querySelector('.vector-show-contours');
    this.vectorShowStreamsEl = shadow.querySelector('.vector-show-streams');
    this.editToggleButtonEl = shadow.querySelector('.edit-toggle-button');
    this.editStatusEl = shadow.querySelector('.edit-status');
    this.editDeleteButtonEl = shadow.querySelector('.edit-delete-button');
    this.editMergeButtonEl = shadow.querySelector('.edit-merge-button');
    this.editCancelButtonEl = shadow.querySelector('.edit-cancel-button');
    this.editUndoButtonEl = shadow.querySelector('.edit-undo-button');
    this.editSaveButtonEl = shadow.querySelector('.edit-save-button');
    this.statusEl = shadow.querySelector('.status-overlay');
    this.pendingLabelEl = shadow.querySelector('.pending-label');
    this.commentEl = shadow.querySelector('.comment-input');
    this.saveButtonEl = shadow.querySelector('.save-button');
    this.discardButtonEl = shadow.querySelector('.discard-button');
    this.logListEl = shadow.querySelector('.log-list');
    this.modeCommentButtonEl = shadow.querySelector('.mode-comment');
    this.modeZoomButtonEl = shadow.querySelector('.mode-zoom');
    this.resetZoomButtonEl = shadow.querySelector('.reset-zoom-button');
    this.zoomReadoutEl = shadow.querySelector('.zoom-readout');
    this.mainScrollEl = shadow.querySelector('.main-scroll');

    for (const canvas of [this.actualCanvas, this.restoredCanvas, this.overlayCanvas, this.combinedCanvas, this.vectorsCanvas]) {
      if (canvas) {
        canvas.width = IMG_W;
        canvas.height = IMG_H;
      }
    }

    if (this.combinedSelectEl) {
      this.combinedSelectEl.innerHTML = COMBINED_LAYERS.map((l) => `<option value="${l.id}">${escapeHtml(l.label)}</option>`).join('');
      this.combinedSelectEl.value = this.combinedLayer;
      this.combinedSelectEl.addEventListener('change', () => {
        const v = this.combinedSelectEl?.value as CombinedLayerId | undefined;
        if (v) void this.setCombinedLayer(v);
      });
    }

    if (this.vectorPlanSelectEl) {
      this.vectorPlanSelectEl.innerHTML = VECTOR_PLANS.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
      this.vectorPlanSelectEl.value = this.vectorPlan;
      this.vectorPlanSelectEl.addEventListener('change', () => {
        const v = this.vectorPlanSelectEl?.value as VectorPlan | undefined;
        if (v) void this.setVectorPlan(v);
      });
    }
    this.vectorShowContoursEl?.addEventListener('change', () => {
      this.showVectorContours = this.vectorShowContoursEl?.checked ?? true;
      this.renderAll();
    });
    this.vectorShowStreamsEl?.addEventListener('change', () => {
      this.showVectorStreams = this.vectorShowStreamsEl?.checked ?? true;
      this.renderAll();
    });

    const none: SubSelector = { combinedLayer: null, vectorPlan: null };
    this.attachSelection(this.actualCanvas, 'actual', () => none);
    this.attachSelection(this.restoredCanvas, 'restored', () => none);
    this.attachSelection(this.overlayCanvas, 'overlay', () => none);
    this.attachSelection(this.combinedCanvas, 'combined', () => ({ combinedLayer: this.combinedLayer, vectorPlan: null }));
    // Edit mode (click-to-select/delete/merge, below) takes over the
    // vectors canvas's clicks -- disable its drag-a-rectangle comment
    // /zoom behavior while active so the two interaction models can't
    // both fire off the same pointer sequence.
    this.attachSelection(this.vectorsCanvas, 'vectors', () => ({ combinedLayer: null, vectorPlan: this.vectorPlan }), () => !this.editVectorsActive);
    this.vectorsCanvas?.addEventListener('click', (e) => this.handleVectorCanvasClick(e));

    this.editToggleButtonEl?.addEventListener('click', () => {
      this.editVectorsActive = !this.editVectorsActive;
      this.editSelectedFeature = null;
      this.editMergeSource = null;
      this.editToggleButtonEl?.classList.toggle('active', this.editVectorsActive);
      this.updateEditButtons();
      this.updateEditStatus();
      this.renderAll();
    });
    this.editDeleteButtonEl?.addEventListener('click', () => this.deleteSelectedFeature());
    this.editMergeButtonEl?.addEventListener('click', () => this.startMerge());
    this.editCancelButtonEl?.addEventListener('click', () => {
      this.editSelectedFeature = null;
      this.editMergeSource = null;
      this.updateEditButtons();
      this.updateEditStatus();
      this.renderAll();
    });
    this.editUndoButtonEl?.addEventListener('click', () => this.undoLastCorrection());
    this.editSaveButtonEl?.addEventListener('click', () => void this.saveCorrections());
    this.updateEditButtons();

    this.saveButtonEl?.addEventListener('click', () => void this.saveComment());
    this.discardButtonEl?.addEventListener('click', () => this.clearPending());
    shadow.querySelector('.clear-all-button')?.addEventListener('click', () => void this.clearAll());

    this.modeCommentButtonEl?.addEventListener('click', () => this.setMode('comment'));
    this.modeZoomButtonEl?.addEventListener('click', () => this.setMode('zoom'));
    this.resetZoomButtonEl?.addEventListener('click', () => this.resetZoom());
    this.updateModeButtons();
    this.updateZoomReadout();

    this.initCollapsibleSections(shadow);
    this.initTableOfContents(shadow);

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

  // ── Collapsible sections ──

  private initCollapsibleSections(shadow: ShadowRoot): void {
    shadow.querySelectorAll<HTMLElement>('.panel-section').forEach((section) => {
      const header = section.querySelector('.section-header');
      header?.addEventListener('click', () => {
        const id = section.dataset.sectionId as SectionId | undefined;
        if (!id) return;
        const collapsed = section.classList.toggle('collapsed');
        if (collapsed) this.collapsedSections.add(id);
        else this.collapsedSections.delete(id);
        void this.persistLocalState();
      });
    });
  }

  private applyCollapsedState(shadow: ShadowRoot): void {
    shadow.querySelectorAll<HTMLElement>('.panel-section').forEach((section) => {
      const id = section.dataset.sectionId as SectionId | undefined;
      if (id && this.collapsedSections.has(id)) section.classList.add('collapsed');
    });
  }

  // ── Table of contents ──

  private initTableOfContents(shadow: ShadowRoot): void {
    shadow.querySelectorAll<HTMLElement>('.toc-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const mainScroll = this.mainScrollEl;
        if (!targetId || !mainScroll) return;
        const target = shadow.querySelector<HTMLElement>(`[data-section-id="${targetId}"]`);
        if (!target) return;
        // Scroll so the target's top sits 20px below the scroll area's own
        // top edge -- clamping the desired scrollTop to the container's
        // valid [0, scrollHeight-clientHeight] range both prevents an
        // invalid scroll position AND is exactly the "minimize the
        // difference from the 20px target" behavior asked for: for a
        // monotonic scrollTop->visible-position relationship, the
        // in-range value closest to an out-of-range target is always
        // whichever boundary it overshot.
        const desired = target.offsetTop - 20;
        const maxScroll = Math.max(0, mainScroll.scrollHeight - mainScroll.clientHeight);
        const clamped = clamp(desired, 0, maxScroll);
        mainScroll.scrollTo({ top: clamped, behavior: 'smooth' });
      });
    });
  }

  // ── Startup ──

  private async init(): Promise<void> {
    const desk = window.desk;
    try {
      this.setStatus('Finding tile service…');
      if (!desk) throw new Error('Desk bridge unavailable');
      const tileService = await desk.state.get(TILE_SERVICE_STATE_KEY);
      const tileServiceValue = tileService.value as { status: string; url: string | null } | null;
      if (!tileServiceValue || !tileServiceValue.url) {
        throw new Error(`${TILE_SERVICE_NAME} tile service is not running -- start it from the Microservices widget`);
      }
      this.serviceUrl = tileServiceValue.url.replace(/\/+$/, '');

      this.setStatus('Loading tiles…');

      const [actualRaw, restoredRaw, combinedRaw] = await Promise.all([
        this.loadStitched('actual-plan-raw'),
        this.loadStitched('restored-plan-raw'),
        this.loadStitched(this.combinedLayer),
      ]);
      this.actualWhite = whiteBg(actualRaw);
      this.restoredWhite = whiteBg(restoredRaw);
      this.overlayComposited = buildOverlay(actualRaw, restoredRaw);
      this.combinedWhiteCache.set(this.combinedLayer, whiteBg(combinedRaw));

      this.setStatus('Loading vector layers…');
      const vectorData = await this.loadVectorPlanData(this.vectorPlan);
      this.vectorDataByPlan.set(this.vectorPlan, vectorData);

      if (desk) {
        const { data } = await desk.self.getLocalStorage();
        const savedEntriesRaw = Array.isArray(data.entries) ? (data.entries as unknown[]) : [];
        const savedEntries = savedEntriesRaw.map((e) => this.migrateEntry(e));
        this.entries = savedEntries;
        const savedNextId = typeof data.nextId === 'number' ? data.nextId : null;
        this.nextId = savedNextId ?? (savedEntries.reduce((m, e) => Math.max(m, e.id), 0) + 1);
        const savedCollapsed = Array.isArray(data.collapsedSections) ? (data.collapsedSections as string[]) : [];
        this.collapsedSections = new Set(savedCollapsed.filter((id): id is SectionId => (SECTION_IDS as readonly string[]).includes(id)));
        this.applyCollapsedState(this.shadowRoot!);
      }

      this.setStatus(null);
      this.renderAll();
      this.renderLogList();
      // Make sure a log file exists / reflects whatever was restored from
      // localStorage, even if nothing changes this session.
      void this.writeLogFile();
    } catch (err) {
      this.setStatus(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Entries saved before this build had a flat `combinedLayer` field
  // directly on the entry instead of today's nested `sub` (which also
  // covers `vectorPlan` for the new (d) panel) -- without this, loading
  // an old save would produce an entry with no `.sub` at all, and every
  // render call crashes the first time it reaches
  // subSelectorLabelSuffix(entry.sub). Old-shape detection is just
  // "there's no `sub` object yet."
  private migrateEntry(raw: unknown): LogEntry {
    const r = raw as Record<string, unknown>;
    const existingSub = r.sub as Partial<SubSelector> | undefined;
    const sub: SubSelector = {
      combinedLayer: existingSub?.combinedLayer ?? (r.combinedLayer as CombinedLayerId | null | undefined) ?? null,
      vectorPlan: existingSub?.vectorPlan ?? null,
    };
    return {
      id: r.id as number,
      source: r.source as SourceId,
      sub,
      rect: r.rect as Rect,
      lonLatBounds: r.lonLatBounds as LogEntry['lonLatBounds'],
      comment: (r.comment as string | undefined) ?? '',
      savedAt: (r.savedAt as string | undefined) ?? new Date().toISOString(),
    };
  }

  private loadStitched(layerId: string): Promise<HTMLCanvasElement> {
    let existing = this.rawCache.get(layerId);
    if (existing) return existing;
    const promise = (async () => {
      const canvas = document.createElement('canvas');
      canvas.width = IMG_W;
      canvas.height = IMG_H;
      const ctx = canvas.getContext('2d')!;
      const tasks: Promise<void>[] = [];
      for (let ty = Y_MIN; ty <= Y_MAX; ty++) {
        for (let tx = X_MIN; tx <= X_MAX; tx++) {
          const url = `${this.serviceUrl}/tiles/${layerId}/${Z}/${tx}/${ty}.png`;
          const ox = (tx - X_MIN) * TILE;
          const oy = (ty - Y_MIN) * TILE;
          tasks.push(
            (async () => {
              // Drawing a cross-origin image onto a canvas taints it --
              // getImageData/putImageData then throw a SecurityError --
              // *unless* the image load itself was explicitly CORS-mode
              // (the server's Access-Control-Allow-Origin: * already
              // allows it). tintByDarkness() is the one place that reads
              // pixel data back, which is where this surfaced.
              //
              // `img.crossOrigin = 'anonymous'` is the usual fix, but it
              // wasn't enough here: these tiles are served with
              // `Cache-Control: ... immutable`, and several had already
              // been cached by an earlier, pre-fix load of this same
              // widget that fetched them WITHOUT crossOrigin set. Chromium
              // doesn't always key its HTTP cache by CORS mode, so the
              // stale no-cors cache entry can get reused for the
              // crossOrigin='anonymous' request and still read back as
              // tainted -- this is what actually produced the "No
              // Access-Control-Allow-Origin header is present" console
              // error (misleading: the live response has always carried
              // that header, confirmed with curl -- it's a cached
              // response from before the header mattered).
              //
              // Fetching the bytes ourselves and loading the image from a
              // blob: URL sidesteps the whole mode-vs-cache-entry
              // ambiguity: a blob: URL is always same-origin, so an
              // <img> loaded from one can never taint a canvas,
              // regardless of how the underlying bytes were cached.
              try {
                const res = await fetch(url, { mode: 'cors', cache: 'reload' });
                if (!res.ok) return; // leave that cell blank rather than failing the whole grid
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
                // leave that cell blank rather than failing the whole grid
              }
            })(),
          );
        }
      }
      await Promise.all(tasks);
      return canvas;
    })();
    this.rawCache.set(layerId, promise);
    return promise;
  }

  private async setCombinedLayer(layer: CombinedLayerId): Promise<void> {
    this.combinedLayer = layer;
    if (!this.combinedWhiteCache.has(layer)) {
      this.setStatus('Loading layer…');
      const raw = await this.loadStitched(layer);
      this.combinedWhiteCache.set(layer, whiteBg(raw));
      this.setStatus(null);
    }
    this.renderAll();
  }

  // ── Extracted vector layers ──

  private loadVectorPlanData(plan: VectorPlan): Promise<VectorPlanData> {
    let existing = this.vectorDataCache.get(plan);
    if (existing) return existing;
    const promise = (async (): Promise<VectorPlanData> => {
      const paths = VECTOR_PATHS[plan];
      const [contours, streams] = await Promise.all([
        this.loadGeoJsonLines(paths.contours),
        // Restored has no marked stream lines -- its Streams.geojson was
        // never written by extract_vector_layers.py at all (not just
        // empty), so a missing-file error here is expected, not a bug.
        this.loadGeoJsonLines(paths.streams).catch(() => []),
      ]);
      await Promise.all([this.loadCorrections(plan, 'contours'), this.loadCorrections(plan, 'streams')]);
      return { contours, streams };
    })();
    this.vectorDataCache.set(plan, promise);
    return promise;
  }

  private async loadGeoJsonLines(path: string): Promise<VectorFeature[]> {
    const desk = window.desk;
    if (!desk) return [];
    const { contents } = await desk.fs.readFile(path);
    const geojson = JSON.parse(contents) as { features: GeoJsonLineFeature[] };
    return geojson.features.map((f, index) => ({
      id: index,
      points: f.geometry.coordinates.map(([lon, lat]) => {
        const world = projectWorld(lon, lat, Z, TILE);
        return { x: world.x - X_MIN * TILE, y: world.y - Y_MIN * TILE };
      }),
      elevationM: f.properties.elevation_m,
      elevationSource: f.properties.elevation_source ?? null,
    }));
  }

  private async setVectorPlan(plan: VectorPlan): Promise<void> {
    this.vectorPlan = plan;
    if (!this.vectorDataByPlan.has(plan)) {
      this.setStatus('Loading vector layers…');
      const data = await this.loadVectorPlanData(plan);
      this.vectorDataByPlan.set(plan, data);
      this.setStatus(null);
    }
    this.editSelectedFeature = null;
    this.editMergeSource = null;
    this.updateEditButtons();
    this.updateEditStatus();
    this.renderAll();
  }

  // ── Manual corrections (delete / merge) ──

  private correctionsKeyFor(plan: VectorPlan, layer: VectorLayerKind): string {
    return `${plan}:${layer}`;
  }

  private getCorrections(plan: VectorPlan, layer: VectorLayerKind): CorrectionsState {
    const key = this.correctionsKeyFor(plan, layer);
    let state = this.corrections.get(key);
    if (!state) {
      state = { deletedIds: new Set(), merged: [] };
      this.corrections.set(key, state);
    }
    return state;
  }

  // The feature list actually drawn/hit-tested for a given plan+layer:
  // the base extraction output, minus anything deleted, plus anything
  // manually merged. Computed fresh rather than cached so undo (which
  // just swaps the CorrectionsState back to an earlier snapshot) can't
  // go stale against a separately-cached derived list.
  private visibleFeatures(plan: VectorPlan, layer: VectorLayerKind): VectorFeature[] {
    const base = this.vectorDataByPlan.get(plan);
    if (!base) return [];
    const baseList = layer === 'contours' ? base.contours : base.streams;
    const corr = this.getCorrections(plan, layer);
    return baseList.filter((f) => !corr.deletedIds.has(f.id)).concat(corr.merged);
  }

  private findNearestEditableFeature(p: { x: number; y: number }): { layer: VectorLayerKind; feature: VectorFeature; distance: number } | null {
    let best: { layer: VectorLayerKind; feature: VectorFeature; distance: number } | null = null;
    if (this.showVectorContours) {
      for (const f of this.visibleFeatures(this.vectorPlan, 'contours')) {
        const d = distancePointToFeature(p, f);
        if (!best || d < best.distance) best = { layer: 'contours', feature: f, distance: d };
      }
    }
    if (this.showVectorStreams) {
      for (const f of this.visibleFeatures(this.vectorPlan, 'streams')) {
        const d = distancePointToFeature(p, f);
        if (!best || d < best.distance) best = { layer: 'streams', feature: f, distance: d };
      }
    }
    return best;
  }

  private handleVectorCanvasClick(e: MouseEvent): void {
    if (!this.editVectorsActive || !this.vectorsCanvas) return;
    const p = this.clientToImagePoint(e, this.vectorsCanvas);
    const nearest = this.findNearestEditableFeature(p);
    if (!nearest || nearest.distance > EDIT_CLICK_TOLERANCE_PX) {
      this.updateEditStatus('No feature within click range — try zooming in (Zoom mode) for precision.');
      return;
    }
    const picked = { plan: this.vectorPlan, layer: nearest.layer, feature: nearest.feature };
    if (this.editMergeSource) {
      this.completeMergeWith(picked);
    } else {
      this.editSelectedFeature = picked;
      this.updateEditButtons();
      this.updateEditStatus();
      this.renderAll();
    }
  }

  private pushUndoSnapshot(plan: VectorPlan, layer: VectorLayerKind): void {
    this.undoStack.push({ plan, layer, snapshot: cloneCorrectionsState(this.getCorrections(plan, layer)) });
    if (this.undoStack.length > 30) this.undoStack.shift();
  }

  private deleteSelectedFeature(): void {
    if (!this.editSelectedFeature) return;
    const { plan, layer, feature } = this.editSelectedFeature;
    this.pushUndoSnapshot(plan, layer);
    const corr = this.getCorrections(plan, layer);
    if (feature.id >= SYNTHETIC_ID_BASE) {
      // Deleting a merged feature removes just that merged line, not its
      // two original constituents (those stay deleted too, from when the
      // merge itself ran) -- Undo right after a merge is the way back to
      // the pre-merge state, not Delete.
      corr.merged = corr.merged.filter((f) => f.id !== feature.id);
    } else {
      corr.deletedIds.add(feature.id);
    }
    this.editSelectedFeature = null;
    this.updateEditButtons();
    this.updateEditStatus();
    this.renderAll();
  }

  private startMerge(): void {
    if (!this.editSelectedFeature) return;
    this.editMergeSource = this.editSelectedFeature;
    this.editSelectedFeature = null;
    this.updateEditButtons();
    this.updateEditStatus();
  }

  private completeMergeWith(target: { plan: VectorPlan; layer: VectorLayerKind; feature: VectorFeature }): void {
    const source = this.editMergeSource;
    if (!source) return;
    if (source.layer !== target.layer) {
      this.updateEditStatus('Can only merge two features of the same layer (both contours, or both streams).');
      this.editMergeSource = null;
      this.updateEditButtons();
      this.renderAll();
      return;
    }
    if (source.feature.id === target.feature.id) {
      this.editMergeSource = null;
      this.updateEditButtons();
      this.renderAll();
      return;
    }
    this.pushUndoSnapshot(target.plan, target.layer);
    const merged = mergeVectorFeatures(source.feature, target.feature, this.nextSyntheticId++);
    const corr = this.getCorrections(target.plan, target.layer);
    for (const f of [source.feature, target.feature]) {
      if (f.id >= SYNTHETIC_ID_BASE) corr.merged = corr.merged.filter((m) => m.id !== f.id);
      else corr.deletedIds.add(f.id);
    }
    corr.merged.push(merged);
    this.editMergeSource = null;
    this.editSelectedFeature = null;
    this.updateEditButtons();
    this.updateEditStatus();
    this.renderAll();
  }

  private undoLastCorrection(): void {
    const last = this.undoStack.pop();
    if (!last) return;
    this.corrections.set(this.correctionsKeyFor(last.plan, last.layer), last.snapshot);
    this.editSelectedFeature = null;
    this.editMergeSource = null;
    this.updateEditButtons();
    this.updateEditStatus();
    this.renderAll();
  }

  private updateEditButtons(): void {
    const hasSelection = this.editSelectedFeature !== null;
    const hasMergeSource = this.editMergeSource !== null;
    if (this.editDeleteButtonEl) this.editDeleteButtonEl.disabled = !hasSelection;
    if (this.editMergeButtonEl) this.editMergeButtonEl.disabled = !hasSelection || hasMergeSource;
    if (this.editCancelButtonEl) this.editCancelButtonEl.disabled = !hasSelection && !hasMergeSource;
    if (this.editUndoButtonEl) this.editUndoButtonEl.disabled = this.undoStack.length === 0;
  }

  private updateEditStatus(message?: string): void {
    if (!this.editStatusEl) return;
    if (message) {
      this.editStatusEl.textContent = message;
      return;
    }
    if (!this.editVectorsActive) {
      this.editStatusEl.textContent = '';
      return;
    }
    if (this.editMergeSource) {
      this.editStatusEl.textContent = `Merge pending (${this.editMergeSource.layer} #${this.editMergeSource.feature.id}) — click the feature to merge it with.`;
      return;
    }
    if (this.editSelectedFeature) {
      const f = this.editSelectedFeature.feature;
      const elev = f.elevationM !== null ? `${f.elevationM}m (${f.elevationSource ?? 'unknown'})` : 'unlabeled';
      this.editStatusEl.textContent = `Selected: ${this.editSelectedFeature.layer} #${f.id}, ${f.points.length} pts, ${elev}.`;
      return;
    }
    this.editStatusEl.textContent = 'Edit mode on — click a line to select it.';
  }

  // Loads a previously-saved corrections file for one plan+layer, if any
  // -- a missing file (the common case: no corrections made yet) is not
  // an error, just nothing to load.
  private async loadCorrections(plan: VectorPlan, layer: VectorLayerKind): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const path = this.correctionsPathFor(plan, layer);
    try {
      const { contents } = await desk.fs.readFile(path);
      const parsed = JSON.parse(contents) as {
        deletedIds: number[];
        merges: Array<{ id: number; coordinates: [number, number][]; elevation_m: number | null }>;
      };
      const state: CorrectionsState = {
        deletedIds: new Set(parsed.deletedIds),
        merged: parsed.merges.map((m) => ({
          id: m.id,
          points: m.coordinates.map(([lon, lat]) => {
            const world = projectWorld(lon, lat, Z, TILE);
            return { x: world.x - X_MIN * TILE, y: world.y - Y_MIN * TILE };
          }),
          elevationM: m.elevation_m,
          elevationSource: null, // not persisted in corrections.json today -- a saved merge always renders as "unlabeled" shade after reload
        })),
      };
      this.corrections.set(this.correctionsKeyFor(plan, layer), state);
      this.nextSyntheticId = Math.max(this.nextSyntheticId, SYNTHETIC_ID_BASE, ...parsed.merges.map((m) => m.id + 1));
    } catch {
      // no corrections file yet for this plan+layer -- fine
    }
  }

  private correctionsPathFor(plan: VectorPlan, layer: VectorLayerKind): string {
    const planLabel = plan === 'actual' ? 'ActualStatePlan' : 'RestoredStatePlan';
    const layerLabel = layer === 'contours' ? 'Contours' : 'Streams';
    // Deliberately a SEPARATE file from extract_vector_layers.py's own
    // *.geojson output (never edited in place) -- see the corrections
    // -related comment above CorrectionsState for why.
    return `Data/mapFeatures/SamoWeb_${planLabel}_${layerLabel}.corrections.json`;
  }

  private async saveCorrections(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    this.setStatus('Saving corrections…');
    try {
      const plans: VectorPlan[] = ['actual', 'restored'];
      const layers: VectorLayerKind[] = ['contours', 'streams'];
      for (const plan of plans) {
        for (const layer of layers) {
          const corr = this.corrections.get(this.correctionsKeyFor(plan, layer));
          if (!corr || (corr.deletedIds.size === 0 && corr.merged.length === 0)) continue;
          const base = this.vectorDataByPlan.get(plan);
          const baseCount = base ? (layer === 'contours' ? base.contours.length : base.streams.length) : 0;
          const payload = {
            baseFeatureCount: baseCount,
            deletedIds: Array.from(corr.deletedIds).sort((a, b) => a - b),
            merges: corr.merged.map((f) => ({
              id: f.id,
              coordinates: f.points.map((p) => {
                const world = unprojectWorld(X_MIN * TILE + p.x, Y_MIN * TILE + p.y, Z, TILE);
                return [world.lon, world.lat];
              }),
              elevation_m: f.elevationM,
            })),
            updatedAt: new Date().toISOString(),
          };
          await desk.fs.writeFile(this.correctionsPathFor(plan, layer), JSON.stringify(payload, null, 2));
        }
      }
      this.setStatus(null);
      this.updateEditStatus('Corrections saved.');
    } catch (err) {
      this.setStatus(`Failed to save corrections: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Selection (drag-to-draw-rectangle) ──

  private attachSelection(canvas: HTMLCanvasElement | null, source: SourceId, subSelectorGetter: () => SubSelector, dragEnabled?: () => boolean): void {
    if (!canvas) return;

    canvas.addEventListener('pointerdown', (e) => {
      if (dragEnabled && !dragEnabled()) return;
      canvas.setPointerCapture(e.pointerId);
      const p = this.clientToImagePoint(e, canvas);
      this.dragState = { source, sub: subSelectorGetter(), startX: p.x, startY: p.y, curX: p.x, curY: p.y };
      this.renderAll();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragState || this.dragState.source !== source) return;
      const p = this.clientToImagePoint(e, canvas);
      this.dragState.curX = p.x;
      this.dragState.curY = p.y;
      this.renderAll();
    });
    canvas.addEventListener('pointerup', (e) => {
      canvas.releasePointerCapture(e.pointerId);
      const drag = this.dragState;
      this.dragState = null;
      if (!drag || drag.source !== source) return;
      const rect = normalizeRect(drag.startX, drag.startY, drag.curX, drag.curY);

      if (this.mode === 'zoom') {
        if (rect.width > 4 && rect.height > 4) {
          this.viewRect = clampViewRect(rect);
          this.updateZoomReadout();
        }
        this.renderAll();
        return;
      }

      if (rect.width > 4 && rect.height > 4) {
        this.pending = { source, sub: drag.sub, rect };
        this.openComposer();
      } else {
        this.renderAll();
      }
    });
  }

  // Maps a pointer event to a point in FULL-image space (0..IMG_W,
  // 0..IMG_H) -- the one coordinate system every stored rect (saved
  // entries, pending selection, drag-in-progress) is always expressed
  // in, regardless of the current zoom level. First maps client coords
  // to raw canvas-buffer pixels (0..IMG_W, since every canvas's backing
  // store is always IMG_W x IMG_H even while zoomed in), then maps that
  // through the current viewRect back out to full-image space -- the
  // exact inverse of the source-rect drawImage() call drawPanel() uses
  // to render the zoomed view in the first place.
  private clientToImagePoint(e: { clientX: number; clientY: number }, canvas: HTMLCanvasElement): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const canvasX = clamp(((e.clientX - rect.left) / rect.width) * IMG_W, 0, IMG_W);
    const canvasY = clamp(((e.clientY - rect.top) / rect.height) * IMG_H, 0, IMG_H);
    const x = this.viewRect.x + (canvasX / IMG_W) * this.viewRect.width;
    const y = this.viewRect.y + (canvasY / IMG_H) * this.viewRect.height;
    return { x, y };
  }

  // Inverse of the above, for drawing: converts a FULL-image-space point
  // (a saved entry's corner, a GeoJSON vector vertex, ...) into raw
  // canvas-buffer pixel coordinates under the current viewRect, so it
  // lands in the right place on top of the zoomed-in image drawPanel()
  // just drew.
  private imagePointToCanvasPoint(x: number, y: number): { x: number; y: number } {
    const scaleX = IMG_W / this.viewRect.width;
    const scaleY = IMG_H / this.viewRect.height;
    return { x: (x - this.viewRect.x) * scaleX, y: (y - this.viewRect.y) * scaleY };
  }

  private imageRectToCanvasRect(rect: Rect): Rect {
    const topLeft = this.imagePointToCanvasPoint(rect.x, rect.y);
    const scaleX = IMG_W / this.viewRect.width;
    const scaleY = IMG_H / this.viewRect.height;
    return { x: topLeft.x, y: topLeft.y, width: rect.width * scaleX, height: rect.height * scaleY };
  }

  // ── Mode / zoom ──

  private setMode(mode: PickMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.updateModeButtons();
  }

  private updateModeButtons(): void {
    this.modeCommentButtonEl?.classList.toggle('active', this.mode === 'comment');
    this.modeZoomButtonEl?.classList.toggle('active', this.mode === 'zoom');
  }

  private resetZoom(): void {
    this.viewRect = fullExtentRect();
    this.updateZoomReadout();
    this.renderAll();
  }

  private updateZoomReadout(): void {
    if (!this.zoomReadoutEl) return;
    const full = this.viewRect.width >= IMG_W && this.viewRect.height >= IMG_H;
    if (full) {
      this.zoomReadoutEl.textContent = 'Showing full extent';
    } else {
      const pctW = Math.round((this.viewRect.width / IMG_W) * 100);
      const pctH = Math.round((this.viewRect.height / IMG_H) * 100);
      this.zoomReadoutEl.textContent = `Zoomed to ${Math.round(this.viewRect.width)}×${Math.round(this.viewRect.height)} px (${pctW}%×${pctH}% of full extent)`;
    }
  }

  // ── Composer ──

  private openComposer(): void {
    if (!this.pending || !this.pendingLabelEl) return;
    const { source, sub, rect } = this.pending;
    const label = SOURCE_LABELS[source] + subSelectorLabelSuffix(sub);
    this.pendingLabelEl.textContent = `${label} — x:${Math.round(rect.x)} y:${Math.round(rect.y)} w:${Math.round(rect.width)} h:${Math.round(rect.height)}`;
    if (this.saveButtonEl) this.saveButtonEl.disabled = false;
    if (this.commentEl) {
      this.commentEl.value = '';
      this.commentEl.focus();
    }
    this.renderAll();
  }

  private clearPending(): void {
    this.pending = null;
    if (this.pendingLabelEl) this.pendingLabelEl.textContent = 'No selection — drag a rectangle on any image above.';
    if (this.saveButtonEl) this.saveButtonEl.disabled = true;
    if (this.commentEl) this.commentEl.value = '';
    this.renderAll();
  }

  private async saveComment(): Promise<void> {
    if (!this.pending) return;
    const { source, sub, rect } = this.pending;
    const topLeft = unprojectWorld(X_MIN * TILE + rect.x, Y_MIN * TILE + rect.y, Z, TILE);
    const bottomRight = unprojectWorld(X_MIN * TILE + rect.x + rect.width, Y_MIN * TILE + rect.y + rect.height, Z, TILE);
    const entry: LogEntry = {
      id: this.nextId++,
      source,
      sub,
      rect,
      lonLatBounds: { west: topLeft.lon, north: topLeft.lat, east: bottomRight.lon, south: bottomRight.lat },
      comment: this.commentEl?.value ?? '',
      savedAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.pending = null;
    this.clearPending();
    this.renderLogList();
    await this.persist();
  }

  private async deleteEntry(id: number): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.renderAll();
    this.renderLogList();
    await this.persist();
  }

  private async clearAll(): Promise<void> {
    if (this.entries.length === 0) return;
    const desk = window.desk;
    const answer = desk ? await desk.popups.show('Clear selection log', `Delete all ${this.entries.length} saved selection(s)? This can't be undone.`, ['Cancel', 'Clear all'], 'Cancel') : 'Clear all';
    if (answer !== 'Clear all') return;
    this.entries = [];
    this.renderAll();
    this.renderLogList();
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.persistLocalState();
    await this.writeLogFile();
  }

  private async persistLocalState(): Promise<void> {
    await window.desk?.self.setLocalStorage({
      entries: this.entries,
      nextId: this.nextId,
      collapsedSections: Array.from(this.collapsedSections),
    });
  }

  private async writeLogFile(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    const payload = {
      tileGrid: { z: Z, xMin: X_MIN, xMax: X_MAX, yMin: Y_MIN, yMax: Y_MAX, tileSize: TILE, imageWidth: IMG_W, imageHeight: IMG_H },
      entries: this.entries,
    };
    try {
      await desk.fs.writeFile(LOG_PATH, JSON.stringify(payload, null, 2));
    } catch (err) {
      this.setStatus(`Failed to write log file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Log list ──

  private colorForId(id: number): string {
    return ENTRY_COLORS[(id - 1) % ENTRY_COLORS.length]!;
  }

  private renderLogList(): void {
    if (!this.logListEl) return;
    if (this.entries.length === 0) {
      this.logListEl.innerHTML = '<div class="log-empty">No selections saved yet.</div>';
      return;
    }
    const rows = [...this.entries]
      .reverse()
      .map((entry) => {
        const label = SOURCE_LABELS[entry.source] + subSelectorLabelSuffix(entry.sub);
        return `<div class="log-entry" data-id="${entry.id}">
          <div class="swatch" style="background:${this.colorForId(entry.id)}"></div>
          <div class="entry-body">
            <div class="entry-meta">#${entry.id} · ${escapeHtml(label)}</div>
            <div class="entry-comment">${escapeHtml(entry.comment) || '<em>(no comment)</em>'}</div>
          </div>
          <button type="button" class="delete-btn" title="Delete">×</button>
        </div>`;
      });
    this.logListEl.innerHTML = rows.join('');
    this.logListEl.querySelectorAll('.log-entry').forEach((el) => {
      const idAttr = (el as HTMLElement).dataset.id;
      const id = idAttr ? Number(idAttr) : null;
      if (id === null) return;
      el.addEventListener('mouseenter', () => {
        this.hoveredEntryId = id;
        this.renderAll();
      });
      el.addEventListener('mouseleave', () => {
        this.hoveredEntryId = null;
        this.renderAll();
      });
      el.querySelector('.delete-btn')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void this.deleteEntry(id);
      });
    });
  }

  // ── Rendering ──

  private renderAll(): void {
    const none: SubSelector = { combinedLayer: null, vectorPlan: null };
    this.drawPanel(this.actualCanvas, this.actualWhite, 'actual', none);
    this.drawPanel(this.restoredCanvas, this.restoredWhite, 'restored', none);
    this.drawPanel(this.overlayCanvas, this.overlayComposited, 'overlay', none);
    this.drawPanel(this.combinedCanvas, this.combinedWhiteCache.get(this.combinedLayer) ?? null, 'combined', {
      combinedLayer: this.combinedLayer,
      vectorPlan: null,
    });
    this.drawVectorPanel();
  }

  private drawPanel(canvas: HTMLCanvasElement | null, base: HTMLCanvasElement | null, source: SourceId, sub: SubSelector): void {
    if (!canvas || !base) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, IMG_W, IMG_H);
    // Draw only the current viewRect crop of the full stitched image,
    // scaled up to fill the canvas -- this is what "zoom" means here;
    // every panel uses the same viewRect, so they stay in lockstep.
    const v = this.viewRect;
    ctx.drawImage(base, v.x, v.y, v.width, v.height, 0, 0, IMG_W, IMG_H);

    this.drawSelectionOverlays(ctx, source, sub);
  }

  private drawVectorPanel(): void {
    const canvas = this.vectorsCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, IMG_W, IMG_H);

    const backdrop = this.vectorPlan === 'actual' ? this.actualWhite : this.restoredWhite;
    const v = this.viewRect;
    if (backdrop) {
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.drawImage(backdrop, v.x, v.y, v.width, v.height, 0, 0, IMG_W, IMG_H);
      ctx.restore();
    }

    if (this.vectorDataByPlan.has(this.vectorPlan)) {
      const contours = this.visibleFeatures(this.vectorPlan, 'contours');
      const streams = this.visibleFeatures(this.vectorPlan, 'streams');
      if (this.showVectorStreams) {
        for (const feat of streams) this.drawVectorLine(ctx, feat, '#0ea5e9', 2);
      }
      if (this.showVectorContours) {
        for (const feat of contours) {
          const major = feat.elevationSource === 'ocr' || feat.elevationSource === 'review-confirmed';
          this.drawVectorLine(ctx, feat, contourColorFor(feat), major ? 1.8 : 1);
        }
        // Labels drawn in a second pass so they're never occluded by a
        // later-drawn line.
        for (const feat of contours) {
          if (feat.elevationM !== null) this.drawElevationLabel(ctx, feat);
        }
      }
    }

    // Edit-mode highlights: the merge-pending source feature (cyan) and
    // the currently-selected feature (white), drawn last so neither is
    // ever hidden under an unrelated line.
    if (this.editMergeSource && this.editMergeSource.plan === this.vectorPlan) {
      this.drawVectorLine(ctx, this.editMergeSource.feature, '#38bdf8', 3.5);
    }
    if (this.editSelectedFeature && this.editSelectedFeature.plan === this.vectorPlan) {
      this.drawVectorLine(ctx, this.editSelectedFeature.feature, '#ffffff', 3.5);
    }

    this.drawSelectionOverlays(ctx, 'vectors', { combinedLayer: null, vectorPlan: this.vectorPlan });
  }

  private drawVectorLine(ctx: CanvasRenderingContext2D, feat: VectorFeature, color: string, lineWidth: number): void {
    if (feat.points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    feat.points.forEach((p, i) => {
      const cp = this.imagePointToCanvasPoint(p.x, p.y);
      if (i === 0) ctx.moveTo(cp.x, cp.y);
      else ctx.lineTo(cp.x, cp.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  private drawElevationLabel(ctx: CanvasRenderingContext2D, feat: VectorFeature): void {
    const p = feat.points[0];
    if (!p || feat.elevationM === null) return;
    const cp = this.imagePointToCanvasPoint(p.x, p.y);
    ctx.save();
    ctx.font = '10px monospace';
    ctx.fillStyle = contourColorFor(feat);
    const suffix = feat.elevationSource === 'interpolated' ? 'm~' : 'm'; // '~' flags a best-guess interpolated minor, not a read label
    ctx.fillText(`${feat.elevationM}${suffix}`, cp.x + 3, cp.y - 3);
    ctx.restore();
  }

  // Saved-entry markers, the pending selection outline, and the live
  // drag box -- the part every panel (raster or vector) draws on top of
  // its own content, in canvas-buffer coordinates under the current
  // viewRect. Shared so drawPanel and drawVectorPanel stay in sync
  // instead of maintaining two copies of this logic.
  private drawSelectionOverlays(ctx: CanvasRenderingContext2D, source: SourceId, sub: SubSelector): void {
    for (const entry of this.entries) {
      const bold = entry.id === this.hoveredEntryId;
      this.drawRect(ctx, this.imageRectToCanvasRect(entry.rect), this.colorForId(entry.id), bold ? 3.5 : 1.5, String(entry.id), false);
    }

    if (this.pending && this.pending.source === source && subSelectorsEqual(this.pending.sub, sub)) {
      this.drawRect(ctx, this.imageRectToCanvasRect(this.pending.rect), '#ffffff', 2, null, true);
    }
    if (this.dragState && this.dragState.source === source && subSelectorsEqual(this.dragState.sub, sub)) {
      const rect = normalizeRect(this.dragState.startX, this.dragState.startY, this.dragState.curX, this.dragState.curY);
      const dashColor = this.mode === 'zoom' ? '#38bdf8' : '#ffffff';
      this.drawRect(ctx, this.imageRectToCanvasRect(rect), dashColor, 2, null, true);
    }
  }

  private drawRect(ctx: CanvasRenderingContext2D, rect: Rect, color: string, lineWidth: number, label: string | null, dashed: boolean): void {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dashed ? [8, 5] : []);
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width, rect.height);
    if (label) {
      ctx.setLineDash([]);
      ctx.font = 'bold 15px monospace';
      const padding = 3;
      const textWidth = ctx.measureText(label).width;
      const boxY = Math.max(0, rect.y - 18);
      ctx.fillStyle = color;
      ctx.fillRect(rect.x, boxY, textWidth + padding * 2, 18);
      ctx.fillStyle = '#10151c';
      ctx.fillText(label, rect.x + padding, boxY + 14);
    }
    ctx.restore();
  }
}

customElements.define('topo-compare', TopoCompareElement);
