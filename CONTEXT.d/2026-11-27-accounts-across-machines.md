## 2026-11-27 -- Accounts across machines: the approved surfaces (beta.20 phase 5)

2.1.3-beta.20 section 5 (track B, after phases 2 and 3.1.1), from the
owner-approved mockup "Accounts across machines (beta.20)"
(`.ccc-canvas/accounts-machines-beta20-v1.html`, approved 27 Nov), frames 1
to 4, Claude Code rows only. Frame 5 (the Reviewer pill) is beta.21. Every
machine signs in on itself (Q7, parked to the Lend ticket): Lend from this
computer and the Codex rows are left out, not greyed.

What changed:
- Account cards (frame 1, AccountUsagePanel.tsx): a Claude Code card shows
  "On machines" while a Linux machine is added and the helper switch is on:
  this computer first, then each machine's line from its last read (signed
  in, the machine's own sign-in, not signed in with "Sign in on <machine>",
  signed in as another account, not read yet). The summary counts the
  accounts still to sign in on a machine; the foot says where a sign-in is
  kept. Lines are pure (utils/hostAccounts.ts).
- Machines card (frame 4, RemoteMachinesSection.tsx): "How accounts sign in
  here" with its one way, Sign in on this machine; "Accounts here" with Sign
  in on <machine> and Sign out (the machine's own sign-in asks first, naming
  it so: Q5; Sign out waits while a tab on that account runs there); Remove
  lists the accounts it signs out first and the machine's own sign-in it
  leaves, and, when the machine does not answer, asks again in those words
  with Remove anyway (`forget`). This computer's card says its accounts sign
  in here.
- The not-signed-in notice (frame 2, HostSignInNotice.tsx, beside
  AccountLaunchGate, same suppression): opened by main's launch-refused push
  (not for a machine that could not be read: the tab says that) and by a
  Switch Account to an account not signed in there. Sign in on <machine>,
  another account signed in there, Cancel.
- Switch Account (frame 3): canSwitchAccountForSession allows a Claude tab
  through the session helper (isHelperTab: the helper's kept mark, or main's
  through-helper flow state) and still refuses today's SSH path and
  shell-only panes. The list marks each account's sign-in on that machine;
  picking one not signed in opens the notice.
- Sign-in tab (phase 3's open item): utils/hostSignIn.ts finds the saved SSH
  config whose target is the machine's and that the helper takes (key
  sign-in, no post-connect command, no container), the one it was added from
  first, and opens a transient, shell-only tab with `remoteAccountSignIn`.
- REMOTE_SWITCH_TEXT reworded (phase 3's other open item): a config's
  account starts on its own sign-in on that machine, and Switch Account
  moves the tab; a config with no account starts on the machine's own.

Decided while building:
- A switch on a tab the helper keeps until it is ended ends that session
  first (End, as the close question's): its Restart would only attach again
  to the CLI running on the old account. An End that fails leaves the tab on
  its account, restarts it there, and the app says why.
- The switch carries the conversation into one start (`carryConversation`,
  consumed at the spawn: its SSH reconnect, so the CLI continues it; projects
  is shared by every account's folder). A plain Restart of a plain SSH tab
  still starts a new one, as REMOTE_SWITCH_TEXT says.
- After "Sign in on <machine>" from the notice, the tab waits for that
  sign-in tab's end (`sign-in-ended`): signed in, it starts (or switches) on
  that account; otherwise it stops waiting.
- Remove's not-answering variant needs to know the machine did not answer:
  main's Remove marks that result `notAnswering` (machines.ts, one field).
- Short names ("Rocky") in lines and lists; the full name with
  user@host:port in Remove's questions, as its notices name a machine.
- Left out of frame 1: "Live from its session on Rocky" (no remote session's
  reading reaches the cards in this beta) and the This computer card's
  "secure store" wording (sign-ins here are the CLI's own files).

Tests: unit (pure lines per state, switch rule, the notice's choices and
its waits, Switch Account on helper, kept and plain SSH tabs, Machines rows,
Remove's listing and not-answering, the machine-own confirm, main's
`notAnswering`). Mutants shown red: a switch on a plain SSH tab, the notice
skipped, Lend shown. e2e layout of a card's machine rows at 1280, 468 and
300 px, for CI.
