## 2026-11-27 -- remote: sign in on this machine, Claude Code on Linux hosts through the helper (beta.20 phase 3)

2.1.3-beta.20 section 3 (the beta's simplification item), owner-approved
plan and mockup "Accounts across machines (beta.20)". Built in this order:

- 3.1.1, the shared shape first (src/shared/host-accounts.ts): each account's
  state on each machine (signed in here, the machine's own, not signed in,
  someone else, not read) with identity, plan, tier, expiry and read time;
  the typed reason a helper tab started nothing; the sign-out request and
  result; the channel names. Pushed alone so the account surfaces (phase 5)
  could build on it.
- 3.1.2, the beta's one helper change (helper/src/field.rs): `field --keys`
  prints one JSON object of several keys of one file, strings and integers.
  The helper reads only the keys on its own list (the account, plan, tier
  and expiry of a sign-in) and refuses any key naming accessToken or
  refreshToken by name first. `--key` keeps its one-string output, for keys
  on the list only (beta.19 took any key; a key off the list now exits 2).
- 3.1.3 to 3.1.8 (src/main/remote-helper/host-accounts.ts, scripts.ts,
  session.ts, index.ts; the Claude package's remote accounts in
  providers/claude/remote-launch.ts): the account's folder
  `~/.aicc/accounts/<profile id>/` (Q4: profile id, never email), owner-only
  with the app's marker, its links into `~/.claude` only (one shared-folder
  list for this computer and hosts, src/shared/account-folder.ts, plus
  CLAUDE.md), settings.json the sanitised copy. One `accounts` exec per
  machine reads every sign-in there; read at Check, the start-up list, a
  sign-in tab's end, each launch on an account, and before and after a
  sign-out; never polled. A launch on an account runs in its folder
  (CLAUDE_CONFIG_DIR), on the machine's own sign-in when that is the
  account, else starts nothing and tells the tab and the renderer why. A
  folder signed in as another account is marked and never used. Sign out
  runs the CLI's own sign-out in the folder, then removes that folder only;
  the machine's own sign-in only after a confirm that names it so (Q5).
  Remove signs out this computer's account folders there first, or, when
  the machine does not answer, names the accounts left and where to end
  each; `forget` removes such a machine from the list without reaching it.

Decided while building:

- A config with no account keeps today's behaviour (the machine's own
  sign-in, nothing read). Today's plain SSH path gets no accounts; the
  helper switch stays off by default.
- The session's own settings file (--settings) carries the sanitised copy
  too when the tab runs in an account folder, so the copy's exclusions do
  not come back through the flag.
- Remove's sign-outs are one exec that needs no read first, so a machine
  whose helper is not this build's can still be removed.
- A sign-in tab names the account's email to `claude auth login --email`,
  the words the app already gives for a sign-in on this computer.

Fix round (independent review, 2 MAJOR, 5 MINOR, 4 NIT):

- The folder's marker names the install that made it (`aicc-account 1
  <profile id> <install id>`). Two computers of the user signed in on one
  host login, or a shared login, each touch only their own folders: the
  read names another computer's as `elsewhere` (new optional field of the
  shared shape), and Remove passes the profile ids it signs out one by one
  (this computer's accounts, and its folders of accounts it no longer
  holds), each signed out only by this install's marker; another
  computer's folder is left and the answer says it is used by another
  computer.
- Remove on a machine whose device folder is already gone signs nothing out
  and goes on as beta.19 did, naming what stays signed in there.
- Sign out is refused while the helper keeps a session there that no open
  tab shows (closed with Leave running, or inside its away clock): it may
  run in that account's folder.
- An account signed in by the machine's own sign-in that also has a folder
  of it left there takes the Q5 confirm, then the machine's own sign-out,
  then that folder goes too.
- A sign-in tab signs in by the account's own method (Claude subscription,
  Console or SSO), as this computer's sign-in of it does.
- An attach to a session kept for a tab reads the account for display only:
  it never stops the attach (only a launch is stopped).
- Remove and Sign out each wait as long as their execs may run; a refusal
  for accounts that did not read on this computer says so; a sign-in tab
  that could not start names its own next step.

Round 2 (recheck, R1): two kinds of folder were never removed and blocked an
account's sign-in there. A folder with the marker of the beta.20 builds
before the install id was in it is this computer's when its profile id is
one of this computer's accounts: it reads as that account's, and its marker
is rewritten at its next sign-in or launch; any other is named by Remove and
left. This computer's own folders after its install id changed (its records
lost) read as another install's: when every such folder is named by one of
this computer's accounts, the card, the launch notice and Remove say they
may be this computer's own from an earlier install, and Adopt (a new door,
the user's own choice only) rewrites their markers; nothing adopts or
removes them by itself.

Tests: helper cargo tests (CI; no toolchain on the build host), vitest unit
red-first with mutants each shown red (a secret key through, a mismatch
read as signed in, CLAUDE_CONFIG_DIR dropped, a sibling folder removed in
the script and on the TypeScript side, a spawn when not signed in; and for
the fix round, another computer's folder signed out, Remove stopped by a
gone device folder). The remote-helper e2e job has stand-in account folders,
another computer's among them. Host lines on Rocky and the Pi come next, by
another agent.
