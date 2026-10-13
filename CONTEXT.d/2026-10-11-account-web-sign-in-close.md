## 2026-10-11 -- account web: sign-in window close, second launch, long click (2.1.1-beta.3)

- **chatgpt.com sign-in window, closed by the user:** the close is held only
  while the account's session cookie is in the jar. The poll looks at the jar
  at once after the close, also when the close comes while the first page is
  still loading (the run stops waiting for that load). No session cookie, or
  no answer from the cookie store: the run ends as closed, the window goes and
  the partition is wiped, so the next sign-in (chatgpt.com or claude.ai) can
  start straight away. With the cookie there, the same four checks decide, for
  at most 12 s, a hard stop that every wait inside the poll races; no last
  look runs after a held close. The text in app-knowledge.ts and
  USER_GUIDE.md ("closed before you signed in is cleared") now matches.
- **The window always unloads:** a will-prevent-unload handler lets it go
  whatever the page's beforeunload says, as the account view and the browser
  pane already do.
- **Accepted bound exception:** the one-at-a-time sign-in latch still clears
  only after the names-only diagnostic's jar read and the partition wipe. Each
  is bounded at 10 s but not cut to the 12 s, so if Electron's storage stops
  answering the latch can clear later than 12 s. On purpose: a new run must
  not start on a partition still being wiped. The window itself is gone by
  then.
- **Second launch while the window is gone:** the `second-instance` handler
  moved to `src/main/second-instance.ts` (`focusExistingWindow`). A destroyed
  or missing window gets one log line and nothing else; a live one is restored
  and focused as before.
- **Long click in the account views:** the release of a mouse press renews
  that press's one-second link allowance, only while the press is unused and
  still the latest input, for the same button. It is never a new input, so one
  press still lets at most one link or popup out.
- **Gates:** credential sign-in code and the account-view link gate, so the
  ADR-009 security review applies before merge.
