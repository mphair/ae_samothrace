// Gazetteer -- a sortable, searchable, groupable list over every named
// thing gathered in Data/gazetteer/gazetteer.geojson (cities, islands,
// seas/straits/channels, rivers -- see that directory's own
// build_gazetteer.py for how it was assembled from Data/naturalEarth/
// and Data/OpenStreetMap-geocoding/). Served by the `gazetteer` hmsvc
// (desk_hmsvc/gazetteer/) -- same URL-discovery-via-desk.state pattern
// as the Natural Earth Map widget, for the same reason (the service
// gets a fresh random port every launch).
//
// Clicking an entry publishes a "jump to this place" message on
// Desk's own cross-widget event channel -- it does not know or care
// whether a Natural Earth Map widget instance actually exists to
// receive it (desk.events.publish is a broadcast to whoever's
// currently subscribed, not a targeted call); see FOCUS_EVENT_NAME's
// own comment for the exact contract both widgets agree on.

// This project's bundled `tsc` (3.8.3) predates the DOM lib's
// ResizeObserver typings -- not actually needed by this widget (no
// canvas, no size-dependent layout math), but declared anyway for
// consistency with every other widget in this project that touches
// `window.desk`, in case a future edit adds one.

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
      publish(name: string, payload?: unknown): Promise<{ ok: boolean }>;
      onMessage(callback: (name: string, payload: unknown, senderInstanceId: string) => void): void;
    };
    workspace: {
      getState(): Promise<{ widgets: Array<{ widget_id: string }> }>;
    };
  };
}

// ── Constants ──

const SERVICE_NAME = 'gazetteer';
const SERVICE_STATE_KEY = `desk.hmsvc.${SERVICE_NAME}`;

// Must match desk_widgets/natural-earth-map/natural-earth-map.ts's own
// FOCUS_EVENT_NAME exactly -- the two widgets agree on this string (and
// the {lon, lat, zoom?, label?} payload shape below) purely by
// convention, same as any other desk.events channel name; neither
// widget imports anything from the other.
const FOCUS_EVENT_NAME = 'natural-earth-map.focus';
const MAP_WIDGET_ID = 'NaturalEarthMap';

type SortMode = 'name' | 'type';

interface GazetteerEntry {
  id: string;
  name: string;
  type: string;
  lon: number;
  lat: number;
  source_layer: string;
  population?: number;
  area_km2?: number;
  country?: string | null;
  [key: string]: unknown;
}

// Badge color per `type` -- deliberately echoing the same palette
// scripts/clip_natural_earth.py's own LAYER_STYLES and
// Data/OpenStreetMap-geocoding/fetch_island_names.py's own LAYER_META
// already use for the matching layer on the map widget side (city
// amber, island teal, named-region lavender, sea/strait/channel cyan,
// river blue) -- so a color here reads as "the same kind of thing" as
// its own dot on the map, not a second, disconnected color scheme.
const TYPE_COLORS: Record<string, string> = {
  city: '#f2b134',
  island: '#5fd4a0',
  island_group: '#c9a9e0',
  sea: '#6fc8e0',
  strait: '#6fc8e0',
  channel: '#6fc8e0',
  river: '#3f8fd1',
};
const DEFAULT_TYPE_COLOR = '#8a93a3';

function humanizeType(type: string): string {
  return type
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

function extraInfo(entry: GazetteerEntry): string | null {
  if (entry.type === 'city' && typeof entry.population === 'number') {
    return `pop. ${entry.population.toLocaleString()}`;
  }
  if ((entry.type === 'island' || entry.type === 'island_group') && typeof entry.area_km2 === 'number') {
    return `${entry.area_km2.toLocaleString()} km²`;
  }
  return null;
}

// ── Element ──

class GazetteerElement extends HTMLElement {
  private searchInput: HTMLInputElement | null = null;
  private sortButtons: NodeListOf<HTMLButtonElement> | null = null;
  private mapHintEl: HTMLElement | null = null;
  private statusRowEl: HTMLElement | null = null;
  private listAreaEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  private serviceUrl: string | null = null;
  private allEntries: GazetteerEntry[] = [];
  private searchText = '';
  private sortMode: SortMode = 'name';
  private saveUiStateTimer: number | null = null;

  connectedCallback(): void {
    const template = document.getElementById('gazetteer-widget-template') as HTMLTemplateElement | null;
    if (!template) return;
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(template.content.cloneNode(true));

    this.searchInput = shadow.querySelector('.search-input');
    this.sortButtons = shadow.querySelectorAll('.sort-button');
    this.mapHintEl = shadow.querySelector('.map-hint');
    this.statusRowEl = shadow.querySelector('.status-row');
    this.listAreaEl = shadow.querySelector('.list-area');
    this.statusEl = shadow.querySelector('.status-overlay');

    this.searchInput?.addEventListener('input', () => {
      this.searchText = this.searchInput?.value ?? '';
      this.scheduleSaveUiState();
      this.renderList();
    });

    this.sortButtons?.forEach((button) => {
      button.addEventListener('click', () => {
        const mode = button.dataset.sort as SortMode | undefined;
        if (!mode) return;
        this.sortMode = mode;
        this.syncSortButtons();
        this.scheduleSaveUiState();
        this.renderList();
      });
    });
    this.syncSortButtons();

    void this.init();
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

  private syncSortButtons(): void {
    this.sortButtons?.forEach((button) => {
      button.classList.toggle('active', button.dataset.sort === this.sortMode);
    });
  }

  // ── Startup ──

  private async init(): Promise<void> {
    const desk = window.desk;
    try {
      if (!desk) throw new Error('Desk bridge unavailable');

      this.watchServiceState().catch((err) => {
        console.warn('watching gazetteer service state failed to start:', err);
      });
      this.checkMapWidgetPlaced().catch((err) => {
        console.warn('checking for a placed Natural Earth Map widget failed (best-effort):', err);
      });

      const serviceState = await desk.state.get(SERVICE_STATE_KEY);
      const serviceValue = serviceState.value as { status: string; url: string | null } | null;
      if (!serviceValue || !serviceValue.url) {
        throw new Error(`${SERVICE_NAME} service is not running -- start it from the Microservices widget`);
      }
      this.serviceUrl = serviceValue.url.replace(/\/+$/, '');

      this.setStatus('Loading gazetteer…');
      await this.loadEntries();

      try {
        const { data: localData } = await desk.self.getLocalStorage();
        if (typeof localData.searchText === 'string') {
          this.searchText = localData.searchText;
          if (this.searchInput) this.searchInput.value = this.searchText;
        }
        if (localData.sortMode === 'name' || localData.sortMode === 'type') {
          this.sortMode = localData.sortMode;
          this.syncSortButtons();
        }
      } catch (err) {
        console.warn('restoring saved UI state failed (best-effort, using defaults):', err);
      }

      this.setStatus(null);
      this.renderList();
    } catch (err) {
      this.setStatus(`Failed to load gazetteer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadEntries(): Promise<void> {
    if (!this.serviceUrl) throw new Error('service URL unknown');
    const res = await fetch(`${this.serviceUrl}/list`);
    if (!res.ok) throw new Error(`/list request failed: ${res.status}`);
    const data = (await res.json()) as { entries: GazetteerEntry[]; count: number };
    this.allEntries = data.entries;
  }

  private async checkMapWidgetPlaced(): Promise<void> {
    const desk = window.desk;
    if (!desk || !this.mapHintEl) return;
    const state = await desk.workspace.getState();
    const placed = state.widgets.some((w) => w.widget_id === MAP_WIDGET_ID);
    (this.mapHintEl as HTMLElement).style.display = placed ? 'none' : 'inline';
  }

  // Detects a gazetteer hmsvc restart (a genuinely new URL published to
  // desk.hmsvc.gazetteer) and refreshes in place -- same mechanism and
  // reasoning as natural-earth-map.ts's own watchServiceState.
  private async watchServiceState(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    await desk.events.subscribe(['desk.state.changed']);
    desk.events.onMessage((name, payload) => {
      if (name !== 'desk.state.changed') return;
      void this.handleServiceStateChanged(payload);
    });
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
      await this.loadEntries();
      this.renderList();
    } catch (err) {
      console.warn('handling service restart failed (best-effort, list may need a manual reload):', err);
    }
  }

  // ── Persistence (search text + sort mode only) ──

  private scheduleSaveUiState(): void {
    if (this.saveUiStateTimer !== null) return;
    this.saveUiStateTimer = window.setTimeout(() => {
      this.saveUiStateTimer = null;
      void window.desk?.self.setLocalStorage({ searchText: this.searchText, sortMode: this.sortMode });
    }, 400);
  }

  // ── List rendering ──

  private filteredEntries(): GazetteerEntry[] {
    const needle = this.searchText.trim().toLowerCase();
    if (!needle) return this.allEntries;
    return this.allEntries.filter((e) => e.name.toLowerCase().includes(needle));
  }

  private renderRow(entry: GazetteerEntry): string {
    const color = TYPE_COLORS[entry.type] ?? DEFAULT_TYPE_COLOR;
    const extra = extraInfo(entry);
    return (
      `<div class="entry-row" data-id="${escapeHtml(entry.id)}">` +
      `<span class="entry-name">${escapeHtml(entry.name)}</span>` +
      (extra ? `<span class="entry-extra">${escapeHtml(extra)}</span>` : '') +
      `<span class="entry-type-badge" style="background:${color}">${escapeHtml(humanizeType(entry.type))}</span>` +
      `</div>`
    );
  }

  private renderList(): void {
    if (!this.listAreaEl || !this.statusRowEl) return;
    const entries = this.filteredEntries();

    const totalText = this.searchText.trim()
      ? `${entries.length} of ${this.allEntries.length} places match "${this.searchText.trim()}"`
      : `${this.allEntries.length} places`;
    this.statusRowEl.textContent = totalText;

    if (entries.length === 0) {
      this.listAreaEl.innerHTML = `<div class="empty-state">No places match this search.</div>`;
      return;
    }

    let html: string;
    if (this.sortMode === 'name') {
      const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
      html = sorted.map((e) => this.renderRow(e)).join('');
    } else {
      const groups = new Map<string, GazetteerEntry[]>();
      for (const entry of [...entries].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))) {
        const list = groups.get(entry.type) ?? [];
        list.push(entry);
        groups.set(entry.type, list);
      }
      const parts: string[] = [];
      for (const [type, list] of groups) {
        parts.push(`<div class="type-group-title">${escapeHtml(humanizeType(type))} (${list.length})</div>`);
        parts.push(list.map((e) => this.renderRow(e)).join(''));
      }
      html = parts.join('');
    }
    this.listAreaEl.innerHTML = html;
    this.attachRowHandlers();
  }

  private attachRowHandlers(): void {
    this.listAreaEl?.querySelectorAll<HTMLElement>('.entry-row').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.dataset.id;
        const entry = this.allEntries.find((e) => e.id === id);
        if (entry) this.focusEntry(entry);
      });
    });
  }

  private focusEntry(entry: GazetteerEntry): void {
    void window.desk?.events.publish(FOCUS_EVENT_NAME, { lon: entry.lon, lat: entry.lat, label: entry.name });
    // Re-check in case the user placed the map widget since startup --
    // cheap (one workspace read) and means the hint disappears the
    // first time it would actually matter, not only on the next full
    // page reload of this widget.
    void this.checkMapWidgetPlaced();
  }
}

customElements.define('gazetteer-widget', GazetteerElement);
