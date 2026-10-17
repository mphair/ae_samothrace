# Investigation: a channel for the agent to apply corrections live, without per-item user confirmation

Status: **first slice shipped, same day (2026-10-16).** Written after
being directly requested: *"once you figured out what was going on with
fragments {134, 89, 45}, you should have been able to have those changes
show up in the UI immediately, as if I had confirmed it in an item in
the Q/A tab."* See §5 for what actually got built and how it answered
(or deliberately left open) each of §3's questions below — §§1-4 are
kept as originally written, for the reasoning trail.

## 1. The gap this closes

Today (2026-10-16), when the agent investigates and resolves something
like the 134/89/45 minor-band fragmentation (real session example: see
the chat transcript around `rec-1792171571463-9b61`), the actual
mechanism is: write JSON directly into
`.desk_temp/contour-connector-log.json` and
`.desk_temp/minor-contour-review-log.json` via a one-off Python/Bash
snippet, matching their existing schemas by hand. This durably records
the correction correctly (same files the UI itself writes), but it
**does not show up live** — the session-local override machinery
(`ContoursLayerController.setConfirmedConnections`/
`setFragmentElevationOverrides`) only re-reads these files from
`MinorBandsTabController`/`ContourConnectorTabController`'s own
`init()`, which only runs once per widget load. The user has to notice
and manually trigger a `[STALE]`-badge reload to see it (and per
`investigations/session-local-override-not-live.md`, even that may not
reliably work right now).

Contrast with the **Agent Q&A tab** (`samothrace-map-agent-qa-tab.ts`),
built 2026-10-13: an agent writes a question to a polled file, the user
clicks Confirm/Reject in the UI, and the answer both durably saves *and*
applies live immediately — no reload needed, because the confirm button
handler is already live code calling straight into the same
`applyConfirmConnection`/`ContourConnectorTabController.
applyExternalDecision` path. What's being asked for here is **the same
live-apply guarantee, but triggered by the agent's own decision
directly, skipping the "wait for a human click" step** for cases where
the agent has already done the investigation and is confident.

## 2. Likely shape (not finalized)

A new polled file, parallel to the Agent Q&A pair but asymmetric (no
corresponding "answer" from the user, since nothing is being asked):

- `.desk_temp/samothrace-map-agent-patches.json` (name TBD) — the agent
  appends a "patch" (own uuid, a type tag matching the question types
  that already exist: `confirm-connection`, `confirm-minor-band`, plus
  whatever else turns out to be needed, each with the same `data` shape
  its matching Agent Q&A question type already uses).
- The widget polls it the same way `AgentQaTabController` already polls
  its own question file (reuse that exact mechanism/interval rather than
  inventing a second one).
- On seeing a new patch, **immediately** (no user action required):
  1. Write it into the correct durable file
     (`contour-connector-log.json` / `minor-contour-review-log.json`),
     same schema the UI itself already writes.
  2. Call the same live-apply path the UI's own confirm button would
     (`ContourConnectorTabController.applyExternalDecision` /
     `ContoursLayerController.setFragmentElevationOverrides` via
     `MinorBandsTabController`'s own `applyOverridesFor`-shaped logic) --
     reusing existing code, not forking it.
  3. Append an acknowledgment to a matching
     `samothrace-map-agent-patches-applied.json` (or similar) so the
     agent can confirm the patch actually landed, the same
     read-back-the-answer-file pattern Agent Q&A already has (including
     its own documented gap -- see
     `FEEDBACK-DESK-agent-qa-file-polling-2026-10-13-1845.md` in
     `../../inadvisable-adventures/FEEDBACK/` -- a real MCP tool pair
     would help this channel too, not just Agent Q&A).

## 3. Open questions -- genuinely unresolved, don't guess here

- **Visibility/trust**: these changes happen with no human click at all.
  Should the widget show *some* indicator when an autonomous patch lands
  (a toast, a highlight, an entry in a visible "recent agent changes"
  list) so the user isn't surprised days later by a change they never
  explicitly saw happen? The whole project's recording/logging ethos
  (see `AGENTS.md`'s own "why recording exists" section) has been about
  making agent reasoning and timing traceable after the fact -- this
  should probably inherit that, not quietly bypass it.
- **Provenance in the durable files**: should an autonomously-applied
  entry be tagged distinctly from a user-confirmed one (e.g. a
  `appliedBy: "agent-autonomous"` field) so `apply_contour_connections.py`
  /`apply_minor_review.py` (once that one exists) and any future review
  can tell the two apart? Current schemas (`LogConnection`,
  `MinorBandGroupAnswer`) have no such field.
- **Scope of what's eligible**: should this be limited to the same two
  question types Agent Q&A already has (confirm-connection,
  confirm-minor-band), or could/should it cover other kinds of decisions
  later? Start minimal, same precedent Agent Q&A itself set.
- **Reversibility**: the Connector tab already has a "Remove" button for
  confirmed connections; Minor Bands has no equivalent undo UI yet. If
  autonomous patches turn out to need correcting more often than
  human-confirmed ones (plausible, if the bar for "agent confident
  enough to skip asking" is set too low), undo-ability matters more here
  than it has so far.
- **Relationship to `investigations/session-local-override-not-live.md`**:
  this channel amplifies exactly the failure mode that investigation is
  about (a correction that's durably recorded but doesn't visibly apply)
  -- probably worth resolving that investigation, or at least
  understanding it, before leaning on the same live-apply path more
  heavily and with less human-in-the-loop visibility into whether each
  change actually landed.

## 4. Not yet done

No code written for this yet -- this doc exists to capture the ask and
the shape before the next session picks it up, per the user's own
explicit "write up ... the beginnings of an investigation" framing.

## 5. What got built (2026-10-16, same day)

Built as "AgentPatchChannel" -- not a new standalone controller, folded
directly into `AgentQaTabController`
(`desk_widgets/samothrace-map/samothrace-map-agent-qa-tab.ts`), reusing
its existing poll loop rather than inventing a second one (§2's own "reuse
that exact mechanism/interval" instruction). File pair matches §2's
sketch almost exactly: `.desk_temp/samothrace-map-agent-patches.json`
(agent-authored) / `.desk_temp/samothrace-map-agent-patches-applied.json`
(widget-authored ack).

**How each §2/§3 open question actually landed**:

- **Mechanism (§2)**: matches the sketch -- write the durable log entry
  (same shape a human Confirm click produces), call the same live-apply
  path (`ContourConnectorTabController.applyExternalDecision` /
  `ContoursLayerController.setFragmentElevationOverrides`), ack the
  patch. One deliberate simplification versus the sketch: no separate
  `MinorBandsTabController`-shaped "apply" method was added for the
  minor-band case -- `AgentQaTabController` writes
  `MINOR_BAND_LOG_PATH` and calls the same `onBandConfirmed` callback
  shape `MinorBandsTabController` already uses directly, rather than
  routing through that controller at all. Simpler, and avoids giving one
  tab controller a dependency on another's internals.
- **Visibility/trust (§3)**: resolved as "a visible, timestamped list,
  not a toast." Every applied patch (success or failure) renders as an
  "⚡ Applied automatically" row in the Q&A tab for as long as it's within
  the most recent `AGENT_PATCH_VISIBLE_HISTORY` (8) -- older ones stay in
  the never-trimmed ack file but drop off the visible list. Deliberately
  does NOT pan/zoom the camera to an autonomously-applied change (only an
  optional highlight flash, same duration as any other "Show me," if
  that spot happens to already be in view) -- panning unprompted felt
  like it would fight whatever the user was actually doing at that
  moment, worse than just showing up quietly in the sidebar.
- **Provenance (§3)**: resolved exactly as sketched -- `appliedBy:
  'agent-autonomous'` added to both `LogConnection`
  (`samothrace-map-connector-tab.ts`) and `MinorBandGroupAnswer`
  (`samothrace-map-qa-panel.ts`), optional, absent on every
  human-confirmed entry, confirmed harmless for
  `scripts/apply_contour_connections.py` (reads entries by explicit key
  access into a newly-constructed dict, extra fields are simply never
  read, not a schema-validated parse).
- **Scope (§3)**: resolved as "exactly the two actions already proven in
  this session" -- `'confirm-connection'` (reuses
  `ConfirmConnectionQuestionData` as-is) and the new
  `'confirm-minor-band'` (mirrors `MinorBandGroupAnswer`'s own
  `fragments` shape). No reject/undo patch type -- a patch only ever
  *adds* a confirmation.
- **Reversibility (§3)**: **resolved, same day, before this work was
  committed.** The user asked directly for OK/Undo buttons on applied
  -patch rows (folded into the same archiving request covered in §6
  below). Undo now reverses the live change --
  `ContourConnectorTabController.removeConfirmedById` (new, delegates to
  the same removal path the tab's own manual "Remove" button already
  uses) for a connection patch, `ContoursLayerController.
  clearFragmentElevationOverrides` (new) plus a direct
  `MINOR_BAND_LOG_PATH` entry removal for a minor-band patch -- AND
  converts the patch into a real pending question (same `data`/`reason`)
  rather than just discarding it, so "undo" never means "lose what the
  agent found," only "hand it back for a deliberate decision."
- **Relationship to session-local-override-not-live (§3)**: that
  investigation is now resolved (see its own §6) -- the override
  mechanism this channel also writes through was confirmed live and
  correct via direct pixel-sampling verification the same day, clearing
  the specific risk §3 flagged before leaning on it further.

**Verification status**: compiles clean (`tsc -p desk_widgets/samothrace-map`,
exit 0). Not yet exercised end-to-end with a real agent-authored patch
file in a live session -- only read through carefully against the
existing question/answer and Minor-Bands/Connector code paths it reuses.
First real patch written by an agent should be treated as this feature's
actual first test, not just the compile check.

## 6. Archiving + OK/Undo (same day, folded in before anything above was committed)

Directly requested, before this whole feature's code was committed:
*"I'd like to add an archive to the Q/A panel. When a user confirms or
rejects or otherwise answers a question, the question should be
archived, after a placeholder message appears in its same place saying
how it was answered and that it is being archived, which then animates
away after 5s, starting with a 3s fade and then a vertical collapse over
0.5s. With automatically-applied changes, instead of a confirm/reject,
it should be ok/undo, and clicking undo should undo it and convert it
into a question instead, so as not to lose the agent's change."*

Scoped, via the user's own explicit choice among three offered options,
to **the Agent Q&A tab only** -- Label Review, Minor Bands, and the
Connector tab's own confirmed-list UI are untouched.

**What shipped**: covered in detail in this widget's own `TODO.md`
(search "Archiving") and `AGENTS.md`'s file-manifest entry for
`samothrace-map-agent-qa-tab.ts`. In short --
- Answering a question, or OK/Undo-ing an applied-patch row, shows a
  placeholder, then a CSS `@keyframes` animation (not a `transition` --
  this renderer's full-`innerHTML`-replace-per-change approach can't
  support a transition reacting to a prior style) fades it out over 3s
  and collapses it over 0.5s after an initial 5s hold, then it stops
  rendering in the MAIN list (see §7 below for where it goes instead).
- "Archived" is a pure DERIVED status (answered-and-not-animating for a
  question; `resolution`-set-and-not-animating for a patch), not a
  separately-tracked flag -- so a question/patch already resolved the
  FIRST time this tab loads (a prior session, or a different Desk
  instance) is simply already-archived from the first render, no
  animation needed or played.
- Undo closes this doc's own §3/§5 "reversibility" gap directly (see the
  updated bullet above) -- and required `'confirm-minor-band'` becoming a
  real first-class QUESTION type, not just a patch type, since Undo needs
  somewhere to hand a minor-band patch BACK to for a real decision.

This answers the open question §3 raised about undo more completely than
expected going in -- not just "can a connection be undone" but a general
pattern (apply live -> show -> OK or undo-and-reconsider) that could, in
principle, extend to future patch types the same way.

## 7. Archive drawer + Reset (same day, immediately following §6)

Directly requested right after §6 landed, before any of this was
committed: *"please add a slide-up-from-the-bottom panel to the Q/A tab
which shows archived items. Items should all have 'reset' buttons, which
undoes the decision and returns the item to the main Q/A section. allow
sorting by question age or answer age, default sort: ascending by answer
age."*

**What shipped**: a collapsed-by-default drawer pinned toward the bottom
of the tab, listing every archived question and `'ok'`-resolved
applied-patch row (an `'undo'`-resolved one is excluded -- its lineage
continues via the question §6's own Undo spawned, not as its own entry),
each with a Reset button and sortable by question age or answer age
(default ascending-by-answer-age = most-recently-resolved first).

The one real design decision this forced: `AppliedPatch` (the durable
record in `.desk_temp/samothrace-map-agent-patches-applied.json`) needed
new `resolution`/`resolvedAt` fields. Without them, "has this applied row
been OK'd/archived" would have had nowhere durable to live -- a purely
in-memory flag would make Reset pointless (archived-ness, and therefore
what Reset even has to undo, would evaporate on every reload) and would
also mean a freshly-reloaded widget shows every past applied patch as
"live" again regardless of whether a human had already OK'd it. Writing
the resolution durably, and letting "archived" be DERIVED from it rather
than tracked separately, fixed both problems at once and turned out
simpler than the original (now-removed) in-memory-Set-based design from
§6 -- see this widget's own `TODO.md` for the fuller before/after.
