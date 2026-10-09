// Samothrace Map -- an interactive Leaflet map over the locally-tiled
// Actual State / Restored State / Aerial Imagery plans in ./Data, with
// clickable monument overlays. Selecting a monument (by click or from the
// dropdown) publishes it to Desk's shared, project-scoped state so a
// separate "Samothrace Monument Description" widget can display it.
//
// Tile images and description images are binary, so they're fetched via
// the binary-safe `desk.documents` Bridge capability (desk.fs.readFile
// decodes UTF-8 text and throws on binary data). GeoJSON overlay files are
// plain text and are fetched via `desk.fs.readFile` instead.

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
    documents: {
      open(path: string): Promise<{ handle: string }>;
      read(handle: string, opts: { offset: number; length: number }): Promise<{ data: string; eof: boolean }>;
      close(handle: string): Promise<{ closed: boolean }>;
    };
    state: {
      get(key: string): Promise<{ value: unknown; edit: unknown }>;
      set(key: string, value: unknown, edit?: unknown): Promise<{ ok: boolean }>;
    };
  };
}

declare const L: any;

// This project's bundled `tsc` (3.8.3) predates the DOM lib's
// ResizeObserver typings, even though real browsers have long supported it.
declare class ResizeObserver {
  constructor(callback: () => void);
  observe(target: Element): void;
  disconnect(): void;
}

// ── Data layout (see ./Data/mapCode for the structure this mirrors --
// no code from there is reused, only the directory/file conventions) ──

const OVERLAY_PATHS: Record<'Actual' | 'Restored', string> = {
  Actual: 'Data/mapFeatures/SamoWeb_ActualStatePlan_Overlay.geojson',
  Restored: 'Data/mapFeatures/SamoWeb_RestoredStatePlan_Overlay.geojson',
};

const TILE_DIRS = {
  ActualPlan: 'Data/mapTiles/SamoWebsite_ActualStatePlan_3857',
  ActualMonuments: 'Data/mapTiles/SamoWebsite_ActualStateMonuments_3857',
  RestoredPlan: 'Data/mapTiles/SamoWebsite_RestoredStatePlan_3857',
  RestoredMonuments: 'Data/mapTiles/SamoWebsite_RestoredStateMonuments_3857',
  Aerial: 'Data/mapTiles/SamoWebsite_AerialImagery_3857',
};

const MIN_ZOOM = 17;
const MAX_ZOOM = 22;
const STATE_KEY = 'samothrace.selectedMonument';
const INTRO_WEBCODE = '(0)Introduction';

const GROUP_OVERLAY_KEY: Record<string, 'Actual' | 'Restored' | null> = {
  'Actual State Plan': 'Actual',
  'Restored State Plan': 'Restored',
  'Aerial Imagery': null,
};
const OVERLAY_KEY_TO_GROUP_NAME: Record<'Actual' | 'Restored', string> = {
  Actual: 'Actual State Plan',
  Restored: 'Restored State Plan',
};

interface SelectedMonument {
  webCode: string;
  label: string;
  name: string;
  plan: string;
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

// ── Tile loading: each tile is fetched once (binary-safe) via
// desk.documents and cached as a data: URI, keyed by file path. The TMS
// y-flip mirrors how these tiles are actually laid out on disk. ──

const tileCache = new Map<string, Promise<string | null>>();

async function fetchTileDataUri(path: string): Promise<string | null> {
  const desk = window.desk;
  if (!desk) return null;
  let handle: string | null = null;
  try {
    handle = (await desk.documents.open(path)).handle;
    const { data } = await desk.documents.read(handle, { offset: 0, length: 8 * 1024 * 1024 });
    if (!data) return null;
    return `data:image/png;base64,${data}`;
  } catch {
    return null;
  } finally {
    if (handle) desk.documents.close(handle).catch(() => {});
  }
}

function loadTileDataUri(path: string): Promise<string | null> {
  let cached = tileCache.get(path);
  if (!cached) {
    cached = fetchTileDataUri(path);
    tileCache.set(path, cached);
  }
  return cached;
}

const LocalTileLayer = (L as any).GridLayer.extend({
  createTile(this: any, coords: { x: number; y: number; z: number }, done: (error: Error | null, tile: HTMLElement) => void): HTMLElement {
    const tile = document.createElement('img');
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;
    tile.alt = '';
    tile.style.visibility = 'hidden';
    const basePath = this.options.basePath as string;
    const tmsY = Math.pow(2, coords.z) - 1 - coords.y;
    const path = `${basePath}/${coords.z}/${coords.x}/${tmsY}.png`;
    loadTileDataUri(path).then((uri) => {
      if (uri) {
        tile.src = uri;
        tile.style.visibility = 'visible';
      }
      done(null, tile);
    });
    return tile;
  },
});

function makeTileLayer(basePath: string): any {
  return new LocalTileLayer({ basePath, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, tileSize: 256, noWrap: true });
}

// ── Overlay feature styling ──

function baseStyle(): Record<string, unknown> {
  return { fillColor: '#ffffff', fillOpacity: 0, color: '#ffffff', weight: 0, opacity: 0 };
}
function hoverStyle(): Record<string, unknown> {
  return { fillColor: '#ffffff', fillOpacity: 0.25, color: '#ffffff', weight: 2, opacity: 1 };
}
function selectedStyle(): Record<string, unknown> {
  return { fillColor: '#ffd84d', fillOpacity: 0.35, color: '#ffd84d', weight: 2, opacity: 1 };
}

// ── Element ──

class SamothraceMapElement extends HTMLElement {
  private mapEl: HTMLElement | null = null;
  private selectEl: HTMLSelectElement | null = null;
  private homeButtonEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private map: any = null;
  private overlays: { Actual: any; Restored: any } = { Actual: null, Restored: null };
  private actualFeatures: any[] = [];
  private restoredFeatures: any[] = [];
  private activeOverlayLayer: any = null;
  private activeFeatures: any[] = [];
  private activePlanName = 'Overview';
  private selectedLayer: any = null;
  private combinedBounds: any = null;
  private baseLayers: Record<string, any> = {};

  connectedCallback(): void {
    const template = document.getElementById('samothrace-map-template');
    if (!(template instanceof HTMLTemplateElement)) {
      throw new Error('samothrace-map-template not found');
    }
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(template.content.cloneNode(true));

    this.mapEl = shadow.querySelector('.map-container');
    this.selectEl = shadow.querySelector('.monument-select');
    this.homeButtonEl = shadow.querySelector('.home-button');
    this.statusEl = shadow.querySelector('.status-overlay');

    this.homeButtonEl?.addEventListener('click', () => this.selectFeature(null));
    this.selectEl?.addEventListener('change', () => {
      const v = this.selectEl?.value ?? INTRO_WEBCODE;
      this.selectFeature(v === INTRO_WEBCODE ? null : v);
    });

    this.resizeObserver = new ResizeObserver(() => this.map?.invalidateSize());
    this.resizeObserver.observe(this);

    void this.init();
  }

  disconnectedCallback(): void {
    this.resizeObserver?.disconnect();
    this.map?.remove();
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

  private async init(): Promise<void> {
    const desk = window.desk;
    try {
      this.setStatus('Loading map data…');
      if (!desk) throw new Error('Desk bridge unavailable');
      if (!this.mapEl) throw new Error('map container missing');

      const [actualRaw, restoredRaw] = await Promise.all([
        desk.fs.readFile(OVERLAY_PATHS.Actual),
        desk.fs.readFile(OVERLAY_PATHS.Restored),
      ]);
      const actualGeojson = JSON.parse(actualRaw.contents);
      const restoredGeojson = JSON.parse(restoredRaw.contents);

      this.map = L.map(this.mapEl, {
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        zoomControl: true,
        attributionControl: false,
        maxBoundsViscosity: 0.7,
      });

      this.overlays.Actual = this.buildOverlay(actualGeojson, 'Actual');
      this.overlays.Restored = this.buildOverlay(restoredGeojson, 'Restored');

      this.combinedBounds = this.overlays.Actual.getBounds().extend(this.overlays.Restored.getBounds());
      this.map.setMaxBounds(this.combinedBounds.pad(0.6));

      this.baseLayers = {
        'Actual State Plan': L.layerGroup([makeTileLayer(TILE_DIRS.ActualPlan), makeTileLayer(TILE_DIRS.ActualMonuments)]),
        'Restored State Plan': L.layerGroup([makeTileLayer(TILE_DIRS.RestoredPlan), makeTileLayer(TILE_DIRS.RestoredMonuments)]),
        'Aerial Imagery': L.layerGroup([makeTileLayer(TILE_DIRS.Aerial)]),
      };
      L.control.layers(this.baseLayers, {}, { collapsed: false, position: 'topright' }).addTo(this.map);
      this.map.on('baselayerchange', (e: { name: string }) => {
        this.applyGroup(e.name);
        void desk.self.setLocalStorage({ lastGroup: e.name });
        this.selectFeature(null, false);
      });

      const { data: localData } = await desk.self.getLocalStorage();
      const lastGroup = typeof localData.lastGroup === 'string' ? (localData.lastGroup as string) : 'Actual State Plan';
      const startGroup = this.baseLayers[lastGroup] ? lastGroup : 'Actual State Plan';
      this.baseLayers[startGroup].addTo(this.map);
      this.applyGroup(startGroup);
      this.map.fitBounds(this.combinedBounds.pad(0.08));
      this.selectFeature(null, false);

      // Restore a previously-shared selection, switching plan if needed.
      const existing = await desk.state.get(STATE_KEY);
      const value = existing.value as SelectedMonument | null;
      if (value && value.webCode && value.webCode !== INTRO_WEBCODE) {
        const overlayKey = value.plan === 'Actual' || value.plan === 'Restored' ? value.plan : null;
        if (overlayKey && OVERLAY_KEY_TO_GROUP_NAME[overlayKey] !== startGroup) {
          const groupName = OVERLAY_KEY_TO_GROUP_NAME[overlayKey];
          this.map.removeLayer(this.baseLayers[startGroup]);
          this.baseLayers[groupName].addTo(this.map);
          this.applyGroup(groupName);
        }
        this.selectFeature(value.webCode, false);
      }

      this.setStatus(null);
    } catch (err) {
      this.setStatus(`Failed to load map: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private buildOverlay(geojson: any, planKey: 'Actual' | 'Restored'): any {
    if (planKey === 'Actual') this.actualFeatures = geojson.features;
    else this.restoredFeatures = geojson.features;
    return L.geoJSON(geojson, {
      style: () => baseStyle(),
      onEachFeature: (feature: any, lyr: any) => {
        lyr.on('mouseover', () => {
          if (lyr !== this.selectedLayer) lyr.setStyle(hoverStyle());
        });
        lyr.on('mouseout', () => {
          if (lyr !== this.selectedLayer) lyr.setStyle(baseStyle());
        });
        lyr.on('click', () => this.selectFeature(feature.properties.WebCode));
      },
    });
  }

  private applyGroup(groupName: string): void {
    if (this.activeOverlayLayer && this.map.hasLayer(this.activeOverlayLayer)) {
      this.map.removeLayer(this.activeOverlayLayer);
    }
    this.clearSelectionHighlight();
    const overlayKey = GROUP_OVERLAY_KEY[groupName] ?? null;
    if (overlayKey) {
      this.activeOverlayLayer = this.overlays[overlayKey];
      this.activeFeatures = overlayKey === 'Actual' ? this.actualFeatures : this.restoredFeatures;
      this.activePlanName = overlayKey;
      this.activeOverlayLayer.addTo(this.map);
    } else {
      this.activeOverlayLayer = null;
      this.activeFeatures = [];
      this.activePlanName = 'Overview';
    }
    this.rebuildDropdown();
    void window.desk?.self.setSubtitle(groupName);
  }

  private rebuildDropdown(): void {
    if (!this.selectEl) return;
    const options = [`<option value="${INTRO_WEBCODE}">Overview — About the Interactive Plan</option>`];
    const sorted = [...this.activeFeatures].sort(
      (a, b) => sortKeyForLabel(a.properties.Label) - sortKeyForLabel(b.properties.Label),
    );
    for (const f of sorted) {
      const p = f.properties;
      options.push(`<option value="${escapeHtml(p.WebCode)}">(${escapeHtml(p.Label)}) ${escapeHtml(p.Name)}</option>`);
    }
    this.selectEl.innerHTML = options.join('');
    this.selectEl.value = INTRO_WEBCODE;
  }

  private clearSelectionHighlight(): void {
    if (this.selectedLayer) {
      this.selectedLayer.setStyle(baseStyle());
      this.selectedLayer = null;
    }
  }

  private findFeature(webCode: string): any | null {
    return this.activeFeatures.find((f: any) => f.properties.WebCode === webCode) ?? null;
  }

  private findLayerForWebCode(webCode: string): any | null {
    let found: any = null;
    this.activeOverlayLayer?.eachLayer((lyr: any) => {
      if (lyr.feature?.properties?.WebCode === webCode) found = lyr;
    });
    return found;
  }

  private selectFeature(webCode: string | null, publish = true): void {
    const feature = webCode ? this.findFeature(webCode) : null;
    this.clearSelectionHighlight();

    if (feature) {
      const layer = this.findLayerForWebCode(webCode as string);
      if (layer) {
        layer.setStyle(selectedStyle());
        this.selectedLayer = layer;
        this.map?.flyToBounds(layer.getBounds(), { maxZoom: MAX_ZOOM, padding: [24, 24] });
      }
      if (this.selectEl) this.selectEl.value = webCode as string;
      if (publish) {
        void window.desk?.state.set(STATE_KEY, {
          webCode: feature.properties.WebCode,
          label: feature.properties.Label,
          name: feature.properties.Name,
          plan: this.activePlanName,
        });
      }
    } else {
      if (this.map && this.combinedBounds) this.map.flyToBounds(this.combinedBounds.pad(0.08));
      if (this.selectEl) this.selectEl.value = INTRO_WEBCODE;
      if (publish) {
        void window.desk?.state.set(STATE_KEY, {
          webCode: INTRO_WEBCODE,
          label: '',
          name: 'Overview',
          plan: this.activePlanName,
        });
      }
    }
  }
}

customElements.define('samothrace-map', SamothraceMapElement);
