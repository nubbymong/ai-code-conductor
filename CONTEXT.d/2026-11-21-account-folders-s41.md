## 2026-11-21 -- What each account folder links, copies and keeps, and one rule for it (S41, paired with S22)

Plan 2.1.3-beta.13, section C5 (aicc_planning#380). Docs and measurement only: no code changes
here. Every `file:line` is at origin/beta 9aa4b704 (v2.1.3-beta.12). Measured on one Windows 11 PC
with 12 Claude accounts whose resources folder is on a different drive from the user's home. Only
folder names, sizes and dates were read: no file was opened. Linux is read from the code; macOS
is not measured. S22 is ADR-030 D7's Standard login, bound by a per-account config folder
instead of by moving the home. In the lists below `<home>` is an account's folder under
`<resources>/account-profiles/<id>`, and `~/.claude` is the user's own config folder. MB and GB
are 1,024-based.

### What this finds

1. An account folder holds three kinds of thing: links to the shared `~/.claude` (six folders),
   copies the app rebuilds (two files, and the home's dot-files), and the account's own state (its
   sign-in, and everything Claude Code keeps for that account).
2. The sharing rule already works for folders. It fails for single files: a file link needs one
   drive, and on this PC the app made 0 file links and 7 to 13 copies per account.
3. A skill can live in seven places, and one of them is dead: the Setup dialog says the resources
   folder holds "skills", the app makes `<resources>/skills`, and nothing reads it.
4. The two rebuilt files are rebuilt when their account launches, not when the app starts, so an
   account that has not launched for a while keeps an old copy (4 of 12 settings copies here).
5. "Old accounts nobody uses" is only partly true on this PC: none is idle for 30 days, two for 14
   days or more. What is missing is a way to see it, not a pile of dead folders.
6. S22 stops moving the home folder. Then the home mirror (55 to 57 links and 7 to 13 copies per
   account) and the tools' litter in the home (359 of 1,049 MB here) would no longer be made.
   That rests on probe P17 (ADR-030), which is not run. S41 is the content list; S22 only changes
   which folder the list is applied to.

### 1. What the app puts in an account folder, and when

- **Six folder links.** `<home>/.claude/{projects,memory,agents,skills,commands,plugins}`, each a
  junction (Windows) or symlink to the same name in `~/.claude` (`SHARED_DIR_NAMES`,
  account-profiles.ts:38; `linkSharedDirs` :2696). `projects` first folds a real folder left
  there into the shared one and keeps the larger file on a clash (:2705, `mergeTreeInto` :2264).
  Made or re-made: when an account is created (:2128); at every launch of that account
  (`setupProfileLinks` :2775 calls `buildHomeLinks` :2709, which links at :2733); at app start,
  only fixing a missing or wrong link (`repairSharedProjectJunctions` :2804, called at
  index.ts:823); after a Windows owner-only remake (`relinkAfterRemake` :1821); in the retired
  per-session homes (`cleanupSessionHomes` :3055). The user manages these only in `~/.claude`.
- **A rebuilt copy of settings.json.** `<home>/.claude/settings.json` is `~/.claude/settings.json`
  with the entries that decide the account removed (`writeSanitisedSettingsCopy` :2552, the
  sanitising call at :2669, a 128 KB cap at :88). It is written whole every launch (:2685, called
  at :2736) and deleted when the source is gone (:2750). Anything the CLI writes into the copy is
  replaced at the next launch. `resyncProfileSettings` (:2852) has no production caller. This copy
  must stay a copy: a link would hand the user's settings to the CLI unsanitised.
- **A rebuilt copy of CLAUDE.md.** `<home>/.claude/CLAUDE.md` is a header, then
  `~/.claude/CLAUDE.md`, then an optional `CLAUDE.overlay.md` kept in the same folder
  (`writeUserScopeClaudeMd` :2452, overlay read :2464). Written at every launch (:2763), only when the text differs (:2484); a file
  it made is removed when both sources are gone (:2469). Nothing creates or documents the overlay.
- **The mirror of the real home.** Every dot-entry of the real home except `.claude` and
  `.claude.json` (`HOME_PRIVATE` :2254) is brought into `<home>` at every launch
  (`mirrorRealHome` :2388): folders as junctions, files as a hard link or, when that fails, a
  copy that is removed and written again each launch (`ensureHardLink` :2366-2379). It exists so
  git, ssh and npm find the user's config while the home is moved (:2765).
- **Empty store folder.** `<home>/.claude/anthropic` is made empty at every launch (:2730,
  `profileRealmConfigRoot` :3659).
- **The account's own, never linked.** The sign-in files: `<home>/.claude.json` and
  `<home>/.claude/.credentials.json`, written by the CLI (the second at sign-in and refresh). The
  app keeps a second copy of both in `<home>/identity/` (`writeCanonicalIdentity` :3071),
  refreshed at an identity refresh (account-profiles-handlers.ts:319), after a credential
  rotation (claude-account-identity.ts:357) and at each session's exit (pty-manager.ts:7552).
  Everything else in `<home>/.claude` (history, `file-history`, `jobs`, `backups`, `cache`,
  `sessions` and so on) is Claude Code's own state for that account: the app neither links nor
  copies it.
- **Left in the home by tools.** `<home>/AppData`, and any folder a person makes there. The app
  neither links nor cleans them.
- **Beside the account folders.** `account-profiles/profiles.json` (the list, :1960) and
  `.owner-only-ready` (a checked home kept for the next new account, Windows, :1242). A retired
  `<resources>/account-homes` is kept only for old session paths (:2977); absent here.

Which launches run the rebuild. Each of these calls `setupProfileLinks` first, so a copy is never
older than its account's last launch: a local Claude tab (pty-manager.ts:6625), a cloud agent
(cloud-agent-manager.ts:114), an Insights run (insights-runner.ts:127), a headless run such as
Sentinel's (`resolveHeadlessProfileHome` :2112, sentinel/index.ts:189), a reviewer
(`profileRealmLaunch` :3948), and the old-layout migration at start (:2887). The sign-in check
and sign-out probes (claude-cli-auth.ts:323, :525) run the CLI in the folder without rebuilding
it. Windows and Linux move the home (`USERPROFILE`, and `HOME` on Linux: :4011, :4020). On macOS
`HOME` stays real (:4012-4019), so the CLI keeps reading the real home and does not read the
account folder built there.

### 2. What the user manages, and where

- Skills, agents, commands and plugins are managed by hand in `~/.claude/...` or with the CLI's
  own plugin commands in any session; the shared link sends both to one place. No page in the app
  lists or edits them (searched the renderer).
- Seven homes for a skill. (1) `~/.claude/skills`, shared. (2) Skills inside plugins, under
  `~/.claude/plugins`, shared. (3) A repository's own `.claude/skills`, the CLI's project scope.
  (4) The app's three canvas skills, written to `<resources>/canvas-plugin/skills`
  (canvas-plugin.ts:575) and given to each Claude session with `--plugin-dir` (pty-manager.ts:7154);
  nothing is written to `~/.claude`. (5) The Ask Conductor helper skill, copied by an agent with
  approval to `~/.claude/skills/ask-conductor` (help-workspace.ts:52), so it lands in home 1.
  (6) Codex's own: the three canvas skills copied into `~/.codex/skills` or a managed account's
  `<home>/skills` (codex-user-skills.ts:4, codex-realm-skills.ts:17); a separate realm. (7)
  `<resources>/skills`: made empty by `setResourcesDirectory` (data-paths.ts:277), named twice in
  the Setup dialog (SetupDialog.tsx:936 and :974), read by nothing. Here it holds 21 folders
  dated January and February 2026 that no launch uses.
- The Accounts page adds, renames, switches off (account-profiles-handlers.ts:188) and deletes
  (:224). A delete refuses while a session is open (:232), clears the claude.ai session first,
  then removes the folder and only the links inside it (`safeTeardown` :2893). The account record
  has no last-used field (account-types.ts:4-21) and the page shows no size.
- What users are told is partial. src/shared/app-knowledge.ts:62 (Which settings apply where, read
  by Ask Conductor and the Feature Guide) says the settings file is copied into each account at a
  session start, that an edit of the copy is overwritten, and that memory, projects, agents,
  skills, commands and plugins are shared; it never mentions the CLAUDE.md copy or its overlay.
  README.md:144 and docs/USER_GUIDE.md:74-77 say "isolated home" and list what is separate, not
  what is shared. The Setup dialog and app-knowledge.ts:108 name "skills" as resources-folder
  content, and its "Resources contains" list leaves out the account folders, the biggest thing in
  it here.

### 3. Measured on this PC

Real bytes under each account folder, links not followed, 2026-11-21. "Last prompt" is the date of
`.claude/history.jsonl` (stat only). "Settings copy" is the byte size of the rebuilt settings.json;
the shared source is 1,046 bytes.

| Account | Total MB | `.claude` MB | AppData MB | Last prompt | Settings copy |
|---|---|---|---|---|---|
| a01 | 258.7 | 200.6 | 55.0 | 14 Nov | 1,046 |
| a02 | 151.2 | 9.2 | 136.3 | 10 Nov | 1,088 |
| a03 | 56.4 | 50.7 | 5.2 | 21 Nov | 1,046 |
| a04 | 49.8 | 30.7 | 18.4 | 21 Nov | 1,046 |
| a05 | 123.3 | 32.7 | 90.2 | 2 Nov | 1,093 |
| a06 | 40.7 | 26.1 | 14.1 | 9 Nov | 1,079 |
| a07 | 16.7 | 14.6 | 1.6 | 21 Nov | 1,046 |
| a08 | 143.8 | 138.0 | 5.3 | 21 Nov | 1,046 |
| a09 | 18.6 | 8.0 | 10.3 | 7 Nov | 1,126 |
| a10 | 50.9 | 27.9 | 22.6 | 20 Nov | 1,046 |
| a11 | 11.8 | 11.1 | 0.3 | 21 Nov | 1,046 |
| a12 | 127.4 | 127.0 | 0.0 | 16 Nov | 1,046 |
| All | 1,049.3 | 676.6 | 359.3 | | |

- **The shared store** (read through the links): `projects` 28.1 GB in 45,225 files and 24 project
  folders, one copy for all 12 accounts; `skills` 48.3 MB (2 entries, 2,787 files); `plugins`
  62.8 MB (17 entries); `commands` 0.6 MB (4 entries); `agents` and `memory` empty. The CLI keeps
  its automatic memory under `projects/<folder>/memory`, so the shared `memory` link carries
  nothing here.
- **Per account**: 55 to 57 junctions in the home; 0 hard-linked files; 7 to 13 copied dot-files
  (counting every plain dot-file in the home gives one more, the sign-in `.claude.json`). The
  folder holding the account folders and the user's home are on different drives, so no file link
  can be made.
- **CLAUDE.md**: 12 of 12 copies are 3,910 bytes, the source is 3,771: the copy is the source plus
  the 139 bytes of header and a blank line, so every copy is current. Their dates, 20 to 25 Oct, are
  when each was first written: the source last changed on 20 Oct, and an account made or launched
  after that wrote its copy then. No account has an overlay.
- **settings.json**: 8 copies equal the source's 1,046 bytes and were written at a launch on 20 or
  21 Nov. 4 are 1,079 to 1,126 bytes, written at a launch between 30 Oct and 10 Nov. Those four
  are a02, a05, a06 and a09, the four accounts not prompted for 11 to 19 days. I did not open
  them, so why their text differs is not established; only that nothing refreshes an idle
  account's copy.
- **Idle accounts**, by last prompt against 21 Nov: 0 idle 30 days or more; 2 idle 14 days or more
  (a05, a09); 4 idle 10 days or more (a02, a05, a06, a09); the other 8 prompted in the last 7 days.
- **Litter**: `AppData` is real in all 12 (0.0 to 136.3 MB); in the two largest I listed it holds
  a pip cache (73 and 103 MB), a GPU cache and an Electron app's user data (26 MB in one). Two
  accounts (a01, a02) hold a hand-made folder of parked commands or scratch files (7.6 MB in all).
  Five (a01 to a05) hold 38 per-session settings and MCP files dated 18 Aug to 20 Sep, and two
  (a01, a02) the legacy statusline script from June. The per-session files are written under
  `os.homedir()` (per-session-settings.ts:18 and :28), which is an account folder only when the
  app itself ran inside one of its own sessions, as in development.

### 4. Premise check

Held: 12 account folders; each with its own generated CLAUDE.md. Corrected: the ticket says each
start re-links and regenerates. At app start only the links are checked (index.ts:823); the two
copies are rebuilt when that account launches. Not supported: unused old accounts, in the sense of
dead folders (above). New: `<resources>/skills` is dead while the Setup dialog advertises it; file
links are copies across drives.

### 5. The rule, proposed

**An account folder holds only what proves who the account is, and what the CLI keeps for that
account. Everything else the user sets up comes from `~/.claude` and is never edited in the account
folder.**

1. **Folders are links; files are rebuilt.** A shared folder is a link (junctions cross drives). A
   shared file the app must treat, settings.json (sanitised) and CLAUDE.md (joined with the
   overlay), is rebuilt from its source before every launch and at every app start, and only
   written when it differs. A file is never presented as a link, since across drives it is a
   copy.
2. **One list.** The six folder names and the two rebuilt files are one definition that every pass
   reads (today the six names are looped in four places and the two files are special cases in
   `buildHomeLinks`), so a seventh name or a third file is one edit.
3. **The sign-in is the only thing copied out of the account folder** (to `identity/`). Nothing
   else the CLI keeps is read, moved or linked by the app.
4. **One place for the user to manage skills: `~/.claude`.** The app shows where it is, opens it
   and repairs the links; it has no second library. `<resources>/skills` goes. Chosen over making
   `<resources>/skills` the library because the terminal's own Claude Code keeps seeing the same
   skills, the 48 MB already in `~/.claude/skills` does not move, and nothing is migrated. The app's own
   canvas skills and Codex's stay as they are (they are the app's, not the user's).

### 6. Steps, sized, paired with S22

| Step | What | Size | Pairs with S22 |
|---|---|---|---|
| S41.1 | Retire the dead folder: drop "skills" from the Setup dialog (:936, :974), stop making `<resources>/skills` (data-paths.ts:277), never delete one that exists; one Feature Guide line and one tip on where skills live. Test by name: no text names it. | 1 h, light | None; any beta |
| S41.2 | One list, one pass: a function that makes the folder's links and two copies from one definition, called from the seven places `setupProfileLinks` is called today and by the start-up pass; the start-up pass also rebuilds the two copies for every account when they differ, and settings.json skips an identical write as CLAUDE.md does (:2484). Contract test over a temp folder: exactly these entries, nothing else the app made, sign-in untouched, an idle account's copy equal to its source after start. | 4 h, light | Takes the folder as its argument: S22 changes the argument, not the content. Land before S22 is built |
| S41.3 | A card in Settings, Accounts: the shared folder's path, a count for each of the six names, each account's six links read as fine, missing or wrong, "Open folder" and "Fix links" (the start-up pass). Reads only; never edits a skill. | 3 h, light | None |
| S41.4 | "Last prompt" on each account row, from the date of its history file (stat only), so an idle account is visible; delete stays the existing one. Sweep the app's own strays by exact name: the per-session files older than a week with no open session, the legacy statusline file. | 2.5 h, light | None |
| S41.5 | Migration with S22: when a launch is bound by config folder, move `.claude.json` in beside the sign-in only after a copy reads back equal, then remove the home mirror's links and copies (links by link, copies by their name in the real home's list), never a target. `AppData` is left. One VM line per sign-in kind. | 3 h, heavy | Is S22's migration. Waits for probe P17: if the CLI does not keep its identity in the config folder, S22 is not built and S41.1 to S41.4 stand as written |
| S41.6 | ADR (extends ADR-030 D7) for the rule; app-knowledge.ts:62 gains the CLAUDE.md copy and its overlay; a tip and a README line say what an account folder holds and what is shared. | 1 h, light | With S41.2 |

About 14.5 h. S41.1, S41.3 and S41.4 can ride any beta before S22. S41.2 is the one S22 depends
on. ADR-009 by path (fail closed): S41.2 and S41.5 edit account-profiles.ts, which holds the
sign-in and credential code, and S41.3 and S41.4 add IPC; each of the four carries "ADR-009 pass
owed before stable (aicc_planning #320 list)". S41.1 and S41.6 are text.

### 7. Not in S41

- Retention and disk size are 2.1.4's. The numbers above are its input: the `.claude` folders hold
  676.6 MB, mostly `file-history`, `jobs` (one account holds 189 MB), `backups` and `cache`, all
  Claude Code's own; `AppData` is 359.3 MB; the shared `projects` is 28.1 GB.
- Codex's own folders, and what the Machines work puts on a remote host (S25 on).
- macOS multi-account (S22 and probe P13).

### Not checked

- Claude Code was not run: how it treats a config-folder binding is probe P17's, not this note's.
- Linux numbers: none; Linux is read from the code only. A Windows PC with the resources folder on
  the same drive as the home would show hard links, not copies; that case is not measured.
- The date of `history.jsonl` stands for the last prompt; it is not a count of use.
- No file was opened, so what is inside a copy that differs is not known.
- Counts of the shared store are one walk that does not follow links, stopped at 80,000 entries
  (not reached: 52,574 entries).
