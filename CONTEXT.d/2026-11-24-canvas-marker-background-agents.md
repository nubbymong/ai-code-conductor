## 2026-11-24 -- A canvas decision is no longer held by an agent's tool calls after the main agent's Stop (aicc_planning#409)

2.1.3-beta.17, section C1. Branch fix/canvas-marker-background-agents.

- The bug: the canvas marker queue read every PreToolUse, PostToolUse and
  SubagentStart of a session as the main turn's, whichever agent fired it
  (canvas-marker-queue.ts, TURN_OPENING_EVENTS). A background agent's or a
  Workflow agent's tool calls after the main agent's Stop opened the turn
  again and restarted the 120 s fallback on each call, so a decision filed
  then was held until the agents went quiet for 120 s or the user prompted
  the agent. The owner's app.log (beta.11, Claude Code 2.1.329) showed two
  decisions held that way.
- The reading (hold 1, on the published signed beta.16 with Claude Code
  2.1.330 on the probe stand-in): every PreToolUse of a foreground subagent,
  a background subagent (with the app's disableBackgroundTasks set false)
  and a Workflow agent carries `agent_id` and `agent_type`; the main
  agent's never do. Every hook event carried the main `transcript_path`
  (0 of 69 events had another), so the transcript sign of
  background-context.ts is not used for this. A Workflow agent's and a
  background subagent's tool calls arrived after the main Stop, as in
  #409's log.
- The fix: feedEntryOf lifts `agent_id` onto the hook event as `agentId`
  before redaction, for the gateway and the session helper's transport
  alike; the boot wiring passes it and the tool name to the queue. An event
  with an agent id counts as the main turn's only while one of the main
  agent's own Agent, Task or Workflow calls is open (its PreToolUse seen,
  its PostToolUse not yet; reset at Stop and SessionStart): then the main
  agent is waiting on that agent, and its tool calls keep the turn alive as
  before. Otherwise it neither opens the turn nor restarts the fallback.
  One log line when an event opens the turn again after a Stop: its name
  and whether it carried an agent id.
- Why the open-call exception (a deviation from the plan's "neither reopens
  nor rearms"): without it, a decision filed while the main agent waits on
  a foreground subagent would be handed on 120 s after the main agent's
  PreToolUse(Agent), then wait at most 120 s more for the ready prompt and
  be dropped as not sent if the subagent ran longer. beta.16 held it to the
  main Stop and typed it. A background Agent call and every Workflow call
  return at once (hold 1), so they open no wait.
