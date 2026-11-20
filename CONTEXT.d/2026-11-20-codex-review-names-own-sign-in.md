## 2026-11-20 -- The Codex review row says the computer's own Codex sign-in cannot review, and links to Accounts

Ticket aicc_planning #367, for 2.1.3-beta.11. A wording and link change in
Settings, General, Built-in Tools, Code review. No behaviour change in what
can or cannot review.

**Before.** With no Codex account added in the app, the Codex review row
showed only "No Codex account can run reviews. Add a Codex account." and no
way to get to Accounts. Since owner decision O5 (2026-10-11) the sign-in the
Codex CLI keeps on the computer (~/.codex) is never taken in as an app
account, so a user signed in to Codex outside the app always landed on that
bare line and read it as a bug. The Claude row has a "Change in Accounts"
link; the Codex row had none.

**Now.** src/renderer/components/settings/CodeReviewTools.tsx:
- When no Codex account can review and main names the computer's own sign-in
  folder (externalHomeFolder, the same snapshot field the external-only
  cases already read), the row says "Codex's own sign-in on this computer
  (<folder>) cannot run reviews. Add a Codex account in Accounts." The
  folder is whatever main names (~/.codex, or the folder CODEX_HOME named),
  never a fixed string.
- When main names no folder, the short line stays and gains the same link:
  "No Codex account can run reviews. Add a Codex account in Accounts."
- The own-sign-in line is used only when the app lists no Codex account that
  is not archived. Main also sends no account id when the app holds an
  account that is only inactive (never made the reviewer, and an inactive
  account cannot be the default), and then the cause is that account, not
  the computer's own sign-in: that state keeps the short line and the link.
- "Accounts" is a button that calls the row's existing onOpenAccounts, the
  same callback the Claude row's "Change in Accounts" uses (Settings opens
  its Accounts tab, which holds the Codex section). No second mechanism and
  no per-card scroll: the app has none to reuse.
- reviewToolView now returns an optional `messageLink` ({ before, after })
  next to `message`; `message` is always the whole line, so the Conductor MCP
  review card (reviewSubToolState) and screen readers get the same sentence
  as plain text.
- The Claude row and every other Codex state (external-only, make-reviewer,
  can't-run-on-account) keep their words and get no link.

**Notes.** Main names the folder for any machine that has the Codex provider
(it does not check that a sign-in exists there), so a user with no Codex
sign-in at all also reads "Codex's own sign-in on this computer (~/.codex)
cannot run reviews", which is true and still points at Add a Codex account.
src/shared/app-knowledge.ts (Code review section) gains one sentence so Ask
Conductor knows the row. The tips library and the Feature Guide cards need
nothing: the review tip already says each row says why a review cannot run.
Two existing assertions in tests/unit/renderer/code-review-tools.test.tsx
pinned the old bare line for exactly this condition and were updated to the
new line; their fixtures now list no Codex account, which is the state the
line is for (main sends an account id whenever a reviewer or an active
default account exists).
