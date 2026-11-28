## 2026-11-27 -- Account usage page as the approved grid (nubbymong/aicc_planning#445)

2.1.3-beta.20 plan phase 2 (track B). The Account usage page is the owner's
approved canvas mockup v1 (`.ccc-canvas/accounts-2.1.3-v1.html`, approved 27 Nov).

What changed:
- `AccountUsagePanel.tsx` draws one grid of every provider's cards (columns of
  at least 330 px) in place of one column per provider. A provider filter
  (All / Claude Code / Codex, shown only with two providers on) replaces the
  sections; sort by 5h left (default), weekly left or name; three bands (Most
  room at 50% or more of the sorted window left, Some room, Not usable now);
  a summary line names the account with the most room, which is outlined with
  a "Most room" pill. Every meter says what is LEFT (owner Q3), the sorted-on
  one bold; per-model rows and Credits stay; a plan pill ("Max 20x" where the
  sign-in carries its `rateLimitTier`).
- Card states: Refreshing, In use, Out of 5h (or the week) until <time>,
  Parked, Sign in again. "Sign in again" is the reading's own `needs-login`
  verdict only (phase 4 decides when main sets it). Refreshing is main's
  renewing hint, compared exactly with the shared `USAGE_DETAIL_RENEWING`
  (src/shared/usage-types.ts, which main's hint now uses too), or a kept
  figure while the stored access token has lapsed and the long-lived one has not.
- "Refresh sign-in" is "Sign in again now" in the card's menu (RowMenu, which
  gained an optional `detail` line and `width`); the per-card Retry is "Read
  usage again" there.
- Loading: every card is drawn at once from the account list and each
  account's last reading, and its meters animate until its fresh reading
  lands. The last readings come from main through a new read-only IPC,
  `accountUsage.lastKnown()` (`accountUsage:lastKnown`): each active
  profile's newest figure, marked stale, with no input, no credential read, no
  network, and nothing while Claude Code is off. They are not marked fresh. The
  cards are placed by the entries as they stood when every stream last
  settled, so nothing reorders while readings arrive (`arrangeCards`,
  utils/accountUsageGrid.ts), or once nothing has arrived for 20 s (a stream
  that never ends holds no card's place for ever).
- The sort and filter are kept per user in the saved settings
  (`accountUsageSort`, `accountUsageProvider`), as other page choices are.
- The Feature Guide and Ask Conductor text (app-knowledge.ts) and the Usage
  page tip describe the grid, the states and Read usage again.

Decisions and why:
- `accountUsage:lastKnown` touches IPC and the preload, so it owes an ADR-009
  adversarial pass. Per the owner's 15 Nov rule no pass runs in a beta; it goes
  on the pre-stable list with the other beta.20 passes.
- A usable card with no figure for the sorted window (no session yet, billed
  per token, a failed read) sits in Some room, and that band's note then says
  "or no reading", rather than claiming under 50% left.
- A long email wraps (never truncated, as before) where the mockup's masked
  emails ellipsised.
- A parked card has no menu: it is never read and never signed in from here.
- `isModelBucket` moved to shared/usage-labels.ts (re-exported by the footer).

Tests: tests/unit/renderer/account-usage-grid.test.ts and
tests/unit/account-usage-last-known.test.ts (new), the panel, handler,
preload, outcome and auth tests (adapted and extended). The e2e layout spec,
tests/e2e/account-usage-grid.spec.ts (page widths 1280, 1024, 860 and 468 px),
runs on CI in the Snap e2e job on the Windows runner, on a dispatch with
snap_e2e; no pull request or push runs it. Every new unit test was shown red
under a mutant of its code.
