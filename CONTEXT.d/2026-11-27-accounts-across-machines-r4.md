## 2026-11-27 -- Accounts across machines: review round 4 fixes (beta.20 phase 5)

- R4-1: Adopt chosen from a Switch Account's notice now says to switch the
  tab again ("Switch web-app to Personal again to move it there."). The
  switch never happened, and a Restart starts the tab on its old account.
  From a refused start it still says to Restart the tab.
- R4-3: the notice hands Adopt the tab, the account it asked for and why
  it asked (`HostAdoptAsk.tab`, which replaces `tabLabel`). The result names
  the tab only when that account was adopted.
- R4-4: otherwise the next step names the account adopted ("Restart a tab
  on Personal to start it there."), or "one of those accounts, A or B" when
  several were. They are named because main's answer may also name an
  account it did not adopt. One pure helper, `adoptNextText`.
- R4-2: both sign-in tab notes from round 3 are now tested after a read of
  the machine. If every such folder is this computer's, the note offers
  Adopt. If another one is for an account this computer does not hold, the
  note says the folder is used by the app on another computer. That note
  now gives only its own steps: it no longer adds "choose Sign in on this
  machine again", because a sign-in from here cannot help there.
- R4-5: a card's Adopt hover text names the accounts as the confirm does:
  the profile's name, else its alias, else its email (`hostAccountName`,
  `adoptTitleOn`). Before, it used the card's identity title.
- R4-6: the hover text says what Adopt does: "Asks first, then makes the
  folders for Personal and Spare on Rocky this computer's again. They carry
  another install's mark and may be this computer's own from an earlier
  install."
- R4-7: a page-level test mounts the account usage page and reads the
  card's Adopt hover text as the page wires it.
- Each new regression test goes red under a mutant that brings its bug
  back.
