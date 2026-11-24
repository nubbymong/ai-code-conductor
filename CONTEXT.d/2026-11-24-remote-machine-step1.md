## 2026-11-24 -- remote step 1: a Linux machine added once, and a Claude Code SSH tab through the session helper there (A2.1)

Plan 2.1.3-beta.17 section A2, aicc_planning#411; its first build step (A2.1),
then A2.2 (below). The bridge mode itself is A1's (aicc_planning#410), merged
into this branch in A2.2.

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
  remote module can read it (the file is 7,741 lines; the cap goes down to it).
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
  image paste in this preview; an image paste, Snap or screenshot storyboard
  types nothing and the tab says so; prompt buttons and broadcast type as into
  any Claude Code tab.

A2.2 (A1 joined, the device check green):
- A1's frozen branch (aad6cc3b) is merged in (a merge commit; no textual
  conflict). The one semantic difference: a dev run now reads the helper and
  its manifest where A1's scripts put them (helper/target/helper-linux-musl/
  aicc-helper, helper/target/helper-manifest/manifest.json); a package keeps
  resources/helper. The job writes the manifest with A1's writer, and the
  device check reads the helper through the app's own manifest reader.
- remote-helper-e2e on this branch (retries 0): run 45335138014 red (the test
  killed the link after a 240 KB flood had already arrived, and closed the
  tab in that moment); run 45336099500 red (its last count matched its own
  command line); run 45336427954 green, 6 of 6: Add, Check, another
  install's Remove refused, the fake CLI session (rc variable, a link killed
  at rest and back), a shell session (resize; 20,000 lines printed while the
  bridge was stopped, then the link killed: "attaching again from 258", every
  line once, none seen before), Remove, nothing left.
- Found by the first run and fixed in the app: a tab closed just as its link
  drops sent its term.end into the dead link, and the holder ran on until its
  away clock. Such an end now goes once more on a new link.
- Found while writing finding 6's tests and fixed: a write longer than 256
  bytes is sliced by writePty, so the image request could be split and the
  rest typed; the write door (pty:write) now holds the whole request back
  first, and the screenshot menu sends one request instead of its line by
  line storyboard on such a tab.

A2.3 (the section review's findings, all applied):
- The switch is read first: while it is off (and unless it is saved exactly
  true) the machine records and the manifest are not asked for, so a dormant
  feature makes no records file and a busy or full disk fails no SSH spawn.
  With it on, records that do not read send the tab the usual way, with one
  log line.
- A tab started through the helper tells its SSH flow overlay at once, and
  keeps answering "through-helper" after a start that failed, until it is
  closed (the kill door forgets it: killPty does not reach a terminal that is
  over) or started again.
- A launch the holder refuses (the config's remote folder is not there) names
  the folder and the holder's words in the tab.
- The launch carries COLORFGBG from the app's theme, as the usual SSH launch
  line does.
- A machine holding another helper than this build's reads not checked on its
  card, with "press Check to update it"; Check installs this build's first.
- Only the app's own image request is held back (one line in its shape, or the
  storyboard's line); a paste or a line that only names the tool is typed.
- The switch's text says Restart on such a tab starts a new conversation
  (/resume picks the earlier one up); a refused key sign-in says a key with a
  passphrase works only through the ssh agent.

A2.4 (the whole-diff review's findings, all applied):
- The records file: only a missing one is made. One that is there but does
  not read (a busy file, a file that does not parse, no valid install id or
  list of machines) is left as it is, and every use of it fails, where it was
  written over with a new install id and no machines: every added machine was
  lost, and their helper folders named an install id the app no longer had.
  Its writes are flushed before the rename. When the list does not load, the
  Machines page's Linux machines section stays and says so, with no Add,
  where it vanished.
- What a tab through the helper is sent reaches the PTY integrity count, as
  every other tab's output does: the Services page showed such a tab at
  `in:0` with a negative gap, and no loss on it could be flagged.
- The SSH flow door's "through-helper" answer has its own test, and the route
  test reads pty-manager.ts's cap from scripts/ci/pr-numbers.mjs instead of
  restating it.
