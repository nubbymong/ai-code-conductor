## 2026-11-27 -- Accounts across machines: review round 2 fixes (beta.20 phase 5)

Phase 3's round 2 added state that the account surfaces had not drawn yet.
These are the fixes for that, and for two smaller findings.

- R2-1: phase 3 now marks folders that may be this computer's own from an
  earlier install: `mayBeEarlierInstall` on the machine's read, and
  `adoptable` on a launch refusal. The Accounts here row, the account card's
  machine line and the notice now say so in main's words and offer Adopt.
  The Switch Account list marks such an account too.
  - Adopt asks first, in a dialog on the notice host that names the
    accounts. Only the folders' marks change: nothing is signed in, signed
    out or removed.
  - It then runs accountsAdopt, says what it did, and reads the accounts
    again.
  - "Used by the app on another computer", with nothing offered, now shows
    only when the folder is not adoptable.
  - Remove's question names those folders, and the earlier build's
    old-marker folders, as main's Remove answer does. It says to Adopt
    before Remove.
- R1-N1: closing a finished sign-in tab before main's read after it answers
  no longer drops the wait. The wait lasts until the grace ends, so the
  waiting tab still goes on, once.
- P4-9: this computer's line on a card that asks to sign in again now says
  the card's reason, such as a duplicate account.
