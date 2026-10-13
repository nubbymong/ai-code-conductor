## 2026-10-11 -- claude.ai chip said "expired" over a working session (2.1.1-beta.3)

- **Problem (owner, on 2.1.1-beta.1, still in beta.2):** the session header's
  claude.ai chip read "expired" while the account's artifacts window worked,
  and "Open artifacts" in the sidebar menu and Settings stayed disabled.
- **Cause:** `statusOf` (session-store.ts) compares the sessionKey expiry
  saved in the account's record with now. The record is written once, at
  sign-in; the account pane rewrites it only on a signed-out to signed-in
  change, a missing record or a missing email, and the artifacts window never
  writes it. claude.ai renews the cookie, so the saved date went stale.
- **Fix:** both status reads (`accountWeb:webStatus`, `accountWeb:status`)
  first call `refreshClaudeWebExpiry` (new `web-session-expiry.ts`), which
  reads the account partition's sessionKey cookie as metadata only (name and
  expiry) and rewrites only `expiresAt`, via the compare-and-set
  `refreshWebSessionExpiry` in session-store.ts. No record: no partition is
  read or made. No cookie: the record is left as it is, so a session that
  really expired still reads expired. Skipped while the account's session is
  being wiped. The read is scoped to https://claude.ai, so a sessionKey
  another site set in the partition never counts. The cookie value is never
  kept, logged, saved or answered.
- **What the answer waits for:** only a record that reads
  expired waits for the cookie check (bounded, 1.5 s). Any other record
  answers from the local JSON read at once, as before, so `webStatus` keeps
  its "answers before the menu is painted" contract for an active account;
  its check runs behind the answer and the next read sees any change.
- **Not changed:** the account pane's recording rules and the artifacts
  window. Every status read now follows the live cookie, which covers both.
- **Gates:** credential-adjacent (IPC handler reading partition cookies), so
  the ADR-009 security review applies before merge.
