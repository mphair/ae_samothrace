# Investigation: a confirmed minor-band override may not always be live in the running widget

Status: **resolved — stale-instance artifact, not a code bug.** See §6.
Written 2026-10-16 from a real, observed discrepancy; closed the same
day after the user restarted the `samothrace-tiles` hmsvc and refreshed
the widget instance, which is exactly the "leading hypothesis" §3 named
below.

## 1. What was observed

Fragment 103 (Restored plan) was confirmed as part of a minor band at
elevation 36m earlier in this session (2026-10-14, `band-35-40-2`,
merged with fragment 35 into one logical contour). The answer is still
present, correctly, in `.desk_temp/minor-contour-review-log.json`.

During a later recording (2026-10-16, `rec-1792171571463-9b61`),
hovering fragment 103 live in the widget logged:

```json
{"plan":"restored","fragmentId":103,"elevationM":null,"elevationSource":"unlabeled",...}
```

`"unlabeled"`, not `"interpolated"` — the session-local override
(`ContoursLayerController.setFragmentElevationOverrides`, applied via
`MinorBandsTabController.applyOverridesFor` on every `init()`) does not
appear to have been active in the widget instance at that moment.

## 2. What's been ruled out

- **Not index drift from the pipeline re-run.** Fragment 103's geometry
  in the current `SamoWeb_RestoredStatePlan_Contours.geojson` is
  byte-identical in its own coordinates to what it was when originally
  confirmed (`[25.53081303834915, 40.501334723317186]` start point,
  checked directly) — same physical fragment, same array index, not a
  case of the known "array index shifts across re-runs" limitation.
- **Not a missing log entry.** `.desk_temp/minor-contour-review-log.json`
  still has the `band-35-40-2` answer, confirmed, elevation 36.
- **Not an obvious code path that clears `elevationOverrides`.**
  `ContoursLayerController.ensureLoaded`'s fragment-load completion hook
  only touches `this.resolved`/`rebuildGroups`/`scheduleRedraw` — it
  never touches `this.elevationOverrides`. `refreshLayerMeta` (the new
  hmsvc-restart-recovery path) doesn't touch `ContoursLayerController`
  at all. Neither looks like a plausible culprit from a source read
  alone.

## 3. Leading hypothesis — cheap to test directly

The widget instance that was running during the 2026-10-16 recording may
simply have been loaded (via the `[STALE]` badge, a human-driven,
agent-can't-trigger-it-themselves reload — see this widget's own
`AGENTS.md`) from a build that **predates** the
`setFragmentElevationOverrides`/`applyOverridesFor` mechanism's own
addition to the code, or from some point between that addition and a
later change that broke it, and simply hasn't been reloaded again since
whatever broke it (if anything did).

**Direct test**: after confirming the widget is freshly reloaded (no
`[STALE]` badge showing), hover fragment 103 again. If it now correctly
shows `interpolated`/36m, this was purely a stale-running-instance
artifact, not a code bug — nothing to fix, just note the lesson (a
`[STALE]` reload is sometimes needed to see session-local override
fixes land, same as for any other code change to this widget).

## 4. If the direct test shows it's still broken

Then it's a real bug, and the next things worth checking, roughly in
order of how cheap they are to rule out:

- Does `MinorBandsTabController.init()` actually run to completion for
  the `restored` plan in this specific session — add a temporary
  `console.warn` or check via the browser/webview console, since its
  `.catch()` in `SamothraceMapElement.init()` would silently swallow a
  failure (`"minor bands tab failed to load:"`).
- Is `this.onBandConfirmed` (the callback `MinorBandsTabController` was
  constructed with) actually wired all the way through to
  `ContoursLayerController.setFragmentElevationOverrides` in the
  currently-running build — i.e., re-check the exact constructor wiring
  in `samothrace-map.ts` hasn't regressed in a later edit.
- Whether `effectiveColorFor`'s own lookup key
  (`` `${plan}:${f.id}` ``) matches exactly what
  `setFragmentElevationOverrides` stores the override under — a subtle
  key-format mismatch (e.g. plan casing, or using `ContourPlan` vs
  `QaPlan`'s own string literals, which are structurally identical types
  but could theoretically diverge if one call site passes the wrong
  value) would produce exactly this symptom.

## 5. Why this matters beyond just fragment 103

This is the exact mechanism the brand-new "live control" request (see
`investigations/agent-autonomous-corrections-channel.md`) would build
on top of. If session-local overrides can silently fail to apply even
once already recorded correctly, that's worth understanding and fixing
*before* making the agent write to this same mechanism more often and
with less human-in-the-loop visibility into whether each change actually
landed.

## 6. Resolution (2026-10-16, same day)

After the user restarted the `samothrace-tiles` hmsvc and refreshed the
widget (a fresh, non-stale instance — confirmed via
`desk_list_widget_instances`, `"stale": false`), ran the §3 direct test,
but via pixel-color sampling instead of a live hover (no tool here can
drive the widget's own pointer, so a hover-triggered log entry wasn't
obtainable directly — see below for why color sampling is an equally
valid substitute).

**Method**: `ContoursLayerController.draw()`'s non-hover render path
calls `effectiveColorFor`, which renders CONTOUR_COLOR.minor
(`#f59e0b`) for ANY fragment with a live `elevationOverrides` entry —
unconditionally, not just on hover. So the override's live-or-not status
is directly visible in a plain screenshot, no pointer interaction
needed. Took a screenshot of the running widget instance
(`desk_screenshot_widget`, instance `34a5236c`, view already centered
near fragment 103 per its own saved UI state), then independently
reimplemented the widget's own `projectWorld`/`toScreen` web-mercator
math in Python against the exact same `view` (`lon`/`lat`/`zoom`) the
instance reported, to compute each candidate fragment's expected screen
pixel from its real geometry in
`Data/mapFeatures/SamoWeb_RestoredStatePlan_Contours.geojson` — then
sampled actual pixel colors there.

**Result — amber (`#f59e0b` exactly) found at the computed location for
every one of the 7 currently-confirmed override fragments**
(35, 36, 37, 38, 45, 103, 134 — all of `band-35-40-0/1/2` and
`band-45-50-0/3` from `.desk_temp/minor-contour-review-log.json`),
**and absent at all 8 sampled control locations** (on-screen fragments
whose own `elevation_source` is also `"unlabeled"` but which are NOT in
any confirmed-override group). Fragment 103 specifically: amber present
in its immediate neighborhood, same as its confirmed partner fragment
35.

**Conclusion**: the `elevationOverrides` mechanism is working correctly
and was live for fragment 103 in this fresh instance. The 2026-10-16
`"elevationSource":"unlabeled"` hover-log entry that started this
investigation is explained by the leading hypothesis in §3 — a
stale-running-widget-instance artifact (the recording in question
predates this session's restart/refresh) — not a real bug in the
override code. Nothing to fix. Lesson for next time, same as any other
code change to this widget: a `[STALE]` badge means the running instance
may not reflect recently-added session-local state either, not just
recently-added code.
