// Final contours layer -- phase 3 of plans/samothrace-map-consolidation.md
// §4.2. The pipeline's real output (Data/mapFeatures/SamoWeb_<Plan>
// _Contours.geojson), not a debug snapshot -- major (OCR'd/confirmed
// index label) vs minor (interpolated 1m band) vs unlabeled, same
// three-shade palette already established in TopoCompare/Contour
// Connector/the pipeline-stage PNGs. Hover highlights the nearest
// fragment; a click "registers" it -- logs a timestamped interaction to
// the active recording (a no-op otherwise, per that plan section: "not
// specified yet; start with log-only").
//
// Concatenated after samothrace-map-stage-layers.ts, before
// samothrace-map.ts, in tsconfig.json's own "files" array (global
// scripts, no import/export). Window.desk's shape is declared once, in
// samothrace-map-recording.ts -- this file only uses `fs` (already
// declared there), nothing new to add.

type ContourPlan = 'actual' | 'restored';

const CONTOUR_PLAN_LABEL: Record<ContourPlan, string> = { actual: 'ActualStatePlan', restored: 'RestoredStatePlan' };

function contourGeojsonPath(plan: ContourPlan): string {
  return `Data/mapFeatures/SamoWeb_${CONTOUR_PLAN_LABEL[plan]}_Contours.geojson`;
}

// Purely namespacing in the shared visibleLayers set, same convention
// and same reasoning as STAGE_LAYER_PREFIX in samothrace-map-stage
// -layers.ts -- see that constant's own comment.
const CONTOURS_LAYER_PREFIX = 'contours:';

function contoursLayerId(plan: ContourPlan): string {
  return `${CONTOURS_LAYER_PREFIX}${plan}`;
}

// Three shades, not one -- kept in sync with the same palette
// TopoCompare/Contour Connector/extract_vector_layers.py's own
// save_stage_fragments already use (see any of those for the "please
// use different shades to distinguish between recognized major and
// minor contours" background).
const CONTOUR_COLOR = { major: '#c026d3', minor: '#f59e0b', unlabeled: '#94a3b8' } as const;

interface ContourFragment {
  id: number; // this load's own array index -- see loadFragments's own comment on why that's fine for a short-lived recording-log correlation but not persisted anywhere durable
  points: Array<{ lon: number; lat: number }>; // kept in lon/lat, same as the monument overlay polygons -- projected to screen at draw/hit-test time, so it stays correct across zoom/pan with no re-fetch
  elevationM: number | null;
  elevationSource: string | null;
}

interface GeoJsonLineFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  properties: { elevation_m: number | null; elevation_source?: string | null };
}

function contourColorFor(f: ContourFragment): string {
  if (f.elevationSource === 'ocr' || f.elevationSource === 'review-confirmed') return CONTOUR_COLOR.major;
  if (f.elevationSource === 'interpolated') return CONTOUR_COLOR.minor;
  return CONTOUR_COLOR.unlabeled;
}

// Screen-space point/segment/polyline distance -- same shape as Contour
// Connector's own distancePointToSegment/distancePointToPolyline (that
// widget's own hit-testing for the same kind of data), reused here
// rather than re-derived differently.
interface ScreenPoint {
  x: number;
  y: number;
}

function pointDistance(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distancePointToSegment(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return pointDistance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return pointDistance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function distancePointToPolyline(p: ScreenPoint, points: ScreenPoint[]): number {
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const d = distancePointToSegment(p, points[i]!, points[i + 1]!);
    if (d < min) min = d;
  }
  return min;
}

// How close (screen px) a hover/click needs to land to a fragment's own
// line to count -- a flat tolerance, not zoom-scaled: unlike Contour
// Connector's own single always-zoomable canvas, this map's "zoom" is a
// discrete tile level the user picks, so a fixed pixel budget (matching
// EDIT_CLICK_TOLERANCE_PX elsewhere in this project) behaves
// consistently regardless of which zoom level is currently showing.
const HIT_TOLERANCE_PX = 7;

// How long the pointer has to settle on the same fragment before a hover
// gets logged to the active recording -- see TODO.md's "hover isn't
// logged" entry. Unthrottled (logging on every hoverKey change) would
// spam one entry per fragment the pointer merely swept across while
// moving toward wherever the user was actually about to stop and talk
// about; a short dwell means only "the user paused here" moments get
// logged, which is what's actually useful for lining a hover position up
// against a narration transcript. Not configurable -- 400ms reads as a
// deliberate point, not a sweep, without feeling laggy.
const HOVER_LOG_DWELL_MS = 400;

interface ContourHit {
  plan: ContourPlan;
  fragment: ContourFragment;
}

// Alternating two-color stroke, white paired with whichever accent
// color the caller gives it -- a solid accent color (the "Show me"
// highlight was originally solid yellow) didn't read clearly over every
// combination of base layer, so this draws the same path twice with an
// identical dash pattern, the second pass's dash offset shifted by
// exactly one segment length: wherever pass one is "off" (the gap),
// pass two is "on," so the two together cover the whole line with no
// actual gaps -- alternating segments butted right up against each
// other, not a normal dashed line with visible background showing
// through between dashes. Used for both the "Show me" highlight (red)
// and plain hover (blue) -- a solid white hover, tried first, had the
// exact same "doesn't read over every base layer" problem the solid
// yellow highlight did.
function strokeCandyCane(
  ctx: CanvasRenderingContext2D,
  points: Array<{ lon: number; lat: number }>,
  toScreen: (lon: number, lat: number) => ScreenPoint,
  lineWidth: number,
  accentColor: string,
): void {
  const segment = Math.max(6, lineWidth * 2);
  const tracePath = (): void => {
    ctx.beginPath();
    points.forEach((p, i) => {
      const sp = toScreen(p.lon, p.lat);
      if (i === 0) ctx.moveTo(sp.x, sp.y);
      else ctx.lineTo(sp.x, sp.y);
    });
  };
  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt'; // crisp segment boundaries -- 'round' would blur where the two colors meet
  ctx.setLineDash([segment, segment]);

  ctx.lineDashOffset = 0;
  ctx.strokeStyle = '#ffffff';
  tracePath();
  ctx.stroke();

  ctx.lineDashOffset = segment;
  ctx.strokeStyle = accentColor;
  tracePath();
  ctx.stroke();

  ctx.restore();
}

const HIGHLIGHT_COLOR = '#dc2626'; // red/white -- "Show me" (confirm/skip's own highlight)
const HOVER_COLOR = '#2563eb'; // blue/white -- plain hover

// Plain west/south/east/north box -- structurally the same shape as
// samothrace-map.ts's own LonLatBounds (that interface isn't visible
// here as a named type -- no import/export in these global-script files
// -- but TS structural typing accepts this fine at the call site).
interface FragmentBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

class ContoursLayerController {
  // Two caches, not one: `loaders` memoizes the actual fetch (so
  // ensureLoaded, used by the async "Show me" path, can simply await
  // it); `resolved` is the synchronously-readable result draw()/hitTest()
  // use -- neither of those may ever await mid-call, same reasoning
  // samothrace-map-stage-layers.ts's own bounds cache documents.
  private loaders = new Map<ContourPlan, Promise<ContourFragment[] | null>>();
  private resolved = new Map<ContourPlan, ContourFragment[] | null>();
  private hoverKey: string | null = null; // `${plan}:${fragment.id}`
  private hoverLogTimer: number | null = null; // pending HOVER_LOG_DWELL_MS timer for the CURRENT hoverKey, if any
  private highlight: { plan: ContourPlan; fragmentIds: Set<number>; clearTimer: number } | null = null;
  // Confirmed-connection-derived grouping, so hovering ANY fragment in a
  // joined pair (or longer chain) highlights the whole thing as one
  // contour, not just the specific fragment under the cursor -- added
  // 2026-10-14 after feedback that a freshly-confirmed connection "is
  // not acting like a single contour line" on hover. Raw connections are
  // stored as-is (set by ContourConnectorTabController.
  // syncConfirmedToContoursLayer, called whenever its own `confirmed`
  // list changes); `groupIdByFragment` is derived from them via union
  // -find over real fragment endpoints, rebuilt wholesale on every
  // change rather than incrementally patched -- cheap at this project's
  // scale (hundreds of fragments, a handful of confirmed connections).
  private confirmedConnectionsByPlan = new Map<ContourPlan, Array<{ aLon: number; aLat: number; bLon: number; bLat: number }>>();
  private groupIdByFragment = new Map<string, string>(); // `${plan}:${fragmentId}` -> `${plan}:${rootFragmentId}` -- only entries for fragments actually in a >1-member group; a fragment with no entry here is its own ungrouped singleton
  // Session-local color override for a fragment confirmed via the Minor
  // Bands tab -- `scripts/apply_minor_review.py` doesn't exist yet (see
  // this widget's own TODO.md), so without this a confirmed answer
  // would correctly get recorded to `.desk_temp/minor-contour-review
  // -log.json` but never visually turn amber. Same "local data
  // structures act like it has always been fixed" stopgap
  // setConfirmedConnections already does for hover-grouping, applied to
  // color/elevation instead. Keyed `${plan}:${fragmentId}` -> the
  // confirmed elevation (only ever used to pick the minor/amber color at
  // draw time, see effectiveColorFor -- this widget never writes a
  // *different* source like "major" through this path, so there's no
  // need to store more than the bare number).
  private elevationOverrides = new Map<string, number>();

  constructor(
    private readonly recording: RecordingController,
    private readonly scheduleRedraw: () => void,
  ) {}

  // One row per plan, meant to be interleaved into that SAME plan's
  // existing "Actual State"/"Restored State" layer-panel group (this is
  // real map content, unlike the pipeline-stage debug layers, which get
  // their own separate groups) -- see buildLayersPanel's own call site.
  rowFor(plan: ContourPlan): { id: string; label: string } {
    return { id: contoursLayerId(plan), label: 'Extracted contours' };
  }

  // Awaitable load, memoized per plan -- used by the Q&A panel's "Show
  // me" (needs a real position before it can pan/zoom, so it must wait
  // for the fetch) as well as internally by getFragments below (fire
  // -and-forget, for the synchronous draw/hitTest path).
  private ensureLoaded(plan: ContourPlan): Promise<ContourFragment[] | null> {
    let promise = this.loaders.get(plan);
    if (!promise) {
      promise = (async () => {
        const desk = window.desk;
        if (!desk) return null;
        try {
          const { contents } = await desk.fs.readFile(contourGeojsonPath(plan));
          const geojson = JSON.parse(contents) as { features: GeoJsonLineFeature[] };
          const fragments: ContourFragment[] = geojson.features.map((f, id) => ({
            id,
            points: f.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })),
            elevationM: f.properties.elevation_m,
            elevationSource: f.properties.elevation_source ?? null,
          }));
          return fragments;
        } catch {
          return null;
        }
      })();
      this.loaders.set(plan, promise);
      void promise.then((fragments) => {
        this.resolved.set(plan, fragments);
        // In case setConfirmedConnections was already called for this
        // plan before fragments finished loading (rebuildGroups bails
        // out with nothing to do until fragments actually exist) --
        // retry now that they do.
        this.rebuildGroups(plan);
        this.scheduleRedraw();
      });
    }
    return promise;
  }

  // Public wrapper for samothrace-map-connector-tab.ts (phase 6) -- the
  // Contour Connector tab's drag-to-connect interaction works against
  // these SAME fragments (kicks off the same lazy load if not cached
  // yet), rather than fetching its own separate copy of the same file.
  fragmentsFor(plan: ContourPlan): ContourFragment[] | null {
    return this.getFragments(plan);
  }

  private getFragments(plan: ContourPlan): ContourFragment[] | null {
    if (!this.resolved.has(plan)) {
      void this.ensureLoaded(plan); // kick off the load; this call returns null until it resolves
      return null;
    }
    return this.resolved.get(plan) ?? null;
  }

  // Bounding box of the given fragment ids, awaiting a load if this
  // plan's contours haven't been fetched yet -- for the Q&A panel's
  // "Show me" button (plans/samothrace-map-consolidation.md §5.1).
  async showMeBounds(plan: ContourPlan, fragmentIds: number[]): Promise<FragmentBounds | null> {
    const fragments = await this.ensureLoaded(plan);
    if (!fragments) return null;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    let any = false;
    for (const id of fragmentIds) {
      const f = fragments[id];
      if (!f) continue;
      for (const p of f.points) {
        any = true;
        if (p.lon < west) west = p.lon;
        if (p.lon > east) east = p.lon;
        if (p.lat < south) south = p.lat;
        if (p.lat > north) north = p.lat;
      }
    }
    return any ? { west, south, east, north } : null;
  }

  // Highlights the given fragments (bright, thick, distinct from every
  // other state) for durationMs, then automatically reverts -- the
  // "highlight the specific questioned feature(s)" part of "Show me"
  // (§5.1 step 3; that section leaves the exact animation as an
  // implementation detail -- this is a plain sustained highlight, no
  // pulsing, the simplest thing that satisfies "distinctly from normal
  // hover styling").
  highlightFragments(plan: ContourPlan, fragmentIds: number[], durationMs: number): void {
    if (this.highlight) clearTimeout(this.highlight.clearTimer);
    const clearTimer = (setTimeout(() => {
      this.highlight = null;
      this.scheduleRedraw();
    }, durationMs) as unknown) as number;
    this.highlight = { plan, fragmentIds: new Set(fragmentIds), clearTimer };
    this.scheduleRedraw();
  }

  // Called by ContourConnectorTabController (samothrace-map-connector
  // -tab.ts) whenever its own `confirmed` list changes -- see that
  // controller's own syncConfirmedToContoursLayer. Replaces this plan's
  // entire confirmed-connections list wholesale (not an incremental
  // patch) and rebuilds the hover grouping from scratch; cheap at this
  // project's scale.
  setConfirmedConnections(plan: ContourPlan, connections: Array<{ aLon: number; aLat: number; bLon: number; bLat: number }>): void {
    this.confirmedConnectionsByPlan.set(plan, connections);
    this.rebuildGroups(plan);
    this.scheduleRedraw();
  }

  // Union-find over this plan's own fragments, joining two fragments
  // whenever a confirmed connection's own endpoint matches one of each
  // fragment's two real endpoints (exact-ish float match is expected --
  // a connection's aLon/aLat/bLon/bLat are copied directly from the
  // fragment endpoint coordinates that produced it, never independently
  // re-measured). A plain O(fragments × connections) endpoint scan, not
  // an index -- both sides of that product are small here (hundreds of
  // fragments, a handful of confirmed connections), not worth a spatial
  // index for.
  private rebuildGroups(plan: ContourPlan): void {
    const fragments = this.resolved.get(plan);
    // Bail without touching this plan's existing groupIdByFragment
    // entries if fragments haven't loaded yet -- ensureLoaded's own
    // `.then` hook calls this again once they have, so this isn't lost,
    // just deferred.
    if (!fragments) return;
    const connections = this.confirmedConnectionsByPlan.get(plan) ?? [];

    const parent = new Map<number, number>();
    for (const f of fragments) parent.set(f.id, f.id);
    const find = (x: number): number => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let cur = x;
      while (parent.get(cur) !== root) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    const EPS = 1e-7; // ~1cm at this site's latitude -- generous given the "copied directly" expectation above, tight enough never to falsely bridge two genuinely different fragments that just happen to pass close together
    const fragmentIdAtEndpoint = (lon: number, lat: number): number | null => {
      for (const f of fragments) {
        if (f.points.length === 0) continue;
        const start = f.points[0]!;
        const end = f.points[f.points.length - 1]!;
        if (Math.abs(start.lon - lon) < EPS && Math.abs(start.lat - lat) < EPS) return f.id;
        if (Math.abs(end.lon - lon) < EPS && Math.abs(end.lat - lat) < EPS) return f.id;
      }
      return null;
    };
    for (const c of connections) {
      const aId = fragmentIdAtEndpoint(c.aLon, c.aLat);
      const bId = fragmentIdAtEndpoint(c.bLon, c.bLat);
      if (aId !== null && bId !== null && aId !== bId) union(aId, bId);
    }

    for (const key of Array.from(this.groupIdByFragment.keys())) {
      if (key.startsWith(`${plan}:`)) this.groupIdByFragment.delete(key);
    }
    const membersByRoot = new Map<number, number[]>();
    for (const f of fragments) {
      const root = find(f.id);
      const members = membersByRoot.get(root) ?? [];
      members.push(f.id);
      membersByRoot.set(root, members);
    }
    for (const [root, members] of membersByRoot) {
      if (members.length < 2) continue; // no entry needed for an ungrouped singleton
      for (const id of members) this.groupIdByFragment.set(`${plan}:${id}`, `${plan}:${root}`);
    }
  }

  // Whether `fragmentId` should render with hover styling given the
  // CURRENTLY hovered fragment (this.hoverKey) -- true for the exact
  // fragment under the cursor, AND for every other fragment in the same
  // confirmed-connection group, so hovering either half of a newly
  // -joined connection highlights the whole thing as one contour rather
  // than just whichever half the cursor happens to sit over.
  private isHoverGroupMember(plan: ContourPlan, fragmentId: number): boolean {
    if (this.hoverKey === null) return false;
    const key = `${plan}:${fragmentId}`;
    if (this.hoverKey === key) return true;
    const hoveredGroup = this.groupIdByFragment.get(this.hoverKey);
    if (hoveredGroup === undefined) return false;
    return this.groupIdByFragment.get(key) === hoveredGroup;
  }

  // Called by MinorBandsTabController (samothrace-map-qa-panel.ts)
  // whenever it confirms a group -- both for a brand-new confirmation
  // during this live session, and (via its own init()) for every
  // already-confirmed answer loaded from disk, so a reload reflects
  // prior confirmations too, not just ones made after the reload.
  // Fragments marked "not a contour" (elevationM null) are never passed
  // here -- there's nothing to recolor for those.
  setFragmentElevationOverrides(plan: ContourPlan, overrides: Array<{ fragmentId: number; elevationM: number }>): void {
    for (const o of overrides) this.elevationOverrides.set(`${plan}:${o.fragmentId}`, o.elevationM);
    this.scheduleRedraw();
  }

  // Reverse of the above -- called by AgentQaTabController's own Undo
  // handler (samothrace-map-agent-qa-tab.ts) when a 'confirm-minor-band'
  // patch gets undone: the override goes away, the fragment reverts to
  // whatever contourColorFor would show for its real (still-unlabeled)
  // *.geojson data, same as if it had never been confirmed at all.
  clearFragmentElevationOverrides(plan: ContourPlan, fragmentIds: number[]): void {
    for (const id of fragmentIds) this.elevationOverrides.delete(`${plan}:${id}`);
    this.scheduleRedraw();
  }

  // contourColorFor plus the session-local override above -- a
  // confirmed minor-band fragment always renders as CONTOUR_COLOR.minor
  // regardless of what the static *.geojson on disk still says, since
  // this widget never writes anything but a minor/interpolated
  // confirmation through this path (see elevationOverrides's own
  // comment on why only the color needs overriding, not a full
  // ContourFragment).
  private effectiveColorFor(plan: ContourPlan, f: ContourFragment): string {
    if (this.elevationOverrides.has(`${plan}:${f.id}`)) return CONTOUR_COLOR.minor;
    return contourColorFor(f);
  }

  // Every plan whose own contours layer is currently visible -- hover
  // /click hit-testing only considers a plan's fragments while its own
  // layer is actually shown, same "can't select what you can't see"
  // principle isOverlayInteractive already applies to monuments.
  private visiblePlans(visibleLayers: Set<string>): ContourPlan[] {
    return (['actual', 'restored'] as ContourPlan[]).filter((p) => visibleLayers.has(contoursLayerId(p)));
  }

  hitTest(
    screenPoint: ScreenPoint,
    visibleLayers: Set<string>,
    toScreen: (lon: number, lat: number) => ScreenPoint,
  ): ContourHit | null {
    let best: ContourHit | null = null;
    let bestDist = HIT_TOLERANCE_PX;
    for (const plan of this.visiblePlans(visibleLayers)) {
      const fragments = this.getFragments(plan);
      if (!fragments) continue;
      for (const fragment of fragments) {
        const screenPoints = fragment.points.map((p) => toScreen(p.lon, p.lat));
        const d = distancePointToPolyline(screenPoint, screenPoints);
        if (d < bestDist) {
          bestDist = d;
          best = { plan, fragment };
        }
      }
    }
    return best;
  }

  // Updates hover state from the current pointer position; returns
  // whether it actually changed (so the caller only redraws when it
  // needs to, same pattern the main element's own monument hover
  // already uses). Also (re)starts the dwell timer that logs a 'hover'
  // entry to the active recording once the pointer has sat still on this
  // fragment for HOVER_LOG_DWELL_MS -- see that constant's own comment.
  updateHover(hit: ContourHit | null): boolean {
    const key = hit ? `${hit.plan}:${hit.fragment.id}` : null;
    if (key === this.hoverKey) return false;
    this.hoverKey = key;
    if (this.hoverLogTimer !== null) {
      clearTimeout(this.hoverLogTimer);
      this.hoverLogTimer = null;
    }
    if (hit && this.recording.isRecording) {
      this.hoverLogTimer = (setTimeout(() => {
        this.hoverLogTimer = null;
        this.recording.log('contours-layer', 'hover', this.logPayloadFor(hit));
      }, HOVER_LOG_DWELL_MS) as unknown) as number;
    }
    return true;
  }

  clearHover(): boolean {
    return this.updateHover(null);
  }

  // Shared by the hover dwell timer and registerClick below -- same
  // entry shape for both, only `type` in the caller's own recording.log
  // call differs, so an agent reading the log back can tell a settled
  // point from a deliberate click at the same spot.
  private logPayloadFor(hit: ContourHit): Record<string, unknown> {
    const p = hit.fragment.points[Math.floor(hit.fragment.points.length / 2)];
    return {
      plan: hit.plan,
      fragmentId: hit.fragment.id,
      elevationM: hit.fragment.elevationM,
      elevationSource: hit.fragment.elevationSource,
      lon: p?.lon ?? null,
      lat: p?.lat ?? null,
    };
  }

  // "Registers" a click -- logs it to the active recording (a no-op,
  // via RecordingController.log's own false return, outside one) --
  // see this file's own header comment for why nothing else happens
  // here yet.
  registerClick(hit: ContourHit): void {
    this.recording.log('contours-layer', 'click', this.logPayloadFor(hit));
  }

  draw(ctx: CanvasRenderingContext2D, visibleLayers: Set<string>, toScreen: (lon: number, lat: number) => ScreenPoint): void {
    // Show-me's highlight is drawn even for a fragment whose own layer
    // isn't currently toggled on -- "ensure the relevant layer is
    // visible" (§5.1 step 1) already forces that on before this ever
    // fires in practice, but staying independent of visiblePlans here
    // means a highlight can never silently fail to show just because of
    // a timing gap between toggling a layer on and its own fragments
    // finishing their load.
    const highlightPlan = this.highlight?.plan;
    const highlightIds = this.highlight?.fragmentIds;
    if (highlightPlan && highlightIds && !this.visiblePlans(visibleLayers).includes(highlightPlan)) {
      this.drawFragmentSet(ctx, highlightPlan, highlightIds, toScreen);
    }

    for (const plan of this.visiblePlans(visibleLayers)) {
      const fragments = this.getFragments(plan);
      if (!fragments) continue;
      for (const fragment of fragments) {
        if (fragment.points.length < 2) continue;
        const isHighlighted = highlightPlan === plan && highlightIds?.has(fragment.id);
        if (isHighlighted) {
          strokeCandyCane(ctx, fragment.points, toScreen, 4, HIGHLIGHT_COLOR);
          continue;
        }
        const isHover = this.isHoverGroupMember(plan, fragment.id);
        if (isHover) {
          strokeCandyCane(ctx, fragment.points, toScreen, 3, HOVER_COLOR);
          continue;
        }
        const major = fragment.elevationSource === 'ocr' || fragment.elevationSource === 'review-confirmed';
        ctx.save();
        ctx.strokeStyle = this.effectiveColorFor(plan, fragment);
        ctx.lineWidth = major ? 1.8 : 1;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        fragment.points.forEach((p, i) => {
          const sp = toScreen(p.lon, p.lat);
          if (i === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Draws a highlighted fragment set directly from `resolved` (bypassing
  // visiblePlans) -- see draw()'s own comment on why this path exists.
  private drawFragmentSet(
    ctx: CanvasRenderingContext2D,
    plan: ContourPlan,
    fragmentIds: Set<number>,
    toScreen: (lon: number, lat: number) => ScreenPoint,
  ): void {
    const fragments = this.resolved.get(plan);
    if (!fragments) return;
    for (const id of fragmentIds) {
      const fragment = fragments[id];
      if (!fragment || fragment.points.length < 2) continue;
      strokeCandyCane(ctx, fragment.points, toScreen, 4, HIGHLIGHT_COLOR);
    }
  }
}
