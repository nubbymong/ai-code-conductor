## 2026-11-19 -- Codex installed with npm on Windows is found off PATH, and the page offers to add its folder

Section C2 of the 2.1.3-beta.10 plan; aicc_planning#288, option A.

**The bug.** `npm install -g @openai/codex` on Windows puts codex.cmd in npm's
own default folder, %APPDATA%\npm. The Node.js installer adds that folder to
the PATH of the account that ran it only. On another account (the VM's
ccctest, 2026-10-13) Run it for me with npm worked, but the check found
nothing and the Set up Codex page said the Codex CLI was not found. The table
of install folders main looks in when a check finds nothing listed Claude
Code's folder only on Windows.

**The fix.** install-folder-path.ts gains a Windows row for Codex: npm's
default folder, %APPDATA%\npm, built from APPDATA in this process's
environment (its name in any case), as npm builds its own default. APPDATA
unset, empty or not a full path (a drive or a share) gives no folder, and the
page reads as before. codex.exe or codex.cmd, a regular file there (never a
link), counts. The page then shows the same off-PATH notice Claude Code gets,
with the folder shown as %APPDATA%\npm, and Add it to PATH for me appends that
one folder through the existing path. Nothing else changed: no program is
started to ask npm where its folder is, a custom npm prefix is not guessed,
discovery still finds Codex through PATH only (it is never run from the npm
folder off PATH, the ticket's option B), Claude Code's row and the macOS and
Linux tables are as they were, and what Add it to PATH for me writes and how
is unchanged.

**From review.** A redirected %APPDATA% can be on a share. A share that is
down could hold a bare lstat of npm's folder, and with it Check again and Add
it to PATH for me, for tens of seconds per press. The looks in an install
folder now wait no longer than a walk of PATH does (pathWalkDeadline, 20 s),
after which the folder counts as holding nothing (no hint, no add). A path
whose lstat has not ended is not looked at again until it has. This applies
to Claude Code's folder too; its answers are unchanged. Not changed: a
codex.cmd under a folder whose path has & or ^ is still offered. After the
add, the check finds it and reports it as found but not runnable (the Codex
package's shim rule, cli-runner.ts), as for an account whose PATH already
names that folder, rather than "not found"; copying that rule here would
cross the package boundary.

**Tests.** install-folder-path.test.ts: the folder off PATH gives the notice;
codex.cmd alone and codex.exe alone count, a link or another name does not;
the folder on PATH is found by a PATH walk and never offered; absent, no hint;
APPDATA unset, empty, relative, drive-relative or a bare server gives no
folder and nothing added; APPDATA read in any case and never from the home
folder; the add appends exactly that folder, after which the PATH walk finds
codex.cmd; a look that never answers ends at the deadline (20 s by default)
with no hint and no add; one lstat outstanding per path.
onboarding-codex-setup.test.tsx: the page shows the notice in
place of its not-found line, and the button sends the provider id alone and
checks again.

**Owed.** The VM check runs at the beta.10 release smoke, on the release PR's
installer, as ccctest. An ADR-009 pass is owed before stable (aicc_planning
#320 list): one more fixed folder whose base is an environment value, and a
PATH write offered for it.
