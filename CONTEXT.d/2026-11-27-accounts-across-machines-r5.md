## 2026-11-27 -- Accounts across machines: review round 5 fixes (beta.20 phase 5)

- R5-1: both sign-in tab notes that name Adopt now give only their own
  steps, as the note for another computer's folder has since round 4. They
  no longer get "Press Check on the Machines page, then choose Sign in on
  this machine again." after them, so no note names Check twice.
  - Machine read, every such folder this computer's: "... if so, choose
    Adopt on the machine's card on the Machines page, then choose Sign in
    on this machine again." It asks for no Check after Adopt, because the
    Adopt dialog reads the machine again.
  - Machine not read yet: "Press Check on the Machines page: if the
    machine's card then says it may be this computer's own from an earlier
    install, choose Adopt on the machine's card, then Sign in on this
    machine again; if it is the app's on another computer, sign it in
    there from that computer."
  Tests pin both whole notes and count Check once (the round 2 and NIT-11
  tests used loose patterns before).
- R5-2: one naming rule. The curried namer in `utils/hostAccounts.ts` is
  now `hostAccountNamer(profiles, aliases, fallback)`. The sign-in tab's
  `hostAccountName(profileId)` in `utils/hostSignIn.ts` calls it over the
  stores with a lower-case fallback, so the two sibling utils no longer
  export two functions of the same name with their own copies of the rule.
- R5-3: a machine's Accounts here row takes its Adopt hover text from
  `adoptTitleOn`, the helper the account card uses (`CardAccounts.adoptTitle`).
  Before, it built the text from its own copy of the naming rule. An
  account with no name and no email showed as "Account" there but "That
  account" on the card and in the confirm. The three now match.
- Each new regression test goes red under a mutant that brings its bug
  back.
