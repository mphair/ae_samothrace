# `map-text-extractor`: layered feature extraction from the Theban Tribunal map

Status: **unblocked and verified — §3's changes are deployed and all three
reported bugs confirmed fixed**. §4/§5 (the blocker and its resume
checklist) are kept below as a historical record of what happened and
how it got fixed, not as outstanding work. See §7 for what's actually
left (all non-blocking).

## 1. Goal

Working from one dropped screenshot (`f2f4f4e6-...png`, "The Theban
Tribunal, 1220 A.D. — Realms and Cities," a fictionalized political map of
the Aegean) toward a reusable process for pulling structured, useful
information out of maps like this — starting with: a gazetteer of named
geographic/political features and their locations, and specifically the
realm-border geometry, to eventually cross-check against whatever
historical support exists for these fictional divisions circa 1220.

Everything here runs as the `map-text-extractor` Installed Job
(`desk-installed-jobs/map-text-extractor/`: `main.py` orchestrator +
dedicated venv, `extract.py` the real pipeline). Per instructions from
early on, the source image and everything derived from it stay under
`.desk_temp/AM-Theban-Tribunal-overview/` — nothing here is committed to
the repo (`.desk_temp/` is gitignored wholesale); the job's own *source
code*, by contrast, is real durable source meant to be committed (not yet
committed as of this writing — see §6).

## 2. Where this stood before the current round

A working multi-layer extraction pipeline, iteratively refined over
several rounds (full blow-by-blow in `.desk_temp/AM-Theban-Tribunal-overview/NOTES.md`,
which `extract.py`'s own header docstring also narrates in less
historical, more current-state form):

- **text / border / mountain / other** base layers, separated mostly by
  measuring this map's own actual ink properties rather than guessing —
  realm borders are a specific dash shade+size signature (not just "small
  dark blob"), mountains are a near-horizontal stroke within 20% of the
  legend's own two sample sizes **and** a specific lighter-grey shade
  distinct from political-black ink.
- **Realm-border chain detection**: proximity graph of dash-like
  candidates → chain-topology filtering (a border is a thin chain, a
  mountain hachure field is a 2D mesh) → bridging across real text
  interruptions → endpoint extension (claims nearby already-correctly
  -shaped-and-shaded dashes that were simply too isolated to form their
  own chain) → diagnosis of whatever's still dangling (near a
  coastline/river, near a mountain field, or genuinely unclear).
- **City squares**: the "Major City" marker, found via morphological
  opening (recovers squares fused with their own city name's first
  letter) against the legend's own sample square.
- **Realm map**: border ink + "realm name" text (political-black text
  that isn't a city name and isn't the title/legend/scale-bar).

## 3. What changed this round (deployed and verified — see §6)

Prompted by direct, specific bug reports after reviewing the previous
round's output:

1. **Border/river and border/mountain shade-coincidence** — investigated
   (including a reverted whole-image shade-resplit attempt that
   over-fragmented everything), landed on: most "lost" dashes near a
   coastline/river/mountain weren't actually ink-fused with anything,
   they were already correctly detected but too isolated to chain or
   bridge. Fixed via the endpoint-extension step in §2. Already verified
   working in the previous round.
2. **OCR-based title detection** (`detect_title_block` in `extract.py`,
   using `easyocr` — now a dependency in the job's own `requirements.txt`,
   along with `certifi` for first-run SSL on a fresh machine). Finds the
   title block by SHAPE (multiple stacked lines sharing a common
   horizontal center — a title is conventionally centered; an incidental
   nearby map label isn't), not by matching known words — **this map's
   own text content is deliberately never written into `extract.py` as a
   literal string**, per explicit instruction. New `title_mask.png`/
   `title_only.png` outputs; title ink removed from `text`/`realm_mask`.
3. **Approximated border reconnection across the title block**
   (`reconnect_border_across_title`) — where a border line passes
   directly under the title text (confirmed: two chain endpoints right at
   the title's edges, same height, nothing recoverable between them since
   border ink and title ink are the same shade here, unlike the
   river/mountain case). Draws an explicitly-separate
   `border_approximated_mask.png` connector (orange in
   `debug_overlay.png`), never silently merged into "detected" ink.
   **A real pairing bug was caught and fixed before shipping**: the first
   version greedily matched each endpoint to its single nearest neighbor
   independently, which paired the two obviously-correct same-height
   endpoints with two *different*, unrelated, lower-down endpoints
   instead of with each other — a locally-greedy-but-globally-wrong
   result. Fixed by collecting all valid pairs first (requiring both
   title-crossing geometry AND y-alignment) and resolving them in order
   of increasing distance.
4. **City-square rescue pass** — a square touching something thicker than
   a letter (a coastline, confirmed on the Constantinople marker, which
   sits right against the Sea of Marmara) can survive the normal opening
   kernel fused and oversized/under-filled. Retried locally with
   progressively stronger opening kernels just for that one candidate;
   confirmed this isolates it cleanly (fill ratio 0.99 at the strongest
   kernel tried).
5. **Label-growing fix for city-name association** — this is the
   "Constantinople"/"Latin Empire" bug reported directly. The old logic
   checked each text FRAGMENT's own distance to the nearest square
   independently (`CITY_NAME_SEARCH_RADIUS`), which (a) split
   Constantinople's own name in half across that radius, since its larger
   font makes it wider than other cities' names, and (b) wrongly pulled
   "Empire" (from "Latin Empire") onto a city-name mask because it
   happened to be the single nearest fragment to some other square. Fixed
   by finding one nearest-component seed per square, then GROWING that
   into the full connected label (`_grow_label_cluster`, small
   edge-to-edge gap tolerance) — i.e. deciding by "is this the rest of
   the same name," not "is this fragment within some blind radius."

## 4. The blocker (resolved — see §6 for root cause and fix)

`desk_install_job` (re-approving the job's changed source, required
before `desk_run_installed_job` will run the new version) has failed 9
consecutive times with the identical error:

```
GuiBridge: GUI thread did not respond in time
```

No variation across attempts, including a retry after the user confirmed
no other Desk sessions were active (which weakens, without fully ruling
out, an earlier theory that a concurrently-active second session was
contending for Desk's GUI thread). Full narrative, verbatim error text,
and the verbatim exchange about what "GuiBridge" even is:
`../../inadvisable-adventures/FEEDBACK/FEEDBACK-DESK-install-job-guibridge-timeout-during-concurrent-session-2026-10-19-1108.md`.

This is a Desk-side bug, not something fixable from within this project —
nothing left to try here except wait and retry.

## 5. Resume checklist, once `desk_install_job` works again (historical — all done, see §6)

1. ~~`desk_install_job(name="map-text-extractor")`~~ — done.
2. ~~`desk_run_installed_job(...)`~~ — done. `easyocr`'s model weights were
   already cached from earlier manual testing, so no re-download needed.
3. ~~Verify the three specific bugs~~ — all three confirmed fixed, see §6.
4. ~~Re-run the usual eyeball pass~~ — done, nothing else regressed.
5. ~~Update `NOTES.md`~~ — done, same round as this doc's own update.
6. ~~Report back to the user~~ — done.

## 6. Resolution

**The blocker itself turned out to be caused by this very round's own
changes** — not an unrelated Desk flake. Root cause, found by a Desk
-expert agent (`desk_ask_desk_expert`) asked to investigate the live
session: this job's self-managed venv had grown to ~1GB/27k files once
`easyocr`→`torch` got added in §3, and it lived INSIDE
`desk-installed-jobs/map-text-extractor/` (alongside `main.py`/
`extract.py`). Desk's own `compute_version_hash` walks every byte of
every file under a job's directory on every `desk_install_job`/
`desk_run_installed_job` call, with no exclusion for a venv (unlike rust
jobs' own `target/`). That hash computation took ~5-5.5s against this
one directory — right at/over `GuiBridge.call`'s hardcoded 5-second
timeout both calls go through — so every single attempt failed
identically, reboot-proof, regardless of anything else happening in the
session (which is also why the "concurrent session contention" theory
in §4 never actually held up under testing — it was never contention,
just a deterministic timeout).

Fix (project-side, no Desk changes needed): moved the venv out of the
job's own directory entirely, to `.desk_temp/job-venvs/map-text-extractor/.venv`
(`main.py`'s own `VENV_DIR`, now `PROJECT_DIR / ".desk_temp" / "job-venvs" / JOB_DIR.name / ".venv"`
instead of `JOB_DIR / ".venv"`), and deleted the old 1GB venv sitting in
`desk-installed-jobs/map-text-extractor/`. That brought the job's own
directory down to 88KB (3 source files), and `desk_install_job`
succeeded on the very next attempt.

Full Desk-expert investigation + the Desk-side bug report (for whoever
maintains Desk itself — this project-side fix works regardless, but the
underlying venv-hashing behavior is still worth fixing upstream):
`../../inadvisable-adventures/FEEDBACK/FEEDBACK-DESK-install-job-guibridge-timeout-unhashed-venv-2026-10-19-1250.md`
(referenced from `.desk_temp/NOTE-map-text-extractor-install-timeout-diagnosis.md`,
which is the expert's own summary note).

**Verification, all three originally-reported bugs confirmed fixed**:

- Constantinople's name shows complete on `city_only.png` (was split
  "Cons-"/"-ple" on the realm map + "-tantino-" on the city map).
- Constantinople's own city square now appears in `city_only.png` (was
  missing — the coastline-fusion case, fixed by the local rescue-opening
  pass).
- "Latin Empire" shows complete on `realm_map.png` (was split: "Latin"
  on the realm map, "Empire" wrongly pulled onto the city map).

**One pleasant surprise**: the title-crossing border reconnection
(§3's orange-connector mechanism) reported 0 connections made, not the
1 expected. Checked directly rather than assumed this was a regression:
the two endpoints that looked like they'd need an approximated bridge
are actually the two ends of one already-fully-connected 7-dash chain —
real detected ink already runs continuously under "...CITIES", recovered
earlier by the (older, already-verified) endpoint-extension mechanism
before the new title-aware reconnection code ever got a chance to run.
`debug_overlay.png` confirms: one unbroken green line, no orange segment
anywhere. The approximation machinery is real and tested (the pairing
-bug fix in §3 item 3 is confirmed correct), it just wasn't needed on
this particular crossing.

## 7. Not yet started / explicitly deferred (for later, not blocked)

From `NOTES.md`'s own open questions, still open as of this writing:

- Realm-border coverage is better but not complete — worth asking
  whether current coverage is enough to start real historical
  cross-checking, or whether a specific stretch still needs to be
  continuous first.
- City-square false positives: ~27 candidates, ~8 confirmed real by eye,
  no clean geometric separator found (checked directly: fill-ratio and
  mean-gray both span the same range for real squares and likely false
  positives). A quick human pass marking which of the ~27 are real is
  probably the efficient move, not more threshold-chasing.
- The interactive review-widget idea (buttons/checkboxes, or a fuller
  inking-canvas widget) was offered but not built — the endpoint
  -extension fix resolved most of what looked like it would need human
  judgment. Revisit if the remaining unclear endpoints or city-square
  list turn out to actually need it.
- Generalization: still only tested against this one map. Unknown
  whether other maps in whatever collection this feeds use a different
  drawing convention (color fills, different line weights, photographed
  rather than scanned) that would need a different approach.
- The job's own source (`desk-installed-jobs/map-text-extractor/`) has
  never been committed — currently fully untracked. Not committed
  without being asked, per standing instruction, but worth doing once
  this round's fixes are verified working.
