# SamothraceMap: overall pan/zoom limits

Status: **draft, not yet implemented** — written to capture the design
before building anything. Update this doc as decisions change; don't let
it go stale once implementation starts.

## 1. The incident that prompted this

Same 2026-10-19 incident `plans/samothrace-map-layer-view-status.md`
documents in full: a saved pan position (lon 25.526, lat 40.495, zoom 19)
turned out to sit just outside the real tile/monument data's actual extent
(lon 25.5290–25.5314, lat 40.4997–40.5015 — confirmed directly against
`Data/mapFeatures/SamoWeb_RestoredStatePlan_Overlay.geojson`'s own real
coordinates and every tile layer's `tilemapresource.xml`). At zoom 19 —
a perfectly valid, in-range zoom level — that's enough drift to put every
single layer 404ing/empty simultaneously, with the only fix being to
manually find and click the Overview button.

Today, nothing stops the camera from ending up there: `zoomBy`/`onPointerMove`'s
drag branch only clamp *zoom* (`this.minZoom`/`this.maxZoom`, published by the
hmsvc's own `/layers` response, currently 17–22) — pan position (`view.lon`/
`view.lat`) is completely unconstrained. A restored saved view (from
`localStorage`, see `init()`'s own restore-state block) is trusted outright,
with no sanity check against where the actual data is.

This plan adds an overall pan boundary — generous, not a tight box around
just the monuments — so the camera can't drift arbitrarily far from every
layer's actual content, while still leaving real room to pan around and
see the site in its surroundings.

## 2. Two different "bounds" that must NOT be conflated

This widget already has `combinedBounds` (monument-overlay-only — the
union of `actualFeatures`/`restoredFeatures`' own `featureBounds()`),
used today by the Overview button and by `init()`'s own fallback
`fitToBounds` call. **This plan introduces a second, separate, broader
concept — call it `datasetBounds`** — and the two should stay distinct:

| | `combinedBounds` (existing) | `datasetBounds` (new) |
|---|---|---|
| Scope | Monument overlay polygons only | Every geo-referenced layer this widget knows about |
| Used for | "Show me the monuments" (Overview button, initial fit) | Outer pan/zoom limit only |
| Changing it | Would change what "Overview" zooms to — not wanted | Doesn't affect Overview's own framing at all |

Conflating them would mean either the Overview button starts framing a much
wider, less useful view (if `combinedBounds` were widened), or the pan
limit stays too tight (if `datasetBounds` were narrowed to match). Keep
`combinedBounds` exactly as it is; add `datasetBounds` alongside it.

## 3. Computing `datasetBounds`

Union of bounds from every source this widget actually has real geographic
extent for:

1. **`combinedBounds` itself** (monument overlay) — already computed, free
   to include.
2. **Every original tile layer's own real extent.** Confirmed directly:
   `Data/mapTiles/SamoWebsite_{Actual,Restored}State{Plan,Monuments}_3857/
   tilemapresource.xml` and `.../SamoWebsite_AerialImagery_3857/
   tilemapresource.xml` each carry a real `<BoundingBox minx= miny= maxx=
   maxy=/>` (EPSG:3857 reprojected to plain lon/lat already, matching this
   widget's own coordinate convention — no further conversion needed). All
   five are near-identical (same physical site), but reading all five
   rather than hardcoding one is both more robust to future drift between
   them and avoids a magic "trust this one arbitrarily" choice.
3. **The Waterway/Regio PNG layers' own `.bounds.json` files** — already
   written by `scripts/style_restored_waterway.py`/`style_restored_regio.py`,
   already read by this widget (`loadWaterwayViewBounds`/`loadRegioBounds`
   or equivalent) for drawing; reuse the same values rather than re-reading.
4. **Pipeline-stage debug layers' own `bounds.json`** (`write_stage_bounds()`),
   if cheap to include — low-value (near-identical to the tile layers'
   own bounds) but harmless to fold in for completeness.

**Not included**: `Keys` (fixed canvas position, no real lon/lat — see
`plans/samothrace-map-layer-view-status.md` §3.2's own note on the same
exclusion). **`Initial Map`**: no `tilemapresource.xml` exists for it today
(confirmed directly) — either compute and persist its real bounds at bake
time (`desk-installed-jobs/map-import-from-photo/`'s own job, writing a
matching file alongside the baked tiles) or fall back to
`Data/mapSources/<slug>/transform.json`'s own locked-in position/scale
parameters if those are sufficient to derive it. Left as an explicit open
question (§6) rather than guessed at here — `datasetBounds` is still a
real, useful improvement even if this one layer's own extent isn't folded
in on day one, since it's not larger than the already-included tile layers
in practice.

This union should be computed **once**, after `loadLayerMeta()`/
`loadOverlays()` (and whatever new bounds-fetching §3 item 2-4 need) have
all resolved during `attemptLoad()` — not recomputed per-frame; nothing
about it changes during a single session.

## 4. What gets clamped, and how generously

**Pan**: after every operation that moves `view.lon`/`view.lat` —
`onPointerMove`'s drag branch, `zoomBy`, `fitToBounds`, and the saved-view
restore in `attemptLoad()` — clamp the view **center** (not the viewport
edges) to stay within `datasetBounds` padded by a generous multiple of its
own size, e.g. `padBounds(datasetBounds, 1.0)` (same `padBounds()` helper
this file already has, reused here, `1.0` meaning the padding on each side
equals the bounds' own width/height — doubling the effective pannable
area well beyond the real content on every side). This is deliberately
loose: the goal is "can't drift to *nothing*," not "can't see the site in
its surroundings" — clamping the center, not the viewport box, also means
a user can still pan until the data is at the very edge of the screen, not
just centered.

**Zoom**: `this.minZoom`/`this.maxZoom` (17–22) already come from the
hmsvc's `/layers` response (`loadLayerMeta()`) and are already enforced
everywhere `view.zoom` changes
— this already prevents zooming out far enough to need its own separate
fix (the incident's own zoom level, 19, was always in-range; the bug was
purely pan position). No new zoom-side limit is proposed here beyond
confirming the existing one is sufficient — **this plan's real content is
the pan clamp**, not a new zoom mechanism.

**Clamp style**: a hard clamp (the computed `view.lon`/`view.lat` is simply
capped to the padded box's own min/max every time it would move outside)
is the simplest correct implementation and matches how `zoomBy`/`fitToBounds`
already clamp zoom today (`Math.min(Math.max(...))`, no animation). A
softer "drag past the edge, then snap back" feel (closer to some consumer
map products) is a possible later polish pass, not needed for this plan's
own goal — note as a nice-to-have in §6, don't build it up front.

## 5. Suggested build order

1. Compute `datasetBounds` once in `attemptLoad()` (§3) — read the five
   `tilemapresource.xml` files (new, small XML-parsing need — `desk.fs
   .readFile` + a minimal regex/DOMParser extraction of the one
   `<BoundingBox .../>` tag is enough, no need for a real XML library) via
   the Bridge `fs` capability (already held) and union them with the
   already-available bounds sources.
2. Clamp in `zoomBy`/`onPointerMove`'s drag branch/`fitToBounds` (§4) — the
   restored-saved-view path in `attemptLoad()` should route through the
   same clamp helper (e.g. a small `clampToDatasetBounds(lon, lat)`) rather
   than duplicating the min/max logic inline.
3. Verify against the exact incident: manually set a widget instance's
   saved `view` (via its own `localStorage`/`.desk` state) to the known
   -bad `{lon: 25.526, lat: 40.495, zoom: 19}` and confirm a reload lands
   somewhere with real content instead.

## 6. Open questions

- **`Initial Map`'s own real bounds** (§3) — needs either a bake-time fix
  in `map-import-from-photo` or a documented, deliberate decision to leave
  it out of `datasetBounds` for now. Shouldn't block shipping the rest of
  this plan.
- **Exact padding factor** (§4 proposes `1.0`, i.e. double the content
  area) — a number to tune by actually trying it live, not to lock in
  here. Too tight defeats this plan's own "don't overly limit the user"
  goal; too loose doesn't meaningfully prevent a repeat of the incident.
- **Interaction with `plans/samothrace-map-layer-view-status.md`**: once
  that plan's "Recenter" button exists, does this plan's own hard pan
  clamp make that button's job trivial (there's now a much smaller area
  to ever need recentering within), or does the clamp alone make that
  plan's "every layer empty" case rare enough it's barely worth building?
  Current read: build both — the clamp prevents the *extreme* drift that
  caused today's incident, but a single layer can still show nothing in
  view for an in-bounds pan (a real tile gap, a layer whose own coverage
  is smaller than the site) that the clamp alone wouldn't catch or
  explain.
- **Should the clamp apply to `handleFocusMessage`-style
  jump-to-a-point calls too** (if `SamothraceMapElement` ever gains an
  equivalent of `NaturalEarthMapElement`'s own cross-widget focus
  contract)? Not applicable today (no such feature exists on this widget
  yet) — noted only so a future implementer of that remembers to route it
  through the same clamp.
