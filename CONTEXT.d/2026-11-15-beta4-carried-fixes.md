## 2026-11-15 -- Carried fixes for 2.1.3-beta.4: the platform config file, the shared program lookup, two model-name minors

One branch, three items carried from the beta 3 reviews and the planning backlog. Each is its own commit.

### platform-config.json is refused and kept, never wiped (planning #258)

On macOS and Linux the app saves its data folder, its resources folder and a few other settings in `platform-config.json` under the home folder (`.ai-code-conductor`, or `.claude-conductor` on an older install). It is the stand-in for the Windows registry.

**Problem.** A file that was there but did not read was taken for an empty set of settings: it could not be opened, it was not JSON, or it held something other than one object of text values. The next write started from that empty set and saved it over the file in place. One change replaced every saved setting with that one change, and a write cut short left a part of a file. A file holding a JSON array answered a write as saved and saved nothing. A file holding JSON null made every read throw.

**Change.** The file has a store of its own, `src/main/platform-config-store.ts`, behind `readRegistry` and `writeRegistry` (`src/main/registry.ts`). It follows the rule `github-config.json` follows (PR #672).

- No file starts empty, and the first write makes it. A file with nothing in it (no characters, or only white space, a byte-order mark and NUL characters) is taken the same way. Neither is taken from one look: "no such file" and "nothing in it" are each asked a second time, and an answer the second look does not confirm is a read that failed.
- A file that is there but did not read is refused and left byte for byte. A write saves nothing and answers false. A later location is not read in its place and no new file is started beside it.
- While the file does not read, a reader is answered from the values last read or written in this run. A file that is gone is no file, and nothing is kept for it.
- A write stages a copy beside the file and renames it over it (`src/main/atomic-write.ts`). A write that fails part way leaves the old file whole.
- The staged copy is created with the permission mode the file has, so a file its user made readable by its owner alone stays so after a save. (A mode is honoured when a file is created, and the process's own mask still applies, as for any new file. The first write of a new file names no mode.)
- A setting is a name the file holds with a text value. A name every object has by inheritance (`constructor`) is no longer answered as a setting.
- The log says a failed read once per kind until the file reads again, by the kind of fault, never the file's text or its path. A save that failed is logged the same way: `platform-config.json could not be saved (Error EACCES)`, never the error's own text, which carries the full path under the home folder. The kind of a failure is one function now, `src/main/failure-kind.ts`, shared with the `github-config.json` store.

**The file's shape is fixed.** One JSON object whose values are all text, and nothing else. The file has no version field, so that is the whole contract between versions of the app, and it is written at the top of the store. A file of any other shape is one this version does not know: it is refused for reads as well as writes and left byte for byte, as `github-config.json` is when its schema version is not this build's. So a later version must never write anything but a text value there. An older build that then read the file would read no data folder from it, start on the default one and show first-run setup, and could save nothing until the file was repaired or removed.

**What the user sees.** First-run setup's folder step used to say "choose another folder" for every folder it could not save. When the reason is the settings file, another folder would not be saved either. The step now says which file it is and to repair or remove it.

**The two setup channels.** `setup:setDataDir` and `setup:setResourcesDir` answered true or false. They now answer true, false or null (`src/shared/setup-folder-save.ts`): true once the folder is saved and only then, false when it was not for a reason of the folder's own, and null when it was not because the settings file is there but did not read. A save that was refused is never answered with a value that reads as true, so a caller that asks no more than "was it saved?" is never told yes by a refusal. The setup screen is the one caller; any other answer it is given, text included, counts as false. No channel was added, and the preload change is the type of those two calls.

**Kept.** Windows is untouched: it saves these values in the registry, and its two channels never answer null. The file's place and its name are unchanged, and so is which location an install uses. A link at the file's path is replaced by a plain file at the next write, as with the app's other files saved this way.

### One shared file test for every walk of PATH (planning #310, item 5, the half outside the SSH branch)

**Problem.** On Windows a file test in a PATH folder on a share that does not answer holds one of the few threads file tests share, for tens of seconds. The walk for Claude Code and the look for node.exe keep to one file test at a time in a folder, across every walk (2026-11-14, `win-launch-path-walk`). The app's other walks did not: git, the GitHub CLI, npm, the Node.js tools check, the Claude Code version probe and the check after a lookup found nothing each made file tests of their own. One folder that was down held a thread for each of them, and with enough of them a launch whose Claude Code is in a healthy folder was refused.

**Change.** `findOnWindowsPathAsync` (`src/main/windows-programs.ts`) is the one shared lookup. With no file test of the caller's own it asks through the shared one (`folderFileTest`).

- A folder is asked one file at a time, across every walk.
- A walk that asks for a file another walk is asking for takes that answer.
- A walk that waited there for another file passes the folder without a test of its own once the first says the folder cannot be reached. A failure about the one file (access denied, in use) is not handed on: the walk that waited asks for its own file.
- A walk waits behind another walk's test until a deadline of its own, 20 s from its start, and then makes its own test there, as the walk for Claude Code does. So a test left from before a share came back does not hold it for longer. At most two tests are outstanding in a folder.
- The version probe (`src/main/claude-cli-version.ts`) and the check after a failed lookup (`src/main/install-folder-path.ts`) keep a loop of their own and ask through the same test. The probe and the Codex lookup read that test through one helper (`sharedFileLook` in `windows-programs.ts`).

PATH's order holds as before, and what each walk names is unchanged. git's walk is in the PTY manager and was not edited: it calls the shared lookup with no file test of its own, so it follows the rule from here.

**The premise, corrected.** The plan said these lookups ran on the main thread. They did not: each was already off the event loop. What they lacked was the shared test, which is what the planning item says.

**The Codex CLI check.** That lookup did run in place. The CLI check (discovery, at start-up and at each later check) walked PATH on Windows, and on macOS and Linux asked a login shell where the program is and waited for it, up to 8 s, on the main process's own thread. The check now asks a twin of that lookup made off the main thread (`resolveCodexBinaryAsync`, `src/main/providers/codex/spawn.ts`): the same folders in the same two passes through the shared file test, and the same question to the same login shell without waiting in place. A suite holds the two lookups to the same answer from the same files asked in the same order.

**The check before a Codex CLI is used.** The check made just before a Codex sign-in, sign-out, status check, launch, usage read or model list read (`verifyCodexExecutable`, `src/main/providers/codex/discovery.ts`) made the same lookup in place each time. It now asks the lookup made off the main thread and waits for it. The file's real path and identity are read straight after the lookup has answered, with nothing waited for in between, and the caller still runs exactly the path the check names. Because the check now waits, every caller with a last word before a start asks that word after the check has answered: a status check asks whether it was stopped, a sign-in asks its caller's rule again, and a usage read makes its check before its last words, so that nothing is awaited between those words and the start of the helper, as before. A status check stopped while its executable is looked up answers "cancelled" and starts nothing.

**How the login shell is asked.** On macOS and Linux both Codex lookups (in place and off the main thread) start the user's login shell itself, by its name as it is written, with an argument list (`-l`, `-c`, `which codex`), in the home folder, with the lookup's environment (`loginShellRun` in `src/main/login-shell.ts`, the form the PATH question already used). The shell is the one every other check asks (`defaultLoginShell`: `SHELL` when it is set, then zsh on macOS, then the first of bash and zsh that exists, then sh).

**The full list of what moved and what did not.**

Moved off the main thread in this branch:

- The Codex CLI check at start-up and at each later check (discovery).
- The check before each use of the Codex CLI: sign-in, sign-out, status, launch preparation, usage read, model list read.

Asking through the shared file test in this branch (they were already off the main thread): git, the GitHub CLI, npm, the Node.js tools check, the Claude Code version probe, the check after a lookup found nothing.

Not moved. These stay for the beta after this one:

- The walks a launch makes in place on Windows for Claude Code (`findClaudeOnWindows`), for node.exe (the picker's last resort in `spawn-claude-command.ts`) and for the Codex resume list's node (`resolveNodeExe`, on every platform). They are reached through the PTY manager's launch build (`src/main/pty-manager.ts`), which this branch does not edit. They are the last resort described in the 2026-11-14 fragment and are unchanged.
- The launch-time fallback on macOS and Linux for a login shell outside the sh family: `claudeInLoginShellPathForLaunch` (`src/main/claude-cli-probe.ts`) asks that shell for its PATH on the event loop when no recent answer is kept (`loginShellPathSync`, at most 3 s, once per answer's life). It is also reached from the launch build.
- The ssh.exe and gsudo.exe walks, which run in place.
- The lookup for a command button's program (`src/main/resolve-executable.ts`). It is already off the event loop, but it makes file tests of its own, outside the shared one, and follows other rules (the working folder, PATHEXT).

Planning #310, item 5, is the ticket for the walkers that are outside the shared test or run in place. The launch-time login-shell fallback and `resolve-executable.ts` are not named there yet and need adding to it.

**The longest wait, and what was not measured.** With the shared test, walks of one folder take turns, so a folder that is down can hold a set of walks for longer than it did when each made its own test at once. The tests pin the worst case with stand-in timers (`tests/unit/main/windows-path-walk-deadline-call-sites.test.ts`): eight walks for eight programs start together, and each file test in the folder ends after the same time T for a reason that is not handed on (UNKNOWN, one of the ways a share that is down answers). Never more than two tests are outstanding, every walk makes its own, and the walks have their answers after T, 20 s + T, 20 s + 2T (two walks), 20 s + 3T (two) and 20 s + 4T (two). Before, each had its answer after about T, with eight tests outstanding at once. When the folder says it cannot be reached (a timeout, the network or the host down), the answer is handed on and every walk has its answer by 20 s + T. For the launch's own walk of PATH the wait for an answer is still bounded at 20 s, and a longer queue behind it means the "a PATH folder did not answer" refusal can last longer while a share is down. No real share was taken down: every file test in the tests is a stand-in, and the figure on a real share is for the VM run.

### Two model-name minors from the beta 3 review

**A proposed name is held to the fetched-file name rule.** For a model entry proposed to the registry (`src/main/sentinel/sentinel-apply.ts`), the proposed id and aliases are now held to the fetched-file name rule (`idHeldBy`, `src/main/model-registry-data.ts`), against every entry the registry has. A name is refused when it is a known id or alias, a known id with a date or a context size after it (`claude-opus-4-8-20260301`, `claude-opus-4-8[1m]`), or one of those read with each dot between two digits as a hyphen (`claude-opus-5.5`), and the refusal names the model that has the name. A new version the registry reaches only by a shorter id or by a pattern (`claude-opus-5-7`, `claude-opus-6`) is still taken, and so is a new model's own dated id. The check reads the registry as the matcher reads it, its entries with an id (`usableEntries` in `src/shared/model-registry.ts`): the user's own registry file is merged in as it is written, and an entry there with no id, or something that is no entry, is passed over and no longer stops the check.

**A fetched model's own dated or dotted id.** A model only the fetched model file has was tried after every standing entry, patterns included. In a family the build ships, the family's plain pattern matches every name of that family, so the new model's dated id, its id with a context size and its id with the version written with a dot all went to the entry with that pattern, at that entry's price (the limit noted on 2026-11-14 in `model-names-katex-docs`). The matcher (`src/shared/model-registry.ts`) now asks one more thing between the standing ids and the standing patterns: a name no standing id starts is the fetched model's, by its id, when it is that model's id with a date or a context size after it, read as written or with each dot between two digits as a hyphen, or the id itself in that second reading.

What does not move:

- A name a standing id starts stays with that entry (`claude-opus-5.7` beside a fetched `claude-opus-5-7` is still reached through the shipped `claude-opus-5`, unless the file lists it as an alias).
- A name that only starts with the new id (`claude-opus-6-fast`), or holds it behind a partner platform's name, stays where it was.
- The two holds the check on a fetched file applies to an alias apply here too, so the matcher gives a new model no name its file could not have listed. A standing id written with a dot keeps the name it has once the dot is read as a hyphen (`gpt-5-5-20260101` beside a fetched `gpt-5-5`). And the entry the pattern step places the name on keeps it when its own id starts with the new id (`claude-haiku-5-20270101` beside a fetched `claude-haiku-5`).

What moves, on purpose:

- Names that resolved before resolve as before. With no fetched file the added list is empty and the matcher's steps are the old ones. With a fetched file, every name a standing id starts is answered before the new step.
- A fetched model's own id with a date or a context size after it, or written with a dot, now goes to that model ahead of a pattern on any standing entry. That includes a pattern on an entry the user added, or one Sentinel added, not only the shipped family patterns.
- Such a name is matched as an id match (`prefix`), which the model pickers and the effort list read as the model itself. Before, it was a pattern match on another entry.
- The limit of eight aliases in a fetched file does not count these names: they are the model's own id in another form, not aliases the file lists.

`resources/model-registry.json` is not changed. The property test over the fetched files now also asks about the dated, bracketed and dotted forms of every new id, and two tests that pinned the old placement were rewritten.

### The release gate's live step runs the per-host statusline packs

`scripts/verify-release.mjs` has an opt-in live step. It named one file, `tests/live/ssh-statusline.live.ts`, which was split into one pack per target host on 2026-08-31, so the step found no test. It now finds the statusline packs by name when it runs (`ssh-statusline-<host>.live.ts`) and hands them to vitest under the live config, as `npm run test:live:ssh` runs them. The multisession packs stay out of it, as before. With no pack found the step fails and says so. This is a script and its unit test only: nothing under `src/` changed for it, and no live run was made here.

### Tests

Each new test was run against the code without its fix first. Failing before: 13 (proposed names), 16 (the matcher), 30 (the platform config file and the setup step), 31 (the lookups).

The review round added tests and ran each against the code without its fix, by taking the source changes away and by a named change to one line:

- With the round's source changes taken away, 31 cases failed: the check before use (the lookup off the main thread, the order of the last words, a stop during the lookup), how the login shell is asked, the save log line, the mode of the staged copy, the two setup channels' answers, the registry with an entry that has no id, and the release gate's packs.
- The 20 s deadline is wired in at four places (the shared lookup, the version probe, the check after a failed lookup, the Codex lookup). Each has a case with stand-in timers: no test of its own and nothing past the folder at 20 s less 1 ms, its own test in the folder at 20 s, that folder's program when it answers, and no timer left when the walk ends. With the deadline not handed to the shared test, the four "its own test at 20 s" cases failed, and so did both longest-wait cases. With the timer not dropped, the four "no timer left" cases failed. With a third test allowed in a folder, both longest-wait cases failed.

The WP1 legacy manifest is unchanged: the new suites name no assistant where an existing one already could, and the ledger was not touched.
