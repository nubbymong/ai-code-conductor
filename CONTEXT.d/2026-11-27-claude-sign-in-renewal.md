## 2026-11-27 -- The app renews a still-valid Claude sign-in itself (nubbymong/aicc_planning#444)

2.1.3-beta.20 plan phase 4 (track C). The Account usage page asked accounts
that were still signed in to "Refresh sign-in"; the app now renews them and
asks for a sign-in only when one is truly needed.

What changed:
- `usage/account-usage.ts`: the app's renewal posts to the address Claude Code
  itself uses, `platform.claude.com/v1/oauth/token` (was
  `console.anthropic.com`), with the same client id. The new refresh token's
  expiry (`refresh_token_expires_in`) is saved as `refreshTokenExpiresAt`, so
  the "Forced sign-in in N days" countdown is the new token's; an answer that
  names none drops the spent token's expiry rather than keep counting it down.
- Each answer of the token address is read by its HTTP status alone
  (`classifyTokenAnswer`) and, for a 400 or 401, its OAuth `error` code alone;
  the body is never kept or logged. `invalid_grant` is an expired or revoked
  sign-in; everything else (a redirect, a 5xx, a network failure or time-out,
  another refusal, a body that cannot be parsed) is tried again on the next
  read. An `invalid_grant` after another writer replaced the refresh token
  meanwhile is not an expiry: theirs is live.
- The primary account, and an account whose sign-in folder has no owner-only
  verdict yet in this run (the first open after a start), renew through
  Claude Code's own `claude auth status` (`readClaudeCliAuth`: no window, no
  shell, a 10 s limit, the account held while it runs), injected by main as
  `setClaudeCliRenewal`. Never `claude -p`. The primary's sign-in is synced
  with the global `~/.claude` before (a fresher token there is used, and the
  CLI never spends a refresh token that one replaced) and after (the renewed
  one goes back, so Claude Code outside the app stays signed in), as a
  session on the primary is. A refused folder gets neither route.
- `needs-login` (the page's "Sign in again", phase 2) is set only for: no
  sign-in at all; `invalid_grant` (detail `session expired`); a profile signed
  in to the same account as another (`duplicate account`) or to a different
  account than its label (`wrong account`), from the same cross-check the
  page's banners read (`account-auth-info.ts` `signInProblemOf`, injected as
  `setClaudeSignInProblem`). A duplicate or wrong-account profile is not
  renewed and not read. Otherwise the signed-in hint (detail now `signed in,
  refreshing`) or the last figure, stale: the page's Refreshing.
- The re-auth tab's banner (TerminalView) no longer says "Setting up a new
  account": a re-auth session carries `signInAgain` and its banner says to run
  claude there (a still-valid sign-in renews by itself) and to /login as the
  same account only if asked (`utils/signInBanner.ts`).
- Kept: no read while a session uses the account; the in-use guard; merged
  duplicate renewals; the write aborted when another writer rotated the token;
  the owner-only folder verdict before the app's write; the 300 ms stagger and
  the 429 backoff; renewal only on page open, Refresh or Retry, and only for a
  lapsed token; noRefresh for the account-switch snapshot.

Decisions and why:
- 401 and 403 without `invalid_grant` are retried, not expired: an
  `invalid_client` or a blocked request says nothing about the user's sign-in.
- The status route's own answer is not read; the credentials file is, after
  it. A CLI that says signed out while a refresh token is on disk is not
  taken as expired (the CLI's renewal on `auth status` is unproven, Q6); a
  file the CLI left with no sign-in is "not signed in".
- An account a running session uses keeps its "In use" figure; the identity
  check applies to the accounts the page reads itself.
- Q6 is not settled here: whether `claude auth status` renews a lapsed token
  is for the VM line (a test profile with a lapsed token; the credential stamp
  moves). If it does not, the primary keeps today's terminal route (the card's
  sign-in action opens the tab), with the corrected banner, and the card says
  Refreshing, never Sign in again.

Tests: tests/unit/account-usage-renewal.test.ts (new: the address, the expiry,
every answer class, both status routes, the identity check, no body or token
in a log), tests/unit/account-usage-outcome.test.ts and
tests/unit/account-auth-info.test.ts (extended),
tests/unit/main/account-usage-renewal-wiring.test.ts (new: main's wiring, no
`-p`), tests/unit/renderer/sign-in-banner.test.ts (new), the re-auth and
add-account hook tests. 14 mutants, each killed (the old address, the expiry
dropped in the parse and in the write, a 5xx read as expired, the primary
skipped, the no-verdict folder skipped, a 3xx or a network failure read as
expired, any 400 read as expired, the rotation check dropped, the identity
check ignored, the primary's sync dropped, the wiring unset, the banner
marker dropped).
