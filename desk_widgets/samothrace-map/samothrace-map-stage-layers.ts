// Pipeline stage layers -- phase 2 of plans/samothrace-map-consolidation.md
// §4.1. Each of scripts/extract_vector_layers.py's 7 named pipeline
// stages, per plan, saved as one plain PNG snapshot under
// .desk_temp/pipeline-stages/<plan>/NN_<stage-name>.png (not tiled --
// ~2560x2304px, small enough to load as a single client-side image
// overlay rather than registering them as real hmsvc tile layers; see
// that plan section's own "Implementation choice" note for why).
//
// Positioning: write_stage_bounds (extract_vector_layers.py) writes one
// `bounds.json` per plan alongside its 7 stage PNGs -- the lon/lat box
// the whole mosaic covers (Web Mercator is north-up/unrotated, so a
// plain west/south/east/north box is exact). This module reads that
// once per plan and reuses the main element's own toScreen() to place
// the image at the right spot for whatever the CURRENT view zoom
// happens to be -- the stage PNG itself is fixed-resolution (zoom 20),
// but the overlay is drawn by scaling that one image to fit its
// lon/lat box's current on-screen size, the same zoom-independent
// approach the monument-overlay polygons already use.
//
// Concatenated between samothrace-map-recording.ts and samothrace-map.ts
// in tsconfig.json's own "files" array (global scripts, no import
// /export). Window.desk's full Bridge-API shape -- including the
// `documents` capability this file uses -- is declared once, in
// samothrace-map-recording.ts; see that file's own header comment for
// why a second, partial `interface Window` here doesn't work.

type StagePlan = 'actual' | 'restored';

// Mirrors extract_vector_layers.py's own PIPELINE_STAGES list -- kept in
// sync by hand, same as Pipeline Stage Viewer's own copy of this same
// list (small, stable; see that constant's own comment in the Python
// source).
const STAGE_DEFS: Array<{ num: number; name: string; label: string }> = [
  { num: 0, name: 'raw-ink', label: 'Raw ink mask (ink/blue split)' },
  { num: 1, name: 'after-structure-exclusion', label: 'After structure (building) exclusion' },
  { num: 2, name: 'candidate-fragments', label: 'Candidate fragments (thin/thick split + length filter)' },
  { num: 3, name: 'after-border-exclusion', label: 'After border/survey-frame exclusion' },
  { num: 4, name: 'after-chain-exclusion', label: 'After decorative circle-chain exclusion' },
  { num: 5, name: 'labeled-contours', label: 'After label-gap merge (index contours get elevation)' },
  { num: 6, name: 'with-minor-bands', label: 'After minor-contour banding (1m interpolation)' },
];

const STAGE_PLAN_LABELS: Record<StagePlan, string> = { actual: 'Pipeline (Actual)', restored: 'Pipeline (Restored)' };

// Every stage layer's id starts with this prefix -- purely namespacing,
// so it can never collide with an hmsvc tile layer's own plain id
// ("aerial", "actual-structures", ...) in the same shared visibleLayers
// set. Nothing actually parses the prefix back out: drawVisible/
// buildLayersPanel both already know, from context, which ids are which
// (one iterates STAGE_DEFS directly, the other builds the stage rows'
// own ids from this same function) -- it exists only so the two id
// spaces can never collide, not to be machine-distinguishable later.
const STAGE_LAYER_PREFIX = 'stage:';

function stageLayerId(plan: StagePlan, stageNum: number): string {
  return `${STAGE_LAYER_PREFIX}${plan}:${stageNum}`;
}

function stagePngPath(plan: StagePlan, stage: { num: number; name: string }): string {
  const nn = String(stage.num).padStart(2, '0');
  return `.desk_temp/pipeline-stages/${plan}/${nn}_${stage.name}.png`;
}

function stageBoundsPath(plan: StagePlan): string {
  return `.desk_temp/pipeline-stages/${plan}/bounds.json`;
}

interface StageBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

// 8 MiB per desk.documents.read call -- see the Bridge API's own doc
// ("length is clamped to 8 MiB per call"). Same constant/helper Pipeline
// Stage Viewer already uses for the same reason.
const DOCUMENT_READ_CHUNK = 8 * 1024 * 1024;

async function readFileAsBlobUrl(path: string): Promise<string> {
  const desk = window.desk;
  if (!desk) throw new Error('Desk bridge unavailable');
  const { handle } = await desk.documents.open(path);
  try {
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const { data, eof } = await desk.documents.read(handle, { offset, length: DOCUMENT_READ_CHUNK });
      if (data) {
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        parts.push(bytes);
        offset += bytes.length;
      }
      if (eof) break;
    }
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const combined = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
      combined.set(p, pos);
      pos += p.length;
    }
    const blob = new Blob([combined], { type: 'image/png' });
    return URL.createObjectURL(blob);
  } finally {
    await desk.documents.close(handle);
  }
}

interface StageImageEntry {
  img: HTMLImageElement;
  status: 'loading' | 'loaded' | 'error';
}

// Manages the per-plan bounds.json and per-(plan,stage) PNG loads, both
// lazy (nothing is fetched until its layer is actually toggled visible)
// and cached thereafter -- same "entry has a status, draw whatever's
// currently loaded, kick off a load if not yet requested, redraw again
// once it resolves" shape as the main element's own getTile()/TileEntry
// for hmsvc tiles, just fetched via desk.documents instead of a plain
// HTTP img.src.
class StageLayersController {
  // Resolved synchronously-readable bounds, not a cache of in-flight
  // promises -- drawVisible (called from inside the main element's own
  // synchronous redraw()) must never await anything mid-draw. Doing so
  // previously deferred the actual drawImage call to a microtask that
  // ran AFTER redraw()'s own subsequent, synchronous drawOverlays() call
  // -- painting a stage layer on TOP of the monument-selection overlay
  // instead of under it. Preloading both plans' bounds eagerly at
  // construction (see preloadBounds below), well before any stage layer
  // could realistically be toggled visible, avoids ever needing to
  // await inside a draw call at all.
  private bounds = new Map<StagePlan, StageBounds | null>();
  private imageCache = new Map<string, StageImageEntry>();

  constructor(private readonly scheduleRedraw: () => void) {
    void this.preloadBounds();
  }

  private async preloadBounds(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    for (const plan of ['actual', 'restored'] as StagePlan[]) {
      try {
        const { contents } = await desk.fs.readFile(stageBoundsPath(plan));
        this.bounds.set(plan, JSON.parse(contents) as StageBounds);
      } catch {
        this.bounds.set(plan, null); // pipeline hasn't been run since write_stage_bounds was added, or this plan's dir doesn't exist yet
      }
    }
    this.scheduleRedraw(); // in case a stage layer was already toggled visible before this resolved
  }

  // Every (plan, layerId, label) tuple for building the layers panel --
  // does not require anything to be loaded yet.
  allLayerRows(): Array<{ id: string; label: string; group: StagePlan }> {
    const rows: Array<{ id: string; label: string; group: StagePlan }> = [];
    for (const plan of ['actual', 'restored'] as StagePlan[]) {
      for (const stage of STAGE_DEFS) {
        rows.push({ id: stageLayerId(plan, stage.num), label: `${String(stage.num).padStart(2, '0')} — ${stage.label}`, group: plan });
      }
    }
    return rows;
  }

  groupLabel(plan: StagePlan): string {
    return STAGE_PLAN_LABELS[plan];
  }

  private getImage(plan: StagePlan, stage: { num: number; name: string }): StageImageEntry {
    const key = stageLayerId(plan, stage.num);
    let entry = this.imageCache.get(key);
    if (!entry) {
      const img = new Image();
      entry = { img, status: 'loading' };
      this.imageCache.set(key, entry);
      void (async () => {
        try {
          const url = await readFileAsBlobUrl(stagePngPath(plan, stage));
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('decode failed'));
            img.src = url;
          });
          entry!.status = 'loaded';
        } catch {
          entry!.status = 'error';
        }
        this.scheduleRedraw();
      })();
    }
    return entry;
  }

  // Draws every currently-visible stage layer (by id, from the same
  // visibleLayers set hmsvc layers share) using the given toScreen --
  // kicks off a load for anything not yet requested and simply skips
  // drawing it this frame (the load's own completion callback schedules
  // a redraw that will draw it once ready).
  drawVisible(
    ctx: CanvasRenderingContext2D,
    visibleLayers: Set<string>,
    toScreen: (lon: number, lat: number) => { x: number; y: number },
  ): void {
    for (const plan of ['actual', 'restored'] as StagePlan[]) {
      const bounds = this.bounds.get(plan);
      if (!bounds) continue; // not preloaded yet (or this plan's pipeline hasn't been run) -- preloadBounds's own scheduleRedraw will retry
      for (const stage of STAGE_DEFS) {
        const id = stageLayerId(plan, stage.num);
        if (!visibleLayers.has(id)) continue;
        const entry = this.getImage(plan, stage);
        if (entry.status !== 'loaded') continue;
        const nw = toScreen(bounds.west, bounds.north);
        const se = toScreen(bounds.east, bounds.south);
        ctx.drawImage(entry.img, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
      }
    }
  }
}
