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
