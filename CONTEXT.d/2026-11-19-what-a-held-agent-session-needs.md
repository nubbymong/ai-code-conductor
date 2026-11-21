## 2026-11-19 -- What a held Claude Code or Codex session still needs from the app run that started it (the list for S16's second half)

Plan 2.1.3-beta.12, section B3 (aicc_planning#356). Docs only: no code, no test, no ADR edit.
On This computer, with "Claude Code and Codex sessions through the session helper" on (off by
default). S15 ends with this beta's B1 and B2: a held session keeps its Conductor tools while its
link to the app drops and comes back inside one app run. S16's second half is the next step: an
update replaces the app's process, and the session goes on. This is the list of what that step
must close, and a proposed order for it. Nothing here proposes turning a default on.

**Where each line was read.** At beta 32fb8b36, except the files beta.10 and beta.11 change, read
at bbe1d6d3 (beta.11 B2's frozen head, which holds #733 and beta.11 B1): session-helper/manager.ts,
helper-pty.ts, conductor-mcp-server.ts, hooks/per-session-settings.ts,
docs/remote/helper-protocol.md and providers/codex/held-tool-launch.ts (new there). ADR-030
lines are all before the probe rows #731 and #737 add, so
they do not move. ipc/pty-handlers.ts is read at beta; #729 adds 42 lines above the part cited. B1
and B2 of this beta are cited by section: they were not built when this was written.

**What the reading found, in short.**
- Two things already carry over. Claude Code's hook events of eight kinds queue in the holder while
  no app takes them (protocol change 9's hook part, built in beta.8). Claude Code's status line falls
  back to its status file, which the next run reads with no change.
- The app answers no permission today. The hooks gateway holds no PreToolUse open in production
  (hooks-gateway.ts:472-477, :491-496: `gateActive` is never set by anything in src), and
  `resolveResponder` (permission-responders.ts:28) has no caller. So D1's "a held permission
  question falls back to the CLI's own prompt" (ADR-030:96-102) already holds, and S16 needs no
  `hook.ask` or `hook.answer` (protocol change 3, ADR-030:260).
- Everything else is made for one run: each credential (the run nonce, conductor-mcp-server.ts:116),
  the tool host's record of the session (:149-170), the gateway's secrets (hooks-gateway.ts:158,
  :247-251), and the in-memory bindings a launch makes in pty-manager.ts. A new run must make them
  again for a CLI that is already running, without launching it.
- Four places remove what a kept session still reads: the session's exit block
  (pty-manager.ts:7527-7532), its teardown (:7761-7917, run by every kill at :8047), the
  start-up sweeps, which run for every session id (index.ts:1098-1103), and the Codex hook-folder
  sweep, which goes by a folder's age, not its session (providers/codex/hooks.ts:463-478, called
  at :384).
- Only a session whose tools go through its holder can keep them. The loopback route's credential
  sits in the CLI's MCP config (per-session-settings.ts:235) or, for Codex, its environment
  (providers/codex/spawn.ts:818-820) for the CLI's whole life, and the next run refuses it. Every local launch is issued the `run`
  form; the `stable` form, the same in every run (conductor-mcp-server.ts:118-129), is issued only
  to a persistent SSH session (pty-manager.ts:3054), and this list does not propose it for a local
  one. On an
  installed Windows app, 2 of Codex's 5 launch shapes keep that route (the beta.11 B2 fragment).
- pty-manager.ts makes and drops a launch's bindings. Making them again for a take-over, without
  growing the file past its cap (8,187, `PTY_MANAGER_LINE_CAP` in scripts/ci/pr-numbers.mjs), needs
  them moved out first. pty-manager.ts is itself a radius file, so each step that touches it owes the
  live SSH matrix once.

**The list.** For each: what the session reaches, or the app keeps about it; what an update does to
it today; what happens when the app's process is replaced; what closes it; whether closing it
touches a radius file or pty-manager.ts.

1. **The Conductor tools.**
   - Today: the CLI starts the helper's relay as its `conductor` server (Claude Code through its MCP
     config, per-session-settings.ts:291-311; Codex through its launch, providers/codex/
     held-tool-launch.ts), and the app serves each stream under the tab's id (manager.ts:1023-1128).
     A session that could not be switched keeps the loopback route.
   - At an update today: the session ends (update-handlers.ts:333, killAllPty at
     pty-manager.ts:8075-8087), and its tab resumes the conversation.
   - When the process is replaced: with B1, the relay keeps its stream and holds a call 30 s, then
     answers "AI Code Conductor is updating, try again shortly". The new run can take the stream back
     only if its tool host has a record for the tab: serveToolStream refuses a session with none
     (conductor-mcp-server.ts:1789-1799), and records live in memory (:170). A loopback session keeps
     no tools.
   - Closed by: S15 (protocol change 9's tool half, ADR-030:268-270; B1 and B2) inside one run. Across
     runs, S16's take-over: a record for the tab with no credential issued, and the stream given back
     on the take-over's connection. If the new version's tool list differs, the CLI must be told
     (`notifications/tools/list_changed`; s15 left this to S16, and P20 below asks whether each CLI
     reads it).
   - Radius or pty-manager.ts: no. The record is a new function beside issueMcpSessionToken
     (conductor-mcp-server.ts:191-201), not the request handler that takes SSH status posts.

2. **Claude Code's hook events, eight kinds** (PostToolUse, Notification, SessionStart, Stop,
   UserPromptSubmit, SubagentStart, SubagentStop, StopFailure).
   - Today: they run the helper's hook mode (session-hooks-writer.ts:156-172), which hands each event
     to the holder. With no connection that acked `hooks`, the holder queues it: 256 events and
     2 MiB, the oldest dropped and counted as `lost` (helper-protocol.md:981-997). The app takes
     events only after it switched the file at the launch (`on`, manager.ts:960, :980) and drops a
     `seq` it has seen (:984-985).
   - At an update today: the session ends, and its queue goes with its holder.
   - When the process is replaced: the queue does what change 9 asks. The new run's take-over must
     ack `hooks` and turn the route on at the attach, since only a launch runs `launched`. The hook
     command names the old helper copy (a `<version>-<sha12>` folder, session-helper/install.ts:102),
     which start-up keeps while a holder reports that version (install.ts:381, #727). The route is
     turned on only while the hooks gateway is on and listening, since the signals module takes no
     event otherwise (deps.taking(), manager.ts:971-973).
   - Closed by: S16's take-over. Nothing in the holder.
   - Radius or pty-manager.ts: no (manager.ts).

3. **Claude Code's PreToolUse, and the permission answer.**
   - Today: PreToolUse stays an http hook to the gateway, with the gateway's port in its URL and the
     session's gateway secret in a header (session-hooks-writer.ts:58-64, :167-169). The app only
     reads it (the feed, attention); no permission is answered by the app (above).
   - At an update today: the session ends.
   - When the process is replaced: the next gateway refuses the old secret (its secrets are minted
     per launch and held in memory) and may bind another port (a bind retry picks one at random,
     hooks-gateway.ts:309-314; the default is 19334, hooks-types.ts:15). The event is lost. What
     Claude Code shows for a refused or unreachable http hook is not measured (P20).
   - Closed by: a small step, not a protocol change. Either PreToolUse joins the eight in the hook
     mode (the hook mode already takes it, helper-protocol.md:920-932, and the manager drops it
     today, manager.ts:986), so the queue keeps it while the app is away and a held Claude Code
     session needs nothing of the gateway's per-run secret; or it stays on the gateway and the
     take-over registers the session's secret again from its settings file
     (registerSessionWithSecret, hooks-gateway.ts:255; read as gatewayHooksIn reads it,
     session-hooks-writer.ts:189), which works only while the gateway keeps its port. Protocol change
     3 is needed only if the app ever answers permissions again. ADR-030's parity row :224 describes
     the gateway holding the answer; in the code that hold is dormant.
   - Radius or pty-manager.ts: no.

4. **Codex's hook events, six kinds** (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
   PermissionRequest, Stop).
   - Today: not through the helper. Codex runs the app's forwarder script as an async hook (it neither
     waits nor reads an answer), one command for every session so that Codex's hook trust holds
     (providers/codex/hooks.ts:5-33, :48). The forwarder reads `hook.json` (the gateway's port, the
     session id and its token) at every event, from a folder made for the launch with a random name,
     which Codex is told by `CCC_CODEX_HOOK_FILE` (hooks.ts:396-421; pty-manager.ts:6087-6108,
     :6179-6189).
   - At an update today: the session ends, and the folder goes with its teardown (forgetCodexHooks,
     pty-manager.ts:863-874, called at :7843).
   - When the process is replaced: the token is the old run's and is refused. Because the forwarder
     reads the file at every event, writing `hook.json` again in place with the new run's port and a
     new token is enough, as long as the folder is still there. Today the update's own kill removes
     it, and a folder older than 24 h is swept at a later start (hooks.ts:456-475, called at :384).
   - Closed by: S16's release (keep the folder and record its path) and take-over (a gateway token
     for the tab, `hook.json` written again). Moving Codex onto the hook mode is a later S12 step and
     needs another form: the hook mode takes its session from its command line, and Codex needs one
     command for every session.
   - Radius or pty-manager.ts: yes as the code stands (the folder is made and removed in
     pty-manager.ts), unless step 3 below moves the Codex launch bindings out first.

5. **The status line and its file fall-back.**
   - Today, Claude Code: the statusLine command runs the app's bridge each tick with the session id
     and the path of `~/.claude/ccc-status-<sid>.url` (statusline-command.ts:34-55;
     per-session-settings.ts:125-172). The bridge reads that file each run (statusline-gather.ts:64-67)
     and posts to the tool host's `/status` with this run's credential. On any failure it writes
     `<resources>/status/<sid>.json` instead (statusline.ts:118-141), and statusline-watcher.ts takes
     that file for any session id (:303-329). Codex has no status line command: its figures come from
     its rollout, read in main (item 9).
   - At an update today: the session ends. The URL file is removed by the exit block
     (pty-manager.ts:7532) and by the next start's sweep (index.ts:1103; hooks/boot-cleanup.ts:59-75).
   - When the process is replaced: the post is refused, the bridge falls back to the file, and the
     new run's watcher shows it. So the status line already survives, by the file. The take-over can
     also write the URL file again with the new run's URL (the bridge reads it each tick), which
     brings back the post. Each version stages the bridge again at start (index.ts:609), so a held
     CLI runs the new bridge from its next tick: the bridge's arguments must stay as they are.
   - Closed by: nothing needed for S16 beyond the URL file. The status line through the helper
     (status frames, protocol changes 4 and 9, ADR-030:261-262, :268-270) is not needed here.
   - Radius or pty-manager.ts: no change. statusline-watcher.ts (radius) is read, not changed.

6. **The per-session files, and what in them is made for one run.**
   - `~/.claude/settings-<sid>.json` (Claude Code): its hooks (the gateway URL and secret for
     PreToolUse, the hook mode's command for the rest), its statusLine command and the canvas tools'
     allow entries (per-session-settings.ts:16-19, :100-172). Made for one run: the gateway secret and
     port. Claude Code reads the file when it starts; whether it reads it again is not known (P20).
   - `~/.claude/mcp-<sid>.json` (Claude Code): the loopback URL with this run's credential
     (per-session-settings.ts:235), or the relay form (:291-311), which names nothing of the run.
   - `~/.claude/ccc-status-<sid>.url`: this run's status URL (:43-46, :342-354). Read every tick.
   - Codex's hook folder and `hook.json` (item 4). Read at every event.
   - Codex's launch arguments: the loopback URL and its credential variable (spawn.ts:818-826), or
     the relay form (providers/codex/held-tool-launch.ts at bbe1d6d3). Fixed for the CLI's life.
   - Not made for one run: the canvas plugin folder (`--plugin-dir`, pty-manager.ts:7147-7159) and
     the agent templates (pty-manager.ts:6906-6911).
   - Who removes them: the exit block (pty-manager.ts:7527-7532), which a released session also
     reaches (its kill at :8042 fires its exit at once, helper-pty.ts:236-244 at bbe1d6d3, while its
     entry still points at it, so `weAreCurrent` is true, :7471-7479); and every start, for every
     session id: cleanupStaleMcpConfigs deletes each `mcp-<sid>.json` and `ccc-status-<sid>.url`,
     and cleanupStaleHookEntries deletes the whole `hooks` block, the hook mode's entries included,
     from each `settings-<sid>.json` that holds a gateway URL (index.ts:1098-1103;
     boot-cleanup.ts:17-41, :59-75; removeHooks, session-hooks-writer.ts:505-511).
   - Closed by: S16's release keeps them (the exit block and the teardown skip a released session;
     the sweeps skip the ids the helper still holds), and the take-over writes again only what the
     CLI reads again (the URL file, `hook.json`).
   - Radius or pty-manager.ts: the sweeps are in index.ts and boot-cleanup.ts (no); the exit block
     is pty-manager.ts (yes, unless step 3 moves its removal of the files out).

7. **The account lease, and the tool host's record of the session.**
   - Codex's lease: pty:spawn prepares the launch and takes a lease on the account
     (ipc/pty-handlers.ts:1071-1095), and pty-manager.ts holds it for the session (codexLaunchLeases,
     :357, :6231-6232), releasing it with the session (:7769-7773) or once its process has ended
     (:392-402). While held, it refuses a sign-out, a deactivation, and turning Codex off (:350-356).
   - Claude Code takes no lease (pty-manager.ts:362-364). Its account is captured at the spawn and
     watched (:6930-6934; claude-account-identity.ts:38, :361), and that capture is what makes a
     profile count as in use (claude-account-identity.ts:236-243).
   - The tool host keeps, per session: the record (conductor-mcp-server.ts:149-170, made by
     issueMcpSessionToken, released at :209-221 from pty-manager.ts:7867), the review opt-in and the
     session's folder (:715-739, registered at pty-manager.ts:6959 and :6403), and through
     pty-manager.ts the canvas roots (:6993-7029, :6412; revoked at :7876), the vision browser's
     pinned target (:7559) and the canvas markers not yet delivered (:7899).
   - At an update today: released and ended with the session.
   - When the process is replaced: all of it is empty. Until a tab takes its session over, nothing in
     the new run knows the CLI runs on that account, so a sign-out or an account's removal is not
     refused in that gap.
   - Closed by: S16. The next start's keep counts each kept session's account in use at once (its
     record says which), and the take-over takes the lease (the usual preparation), the capture, a
     record with no credential, and the review and canvas registrations as a launch makes them: the
     canvas roots from the tab's configured folder, never a transcript's (the rule at
     pty-manager.ts:6962-6992), and the review from the folder the CLI was launched in (:6947-6960),
     which a launch keeps on purpose (:6989-6992); the release's record carries it.
   - Radius or pty-manager.ts: the lease map, the capture and the registrations are in pty-manager.ts
     today (yes, unless step 3 moves them).

8. **The PTY manager's launch state for a restored tab** (which a re-attached session must skip).
   - Today a restored tab's spawn (pty-manager.ts:2723) runs the whole launch: the resume decision
     (Codex at :6109-6124), the files (item 6), a new gateway secret (:7107, :6097), a new tool host
     record, the agent templates, then the watchdog (:7302-7311) and the logging run (item 12). For
     Claude Code it also types the launch line 300 ms after the spawn (:7235-7246). A plain
     terminal is taken over inside spawnPlainPty (manager.ts:816-821), where pty-manager.ts has done
     nothing else for it. An agent tab's spawnAgentPty (pty-manager.ts:6914, :6236) sits inside the
     launch: Codex's hook token and folder (:6087-6108) and its lease (:6231) come before it, and the
     rest comes after it in the same synchronous run (for Claude Code the account capture :6930, the
     registrations :6959-7029, the settings file and its gateway secret :7089-7110, the MCP config
     :7128 and the typed line :7235-7246; for Codex the pane, the colour answers and the telemetry,
     :6265-6392).
   - For a kept session the launch itself is skipped (the resume, the files, the typed line): the CLI
     is running, and a typed launch line would land in Claude Code's composer. What the launch binds
     is made again instead (items 1, 2, 4, 5, 7, 9, 10 and 12), and the session needs its entry, where
     writes, resizes and ends reach it (ptySessions, :314, :7282), its input guard (:7285) and its
     meta (:7286).
   - Closed by: S16's take-over (ADR-030 row 3's session client is its long-term home).
   - Radius or pty-manager.ts: yes, one entry before the provider branches, net zero against the cap.

9. **Codex's telemetry binding.**
   - Today: at the launch, pty-manager.ts:6327-6392 starts the Codex package's telemetry. It claims
     the session's rollout (by the resume id when there is one, else by folder and a time window from
     the spawn: providers/codex/telemetry.ts:768-776, :810-826), reads it every 500 ms, sends the status
     line, keeps the conversation the tab's save persists (session-resume-enrich.ts:181-188), and
     feeds the Codex log binder (pty-manager.ts:6310, :6377) and the session context (:6367). Kept in
     codexTelemetrySources (:504), stopped with the session (:7816-7834).
   - At an update today: stopped with the session.
   - When the process is replaced: nothing reads the rollout. The take-over claims it by the saved
     conversation id (an exact claim, with no window from a spawn time) and begins the log binder's run.
   - Closed by: S16's take-over.
   - Radius or pty-manager.ts: yes today (step 3 moves it).

10. **The Watchdog's pane and the Codex pane** (which start mid-stream after a take-over).
    - Today: two headless terminals in main per session: the Watchdog's (watchdog-manager.ts:528,
      :581; started at pty-manager.ts:7302 and fed at :7260 and :6294) and, for Codex, the pane the
      composer rule reads before main types into Codex (providers/codex/session-screen.ts:61-66,
      :144; opened at pty-manager.ts:6272 and fed at :6295). Both expect the output from its first
      byte (session-screen.ts:9-10). Codex's colour answers are given in main from the bytes main
      is fed, and Codex reads a late answer as text typed into its composer (pty-manager.ts:6273-6285).
    - At an update today: both go with the session.
    - When the process is replaced: a take-over attaches from the ring's start, as a plain
      terminal's does today (helper-pty.ts:346), which is the middle of the output once the 2 MiB
      ring has wrapped (helper/src/ring.rs:10). A1's nudge (this beta) makes
      both CLIs redraw their whole screen (P19, on all three systems), so both panes read a whole
      screen after it. The screen and the input modes come from the holder's screen (`screen.read`,
      A3), and, as this plan decided, the app writes them from a fixed table of its own after the
      replay and before the nudge: to the tab's terminal and to both panes. A replayed query must not
      be answered again: the colour answers drop the queries in the replay and answer only live ones.
    - Closed by: S16's take-over, with A1 and A3. S13's later steps, where the readers read the
      holder's screen (protocol change 5, ADR-030:263; parity rows :226 and :230), remove both panes
      (the SDLC row, ADR-030:342).
    - Radius or pty-manager.ts: yes today, where the panes are opened and fed (step 3 moves the
      opening).

11. **What the update path does today, all in one place.** update-handlers.ts:323-333: on Windows,
    the held plain and partner terminals of saved tabs are let go of first (manager.ts:1495-1508;
    agent sessions are skipped at :1501). Then killAllPty: every session's kill sends a held agent
    session `term.end` (pty-manager.ts:8042) and runs its teardown (:8047), and its exit block removes
    its files. Then hardExitTeardown ends the vision browser the app started (update-handlers.ts:368;
    hard-exit.ts:24-26), and `app.exit(0)` (update-handlers.ts:369). The next start finds the running mark (on
    Windows it says "update"), takes the crash path and ends every agent session it finds
    (manager.ts:596-602), and each
    restored tab resumes its conversation in a new CLI. macOS and Linux let go of nothing
    (update-handlers.ts:327; manager.ts:1496).

12. **The logging run.**
    - Today: at the launch, under the logging switches, pty-manager.ts:7319-7391 registers a run with
      the transcripts worker (runStart at :7375-7391), and a Codex run's log binder starts its run
      (:7397). The worker drops a transcript bind for a session with no run
      (logging/transcripts-worker.ts:845-850), and a worker that starts again does not refill that
      map (:592-597).
    - At an update today: the run ends with the session.
    - When the process is replaced: the new run's worker closes every run left open as crashed and
      reopens, and goes on tailing, one whose transcript it was tailing (transcripts-worker.ts:582-622),
      but it does not refill its session map (:592-597), so a hook event's `transcript_path`, or
      Codex's claim, binds nothing until a run is registered. A release that reaches the exit block
      ends the run first, as `exited` (logSup.runEnd, pty-manager.ts:7508; the binders' runs,
      :7512-7514), so nothing is left open to reopen.
    - Closed by: S16's take-over registers a new run, under the same switches, before the hook route
      or the telemetry binds a transcript. Keeping the old run open instead needs the release to skip
      the exit block's run end (:7508-7514), which is pty-manager.ts unless step 3 moves it too.
    - Radius or pty-manager.ts: yes today (step 3 moves it).

13. **Smaller state** that starts empty for a taken-over session and needs no protocol change: the
    integrity monitor's count, the attention source (codex-idle-attention.ts:13-38), the session
    meta (session-registry.ts:18), the activity feed's history (hooks-gateway.ts:159;
    session-signals/hooks.ts:117-121), the canvas link (canvas/canvas-session-link.ts:92, forgotten
    at pty-manager.ts:7573), the subagent depth and main transcript anchor (background-context.ts:32-36,
    dropped at :7807), the not-indexed mark and its windows (pty-manager.ts:625;
    logging/indexing-gaps.ts:95-100; ended at :7820-7824), the session's name for its logs
    (logging/session-name-sidecar.ts:86; :7517), and canvas markers queued but not yet typed (lost at
    the update; the review itself is kept). Radius or pty-manager.ts: the parts pty-manager.ts makes
    and drops (the meta at :7286, the not-indexed mark at :7371-7372) go with step 3's module.

**Proposed order of steps.** All behind the existing switch, Windows first, and none turns a default
on.
1. Probe P20 (new; 3 h; the test machine, no account, the stand-in model as P19). For Claude Code and
   Codex at the versions in the tested range: (a) what each does and shows when its hook endpoint
   refuses, answers 401, or never answers (Claude Code's http PreToolUse; Codex's forwarder);
   (b) whether Claude Code reads its `--settings` hooks or its `--mcp-config` again while it runs (the
   file changed under it; `/mcp` after its tool server ended); (c) whether each lists its tools again
   on `notifications/tools/list_changed` on a stream it already has. Gates steps 2, 4 and 6.
2. PreToolUse after an update (2 h; TypeScript), the way item 3 and P20 (a) point (Question 3). The
   hook mode: the writer gives PreToolUse the hook mode as it gives the other eight, and the manager
   stops dropping it; the dormant gateway hold stays as it is. No radius file. ADR-009 pass owed
   before stable (a command in the CLI's settings, as beta.8 A4's).
3. Move a launch's bindings out of pty-manager.ts (8 h; no behaviour change): the Claude Code block
   (the account capture, the review and canvas registrations, :6926-7029), the Codex block (the hook
   token and folder, the lease, the pane, the colour answers, the telemetry, the log binder and the
   registrations, :6087-6108, :6179-6189, :6231-6232, :6265-6414), the logging run (:7319-7397),
   their part of the teardown (:7768-7773, :7812-7843, :7863-7905), and the exit block's removal of
   the per-session files (:7527-7532), into one module that a launch and a take-over both call.
   pty-manager.ts gets shorter and the cap is lowered to its new length. The SSH branch is unchanged,
   but pty-manager.ts is a radius file: the live SSH matrix runs once.
4. Keep a held agent session through an update, on Windows (8 h). releaseForUpdate also lets go of an
   attached agent session of a saved tab whose tools, and for Claude Code whose hook events, go
   through its holder; any other ends as today. The release keeps its files (step 3's module skips
   them for it, at the exit and in the teardown; the start-up sweeps skip the ids the helper still
   holds, and the Codex hook-folder sweep skips the folders the release recorded) and records what the next run needs: the provider, the conversation id, the account and
   Codex's hook folder. The next start keeps such a session for its tab when its mark says "update"
   (it ends it today, manager.ts:596-602), counting its account in use at once; the keeper does not
   ack `mcp` (manager.ts:1312-1325), so streams wait for the tab. No radius file once step 3 has
   moved both the teardown's part and the exit block's file removal out; without step 3 it touches
   pty-manager.ts and the live SSH matrix runs. ADR-009 pass owed before stable: a process kept
   across an update, and a record the next start acts on.
5. Take a kept agent session over in its restored tab (14 h). No launch: step 3's module makes the
   bindings again for the running CLI (a tool host record with no credential; the review and canvas
   registrations; the lease and the account capture; the telemetry by the saved conversation id; a
   gateway token for Codex with its `hook.json` written again; the status URL file written again;
   the logging run, under its switches, before anything binds a transcript), and the hook and tool
   routes are on from the attach. Then the replay: both panes fed it, with Codex's colour answers
   off for replayed bytes; A3's modes written; A1's nudge. The tab shows a terminal shown again,
   with no resume. One entry in pty-manager.ts, net zero against step 3's cap; the live SSH matrix
   runs once. Needs S15 complete (B1, B2), A1, A3 and step 4. ADR-009 pass owed
   before stable: a record made with no credential, a stream given back to a new run, and the
   take-over's inputs.
6. The tool list after an update (2 h): once a stream is given back to a new run, the tool host sends
   `notifications/tools/list_changed`, if P20 (c) shows the CLIs read it. The exported stream
   function only; the request handler is not touched.
7. Probe P8, then macOS and Linux (P8: 4 h, the owner's Mac as ccctest and a Linux machine; then 4 h of
   building). P8 asks whether a detached holder and its CLI survive the app's end and the update's
   replacement of the app there, and a new app run attaches again (ADR-030:382). P18's start of a tool
   server by a real CLI rides with it on both (s15 left it to P8). Then the release and the keep off
   Windows (update-handlers.ts:327; manager.ts:1496).
8. The test machine checks of steps 4 and 5 together (3 h). The version being left must carry step
   4, so the check updates from one build of the branch to a second build on the test machine, not
   from the last published beta. With the switch on, one Claude Code tab and one Codex tab of a
   switched launch shape: a tool call made in the gap waits or is answered "updating"; a hook event
   made in the gap arrives after the take-over; the status line comes back; both panes read a ready
   screen after the nudge; the gap from the release to the next start's keep, against the 2-minute
   away clock (ADR-030 Q9); the count of console hosts before and after.
   About 48 h in all, with the two probes.

**Questions, defaults taken.**
1. Which agent sessions an update keeps. Default: only one whose tools, and for Claude Code whose hook
   events, go through its holder; any other ends and resumes, as today.
2. A crash. Default: an agent session still ends after a crash (plan s11, Q1). Only an update writes
   what the next run needs.
3. PreToolUse: the hook mode, or the gateway with its secret registered again. Default: the hook
   mode, since the holder then queues it while the app is away, as D1 says of hook events. Its cost:
   Claude Code waits for a command hook before the tool runs, so each tool call waits for one more
   start of the hook mode (P16's stand-in for it took 36.4 ms at p95 on the one machine measured,
   ADR-030's P16 result).

**Not checked here.**
- Whether a replayed ring holds a terminal query that the tab's terminal answers again (TerminalView.tsx
  :1380 sends every answer to the PTY), for a plain terminal today or an agent session later. A2's
  recordings can show whether either CLI's output holds one.
- The accounts slices (S22, S23), which change how a launch binds an account; SSH sessions (S25 on);
  runs of the app's own (Insights, S18).
