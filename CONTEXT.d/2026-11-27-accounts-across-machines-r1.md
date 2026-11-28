## 2026-11-27 -- Accounts across machines: review round 1 fixes (beta.20 phase 5)

The independent review of phase 5 passed the spec and failed quality on one
major finding. Fixed on the beta.20 aggregate:

- MAJOR-1: "Sign in on <machine>" from the notice made the tab wait for any
  later sign-in of that account on that machine, and nothing cleared the
  wait. A tab now waits for its own sign-in tab only, and only while it is
  still the same run (`createdAt`). The wait is dropped by Cancel, by the
  other account, by a later notice, by a Switch or a Restart, by either tab
  closing, by a sign-in tab whose terminal ended with no sign-in end (90 s
  grace: a sign-in tab that starts nothing sends none) and at a 20 minute
  limit (stores/hostAccountsStore.ts pruneHostWaits).
- MINOR-2: phase 3's `elsewhere` (a folder the app on another computer made
  on that login): the card, Accounts here, the Switch Account list and the
  notice say "Used by the app on another computer" and offer no Sign in
  there. Remove's question says such folders stay.
- MINOR-3: each SSH start notes whether it carried the conversation. A
  refused start's notice carries it again on "Use this account" and on the
  start after the sign-in. A helper tab never sets sshReachedClaudeRunning,
  so that check was dropped.
- MINOR-4: the notice starts on Cancel and its message starts on OK; each
  gives the focus back when it closes.
- NITs: "How accounts sign in here" is static text. isHelperTab counts the
  kept mark only on an SSH Persistent tab. Remove's list is keyed by
  account. A switch of a kept tab to an account not read there yet ends
  nothing and says to press Check first.
- Phase 2's remaining F7: "Read usage again" replaces Retry in the Feature
  Guide and in the network-calls tip.
