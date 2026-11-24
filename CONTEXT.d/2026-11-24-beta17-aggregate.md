## 2026-11-24 -- 2.1.3-beta.17 lands in one PR, with its release commit

**One PR for the beta.** The reviewed sections of 2.1.3-beta.17 were merged at
their frozen heads with real merge commits onto one branch from beta (#761),
one push each, in the order C2, A1, C1, C5, C6, C3, H, A2, C4, C7, C8, C5b, B1,
B1b, C9, B1c, B1d, C10, B1e, B1f and C11 (through C11b and C11c). The version
bump, the changelog entry and the release surface sweep are one commit, the
release commit. Nothing in the plan was dropped. H, C8, C5b, B1b, C9, B1c to
B1f, C10 and C11 joined from outside the plan: each fixed a cause a section's
CI, review or VM line found (owner rule: never ship a known bug). B1g was built
and not joined: the case it fixes (a canvas decision for a restored tab not
shown yet) cannot be reached through the UI, since the canvas pane is mounted
only in the active tab's tile; its branch is kept for when it can.

**Sections and their fragments (15.8).** C2, aicc_planning#413:
`2026-11-24-broadcast-chooser.md`. A1, aicc_planning#410:
`2026-11-24-helper-bridge-linux-package.md`. C1, aicc_planning#409:
`2026-11-24-canvas-marker-background-agents.md`. C5, aicc_planning#414:
`2026-11-24-cc-narrow-banner-once.md`. C6, aicc_planning#415:
`2026-11-24-codex-image-paste.md`. H, aicc_planning#417:
`2026-11-24-helper-start-settles-after-self-test.md`. A2, aicc_planning#411:
`2026-11-24-remote-machine-step1.md`. C4, aicc_planning#407 and #408:
`2026-11-24-leftover-pick-folders-snap-page.md`. C7, aicc_planning#371:
`2026-11-24-codex-warning-row-readers.md`. C5b, aicc_planning#414:
`2026-11-24-cc-narrow-banner-limits.md`. B1, aicc_planning#412:
`2026-11-24-takeover-kept-agent-session.md`. B1b, aicc_planning#419:
`2026-11-24-takeover-codex-pick-folder.md`. C9, aicc_planning#420:
`2026-11-24-codex-image-with-warning-count.md`. B1c, aicc_planning#423:
`2026-11-24-takeover-hidden-tab-keeps-session.md`. B1d:
`2026-11-24-takeover-hidden-tab-serves-tools.md`. C10, aicc_planning#421 and
#422: `2026-11-24-terminal-live-button-and-line-selection.md`. B1e:
`2026-11-24-takeover-hidden-tab-hooks-status.md`. B1f:
`2026-11-24-takeover-update-handover-hooks.md`. C11, aicc_planning#424:
`2026-11-24-terminal-partial-selection-keep.md`. C3 and C8 have no fragment of
their own; their lines follow.

**C3 (aicc_planning#406).** snap-e2e D12 measured the Snap menu in 6 of 6
pictures with the page's CPU slowed 20x on beta.16's code (run 45349991502).
Rectangle now waits two animation frames after closing its menu before asking
for the capture (ScreenshotButton.tsx afterTwoFrames; a hidden page asks at
once). D12 stays as a guard with a built-in control (run 45351129782: 0 of 12
slowed, control 6 of 6).

**C8 (aicc_planning#416).** Codex 0.157.1 shows a catalogue model by its
display name (GPT-5.5), so the renderer's footer match, case-sensitive against
the session's models, refused Compact, the model pill, Plan mode and the Alt+V
line; footerRe now matches the listed models in either case; main's readers
were never affected.

**Decided at launch, recorded in ADR-030.** Remote step 1 runs each session on
one `ssh -T` exec through the helper's `bridge` mode, not the two ssh
connections the shape agreed on 2026-11-14 named: one code path with local
sessions, and no console on Windows between the app and the remote terminal.
ADR-030 has it as protocol change 16 and in component row 3; helper-protocol.md
section 4 has the `bridge` row, with `serve` and `attach` superseded in step 1.

**The release commit.** Version 2.1.3-beta.17 and its changelog entry (dated
2026-11-25, CHANGELOG.md regenerated). The surface sweep: app-knowledge (the
broadcast chooser in the sessions and shortcuts sections; Codex's own paste in
the Snap and Alt+V paragraphs; the canvas verdict known issue's two sentences
from C1; the Machines page's Linux machines, the remote preview and its two
known issues; the take-over in the Machines section; the Codex warning-count
known issue removed, since C7's readers take the count and Compact with the
count was measured sent); tips (the chooser, Codex's Alt+V, the remote
preview); the Feature Guide (Machines, Settings, Tips and Shortcuts and Snap
cards); README (command buttons, Snap, Machines). ADR-030: protocol change 16
and row 3, remote step 1 (Probes, S24 and S25), C7's misread count, S16 steps 5
and 6 with B1b to B1f, C6's reading. helper-protocol.md: sections 1, 2 and 4
for step 1, the hook let-go at an update, the keeper of a hidden tab. The
threat model: the remote manifest, remote step 1, the bridge's sockets, the
served Codex token. The probes README: C6 and C7. The `pty-manager.ts` cap goes
down to 7,741, the file's length.

**Limits named, not known bugs.** The holder's hook queue (256 events or 2 MiB,
the oldest dropped first) now holds only what a session makes from the old
app's exit until 3 s after Resume. A Codex session's hook events made from the
old app's let-go until the next run writes its hook file again are lost (the
forwarder posts once; P20 (a)); moving Codex onto the helper's hook path closes
it (S16 item 4's later S12 step, proposed for beta.18). The first update into
2.1.3-beta.17 still has the Claude Code let-go window, because the old app lets
go. C11's five limits each clear a selection or keep less of it, never select
other text.

**Not measured, carried to the release smoke or beta.18.** Snap into a Codex
tab with the warning count (no desktop over SSH), so app-knowledge names only
Alt+V for that case. A Codex footer of 0.170.0 or later on a model whose
display name has a space. The status line through the helper (P1) and password
hosts (P2). A selection after a trim in a full scrollback on the WebGL renderer.

ADR-009 passes are owed before stable for A1, A2, B1 to B1f, C1, C2, C4, C6,
C7, C8 and C9, and for the CI-answering commits cffd828e, 6ffb59cb and
00259a9e and the join fix b2909a52, on the aicc_planning #320 list.
