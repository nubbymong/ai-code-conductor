## 2026-11-24 -- remote step 1: a Linux machine added once, and a Claude Code SSH tab through the session helper there (A2.1)

Plan 2.1.3-beta.17 section A2, aicc_planning#411; its first build step (A2.1).
The bridge mode itself is A1's (aicc_planning#410); A2.2 merges A1's frozen
branch and runs remote-helper-e2e with the real bridge.

What was built:
- `src/main/remote-helper/` (no Electron import): one-shot ssh execs with the
  fixed options of protocol section 2 a key-only host needs, each value checked
  before ssh starts (`ssh-exec.ts`); ten fixed `/bin/sh -c` scripts with no
  quote, backslash or line end, values as arguments and content on stdin, each
  checking the device id, `$HOME` and (but probe and install) the owner marker
  before it acts (`scripts.ts`); the installer's manifest (`manifest.ts`, A1's
  contract); Add, Check and Remove (`machines.ts`); the routing (`route.ts`);
  the tab's terminal, a HelperPty whose driver runs `hold --detach` and the
  `bridge` exec over ssh (`session.ts`); the door from the PTY manager
  (`index.ts`).
- `pty-manager.ts`: one entry after the SSH branch's Codex refusal (a labelled
  branch, two lines); `SSHOptions` moved to `src/main/ssh-options.ts` so the
  remote module can read it (the file is 7,741 lines, cap 7,773).
- Machines: a Linux machines section (Windows) with Add (a question naming the
  file, its size and SHA-256 first, then a one-time token), Check and Remove.
- Settings, General, Terminal: "Remote sessions through the session helper
  (Linux, preview)", off by default, Windows only.
- ci.yml: the dispatch-only `remote-helper-e2e` job (a localhost sshd, the
  static helper and the fake CLI built in the job, rc files that print a line
  and set what only `bash -il` sees, retries off).

Decided while building (recorded for the aggregate's docs):
- Only Connection = SSH (`detachable: false`) goes through the helper: a config
  with no `detachable` value is SSH Persistent and keeps the usual path, with one
  log line saying so; the machine's card says which configs go through it.
- A tab whose helper start fails shows why in the tab and ends; it does not fall
  back to the usual SSH path mid-start (Check on Machines, or the switch off).
- The fixed scripts report `AICC-RESULT <nonce> <key> <value>` words, not JSON:
  script text with no quote or backslash cannot write JSON. The helper's own
  self-test still prints its JSON line.
- No read-back hash: a host with no sha256sum, shasum or openssl is refused at
  Add (each start hashes the file with the same tool).
- A tab through the helper has no status line, usage, app tools, hook events or
  image paste in this preview; an image paste or Snap types nothing and the tab
  says so; prompt buttons and broadcast type as into any Claude Code tab.
