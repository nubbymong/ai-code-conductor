## 2026-11-13 -- The accounts list is never written from a failed read, and the owner-only folder check is remembered for ten minutes (PR #657)

Two fixes in one PR, both for the 2.1 stabilisation line.

**The accounts list (profiles.json).** `listProfiles` answers any failed read with an empty list, and the three writers (`upsertProfile`, `deleteProfileMeta`, `setPrimaryProfile`) saved what it gave them. One read that failed while another program held the file, and the next account edit replaced every saved account with the one being edited. The writers now read strictly: no file is an empty list, and a file that did not read completely is left byte for byte as it is and the writer throws `ProfilesUnreadableError`.

What the review round added on top:

- One parser. `readProfilesFile` is the only read and shape check of the file; `listProfiles`, `readProfilesStrict`, `updateProfilesStrict` and the writers all go through it. It passes over a byte-order mark, so a file saved by an editor that adds one still reads.
- Read once. A caller with a step it cannot take back (making an account folder, removing one, the home-layout migration) reads the list before the step and writes from that same read, so the list cannot stop reading between the step and the write. Both capture paths make the folder and the copies first and write the list once at the end.
- The user is told. Rename, make active or inactive, and remove answer one fixed sentence that names the file and not its path, and the Accounts row shows it; remove asks before it closes or clears anything, and if the list stops reading while it clears the claude.ai sign-in, it says that the sign-in was cleared and the account was kept. Add account shows the same sentence from Settings. The identity refresh answers no email while the list cannot be read (at its own read, or at the save), so the add-account poll keeps asking. The new-account prompt (a /login that brought an account the app has not seen) has no error line of its own, so a capture refused there leaves the prompt open and says nothing.
- Start-up skips rather than half-runs. The home-layout migration checks the list before it removes any sign-in file; first-run capture logs a list that stops reading part-way and does not throw. An entry of the list that is not a profile object is never handed to a reader (`listProfiles` returns the profile objects only), the start-up steps that edit the file as it was read pass over it, and the writers keep it in the file.

Known, and noted for the owner: a profiles.json that stays unparsable is no longer silently rebuilt (which lost accounts). The app shows no accounts and says why on each edit until the file is repaired by hand. There is no in-app repair.

**The owner-only folder check: a recorded decision reversed.** `account-profiles.ts` used to say "Unmemoised is a DECISION, not an oversight": `hardenCredentialDir` asked the file system on every call instead of remembering, because a memo keyed by path would call a recreated folder done (the canvas plugin tree is deleted and rebuilt, which puts it back on its parent's access list). That choice is reversed, and this is why. On Windows every call started icacls, a synchronous program start on the main thread, on every config write, at every session start and for each session's settings, MCP config and hooks. Idle that is 12-25 ms. While Defender is scanning, one start takes seconds, and the window froze for 1-5 s at a time.

A folder that an icacls read has PROVEN owner-only is now remembered, so the next calls for it start nothing. The objection that made the old decision is kept and enforced rather than dropped:

- Identity-checked. An entry is tied to the folder's file identity (`realFolderId`), taken before the proving read and compared after it. A folder removed and made again is another folder and is read again. A link, anything that is not a folder, and a missing folder are never remembered.
- Bounded to ten minutes, counted on `performance.now()`, so a system clock set back cannot keep an entry longer. After that the next call reads again, so a list changed from outside is found within that time.
- One way in. Only a read that showed the owner-only list is remembered, never a write. A folder that needed hardening costs a read and a write, then one read, then nothing.
- Forgotten on a failed write. `atomicWriteSecure` drops the entry for its folder when a write throws; the session-state save and the saved price lists, which write on their own, do the same.
- Capped at 512 folders; the one remembered longest ago goes first.

The jank detector is told once per call that starts icacls (not once per run), by a fixed label and never a path, so a stall during one is named.

**Evidence and what is still open.** The host-safe suites use a fake icacls and plain temp folders. Each review fix that changes what the app does has a test there, and each of those tests was checked by mutating the fix and watching it fail. `tests/unit/harden-dir-acl-windows.test.ts` drives real icacls and runs on CI and the test VM only; it was edited for this round and not run on the owner's machine. The same holds for the account handlers' block of `tests/wp1/claude-characterization.test.ts`, whose stand-in for the accounts module was given the exports the handlers now use. The measurement the change is for (fewer main-thread stalls with 20+ restored sessions) is a desktop check on a packaged build and is not done yet.
