## 2026-11-27 -- Claude sign-in renewal: review round 1 (nubbymong/aicc_planning#444)

2.1.3-beta.20 plan phase 4, the fixes from its independent review, on the
beta.20 aggregate (with phase 2's Account usage grid).

What changed:
- Each reason the user must sign in again is a shared constant beside
  USAGE_DETAIL_RENEWING (shared/usage-types.ts): not signed in, session
  expired, duplicate account, wrong account. A duplicate or wrong-account
  reading carries the accounts (`signInProblem`). The card names the reason
  ("Signed in to the same account as Work"; "Signed in as X, labelled Y")
  instead of "Not signed in", with an action that clears it: "Sign in as its
  own account" for a duplicate (signing in as the same account cannot), "Sign
  in again" as the labelled account for a wrong one. The sign-in tab is told
  the reason, and its banner names the account to choose.
- The duplicate that blocks the usage read counts a twin only when it is
  active, holds a sign-in with a refresh token, and its own home is the same
  account (a label match is not proof). A parked or signed-out twin no longer
  costs a working account its reading; the panel's wider duplicate warning
  (duplicateOfProfileIds) is unchanged. Main reads it with
  readClaudeSignInProblem (account-auth-info.ts).
- The primary: when Claude Code's own `claude auth status` answers that it is
  not signed in and its token stays lapsed, the card is Sign in again (session
  expired) rather than Refreshing forever. A folder with no verdict yet is not
  judged that way: the next read renews it through the app's own POST.
- A renewal that hands back the same refresh token with no expiry keeps the
  expiry in force; a rotated one with none still drops the spent one's.
- The token address comment now says what it is (Claude Code's own TOKEN_URL),
  not a cause the log never confirmed.

Recorded, not changed:
- Residual window (for the pre-stable ADR-009 pass): after the first sync the
  primary's profile and ~/.claude hold the same refresh token. Once `auth
  status` renews it in the profile's home, ~/.claude holds the spent one until
  the second sync, which runs as soon as the CLI returns (normally well under
  a second, at most its 10 s limit). A Claude Code outside the app renewing
  from ~/.claude in that window, or at the same moment, can lose its sign-in.
  A session on the primary has the same exposure. Not narrowed by syncing
  while the CLI runs: a file caught mid-write could let the older global copy
  win the freshest-wins sync.
- On the first open after a start, each lapsed account whose folder has no
  verdict yet runs `claude auth status` in turn (up to 10 s each, plus the
  first-start warm-up), so later cards wait; the plan asked for this route.
- A wrong-account profile's label follows the account its home holds as soon
  as the sign-in tab's poll asks for its identity (refreshIdentity relabels,
  as before this change).

Tests: account-auth-info (parked, signed-out, label-only and no-refresh-token
twins; the named problem), account-usage-renewal (the named problem on the
reading, the primary's signed-out answer, the same-token expiry),
account-usage-outcome (the constants), account-usage-panel (a card per
reason), account-usage-panel-streaming (the reason reaches the sign-in tab),
sign-in-banner and use-reauth-account. 9 mutants, each killed.
