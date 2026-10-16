# Investigation: a channel for the agent to apply corrections live, without per-item user confirmation

Status: **early, not designed yet**. Written 2026-10-16, directly
requested: *"once you figured out what was going on with fragments
{134, 89, 45}, you should have been able to have those changes show up
in the UI immediately, as if I had confirmed it in an item in the Q/A
tab."*

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
