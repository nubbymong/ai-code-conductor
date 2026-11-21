## 2026-11-21 -- Probe P20: a hook endpoint that is gone, files read again, and tools/list_changed (S16's second half, steps 2, 4 and 6)

Plan 2.1.3-beta.13, section C1 (aicc_planning#376, and #358's ADR half). Step 1 of
CONTEXT.d/2026-11-19-what-a-held-agent-session-needs.md. No product code.

**What was built.** `helper/probes/p20-probe.cjs` (the driver, the hook endpoint and the
verdicts), `p20-model-stand-in.cjs` (a stand-in model that answers a turn with a tool call
reading a file in the run's folder: Claude Code's Read, Codex's shell tool, `exec_command` in
both Codex versions run) and `p20-tool-server.cjs` (a stand-in `conductor` tool server that
declares `listChanged`, as the app's tool host does, and adds a tool when asked). The
decision lines are in the probe's header, committed (e53c95c6) before the run. Its verdict
code and the stand-in's reading of a request are covered by
`tests/unit/scripts/probe-p20.test.ts`; five mutants (a check run read as a verdict, the 10 s
window dropped, the control's hook count dropped, a settings change read as "again" with the
old URL still hit, a tool result read as run without the marker) each turned one test red.

**The run.** WINDOWS_1 (build 22621), node-pty's bundled ConPTY, Claude Code 2.1.328 and Codex
0.157.1 (installed there) at 20:57Z to 21:09Z, then Codex 0.171.0 (the newest tested release,
staged in the probe's folder for the run and removed after) at 21:11Z to 21:12Z. 3 runs per
case, the runs of a case side by side. The result files name the probe code by sha256:
p20-probe.cjs feaaab9c..., p20-model-stand-in.cjs 6df9ab12..., p20-tool-server.cjs
d51689a7... (the committed files; LF line ends). Clean-up complete in both runs.

**Results.**
- (a) Both CLIs RUN THE TOOL for every endpoint behaviour.
  - Claude Code (http PreToolUse, the entry buildHooksBlock writes): refused 0.1 to 0.2 s,
    401 0.2 s, 404 0.1 s, the control 0.1 to 0.2 s, from the tool call to its result. At
    each failed hook the terminal shows "PreToolUse:Read hook failed" and "HTTP 401 from
    <the hook URL>" ("HTTP 404 ...", "HTTP undefined ..." for a refused connection). An
    endpoint that never answers holds the call 600 s (599,994 to 599,997 ms, 3 of 3), then
    the tool runs; no line names the hook. 600 s is Claude Code's own limit: the app's entry
    gives no `timeout`.
  - Codex 0.157.1 and 0.171.0 (the app's forwarder, by `-c` as the app gives it): 0.3 to
    0.4 s in every case, as the control. The forwarder delivered SessionStart,
    UserPromptSubmit, PreToolUse, PostToolUse and Stop with the session's token. Never
    answering: each request closed 15 to 473 ms after it came, before the forwarder's own 2 s
    limit, but at the probe's own Ctrl+C that ends the run (all five within 12 ms of each
    other, 546 to 565 ms before the CLI's exit), so how long one is held while the session
    goes on was not measured. Nothing on screen said a hook failed.
- (b) Claude Code READS ONCE, both files. `--settings`: the PreToolUse URL changed by a
  rename over the file; the next turn's hook went to the old URL about 3.8 s later, 3 of 3,
  nothing shown. `--mcp-config`: the server ended and the file named another; `/mcp`,
  Reconnect started the old one again, 3 of 3 ("Reconnected to conductor."); none started
  before `/mcp` in 5 s.
- (c) Claude Code LISTS AGAIN (`tools/list` 1 to 4 ms after the notification; the next turn
  named the added tool; 3 of 3). Codex 0.157.1 and 0.171.0 DO NOT LIST AGAIN (no
  `tools/list`; the next turn named only the first tool; 3 of 3 each).

**What it means for S16's second half** (as fixed before measuring).
- Step 2 (PreToolUse through the hook mode) is a default, not a gate on step 4: a held Claude
  Code session's tools still run against a gone gateway. Claude Code does not read its
  settings file again, so a take-over cannot give it a new port or secret there. PreToolUse
  then reaches a new run through the hook mode, or only while the new gateway has the old port
  and takes the old secret again (item 3's second way). Step 2 also removes the "hook failed"
  line each tool call shows until then.
- Step 4 may keep a Claude Code session whose PreToolUse stays on the gateway. A gateway that
  hangs stalls each tool call 10 minutes; recorded, no gate.
- Step 5 writes nothing into `settings-<sid>.json` or `mcp-<sid>.json` for a running Claude
  Code: neither is read again. The relay command stays valid for the CLI's life (S15 built it
  so).
- Step 6 sends `notifications/tools/list_changed` to Claude Code only. A held Codex session
  keeps the tool list it started with until it starts again.
- S16 needs no protocol change 3: the app answers no permission today.

**#358's ADR half.** ADR-030's parity row "Permission answers from the app" now says what the
code does: none; the gateway answers each PreToolUse at once, and its hold is dormant (nothing
sets `gateActive`, `resolveResponder` has no caller, no `PermissionRequest` is registered).
Its target and row 13 say no answer is planned, and protocol change 3 is needed only if the
app answers permissions again. The code half (delete the dormant path, or keep it) stays on
#358.

**Where this differs from the plan.**
- A 404 case was added beside refused, 401 and never answers: at base the gateway answers a
  session it does not know with 404 `{}`, not 401 (hooks-gateway.ts:619-623), and that is
  what a new app run answers a held session.
- Codex was measured at two versions (0.157.1, installed on the test machine, and 0.171.0,
  the newest tested); 0.171.0 was staged with the machine's name lookups set for the download
  and put back (b12-dns.ps1 set, then reset).
- The plan's "decision lines in the PR before measuring": no builder opens a PR (rule 11), so
  the lines are in the probe's header in the commit before the run, and in the aggregate's
  notes.
- The header's STILL WAITING line gives one cap, 12 minutes from the tool call. The probe uses
  that cap only for the endpoint that never answers; every other case waits 120 s for the
  result (p20-probe.cjs:646). No case came near either: outside never answers the longest
  wait was 0.4 s.
- The header's meaning line for (b) `--settings` is wrong in one place and is left as it ran
  (the result files name the probe by its digest). It calls writing the new run's port and
  secret into the file item 3's second way, and says READS ONCE leaves only the hook mode.
  Item 3's second way is the take-over registering the session's old secret again, which the
  CLI reads nothing for and which works only while the gateway keeps its port; the result
  above and ADR-030 say that. The verdict rule itself (READS AGAIN, READS ONCE, HOOK DROPPED)
  is as written before the run.

**Seen beside the questions.** In the first Codex 0.171.0 case, the clean-up after the case
stopped git.exe and git-remote-https.exe processes, with their console hosts (15 in all, 7
of them gone by the time each was checked), that Codex had started and that were still
running after it ended; no later case left any, nor any case with Codex 0.157.1 or Claude
Code. What they fetched was not recorded; the test machine's name
lookups do not work, so a fetch could not finish.

**The test machine, left as found.** Held under the VM lock 20:51Z to 21:14Z (and a short
read-only look before). The probe folder (scripts, results, Codex 0.171.0, its npm cache) and
the probe's temporary folders are gone; DNS is back to the DHCP server; b12smoke holds only
beta12-signed.exe, untouched. Two `codex --version` checks run in the machine's own profile
had each left a Codex start-up temp folder under `.codex\tmp`; both were removed by name. The
profile's `.claude` was not written.

**Not measured.** A signed-in account and a real model; the app's own gateway and launch path
(the probe writes the same entries); a settings file written in place rather than renamed;
Claude Code's other hook events; macOS and Linux; Codex below 0.157.1 (the tested range starts
at 0.153.4).
