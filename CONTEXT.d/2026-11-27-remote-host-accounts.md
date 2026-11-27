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
  refreshToken by name first. `--key` keeps its beta.19 output.
- 3.1.3 to 3.1.8 (src/main/remote-helper/host-accounts.ts, scripts.ts,
  session.ts, index.ts; the Claude package's remote accounts in
  providers/claude/remote-launch.ts): the account's folder
  `~/.aicc/accounts/<profile id>/` (Q4: profile id, never email), owner-only
  with the app's marker, its links into `~/.claude` only (one shared-folder
  list for this computer and hosts, src/shared/account-folder.ts, plus
  CLAUDE.md), settings.json the sanitised copy. One `accounts` exec per
  machine reads every sign-in there; read at Check, the start-up list, a
  sign-in tab's end and each launch on an account; never polled. A launch on
  an account runs in its folder (CLAUDE_CONFIG_DIR), on the machine's own
  sign-in when that is the account, else starts nothing and tells the tab
  and the renderer why. A folder signed in as another account is marked and
  never used. Sign out runs the CLI's own sign-out in the folder, then
  removes that folder only; the machine's own sign-in only after a confirm
  that names it so (Q5). Remove signs out every account folder there first,
  or, when the machine does not answer, names the accounts left and where
  to end each; `forget` removes such a machine from the list without
  reaching it.

Decided while building:

- A config with no account keeps today's behaviour (the machine's own
  sign-in, nothing read). Today's plain SSH path gets no accounts; the
  helper switch stays off by default.
- The session's own settings file (--settings) carries the sanitised copy
  too when the tab runs in an account folder, so the copy's exclusions do
  not come back through the flag.
- Remove's sign-outs use one `signout all` exec that finds the marked
  folders itself, so a machine whose helper is not this build's can still
  be removed.
- A sign-in tab names the account's email to `claude auth login --claudeai
  --email`, the words the app already gives for a sign-in on this computer.
- A kept session's attach also reads the account first; an account signed
  out since stops the attach with the notice (the session stays kept; End
  is on the Machines card).

Tests: helper cargo tests (CI; no toolchain on the build host), vitest unit
red-first with five mutants each shown red (a secret key through, a mismatch
read as signed in, CLAUDE_CONFIG_DIR dropped, a sibling folder removed in
the script and on the TypeScript side, a spawn when not signed in). The
remote-helper e2e job gains a stand-in account folder case. Host lines on
Rocky and the Pi come next, by another agent.
