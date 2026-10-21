// Layered Map -- a minimal, chrome-free map viewport: just the canvas,
// its zoom control/monitor, and a hover label. No layer panel, no
// toolbar, no recording/annotation subsystem -- deliberately a subset
// of desk_widgets/samothrace-map/ and desk_widgets/natural-earth-map/,
// taking only "the area inside the map area" from each.
//
// What makes this widget different from either of those: it draws
// layers from THREE hmsvcs at once -- `natural-earth-map` (vector
// GeoJSON), `samothrace-tiles` (raster tiles), and `samothrace-vectors`
// (vector GeoJSON, added 2026-10-20 -- Extracted Contours/Restored
// State -- Waterway/Restored State Plan structures, previously only
// readable by Samothrace Map itself straight off disk, see
// desk_hmsvc/samothrace-vectors/service.py's own header comment for the
// full story) -- interleaved in a single z-order, and that z-order is
// not a local per-instance setting.
// 2026-10-21 -- `samothrace-tiles`' own raster layers (everything
// except the two pipeline-topographic debug ones) now actually come
// from a FOURTH hmsvc, `samothrace-tiles-static` (pre-baked/passthrough
// static files, no live PIL compute -- see
// desk_hmsvc/samothrace-tiles-static/service.py's own header comment),
// merged into the same logical `samothrace-tiles` catalog this widget
// already had. `samothrace-tiles`' own /layers response is left fully
// intact (samothrace-map's own panel depends on it) and genuinely
// overlaps samothrace-tiles-static's on 7 of 9 ids -- the merge runs
// samothrace-tiles THEN samothrace-tiles-static, never concurrently
// with each other, so the static origin deterministically wins on any
// overlapping id instead of that being a timing-dependent race. Each
// RasterLayerMeta entry carries forward the short service NAME (not a
// resolved URL, see that interface's own comment) of whichever origin
// actually won.
// 2026-10-21, second pass -- tile-image URLs no longer come from a
// plain string template at all: `sharedPlatform.resolveTileUrl`
// resolves each tile through that service's own version/override
// manifest (so a correction or re-bake never has to change the bytes
// at an already-published, long-cached tile URL). drawRasterLayer/
// getTile never construct a `/tiles/...` path themselves anymore.
// It's read from the shared state key
// `samothrace.mapLayerStack` (see STACK_STATE_KEY below), written by
// the companion `desk_widgets/layer-stack/` widget's own drag-and-drop
// UI. This widget never writes that key, only reads it (once at
// startup, and live via the shared platform's own change notifications
// -- see `desk_widgets/_shared/platform.ts`) -- see
// desk_domains/cartography/natural-earth-and-openstreetmap.md's own
// "Cross-widget navigation" section for why a durable, read-on-startup
// value like this belongs in durable shared state rather than a
// fire-and-forget broadcast.
//
// Web Mercator projection formulas, pan/zoom mechanics, and the
// RetryingLoader startup-race fix are kept byte-for-byte parallel to
// samothrace-map.ts/natural-earth-map.ts (see those files' own header
// comments for the same note) -- not imported, duplicated by this
// project's own established convention.

// This project's bundled `tsc` (3.8.3) predates the DOM lib's
// ResizeObserver typings, even though real browsers have long
// supported it -- same gap samothrace-map.ts's own declaration works
// around.
declare class ResizeObserver {
  constructor(callback: () => void);
  observe(target: Element): void;
  disconnect(): void;
}

// ── Constants ──
//
// Service URLs are resolved through the shared platform module (see
// `desk_widgets/_shared/platform.ts`) by plain service name -- no
// host-specific key format is known here at all.

const NE_SERVICE_NAME = 'natural-earth-map';
const TILES_SERVICE_NAME = 'samothrace-tiles';
const TILES_STATIC_SERVICE_NAME = 'samothrace-tiles-static';
const VECTORS_SERVICE_NAME = 'samothrace-vectors';

// The shared layer-stack contract -- see desk_widgets/layer-stack/
// layer-stack.ts's own header comment for the writer's half of this.
// Value shape: `string[]`, each entry `"<source>|<id>"` (see
// makeLayerKey/parseLayerKey below), ordered CLOSEST-TO-THE-VIEWER
// FIRST (index 0 = top of the layer-stack widget's own visual stack =
// drawn last/on top here). A flat string array (not an array of
// richer objects) is deliberate -- it's unambiguously within the
// shared platform's own documented validated-schema subset ("arrays
// (`string[]`, ...)"), where an array-of-object-shape's own support is
// untested and not worth risking a widget that fails to load at all
// over.
const STACK_STATE_KEY = 'samothrace.mapLayerStack';

const TILE_SIZE = 256; // world-pixel-at-zoom unit, shared by both hmsvcs' own data (confirmed: both use 256).
const GLOBAL_MIN_ZOOM = 2; // natural-earth-map's own vector data has no real tiling scheme, so this is just "zoomed out enough to see the region."
const GLOBAL_MAX_ZOOM = 22; // matches samothrace-tiles' own MAX_ZOOM -- the tightest real raster detail either source has.

type MapSource = 'natural-earth-map' | 'samothrace-tiles' | 'samothrace-vectors';
// natural-earth-map and samothrace-vectors are both "vector" sources in
// the sense that matters to this widget (fetch a whole GeoJSON
// FeatureCollection per layer, render via VectorLayerMeta's own style
// fields) -- checked with `!== 'samothrace-tiles'` in a few places below
// rather than listing both literals out, so a future fourth vector
// source needs no extra branching.

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

// Byte-for-byte the same ordered id list as
// desk_widgets/layer-stack/layer-stack.ts's own DEFAULT_STACK --
// duplicated per this project's established convention (same as
// makeLayerKey/parseLayerKey above), not read from shared state, so
// this widget shows the matching arrangement even though it never
// writes STACK_STATE_KEY itself. See that file's own DEFAULT_STACK
// comment for the full "why" and the "applies only when nothing has
// ever been saved" rule this follows identically.
const DEFAULT_STACK: string[] = [
  makeLayerKey('samothrace-vectors', 'regio_1'),
  makeLayerKey('samothrace-vectors', 'restored_waterway'),
  makeLayerKey('samothrace-tiles', 'aerial'),
  makeLayerKey('natural-earth-map', 'osm_island_names'),
  makeLayerKey('natural-earth-map', 'ne_10m_rivers_lake_centerlines'),
  makeLayerKey('natural-earth-map', 'ne_10m_geography_marine_polys'),
  makeLayerKey('natural-earth-map', 'ne_10m_land'),
];

interface LonLatBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

type RenderKind = 'fill-stroke' | 'stroke' | 'dot-label' | 'centroid-label';

// natural-earth-map hmsvc's own LayerMeta shape (vector) -- see that
// widget's own natural-earth-map.ts for the authoritative copy of this
// interface; kept in sync by hand, same duplication convention as the
// projection math.
interface VectorLayerMeta {
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
  extraField?: string;
  extraLabel?: string;
  // Only meaningful for `render: 'stroke'` -- a dashed line instead of
  // solid, consulted by drawVectorLayer below. Added 2026-10-20 for
  // restored_waterway_bridges (see scripts/build_samothrace_vectors.py's
  // own header comment on why a bridge is represented as a thin dashed
  // connector rather than merged into the Waterway fill the way the
  // raster view does it).
  dashed?: boolean;
  featureCount: number;
}

// samothrace-tiles hmsvc's own LayerMeta shape (raster) -- much
// thinner, see desk_hmsvc/samothrace-tiles/service.py's own `LAYERS`.
interface RasterLayerMeta {
  id: string;
  label: string;
  group: string;
  order: number;
  defaultVisible: boolean;
  // Real lon/lat extent of this raster layer's own source tile set, if
  // known (2026-10-19, see desk_hmsvc/samothrace-tiles/service.py's own
  // BOUNDS_SOURCE_DIR comment) -- `null`/absent for a layer with no
  // real site of its own ("blank") or no tilemapresource.xml on disk
  // yet ("initial-map"). Used by updateRecenterTarget/
  // shouldShowMarkerInstead below; never required for drawing (a raster
  // layer draws fine with no known bounds, it's just unable to tell the
  // user where to find it if the current view doesn't happen to already
  // show it, and can never get a marker of its own either).
  bounds?: LonLatBounds | null;
  // Assigned client-side, NOT part of the hmsvc's own /layers response
  // -- see rasterColorForGroup's own comment for why (samothrace-tiles'
  // raster layers have no per-layer color of their own the way
  // natural-earth-map's vector layers do).
  color: string;
  // Also assigned client-side (2026-10-21), from whichever of
  // samothrace-tiles/samothrace-tiles-static's own /layers response this
  // entry actually came from -- see this file's own header comment on
  // the two-hmsvc split. A short name, NOT a resolved URL (2026-10-21,
  // second pass) -- tile-image URLs now go entirely through
  // `sharedPlatform.resolveTileUrl`, which takes a service name itself;
  // this widget must never hold or construct a tile URL on its own.
  service: TileServiceName;
}

// A per-group fallback color for samothrace-tiles' own raster layers --
// same values as desk_widgets/layer-stack/layer-stack.ts's own copy
// (duplicated per this project's established convention), used here to
// color a too-small-to-render layer's own marker (drawLayerMarker)
// consistently with how that layer's own chip looks in the Layer Stack
// widget.
const RASTER_GROUP_COLORS: Record<string, string> = {
  imagery: '#8ab4f8',
  restored: '#f2b134',
  'pipeline-topographic': '#9aa5b5',
};
const RASTER_DEFAULT_COLOR = '#5fd4a0';

function rasterColorForGroup(group: string): string {
  return RASTER_GROUP_COLORS[group] ?? RASTER_DEFAULT_COLOR;
}

// ── Attribution: which currently-visible layers come from a
// third-party source that asks for (or just warrants) credit. See
// desk_domains/cartography/natural-earth-and-openstreetmap.md's own
// "Licensing" sections for the full reasoning behind the
// natural-earth/openstreetmap URLs: Natural Earth is public domain but
// credited anyway (its own terms-of-use page says as much);
// OpenStreetMap's ODbL is a real license term, and
// openstreetmap.org/copyright is the same page this project's own
// Data/OpenStreetMap-geocoding/README.md already cites for that.
//
// samothrace-tiles and samothrace-vectors are NOT this project's own
// original content -- this whole project is a fork of
// https://github.com/jagingrich/samo_website (American Excavations:
// Samothrace's own "Interactive Map: Sanctuary of the Great Gods,
// Samothrace" web map; see root README.md's own "Forked from..."
// section), and both of those sources' underlying data
// (Data/mapTiles/, Data/mapFeatures/) came from that fork, carried
// over at import time -- see Data/mapTiles/README.md and
// Data/mapDescriptions/README.md for the fuller provenance writeup.
// samothrace-vectors is a derived product of that same forked data
// (vectorized/split, never redrawn from scratch -- see
// scripts/build_samothrace_vectors.py's own header comment), so it's
// credited identically rather than treated as this project's own. ──
interface SourceInfo {
  name: string;
  url: string;
}

const SOURCE_INFO: Record<string, SourceInfo> = {
  'natural-earth': { name: 'Natural Earth', url: 'https://www.naturalearthdata.com/about/terms-of-use/' },
  openstreetmap: { name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' },
  'samo-website': { name: 'American Excavations: Samothrace', url: 'https://github.com/jagingrich/samo_website' },
};

// natural-earth-map's own hmsvc merges two data directories with two
// different real licenses into one layer catalog (see that hmsvc's own
// service.py header comment) -- the single layer id
// `osm_island_names` is the only one sourced from
// Data/OpenStreetMap-geocoding/ rather than Data/naturalEarth/,
// confirmed directly against scripts/clip_natural_earth.py's own
// DATASETS list vs fetch_island_names.py's own output filename.
// Every samothrace-tiles/samothrace-vectors layer, regardless of id,
// traces back to the forked samo_website repo (see this function's own
// header comment above) -- there's no project-original map layer left
// to carve out an exception for.
function sourceKeyForLayer(ref: { source: MapSource; id: string }): string | null {
  if (ref.source === 'natural-earth-map') {
    return ref.id === 'osm_island_names' ? 'openstreetmap' : 'natural-earth';
  }
  return 'samo-website';
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

interface TileEntry {
  img: HTMLImageElement;
  status: 'loading' | 'loaded' | 'error';
}

interface HoverInfo {
  layerLabel: string;
  name: string | null;
  extra: string | null;
}

// ── Web Mercator tile math (EPSG:3857) -- byte-for-byte the same
// formulas as samothrace-map.ts/natural-earth-map.ts's own
// projectWorld/unprojectWorld. ──

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

// ── Geometry helpers -- identical to natural-earth-map.ts's own copies
// (generic over every GeoJSON type the vector data actually uses). ──

function isCoordPair(x: unknown): x is [number, number] {
  return Array.isArray(x) && x.length >= 2 && typeof x[0] === 'number' && typeof x[1] === 'number';
}

function flattenCoords(coords: unknown): [number, number][] {
  if (isCoordPair(coords)) return [coords];
  if (Array.isArray(coords)) return (coords as unknown[]).flatMap(flattenCoords);
  return [];
}

function polygonRings(geometry: { type: string; coordinates: unknown }): [number, number][][] {
  if (geometry.type === 'Polygon') {
    return (geometry.coordinates as unknown[]).map((ring) => flattenCoords(ring));
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as unknown[]).flatMap((poly) => (poly as unknown[]).map((ring) => flattenCoords(ring)));
  }
  return [];
}

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

function geometryCenterLonLat(geometry: { type: string; coordinates: unknown }): { lon: number; lat: number } | null {
  const b = geometryBounds(geometry);
  if (!b) return null;
  return { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 };
}

// Plain bbox overlap (not exact-geometry intersection) -- good enough
// for "is this raster layer's known extent anywhere near the current
// viewport," which is itself always a rectangle.
function boundsIntersect(a: LonLatBounds, b: LonLatBounds): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

// ── Hit-testing, all in plain CSS-pixel screen space -- same as
// natural-earth-map.ts's own copies. ──

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

// ── Startup load retry -- see RetryingLoader's own copy in
// samothrace-map.ts/natural-earth-map.ts/gazetteer.ts for the full
// "why" (byte-for-byte the same class, duplicated per this project's
// own established convention). This widget depends on TWO separate
// hmsvcs instead of one -- attemptLoad() below waits on both before
// succeeding, so a single retry schedule still covers "either one
// isn't up yet." ──
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

class LayeredMapElement extends HTMLElement {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private hoverBarEl: HTMLElement | null = null;
  private zoomLabelEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private emptyMessageEl: HTMLElement | null = null;
  private recenterBannerEl: HTMLElement | null = null;
  private recenterTextEl: HTMLElement | null = null;
  private sourcesPanelEl: HTMLElement | null = null;
  // Compared against on every updateSourcesPanel() call so a redraw
  // with an unchanged stack never touches the DOM -- same "don't
  // innerHTML-replace every single frame" discipline the rest of this
  // widget's own overlays already follow.
  private lastSourcesPanelHtml: string | null = null;
  private loader: RetryingLoader | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private neServiceUrl: string | null = null;
  private vectorsServiceUrl: string | null = null;
  private tilesMinZoom = 17;
  private tilesMaxZoom = 22;

  private neCatalog = new Map<string, VectorLayerMeta>();
  private vectorsCatalog = new Map<string, VectorLayerMeta>();
  private tilesCatalog = new Map<string, RasterLayerMeta>();
  // Vector feature data from EITHER vector source, keyed by plain layer
  // id -- not source-qualified, since natural-earth-map's and
  // samothrace-vectors' own id namespaces are disjoint today (confirmed
  // directly: "ne_10m_*"/"osm_*" vs "extracted_contours_*"/
  // "restored_*") and a shared cache keeps loadVectorFeaturesFrom/
  // drawVectorLayer/hitTest simple -- a real collision would need
  // revisiting this, same caveat natural-earth-map's own hmsvc already
  // notes for ITS OWN multi-directory id merge.
  private featureCache = new Map<string, GeoJsonFeature[]>();
  private tileCache = new Map<string, TileEntry>(); // keyed by full tile URL
  // One layer of indirection in front of tileCache above -- resolving a
  // tile's actual URL through `sharedPlatform.resolveTileUrl` is itself
  // async (a manifest fetch, possibly), so this caches that resolution
  // the same way tileCache caches the subsequent image load: a pending
  // resolution schedules a redraw on completion rather than blocking
  // the current frame. Keyed `${service}|${layerId}|${zoom}|${tx}|${ty}`.
  // Not proactively invalidated on a manifest version bump (see
  // this file's own header comment) -- only onServiceUrlChanged
  // (a service restart) clears it, same as tileCache.
  private resolvedTileUrlCache = new Map<string, { status: 'resolving' | 'resolved' | 'error'; url?: string }>();

  // The shared layer stack, closest-to-the-viewer first -- read from
  // STACK_STATE_KEY at startup and on every shared-value change
  // notification for that key. Deliberately NOT filtered down to "only entries whose
  // catalog lookup currently succeeds" at read time -- see
  // sanitizeStack's own comment for why a too-early filter would be
  // actively wrong here.
  private stack: { source: MapSource; id: string }[] = [];

  private view = { lon: 25.5333, lat: 40.4833, zoom: 7 };
  private minZoom = GLOBAL_MIN_ZOOM;
  private maxZoom = GLOBAL_MAX_ZOOM;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private dpr = 1;

  private dragState: { startClientX: number; startClientY: number; startLon: number; startLat: number; moved: boolean } | null = null;
  private lastWheelAt = 0;
  private hover: HoverInfo | null = null;
  private hoverScreenPoint: { x: number; y: number } | null = null;
  private redrawScheduled = false;
  private saveUiStateTimer: number | null = null;

  // Set by updateRecenterTarget (called at the end of every redraw) --
  // the topmost raster layer currently on the stack whose own known
  // real-world bounds (see RasterLayerMeta.bounds's own comment) say it
  // ISN'T actually visible right now, either because the current zoom
  // is outside this hmsvc's own tile range or the view has panned
  // somewhere its bounds don't reach. `null` whenever that's not the
  // case (nothing on the stack, nothing with known bounds, or the
  // topmost such layer IS currently visible) -- see
  // desk_hmsvc/samothrace-tiles/service.py's own BOUNDS_SOURCE_DIR
  // comment for the 2026-10-19 incident this exists to fix: a user
  // added "Aerial Imagery" to the stack while viewing the whole Aegean
  // at zoom 11 and had no way to tell it was both zoomed too far out
  // AND panned away from the tiny (~300m) real site, since the data
  // itself (confirmed directly against tilemapresource.xml) was
  // perfectly correct the whole time.
  private recenterTarget: { label: string; bounds: LonLatBounds } | null = null;

  // Rebuilt every redraw() -- the on-screen position/radius/bounds/label
  // of every marker actually drawn this frame (see drawLayerMarker's own
  // comment), used by hitTest (hover) and onPointerUp (click-to-recenter)
  // immediately afterward. Always safe to read right after a redraw;
  // never meaningful mid-frame.
  private drawnLayerMarkers: { screenX: number; screenY: number; radius: number; bounds: LonLatBounds; label: string }[] = [];

  private readonly toScreen = (lon: number, lat: number): { x: number; y: number } => {
    const centerWorld = projectWorld(this.view.lon, this.view.lat, this.view.zoom, TILE_SIZE);
    const w = projectWorld(lon, lat, this.view.zoom, TILE_SIZE);
    return { x: w.x - centerWorld.x + this.viewportWidth / 2, y: w.y - centerWorld.y + this.viewportHeight / 2 };
  };

  connectedCallback(): void {
    const template = document.getElementById('layered-map-template') as HTMLTemplateElement | null;
    if (!template) return;
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(template.content.cloneNode(true));

    this.canvas = shadow.querySelector('.map-canvas');
    this.ctx = this.canvas?.getContext('2d') ?? null;
    this.hoverBarEl = shadow.querySelector('.hover-bar');
    this.zoomLabelEl = shadow.querySelector('.zoom-label');
    this.statusEl = shadow.querySelector('.status-overlay');
    this.emptyMessageEl = shadow.querySelector('.empty-stack-message');
    this.recenterBannerEl = shadow.querySelector('.recenter-banner');
    this.recenterTextEl = shadow.querySelector('.recenter-text');
    this.sourcesPanelEl = shadow.querySelector('.sources-panel');

    shadow.querySelector('.zoom-in-button')?.addEventListener('click', () => this.zoomBy(1, this.viewportWidth / 2, this.viewportHeight / 2));
    shadow.querySelector('.zoom-out-button')?.addEventListener('click', () => this.zoomBy(-1, this.viewportWidth / 2, this.viewportHeight / 2));
    shadow.querySelector('.recenter-button')?.addEventListener('click', () => {
      if (this.recenterTarget) this.recenterOnBounds(this.recenterTarget.bounds);
    });

    if (this.canvas) {
      this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
      this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
      this.canvas.addEventListener('pointercancel', () => { this.dragState = null; });
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

  // ── Startup ──

  private async init(): Promise<void> {
    this.watchState();
    if (!this.statusEl) return;
    this.loader = new RetryingLoader(this.statusEl, () => this.attemptLoad());
    this.loader.start();
  }

  // Everything that can legitimately fail because one of the three
  // hmsvcs, or the shared layer-stack value, isn't ready yet -- see
  // RetryingLoader's own header comment. Safe to re-run in full: every
  // step overwrites its own previous result.
  private async attemptLoad(): Promise<void> {
    this.loader?.setMessage('Finding map services…');
    const [neServiceUrl, tilesServiceUrl, tilesStaticServiceUrl, vectorsServiceUrl] = await Promise.all([
      sharedPlatform.getServiceUrl(NE_SERVICE_NAME),
      sharedPlatform.getServiceUrl(TILES_SERVICE_NAME),
      sharedPlatform.getServiceUrl(TILES_STATIC_SERVICE_NAME),
      sharedPlatform.getServiceUrl(VECTORS_SERVICE_NAME),
    ]);
    if (!neServiceUrl) {
      throw new Error(`${NE_SERVICE_NAME} service is not running yet -- start it from the Microservices widget if this persists`);
    }
    if (!tilesServiceUrl) {
      throw new Error(`${TILES_SERVICE_NAME} service is not running yet -- start it from the Microservices widget if this persists`);
    }
    if (!tilesStaticServiceUrl) {
      throw new Error(`${TILES_STATIC_SERVICE_NAME} service is not running yet -- start it from the Microservices widget if this persists`);
    }
    if (!vectorsServiceUrl) {
      throw new Error(`${VECTORS_SERVICE_NAME} service is not running yet -- start it from the Microservices widget if this persists`);
    }
    this.neServiceUrl = neServiceUrl;
    this.vectorsServiceUrl = vectorsServiceUrl;

    this.loader?.setMessage('Loading layer catalogs…');
    let neCenter: { lon: number; lat: number } | null = null;
    // samothrace-tiles and samothrace-tiles-static both back the SAME
    // logical raster catalog (see this file's own header comment) --
    // merged into `this.tilesCatalog` by this one small helper, called
    // once per origin, each entry keeping the short `service` NAME of
    // whichever origin actually won (see RasterLayerMeta.service's own
    // comment) so drawRasterLayer/getTile can hand it straight to
    // `resolveTileUrl` without re-deciding ownership.
    const mergeRasterCatalog = async (serviceName: TileServiceName, serviceUrl: string): Promise<void> => {
      const res = await fetch(`${serviceUrl}/layers`);
      if (!res.ok) throw new Error(`${serviceName} /layers request failed: ${res.status}`);
      const data = (await res.json()) as { layers: Omit<RasterLayerMeta, 'color' | 'service'>[]; minZoom: number; maxZoom: number };
      // Neither origin's own /layers response has a per-layer color
      // field (see RasterLayerMeta.color's own comment) -- assigned
      // here, client-side, from each layer's own group.
      for (const m of data.layers) {
        this.tilesCatalog.set(m.id, { ...m, color: rasterColorForGroup(m.group), service: serviceName });
      }
      if (typeof data.minZoom === 'number') this.tilesMinZoom = data.minZoom;
      if (typeof data.maxZoom === 'number') this.tilesMaxZoom = data.maxZoom;
    };
    this.tilesCatalog = new Map();
    await Promise.all([
      (async () => {
        const res = await fetch(`${this.neServiceUrl}/layers`);
        if (!res.ok) throw new Error(`${NE_SERVICE_NAME} /layers request failed: ${res.status}`);
        const data = (await res.json()) as { layers: VectorLayerMeta[]; center: { lon: number; lat: number } | null };
        this.neCatalog = new Map(data.layers.map((m) => [m.id, m]));
        neCenter = data.center;
      })(),
      // Sequenced (not run concurrently with each other) so
      // samothrace-tiles-static deterministically wins on any
      // overlapping id -- see this file's own header comment.
      (async () => {
        await mergeRasterCatalog(TILES_SERVICE_NAME, tilesServiceUrl);
        await mergeRasterCatalog(TILES_STATIC_SERVICE_NAME, tilesStaticServiceUrl);
      })(),
      (async () => {
        const res = await fetch(`${this.vectorsServiceUrl}/layers`);
        if (!res.ok) throw new Error(`${VECTORS_SERVICE_NAME} /layers request failed: ${res.status}`);
        const data = (await res.json()) as { layers: VectorLayerMeta[] };
        this.vectorsCatalog = new Map(data.layers.map((m) => [m.id, m]));
      })(),
    ]);

    this.loader?.setMessage('Loading map data…');
    await Promise.all([
      this.loadVectorFeaturesFrom(this.neServiceUrl, this.neCatalog, NE_SERVICE_NAME),
      this.loadVectorFeaturesFrom(this.vectorsServiceUrl, this.vectorsCatalog, VECTORS_SERVICE_NAME),
    ]);

    this.loader?.setMessage('Loading layer stack…');
    const stackValue = await sharedPlatform.getSharedValue(STACK_STATE_KEY);
    // Checked on the RAW value, before sanitizeStack ever runs -- same
    // "nothing saved yet" vs. "saved as []" distinction
    // layer-stack.ts's own DEFAULT_STACK comment explains.
    this.stack = this.sanitizeStack(stackValue === null || stackValue === undefined ? DEFAULT_STACK : stackValue);

    let restoredView = false;
    try {
      const localData = await sharedPlatform.getLocalData();
      const rawView = localData.view;
      if (rawView && typeof rawView === 'object') {
        const v = rawView as { lon?: unknown; lat?: unknown; zoom?: unknown };
        if (
          typeof v.lon === 'number' && Number.isFinite(v.lon) &&
          typeof v.lat === 'number' && Number.isFinite(v.lat) &&
          typeof v.zoom === 'number' && Number.isFinite(v.zoom)
        ) {
          this.view = { lon: v.lon, lat: v.lat, zoom: Math.min(Math.max(Math.round(v.zoom), this.minZoom), this.maxZoom) };
          restoredView = true;
        }
      }
    } catch (err) {
      console.warn('restoring saved view failed (best-effort, using defaults):', err);
    }
    if (!restoredView && neCenter) {
      this.view = { lon: (neCenter as { lon: number; lat: number }).lon, lat: (neCenter as { lon: number; lat: number }).lat, zoom: 7 };
    }

    this.scheduleRedraw();
  }

  // Every vector layer from the given source/catalog is fetched once,
  // up front, regardless of whether it's currently on the shared stack
  // -- same reasoning as natural-earth-map.ts's own loadAllFeatures
  // (small files, cheap to hold all of, and it means a stack change
  // never needs a refetch, only a redraw). Raster tiles stay
  // lazy/per-tile, same as samothrace-map.ts. Shared by both vector
  // sources (natural-earth-map, samothrace-vectors) -- called once per
  // source from attemptLoad, writing into the one shared featureCache
  // (see that field's own comment on why a shared cache is safe here).
  private async loadVectorFeaturesFrom(serviceUrl: string | null, catalog: Map<string, VectorLayerMeta>, serviceName: string): Promise<void> {
    if (!serviceUrl) throw new Error(`${serviceName} service URL unknown`);
    const metas = [...catalog.values()];
    await Promise.all(
      metas.map(async (meta) => {
        const res = await fetch(`${serviceUrl}${meta.url}`);
        if (!res.ok) throw new Error(`${meta.url} request failed: ${res.status}`);
        const fc = (await res.json()) as GeoJsonFeatureCollection;
        this.featureCache.set(meta.id, fc.features);
      })
    );
  }

  // Looks a stack entry's own VectorLayerMeta up in whichever vector
  // catalog matches its `source` -- used by redraw()'s vector-drawing
  // branch and hitTest below, so neither has to special-case which of
  // the two vector sources a given ref came from beyond this one lookup.
  // Returns undefined for a `samothrace-tiles` ref (not a vector
  // source at all) or an id this widget's own catalogs don't (yet, or
  // ever) recognize -- both treated identically by every caller: skip
  // this entry, draw/hit-test nothing for it.
  private vectorMetaFor(ref: { source: MapSource; id: string }): VectorLayerMeta | undefined {
    if (ref.source === 'natural-earth-map') return this.neCatalog.get(ref.id);
    if (ref.source === 'samothrace-vectors') return this.vectorsCatalog.get(ref.id);
    return undefined;
  }

  // Minimal shape validation only -- NOT filtered against "does this
  // id currently exist in neCatalog/tilesCatalog," on purpose: this
  // runs both at startup (where the catalogs are already loaded by the
  // time this is called, see attemptLoad's own ordering) and from a
  // live shared-value change notification (which can arrive before this
  // widget's OWN catalogs are ready, if two widgets start around the
  // same time). Filtering here would permanently and silently drop a
  // perfectly valid stack entry just because of a load-order race;
  // instead, redraw()/hitTest() each skip a stack entry whose catalog
  // lookup currently misses, which self-heals the moment the catalog
  // itself finishes loading (or the next legitimate state change
  // arrives) without ever losing data.
  private sanitizeStack(raw: unknown): { source: MapSource; id: string }[] {
    if (!Array.isArray(raw)) return [];
    const out: { source: MapSource; id: string }[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const parsed = parseLayerKey(entry);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  private watchState(): void {
    sharedPlatform.onSharedValueChanged((key, value) => {
      if (key !== STACK_STATE_KEY) return;
      this.stack = this.sanitizeStack(value);
      this.scheduleRedraw();
    });
    for (const serviceName of [NE_SERVICE_NAME, TILES_SERVICE_NAME, TILES_STATIC_SERVICE_NAME, VECTORS_SERVICE_NAME]) {
      sharedPlatform.onServiceUrlChanged(serviceName, () => {
        // This hmsvc restarted (new URL published) -- the simplest
        // correct response is to re-run the whole load attempt, same as
        // samothrace-map.ts/natural-earth-map.ts's own
        // watchTileServiceState/watchServiceState handlers.
        console.warn(`${serviceName} service URL changed -- reloading`);
        this.tileCache.clear();
        this.resolvedTileUrlCache.clear();
        this.loader?.retryNow();
      });
    }
  }

  // ── Persistence (view only -- layer stack membership/order is
  // shared state, not local to this instance) ──

  private scheduleSaveUiState(): void {
    if (this.saveUiStateTimer !== null) return;
    this.saveUiStateTimer = window.setTimeout(() => {
      this.saveUiStateTimer = null;
      void sharedPlatform.setLocalData({ view: this.view });
    }, 400);
  }

  // ── View (pan/zoom) -- same algorithms as the other two widgets'
  // own fitToBounds-less pan/zoom (this widget has no bounds-fit
  // button, so there's no fitToBounds here at all). ──

  private zoomBy(delta: number, anchorScreenX: number, anchorScreenY: number): void {
    const oldZoom = this.view.zoom;
    const newZoom = Math.min(Math.max(oldZoom + delta, this.minZoom), this.maxZoom);
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
    // Pointer cursor over a layer marker specifically -- the only thing
    // in this widget a plain click actually does anything to (see
    // onPointerUp's own click-to-recenter) -- plain "grab" everywhere
    // else, same as before this feature existed.
    if (this.canvas) {
      const overMarker = this.drawnLayerMarkers.some((m) => Math.hypot(screenX - m.screenX, screenY - m.screenY) <= m.radius + 5);
      this.canvas.style.cursor = overMarker ? 'pointer' : 'grab';
    }
    this.scheduleRedraw();
  }

  private onPointerUp(e: PointerEvent): void {
    this.canvas?.releasePointerCapture(e.pointerId);
    const wasClick = !!this.dragState && !this.dragState.moved;
    if (this.dragState) this.scheduleSaveUiState();
    this.dragState = null;

    // A plain click (no drag) landing on a layer marker jumps straight
    // to it -- same target recenterOnBounds already computes for the
    // "Center here" banner's own button, just reached a second,
    // more-direct way now that the marker itself is a visible target.
    if (wasClick) {
      const rect = this.canvas?.getBoundingClientRect();
      if (rect) {
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const hitMarker = this.drawnLayerMarkers.find(
          (m) => Math.hypot(screenX - m.screenX, screenY - m.screenY) <= m.radius + 5
        );
        if (hitMarker) this.recenterOnBounds(hitMarker.bounds);
      }
    }
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

  // ── Hit-testing -- vector layers only (a raster tile has no feature
  // properties to show), topmost-in-the-stack wins. `this.stack` is
  // already ordered closest-first, so the first match IS the topmost. ──

  private hitTest(screenX: number, screenY: number): HoverInfo | null {
    // A too-small-to-render raster layer's own marker (drawLayerMarker)
    // is always drawn on top of everything else this frame -- check it
    // first, same "topmost wins" convention the vector hit-test below
    // already follows for its own layers.
    for (const marker of this.drawnLayerMarkers) {
      if (Math.hypot(screenX - marker.screenX, screenY - marker.screenY) <= marker.radius + 5) {
        return { layerLabel: marker.label, name: marker.label, extra: null };
      }
    }
    for (const ref of this.stack) {
      if (ref.source === 'samothrace-tiles') continue;
      const meta = this.vectorMetaFor(ref);
      const features = this.featureCache.get(ref.id);
      if (!meta || !features) continue;
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

  private featureHit(feature: GeoJsonFeature, meta: VectorLayerMeta, screenX: number, screenY: number): boolean {
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

    if (this.zoomLabelEl) this.zoomLabelEl.textContent = `zoom ${this.view.zoom}`;

    const zoom = this.view.zoom;
    const centerWorld = projectWorld(this.view.lon, this.view.lat, zoom, TILE_SIZE);
    const occupied: { x: number; y: number; w: number; h: number }[] = [];
    this.drawnLayerMarkers = [];

    // Draw farthest-from-the-viewer first -- `this.stack` is ordered
    // closest-first (same convention as the layer-stack widget's own
    // visual list, top = closest), so reversing it gives bottom-to-top
    // compositing order, the normal "paint the back layers first" rule.
    const drawOrder = [...this.stack].reverse();
    const markerTargets: { meta: RasterLayerMeta; bounds: LonLatBounds }[] = [];
    for (const ref of drawOrder) {
      if (ref.source === 'samothrace-tiles') {
        const meta = this.tilesCatalog.get(ref.id);
        if (!meta) continue;
        if (meta.bounds && this.shouldShowMarkerInstead(meta.bounds, zoom)) {
          // Too small on-screen (or entirely out of this raster set's
          // own real zoom range) for actual tiles to be a useful thing
          // to request -- see drawLayerMarker's own comment. Deferred
          // to after the main compositing loop so a marker always sits
          // on top of every tile layer, never underneath one.
          markerTargets.push({ meta, bounds: meta.bounds });
          continue;
        }
        if (zoom < this.tilesMinZoom || zoom > this.tilesMaxZoom) continue; // out of range and no known bounds to fall back to a marker for (e.g. "blank"/"initial-map") -- just skip, no fetch
        this.drawRasterLayer(ctx, ref.id, meta.service, zoom, centerWorld);
      } else {
        const meta = this.vectorMetaFor(ref);
        const features = this.featureCache.get(ref.id);
        if (!meta || !features) continue;
        this.drawVectorLayer(ctx, meta, features, occupied);
      }
    }

    for (const { meta, bounds } of markerTargets) this.drawLayerMarker(ctx, meta, bounds, occupied);

    if (this.hover && this.hoverScreenPoint) this.drawHoverMarker(ctx, this.hoverScreenPoint);

    this.updateEmptyMessage();
    this.updateRecenterTarget();
    this.updateSourcesPanel();
  }

  // Lower-left attribution box -- every distinct third-party source
  // among the layers currently on the stack (see sourceKeyForLayer's
  // own comment for which layers count), each a hyperlink to that
  // source's own license page. "Currently visible" is read as "on the
  // shared stack right now," the same meaning every other per-frame
  // check in this widget (updateEmptyMessage, updateRecenterTarget)
  // already uses -- not a stricter "and its tiles/features actually
  // rendered something in the current viewport" test, which would make
  // the box flicker in and out while panning past a layer's own edge
  // for no reason a user would find useful.
  private updateSourcesPanel(): void {
    if (!this.sourcesPanelEl) return;
    const seen = new Set<string>();
    const entries: SourceInfo[] = [];
    for (const ref of this.stack) {
      const key = sourceKeyForLayer(ref);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const info = SOURCE_INFO[key];
      if (info) entries.push(info);
    }

    const el = this.sourcesPanelEl as HTMLElement;
    if (entries.length === 0) {
      el.style.display = 'none';
      this.lastSourcesPanelHtml = null;
      return;
    }
    const html = entries
      .map((e) => `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.name)}</a>`)
      .join('');
    if (html !== this.lastSourcesPanelHtml) {
      el.innerHTML = html;
      this.lastSourcesPanelHtml = html;
    }
    el.style.display = 'flex';
  }

  // A raster layer's own real extent (see RasterLayerMeta.bounds's own
  // comment) is "too small to bother drawing as actual tiles" when
  // either the current zoom is entirely outside this hmsvc's own tile
  // range (no tiles would even be requested), or the bounds box
  // projects to less than MARKER_MIN_PX on a side -- at that size the
  // tiles themselves would be imperceptible even if they loaded, and a
  // deliberate, clickable, colored marker is strictly more useful than
  // a few sub-pixel-sized image requests.
  private shouldShowMarkerInstead(bounds: LonLatBounds, zoom: number): boolean {
    if (zoom < this.tilesMinZoom || zoom > this.tilesMaxZoom) return true;
    const nw = this.toScreen(bounds.west, bounds.north);
    const se = this.toScreen(bounds.east, bounds.south);
    const w = Math.abs(se.x - nw.x);
    const h = Math.abs(se.y - nw.y);
    return w < LayeredMapElement.MARKER_MIN_PX || h < LayeredMapElement.MARKER_MIN_PX;
  }

  // A city-dot-style marker (same visual language as
  // natural-earth-map.ts's own drawPointLabels, which this project's
  // users already know from that widget) at a too-small-to-render
  // raster layer's own bounds center, colored with that layer's own
  // associated color (meta.color -- see rasterColorForGroup's own
  // comment for where a samothrace-tiles layer's color comes from,
  // since that hmsvc's own /layers response has no color field of its
  // own the way natural-earth-map's vector layers do). Shares the same
  // `occupied` label-collision list the vector dot-label/centroid-label
  // layers already use, so a marker's own label never overlaps a city
  // or named-island label drawn earlier in the same frame. Also records
  // the marker's own screen position/radius/bounds into
  // `drawnLayerMarkers` for hitTest (hover) and onPointerUp
  // (click-to-recenter) to use afterward.
  private static readonly MARKER_MIN_PX = 20;

  private drawLayerMarker(
    ctx: CanvasRenderingContext2D,
    meta: RasterLayerMeta,
    bounds: LonLatBounds,
    occupied: { x: number; y: number; w: number; h: number }[]
  ): void {
    const center = { lon: (bounds.west + bounds.east) / 2, lat: (bounds.south + bounds.north) / 2 };
    const p = this.toScreen(center.lon, center.lat);
    if (p.x < -20 || p.x > this.viewportWidth + 20 || p.y < -20 || p.y > this.viewportHeight + 20) return;

    const radius = 5;
    ctx.save();
    ctx.fillStyle = meta.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(13, 20, 32, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#e6e9ef';
    ctx.font = '600 11px Arial, Helvetica, sans-serif';
    ctx.textBaseline = 'middle';
    const labelX = p.x + radius + 4;
    const rect = this.textRect(ctx, meta.label, labelX + ctx.measureText(meta.label).width / 2, p.y);
    if (!this.overlapsAny(rect, occupied)) {
      occupied.push(rect);
      ctx.fillText(meta.label, labelX, p.y);
    }
    ctx.restore();

    this.drawnLayerMarkers.push({ screenX: p.x, screenY: p.y, radius, bounds, label: meta.label });
  }

  private updateEmptyMessage(): void {
    if (!this.emptyMessageEl) return;
    (this.emptyMessageEl as HTMLElement).style.display = this.stack.length === 0 ? 'flex' : 'none';
  }

  private currentViewportBounds(): LonLatBounds {
    const centerWorld = projectWorld(this.view.lon, this.view.lat, this.view.zoom, TILE_SIZE);
    const nw = unprojectWorld(centerWorld.x - this.viewportWidth / 2, centerWorld.y - this.viewportHeight / 2, this.view.zoom, TILE_SIZE);
    const se = unprojectWorld(centerWorld.x + this.viewportWidth / 2, centerWorld.y + this.viewportHeight / 2, this.view.zoom, TILE_SIZE);
    return { west: nw.lon, north: nw.lat, east: se.lon, south: se.lat };
  }

  // Finds the TOPMOST stack entry that's both a samothrace-tiles layer
  // AND has a known real-world extent (see RasterLayerMeta.bounds's own
  // comment), and decides whether it's actually visible right now --
  // see this.recenterTarget's own field comment for the full story.
  // Only ever considers one layer (the first match) -- simplest useful
  // scope for the 2026-10-19 incident this fixes; a stack with several
  // off-screen raster layers only ever gets one recenter suggestion at
  // a time, which is enough to get unstuck (recentering on the first
  // one typically brings the others into range too, since they're all
  // real tile sets for the same physical site).
  private updateRecenterTarget(): void {
    let target: { label: string; bounds: LonLatBounds } | null = null;
    const zoomInRange = this.view.zoom >= this.tilesMinZoom && this.view.zoom <= this.tilesMaxZoom;
    const viewport = this.currentViewportBounds();
    for (const ref of this.stack) {
      if (ref.source !== 'samothrace-tiles') continue;
      const meta = this.tilesCatalog.get(ref.id);
      if (!meta || !meta.bounds) continue;
      const visible = zoomInRange && boundsIntersect(viewport, meta.bounds);
      if (!visible) target = { label: meta.label, bounds: meta.bounds };
      break; // topmost bounds-known raster layer only, found or not
    }
    const changed = JSON.stringify(target) !== JSON.stringify(this.recenterTarget);
    this.recenterTarget = target;
    if (changed) this.renderRecenterBanner();
  }

  private renderRecenterBanner(): void {
    if (!this.recenterBannerEl) return;
    if (!this.recenterTarget) {
      (this.recenterBannerEl as HTMLElement).style.display = 'none';
      return;
    }
    if (this.recenterTextEl) this.recenterTextEl.textContent = `"${this.recenterTarget.label}" isn't in view here.`;
    (this.recenterBannerEl as HTMLElement).style.display = 'flex';
  }

  // Same fit-to-bounds zoom search as natural-earth-map.ts's own
  // fitToBounds, clamped to this hmsvc's own tile range (never past
  // tilesMinZoom/tilesMaxZoom -- there's no point landing on a zoom
  // where the target raster layer wouldn't even draw).
  private recenterOnBounds(bounds: LonLatBounds): void {
    let zoom = this.tilesMaxZoom;
    for (; zoom >= this.tilesMinZoom; zoom--) {
      const nw = projectWorld(bounds.west, bounds.north, zoom, TILE_SIZE);
      const se = projectWorld(bounds.east, bounds.south, zoom, TILE_SIZE);
      if (se.x - nw.x <= this.viewportWidth && se.y - nw.y <= this.viewportHeight) break;
    }
    zoom = Math.min(Math.max(zoom, this.tilesMinZoom), this.tilesMaxZoom);
    this.view = { lon: (bounds.west + bounds.east) / 2, lat: (bounds.south + bounds.north) / 2, zoom };
    this.scheduleSaveUiState();
    this.scheduleRedraw();
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

  // ── Raster compositing -- same tile-range/getTile pattern as
  // samothrace-map.ts's own drawLayer/getTile, parameterized over the
  // samothrace-tiles service URL this widget discovered itself. ──

  private getTile(url: string): TileEntry {
    let entry = this.tileCache.get(url);
    if (!entry) {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // same canvas-tainting avoidance as samothrace-map.ts's own getTile
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

  // Resolves one tile's actual URL via `sharedPlatform.resolveTileUrl`
  // -- `null` while the resolution is still pending (or failed), in
  // which case the caller just skips this tile for the current frame;
  // the resolution itself schedules a redraw once it completes, same
  // pattern as getTile's own async image load one layer further in.
  private getResolvedTileUrl(service: TileServiceName, layerId: string, zoom: number, tx: number, ty: number): string | null {
    const key = `${service}|${layerId}|${zoom}|${tx}|${ty}`;
    let entry = this.resolvedTileUrlCache.get(key);
    if (!entry) {
      entry = { status: 'resolving' };
      this.resolvedTileUrlCache.set(key, entry);
      sharedPlatform.resolveTileUrl(service, layerId, zoom, tx, ty).then(
        (url) => {
          entry!.status = 'resolved';
          entry!.url = url;
          this.scheduleRedraw();
        },
        (err) => {
          entry!.status = 'error';
          console.warn(`resolving tile URL for ${service}/${layerId}/${zoom}/${tx}/${ty} failed:`, err);
        }
      );
    }
    return entry.status === 'resolved' ? (entry.url ?? null) : null;
  }

  private drawRasterLayer(ctx: CanvasRenderingContext2D, layerId: string, service: TileServiceName, zoom: number, centerWorld: { x: number; y: number }): void {
    const tileSize = TILE_SIZE;
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
        const url = this.getResolvedTileUrl(service, layerId, zoom, tx, ty);
        if (!url) continue; // not resolved yet (or errored) -- redraws once it is
        const entry = this.getTile(url);
        if (entry.status !== 'loaded') continue;
        const screenX = tx * tileSize - centerWorld.x + this.viewportWidth / 2;
        const screenY = ty * tileSize - centerWorld.y + this.viewportHeight / 2;
        ctx.drawImage(entry.img, screenX, screenY, tileSize, tileSize);
      }
    }
  }

  // ── Vector rendering -- same drawLayer/drawPointLabels/
  // drawLineLabels/textRect/overlapsAny shapes as natural-earth-map.ts's
  // own copies. ──

  private drawVectorLayer(
    ctx: CanvasRenderingContext2D,
    meta: VectorLayerMeta,
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
      if (meta.dashed) {
        // A short dash + round cap reads as a dotted line, not a
        // dashed one -- scaled off the line's own weight so it stays
        // proportionate at any configured thickness. Reset to solid
        // (`[]`) is implicit: this is inside ctx.save()/restore(), and
        // every OTHER stroke layer never sets a dash in the first
        // place.
        const dot = Math.max(1, (meta.weight ?? 1) * 0.8);
        ctx.setLineDash([dot, dot * 3]);
      }
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

  private drawPointLabels(
    ctx: CanvasRenderingContext2D,
    meta: VectorLayerMeta,
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
    meta: VectorLayerMeta,
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
      const mid = longest[Math.floor(longest.length / 2)]!;
      const p = this.toScreen(mid[0], mid[1]);
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
    const gap = 3;
    return { x: cx - w / 2 - gap, y: cy - h / 2 - gap, w: w + gap * 2, h: h + gap * 2 };
  }

  private overlapsAny(rect: { x: number; y: number; w: number; h: number }, occupied: { x: number; y: number; w: number; h: number }[]): boolean {
    return occupied.some(
      (o) => rect.x < o.x + o.w && rect.x + rect.w > o.x && rect.y < o.y + o.h && rect.y + rect.h > o.y
    );
  }
}

customElements.define('layered-map', LayeredMapElement);
