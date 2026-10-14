## 2026-10-14 -- 2.1.1 security record: GHSA-q5xq-wjvw-4m2p published, and the fixes held until stable

This is the public record. It was written after 2.1.1 reached the stable channel (2026-10-14) and after the advisory was published, as the embargo in SECURITY.md requires.

Every item below:

- was found by the project's own ADR-009 adversarial review passes: the WP2 review of the new Codex CLI runner, the 2.1.1-beta.2 security batch, and the 2.1.1-beta.3 release-candidate review;
- was tracked privately and fixed in public pull requests with neutral wording (the owner's routing decisions of 2026-10-04 for beta.2 and 2026-10-12 for beta.3);
- shipped before this was written.

Scope: this record covers the items listed here. It is not a list of every security-relevant change in 2.1.1.

### GHSA-q5xq-wjvw-4m2p (high, 7.8, CWE-427): current-folder program search through npm .cmd launchers (Windows)

**Affected:** 2.1.1-beta.1 and earlier, 2.1.0 included.
**Fixed in:** 2.1.1-beta.2. Shipped to stable in 2.1.1.

Codex and Claude Code installed with npm start through `.cmd` launchers, and those start `node` by its bare name. The app ran these launchers through `cmd.exe` with the project folder as the current folder, and it never set `NoDefaultCurrentDirectoryInExePath`. A program with the right name at a repository's root therefore ran as the user when a session was started there.

The routes were:

- Codex sessions;
- the Codex resume list, which also used `where` from the project folder;
- `codex_review`, which started the launcher through a shell;
- Claude Code sessions on the npm launcher;
- cloud agents, which started `claude` through `cmd.exe` in the project folder.

What changed:

- Every launcher starts by its full path, with the current-folder search off for it and for everything it starts.
- The app locates the CLIs and Node.js itself, with no `where`.

The fixing PRs were #625, #628 and #638. The advisory draft asked for the Claude Code npm route to be checked as possibly the same class. It was, and the same release fixed that route and the cloud-agent route, so the published advisory covers both.

### Codex review request expanded by cmd.exe (medium)

**Affected:** 1.5.0-beta through 2.1.1-beta.1.
**Fixed in:** 2.1.1-beta.2 (#625). Shipped to stable in 2.1.1.

On Windows, `codex_review` passed the review request to an npm-installed Codex as a command-line argument through `cmd.exe`. `cmd.exe` expands environment-variable references inside quotes. A prompt-injected session could therefore copy values from the app's environment into the prompt sent to the reviewing account.

On every platform the review also had two lower-impact faults:

- it inherited an ambient OpenAI API key;
- a review that timed out stopped only the wrapper process.

Reviews now:

- start Codex with a fixed command line that carries none of the request;
- pass the request on standard input;
- run in the reviewing account's prepared environment, with ambient keys removed;
- stop the whole process tree on a timeout.

### Fixed in 2.1.1-beta.3 (#641), shipped to stable in 2.1.1

- **Session hooks were collected from every folder above the session folder.** This affected 2.1.0-beta.2 through 2.1.1-beta.2. The walk went past the user's home folder, so a settings file in a folder another local account could write added hooks (commands) to the user's sessions. Hooks now come only from:
  - the user's own Claude Code settings;
  - the project itself, never a folder at or above home.

  The SSH remote side follows the same rule.
- **A held canvas verdict was typed without the ready-prompt check.** This affected 2.1.0-beta.11 through 2.1.1-beta.2. A canvas verdict that waited for the end of Claude Code's turn was typed into the session without checking for Claude Code's ready, empty prompt, so it could answer a permission question. Canvas verdicts now wait for that prompt, and the Compact, model and effort controls act only at it.
- **Square brackets in a Windows session folder name** could start Claude Code, or the resume list, in a different folder, because the launch line read the brackets as a pattern. The launch now uses the folder name literally. This affected Windows releases up to 2.1.1-beta.2.
- **One more Claude Code npm launch case was hardened.**
- **SSH remote setup could reset the host's Claude Code `settings.json`.** This affected 1.3.0 through 2.1.1-beta.2. A file the setup script could not parse as plain JSON was replaced with `{}` on the next connect. That happened to a file with a byte-order mark, a UTF-16 file (as Windows PowerShell writes) or one with a syntax slip. It silently removed the user's remote settings, including permission deny rules and sandbox settings. The file is now:
  - decoded the way Claude Code decodes it, and left as it is when it cannot be parsed;
  - otherwise cleaned of the status-line and MCP server entries the app recognises by name (a status line whose command names `conductor-ssh-statusline`, and MCP servers named `conductor` or `conductor-vision`), and rewritten only when one was removed.

  Users who rely on deny rules or sandboxing on an SSH host should check that file on the host.

### Process notes

- These fixes went through public PRs with neutral wording rather than advisory forks. The record was held until stable so that stable users had the fixes before the details were public.
- The advisory's temporary private fork carried no work. GitHub deletes it on publication.
- Only the Windows launcher class got an advisory. The other items, including the beta.2 review-request issue, are recorded here and in the 2.1.1 changelog. This follows the owner's decisions of 2026-10-14.
- Regression tests ship with each fix.
