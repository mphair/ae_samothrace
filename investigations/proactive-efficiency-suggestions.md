# Investigation: having the agent proactively suggest efficiency improvements, unprompted

Status: **very early, exploratory**. Written 2026-10-16, directly
requested: *"figure out some ways that you could proactively (without
being prompted) suggest improvements to the widget or pipeline or the
MCP so that we can make this process more efficient."* This doc is
meant to seed that discussion, not settle it.

## 1. Why this is worth doing -- a real example from this same session

The Actual-plan pipeline-scope reduction (2026-10-15: ~12s -> ~5.3s per
run) is exactly the KIND of finding this capability should surface
unprompted. In reality, it only happened because the user directly
asked "how much of the current pipeline needs to run on [actual] to get
that data? can we get away with a subset?" -- the measurement (`~7.8s of
~12s spent on output nothing downstream read`) was sitting there,
discoverable, the whole time before that question was asked. The goal:
notice and surface things like that *without* needing the question
asked first.

Second example, even closer to home: this session's own
`investigations/agent-autonomous-corrections-channel.md` -- the pattern
of "hand-write JSON via a Bash/Python one-off, then tell the user to
reload" repeated at least three times this session (restored-auto-gap-100,
band-35-40-0/1/2/3, band-45-50-0/3) before the user pointed out it
should be live instead. An agent noticing "I've now done this same
manual workaround three times" and raising it unprompted is a concrete,
checkable instance of the capability being asked for here.

## 2. Two different kinds of "efficiency," worth treating separately

- **Computational efficiency**: pipeline run time, redundant
  recomputation, caching opportunities, unnecessary data being
  generated/stored (e.g. the now-deleted Actual-plan contour outputs
  nothing read), tile-serving cost, anything with a measurable number
  attached.
- **Interaction/workflow efficiency**: repeated manual steps a human or
  agent keeps doing that a tool/mechanism could absorb (the
  hand-written-JSON pattern above; needing a manual `[STALE]` reload
  for every code change; the Agent Q&A polling delay noted in
  `FEEDBACK-DESK-agent-qa-file-polling-2026-10-13-1845.md`). Harder to
  measure than computational efficiency, but arguably where most of this
  session's real friction actually was.

## 3. Candidate mechanisms -- not evaluated against each other yet

- **A periodic self-review pass**, using this environment's own
  `/loop`/scheduled-wakeup mechanisms, that occasionally re-reads
  recent activity (git log, this widget's own TODO.md, recent
  `desk_query_widget_log` history, recent FEEDBACK files) and asks "is
  there a pattern here worth flagging" -- output appended somewhere
  durable (a running suggestions doc, or a TODO.md entry) rather than
  interrupting mid-task.
- **An end-of-task self-check**, baked into working habits rather than
  a separate scheduled process: after finishing a nontrivial piece of
  work, spend one short pass asking "did I just do something manually
  that's the third time I've done it this way" or "did I just measure
  something whose answer is surprising" -- closer to a checklist habit
  than new infrastructure, cheapest to start with.
- **Mining the recording/widget-log infrastructure this project already
  built** as a data source: the whole point of
  `samothrace-map-recording.ts` and `desk_query_widget_log` is making an
  agent's own reconstruction of "what happened and when" possible after
  the fact -- the same data could plausibly feed a periodic "what kept
  happening that a human had to repeat" pass, not just one-off
  "reconstruct this specific moment" lookups.

## 4. Open questions

- **Where do unprompted suggestions actually surface?** Mid-conversation
  (risks being intrusive/off-topic for whatever the user is currently
  doing), a running doc the user checks on their own schedule, or a
  dedicated low-noise channel (another Agent Q&A-shaped mechanism,
  ironically)?
- **What's the false-positive cost?** A suggestion engine that's noisy
  gets ignored; one that's silent misses the point entirely. No
  calibration data exists yet -- this needs real trial-and-adjustment,
  not a one-shot design.
- **Scope**: "the widget or pipeline or the MCP" is broad. Likely needs
  narrowing to concrete trigger conditions (e.g. "flag it when the same
  manual workaround happens 3+ times," "flag it when a measured number
  surprises the agent itself") rather than an open-ended "always be
  looking for optimizations" mandate, which risks constant low-value
  noise.

## 5. Not yet done

No mechanism built, no decision made on shape. This doc exists to hold
the ask and a few candidate directions for whoever (or whichever future
agent session) picks this up next.
