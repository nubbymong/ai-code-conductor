## 2026-11-19 -- Probe P18: Claude Code and Codex start a tool server as a direct child, and nothing is left when they end

Plan 2.1.3-beta.10, section B1 (aicc_planning #337). No product code.

- **What was built.** `helper/probes/p18-windows-tool-server-start.ps1` and the stand-in tool
  server beside it (`p18-stand-in.cjs`, about 60 lines, run by a copy of the machine's own
  node.exe). The stand-in answers `initialize`, `tools/list` and `ping`, refuses anything else,
  can hold its first request, ends at end of input as the relay mode will, and logs each event.
  The script registers it with each CLI's own add command and runs each CLI in a fresh
  environment (every per-user folder in its own temporary folder, no account, no API key).
- **Decisions made while building it.** Codex has no connection check of its own (`codex mcp
  list` only reads its config), so a `codex exec` run stands in for it. On a closed port Codex
  0.157.1 waits for the network and never ends, so its model provider is a local stand-in that
  refuses every request at once. Codex does not wait for a held tool server before its turn,
  so for the end from outside that model stand-in holds the model request and Codex stays up.
  Which process started which comes from WMI's process start and stop events, but no time does:
  those events arrive a second or more late. The stand-in's own log gives its times.
- **Result (WINDOWS_1, Claude Code 2.1.328, Codex 0.157.1): PASS for both** on the plan's line.
  Each CLI starts the program as its direct child, with no shell, from a path with a space as
  given, over pipes, with a console of its own. First answer 19 to 25 ms after node's clock
  started in the program, in 8 of 8 runs per CLI over two measured runs (the second with the
  script as of e7bcfcd6, after the automatic review's fixes below). Nothing of any run was
  left 2 s after the CLI's end (20 of 20 runs, both normal ends and ends from outside). The
  full paragraph is in ADR-030 after the P16 result.
- **Review fixes (the PR's automatic review).** Output is read for at most 5 s after a process
  ends, so a process left holding it cannot hang the probe; a normal run counts only when the
  CLI ended by itself; the probe refuses a temporary folder whose path has a space. A `.cmd`
  launcher stays allowed: the VM started npm's `claude.cmd` and `codex.cmd` the same way.
- **Review fixes (the plan's reviewer).** A CLI whose runs started nothing is CANNOT MEASURE
  only when its words (what each run and its add command printed) ask for a sign-in, and FAIL
  otherwise, as the plan's line says. The second check option for Codex is gone, since
  `codex mcp list` starts no tool server. The probe's own node processes (the stand-in's
  self-test, the model stand-in, node's version check) get the fresh environment and work
  folder too. With the process trace off, a console host not seen is recorded as not seen,
  not as absent. None of them changes a value the two measured runs recorded.
  `tests/unit/scripts/helper-probe-p18.test.ts` reads the script for these three mistakes.
- **What it means for B2 and the step after.** The relay can be a plain program started by its
  full path. Only Claude Code's normal end closes the program's input; Codex's end and an end
  from outside end the program without it, so the holder takes a dropped relay connection as a
  closed stream. Codex passes only 17 named variables (no HOME or CODEX_HOME), so the relay
  takes its store and session from its command line. Each relay has a console host of its own
  while it runs.
- **WP1 legacy Codex gate.** helper/ was in no scope of the legacy Codex manifest, so any file
  there that names Codex failed the gate as an unscoped mention (the three P18 files did, in the
  manifest check before this change). helper/ now joins the code scope
  (scripts/wp1/legacy-codex-manifest.mjs), the committed manifest and the ledger are regenerated,
  and the three files have `added` rows (no legacy Codex code path). No other helper file names
  Codex, so nothing else moved; B2 will meet the same rule if its files name Codex.
- **VM.** Held 06:46Z to 07:01Z and 07:27Z to 07:29Z under the VM lock. One discovery command,
  run before the probe in the real environment (`codex exec --help`), left one Codex temporary
  folder under the real profile; it was removed, and its parent folder's modified time changed.
  The probe's own folders and processes were left as found.
