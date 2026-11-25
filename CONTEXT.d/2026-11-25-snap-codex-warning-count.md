## 2026-11-25 -- Snap into a Codex tab while Codex shows its warning count, end to end on CI

Plan 2.1.3-beta.18, section 7.5 (aicc_planning#428). Base: origin/beta at d0be048e.

- **Why.** beta.17 C9 measured an Alt+V image going into a Codex tab while Codex shows its
  warning count, but not Snap: the test machine is driven over SSH and has no desktop to
  capture, and snap-e2e opened no Codex tab.
- **Read feasible first (rule 34).** One snap-e2e dispatch (run 45578961836) on a first commit
  that only opened the tab: the GitHub Windows runner ran the app's Codex tab on Codex 0.157.1
  from npm, and Codex showed "1 warning . f2 to view" under its composer. Codex asked only its
  hooks review (the project's trust is seeded; no sandbox menu showed).
- **What was added.** The snap-e2e job installs Codex 0.157.1 from npm into a prefix and a cache
  of its own with scripts off, as the Probe P19 job does, and hands the spec that prefix.
  `tests/e2e/snap-windows.spec.ts` gains a second part in an app and a serial group of its own:
  one managed Codex account signed in with a made-up key, its config pointing Codex at probe
  P11's model stand-in on loopback (it names each picture a request carries by its SHA-256) and
  naming one tool server that cannot start. C1 opens the tab and reads the count; C2 Rectangle
  and C3 Whole screen, 3 runs each, press Snap while the count shows and read the saved JPEG
  (its SHA-256 none of an earlier press's), main's "pasted and sent" line, and exactly one
  request at the stand-in whose pictures are every picture pressed so far, in order, the newest
  byte for byte the saved file.
- **Two reds, both the spec's own premises, each read in the run's log.** The footer: the app
  launches Codex with its config's model (`-m gpt-6-astra`), so the footer did not carry the
  account config's model the first pattern named; it is now read by its shape. The turn: P19's
  note that a turn carries Codex's tools did not hold for the app's launch (the one request each
  press made carried none); every request now counts, so a second one would fail the test. No
  bound, wait or retry was changed.
- **Result.** Run 45581252484: 29 of 29 green, retries 0 (part one's 22 unchanged; C1, C2 3 of 3,
  C3 3 of 3). The file to Codex's turn took 1.1 to 1.2 s; Codex at rest with its count again
  0.3 s later.
- **Review round (on d886147e).** In run 45582381926 two presses pictured the same screen as the
  press before them (C2 run 3 and C3 run 2: Codex numbers each message's image [Image #1], so
  its screen after each turn is the same), so on those two the check that the newest picture is
  this press's file could not fail. Each run now moves its picture 16 DIP (C2's drag, C3's app
  window, put back after) and the press's SHA-256 must be none of an earlier press's. Part two
  also clears the shared app handle around its hooks, so a failed launch never closes part
  one's app again by its old process id.
- **Shared code.** The 9.2 rules' first-screen answer moved from codex-real-launch.spec.ts into
  helpers/codex-mode.ts unchanged, and the footer pattern is exported from
  codex-first-screens.ts. D2, D3 and D12 share the rectangle and whole-screen size rules with C2
  and C3.
- **Not covered.** Snap, Window (the plan names Rectangle and Whole screen); a picture larger
  than 1024 by 768; Codex versions other than 0.157.1; a session held by the session helper;
  macOS and Linux.
