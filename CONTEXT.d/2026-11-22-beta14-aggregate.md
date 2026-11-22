## 2026-11-22 -- 2.1.3-beta.14 lands in one PR, with its release commit

**One PR for the beta.** The reviewed sections of 2.1.3-beta.14 were merged at
their frozen heads with real merge commits onto one branch from beta (#756),
in the order C2, C3, C4, B1, A1 (the opening push), C6 and B2 (one push),
then C9 and C5 (one push each). The version bump, the changelog entry and
the release surface sweep are the branch's last commit, so no second release
PR is opened (plan rule 11). C8 is held out (below).

**Conflicts, each resolved by keeping both sides.**
- `src/main/sessions/launch-bindings.ts` (A1 after C3): the comment above
  `unbindLaunchFiles` keeps C3's quit's kill and A1's kept session.
- `src/main/session-helper/manager.ts` and `launch-bindings.ts` (B2 after A1):
  the header keeps both paragraphs, the imports keep both sets.
- `helper/src/main.rs` (C5 after C6): the header's command list, the usage
  line and the command match keep both `capture` and `end-console-host`.
- `tests/wp1/legacy-codex-ledger.json`: every section's rows kept, the digest
  lines regenerated once per join.
- C3's sweep test was written against `buildHelperHooksBlock`'s old four
  arguments, which C4 cut to one; merged, 3 of its 12 tests failed. The
  branch's own test fix passes the target alone.

**Owed text applied here.** The plan keeps these files off the sections'
branches, so their lines land in the release commit:
- `docs/remote/helper-protocol.md`: the hook-events paragraph says a held
  Claude Code session's PreToolUse goes through the hook mode (C4); the tool
  relay's "What is not here yet" says an update on Windows lets a held agent
  session's CLI run on and records it (A1); the screen reads and the title say
  a held Codex session asks for them (B2); a new paragraph, "A terminal's
  console host after its program has ended" (C5); P3 on Rocky is owed to
  beta.15 (C7).
- `helper/README.md`: the Screen row (B2); the `end-console-host` command line,
  its Console hosts row and its output (C5). `helper/src/serve.rs`: the
  `HOLDER_CAPS` comment (B2). The threat model's holder-screen entry (B2).
- ADR-030: the "Permission answers from the app" row (C4); the canvas markers,
  Codex composer and headless terminals rows (B2); the Rocky line (C7).
  `helper/probes/README.md`: the Rocky line (C7).
- `src/main/index.ts`: the start-up sweep's comment names the settings files
  (C3). Three `pty-manager.ts` comments say a Codex run's screen, not its pane
  (B2), each the same number of lines, none in the SSH branch: the file stays
  at 7,773 lines, its cap. `session-helper-connection.test.ts`: the header no
  longer says no caller asks for `screen` (B1).

**Release surface sweep.** `src/renderer/changelog.ts`: five lines (C5, C3, C9,
C4, B2); A1, B1, C2 and C6 change nothing a user sees. `app-knowledge.ts`: the
Machines section says a held Claude Code session's PreToolUse goes through the
helper too (C4); the troubleshooting paragraph on console hosts says the app
now ends a terminal's host once its program has ended by itself (C5); C9's
Codex, Sentinel and known-issue lines came with C9's branch. No known-issues
entry is added: nothing ships with a live workaround. The held-terminal entry
about a window resized between runs stays as it is, since C8 is held out.
Tips, the tour and the Feature Guide cards: nothing (no new page or panel).
README.md: C9's Codex line came with its branch; nothing else.

**Sections with no fragment of their own.**
- A1 (S16 step 4, aicc_planning#387 with #359): an update keeps a held agent
  session's CLI running and records it; the next start still ends it until the
  take-over (step 5).
- C2 (aicc_planning#389, follow-up of #382): a soft reset on either screen
  stops the replay's clear. Nothing more is written about it here (plan rule
  12).
- C1 (aicc_planning#386, #364, #363, #385; a measurement on the published
  beta.13, no branch): 12 of 12 first Claude Code tabs were 103 columns at
  1024x768, so #386's first screen is fixed; the app runs elevated there and
  Codex 0.157.1 runs; a console host is left only when the program ends by
  itself (C5 fixes it); a quit with Close sessions left the settings file
  that the next start rewrote (C3 fixes it).
- C7 (aicc_planning#377, run by the orchestrator): the Rocky Linux 10 host did
  not answer its one 8 s connect on 2026-11-22, so P3 and P6 there are owed to
  beta.15.

**Held out: C8** (aicc_planning#374's P3.1). Its VM line failed when the window
grew between runs (3 of 3) and passed when it shrank (3 of 3). The cause is the
console's redraw after a resize, which a live resize shares, in code C8 did
not change: aicc_planning#394. Its lines are not applied, and the app-knowledge
entry on a window resized between runs stays true.

**Process.** The provider-name ratchet and `tests/wp1/traceability.test.ts`
are now run by name on each join: a section missed each, and CI found it.
Two sections' tests can break only once merged (C3's sweep test with C4's
new signature), so a join now runs the tests of every function two sections
both change. C8 was held out on its VM line, not on a review. Tickets filed
this beta, in aicc_planning: #393, #394, #395, #396.
