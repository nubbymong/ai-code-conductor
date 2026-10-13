## 2026-10-11 -- O5 follow-on: the way off the retired Codex sign-in for beta.2 users

Follows 2026-10-11-o5-codex-signin-retired.md (the "use this computer's Codex
sign-in" option is removed in 2.1.1-beta.3). Only 2.1.1-beta.2 offered that
sign-in; the account it registered keeps working. The owner agreed the way
off it on 2026-10-11, with no new mechanism beyond these two:

- One page, once: "Replace this sign-in with a Codex account". A boot gate
  ('codexReplace', after the Multi Spawn page and before the Codex
  introduction, so it never takes the screen from a page already showing:
  App arms it from the first accounts snapshot of a start, which can land
  after the resume prompt is up). Armed only with Codex on as answered and an
  account for that sign-in still listed. Add a Codex account opens the usual
  add-account dialog over it; an account added there closes it. Not now (or
  Escape) closes it. Either way it stamps `codexReplaceSeenVersion`, and
  presence of that stamp is what counts, as with Hello Codex. It signs
  nothing out, archives nothing and changes no config.
- At launch: the confirm asked before a later launch on that sign-in
  (LaunchAckConfirm) also lists the other Codex accounts, by the New session
  dialog's picker rule, with "Use this account". Picked (once armed, like
  every answer), the session moves to it, the saved config it came from moves
  too when it named that sign-in or followed it as the default (a config that
  names another account is left alone), and the launch starts there, asking
  first only if that account needs it. An account no longer usable by the
  time it is picked moves nothing and starts nothing. A Cloud Agent retry is
  not offered it (the request API keeps its yes/no answer; only the session
  launch asks through the new requestChoice).

A launch the confirm moves resumes as before: main's exact resume of a
restored tab looks in the new account's folder and falls back to the picker
or a new conversation when the conversation is not there; a live Restart
carries it over (P3.6). When the launch resumes an exact conversation, the
confirm says under the picker that the tab's conversation does not come along (it stays
with this computer's sign-in) and names the way that keeps it: Launch, then
Switch account on the running session, which carries it (main's
carryForRespawn copies it from the source account's realm; the source may
be that sign-in while it is not archived). The one-time page says the same,
and both now say a saved config moves only when it used that sign-in.
Carrying a restored tab's conversation at the launch itself would be a new
main path (the renderer naming a source conversation and account to copy
from), so it was left out: not agreed, and an ADR-009 path of its own.

Archiving the account for that sign-in is final (no Restore in Settings,
refused in main), and both the Archive confirmation in Settings and main's
acknowledgement message say so plainly before anything changes. The row's retire line on an active row that is
no longer the default asks only to add an account if needed, then Make
inactive and Archive (it no longer says to make a new default).

Same day, the rest of this change (stable closeout items F8, F10, F11):

- F10 (#196 point 1): on the row for that sign-in, the app-only actions
  (Make inactive, then Archive) now come before Sign out, which is named
  "Sign Codex out on this computer..." and keeps its warning, because it
  signs the Codex CLI out machine-wide. Managed rows are unchanged. No
  one-step "Remove from the app" was added: the replace page does not route
  a user whose only Codex account is that sign-in, so that stays 2.2.
- F11 (#196 point 3): Sign in again is no longer offered on that row, and
  main refuses it first ('unsupported', with a plain message), before any
  check, sign-out or login runs, acknowledgement or not. The in-place path
  that signed every app using that sign-in out first is removed.
- F8 (#181 items 1, 2, 4 and the pill reason): row buttons may wrap inside
  their cell; "ChatGPT sign-in" on an account row uses a non-breaking hyphen;
  the "Confirm each launch" pill's reason is also an sr-only line it names
  with aria-describedby (a pill takes no focus, so its title reached only a
  mouse); the row comment and the layout test now say a long name wraps to
  two lines and is cut past that, with its full text in its title.

A saved config that names no account moves to the picked account only
when it used that sign-in, as the code, this log and the confirmation
promise (a tab can be bound to the sign-in by a Switch account while its
config follows another default). A config that names no account moves only
when the launch resolved from the default (the session named no account when the launch was planned); one that names the sign-in
moves as before. An inactive account for that sign-in still shows the
one-time page, which then says nothing starts on it instead of promising
launch confirmations; Use this account is described (aria-describedby) by
what moves and, for a restored tab, by the conversation note; the Confirm
each launch reason, read by a screen reader after the visible Cannot run
reviews line, no longer repeats that line.
