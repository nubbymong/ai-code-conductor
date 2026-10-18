## 2026-10-18 -- Input-lag investigation with 25 sessions (aicc_planning#301-#305)

Owner report: input lag on 2.1.2 with 25 sessions, where 2.1.1 handled 47.
Not a 2.1.2 regression: `v2.1.1..v2.1.2` changes only the Claude CLI probe,
headless runs and the changelog. Measured on the owner's machine (Node
inspector on the running app, a Chromium trace, process counters):

- Most CPU was outside the app: Defender (`MsMpEng` ~2.8 cores, `MsSense`
  ~0.85), Windows Search (~1.1), and per-session MCP servers
  (`codebase-memory-mcp` x8 ~1.2 cores, 35 python processes).
- The app's own share, each fixed on its own branch:
  - #301 config and state writes ran `icacls` synchronously on the main
    thread every time (the `[jank] ... near tick` freezes): memo of folders
    a read proved owner-only, 10 min, identity-checked, capped.
  - #302 the tokenomics worker re-walked all of `~/.claude/projects` on
    every change and every 5 s: changed-files sweeps, full walk every 5 min.
  - #303 output into hidden terminals rebuilt their DOM viewport: batched
    once a second, flushed when shown.
  - #304 statusline ticks that changed nothing replaced the sessions array:
    value comparison in the no-op guard, `RateLimitBar` memoized.
- #305 (feature, same slot): the header shows Claude Code's own session name
  from the statusline `session_name` (local sessions).

Not done: the 44 s freeze at a 25-session restore is not attributed (the
session PTY start is untimed, ADR-025); the always-running session-row CSS
animations were left as they are.
