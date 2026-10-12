# Targeted, incremental pipeline runs

Status: **deferred — no action item**. Captured so the discussion isn't
lost, not because anything here is scheduled to be built. Revisit only if
a targeted pipeline run (once it exists) actually feels sluggish in use —
see §3.

## 1. The core idea

Part of the broader "live interaction" discussion (see
`plans/samothrace-map-consolidation.md` for the widget-side half of that):
instead of always re-running `scripts/extract_vector_layers.py` over both
whole plan mosaics, wrap a **region-scoped** version of the pipeline (takes
a bounding box, processes just that crop) as an **Installed Job**. Installed
Jobs are approved once (`desk_install_job`) and then callable by me directly
via the `desk_run_installed_job` MCP tool, with no further human click —
unlike the one-shot `Job`/`DeskProc` tempui mechanism, which needs a fresh
file dropped and a Start button clicked every single time. That's what
makes this viable as something closer to real-time: I could re-run
extraction on just the area you're pointing at and get a result back within
the same conversation turn.

## 2. The incremental refinement

Targeted (spatially scoped) isn't the whole story on its own — a region
-scoped run still redoes every stage (structure exclusion, border
exclusion, circle-chain exclusion, label-gap merge, minor-band
interpolation, ...) from scratch every time. The idea floated: make it
genuinely *incremental* too — only recompute a stage if its actual inputs
changed since the last run, by storing each stage's output on disk
alongside version/dependency metadata (which inputs it was computed from),
similar to a small build-system or content-addressed cache layered over the
pipeline's own stages.

## 3. Where we landed

Counter-proposal: measure before building that caching machinery, since the
full two-plan pipeline already runs comfortably fast today (well under
Bash's own 2-minute default timeout; a region-scoped crop would be faster
still — the actual per-stage numpy/skeletonize/etc. work on a small array
is cheap). The likeliest *real* cost in a region-scoped run is probably
tile-fetching/stitching the crop from the hmsvc and any OCR calls inside
it, not the stage computations themselves — so if caching ever turns out to
be worth adding, the first candidate would be a small, targeted cache of
the **stitched crop raster** (keyed by region bounds + zoom), not full
stage-level dependency versioning.

Final call: don't even measure proactively. Build the region-scoped
Installed Job first (whenever that work actually starts), use it for real,
and only come back to this if it *feels* too slow in practice — at which
point actually profile where the time goes before deciding what (if
anything) from §2 is worth building.

## 4. Revisit trigger

None scheduled. Come back to this doc if/when the region-scoped pipeline
job exists and using it feels sluggish.
