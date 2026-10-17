// Contour Connector tab -- phase 6 (the last) of
// plans/samothrace-map-consolidation.md §5 item 3. Ports the standalone
// Contour Connector widget's drag-to-connect interaction as the third
// Q&A tab, kept deliberately self-contained from the plain hover/click
// contours layer (phase 3) -- drag-to-connect only engages while THIS
// tab is the active one (see samothrace-map.ts's own pointer handlers),
// so it can never clash with ordinary monument/contour interaction on
// any other tab.
//
// Reuses samothrace-map-contours-layer.ts's already-loaded fragments
// (via ContoursLayerController.fragmentsFor) rather than fetching a
// second copy of the same *.geojson, and its ScreenPoint/pointDistance
// /distancePointToSegment/distancePointToPolyline helpers (all declared
// there, globally visible here the same way Window.desk's shape is).
//
// One interpretation call on "gets list-style entries too... so it has
// the same 'show me' affordance" (§5, point 3): a flat list of every
// SUGGESTED connection isn't practical here -- there are thousands per
// plan (the whole reason the standalone widget's own canvas-drag/click
// -to-accept/right-click-to-reject interaction exists instead of a list
// in the first place). The list this tab actually renders is of
// CONFIRMED connections (naturally small -- starts empty, grows only as
// you actually connect things), each with its own "Show me" and a
// remove button.
//
// Concatenated after samothrace-map-qa-panel.ts, before
// samothrace-map.ts, in tsconfig.json's own "files" array.

function connectorSuggestedPath(plan: ContourPlan): string {
  return `Data/mapFeatures/SamoWeb_${CONTOUR_PLAN_LABEL[plan]}_Contours.connections.suggested.json`;
}
function connectorConfirmedPath(plan: ContourPlan): string {
  return `Data/mapFeatures/SamoWeb_${CONTOUR_PLAN_LABEL[plan]}_Contours.connections.confirmed.json`;
}
const CONNECTOR_STREAMS_PATH = 'Data/mapFeatures/SamoWeb_ActualStatePlan_Streams.geojson';
const CONNECTOR_LOG_PATH = '.desk_temp/contour-connector-log.json';

type ConnectionSource = 'auto-gap' | 'stream-guided' | 'manual';

interface ConnectorConnection {
  connectionId: string;
  source: ConnectionSource;
  plan: ContourPlan;
  aLon: number;
  aLat: number;
  bLon: number;
  bLat: number;
  elevationM: number | null;
}

interface SuggestedConnectionFile {
  plan: ContourPlan;
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
  plan: ContourPlan;
  connections: Array<{ connectionId: string; source: ConnectionSource; aLon: number; aLat: number; bLon: number; bLat: number; elevationM: number | null }>;
}

interface LogConnection {
  connectionId: string;
  plan: ContourPlan;
  source: ConnectionSource;
  aLon: number;
  aLat: number;
  bLon: number;
  bLat: number;
  elevationM: number | null;
  confirmedAt: string;
  // Set only by samothrace-map-agent-qa-tab.ts's own AgentPatchChannel
  // logic when a patch applied this WITHOUT a user clicking
  // Confirm/Reject -- see investigations/agent-autonomous-corrections
  // -channel.md's own "provenance in the durable files" open question.
  // Absent (not `false`) for every ordinary human-confirmed connection,
  // whether via this tab's own UI or the Agent Q&A tab's Confirm button
  // -- so an older log entry, or any reader that doesn't know this field
  // exists yet (scripts/apply_contour_connections.py included), keeps
  // working unchanged.
  appliedBy?: 'agent-autonomous';
}

interface LogRejection {
  connectionId: string;
  plan: ContourPlan;
  rejectedAt: string;
}

const CONNECTOR_SUGGESTED_COLOR: Record<'auto-gap' | 'stream-guided', string> = { 'auto-gap': '#64748b', 'stream-guided': '#0ea5e9' };
// visibleSuggested() only ever actually holds 'auto-gap'/'stream-guided'
// entries (suggestions are never 'manual' -- that source only exists
// once something's been confirmed), but Connection.source's declared
// type is the wider ConnectionSource (also used for confirmed
// connections) -- same gap the standalone Contour Connector widget's
// own suggestedColorFor already covered.
function connectorSuggestedColorFor(source: ConnectionSource): string {
  return source === 'auto-gap' || source === 'stream-guided' ? CONNECTOR_SUGGESTED_COLOR[source] : '#64748b';
}
const CONNECTOR_INFERRED_COLOR = '#facc15';
const CONNECTOR_ANCHOR_COLOR = '#ffffff';
const CONNECTOR_DRAG_TARGET_COLOR = '#22c55e';
const CONNECTOR_HOVER_COLOR = '#38bdf8';
const CONNECTOR_STREAM_GUIDE_COLOR = '#0ea5e9';

type ConnectorHit = { kind: 'fragment'; plan: ContourPlan; fragmentId: number } | { kind: 'suggested'; idx: number } | { kind: 'confirmed'; idx: number };

interface ConnectDragState {
  anchorPlan: ContourPlan;
  anchorFragmentId: number;
  anchorPoint: { lon: number; lat: number };
  curScreenPoint: ScreenPoint;
  dragTarget: { plan: ContourPlan; fragmentId: number } | null;
}

class ContourConnectorTabController {
  private suggested: ConnectorConnection[] = [];
  private confirmed: ConnectorConnection[] = [];
  private streamGuide: Array<Array<{ lon: number; lat: number }>> = [];
  private rejectedIds = new Set<string>(); // `${plan}:${connectionId}`
  private log: { connections: LogConnection[]; rejections: LogRejection[]; removed: string[] } = { connections: [], rejections: [], removed: [] };
  private loaded = false;

  private hoverTarget: ConnectorHit | null = null;
  private selectedConfirmedIdx: number | null = null;
  private connectDrag: ConnectDragState | null = null;
  private maxSuggestDistPx = 140;
  private showSuggested = true;
  private showConfirmed = true;
  private showStreamGuide = true;

  constructor(
    private readonly recording: RecordingController,
    private readonly onChanged: () => void,
    private readonly scheduleRedraw: () => void,
    private readonly contoursLayer: ContoursLayerController,
    private readonly onShowMeBounds: (bounds: { west: number; south: number; east: number; north: number }) => void,
  ) {}

  async init(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    try {
      const { contents } = await desk.fs.readFile(CONNECTOR_LOG_PATH);
      const parsed = JSON.parse(contents) as { connections?: LogConnection[]; rejections?: LogRejection[]; removed?: string[] };
      this.log = { connections: parsed.connections ?? [], rejections: parsed.rejections ?? [], removed: parsed.removed ?? [] };
    } catch {
      // no log yet -- fine
    }
    for (const r of this.log.rejections) this.rejectedIds.add(`${r.plan}:${r.connectionId}`);

    const plans: ContourPlan[] = ['actual', 'restored'];
    // Separate named promises, awaited individually -- NOT destructured
    // from one combined Promise.all([...]) of heterogeneous types. This
    // project's pinned tsc (3.8.3) has already been found to lose
    // per-position typing in that case (every element gets typed as the
    // union of all three, not its own real type) -- same bug, same fix,
    // as topo-compare.ts/contour-label-review.ts hit earlier.
    const suggestedPromise = Promise.all(plans.map((p) => this.loadJson<SuggestedConnectionFile>(connectorSuggestedPath(p))));
    const confirmedPromise = Promise.all(plans.map((p) => this.loadJson<ConfirmedConnectionFile>(connectorConfirmedPath(p))));
    const streamsPromise = desk.fs.readFile(CONNECTOR_STREAMS_PATH).catch(() => null);
    const suggestedFiles = await suggestedPromise;
    const confirmedFiles = await confirmedPromise;
    const streamsResult = await streamsPromise;

    this.suggested = [];
    suggestedFiles.forEach((file, i) => {
      const plan = plans[i]!;
      if (!file) return;
      for (const c of file.connections) {
        if (this.rejectedIds.has(`${plan}:${c.connectionId}`)) continue;
        this.suggested.push({ connectionId: c.connectionId, source: c.source, plan, aLon: c.aLon, aLat: c.aLat, bLon: c.bLon, bLat: c.bLat, elevationM: c.elevationM });
      }
    });

    const fileConfirmed: ConnectorConnection[] = [];
    confirmedFiles.forEach((file, i) => {
      const plan = plans[i]!;
      if (!file) return;
      for (const c of file.connections) fileConfirmed.push({ connectionId: c.connectionId, source: c.source, plan, aLon: c.aLon, aLat: c.aLat, bLon: c.bLon, bLat: c.bLat, elevationM: c.elevationM });
    });
    // This session's own not-yet-applied confirmations render too, same
    // reasoning the standalone widget's own loadPlan already documented:
    // a human sees what they've connected immediately, without first
    // asking Claude to fold the log into *.connections.confirmed.json.
    const sessionConfirmed: ConnectorConnection[] = this.log.connections.map((c) => ({
      connectionId: c.connectionId,
      source: c.source,
      plan: c.plan,
      aLon: c.aLon,
      aLat: c.aLat,
      bLon: c.bLon,
      bLat: c.bLat,
      elevationM: c.elevationM,
    }));
    const seen = new Set(fileConfirmed.map((c) => c.connectionId));
    const removedSet = new Set(this.log.removed);
    this.confirmed = [...fileConfirmed, ...sessionConfirmed.filter((c) => !seen.has(c.connectionId))].filter((c) => !removedSet.has(c.connectionId));

    this.streamGuide = streamsResult
      ? (JSON.parse(streamsResult.contents) as { features: Array<{ geometry: { coordinates: [number, number][] } }> }).features.map((f) =>
          f.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })),
        )
      : [];

    this.loaded = true;
    this.syncConfirmedToContoursLayer();
    this.onChanged();
    this.scheduleRedraw();
  }

  // Pushes `this.confirmed` (split by plan) into
  // ContoursLayerController.setConfirmedConnections -- see that method's
  // own comment. Called after every mutation of `this.confirmed`
  // (init/commitConnection/acceptSuggestion/removeConfirmed/
  // applyExternalDecision) so hover-grouping across a joined connection
  // stays correct within the same session no matter which of this tab's
  // own actions (or the Agent Q&A tab's) produced the change.
  private syncConfirmedToContoursLayer(): void {
    for (const plan of ['actual', 'restored'] as ContourPlan[]) {
      const list = this.confirmed.filter((c) => c.plan === plan).map((c) => ({ aLon: c.aLon, aLat: c.aLat, bLon: c.bLon, bLat: c.bLat }));
      this.contoursLayer.setConfirmedConnections(plan, list);
    }
  }

  private async loadJson<T>(path: string): Promise<T | null> {
    const desk = window.desk;
    if (!desk) return null;
    try {
      const { contents } = await desk.fs.readFile(path);
      return JSON.parse(contents) as T;
    } catch {
      return null;
    }
  }

  private visibleSuggested(): ConnectorConnection[] {
    if (!this.showSuggested) return [];
    return this.suggested.filter((c) => {
      // distance filter needs screen-independent units -- approximate
      // meters via the same equirectangular approximation this project
      // already uses elsewhere (extract_vector_layers.py's
      // _approx_meters) is overkill here; the slider's own purpose is
      // just "fewer/more suggestions shown," so comparing degrees
      // directly against a px-labeled slider (treated as a relative
      // knob, not a real px measurement once off the standalone
      // widget's own fixed zoom-18 canvas) is good enough.
      const dLon = c.aLon - c.bLon;
      const dLat = c.aLat - c.bLat;
      const approxPx = Math.hypot(dLon * 85000, dLat * 111000) / 0.11; // ~0.11 m/px at zoom 20, this site's own latitude
      return approxPx <= this.maxSuggestDistPx;
    });
  }

  // ── Sidebar ──

  summary(): string {
    if (!this.loaded) return 'Loading…';
    return `${this.confirmed.length} connection(s) confirmed · ${this.visibleSuggested().length} suggestion(s) shown (of ${this.suggested.length})`;
  }

  render(): string {
    if (!this.loaded) return '';
    const confirmedList =
      this.confirmed.length === 0
        ? '<div class="qa-empty">No connections confirmed yet -- drag between two contour fragments on the map, or click a suggested (dashed) connection to accept it.</div>'
        : this.confirmed
            .map((c, idx) => {
              const selected = this.selectedConfirmedIdx === idx;
              return `<div class="qa-card${selected ? ' answered' : ''}" data-idx="${idx}">
          <div class="qa-card-header">
            <span class="qa-plan-chip">${escapeHtml(QA_PLAN_LABEL[c.plan])}</span>
            <button type="button" class="qa-show-me-button qa-cc-show-me-button" data-idx="${idx}">📍 Show me</button>
          </div>
          <div class="qa-ocr-line">${escapeHtml(c.source)}${c.elevationM !== null ? ` — ${c.elevationM}m` : ''}</div>
          <div class="qa-actions">
            <button type="button" class="qa-reject-button qa-cc-remove-button" data-idx="${idx}">🗑 Remove</button>
          </div>
        </div>`;
            })
            .join('');

    return `<div class="qa-cc-toolbar">
      <label class="qa-cc-toggle"><input type="checkbox" class="qa-cc-show-suggested" ${this.showSuggested ? 'checked' : ''} /> Show suggested</label>
      <label class="qa-cc-toggle"><input type="checkbox" class="qa-cc-show-confirmed" ${this.showConfirmed ? 'checked' : ''} /> Show confirmed</label>
      <label class="qa-cc-toggle"><input type="checkbox" class="qa-cc-show-stream-guide" ${this.showStreamGuide ? 'checked' : ''} /> Stream guide (Restored)</label>
      <div class="qa-cc-slider-row">
        <label>Max suggested gap <span class="qa-cc-slider-readout">${this.maxSuggestDistPx}px</span></label>
        <input type="range" class="qa-cc-max-dist" min="10" max="260" step="10" value="${this.maxSuggestDistPx}" />
      </div>
    </div>
    <div class="qa-help-text">Drag from one contour fragment to another (on the map) to connect them. Click a dashed suggested connection to accept it; right-click to dismiss it. Click a confirmed (yellow dashed) connection to select it, Remove to undo.</div>
    <h4 class="qa-cc-list-title">Confirmed this session</h4>
    ${confirmedList}`;
  }

  attachHandlers(container: HTMLElement): void {
    container.querySelector<HTMLInputElement>('.qa-cc-show-suggested')?.addEventListener('change', (e) => {
      this.showSuggested = (e.currentTarget as HTMLInputElement).checked;
      this.onChanged();
      this.scheduleRedraw();
    });
    container.querySelector<HTMLInputElement>('.qa-cc-show-confirmed')?.addEventListener('change', (e) => {
      this.showConfirmed = (e.currentTarget as HTMLInputElement).checked;
      this.onChanged();
      this.scheduleRedraw();
    });
    container.querySelector<HTMLInputElement>('.qa-cc-show-stream-guide')?.addEventListener('change', (e) => {
      this.showStreamGuide = (e.currentTarget as HTMLInputElement).checked;
      this.scheduleRedraw();
    });
    container.querySelector<HTMLInputElement>('.qa-cc-max-dist')?.addEventListener('input', (e) => {
      this.maxSuggestDistPx = Number((e.currentTarget as HTMLInputElement).value);
      const readout = container.querySelector('.qa-cc-slider-readout');
      if (readout) readout.textContent = `${this.maxSuggestDistPx}px`;
      this.onChanged();
      this.scheduleRedraw();
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-cc-show-me-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const c = this.confirmed[idx];
        if (!c) return;
        const west = Math.min(c.aLon, c.bLon);
        const east = Math.max(c.aLon, c.bLon);
        const south = Math.min(c.aLat, c.bLat);
        const north = Math.max(c.aLat, c.bLat);
        this.onShowMeBounds({ west, south, east, north });
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.qa-cc-remove-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        void this.removeConfirmed(idx);
      });
    });
  }

  // ── Map hit-testing (only consulted while this tab is active) ──

  private fragmentHitTest(
    p: ScreenPoint,
    visibleLayers: Set<string>,
    toScreen: (lon: number, lat: number) => ScreenPoint,
    exclude: { plan: ContourPlan; fragmentId: number } | null,
  ): { kind: 'fragment'; plan: ContourPlan; fragmentId: number } | null {
    const TOL = 7;
    let best: { kind: 'fragment'; plan: ContourPlan; fragmentId: number } | null = null;
    let bestDist = TOL;
    for (const plan of ['actual', 'restored'] as ContourPlan[]) {
      if (!visibleLayers.has(`contours:${plan}`)) continue;
      const fragments = this.contoursLayer.fragmentsFor(plan);
      if (!fragments) continue;
      for (const f of fragments) {
        if (exclude && exclude.plan === plan && exclude.fragmentId === f.id) continue;
        const screenPoints = f.points.map((pt) => toScreen(pt.lon, pt.lat));
        const d = distancePointToPolyline(p, screenPoints);
        if (d < bestDist) {
          bestDist = d;
          best = { kind: 'fragment', plan, fragmentId: f.id };
        }
      }
    }
    return best;
  }

  private hitTestAll(p: ScreenPoint, visibleLayers: Set<string>, toScreen: (lon: number, lat: number) => ScreenPoint): ConnectorHit | null {
    // A real fragment always wins over a suggested/confirmed connection
    // line -- same "the thing with real data wins" precedent the main
    // element's own monument-vs-contour hit-testing already uses.
    const fragHit = this.fragmentHitTest(p, visibleLayers, toScreen, null);
    if (fragHit) return fragHit;

    const TOL = 7;
    let best: ConnectorHit | null = null;
    let bestDist = TOL;
    if (this.showConfirmed) {
      this.confirmed.forEach((c, idx) => {
        const d = distancePointToSegment(p, toScreen(c.aLon, c.aLat), toScreen(c.bLon, c.bLat));
        if (d < bestDist) {
          bestDist = d;
          best = { kind: 'confirmed', idx };
        }
      });
    }
    if (!this.connectDrag) {
      this.visibleSuggested().forEach((c, idx) => {
        const d = distancePointToSegment(p, toScreen(c.aLon, c.aLat), toScreen(c.bLon, c.bLat));
        if (d < bestDist) {
          bestDist = d;
          best = { kind: 'suggested', idx };
        }
      });
    }
    return best;
  }

  isDragging(): boolean {
    return this.connectDrag !== null;
  }

  tryStartDrag(p: ScreenPoint, visibleLayers: Set<string>, toScreen: (lon: number, lat: number) => ScreenPoint): boolean {
    const hit = this.fragmentHitTest(p, visibleLayers, toScreen, null);
    if (!hit) return false;
    const fragments = this.contoursLayer.fragmentsFor(hit.plan);
    const frag = fragments?.find((f) => f.id === hit.fragmentId);
    if (!frag || frag.points.length === 0) return false;
    const startPt = frag.points[0]!;
    const endPt = frag.points[frag.points.length - 1]!;
    const startScreen = toScreen(startPt.lon, startPt.lat);
    const endScreen = toScreen(endPt.lon, endPt.lat);
    const anchorPoint = pointDistance(p, startScreen) <= pointDistance(p, endScreen) ? startPt : endPt;
    this.connectDrag = { anchorPlan: hit.plan, anchorFragmentId: hit.fragmentId, anchorPoint, curScreenPoint: p, dragTarget: null };
    this.hoverTarget = hit;
    return true;
  }

  updateDrag(p: ScreenPoint, visibleLayers: Set<string>, toScreen: (lon: number, lat: number) => ScreenPoint): void {
    if (!this.connectDrag) return;
    this.connectDrag.curScreenPoint = p;
    const hit = this.fragmentHitTest(p, visibleLayers, toScreen, { plan: this.connectDrag.anchorPlan, fragmentId: this.connectDrag.anchorFragmentId });
    this.connectDrag.dragTarget = hit?.kind === 'fragment' ? { plan: hit.plan, fragmentId: hit.fragmentId } : null;
  }

  async endDrag(): Promise<void> {
    const drag = this.connectDrag;
    this.connectDrag = null;
    if (drag?.dragTarget) await this.commitConnection(drag);
  }

  cancelDrag(): void {
    this.connectDrag = null;
  }

  updateHover(p: ScreenPoint | null, visibleLayers: Set<string>, toScreen: (lon: number, lat: number) => ScreenPoint): boolean {
    const hit = p ? this.hitTestAll(p, visibleLayers, toScreen) : null;
    if (JSON.stringify(hit) === JSON.stringify(this.hoverTarget)) return false;
    this.hoverTarget = hit;
    return true;
  }

  clearHover(): boolean {
    if (this.hoverTarget === null) return false;
    this.hoverTarget = null;
    return true;
  }

  handleClick(p: ScreenPoint, visibleLayers: Set<string>, toScreen: (lon: number, lat: number) => ScreenPoint): void {
    const hit = this.hitTestAll(p, visibleLayers, toScreen);
    if (!hit) {
      this.selectedConfirmedIdx = null;
      this.onChanged();
      this.scheduleRedraw();
      return;
    }
    if (hit.kind === 'suggested') {
      void this.acceptSuggestion(hit.idx);
      return;
    }
    if (hit.kind === 'confirmed') {
      this.selectedConfirmedIdx = hit.idx;
      this.onChanged();
      this.scheduleRedraw();
    }
  }

  handleRightClick(p: ScreenPoint, visibleLayers: Set<string>, toScreen: (lon: number, lat: number) => ScreenPoint): void {
    if (this.connectDrag) {
      this.cancelDrag();
      this.scheduleRedraw();
      return;
    }
    const hit = this.hitTestAll(p, visibleLayers, toScreen);
    if (hit?.kind === 'suggested') void this.rejectSuggestion(hit.idx);
  }

  // ── Connection actions ──

  private async commitConnection(drag: ConnectDragState): Promise<void> {
    if (!drag.dragTarget) return;
    const anchorFragments = this.contoursLayer.fragmentsFor(drag.anchorPlan);
    const targetFragments = this.contoursLayer.fragmentsFor(drag.dragTarget.plan);
    const anchorFrag = anchorFragments?.find((f) => f.id === drag.anchorFragmentId);
    const targetFrag = targetFragments?.find((f) => f.id === drag.dragTarget!.fragmentId);
    if (!anchorFrag || !targetFrag || targetFrag.points.length === 0) return;
    // Re-pick the anchor's own nearest endpoint to the TARGET fragment
    // (not wherever the drag happened to start), same reasoning the
    // standalone widget's own commitConnection already documented --
    // the connection always spans the true shortest gap.
    const anchorStart = anchorFrag.points[0]!;
    const anchorEnd = anchorFrag.points[anchorFrag.points.length - 1]!;
    const targetNearStart = distancePointToLonLatPolyline(anchorStart, targetFrag.points);
    const targetNearEnd = distancePointToLonLatPolyline(anchorEnd, targetFrag.points);
    const anchorPoint = targetNearStart <= targetNearEnd ? anchorStart : anchorEnd;
    const targetStart = targetFrag.points[0]!;
    const targetEnd = targetFrag.points[targetFrag.points.length - 1]!;
    const targetPoint = distanceLonLat(anchorPoint, targetStart) <= distanceLonLat(anchorPoint, targetEnd) ? targetStart : targetEnd;
    const elevationM = anchorFrag.elevationM ?? targetFrag.elevationM ?? null;

    const entry: LogConnection = {
      connectionId: `manual-${drag.anchorPlan}-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      plan: drag.anchorPlan,
      source: 'manual',
      aLon: anchorPoint.lon,
      aLat: anchorPoint.lat,
      bLon: targetPoint.lon,
      bLat: targetPoint.lat,
      elevationM,
      confirmedAt: new Date().toISOString(),
    };
    this.log.connections.push(entry);
    this.confirmed.push({ connectionId: entry.connectionId, source: 'manual', plan: drag.anchorPlan, aLon: entry.aLon, aLat: entry.aLat, bLon: entry.bLon, bLat: entry.bLat, elevationM });
    this.syncConfirmedToContoursLayer();
    const loggedToRecording = this.recording.log('qa:contour-connector', 'connection', entry);
    if (!loggedToRecording) await this.writeLogFile();
    this.onChanged();
    this.scheduleRedraw();
  }

  private async acceptSuggestion(idx: number): Promise<void> {
    const c = this.visibleSuggested()[idx];
    if (!c) return;
    const entry: LogConnection = { connectionId: c.connectionId, plan: c.plan, source: c.source, aLon: c.aLon, aLat: c.aLat, bLon: c.bLon, bLat: c.bLat, elevationM: c.elevationM, confirmedAt: new Date().toISOString() };
    this.log.connections.push(entry);
    this.confirmed.push({ ...c });
    this.suggested = this.suggested.filter((s) => s.connectionId !== c.connectionId);
    this.syncConfirmedToContoursLayer();
    const loggedToRecording = this.recording.log('qa:contour-connector', 'accept-suggestion', entry);
    if (!loggedToRecording) await this.writeLogFile();
    this.onChanged();
    this.scheduleRedraw();
  }

  private async rejectSuggestion(idx: number): Promise<void> {
    const c = this.visibleSuggested()[idx];
    if (!c) return;
    this.rejectedIds.add(`${c.plan}:${c.connectionId}`);
    const rejection: LogRejection = { connectionId: c.connectionId, plan: c.plan, rejectedAt: new Date().toISOString() };
    this.log.rejections.push(rejection);
    this.suggested = this.suggested.filter((s) => s.connectionId !== c.connectionId);
    const loggedToRecording = this.recording.log('qa:contour-connector', 'reject-suggestion', rejection);
    if (!loggedToRecording) await this.writeLogFile();
    this.onChanged();
    this.scheduleRedraw();
  }

  // Called by AgentQaTabController immediately after IT durably writes a
  // 'confirm-connection' answer into this controller's own
  // CONNECTOR_LOG_PATH -- keeps this controller's already-loaded
  // suggested/confirmed/rejectedIds (and its own in-memory `log` mirror,
  // same one removeConfirmed/init read) in sync within the same session,
  // without a reload. Deliberately does NOT write CONNECTOR_LOG_PATH
  // itself (the caller already did) or call this.recording.log (the
  // caller already logged one informational entry under its own
  // 'qa:agent' source) -- this method's only job is the in-memory half,
  // so switching to this tab afterward (or hovering/clicking the real
  // fragments elsewhere) reflects the decision immediately rather than
  // only after a reload. "Local data structures... act like it has
  // always been fixed" (the user's own framing, 2026-10-14) for this
  // tab specifically.
  applyExternalDecision(
    data: { connectionId: string; plan: ContourPlan; source: ConnectionSource; aLon: number; aLat: number; bLon: number; bLat: number; elevationM: number | null },
    decision: 'confirm' | 'reject',
  ): void {
    this.suggested = this.suggested.filter((s) => s.connectionId !== data.connectionId);
    if (decision === 'confirm') {
      if (!this.confirmed.some((c) => c.connectionId === data.connectionId)) {
        const entry: LogConnection = { ...data, confirmedAt: new Date().toISOString() };
        this.log.connections.push(entry);
        this.confirmed.push({ connectionId: data.connectionId, source: data.source, plan: data.plan, aLon: data.aLon, aLat: data.aLat, bLon: data.bLon, bLat: data.bLat, elevationM: data.elevationM });
        this.syncConfirmedToContoursLayer();
      }
    } else {
      this.rejectedIds.add(`${data.plan}:${data.connectionId}`);
      if (!this.log.rejections.some((r) => r.connectionId === data.connectionId)) {
        this.log.rejections.push({ connectionId: data.connectionId, plan: data.plan, rejectedAt: new Date().toISOString() });
      }
    }
    this.onChanged();
    this.scheduleRedraw();
  }

  // Public wrapper for AgentQaTabController's own Undo handler
  // (samothrace-map-agent-qa-tab.ts) -- connections are confirmed/
  // removed by connectionId everywhere else in this project (position
  // -keyed, see this widget's own AGENTS.md), so the caller has no
  // index into `this.confirmed` to give us; this just finds it and
  // delegates to the same removeConfirmed(idx) the tab's own UI "Remove"
  // button already calls, rather than duplicating its body.
  async removeConfirmedById(connectionId: string): Promise<void> {
    const idx = this.confirmed.findIndex((c) => c.connectionId === connectionId);
    if (idx === -1) return;
    await this.removeConfirmed(idx);
  }

  private async removeConfirmed(idx: number): Promise<void> {
    const c = this.confirmed[idx];
    if (!c) return;
    this.confirmed = this.confirmed.filter((x) => x.connectionId !== c.connectionId);
    this.log.connections = this.log.connections.filter((x) => x.connectionId !== c.connectionId);
    if (!this.log.removed.includes(c.connectionId)) this.log.removed.push(c.connectionId);
    if (this.selectedConfirmedIdx === idx) this.selectedConfirmedIdx = null;
    this.syncConfirmedToContoursLayer();
    const loggedToRecording = this.recording.log('qa:contour-connector', 'remove-confirmed', { connectionId: c.connectionId, plan: c.plan });
    if (!loggedToRecording) await this.writeLogFile();
    this.onChanged();
    this.scheduleRedraw();
  }

  private async writeLogFile(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    await desk.fs.writeFile(CONNECTOR_LOG_PATH, JSON.stringify(this.log, null, 2));
  }

  // ── Drawing ──

  // Called UNCONDITIONALLY every redraw (see samothrace-map.ts's own
  // render method), regardless of which Q&A tab is active -- unlike
  // everything else this file draws (suggested connections, the live
  // drag line, anchor/hover overdraw), a CONFIRMED connection is a
  // settled fact, not part of this tab's own interactive workflow. Per
  // 2026-10-14 feedback: after confirming `restored-auto-gap-100` via
  // the Agent Q&A tab, the two fragments it joins still looked like two
  // separate pieces rather than "one contour" while sitting on any tab
  // OTHER than this one -- because this line used to only draw as part
  // of draw() below, which is itself gated to `activeQaTab ===
  // 'contour-connector'`. Naturally small (starts empty, only grows as
  // connections actually get made), so no real "clutters every tab"
  // cost the way always-showing the (thousands-per-plan) suggested list
  // would have.
  drawConfirmed(ctx: CanvasRenderingContext2D, toScreen: (lon: number, lat: number) => ScreenPoint): void {
    if (!this.showConfirmed) return;
    this.confirmed.forEach((c, idx) => {
      const isHover = !this.connectDrag && this.hoverTarget?.kind === 'confirmed' && this.hoverTarget.idx === idx;
      const isSelected = this.selectedConfirmedIdx === idx;
      this.strokeDashed(ctx, [{ lon: c.aLon, lat: c.aLat }, { lon: c.bLon, lat: c.bLat }], toScreen, CONNECTOR_INFERRED_COLOR, isSelected ? 4 : isHover ? 3 : 2.2, [10, 6]);
    });
  }

  // Only called while this tab is active (see samothrace-map.ts's own
  // redraw) -- the rest of this tab's own interactive state: suggested
  // connections, the live drag line, anchor/drag-target/hover overdraw,
  // the stream guide. Confirmed connections are drawn separately, above,
  // by drawConfirmed -- NOT also here, to avoid a double-draw on the one
  // tab where both get called.
  //
  // No visibleLayers param, unlike every other draw()/hitTest() method
  // in this file -- this one genuinely never needs it: it only ever
  // overdraws a fragment the caller already resolved by explicit
  // (plan, fragmentId) (anchor/drag-target/hover), plus this tab's own
  // suggested connection lines, neither of which is gated by which
  // hmsvc/contours layers happen to be toggled on.
  draw(ctx: CanvasRenderingContext2D, toScreen: (lon: number, lat: number) => ScreenPoint): void {
    if (this.showStreamGuide) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      for (const line of this.streamGuide) this.strokeDashed(ctx, line, toScreen, CONNECTOR_STREAM_GUIDE_COLOR, 2, [2, 3]);
      ctx.restore();
    }

    // Overdraw the anchor/drag-target/hover fragment on top of
    // ContoursLayerController's own already-drawn, normal-colored line
    // -- that controller's own hover is cleared while this tab is
    // active (see samothrace-map.ts), so there's nothing to conflict
    // with here.
    if (this.connectDrag) {
      this.overdrawFragment(ctx, this.connectDrag.anchorPlan, this.connectDrag.anchorFragmentId, toScreen, CONNECTOR_ANCHOR_COLOR, 3.5);
      if (this.connectDrag.dragTarget) this.overdrawFragment(ctx, this.connectDrag.dragTarget.plan, this.connectDrag.dragTarget.fragmentId, toScreen, CONNECTOR_DRAG_TARGET_COLOR, 3.5);
    } else {
      // Captured into a local first, not accessed as `this.hoverTarget.*`
      // directly after the kind check -- this project's pinned tsc
      // (3.8.3) doesn't narrow a class field's type through optional
      // chaining the way a local variable gets narrowed.
      const hover = this.hoverTarget;
      if (hover && hover.kind === 'fragment') {
        this.overdrawFragment(ctx, hover.plan, hover.fragmentId, toScreen, CONNECTOR_HOVER_COLOR, 2.6);
      }
    }

    if (this.showSuggested) {
      this.visibleSuggested().forEach((c, idx) => {
        const isHover = !this.connectDrag && this.hoverTarget?.kind === 'suggested' && this.hoverTarget.idx === idx;
        ctx.save();
        ctx.globalAlpha = isHover ? 0.95 : 0.55;
        this.strokeDashed(ctx, [{ lon: c.aLon, lat: c.aLat }, { lon: c.bLon, lat: c.bLat }], toScreen, connectorSuggestedColorFor(c.source), isHover ? 2.5 : 1.4, c.source === 'stream-guided' ? [2, 6] : [4, 4]);
        ctx.restore();
      });
    }

    if (this.connectDrag) {
      const anchorScreen = toScreen(this.connectDrag.anchorPoint.lon, this.connectDrag.anchorPoint.lat);
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(anchorScreen.x, anchorScreen.y);
      ctx.lineTo(this.connectDrag.curScreenPoint.x, this.connectDrag.curScreenPoint.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  private overdrawFragment(ctx: CanvasRenderingContext2D, plan: ContourPlan, fragmentId: number, toScreen: (lon: number, lat: number) => ScreenPoint, color: string, width: number): void {
    const fragments = this.contoursLayer.fragmentsFor(plan);
    const frag = fragments?.find((f) => f.id === fragmentId);
    if (!frag || frag.points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    frag.points.forEach((p, i) => {
      const sp = toScreen(p.lon, p.lat);
      if (i === 0) ctx.moveTo(sp.x, sp.y);
      else ctx.lineTo(sp.x, sp.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  private strokeDashed(
    ctx: CanvasRenderingContext2D,
    points: Array<{ lon: number; lat: number }>,
    toScreen: (lon: number, lat: number) => ScreenPoint,
    color: string,
    width: number,
    dash: number[],
  ): void {
    if (points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(dash);
    ctx.beginPath();
    points.forEach((p, i) => {
      const sp = toScreen(p.lon, p.lat);
      if (i === 0) ctx.moveTo(sp.x, sp.y);
      else ctx.lineTo(sp.x, sp.y);
    });
    ctx.stroke();
    ctx.restore();
  }
}

// Plain lon/lat distance helpers for commitConnection's own
// nearest-endpoint math -- deliberately NOT screen-space (unlike this
// file's other distance helpers, reused from samothrace-map-contours
// -layer.ts), since picking which real endpoint to splice at shouldn't
// depend on whatever zoom level the connection happened to be drawn at.
function distanceLonLat(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  return Math.hypot(a.lon - b.lon, a.lat - b.lat);
}

function distancePointToLonLatPolyline(p: { lon: number; lat: number }, points: Array<{ lon: number; lat: number }>): number {
  let min = Infinity;
  for (const q of points) {
    const d = distanceLonLat(p, q);
    if (d < min) min = d;
  }
  return min;
}
