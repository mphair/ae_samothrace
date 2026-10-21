# Development rules

Binding conventions for working in this project, recorded as decisions get
made. Entries are added over time; once an entry is here, follow it.

## Shared widget code location

Code shared between more than one `desk_widgets/<name>/` widget lives in
`desk_widgets/_shared/`.

Context: decided 2026-10-21, in response to a request to extract the Desk
Bridge access and hmsvc-fetch logic shared by `desk_widgets/layer-stack` and
`desk_widgets/layered-map` into a shared library. Before this decision,
every `desk_widgets/<name>/` directory was
fully self-contained — its own `tsconfig.json`, building independently into
its own `.build/` — with no existing convention for code shared across more
than one widget's build. `desk_widgets/_shared/` is the one blessed location
for that going forward (the leading underscore marks it as shared support
code, not a widget kind of its own).

## No "Desk" naming outside the shared library's own implementation

Widget code (anything in a widget's own `desk_widgets/<name>/<name>.ts`)
must not reference `desk`/`window.desk` directly, and the shared library's
own **interface** (the types/functions widget code actually imports/calls)
must not use "desk" in its naming either — not in the interface's exported
type/function names, and not in its own filename. Only the shared library's
concrete **implementation** module (the one file that actually calls
`window.desk.*`) may mention "desk," including in that file's own filename.

Context: decided 2026-10-21, for the same shared-library extraction as the
entry above. The point of the extraction is that a non-Desk environment
(a plain static webpage, no Desk runtime behind it) can later supply its own
implementation of the same interface. An interface that itself leaks "desk"
naming would defeat that — widget code and the interface it depends on
should read as platform-agnostic; "Desk" only belongs in the one module that
is actually Desk-specific.

## Tile-image URLs never come from a plain string template — go through `resolveTileUrl`'s manifest

A widget must never construct a `/tiles/...` URL itself (string-templating
a service's base URL with `{layer}/{z}/{x}/{y}`) — always call
`SharedPlatform.resolveTileUrl(service, layerId, zoom, tx, ty)` instead. Any
tile-serving hmsvc that wants a layer's own image bytes to be correctable or
re-bakeable after the fact (without ever changing what an already-published,
long-cached tile URL points to) publishes a `/manifest` endpoint (short,
~1 minute `Cache-Control`) recording that layer's current `version` — mapped
via a fixed `urlTemplate` to the real tile URL — plus a per-tile `overrides`
map for one-off corrections, served from a `/corrections/{filename}` route.
A layer with nothing to re-bake (a plain passthrough/static file) doesn't
need a `{version}` segment in its own template at all — the manifest schema
still carries a `version` field for uniformity, it just never changes.

Context: decided 2026-10-21, for an aws_am_samothrace request needing to
update deployed tile images post-launch without disturbing already-cached
URLs. Both `desk_hmsvc/samothrace-tiles/` and
`desk_hmsvc/samothrace-tiles-static/` implement this manifest for real (not
a Desk-only shortcut), so testing a correction locally in Desk exercises the
same mechanism that runs once deployed. See
`desk_hmsvc/samothrace-tiles-static/service.py`'s own header comment for the
fullest worked example (versioned vs. un-versioned layers side by side).
