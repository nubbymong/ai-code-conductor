## 2026-11-23 -- 2.1.3-beta.15 lands in one PR, with its release commit

**One PR for the beta.** The reviewed sections of 2.1.3-beta.15 were merged at
their frozen heads with real merge commits onto one branch from beta (#757),
in the order B5 and B4 (the opening push), B2, B1, A1 and B3 (one push each).
The version bump, the changelog entry and the release surface sweep are the
branch's last commit, so no second release PR is opened (plan rule 11).
Nothing was held out.

**Conflicts: none.** Two files are shared, and git merged both cleanly:
`TerminalView.tsx` (B2, then A1 with C8's hunks: in the resize observer B2's
check for a pane with no size comes first, then C8's replay-fit check, then
A1's aligner call) and `helper-pty.ts` (B1's screen-and-title check, then C8's
and #392's hunks). B3 shares no file with another section.

**Fixes made on the branch.** a653e84f: B5's Probe P21 job builds the helper in
release on Windows, so it now runs `scripts/check-pe-imports.mjs` after that
build, as `check-pe-imports.test.ts` holds for every such build. 440e9ac3: the
WP1 ledger row for A1's new TerminalView test, the manifest rebound.

**Owed text applied here.** The plan keeps these files off the sections'
branches, so their lines land in the release commit:
- ADR-030: D19 names each provider package's exit keys (B3); the P21 sentence
  that asked for a second console reading now points to it, and a new "P21
  console result" paragraph (B5); the Rocky line (C7).
- `docs/remote/helper-protocol.md`: the take-over's replay written at the
  holder's size, its budget, and the console's paint written where the tab
  holds the lines (A1 with C8); `list` run at a start with both settings off
  (B1); a held Codex session reads the screen only on a connection that acked
  `title` too (B1); the title's C1 rule and the limits of the screen's parser
  (B4); the Rocky line (C7).
- `docs/remote/helper-threat-model.md`: the clean-up of old copies (B1), the
  holder-screen title (B4), P21's console half (B5). `helper/README.md`: the
  Screen row's title rule (B4). `helper/probes/README.md`: the Probe P21 job and
  its answer (B5, with the job's import check), the Rocky line (C7).
- Comments: `providers/codex/session-screen.ts` (B1, read against B3's version
  of the provider package), `consoleRepaint.ts` and its test (A1's recheck),
  `session-helper-flow.test.ts` (C8), and two B3 test notes (its rechecks).
- `tests/wp1/legacy-codex-ledger.json`: the evidence for
  `pty-quit-exit-keys-local.test.ts` names Codex's keys (B3). The gate shows
  no drift: 1063 paths, all with a row.

**Release surface sweep.** `src/renderer/changelog.ts`: five lines (A1, B2, B1,
B3, B4); B5 and C7 change nothing a user sees. `app-knowledge.ts`: the quit
paragraph names each assistant's exit keys (B3), and the known issue on a
terminal shown again after the helper dropped its earlier output now says the
replay is written at the holder's size when the window's size changed, and
names what the aligner leaves as before (A1 with C8). No known-issues entry
is added. `tips-library.ts`: the Terminal only SSH tip says "the assistant's
exit keys" (B3). The tour and the Feature Guide cards: nothing (no new page or
panel). README.md: nothing. `pty-manager.ts` is 7,773 lines (B3's call and
four comments, no net line, no hunk in the SSH branch), so its cap stays
7,773.

**VM lines** (WINDOWS_1, Windows 11 build 22621, each on its section's frozen
head, the machine left on the published signed beta.14):
- B2 (61e70518): three new tabs switched through in 44 ms started no console
  host while hidden, then each at 103x27 when shown; the published beta.14
  started all three at 80x24. A key switch right after a new tab, three runs,
  and 12 new tabs closed one by one: every host at its tab's size.
- B1 (818aa70e): with both switches off, three old folders (two version
  folders and a staging folder) were gone about 1 s after the start and the
  log line named them; no copy was placed; the published beta.14 left all
  three.
- A1 (56edee53): grow, shrink and maximise of a plain terminal, switches off
  and plain terminals on, 18 of 18 with no lost line; a Claude Code tab and a
  Codex tab whole after a grow and back; C8's restores, 3 into a larger window
  and 3 into a smaller one, all whole, the notice at row 0, the log naming
  both sizes. The published beta.14 lost lines on the same grow.
- B3 (449feb74, Codex CLI 0.157.1): 12 quits (5 direct and 5 held at Hooks
  review, one of each at the composer), each from "Gracefully exiting" to
  "All sessions exited" in 229 to 930 ms, exit code 0, no forced kill,
  nothing left.

**Sections with no fragment of their own.**
- M1 (a measurement on the published beta.14, no branch): no xterm.js option
  cures #394's lost lines, so A1 fixed it in the renderer; the 80x24 first size
  is reached by clicking through new tabs quickly (B2); four direct Codex quits
  took 0.39 to 1.20 s, so B3's timing was then measured on its own build.
- B4 (aicc_planning#395, #396, #384): on macOS a connection that has ended
  both ways refuses to set any socket option, and the transport now counts
  that refusal as set when a read would not wait (#396). The holder's title
  follows xterm.js 6.0.0 on the first C1 control and on long kinds (#384 cases
  2 and 3). Cases 1 and 4, and the rows after a C1 control in a string, are
  limits of vte 0.15.0. #395 was measured in the code with no production
  change. Helper job green on all three systems (run 45093569291).
- B5 (aicc_planning#391): ci.yml gains a dispatch-only Probe P21 job (input
  `probe_p21`, windows-2025); `p21-capture.cjs` gains `verdict --ssh-not-run`
  and a session line from `measure` and `console`. The runner's console
  reading is CAPTURES at 100% on one 1024x768 display, 3 of 3 runs in 50 to
  62 ms, session 2 elevated (CI run 45091643024). A second scale, mixed
  scaling and a session that is not elevated are not measured.
- C7 (aicc_planning#377, run by the orchestrator once the owner powered the
  host on): Rocky Linux 10.2, "P3 HOLDS - alive at 60 s in 3 of 3 runs of each
  form" and "P6 SAME" (exec, `-l` and `-il` alike); KillUserProcesses no,
  Linger yes, so a host with logind cleanup on is still not measured; left as
  found.

**Process.** Measurements on the published beta ran first and gated only the
sections that needed them (rule 25). Rule 21's join tests (the provider-name
ratchet, traceability, and both sections' tests where two touch one function)
ran on every join; CI still found one fault only a merge shows (the P21 job's
missing import check). The release commit carried the rule 15 checklist with
its two new items: no placeholder left (15.9), and every section's comment and
user sentence read against the combined head (15.10).
