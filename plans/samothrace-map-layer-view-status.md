# SamothraceMap: layer view-status panel ("is anything actually showing?")

Status: **draft, not yet implemented** — written to capture the design
before building anything. Update this doc as decisions change; don't let
it go stale once implementation starts.

## 1. The incident that prompted this

2026-10-19: a user clicked `[STALE]` to rebuild `samothrace-map` after an
unrelated code change, and the map came back showing nothing but a plain
gray canvas — layer panel fully populated, no error, "Aerial Imagery"
selected. Diagnosing it required an agent to manually `curl` the
`samothrace-tiles` hmsvc's `/tiles/...` endpoint directly and grep its
logs to discover the real cause: the saved pan position (lon 25.526, lat
40.495, zoom 19) sat just outside the actual tile/monument data's real
extent (lon 25.5290–25.5314, lat 40.4997–40.5015) — at zoom 19 that's
enough to put every layer's tiles 404ing simultaneously, with nothing on
screen to say so. The widget itself had no way to tell the user "you're
looking at empty space" versus "something is broken" — both look
identical: a flat gray rectangle.

This plan is the fix for *that gap specifically*: make the widget surface,
live, whether what's currently checked in the layer panel is actually
rendering anything for the current view. `plans/samothrace-map-pan-zoom-
limits.md` (written alongside this one) is the complementary fix for the
other half — stopping the camera from drifting somewhere with no content
in the first place. Both are worth having: this one still matters even
with pan/zoom limits in place, since a single layer can be empty in-view
(a tile gap, a layer whose own real coverage is smaller than the site) even
when the overall camera position is perfectly reasonable.

## 2. Goal

A small status readout, **above the Q&A tabs, below the recording
indicator** — i.e. inside `.qa-panel-header` in `widget.html`, the same
container `.recording-indicator` already lives in — that answers, for the
*current* view and the *current* set of checked layers:

- Is each visible layer actually drawing something inside the current
  viewport right now?
- For a tile-backed layer, are its tile requests failing (404, or any
  other fetch error)?

Quiet by default (nothing alarming → nothing shown, or a single
unobtrusive line) — this is a diagnostic aid for exactly the "why is this
blank" moment, not a permanent dashboard competing for attention with the
recording indicator and the tabs below it.

## 3. Two different kinds of "showing nothing," tracked two different ways

This widget's layers aren't all the same shape, and "is it showing
anything" means something different for each:

### 3.1 Tile-backed layers (raster, fetched per z/x/y from `samothrace-tiles`)

Aerial/Topographic/Blank/Initial Map imagery, Restored State Structures/
Monuments, and the Pipeline (Topographic) debug layers. These are nominally
"whole-site" layers, but — confirmed directly by today's incident — the
underlying tile set can have real gaps or simply not extend as far as
assumed. The only way to know if a tile is missing is to actually ask for
it and see what comes back.

`getTile(url)` already tracks exactly this, per URL, in `tileCache: Map<string,
TileEntry>` (`TileEntry = {img, status: 'loading' | 'loaded' | 'error'}`) —
the data needed already exists, it's just never aggregated or surfaced
anywhere. Plan: after each `redraw()` pass (or on a short debounce after
pan/zoom settles, to avoid recomputing every frame while dragging),
for each currently-visible tile-backed layer, walk the same z/x/y tile
range `redraw()` itself just requested and classify:

- `ok` — every needed tile is `loaded`.
- `partial` — some loaded, some `error`/missing (covers the exact "aerial
  imagery stops partway across the site" shape of today's incident).
- `empty` — every needed tile is `error`, or none have ever resolved as
  `loaded` (covers "zero content at this view," today's actual symptom).
- `loading` — still waiting on first response; don't flag as broken yet,
  but worth a neutral "loading…" state so a slow network doesn't briefly
  flash a false "empty" warning.

### 3.2 Bounds-backed layers (vector or a single fixed-position PNG)

Monument overlay polygons, extracted contours, the Waterway view, Regio
layers, pipeline-stage debug PNGs — each of these already has (or easily
can have) a known lon/lat bounding box: `featureBounds()`/`unionBounds()`
for vector data, each layer's own `*.bounds.json` for the PNG ones (same
file `write_stage_bounds()`/`style_restored_waterway.py`/
`style_restored_regio.py` already write). For these, "showing anything in
the current view" is a cheap, purely geometric check — does the layer's
own bounds box intersect the current viewport's lon/lat bounds — not a
network-status question at all. No tile requests to track; this is a
simple `boundsIntersect(layerBounds, viewportBounds)` test, run the same
cadence as §3.1's check.

`Keys` are the one exception worth calling out explicitly: they're drawn
at a fixed *canvas* position (§"Keys" in `AGENTS.md`), not geo-projected —
"in view" is meaningless for them, and they should be excluded from this
check entirely rather than forced into either bucket.

## 4. UI

A new `.view-status-panel` element in `.qa-panel-header`, below
`.recording-indicator`:

- **Nothing checked is empty/broken**: render nothing (or a barely-visible
  single line, e.g. a small gray dot + "Layers OK," low-contrast — TBD
  during implementation, lean toward fully hidden unless it's useful to
  always confirm the check ran at all).
- **Some but not all visible layers are empty/partial/erroring**: a single
  amber summary line ("2 of 6 visible layers show nothing here"),
  expandable (same collapsible pattern `.debug-section`/the Agent Q&A
  tab's archive drawer already use) to a per-layer list: layer label +
  status + a short reason ("no tiles in view (8/8 requests failed)," "out
  of view," "loading…").
- **Every visible layer is empty** (today's exact incident): the single
  highest-value case, worth its own distinct, more prominent treatment —
  a red/amber banner ("Nothing visible here") with a direct **"⟲
  Recenter"** button, wired to the same action the existing Overview
  button already performs. This is the one-click fix for the actual
  symptom a user hits, surfaced at the moment it's happening instead of
  requiring them to notice the Overview button exists and guess that's
  the fix.

Color/shape conventions should match what's already established in this
widget rather than invent new ones — the amber tone `.qa-auto-row`/
`AgentPatchChannel` already uses for "worth your attention but not an
error," the retry UI's own `.retry-box` shape (message + action button)
for the "nothing visible" banner specifically.

## 5. Implementation sketch

- `private layerViewStatus = new Map<string, LayerViewStatus>()`, where
  `LayerViewStatus = { kind: 'tile'; state: 'ok' | 'partial' | 'empty' |
  'loading'; requested: number; failed: number } | { kind: 'bounds'; inView:
  boolean }`.
- Recomputed by a new `updateViewStatus()`, called at the end of
  `redraw()` (cheap — this is a status summary over already-cached/already
  -known data, not new fetches) but only re-rendering the DOM when the
  summary actually changed (avoid a full innerHTML replace every single
  frame during a drag — compare against the previous summary first, same
  spirit as `onPointerMove`'s own hover-change check).
- `renderViewStatusPanel()` builds the HTML block described in §4,
  attaches the Recenter button's click handler to call the same method
  the Overview button's own listener calls.
- New CSS in `widget.html`: `.view-status-panel`, `.view-status-summary`,
  `.view-status-detail-row`, `.view-status-recenter-button` — sized and
  colored to sit comfortably between `.recording-indicator` and
  `.qa-tabs` without pushing the tab bar down noticeably when quiet/hidden.

## 6. Open questions

- **Debounce interval for the tile-range check.** Checking on every single
  `redraw()` call (which fires on every pointer-move frame while
  dragging) is probably wasteful even though the check itself is cheap
  (no new fetches, just reading already-cached statuses) — likely want to
  only recompute after pan/zoom has been still for ~150-300ms, the same
  shape `onWheel`'s own `lastWheelAt` throttle already uses elsewhere in
  this file. Pick a concrete number during implementation, not here.
- **Does "partial" need its own banner tier**, or is amber-summary-line
  enough? Lean toward starting simple (ok / not-ok, detail list explains
  which) and only splitting `partial` out visually if it turns out to be
  common and the single bucket reads as misleadingly alarming in
  practice.
- **Should this also watch layers the user hasn't manually unchecked but
  that are structurally excluded from the current tab** (e.g. pipeline
  -stage debug layers, which are off by default and mostly irrelevant day
  -to-day)? Default answer: only ever report on layers actually in
  `visibleLayers` — an unchecked layer showing nothing is not interesting,
  by definition.
- **`Initial Map` and any future baked-from-photo layer's own bounds.**
  `SamoWebsite_InitialMap_3857` has no `tilemapresource.xml` (confirmed
  directly — only the five original tile sets have one); its real extent
  would need to come from `Data/mapSources/<slug>/transform.json` or be
  computed at bake time. Doesn't block this plan (the tile-fetch-status
  check in §3.1 works regardless of whether bounds are known), but affects
  whether such a layer can ever be flagged "out of view" the bounds-based
  way — likely moot for this plan specifically, more relevant to the
  pan/zoom-limits plan's own bounds union.
