# ADR-032: Images reach every CLI through its own clipboard paste

- Status: Accepted (owner approval of the 2.1.3-beta.21 plan on the Agent
  Canvas, 2026-11-28, phase 1; nubbymong/aicc_planning#447). The probes below
  can still reshape the slice each one gates; none can bring a file path
  back.
- Date: 2026-11-28
- Supersedes in ADR-030: D5 for images (text paste is unchanged); the delivery
  named in component row 8; the image half of D6; the Target column of the
  parity rows "Image paste" and "Snap"; the second sentence of declared
  exception 6; probe P4; the image clause of row 14; ADR-029 decision 7 as
  ADR-030 amended it (`:62-64`); declared exceptions 2 and 3 (reopened); Q7
  (answered). Amends declared exception 13 and the "Unchanged" line at `:71`.
  The Vision screenshots row (`:246`) and ADR-030's parked Q6 (`:1054`) are
  not changed. See "What this changes in ADR-030".
- Row 12 (`:90`): vision screenshots keep ADR-030's target, not row 8's paste
  route.
- Related: ADR-008 (the terminal's copy and paste keys), ADR-009 (adversarial
  review), ADR-030 (one session helper on every machine), ADR-031 (a review's
  argv)

## Context

At 2.1.3-beta.20 (origin/beta 49a8ddb9) every picture the app delivers goes in
as a file path:

- Alt+V with the focus outside the terminal: the renderer's bubble listener
  (`src/renderer/hooks/useKeyboardShortcuts.ts:142-215`) asks main to save the
  clipboard picture (`src/main/ipc/clipboard-handlers.ts:69-94`) as a JPEG in
  `<resources>/screenshots/`. Main then pastes the path: a bracketed paste of
  it into Claude Code (`src/main/providers/claude/run-screen.ts:129`), or into
  Codex's composer (`src/main/providers/codex/session-screen.ts:452`), and what
  Codex does not take is typed back as "sentence path"
  (`src/renderer/lib/codexComposer.ts:351-366`). What main does not take for
  Claude Code is typed as "sentence path" and Enter by the 'enter' image line
  (`src/renderer/utils/imageTransfer.ts:108-112`, `composeLocalPathPrompt`
  `:74-80`). A plain terminal or a local partner shell gets the quoted path
  typed (`src/renderer/hooks/useKeyboardShortcuts.ts:159-199`:
  `typeImagePathIntoShell` at `:178` and `:194`; `imageTransfer.ts:258-262`,
  `composeShellImagePath` `:238-240`). An SSH tab gets a prompt asking Claude Code to call
  `fetch_host_screenshot` (`src/renderer/utils/imageTransfer.ts:60-67`,
  `:176-191`).
- Snap's two items, Rectangle
  (`src/renderer/components/ScreenshotButton.tsx:74-91`) and Window (`:93-104`,
  offered at `:144-153`), send their saved file down the same routes.
- Alt+V with the terminal focused: `isPasteChord`
  (`src/renderer/utils/terminalInput.ts:164-176`) leaves Alt out, so xterm
  sends ESC v and the CLI reads the clipboard itself. Ctrl+V, Cmd+V and
  Shift+Insert belong to ADR-008's capture-phase handler
  (`src/renderer/components/terminal/terminalKeybindings.ts:55-107`), which
  pastes text only: a clipboard holding only a picture gets "nothing to paste".

The path route fails under load. In one CI job (run 46084512071, 4 CPUs) the
beta.20 Snap test C2 passed 2 of 2 with no busy process and 0 of 2 with three,
and every failure read "the composer held 106 characters of the path, as text".
Codex on Windows tells a paste from typing only by key timing (8 ms between
characters, a 60 ms idle flush; `paste_burst.rs`, rust-v0.157.1). beta.20
shipped with a known issue for it (`src/shared/app-knowledge.ts:243`).

Both CLIs already have a clipboard image paste that does not depend on timing:
one key event, after which the CLI reads the clipboard itself. Codex binds
Ctrl+V and Alt+V to `paste_image_to_temp_png` (`chatwidget/interaction.rs`
133-158). Claude Code binds `chat:imagePaste`, Alt+V on Windows and WSL and
Ctrl+V elsewhere (2.1.332).

The owner, 2026-11-28 about 01:00Z: "We should be using clipboard paste - i hate
the file path option across all options. The idea is we should be using the
helper to inject into clipboard for paste on remote machines." and "this is true
for claude as well". About 04:00Z: "this is all part of the simplification it is
all 2.1.3", which brings Codex over SSH, remote canvas files and Windows hosts
into 2.1.3.

## Decision

1. **Every picture goes in through the CLI's own clipboard image paste.** Image
   paste and Snap reach Claude Code and Codex, on this computer and on remote
   machines, as that CLI's own paste. A typed or inserted file path is not an
   acceptable end state anywhere.
2. **Who writes the clipboard: the app on this computer, the helper on a remote
   machine.**
   - On this computer, Electron main writes the picture only when the clipboard
     does not already hold what the CLI reads: for Snap, and for a copied image
     file when the CLI does not read copied files itself. When the clipboard
     already holds a picture, nothing is written.
   - On a remote machine, the helper serves the CLI's read: on Linux a
     short-lived stand-in mode the CLI runs as `xclip` or `wl-paste` (Claude
     Code), or the holder's private data-control socket (Codex, after PR2); on
     Windows and macOS hosts the holder writes that machine's clipboard. The
     picture reaches the holder first by `file.put`.
3. **The key.** The app sends the CLI's own paste key as one PTY write, never
   inside a bracketed paste, from the provider package's table below. It then
   reads the CLI's `[Image #N]` placeholder on the session's screen. For a press
   made outside the terminal, and for Snap, it then types the sentence and
   presses Enter, as today. For Alt+V pressed in the terminal it types nothing
   more: the user is writing.
4. **Which keys the app takes.** In a Claude Code or Codex session the app takes
   Alt+V wherever the focus is, in a session on this computer or a helper tab,
   except while the session's partner shell is on screen
   (`src/renderer/hooks/useKeyboardShortcuts.ts:150`): there Alt+V goes to the
   partner shell as a key, and nothing is sent to the CLI. In those sessions (not the partner view) it also takes Ctrl+V (Cmd+V on a Mac) when the clipboard holds only a
   picture. On a tab on the old SSH path a focused Alt+V stays xterm's, as
   today; only a press from outside the terminal gets the fetch request
   (decision 9), and Ctrl+V with only a picture says nothing to paste. Text
   paste is unchanged (ADR-008). In a plain
   terminal or a partner shell, Alt+V goes to the program there as a key (a CLI
   started there by hand reads the clipboard itself), and no path is typed.
5. **After Snap the picture stays on this computer's clipboard**, as a Snipping
   Tool picture does, whichever machine the session runs on. The clipboard's
   earlier content is not saved or restored around a write. The picture is an ordinary clipboard item: no
   transient markers, and Windows clipboard history and cloud sync follow the
   user's own settings.
6. **What a CLI does not take is reported, never typed.** No placeholder within
   the wait, or the CLI's own failure line, puts a note in the session's paste
   hint: the picture is on the clipboard, press Alt+V in the session. No path,
   no take-back.
7. **One owner per job (ADR-030's rows).** Row 8 (Paste and Snap) decides
   whether a press is an image paste and what must be written. Row 14 (the
   provider packages) holds each CLI's key, formats and copied-file rule per OS.
   Row 3 (the session client) sends the key through one door. Row 4 (the helper)
   holds a host's paste folder and serves or writes that host's clipboard,
   deciding nothing. Row 2 (the renderer) reports the key.
8. **`file.put` is built for remote sessions only.** It carries the picture to
   the holder's per-session paste folder. No pasted or Snapped picture goes
   through a paste folder on this computer; vision screenshots keep ADR-030's
   target (`:246`, ADR-030's Q6).
9. **Order, by milestone** (beta numbers are planned, and ADR-030 D2 re-cuts
   slices by measured pace). First (planned 2.1.3-beta.21): this computer
   (Windows, macOS and Linux app machines) and Claude Code in a helper tab on a
   Linux host. Codex on Linux hosts comes with Codex remote sessions (planned
   2.1.3-beta.24), after PR2. Image paste on macOS hosts comes with macOS hosts
   (planned 2.1.3-beta.26), after PR5; on Windows hosts, with Windows hosts
   (planned 2.1.3-beta.27), after PR4. Until its route lands, image paste into
   a remote Codex session is shown as not available yet. A tab on the old SSH
   path keeps today's tool route (a request naming the saved file for the tool, never its
   path) until the remote deletion (planned 2.1.3-beta.30).

## Each OS and each CLI

The key is what the app writes to the PTY. "Writes the clipboard" names who
puts the picture there, and when.

| Session runs on | CLI | Key the app sends | What the CLI reads | Formats written | Writes the clipboard |
|---|---|---|---|---|---|
| This computer, Windows | Claude Code | ESC v (`1B 76`, Alt+V), unless the account's keybindings file rebinds `chat:imagePaste` | `powershell -NoProfile -NonInteractive -Sta`, WinForms `Clipboard.GetImage()`, saved as PNG; a copied file list is not read | CF_DIB and the registered `PNG` format | The app (Electron main), for Snap and for a copied image file |
| This computer, Windows | Codex | ESC v (proven by P3.15, c11fb360) | arboard 3.6.1: a copied file list first, then `PNG`, then CF_DIBV5 (synthesised from CF_DIB) | CF_DIB and `PNG` | The app, for Snap only; Codex reads a copied file itself |
| This computer, macOS | Claude Code | Ctrl+V (`16`) | `osascript`: the clipboard as `«class PNGf»` | `public.png` and `public.tiff` | The app, for Snap and for a copied image file |
| This computer, macOS | Codex | Ctrl+V (`16`) | arboard: `NSPasteboardTypeTIFF`, and file URLs | `public.tiff` and `public.png` | The app, for Snap only |
| This computer, Linux | Claude Code | Ctrl+V (`16`) | `wl-paste --list-types` when `WAYLAND_DISPLAY` is set, else `xclip -selection clipboard -o -t TARGETS`; then the first of image/png, jpeg, jpg, webp, gif, bmp | `image/png` | The app, for Snap. A copied image file is not read on Linux (`src/main/clipboard-file.ts:138`, `:142`), as today. With neither tool installed the hint names them |
| This computer, Linux | Codex | Ctrl+V (`16`) | arboard: Wayland data-control, else X11 `image/png` | `image/png` | The app, for Snap only |
| Linux host, helper tab | Claude Code | Ctrl+V (`16`), unless `keybindings.json` in the config folder that tab's Claude Code uses rebinds `chat:imagePaste` (`<configDir>` when the launch sets `CLAUDE_CONFIG_DIR`, `src/main/providers/claude/remote-launch.ts:78`, else `~/.claude`; read through a new host read beside `CLAUDE_HOST_READS`, `:93`; a `configDir` outside the home folder: Ctrl+V, as when there is no file) | `xclip` or `wl-paste` found first on `PATH`: the helper's stand-in, reached through a two-line fixed sh script under each name in the session's `bin/` folder that execs the helper by absolute path with `--store` and `--session` | The picture's own type (`image/png` or `image/jpeg`), from the session's `paste/` folder | The helper, from `file.put`'s file; no host clipboard is touched (2.1.3-beta.21) |
| Linux host, helper tab | Codex | Ctrl+V (`16`) | arboard, Wayland first: `WAYLAND_DISPLAY` names the holder's private data-control socket in the session folder (R4) | `image/png` | The helper (2.1.3-beta.24, after PR2) |
| Windows host | Claude Code and Codex | ESC v | As on this computer, inside the OpenSSH logon's window station | CF_DIB and `PNG` | The holder, from a message-only window (R1; 2.1.3-beta.27, after PR4) |
| macOS host | Claude Code and Codex | Ctrl+V (`16`) | As on this computer | `public.png` and `public.tiff` | The holder (R6; 2.1.3-beta.26, after PR5; ties to aicc_planning#449) |

The Claude package reads `chat:imagePaste` from `keybindings.json` in the
account's own config folder (`CLAUDE_CONFIG_DIR`) and sends that chord's
bytes. For a helper tab it reads `keybindings.json` in the config folder the
tab's Claude Code uses on the host: `<configDir>` when the launch sets
`CLAUDE_CONFIG_DIR` (`remote-launch.ts:78`), else `~/.claude`, through a new
host read beside `CLAUDE_HOST_READS` (`:93`); else Ctrl+V. A binding the app cannot express as bytes
gets the hint "press Claude Code's image paste key". The app never pins the
binding, because that would override the user's choice (PK1).

## Rejected options

- **Insert the path (ADR-030 D5).** Codex on Windows reads a pasted path as
  typing when the computer is busy (C2, above), and the owner rejected the path
  route everywhere.
- **Save the user's clipboard and restore it after a write.** A restore is a
  copy, not the original. Reading every format forces the source program's
  delayed rendering, which is slow and can block. GDI handles, owner-display and
  promised formats cannot be saved byte for byte. Restoring takes ownership from
  the source program, so live links (Office's, for example) are lost. Electron
  exposes no clipboard sequence number to guard the restore. Leaving the picture
  on the clipboard, as Snipping Tool does, removes the race altogether.
- **The holder writes this computer's clipboard (a Rust Win32 writer, about 300
  lines).** Not taken for this computer: Electron main writes it with no new
  Rust code and no new crate. It stays as the fallback if PW2 finds Electron
  44's `clipboard.write` cannot write the formats above.
- **OSC 52 or OSC 5522 through the terminal.** Neither CLI reads an image that
  way. Claude Code closed anthropics/claude-code#42712 as not planned
  (2026-04-02), and Codex uses OSC 52 only to copy out. The app's xterm has no
  OSC 52 handler, and the threat model forbids one for a remote terminal
  (`docs/remote/helper-threat-model.md:207-209`).
- **Xvfb or Xwayland on the host, with the helper as the X11 selection owner.**
  RHEL 10 and Rocky 10 ship no X.org server, and the EPEL 10 request was closed
  NOTABUG. It needs packages on every host, against the no-installs direction,
  and a `DISPLAY` makes the agent's GUI programs open on an invisible screen.
- **A private X11 server in the helper (R3, about 1,200 to 2,000 lines).** Not
  taken. It is kept only as the fallback if PR2 shows Codex cannot paste from
  the Wayland stand-in.
- **Keep the pasted path for Codex on Unix hosts until the stand-in lands
  (X2).** A bracketed paste arrives there as one event, so timing would not
  bite. Rejected by the owner's words: "i hate the file path option across all
  options".
- **Install xclip or wl-clipboard on hosts.** Against the no-installs
  direction, and neither serves anything on a host with no display.

## What this changes in ADR-030

- **D5 (images).** Superseded by decisions 1 to 6 here. The rest of D5 stands:
  text paste through the holder, chunked on whole characters; the paste folder
  capped and deleted at session end (now on hosts only); the shared screenshots
  library going away (declared exception 13 keeps it until the remote deletion);
  other file kinds and drag and drop not in 2.1.3.
- **D6.** "Image paste into plain and partner terminals" becomes: Alt+V reaches
  the program in a plain or partner terminal as a key, and no path is typed.
- **Row 8 (Paste and Snap).** "Delivery by `file.put` to the session's holder,
  then asking row 3 to insert the returned path" becomes "delivery through the
  CLI's own clipboard paste: on this computer the app writes the picture only
  when the clipboard does not already hold what the CLI reads, then asks row 3
  to send the CLI's paste key; for a remote session it sends the picture to the
  holder by `file.put`, and the holder serves the CLI's clipboard read".
- **Row 4 (helper).** Gains: serving its session's clipboard read on a host (the
  stand-in on Linux; writing the clipboard on Windows and macOS hosts). It still
  makes no decision.
- **Row 14 (provider packages).** "Whether that CLI attaches an inserted image
  path like its own paste" becomes "that CLI's image paste key per OS (read from
  the CLI's own keybindings where it has them), the image formats its clipboard
  read takes, and whether it reads a copied file itself".
- **"What this changes in ADR-029", the amended decision 7.** Image paste goes
  through the holder's clipboard stand-in or clipboard write, fed by `file.put`;
  no path is inserted.
- **Parity table.** Image paste, Target: "The CLI's own clipboard paste wherever
  the focus is: the app writes the clipboard on this computer, the helper serves
  or writes it on a remote machine; no path anywhere (ADR-032)". Snap, Target:
  "... delivered as the CLI's own clipboard paste; the picture stays on this
  computer's clipboard". Canvas rendering of project files (`:250`):
  "Unchanged (declared exception 3)" becomes "remote canvas files come in
  2.1.3-beta.28 (planned)".
- **Declared exception 6.** "If probe P11 fails for one CLI, that CLI keeps its
  own paste on This computer" is removed: every CLI uses its own paste.
- **Declared exception 13** (`:361-362`). "Helper sessions never write to it"
  becomes "Helper sessions never read it; Snap saves its picture there for
  every session until the remote deletion, for the C2 proof and the tool
  route."
- **Row 12** (`:90`). Vision screenshots keep ADR-030's target (`:246`), not
  row 8's paste route.
- **`:71`** ("Unchanged. Codex over SSH stays in the feature queue.") amended:
  Codex over SSH is in 2.1.3 (ADR-032, owner 28 Nov).
- **Probes.** P4 (a CLI on a host attaches an inserted path) is withdrawn and
  replaced by PR1. P11's result stays as a record and gates nothing.
- **Protocol change 7** (`file.put` on This computer) is not needed for paste.
- **ADR-030's Q7** (`:1058`). Answered by the owner on 2026-11-28 ("it is all
  2.1.3"): Codex on remote machines is in 2.1.3. Declared exceptions 2 and 3 are reopened; their
  builds come in their own betas.

## Consequences

- C2's failure goes away by construction: the CLI gets one key event, and no
  characters of a path are timed.
- No file path is typed into any session on any path that remains at stable.
  Alt+V of a picture already on the clipboard saves no file, except for a tab
  on the old SSH path (decision 9). Snap still
  saves its file in the shared screenshots folder, for the C2 proof and the
  tool route (declared exception 13 as amended above).
- The user's clipboard holds the Snap picture afterwards. A user who copies
  text between the write and the CLI's read gets the hint; one who copies
  another picture has that picture sent (a window of about 0.3 to a few
  seconds).
- A copied image file is replaced on the clipboard by its picture (Alt+V with
  a copied file in a Claude Code session).
- Claude Code's clipboard read on Windows spawns PowerShell, which is slow under
  load. The placeholder wait is probe PW1's worst case at 3 busy processes
  times 2, at most 10 s, fixed in code before the gate job is dispatched.
- Claude Code's placeholder is read from the holder's screen for a held session.
  For a session still on the old local path it is read from the session's
  terminal view, as canvas markers are today. That read goes with the local
  deletion (2.1.3-beta.25).
- The app depends on each CLI's paste key, and on Claude Code shelling out to
  `xclip` and `wl-paste` by name. The provider packages own those facts.
  remote-helper-e2e (a dispatch, `ci.yml:1604`) checks the stand-in read
  against Claude Code 2.1.332, installed into that job by this change. The
  Helper job (`ci.yml:1805`) runs the stand-in's Rust tests on every helper
  change.
- On a host, any process of the session's user can read the current picture by
  running `xclip` in that session, as the agent can on a desktop. The picture
  stays in the session folder until the next picture or the session's end.
- Code deleted once nothing uses it: the bracketed path paste of both CLIs,
  Codex's Ctrl+U take-back, the typed "sentence path" lines of both CLIs
  (Codex's composer line and Claude Code's 'enter' line), and the plain
  terminal's typed path. They stay for one beta behind a test switch that only
  an unpackaged run reads, so the proof can run both routes in one job, and go
  in 2.1.3-beta.22.

## Probes and their fallbacks

Each runs before the build it gates. The decision lines are fixed before
measuring and written into each probe's header.

| Probe | Question | Gates | Runs | If it fails |
|---|---|---|---|---|
| PW1 | On the GitHub Windows runner, with Codex 0.157.1 under the bundled ConPTY and Claude Code 2.1.332 against P11's model stand-in: after Electron writes the picture, do ESC v and Ctrl+V give `[Image #N]` and a turn carrying the same picture (by decoded pixels), and how long does the placeholder take, at 0 to 3 busy processes? | The local route on Windows, and the placeholder waits | beta.21, phase 2 | The waits are the measured worst case at 3 busy processes times 2, at most 10 s. A CLI still red at 3 busy processes is diagnosed and the owner is told before the beta is cut; the path does not come back |
| PW2 | Does one Electron 44 `clipboard.write()` call with one item holding `image/png` (the W3C-shaped API whose read the app already uses, `src/main/clipboard-image.ts:10-11`) put CF_DIB and the registered `PNG` format on the Windows clipboard together, and do both CLIs read the result? | The local writer on Windows | beta.21, phase 2 | CF_DIB alone (both readers take it); if Electron cannot write a picture at all, a short-lived helper mode writes it (the rejected Rust writer, taken as the fallback) |
| PW3 | A PNG copied in File Explorer, then Alt+V: does Codex attach it and Claude Code not? | Whether a copied file is written as a picture for Claude Code | beta.21, phase 2 | If Claude Code reads the file itself, nothing is written for it either |
| PK1 | On the VM, in a test account with `chat:imagePaste` rebound in its keybindings file: does the Claude package read the binding and send the right bytes? | The Claude Code key on every OS | beta.21, phase 2 | A binding it cannot read or express gets the hint to press Claude Code's own key |
| PM1 | On the GitHub macOS runner: after the app's write, does `osascript -e 'clipboard info'` list PNGf and TIFF, and do both CLIs attach with Ctrl+V? | The macOS writer | beta.21, phase 3 | TIFF added by `osascript` with `sips`; the privacy prompt (Paste from Other Apps) is checked on a real Mac in 2.1.3-beta.23 with aicc_planning#448 |
| PM2 | On macOS today, do Ctrl+V and Option+V with the terminal focused give Claude Code and Codex a picture? | Confirms the suspected dead Claude Code paste there | beta.21, phase 3 | Recorded either way; the new route replaces it |
| PL1 | On the GitHub Ubuntu runner under X11: after the app writes `image/png`, do Claude Code (with xclip, with wl-paste, with neither) and Codex attach? | The Linux writer | beta.21, phase 3 | If a CLI does not attach under X11, Snap on Linux app machines says 'Snap into a session is not available on this computer in this beta', with no path; `app-knowledge.ts` gets a known issue, and the owner is told. Alt+V with a picture already there is unaffected. Wayland is not measured in CI and is recorded as not measured; Linux Snap stays experimental (declared exception 7) |
| PH1 | Does `file.put` store a picture in the holder's `paste/` folder with its hash, refuse over the caps, remove a partial file on a timeout and remove the folder at session end? | Every remote route | beta.21, phase 4 | It is fixed until it does; no remote route ships without it |
| PR1 | On Rocky Linux 10 (x86-64, read-only check first: `dnf list --available xclip wl-clipboard xorg-x11-server-Xvfb xwayland-run`), in a held Claude Code session with a throwaway `xclip` script first on `PATH` after the login shell's rc files: does Claude Code show `[Image #1]` and carry the picture? | The Claude Code stand-in on Linux hosts | beta.21, phase 5 | If Claude Code does not consult the stand-in, `WAYLAND_DISPLAY` is set to a session-folder path so it asks `wl-paste` first; if neither, image paste into a Claude Code helper tab shows as not available yet, as for a remote Codex session (decision 9), and the owner is told |
| PR3 | On the Raspberry Pi 5 (arm64): what are `XDG_SESSION_TYPE` and `/run/user/<uid>/wayland-*`, and does the session's stand-in leave a desktop session untouched? | The same, on a host with a desktop | beta.21, phase 5 | Recorded; the stand-in is per session and on `PATH` only, so a desktop does not change it |
| PR4 | On the Windows test VM over OpenSSH: in one connection, does a process with a message-only window write CF_DIB and PNG, does a child `powershell -Sta` read it with `GetImage()`, is the console user's clipboard unchanged, and does a holder started in one connection still serve its CLI after a disconnect? | Windows hosts (R1) | Recorded in beta.21 (cheap); the build is 2.1.3-beta.27 | Windows hosts show image paste as not available yet, and the owner is told before Windows hosts become a default |
| PR2 | On Ubuntu in CI, then on Rocky and the Pi with only the helper binary: does arboard 3.6.1 in Codex 0.157.1 start on a private data-control socket with no `wl_compositor`, and does Ctrl+V attach the picture? | Codex on Linux hosts (R4) | 2.1.3-beta.24, with Codex remote sessions | The private X11 server (R3); if that fails too, image paste into a remote Codex session stays not available and the owner is told |
| PR5 | On a Mac over SSH, with and without a desktop login: can `osascript` and NSPasteboard read and write the pasteboard, and does a prompt show on the Mac's screen? | macOS hosts (R6) | 2.1.3-beta.26 | Image paste on a macOS host needs a desktop login and a one-time prompt accepted at the Mac (aicc_planning#449), or shows as not available yet |

## Security notes for the pre-stable ADR-009 round

Betas skip the pass (owner rule, 2026-11-15). These are owed before stable and
go on aicc_planning#320.

- **The paste key IPC.** One new renderer-to-main channel carries "the paste key
  was pressed in session S, focused or not". It carries no clipboard content and
  no path. Main reads the clipboard itself, and Snap's capture in main hands its
  picture to the paste module itself, so the renderer sends no path (today it
  gets one back, `src/renderer/components/ScreenshotButton.tsx:81-83`). The
  attack lens: a renderer that
  forges presses for a session it does not show. The old image branch of
  `PTY_SUBMIT_PROMPT` stays for this beta, refused in main unless unpackaged
  with the switch.
- **Writing the user's clipboard.** Only on the user's own Snap, or on Alt+V
  with a copied image file. The picture stays as an ordinary item, so Windows
  clipboard history and cloud sync follow the user's own settings, as Snipping
  Tool's does. A Snap can hold secrets that were on screen: the round judges
  whether to mark Snap pictures `CanUploadToCloudClipboard = 0`.
- **The key into a PTY.** The bytes come from the provider table: ESC v or
  `16`, or the chord the account's own binding names. For a helper tab that
  binding is read from the host's file and mapped through a fixed
  chord-to-bytes table, so a host picks at most a chord from that table, never
  raw bytes. Never from a page. They are one
  raw write, never inside a bracketed paste, so a CLI cannot be made to read
  them as text.
- **A picture from this computer to a host.** New threat-model row beside
  `docs/remote/helper-threat-model.md:207-209`: on the user's key press or Snap
  only, a picture only (never text), to the one session on screen. The line at
  `:207-208` is amended to "for a remote terminal the app neither reads nor
  writes the local clipboard in answer to anything the host sends (no OSC 52);
  the user's own Alt+V or Snap is ADR-032's row".
- **`file.put`.** Names from a fixed pattern (`paste-<n>.png` or `.jpg`) and
  only into `sessions/<sid>/paste/` (folder 0700, files 0600). 20 MiB each and
  100 MiB per session. The hash is checked, a partial file is removed, and the
  folder goes at session end. A host never names a local path. Threat model
  3.6 (`docs/remote/helper-threat-model.md:359-366`, at `:330-335` before this ADR) is amended: the reply
  carries the hash only and nothing is pasted.
- **The stand-in.** It is reached through a two-line fixed sh script per name
  in `sessions/<sid>/bin/` (folder 0700, each script 0700, not the 0600 of the
  other session files, `docs/remote/helper-protocol.md:47`) that execs the
  helper by absolute path with
  `--store` and `--session`, so it serves only the session that script names.
  It answers only the argv shapes Claude Code sends for a list and a read, only
  with the current picture from its own session's `paste/`, and only an image
  type. It reads no other file, and a read naming another session is refused.
  Anything else goes to the real tool by the absolute path recorded at launch,
  never through `PATH`, or exits non-zero. The `PATH` change is core's:
  `remoteLaunchSpec` (`src/main/remote-helper/session.ts:177-188`) puts
  `sessions/<sid>/bin` first on `PATH` inside the `-c` wrapper text, after the
  rc files, when the Claude package's remote launch asks for the stand-in (a
  new `RemoteLaunch` field, not an env var, since a provider's env may not set
  `PATH`, `:183-186`). For a login shell outside the sh family (no wrapper,
  `:178`), the folder is put in front of `hostAccountEnv`'s `PATH` (`:139`),
  where no rc file runs. Any process of the session's user on that host can
  read the current picture: the same user, the same trust as the session.
- **Later hosts.** The Wayland stand-in (2.1.3-beta.24) adds a socket in the
  session folder and must serve or ignore clipboard sets. The Windows host write
  (2.1.3-beta.27) must not reach the console user's clipboard (PR4 measures
  that). The macOS host write (2.1.3-beta.26) overwrites the remote user's
  pasteboard when a desktop login exists, and can raise a prompt where nobody
  sees it.
