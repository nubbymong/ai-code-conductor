## 2026-10-12 -- the scripts folders are made the user's alone at each start (2.1.1-beta.3)

- **At start, before the deploys:** the resources folder's `scripts` folder
  and its `lib` folder go through the owner-only folder rule once a run
  (`secureScriptFoldersRule` in `owner-only-folders.ts`, run by
  `script-folders.ts`), in one asynchronous call, never on the main thread's
  path. On Windows each is made this user's and owner-only, and what is
  directly inside it is read and put right as for the account sign-in
  folders; on macOS and Linux each is made 0700 and must be this user's. The
  resources folder itself is made first when it is not there yet (a first
  start). As for the sign-in folders, each folder's identity is read before
  the rule is asked, and a folder passes only when it is still that folder
  after the answer (one the rule made passes as the folder there after it).
  A folder the rule gave no read of (a call that could not run or end, as a
  cold Windows PowerShell can once) is asked once more, in one call; a folder
  read and refused is not. The `lib` folder passes only inside a `scripts`
  folder that passed, and only the `scripts` folder's refusal is logged then.
  The deploys then run, and only after them may a launch take a script from
  these folders.
- **Launches:** a Claude Code or Codex session runs a deployed script (the
  status line script, either resume picker and the Codex picker's helper lib,
  the Codex hook forwarder and its Windows wrapper) only when
  `checkDeployedScript` holds: the script is a plain file with one name (on
  macOS and Linux also this user's, with no write bit for group or others),
  in a folder the rule passed in this run that is still the same folder (its
  volume and file id) and a real folder. Otherwise the feature is skipped for
  that launch (no status line of the app's, no resume list, no hooks), said
  in one warning, and the session starts. A folder the rule cannot make
  owner-only (a network share, a FAT drive) is said once at start, by its
  name (a path in the rule's reason is put as its last name only, also when
  its folders' names hold a space), and those
  features are skipped for the run. The Claude Code launch looks the resume
  picker up on every local launch, and says a refusal only for a launch that
  asked for the resume list.
- **The Codex picker's lib folder:** when `scripts/lib` is there, the picker
  runs only if that folder passed this run's check, whether or not the
  helper lib is in it (the picker loads its helper from that folder). The
  picker always loads its helper, so when the folder passed but the helper
  lib is not there because this run's deploy of it failed, the picker is not
  run either: Codex starts directly, with one warning.
- **A deploy that failed:** a destination whose deploy failed this run (the
  source could not be read, or the shipped bytes could not be put in place)
  is recorded (`deployFailedThisRun`), and a launch does not run what is
  there (the launch check, and the Codex hook check for the forwarder and its
  Windows wrapper) until a later deploy this run finds or puts the shipped
  bytes there.
- **Waiting:** a local launch that comes while the check and the deploys
  still run is held as a prepared spawn (`pty-handlers.ts`), at most 5
  seconds (`awaitScriptFolders`), so tabs restored at start get their
  scripts; past that it starts without them. A local Codex launch waits for
  its hook folders (`awaitCodexHookFolders`, its own 5 second bound) only
  after this wait, since the start wires the hook folders after the scripts
  folders' check and the deploys; so each bound covers its own work alone.
- **The status line script** is deployed through `deployScriptBytes`, by the
  same rules as every other deployed script, and a failure is logged. Its
  command goes into a session's settings only after the launch check
  (`launchStatuslineSetting`); a path the shell would read as more than a path
  still gives no command, as before.
- **Deploy rules (`script-deploy.ts`):** the destination is read with lstat
  first, and its bytes only when that shows a plain file, through a handle
  opened with `O_NOFOLLOW` and `O_NONBLOCK` where the system has them,
  and only when the handle says it has the shipped bytes' size (a plain file
  of another size is replaced unread); anything else there (a link, a
  directory, a FIFO, a socket, a device) is replaced as a copy whose bytes
  differ, and a failure to replace it throws.
  On Windows a plain copy with one name and the read-only attribute is made
  writable before it is replaced (never one with another name). On macOS and
  Linux a copy with a different owner is replaced, `scripts/lib` of this user's
  with loosened bits is made 0700, and the folders the app makes are 0700.
- **Tests only:** every directory removal at a destination is asserted to be
  called with the path alone, so a recursive removal fails the suites. The
  host-safe suites that run the launch check make their scripts folders 0700
  and their scripts 0600, so a runner's umask does not decide them.
- **Owed on CI or the VM:** `script-folders-real`, `script-deploy-links` (a
  real FIFO and a link to a device), `per-session-settings-statusline`,
  `resume-picker-lib-links`, `spawn-resume` and `provider-entry-routing`
  (host quarantine); the POSIX-only case in `statusline-deploy` (CI); manual rows
  on an elevated and a standard account (the two-account rows; a resources folder on a FAT drive or a network share; tabs
  restored at start get the status line and a Codex tab its hooks); and the
  live SSH matrix (`npm run test:live:ssh`), since `pty-manager.ts` is touched
  (its local resume picker lookup and the one line that asks it).
