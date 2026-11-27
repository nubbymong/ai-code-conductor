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
  one bold; per-model rows and Credits stay; a plan pill.
- Card states: Refreshing, In use, Out of 5h (or the week) until <time>,
  Parked, Sign in again. "Sign in again" is the reading's own `needs-login`
  verdict only (phase 4 decides when main sets it; account-usage.ts is not
  touched here). Refreshing is read from data the page already has: the
  signed-in refresh hint, or a kept figure while the stored access token has
  lapsed and the long-lived one has not.
- "Refresh sign-in" is "Sign in again now" in the card's menu (RowMenu, which
  gained an optional `detail` line and `width`); the per-card Retry is "Read
  usage again" there.
- Loading: every card is drawn at once from the account list and the last
  readings, and its meters animate until its fresh reading lands. The cards
  are placed by the entries as they stood when every stream last settled, so
  nothing reorders while readings arrive (`arrangeCards`, utils/accountUsageGrid.ts).
- The sort and filter are kept per user in the saved settings
  (`accountUsageSort`, `accountUsageProvider`), as other page choices are; no
  new IPC.

Decisions and why:
- "Last readings" are what the page saw in this run, kept in renderer memory
  (never saved) and used when the page opens again. On the first opening after
  a start there are none, so the cards show identity, plan and countdown with
  animated meters until each reading lands. Main's saved snapshots
  (usage-snapshots.json) have no read-only route to the renderer, and the brief
  said no new IPC unless unavoidable.
- A usable card with no figure for the sorted window (no session yet, billed
  per token, a failed read) sits in Some room, and that band's note then says
  "or no reading", rather than claiming under 50% left.
- The Claude plan pill reads `subscriptionType` (Pro, Max, Team, Enterprise,
  Free); the mockup's "Max 20x" / "Max 5x" tier is not in what the app reads.
- A long email wraps (never truncated, as before) where the mockup's masked
  emails ellipsised.
- A parked card has no menu: it is never read and never signed in from here.
- `isModelBucket` moved to shared/usage-labels.ts (re-exported by the footer).

Tests: tests/unit/renderer/account-usage-grid.test.ts (new, pure),
account-usage-panel.test.tsx and account-usage-panel-streaming.test.tsx
(adapted and extended); e2e layout at 1280, 1024, 860 and 468 px page widths
in tests/e2e/account-usage-grid.spec.ts (CI). 63 mutants, each killed.
