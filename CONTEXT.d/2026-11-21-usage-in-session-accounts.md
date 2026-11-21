## 2026-11-21 -- The Usage page never fetches an account a running session uses

Plan 2.1.3-beta.13, section C3 (aicc_planning#378).

- **Why.** The owner (2026-11-21): an account in a running session already has its usage from that
  session's status line, so the page must use that and never ask again. At beta.12 the page still
  asked for it in four cases (src/main/usage/account-usage.ts at 9aa4b704): the primary account
  always; a figure with credits, or a profile whose last fetch had credits; a figure older than
  90 s; and a session that had delivered nothing yet (including one whose transcript was not in the
  profile's folder).
- **What.** For an account a Claude Code session runs on, fetchAccountUsage makes no GET and no token
  refresh, the primary as any other (inSessionUsage). It shows the newest figure it has, the
  session's or the last fetched one, with its time. Older than 90 s, it is shown as not updated
  since then. The status line has no credits figure, so the credits row shows the last fetched
  credits with their own time, or no row. With no figure yet: the last fetched figure, or "Waiting
  for this account's session" (a new `waiting` status). With no current figure, the credentials
  file is still read (a local read) so an account with no sign-in at all still says Not signed in.
  The stagger counts only accounts with no running session. Accounts with no running session are
  fetched as before.
- **"A running session" is sessionsOnProfile, not isProfileInUseByLiveSession.** The plan named the
  second. It also counts the sign-in probe, headless and Insights runs, cloud agents and a plain
  shell under the account, none of which report a status line: with it, an account with only a
  plain shell open would have read "Waiting for this account's session" for as long as the shell
  stayed open. Such an account is fetched as before. The token refresh still waits for all of
  them (isProfileInUseByLiveSession, unchanged).
- **The card.** Two words the page could not say before, so the change reaches the renderer
  (AccountUsagePanel.tsx) and the shared type (usage-types.ts: `waiting`, `inSession`,
  `creditsFetchedAt`). An old in-session figure reads "Last updated <age>", without "couldn't
  refresh" (nothing was tried; the owner's test step 3 says the card never shows it while the tab
  runs). The credits row adds "as of <age>" when its credits are older than the bars.
- **Tests.** tests/unit/account-usage-live-open.test.ts is rewritten around the new rule: no request
  for an in-use account with credits, with cached credits, past 90 s, with nothing yet, for the
  primary, and for a write the folder rule does not file; the newest figure wins; another account's
  figures never show; closed accounts and plain-shell-only accounts are fetched as before. Against
  the base, 15 of its 29 tests fail; tests/unit/renderer/account-usage-panel.test.tsx adds five card
  tests, three of them failing against the base. A mutant that uses isProfileInUseByLiveSession for
  "a running session" turns the plain-shell test red. Five other usage suites gain
  `sessionsOnProfile` in their identity mock.
- **Left for the release's own commit.** app-knowledge.ts (the Usage page paragraph and the
  known-issues entry on a missing credits row) and tips-library.ts (the Usage page tip) still say
  the primary is always fetched and that extra usage makes one request; this release's changelog
  entry names the change.
