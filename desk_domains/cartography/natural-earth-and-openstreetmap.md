# Natural Earth & OpenStreetMap — domain knowledge

General, transferable knowledge about sourcing and combining two public
vector-GIS datasets — [Natural Earth](https://www.naturalearthdata.com)
(world-scale basemap geometry, public domain) and
[OpenStreetMap](https://www.openstreetmap.org) (crowd-sourced, ODbL) —
learned building this project's regional basemap
(`Data/naturalEarth/`, `Data/OpenStreetMap-geocoding/`), the gazetteer
built on top of both (`Data/gazetteer/`), and the widget/hmsvc pairs
that serve all of it. Written for *other* projects that need to vendor
or clip public geographic data, the same way `cartography.md` (this
directory's sibling) is written for other hand-drafted-plan-digitization
projects — each point below is a convention or gotcha worth expecting
on a *different* project's data, with this project's own evidence kept
as the concrete example rather than the point itself.

## 1. Natural Earth

### 1.1 Pick scale and theme by what you actually need, not everything available

Natural Earth ships three scales (`10m`/`50m`/`110m`, most-to-least
detailed) and two cultural/physical themes, each with dozens of layers.
Resist importing a whole theme — pick the specific layers your project
needs (this project: coastline, land, minor islands, rivers, major
cities, named-island/sea labels) and strip every unused attribute
column before committing the result. Each Natural Earth feature
typically carries 25-170 properties (name translated into ~25
languages, per-country disputed-boundary viewpoint columns, ...); a
project almost never uses more than 2-4 of them. Confirmed directly:
stripping down six clipped layers to a ~1000-mile regional box took
raw Shapefiles from ~90 MB to ~1.3 MB of committed GeoJSON — a
>60:1 reduction, almost entirely from dropping unused attributes and
clipping to a region, not from the geometry itself being simplified.

### 1.2 Clip with a real geometry intersection, never just a bbox-vs-bbox check

A feature's own bounding box can lie. Confirmed directly: a plain
"does this feature's bbox overlap my bbox" pre-filter against Natural
Earth's marine-polygon layer kept a spurious "North Pacific Ocean"
match in a *Mediterranean/Aegean* region query — its real geometry
wraps the antimeridian, so its reported bbox spans the full
-180°..180°, overlapping literally every bounding box on Earth. Only
actually intersecting the candidate's real geometry against the query
box (not just comparing the two boxes' own extents) correctly clips it
to empty and drops it. Cheap bbox-vs-bbox rejection is still worth
doing first as a fast pre-filter — just don't stop there; always follow
it with a real intersection before trusting the result. Any dataset
with antimeridian-spanning or dateline-wrapping features (oceans,
Russia, Fiji, Antarctica, ...) can hit this, even when your own query
box is nowhere near ±180° itself.

### 1.3 A plausible-sounding layer name is not evidence it has what you need — check the actual fields and coverage

Before building a pipeline around a layer, download it and inspect its
field list and real geographic coverage in your own region — the
layer's name alone is not reliable evidence. Three real, surprising
findings from checking rather than assuming:

- `ne_10m_minor_islands_label_points` sounds exactly like "names for
  small islands" — it carries **no `name` attribute at all** in this
  release (`featurecla`/`min_zoom`/`scalerank` only), despite being a
  "label points" layer.
- `ne_10m_geography_regions_points`/`_polys` (the general named-places
  layer) *does* carry real names, but it's a small, **curated-by-fame
  list**, not a size- or completeness-based gazetteer — confirmed by
  checking which real, comparably-sized islands made the cut and which
  didn't (Crete, Rhodes, Lesbos, Cyprus did; Samothrace, Thasos,
  Lemnos, Imbros, none obviously smaller or less real, did not).
  Fame, not size, is the actual inclusion criterion — expect the same
  shape of curation (mountains, capes, famous-but-arbitrary) on any
  Natural Earth "named regions" layer.
- Natural Earth's *political* layers don't fill the gap either, and
  this is worth checking explicitly before assuming a finer
  administrative layer will have per-feature names a physical layer
  lacks: `ne_10m_admin_0_map_subunits` exists specifically to split a
  sovereign state into separate records for disjoint territories (e.g.
  French Guiana getting its own record, distinct from mainland
  France) — but confirmed directly, Greece's many islands are **not**
  split out this way; every one of them still returns a single
  `NAME: "Greece"` record. One administrative level finer
  (`admin_1_states_provinces`) does return a real per-point name, but
  it's the *region's* name (e.g. "North Aegean"), routinely shared by
  several different islands in the same region — not the island's own
  name.

Counter-example, same lesson in the other direction: don't let a
pattern of gaps make you assume failure *by default* either.
`ne_10m_geography_marine_polys` (sea/strait/channel names) worked
correctly on the first try in this same region — real `name` field,
real coverage, no gap to route around. Verify in both directions; a
franchise of early disappointments doesn't predict the next layer's
own result.

### 1.4 A representative point, not a bounds-midpoint, for anything you'll label or geocode

A polygon's bounding-box midpoint is not guaranteed to fall inside the
polygon — true for any concave shape, and close to guaranteed false for
a large feature clipped to an irregular query box (a sea polygon
clipped to a rectangular region, where the coastline cuts deep into
both the kept and discarded parts). Use a real "guaranteed inside"
point instead (Shapely's `representative_point()`, or equivalent) for
anything downstream that assumes the point is actually on/in the
feature — a map label, or a point you intend to reverse-geocode (see
§2.2). Compute and store it once, at clip time, as its own
`label_lon`/`label_lat` property pair, rather than recomputing a
bounds-midpoint approximation repeatedly downstream (e.g. in a
rendering widget) — one real computation, reused everywhere, is both
cheaper and correct in more cases than the cheap approximation
reimplemented at every consumer.

### 1.5 Licensing: public domain, credit anyway

Natural Earth is public domain — no permission, fee, or attribution
required, just requested (`Made with Natural Earth. Free vector and
raster map data @ naturalearthdata.com.`). Credit it anyway: it's cheap,
it's what the maintainers ask for, and it keeps your own provenance
trail honest, the same reasoning that applies to any source you use
with a clear conscience regardless of what the license technically
compels.

## 2. OpenStreetMap

### 2.1 A real license term, not a request — but scoped to how much you actually reuse

Unlike Natural Earth, OpenStreetMap's **Open Database License (ODbL)
1.0** is a real license term: attribution is not optional for genuine
reuse. What's less obvious, and worth getting right before assuming
the license blocks a use case: **the ODbL's share-alike clause only
applies to republishing a "Derivative Database"** — a substantial
reuse of OSM's own database. The project's own guidelines give exactly
the relevant counter-example: a small set of extracted facts (their
example is geocoding results) "need not maintain attribution... as
long as it does not form a Derivative Database." Extracting a handful
of names (not geometry, not bulk data) from OSM is squarely that
"individual facts" case — attribution is still the right thing to do
(and this project does it, matching its own Natural Earth practice),
but don't assume ODbL forces a full database-style release just
because *a* OSM-derived fact appears in your output.

### 2.2 Overpass vs. Nominatim are not interchangeable — confirm reachability and capability before committing to one

OpenStreetMap exposes (at least) two very differently-shaped public
APIs, and picking the wrong one for your actual need costs real time:

- **Overpass API** — query by tag/bounding-box ("find every
  `place=island` in this box"). The right tool for enumeration.
- **Nominatim** — forward search (by name) and reverse geocoding (by
  point). No "enumerate everything of type X in a box" capability at
  all — it answers "what's at this point" or "where is this name," not
  "what's in this area."

Confirmed directly: **every Overpass endpoint tried from this
project's own environment was unreachable** — the main server
(alternating `406`/timeout) and five independent public mirrors (`500`
errors, timeouts, or a redirect chasing another failing mirror) — while
Nominatim was reachable throughout. Likely an IP-range block on that
specific environment's egress, not a real, general Overpass outage —
but the actionable lesson is general regardless of cause: **check
reachability of the specific endpoint you plan to depend on early**,
before designing a pipeline around it, since "the general service
exists and is well-documented" does not guarantee *your* environment
can reach *that* instance of it.

When your enumeration tool is unreachable, don't force the
point-lookup tool into an enumeration role it isn't built for (e.g.
repeatedly guessing/searching names hoping to stumble on everything
relevant). Flip the architecture instead: enumerate from whatever
source genuinely can enumerate (here, Natural Earth's own land
polygons, decomposed into parts — see §3), and use Nominatim only for
the one thing it's actually good at, naming a specific point.

### 2.3 Track *which* resolution strategy actually won, not just the final name

When resolving data via several fallback strategies of decreasing
reliability, record which tier actually produced the answer as its own
field — never collapse different confidence levels into one
undifferentiated result. This project's own contour-elevation pipeline
already established this convention (`elevationSource`:
`"ocr"`/`"review-confirmed"`/`"interpolated"`, see `cartography.md`
§"Contour lines"); the same shape applies directly to geocoding a name
from multiple candidate queries at decreasing confidence (a direct
tagged-feature match, a match derived from administrative context, a
bare administrative-unit fallback, unresolved). Three concrete payoffs
from doing this on a real run:

- **A real, not hypothetical, licensing-relevant distinction surfaced
  for free**: Cyprus has no OSM record actually tagged as an island at
  all — only its own country-administrative boundary. Without a
  tracked confidence tier, "Cyprus" would have looked identical in the
  output to every island resolved from a real place-type tag, hiding a
  genuine difference in what was actually confirmed.
- **A wrong hand-guess failed safely instead of silently**: seeding a
  name-search query with the wrong candidate name for a given point
  (a real mistake made while developing this project's own island-name
  lookup — two Croatian islands' coordinates were swapped against their
  common names) correctly found *no* matching record, rather than
  somehow matching the wrong thing — the system fell through to a
  lower-confidence fallback tier, which is what actually exposed the
  mistake on review. A resolution strategy is well-designed when a bad
  input degrades gracefully into "I don't actually know this
  confidently" rather than asserting a specific wrong answer.
- **A geographic/distance tolerance bug was caught by comparing
  results across tiers**, not by their both being individually
  plausible: a too-generous "is this match close enough" distance
  check matched a real island to its *neighbor's* administrative
  boundary instead of its own (two Cycladic islands roughly 30-40 km
  apart) — tightening the tolerance and re-verifying against a case
  that genuinely needed a generous tolerance (an isolated, country-size
  island whose administrative centroid sits further from the
  geometry's own computed center) fixed both without breaking either.

### 2.4 Respect published usage limits mechanically, in code, not just in spirit

Nominatim's usage policy caps general use at 1 request/second and asks
for a descriptive `User-Agent` identifying the project and a contact
method. Enforce this as a real rate limiter in the request path
(sleep-until-next-allowed-time before every call), not as a
best-effort "try not to go too fast" — a batch job that fires requests
as fast as the network allows will violate a 1 req/sec policy almost
immediately otherwise.

## 3. A hybrid pattern worth reusing: enumerate from one source, name from another

The general shape, stated once since both §1.3 and §2.2 arrive at it
from different angles: when your authoritative geometry source can't
supply names, and your naming source can't enumerate, don't force
either tool outside its real competency — compose them, each doing
only what it's actually good at.

Concretely, this project's island-name lookup: decompose Natural
Earth's land/minor-island polygons into individual connected parts (a
`MultiPolygon`'s each element is one contiguous landmass — mainland
Europe is one giant connected part, each separate island is its own),
compute each part's area, and treat any part touching the query box's
own edge as clipped mainland rather than a real island (confirmed
directly: the biggest excluded parts by this rule were ~956,000 km²
and ~377,000 km², obviously continents, nothing resembling a real
island caught by it). This enumeration is complete and unbiased
relative to Natural Earth's own geometry, with zero dependency on
OpenStreetMap tagging completeness — it can't miss an island because
an OSM mapper forgot to tag it. OpenStreetMap then supplies only the
one thing the geometry source can't: each part's name, looked up at
that part's own representative point (§1.4).

## 4. A reusable service/widget architecture for this kind of data

Worth defaulting to on a similar "serve several small, independently
-sourced vector layers to a map widget" project:

- **A generating script writes its own `metadata.json`** next to the
  data it describes (display style — color/weight/fill, group, draw
  order, default visibility, which property is a label) rather than
  hand-duplicating that list inside the serving layer. Re-running the
  script with a different filter or style is then picked up with zero
  code changes anywhere downstream.
- **The serving layer (hmsvc) merges `metadata.json` from every known
  data directory**, not just one — adding a second, independently
  -generated data source (this project: Natural Earth's own output
  directory, then a separate OpenStreetMap-derived one) becomes "point
  the service at one more directory," not "teach the service about a
  new kind of layer."
- **The widget renders generically off each layer's own declared
  style**, never special-cased by layer id — a `render` kind (filled
  polygon / line / point-with-label / label-only), a color, an
  optional second hover-info field (`extraField`/`extraLabel`, generic
  over *any* numeric property a layer wants to surface — population
  for a city, area for an island). A brand-new layer with no widget
  -code change at all is the actual test of whether this generalization
  held: confirmed directly twice on this project (the OpenStreetMap
  island-name layer, then the Natural Earth seas layer) — both showed
  up correctly with zero widget-specific code added for either.

## 5. Building a gazetteer: merging and deduping independently-sourced named-entity layers

Once several named-entity layers exist (cities, islands, seas, rivers —
whatever a project has gathered), a flat, cross-source "gazetteer" —
one normalized record per named thing, regardless of which layer or
dataset it came from — is a genuinely different artifact from any one
of those layers, worth building as its own deliberate step rather than
leaving a consumer (a search box, a list widget) to merge several
differently-shaped layers itself:

- **Reduce every geometry to one point**, even for a layer whose real
  geometry is a line or an irregular polygon — a gazetteer is "a place
  you look up and jump to," not "a shape to render." Use the same
  guaranteed-inside-the-shape point discussed in §1.4 for an area
  feature; for a line feature (a river), use the point at the exact
  middle of its length (`interpolate(0.5, normalized=True)`, or
  equivalent), not an average of its endpoints, which can land well
  off the line for a winding path.
- **Expect real duplicates when merging two independently-built named
  -entity sources that cover overlapping ground**, and don't assume a
  simple "same name" string match will catch them — the two sources
  may use different transliterations of the same name. Confirmed
  directly: a fame-curated Natural Earth list and a size-curated
  OpenStreetMap list, built independently (in different sessions, for
  different stated reasons) over the same region, turned out to share
  4 of the larger list's 7 entries — the same real islands, named
  independently by each source. A proximity match (two points within
  some small tolerance of each other) is a reasonable dedup strategy
  when names might not match exactly — tune the tolerance against real
  confirmed-duplicate pairs the same way §2.3's distance-tolerance bug
  was tuned, not picked arbitrarily.
- **A proximity-based dedup must still respect semantic category
  boundaries** — a real bug hit building this project's own gazetteer:
  deduping blindly by distance wrongly dropped an *island group* entry
  ("Ionian Is.") because its own representative point happened to sit
  close to *one of its own member islands* ("Lefkada," already present
  from the other source) — a group and one of its members are not
  duplicates of each other, even though they're geographically
  coincident almost by definition. Fixed by only attempting the
  proximity match between entries of the same fine-grained category
  (single island vs. single island), not across a "island-ish" category
  that quietly conflated two different granularities of thing.
- **When sources disagree or one subsumes the other, prefer the entry
  with richer, independently-checkable provenance** — the OpenStreetMap
  copy of a deduped island (carrying `name_source`, `area_km2`,
  `country`, per §2.3's tiered-confidence fields) was kept over the
  Natural Earth copy (a bare name with no confidence tier at all),
  not because one source is generally better, but because that
  specific entry carried more of its own evidence along with it.

## 6. A local geocoding service: forward, reverse, and "things in this polygon" — and why local-only

A small hmsvc-style service over a gazetteer like §5's naturally wants
the three query shapes "geocoding" usually means, plus whatever
spatial-containment query the project actually needs:

- **Forward** (name → location): rank matches by tier (exact match,
  then starts-with, then plain substring), not just "contains the
  search text," so an exact or near-exact match doesn't get buried
  under loosely-related longer names containing the same substring.
- **Reverse** (location → nearest named things): compute a *real*
  distance (haversine / great-circle), not the flat-plane
  degrees-per-mile approximation §1 and this project's own bounding
  -box math use elsewhere. That approximation is fine for a one-off
  "is this bounding box roughly the right size" sanity check; a
  per-query distance a caller might actually display, sort by, or
  compare against a threshold deserves the real formula — it's cheap
  enough to compute per request over a gazetteer sized in the
  hundreds, and using the cheaper approximation here would be
  optimizing a cost that was never the bottleneck at the expense of an
  answer a caller might actually rely on.
- **"Things [of a type] in this polygon"**: implement the general
  case (an arbitrary posted polygon geometry, since that doesn't fit
  cleanly in a query string) and a convenience case (a plain bounding
  box via four query parameters) as the *same* underlying
  point-in-polygon check — the convenience form just builds a
  rectangular polygon and calls the general one, so the two can't
  silently drift apart into inconsistent behavior.

**Deliberately local-only — no live third-party geocoder call in the
request path.** Every query runs entirely over this project's own
already-fetched, already-cited data (§1, §2), not a live proxy to
Nominatim or anything else. This sidesteps, by construction, every
problem §2.2's own Overpass/Nominatim reachability section documents —
no rate limit to respect, no reachability to verify per environment, no
network dependency at request time at all — and keeps every answer
traceable to a `source_layer`-style field a caller can follow back to
the underlying data's own citation. The tradeoff, worth stating
plainly rather than glossing over: this only knows about what's already
been gathered into the gazetteer — it is not a general-purpose geocoder
for an arbitrary name the project hasn't already collected, and
shouldn't be presented as one.

## 7. Cross-widget navigation: a named-event contract, not a direct link

When one widget (a search/list UI) needs to drive what another widget
(a map) shows, and both are independently-authored `kind: "html"`
widgets with no way to call each other's code directly, the Bridge
API's own named-message channel (`desk.events.publish`/`subscribe`/
`onMessage`) is the right tool — and the contract between the two sides
is worth designing deliberately, not left implicit:

- **Agree on a flat, minimal payload shape** (this project: `{lon,
  lat, zoom?, label?}`) **that doesn't leak either widget's own
  internal data model** — the publishing widget's own record shape
  (a gazetteer entry, with its id/type/source-layer/etc.) and the
  receiving widget's own internal state (its layer cache, its
  feature-index bookkeeping) can then keep changing independently;
  neither widget needs to know anything about the other's internals,
  only the one shared message shape.
- **An event, not shared `desk.state`, for this** — Desk offers both a
  shared key/value store (`desk.state`, already used elsewhere in this
  project for hmsvc URL discovery) and this named-message channel;
  they suit different things. A "jump to this place" request is a
  one-off *action*, not a durable *value* either widget would want to
  read back later — publishing it as an event, rather than writing it
  into a shared state key, avoids inventing a fake "current target"
  value that would need its own stale-vs-fresh handling (was this the
  last click, or a leftover from three clicks ago?) for a concept that
  was never really a persistent value in the first place.
- **The message name itself is the only coupling** — there's no shared
  import, no shared type, no build-time dependency between the two
  widgets' source directories. Both sides simply agree, by comment and
  by convention, on the same string constant and the same payload
  shape. This is real coupling (change one side's contract and the
  other silently stops working, with no compiler to catch it) — worth
  a clear comment on both ends naming the other side explicitly, since
  nothing else makes the relationship visible.
- **A publish is a broadcast, not a targeted call** — `desk.events
  .publish` reaches every other widget instance currently subscribed to
  that name, not one specific instance. Don't try to address a specific
  instance through this channel; if that's genuinely needed, that's a
  different Bridge API capability (`desk.widgets`), not this one. The
  corollary worth designing for: the publisher cannot assume a receiver
  exists at all (zero placed instances of the receiving widget kind is
  a normal, silent no-op) — if that matters to the user, check via
  `desk.workspace.getState()` (a real, cheap read) and show your own
  hint rather than silently doing nothing when nothing is listening.

## 8. The general methodological takeaway

The same shape recurs across every section above: **a public dataset's
own documentation or layer name tells you what it's *for*, not
reliably what it actually *contains* in your specific region** —
`minor_islands_label_points` sounds like exactly the right layer and
has no names at all; `geography_regions_polys` sounds comprehensive and
is a fame-curated handful; `admin_0_map_subunits` sounds like it splits
island nations by landmass and doesn't, for this one; Overpass sounds
universally reachable and wasn't, here. The fix is the same every time:
**download the actual data (or hit the actual endpoint) and check**,
rather than reasoning from the layer's name, its stated purpose, or
general reputation — and when a check fails, that's useful, specific
information to route around (verify a neighboring layer, flip to a
different API, compose two tools instead of forcing one), not a reason
to assume the whole approach is unworkable. Equally, don't let a
pattern of real disappointments bias the next check toward a pessimism
that isn't earned either — the marine-polygon layer worked immediately,
precisely because it was actually tried rather than assumed to share
the island layers' fate.

The same discipline applies one layer up, past data-gathering into
building on top of what was gathered: §5's own two real bugs (a wrong
name-mix-up caught by noticing an implausible result, a group wrongly
deduped against its own member caught the same way) were both found by
**checking the actual merged output against what's actually true**, not
by the merge code looking correct on inspection — a proximity-based
dedup rule or a tiered fallback search can be logically sound and still
produce a wrong answer on a case its author didn't specifically think
through. Trust the result once it's been checked against known-correct
facts, not once the code reads plausibly.
