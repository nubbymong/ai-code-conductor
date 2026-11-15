## 2026-11-15 -- Program lookups off the main thread, the rest, for 2.1.3-beta.5 (planning #310, item 5, the half outside the SSH branch)

The owner approved the 2.1.3-beta.5 plan on the Agent Canvas on 2026-11-15. Beta 4 moved the shared PATH walks (git, the GitHub CLI, npm, the Node.js tools check, the Claude Code version probe) off the main thread. What was left outside the SSH branch is done here. The ssh.exe walk (`pty-manager.ts`, `sshProgram`) is in the SSH blast radius and is not touched.

### What a launch no longer does in place

**Problem.** A launch asked for with no answer kept still looked for a program on the main process's own thread: a PATH folder on a share that does not answer holds one file test there for tens of seconds, and a login shell with slow start-up files holds it for as long as they take. No window is repainted and no terminal gets its output meanwhile.

| Lookup | Where | Before | Now |
| --- | --- | --- | --- |
| Claude Code, the last resort | `providers/claude/spawn.ts` `findClaudeOnWindows` | `findOnWindowsPath` in place | starts the shared walk (`claudeOnWindowsPathAnswered`, one stat at a time through the shared file test), answers none for this launch |
| node.exe for the resume list | `spawn-claude-command.ts` `pickerNodeOnWindows` | `findOnWindowsPath` in place | starts `warmPickerNodeOnWindows`, leaves the resume list out for this launch |
| gsudo.exe, an elevated terminal | `providers/claude/spawn.ts` | `findOnWindowsPath` in place | looked for once before the launch (`gsudo-lookup.ts`), the answer kept |
| the login shell's PATH, for a user whose shell is not of the sh family | `claude-cli-probe.ts` `claudeInLoginShellPathForLaunch` | `execFileSync`, up to 3 s | the kept answer, else none and the question started off the event loop |
| where codex is, macOS and Linux | `providers/codex/spawn.ts` `resolveCodexBinary` | `execFileSync`, up to 8 s | the answer `resolveCodexBinaryAsync` last kept |
| where node is, for the Codex resume list, macOS and Linux | `providers/codex/spawn.ts` `resolveNodeExe` | `execSync` through a shell string, up to 8 s | the answer `warmNodeExeOnPosix` kept, the bare name until there is one |

`loginShellPathSync` (`login-shell.ts`) had no caller left and is gone.

### How a launch still gets the answer

- **Held first, as a Claude Code launch already was.** `claude-launch-walk.ts` holds a local Claude Code launch, as a prepared spawn, for the walk off the event loop when no answer is kept. It now also holds one on macOS and Linux for a user whose login shell is not of the sh family (fish, say), for the shell's PATH question. An elevated terminal on Windows is held, bounded by the walk's deadline, for the look for gsudo (`ipc/pty-handlers.ts`). A Codex launch that opens the resume list on macOS and Linux waits for `warmNodeExeOnPosix` in the preparation it already has.
- **"Not yet" is not "not installed".** A launch asked for in the moment between (the kept answer ran out while it waited) takes no answer, starts the look for the next launch, and says so: `CLAUDE_LOOKUP_UNDER_WAY` for Claude Code, `GSUDO_LOOKUP_UNDER_WAY` for gsudo, `CLAUDE_RESUME_LIST_SKIPPED_LOOKING` in the log for the resume list. Never the not-found message, never a later folder's program, never a bare name. A launcher with no login-shell answer is a login shell that builds its own PATH, as for a user of an sh-family shell.
- **A walk that fails.** A walk of PATH that throws keeps no answer, and the launch is told to try again. One that throws twice in a row for the same PATH keeps "none" for a minute (a failure more than a minute old does not count as the first of the two), so the launch then says Claude Code was not found instead of asking for a retry for ever; the failure is logged. A walk that succeeds clears the count.
- **Before main has started** (`launch-lookups-armed.ts`; `startClaudeAtBoot` arms it) no launch is asked for, and a unit test that drives one has no look to wait for: those calls keep the look in place, as before. In the app the flag is set at start.

### Tests

`tests/unit/main/launch-lookups-off-main-thread.test.ts` has a slow fake folder (or a login shell that does not answer) per call site and fails if the call walks or starts a shell in place. Existing cases that asserted the in-place last resort were changed to the new behaviour (`claude-launch-walk.test.ts`, `claude-start-lookup.test.ts`, `pty-spawn-claude-start-lookup-bound.test.ts`, `providers/codex/spawn.test.ts`), `pty-spawn-launch-lookups-held.test.ts` drives the real `pty:spawn` handler to show an elevated terminal on Windows is held for the look for gsudo and starts only when it ends (and is not held with an answer kept, not elevated, off Windows or before main has started), and that a Codex launch that opens the resume list on macOS and Linux waits for the node question (and a launch that opens none does not ask it). `spawn-site-inventory.json` follows the three process starts that went and the one that was added.

### Not in this change

- The ssh.exe walk (`pty-manager.ts` `sshProgram`, five call sites): SSH blast radius, needs the live SSH matrix, a later beta.
- The Codex resume list's node.exe on Windows (`resolveNodeExe`, a file test in place) and `pickerNodeFor`'s per-folder stat on macOS and Linux (`findOnPosixPath`): not login-shell lookups, and not in the plan for this beta.
- The text of planning #310 about `resolve-executable.ts` having a login-shell fallback is stale (it is the capture-command resolver, async); the launch-time fallback was `claudeInLoginShellPathForLaunch`, above.
