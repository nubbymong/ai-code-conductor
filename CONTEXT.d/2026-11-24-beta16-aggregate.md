## 2026-11-24 -- 2.1.3-beta.16 lands in one PR, with its release commit

**One PR for the beta.** The reviewed sections of 2.1.3-beta.16 were merged at
their frozen heads with real merge commits onto one branch from beta (#760), in
the order B2, B3, B4, B1F, A1 (with A2 merged into it) and X1, one push each.
The version bump, the changelog entry and the release surface sweep are one
commit, 5a2f0f41; the commits after it answer the final step's findings.
Nothing in the plan was dropped; B1F joined from outside the plan (B1's hold
found its cause).

**Sections and their fragments (15.8).** A1, aicc_planning#401:
`2026-11-23-snap-own-capture-windows.md`. A2, aicc_planning#402:
`2026-11-23-snap-overlay.md`. B2, aicc_planning#400 and aicc_planning#403:
`2026-11-23-installer-listed-pid-and-location.md`. B3, aicc_planning#404:
`2026-11-23-cc-grow-keeps-rows.md`. B4, aicc_planning#399:
`2026-11-23-command-broadcast.md`. B1F, aicc_planning#371:
`2026-11-23-codex-no-app-warning.md`. X1, aicc_planning#405:
`2026-11-23-p11-image-paste.md`. B1, aicc_planning#370, changed no code and
has no fragment of its own; its reading is the next paragraph.

**B1, read in the running app, no code.** On the published signed beta.15 with
Codex 0.157.1 and replies from the P19 stand-in, 3 runs with the tab started by
the app and 3 with it held by the session helper: while a 21 s reply streamed,
no prompt-button press was typed into it. A press more than 5 s before the
reply ended answered "not sent" after the button's 5 s wait; a press in the
last 5 s was sent once, 0.5 to 0.7 s after the reply ended. aicc_planning#370
stays open for macOS, and its known-issues entry stays as it is.

**S8 on Windows.** Steps 2 and 3 ship in 2.1.3-beta.16. Snap takes its picture
with the helper's capture mode and our own overlay (a rectangle or the whole
screen); the new Snap is the Windows default, the previous one is a setting
away and takes any press the new one cannot do, and its package is loaded only
by a press that uses it. Linux and macOS wait (the mode exits 4 there). S34,
deleting the package, waits one beta and 2 days of owner use.

**Conflicts: none.** At each join no file had changed on both sides since
9bfcf0b6, read with `git diff --name-only` per merge parent. X1's hunks in
`src/preload/index.ts` and `src/renderer/types/electron.d.ts` come after A1's
join (A1 changed neither file); `src/main/session-input/index.ts` is X1's only
(B4 sends through `pty:submitPrompt` and changes no main file).

**Commits on the branch besides the joins.** aa8979b4, 5b538e90, 337bec27 and
1217de2e apply review wording (B2, B3, B4, B1F). 9f016863 and 4e538393 add the
WP1 ledger rows for B1F's and X1's new files, the manifest rewritten on the
clean tree each time. 043d7924 added a snap-e2e case at a forced display scale
of 1.5 (D11 to D13), owed since A2's review, and a later commit reverts it: on
its first run (45304028588) the forced scale gave Electron a display of 683 by
512 physical pixels where the helper read Windows' 1024 by 768, so the engine
could not pair them and the previous Snap took the press.

**The release commit.** Version 2.1.3-beta.16 and its changelog entry (dated
2026-11-24, CHANGELOG.md regenerated). The surface sweep: app-knowledge (the
Snap entry, the broadcast lines in the sessions and shortcuts sections, the
Alt+V paragraph, the Codex warning-count known issue in B1F's words); tips (Snap
on Windows, Shift+click to send to every session, the Alt+V tip); the Feature
Guide (the Snap card names the new overlay and the Previous choice; the Tips and
Shortcuts card names Shift+click); README (command buttons, Snap). ADR-030: the
native add-on row as measured (1 at start before and after; the old package's
36 JS files move to its first press), the P21 basic-user and in-app readings,
the P11 result. helper-protocol.md: the app runs the capture mode, and its
command line is frozen. The threat model: the app's run of the capture mode,
and Snap's overlay. The probes README: P11. X1's two review wording findings.
The `pty-manager.ts` cap stays at 7,773, the file's length.

**Not measured, carried to the owner's steps or to beta.17.** A capture from a
signed-in user who is not elevated (the Medium level): CI's basic-user step ran
at the High level with the Administrators group for deny only, so the owner's
first press is that reading, and the previous Snap takes any failed press. The
overlay's picture on a display above 100% in real Electron (the PNG path is
unit-tested only), a second display and mixed scaling. After a grow then a
narrowing back, a Claude Code tab can show the top row of its banner twice
above the screen (B3's VM note; no workaround, so no known-issues entry; a
beta.17 candidate). Codex's image paste waits for beta.17.

ADR-009 passes are owed before stable for A1, A2, B2, B4, B1F and X1, on the
aicc_planning #320 list.
