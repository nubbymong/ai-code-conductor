/**
 * Snap on Windows, end to end on the GitHub runner's own desktop (plan
 * 2.1.3-beta.16, section A1; aicc_planning#401). Run ONLY by the snap-e2e job
 * in ci.yml (a dispatch), with `--retries=0 --workers=1`: never on the test
 * machine, never on a developer's PC (it presses Snap on the real screen).
 * Without SNAP_E2E_HELPER every test here is skipped, so a full Playwright run
 * leaves Snap unpressed; in the job a run that skipped everything fails its
 * next step.
 *
 * One app (launchIsolatedApp: every per-user folder in its own temp folder),
 * one Claude Code tab on a stand-in `claude` (the Snap button shows on agent
 * tabs only, session-capabilities.ts canSendImageToAgent; the runner has no
 * Claude Code) that keeps what it is typed in typed.txt, the built helper given
 * through the test-only helper path (CCC_E2E_SNAP_HELPER, from
 * SNAP_E2E_HELPER), and the new Snap chosen (magic-buttons.json,
 * snapEngineWindows: 'new').
 *
 * DECISION LINES, fixed before the run (A1 with the overlay, section A2,
 * merged). "The display" is the one holding the app's window; the rectangle is
 * drawn over the app's window there, so its picture is the app, never a black
 * wallpaper.
 *   D1 START: the app starts and one Claude Code tab shows the Snap button;
 *      the tab runs the stand-in on a terminal (its start recorded with a
 *      terminal for input, its ready line on screen).
 *   D2 RECTANGLE, 3 runs: Snap, Rectangle opens one overlay page per Electron
 *      display, each with its picture; a 200 by 120 DIP drag shows its size in
 *      the display's pixels, and Enter gives one new JPEG of that size (200 and
 *      120 times the display's scale), not all black; since 2.1.3-beta.21
 *      (ADR-032) the picture goes onto the clipboard at that size and the
 *      CLI's own paste key (ESC v) reaches the tab as one write, then the
 *      sentence and Enter, and no path is typed (the run ends once that Enter
 *      is typed); one line names a rectangle of that size, the
 *      helper's time
 *      (within the 2 s bound) and one entry per display at its physical size
 *      and scale; no overlay page is left, the button is usable again, and no
 *      press folder is left. Run 1 keeps a picture of the overlay mid-drag
 *      (overlay-mid-drag.png, the runner's desktop only).
 *   D3 WHOLE SCREEN, 3 runs: Whole screen gives one new JPEG of the display at
 *      its physical size (the longer side capped at 1920), not all black; the
 *      picture onto the clipboard and the CLI's own paste key into the tab,
 *      then the sentence and Enter, no path typed (the run ends once that
 *      Enter is typed); one line names the whole screen.
 *   D4 ESCAPE, 3 runs: Escape gives no file and types nothing; one line says
 *      cancelled; no overlay page is left and the button is usable again.
 *   D5 DEFAULT (S8 step 3): with no choice saved (magic-buttons.json without
 *      snapEngineWindows), Snap, Rectangle opens the new Snap's overlay;
 *      Escape; one line says cancelled.
 *   D6 NOT LOADED BY THE NEW SNAP: neither main at start (R1) nor main after
 *      D2 to D5's presses holds a file of the previous Snap's package
 *      (electron-screenshots) or its native add-on (node-screenshots).
 *   D7 FORCED FAILURE, 3 runs: the test-only helper path names a helper that
 *      is not there: the line says the helper could not start (ENOENT), the
 *      previous Snap opens and is cancelled.
 *   D8 PREVIOUS CHOSEN: no new-engine line; one line says the previous engine
 *      loaded and takes the press; the previous Snap opens and is cancelled.
 *   D9 LOADED BY ITS FIRST PRESS: after D7 and D8, main holds the package's
 *      files and its native add-on (R2).
 *   D10 HELPER DIRECT: the built helper's capture, run once from the test, has
 *      each picture's size equal its header and the line, each matched to one
 *      of Electron's displays by physical bounds and scale.
 *   D11 SCALED PICTURE (added at the beta.16 aggregate): in this Electron a
 *      picture made at a scale of 1.5 (createFromBitmap with a scaleFactor, as
 *      windows-engine.ts makes one on a display at 150%) is not empty, toJPEG
 *      gives nothing for it, and toPNG at that scale gives a PNG of the
 *      picture's own size: the two calls of the overlay's fallback (overlay.ts
 *      pictureDataUrl), read in real Electron. No display above 100% is read:
 *      the runner has none, and Chromium's --force-device-scale-factor cannot
 *      stand in for one (run 45304028588: under it Electron listed the 1024 by
 *      768 display as 455 by 341 DIP and 683 by 512 physical, the helper read
 *      1024 by 768, the engine refused the mismatch and the previous Snap took
 *      the press).
 *   D12 MENU OUT OF THE PICTURE (plan 2.1.3-beta.17 C3, aicc_planning#406):
 *      the Snap menu is never in a press's picture. Before each press the
 *      menu's box is read on the app's page, with two pictures of that box
 *      from the page itself (webContents.capturePage): the menu open, and the
 *      menu closed again. The press's picture of the box (Rectangle drawn over
 *      the box, or Whole screen cut at the box) is read pixel by pixel on the
 *      pixels where those two differ (at least MENU_PIXEL_GAP apart): the menu
 *      is seen when most of them are nearer the open one; the box shows the
 *      app when its nearer page picture is closer than half the gap between
 *      the two (each box must). The app's window is kept on top for D12's
 *      presses, as it is when its user clicks its menu. First a control, a
 *      test-only copy of the menu left on screen until the overlay is up (a
 *      menu that has not closed when the picture is taken), the page not
 *      slowed: the menu is seen in all 6 pictures (Rectangle and Whole
 *      screen, 3 runs each), so the check can fail. Then the page's CPU slowed
 *      by CDP (Emulation.setCPUThrottlingRate) at 4x and at 20x, from just
 *      before the Rectangle click until the overlay is up: 3 runs each of
 *      Rectangle and Whole screen at each rate, and the menu is seen in none of
 *      the 12. The slowing itself is read (a fixed loop's time on the page at
 *      rate 1 and at the rate) and is at least half the rate, or the run did
 *      not make its condition. Every box's two pictures differ on at least
 *      MENU_MIN_PIXELS pixels, or the box was not read. One test, so a red
 *      press still leaves every reading; it runs last, so a red one skips
 *      nothing.
 *      Before the fix (run 45349991502 on 60e1b1ae, one 1024x768 display at
 *      100%): the slowing read 4.4x and 25x; the control (then a copy left
 *      300 ms after the click) seen 6 of 6; the menu in 0 of 6 pictures at 4x
 *      and in 6 of 6 at 20x (3 Rectangle, 3 Whole screen), as the press asked
 *      for the capture in the same task that closed the menu. The fix
 *      (ScreenshotButton.tsx afterTwoFrames) asks only after the page has
 *      drawn the close.
 * READINGS (recorded): R1, what main has loaded once the app has started and
 *   its tab runs (before any press): the native add-ons (.node files, from
 *   main's module cache and from the process report) and the files of the
 *   previous Snap's package; R2, the same after the previous Snap's presses
 *   (D7, D8). Before the cutover, with the package imported at main's start
 *   (run 45271463233 on 3e690893): R1 held 36 files of the package and one
 *   native add-on (node-pty's conpty.node); R2 held the same 36 and a second
 *   add-on, node-screenshots, which the package loads at its first capture.
 *   The basic-user capture is the job's step before this one
 *   (scripts/ci/snap-basic-user.mjs).
 *
 * TIMEOUTS, set once from the readings and never raised to answer a red run
 * (rule 27). Skeleton (run 45260050397, one 1024x768 display at 100%): launch
 * 2600 ms, tab 822 ms, the previous Snap's window 783 ms after the press,
 * cancelled in 157 ms, helper 58 ms; A1.1's head (run 45264100584): press to
 * the previous Snap's window 761 to 1050 ms, the helper in the app 66 to
 * 432 ms. Each bound is about ten times its reading. Run 45271463233: the
 * overlay on screen 218 to 378 ms after the press, Enter to the file 32 to
 * 71 ms, the file to its path typed 13 to 63 ms (OVERLAY_MS bounds each), and
 * the stand-in started on the tab's terminal 11.2 s after the tab's Snap
 * button showed, within TAB_MS: under three times that reading, not ten, and
 * not raised. That time was Windows PowerShell's cold start, reaching the tab
 * by two routes (diagnosis runs 46026344825, 46028075097 and 46040073797:
 * main's log, and times written by each Windows PowerShell itself with no
 * command). The first time Windows PowerShell 5.1 runs a cmdlet named bare,
 * it looks through every module on its module path for it, and with no
 * module analysis cache yet, as on the runner, that look took 21.6 to 27.4 s
 * in 46040073797 (the start's calls took 8.4 s on a faster runner,
 * 46026344825). The start's owner-only calls named New-Object bare, and the
 * tab's launch line named Set-Location bare. Route one, the app's: the tab,
 * started on no account, was held for the start's profile steps, which waited
 * for the owner-only check of the home kept ready for the next new account.
 * Route two, the tab's own: its Windows PowerShell began the launch line
 * about 1.1 s after it was written, and the line's Set-Location then waited
 * for that PowerShell's own look (each Windows PowerShell looks on its own:
 * one started 2 s after another ended 2.3 to 2.6 s after it). In
 * 46028075097 and 46040073797 the start's calls ran to their 30 s limit and
 * were asked again, and the stand-in never started within TAB_MS (as in run
 * 46023467484). Since then the ready home is checked after the steps when
 * they make no account (account-profiles.ts startOwnerOnlyCredentialFolders),
 * and the launch line and the owner-only script name each cmdlet with its
 * module (terminal-launch-line.ts PS_SET_LOCATION, owner-only-folders.ts),
 * which makes no look: in 46040073797 the tab's folder change took 36 to
 * 43 ms, the start's calls 2.6 s inside Windows PowerShell (3.3 s as main
 * saw them), and the stand-in started 1.7 to 3.0 s after the Snap button
 * showed, where the bare names left it unstarted after 30 s. Each app here
 * runs with a fresh, empty module analysis cache (PSModuleAnalysisCachePath,
 * coldPowerShellEnv), so every run reads that cold start, whatever an earlier
 * app on the runner left in the runner's own cache. Not raised, and not
 * answered by the fix: the first app of a job is slower than the apps after
 * it. It meets its own cold-disk start and, in most jobs, a burst of
 * disk reads by a runner process outside the app as well (provjobd.exe,
 * about one CPU and 3,000 to 13,000 read operations a second for 8 to 9 s,
 * from 2 to 6 s after the first app's launch, C: 0 to 12% idle). Under the
 * diagnosis's harder condition (thousands of generated modules as well), in
 * 46049854244 the first app's owner-only calls sat at 3 to 9% CPU for about
 * 11 s after their first cmdlet and took 13.6 s as main saw them, past the
 * 5 s the tab waits for the scripts folders, so the tab took the direct
 * claude.cmd line; its PowerShell began that line 7.4 s after it was
 * written, its folder change took 4.4 s, and the stand-in started 17.6 s
 * after the Snap button showed. Run 46046004682 (no times) did the same up
 * to the line, then showed nothing after it within TAB_MS. Without the
 * generated modules, in 46059519266, the first app's owner-only JSON step
 * took 0.6 to 0.8 s before provjobd's burst began, and its folder change
 * 2.1 s as the burst began, against 20 to 60 ms and 36 to 50 ms in the seven
 * apps after it, which all passed D1 in 2.3 to 2.9 s, with or without
 * 24,000 files written just before them. A forced disk burst and a forced
 * cache purge were separated in one job in 46092372556 (diagnosis, 16 apps,
 * alternating): a forced burst (one process at about one CPU, several
 * thousand I/O operations a second for 9 s from 2 s after the launch, mostly
 * writes, where provjobd's are reads) left D1 as it was on a warm file cache
 * (the stand-in 2.0 to 2.6 s after the Snap button, against 1.9 to 2.3 s
 * with no load), and so did the burst with two busy processes (1.7 to
 * 3.4 s); the standby file cache purged before the launch made it 2.9 to
 * 3.2 s. Both together gave the first app's outcome (the direct line, the
 * stand-in 8.2 to 8.7 s after the Snap button showed, against the first
 * app's 8.4 s), though not its timeline: the owner-only calls took 12.1 to
 * 12.4 s, about 11 s of it before Windows PowerShell ran their first line,
 * where the first app spent 4 to 5 s before it and 3.2 to 3.7 s to its first
 * cmdlet. In 46094389002 provjobd ran no burst, and the first app was as
 * slow (8.0 s), C: 0 to 4% idle through its own start; a cold cache, the
 * burst and two busy processes together gave 7.9 to 8.2 s in 3 apps. A
 * fourth, whose burst ended before its app had launched, reads as a cold
 * cache, two busy processes and a system svchost load, and took 6.4 s. The
 * slowest D1 read with the fix in and no generated modules is a first app
 * with no diag lines, the merge candidate 46094264723: the stand-in about
 * 11.8 s after the Snap button, 18 s inside TAB_MS.
 * With X1.2 in (the beta.16 aggregate, run 45304028588 on 5a2f0f41), a
 * picture's sentence follows its paste by 1.5 s and its Enter by 2.2 s, and a
 * picture pressed meanwhile waited behind the one before it: 82 to 1818 ms
 * from the file to its path. Each picture test now ends at its own Enter,
 * within OVERLAY_MS: about four and a half times that 2.2 s, not ten, and not
 * raised.
 * The readings go to the log and to $SNAP_E2E_OUT/readings.json.
 *
 * PART TWO, A CODEX TAB WHILE CODEX SHOWS ITS WARNING COUNT (plan
 * 2.1.3-beta.18, section 7.5; aicc_planning#428). An app of its own, in a
 * serial group of its own, so a red test in part one skips nothing here.
 * Codex 0.157.1, the version the test machine's readings used (probe P19,
 * beta.17 C9), from npm (the job's install, SNAP_E2E_CODEX), first on the
 * app's PATH; one managed Codex account, signed in with a made-up key; its
 * config points Codex at probe P11's model stand-in on a loopback port (the
 * stand-in names every picture a request carries by its SHA-256) and names
 * one tool server that cannot start (probe P19's warning launch), so Codex
 * shows its warning count on the hint row. Everything else Codex might reach
 * goes to a dead proxy.
 *   C1 START: the app finds that Codex (found, 0.157.1); a Codex tab opens on
 *      the account, its first screens answered by the 9.2 rules
 *      (helpers/codex-first-screens.ts); within CODEX_START_MS the tab shows
 *      Codex's composer, its footer and, under it, "1 warning" after the
 *      warning sign, on two reads 300 ms apart; the Snap button shows.
 *   C2 RECTANGLE, 3 runs, and C3 WHOLE SCREEN, 3 runs, each pressed while
 *      Codex is at rest with "1 warning" (two reads 300 ms apart): one new
 *      JPEG at D2's or D3's size, not all black; one new-engine line; since
 *      2.1.3-beta.21 (ADR-032) one line from main saying Codex's clipboard
 *      paste pasted and sent it, and none of its path rule; the picture the
 *      app left on the clipboard at that size, its decoded pixels none of an
 *      earlier press's (kept beside the JPEG as <name>.clipboard.png);
 *      exactly one new request from Codex to the stand-in (the turn), whose
 *      pictures are every picture pressed so far, in order, each once by its
 *      decoded pixels (helper/probes/png-rgba.cjs: Codex re-encodes what it
 *      reads from the clipboard), the newest this press's (Codex sends the
 *      whole conversation with each turn); then
 *      Codex at rest with its count again, and still that one request. Each
 *      run's picture is made to differ from the one before it (PICTURE_STEP:
 *      C2's drag starts 16 DIP further right a run, C3 moves the app's window
 *      16 DIP right a run and back after), so a turn that sent an earlier
 *      press's picture again fails. Without it, run 45582381926 on d886147e
 *      pictured the same screen twice: C2 run 3's picture was C2 run 2's, and
 *      C3 run 2's was C3 run 1's, byte for byte (Codex numbers each message's
 *      image [Image #1], so its screen after each turn is the same).
 * The reading before C2 and C3 were added (rule 34; run 45578961836, Codex
 * 0.157.1, one 1024x768 display at 100%): the tab opened, Codex asked only
 * its hooks review (the project's trust is seeded, and no sandbox menu
 * showed), and its hint row read "1 warning . f2 to view"; the stand-in saw
 * no request before a turn.
 * CODEX_START_MS and CODEX_TURN_MS were set before any reading on the runner
 * (P19's own bound for Codex's ready composer is 60 s, the real-launch
 * spec's 150 s; C6's image rule waits up to 5 s for a ready composer and
 * Codex's placeholder showed within 314 ms), and are not raised. Read since
 * (run 45581252484 on de5d6c9c, all 7 green): Codex at rest with its count
 * 5.4 s after the tab was asked for (5.8 s in run 45580311269), Enter to the
 * file 32 to 94 ms, the file to Codex's turn at the stand-in 1.1 to 1.2 s,
 * the turn to Codex at rest again 0.3 s; the app launches Codex with
 * `-m gpt-6-astra`, and each press made one request, with no tools. The
 * part's readings go to $SNAP_E2E_OUT/codex-readings.json.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFile, spawn, spawnSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'
import { seedCodexAccount, realmDirOf, createCodexConfig, openSession, activeSessionId, terminalRows, answerFirstScreen, ptyWrite } from './helpers/codex-mode'
import { nextFirstScreen, FOOTER, type FirstScreenAnswer } from './helpers/codex-first-screens'
import { pathWithoutCodex } from './helpers/fake-codex'
import { isolatedHomeDir } from './helpers/isolated-env'

/** A Claude Code the app supports (CLAUDE_MIN_MANAGED_CLI_VERSION, as
 *  onboarding-provider-select.spec.ts's stand-in answers). */
const CLAUDE_MIN_MANAGED_CLI_VERSION = '2.1.278'
const OUT = process.env.SNAP_E2E_OUT ?? path.resolve(__dirname, '../../test-results/snap-e2e')
const HELPER = process.env.SNAP_E2E_HELPER ?? ''
const CLI_NAMES = ['claude', 'claude.exe', 'claude.cmd', 'claude.bat', 'claude.ps1']
const LABEL = 'Snap E2E'
const RUNS = 3
/** The drag, in DIP (plan A1: a 200 by 120 DIP drag). */
const DRAG = { width: 200, height: 120 }
/** Today's cap on a Snap picture's longer side (screenshot-capture.ts SCREENSHOT_MAX_DIM). */
const MAX_DIM = 1920

// Bounds (see TIMEOUTS above).
const LAUNCH_MS = 30_000
const TAB_MS = 30_000
const OVERLAY_MS = 10_000
const CANCEL_MS = 5_000
const PRESS_TEST_MS = 30_000
/** The engine's own bound on the helper (helper-capture.ts HELPER_CAPTURE_BOUND_MS). */
const HELPER_BOUND_MS = 2_000

const readings: Record<string, unknown> = {
  pressMs: [] as number[], helperMs: [] as number[], overlayMs: [] as number[], overlayReadyMs: [] as number[],
  enterToFileMs: [] as number[], fileToTypedMs: [] as number[],
}
const push = (key: string, v: number) => { ((readings[key] ??= []) as number[]).push(v) }
/** A reading's name under a prefix (D12's: menuOverlayMs), or the name itself. */
const named = (prefix: string | undefined, key: string) => prefix ? `${prefix}${key[0].toUpperCase()}${key.slice(1)}` : key
let ctx: IsolatedApp | undefined
/** Every line main writes to its console (logInfo writes there too). */
const mainLines: string[] = []

/** A stand-in `claude`: every start is recorded in launches.jsonl beside it
 *  (its arguments, whether its input and output are a terminal, its pid);
 *  `--version` answers the app's floor; on a terminal it says it is ready,
 *  keeps what it is typed in typed.txt beside itself, until its input ends;
 *  any other call ends at once. Since 2.1.3-beta.21 (ADR-032, plan phase 2)
 *  it draws a prompt shaped as Claude Code's (two rules of U+2500 around the
 *  pointer row, a footer two columns in: what src/shared/claude-screen.ts
 *  reads), with what it is typed on the pointer row, and Claude Code's own
 *  paste key (ESC v, or Ctrl+V) adds an "[Image #N]" placeholder there as
 *  Claude Code's does; Enter clears the row. So main's placeholder read sees
 *  the key arrive, then types the sentence and Enter. It reads no clipboard:
 *  a real Claude Code reading the picture is C4's (part three). */
function installStandInClaude(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'stand-in-claude.js'), [
    "const fs = require('fs'), path = require('path')",
    "const record = (o) => fs.appendFileSync(path.join(__dirname, 'launches.jsonl'), JSON.stringify(o) + String.fromCharCode(10))",
    'record({ argv: process.argv.slice(2), stdinTty: !!process.stdin.isTTY, stdoutTty: !!process.stdout.isTTY, pid: process.pid, at: Date.now() })',
    `if (process.argv[2] === '--version') { process.stdout.write('${CLAUDE_MIN_MANAGED_CLI_VERSION} (Claude Code)' + String.fromCharCode(10)); process.exit(0) }`,
    'if (!process.stdin.isTTY) process.exit(0)',
    "const typed = path.join(__dirname, 'typed.txt')",
    "try { process.stdin.setRawMode(true) } catch (e) { record({ rawMode: String(e && e.message) }) }",
    "const C = String.fromCharCode, NL = C(13, 10), RULE = C(0x2500).repeat(40), ESC = C(27)",
    "let prompt = '', images = 0, esc = false",
    "const draw = () => process.stdout.write(ESC + '[2J' + ESC + '[H' + 'stand-in Claude Code ready' + NL + NL + RULE + NL + C(0x276f) + ' ' + prompt + NL + RULE + NL + '  ? for shortcuts' + NL)",
    "const image = () => { images++; prompt += '[Image #' + images + '] ' }",
    "draw()",
    "process.stdin.on('data', (d) => { fs.appendFileSync(typed, d); for (const ch of d.toString('latin1')) { if (esc) { esc = false; if (ch === 'v') image(); else if (ch >= ' ') prompt += ch; continue } if (ch === ESC) { esc = true; continue } if (ch === C(22)) { image(); continue } if (ch === C(13)) { prompt = ''; images = 0; continue } if (ch >= ' ') prompt += ch } draw() })",
    "process.stdin.on('end', () => { record({ end: process.pid, at: Date.now() }); process.exit(0) })",
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'claude.cmd'), ['@ECHO off', `"${process.execPath}" "%~dp0stand-in-claude.js" %*`, ''].join('\r\n'))
  return dir
}
const standInDir = (dataDir: string) => path.join(dataDir, 'stand-in-claude')
/** A fresh, empty module analysis cache for one app and every Windows
 *  PowerShell it starts (Windows PowerShell 5.1 reads and writes the file
 *  PSModuleAnalysisCachePath names): each app meets Windows PowerShell's cold
 *  start, as on a new user profile, whatever an earlier app on the runner
 *  left in the runner's own cache (see TIMEOUTS above). */
function coldPowerShellEnv(dataDir: string): Record<string, string> {
  const dir = path.join(dataDir, 'ps-module-analysis-cache')
  fs.mkdirSync(dir, { recursive: true })
  return { PSModuleAnalysisCachePath: path.join(dir, 'ModuleAnalysisCache') }
}
const typedText = (): string => {
  try { return fs.readFileSync(path.join(standInDir(ctx!.dataDir), 'typed.txt'), 'utf8') } catch { return '' }
}
const launches = (): Array<Record<string, unknown>> => {
  try {
    return fs.readFileSync(path.join(standInDir(ctx!.dataDir), 'launches.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

/** Terminals drawn by xterm's DOM renderer (GPU rendering off, the same two
 *  settings the other e2e helpers seed for a readable terminal), so the tab's
 *  text can be read; gpuDefaultOnMigrated keeps the saved false
 *  (settingsStore.ts). */
function seedDomTerminal(dataDir: string): void {
  const file = path.join(dataDir, 'resources', 'CONFIG', 'settings.json')
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...settings, terminal: { ...(settings.terminal ?? {}), gpuRendering: false }, gpuDefaultOnMigrated: true }, null, 2))
}
/** What the terminal on screen shows (the DOM renderer's rows). */
const terminalText = (page: Page): Promise<string> => page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-terminal-active] .xterm-rows > div'))
    .map((row) => (row.textContent ?? '').replace(new RegExp(String.fromCharCode(0xa0), 'g'), ' ').trimEnd()).join('\n'))

/** PATH without any folder holding a Claude, the given folder first. */
function pathWith(first: string): string {
  const rest = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && !CLI_NAMES.some((n) => {
    try { return fs.existsSync(path.join(d, n)) } catch { return false }
  }))
  return [first, ...rest].join(path.delimiter)
}

function runHelper(args: string[]): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const started = performance.now()
  return new Promise((resolve) => {
    execFile(HELPER, args, { windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? Number((err as { code?: unknown }).code ?? 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr), ms: Math.round(performance.now() - started) })
    })
  })
}

const magicButtons = (dataDir: string) => path.join(dataDir, 'resources', 'CONFIG', 'magic-buttons.json')
const chooseSnap = (dataDir: string, engine: 'new' | 'previous') =>
  fs.writeFileSync(magicButtons(dataDir), JSON.stringify({ screenshotColor: '#00FFFF', autoDeleteDays: null, snapEngineWindows: engine }, null, 2))

/** The screenshots folder (getResourcesDirectory()/screenshots) and its JPEGs. */
const shotsDir = () => path.join(ctx!.dataDir, 'resources', 'screenshots')
const jpegs = (): string[] => {
  try { return fs.readdirSync(shotsDir()).filter((f) => f.toLowerCase().endsWith('.jpg')).sort() } catch { return [] }
}

type Disp = { id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number; physical: { x: number; y: number; width: number; height: number } }
/** Electron's displays, with their physical bounds. */
const electronDisplays = (app: ElectronApplication): Promise<Disp[]> => app.evaluate(({ screen }) => screen.getAllDisplays().map((d) => ({
  id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, physical: screen.dipToScreenRect(null, d.bounds),
})))

/** What main has loaded (R1, R2): the .node files in its module cache and in
 *  the process report (every DLL the process has loaded, however it was
 *  loaded), and the previous Snap's package files in its module cache. A
 *  source main does not offer reads as not read. */
const loadedModules = (app: ElectronApplication) => app.evaluate(() => {
  const cache = (process as unknown as { mainModule?: { constructor?: { _cache?: Record<string, unknown> } } }).mainModule?.constructor?._cache
  const keys = cache ? Object.keys(cache) : null
  let shared: string[] | null = null
  try {
    const reporter = (process as unknown as { report?: { excludeNetwork?: boolean; getReport?: () => unknown } }).report
    // The network part is slow to gather and not needed here.
    try { if (reporter) reporter.excludeNetwork = true } catch { /* an older Node: the report is slower, no more */ }
    const raw = reporter?.getReport?.()
    const report = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { sharedObjects?: unknown } | undefined
    shared = Array.isArray(report?.sharedObjects) ? (report!.sharedObjects as string[]) : null
  } catch { shared = null }
  const pkg = /[\\/]node_modules[\\/]electron-screenshots[\\/]/i
  return {
    cacheRead: keys !== null,
    nativeInCache: keys ? keys.filter((k) => k.toLowerCase().endsWith('.node')) : [],
    packageFilesInCache: keys ? keys.filter((k) => pkg.test(k)) : [],
    reportRead: shared !== null,
    nativeInReport: shared ? shared.filter((s) => s.toLowerCase().endsWith('.node')) : [],
  }
})

/** A saved JPEG as main reads it: its size, and how many pixels are not near black. */
const jpegInfo = (app: ElectronApplication, file: string) => app.evaluate(({ nativeImage }, f) => {
  const img = nativeImage.createFromPath(f)
  const { width, height } = img.getSize()
  const bmp = img.toBitmap()
  let lit = 0
  for (let i = 0; i + 3 < bmp.length; i += 4) if (Math.max(bmp[i], bmp[i + 1], bmp[i + 2]) >= 16) lit++
  return { width, height, empty: img.isEmpty(), lit, pixels: Math.floor(bmp.length / 4) }
}, file)

/** Where we are in each source of main's lines: its console, and its log file
 *  (<data dir>/debug/app.log, debug-logger.ts), in case the console does not
 *  reach the test. */
type Mark = { console: number; fileLines: number }
const appLogLines = (): string[] => {
  try { return fs.readFileSync(path.join(ctx!.dataDir, 'debug', 'app.log'), 'utf8').split(/\r?\n/) } catch { return [] }
}
const mark = (): Mark => ({ console: mainLines.length, fileLines: appLogLines().length })

/** Main's lines that start with `prefix` since `from`: from its console when it
 *  has any, else from the log file (the file's lines carry a time and a level first). */
function linesSince(from: Mark, prefix: string): string[] {
  const fromConsole = mainLines.slice(from.console).filter((l) => l.startsWith(prefix))
  if (fromConsole.length > 0) return fromConsole
  return appLogLines().slice(Math.max(0, from.fileLines - 1)).map((l) => l.slice(Math.max(0, l.indexOf(prefix)))).filter((l) => l.startsWith(prefix))
}
const snapLines = (from: Mark) => linesSince(from, '[snap] new engine:')

/** A line's display list ("display 1 1024x768 at 100% (primary), ...") is one
 *  entry per Electron display, each at that display's physical size and scale. */
async function expectDisplayList(list: string): Promise<void> {
  const logged = list.split(', ').map((s) => /^display (\d+) (\d+)x(\d+) at (\d+)%( \(primary\))?$/.exec(s))
  expect(logged.every(Boolean), list).toBe(true)
  const displays = await electronDisplays(ctx!.app)
  readings.electronDisplays = displays
  expect(logged.length).toBe(displays.length)
  const want = displays.map((d) => `${d.physical.width}x${d.physical.height}@${Math.round(d.scaleFactor * 100)}`).sort()
  expect(logged.map((l) => `${l![2]}x${l![3]}@${l![4]}`).sort()).toEqual(want)
}

/** The overlay's pages now open (src/renderer/snap-overlay.html). */
const overlayPages = (app: ElectronApplication): Page[] => app.windows().filter((p) => {
  try { return !p.isClosed() && p.url().endsWith('/snap-overlay.html') } catch { return false }
})

const snapButton = () => ctx!.page.locator('[data-testid="snap-button"]').first()

/** Press Snap, Rectangle with the new Snap: wait for one overlay page per
 *  display, each with its picture; answer which page is the display holding
 *  the app's window, and where the drag starts there (over the app's window,
 *  below the overlay's bar). D12 passes `menuOpen` (run with the menu open,
 *  just before the Rectangle click), `overlayUp` (run once every overlay page
 *  has its picture) and `prefix` (its readings' names). */
async function pressNew(opts: { menuOpen?: () => Promise<void>; overlayUp?: () => Promise<void>; prefix?: string } = {}): Promise<{ overlay: Page; display: Disp; start: { x: number; y: number }; from: Mark }> {
  const { app, page } = ctx!
  const displays = await electronDisplays(app)
  await expect(snapButton()).toBeEnabled({ timeout: CANCEL_MS })
  const from = mark()
  typedAtPress = typedText().length
  await snapButton().click()
  if (opts.menuOpen) await opts.menuOpen()
  const started = performance.now()
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await expect.poll(() => overlayPages(app).length, { timeout: OVERLAY_MS, intervals: [50] }).toBe(displays.length)
  const pages = overlayPages(app)
  for (const p of pages) await expect(p.locator('body.pictured')).toBeAttached({ timeout: OVERLAY_MS })
  if (opts.overlayUp) await opts.overlayUp()
  push(named(opts.prefix, 'overlayMs'), Math.round(performance.now() - started))
  const ready = linesSince(from, '[snap] overlay pages ready').map((l) => /in (\d+) ms/.exec(l)?.[1]).filter(Boolean)
  if (ready.length) push(named(opts.prefix, 'overlayReadyMs'), Number(ready[0]))

  const main = await (await app.browserWindow(page)).evaluate((w) => w.getBounds())
  const centre = { x: main.x + main.width / 2, y: main.y + main.height / 2 }
  const display = displays.find((d) => centre.x >= d.bounds.x && centre.x < d.bounds.x + d.bounds.width && centre.y >= d.bounds.y && centre.y < d.bounds.y + d.bounds.height) ?? displays[0]
  let overlay: Page | undefined
  for (const p of pages) {
    const b = await (await app.browserWindow(p)).evaluate((w) => w.getBounds())
    if (b.x === display.bounds.x && b.y === display.bounds.y && b.width === display.bounds.width && b.height === display.bounds.height) overlay = p
  }
  expect(overlay, `an overlay page at the bounds of display ${display.id}`).toBeDefined()
  // The app's window on that display, in the display's own DIP.
  const left = Math.max(main.x, display.bounds.x) - display.bounds.x
  const top = Math.max(main.y, display.bounds.y) - display.bounds.y
  const right = Math.min(main.x + main.width, display.bounds.x + display.bounds.width) - display.bounds.x
  const bottom = Math.min(main.y + main.height, display.bounds.y + display.bounds.height) - display.bounds.y
  // Below the bar (16 DIP from the top, about 40 tall) and inside the app's window.
  const start = { x: left + 40, y: Math.max(top + 40, 100) }
  expect(start.x + DRAG.width <= right && start.y + DRAG.height <= bottom, `the drag fits the app's window on the display: ${JSON.stringify({ left, top, right, bottom })}`).toBe(true)
  return { overlay: overlay!, display, start, from }
}

/** An action that answers the overlay. Main closes every overlay page at the
 *  answer, so the action's own end (a key's release, a click's last step) can
 *  find its page gone: an error counts only if the page is still open after. */
async function answer(overlay: Page, action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (err) {
    const until = Date.now() + CANCEL_MS
    while (!overlay.isClosed() && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    if (!overlay.isClosed()) throw err
  }
}

/** After an answer: no overlay page left, the button usable again. */
async function expectOverlayGone(): Promise<void> {
  await expect.poll(() => overlayPages(ctx!.app).length, { timeout: CANCEL_MS, intervals: [50] }).toBe(0)
  await expect(snapButton()).toBeEnabled({ timeout: CANCEL_MS })
}

/** What the tab was typed before the last press (pressNew), for that
 *  press's own keys (ADR-032). */
let typedAtPress = 0
/** Claude Code's paste key on Windows, as the app types it (ADR-032). */
const ESC_V = '\u001bv'

/** The one JPEG a press saved, checked at its size and not all black; since
 *  2.1.3-beta.21 (ADR-032, plan phase 2, 2.1.5) the picture on the clipboard
 *  at that size, and no path typed into the tab: the CLI's own paste key
 *  (ESC v) as one write, then, once the stand-in shows its placeholder, the
 *  sentence and Enter. Answers its name. D12 passes `lit: false` (a box of
 *  the dark menu or of the terminal behind it can be mostly near black) and
 *  `prefix` (its readings' names). */
async function expectSaved(before: string[], answeredAt: number, width: number, height: number, opts: { lit?: boolean; prefix?: string } = {}): Promise<string> {
  await expect.poll(() => jpegs().filter((f) => !before.includes(f)).length, { timeout: OVERLAY_MS, intervals: [50] }).toBe(1)
  push(named(opts.prefix, 'enterToFileMs'), Math.round(performance.now() - answeredAt))
  const savedAt = performance.now()
  const name = jpegs().find((f) => !before.includes(f))!
  const file = path.join(shotsDir(), name)
  const info = await jpegInfo(ctx!.app, file)
  expect(info.empty, name).toBe(false)
  expect({ width: info.width, height: info.height }, name).toEqual({ width, height })
  if (opts.lit !== false) expect(info.lit, `${name}: pixels not near black, of ${info.pixels}`).toBeGreaterThan(info.pixels / 100)
  const sincePress = (): string => typedText().slice(typedAtPress)
  try {
    await expect.poll(sincePress, { timeout: OVERLAY_MS, intervals: [50] }).toContain(ESC_V)
  } catch (err) {
    // What the tab showed and what the stand-in recorded, for the cause.
    readings.atTypedFailure = { terminal: await terminalText(ctx!.page).catch(() => 'unread'), launches: launches(), typed: typedText() }
    throw err
  }
  push(named(opts.prefix, 'fileToTypedMs'), Math.round(performance.now() - savedAt))
  // Since 2.1.3-beta.21 (ADR-032) main types the key in one write, reads the
  // stand-in's placeholder, then types a space and the sentence, then Enter
  // as its own write (session-input pasteFromClipboard). The press is done
  // when that Enter has reached the tab, so the next test reads a tab at rest
  // (D4's "types nothing") and the next picture does not wait behind this
  // one. An event wait inside the unchanged OVERLAY_MS.
  try {
    await expect.poll(() => {
      const t = sincePress()
      const at = t.indexOf(ESC_V)
      return at >= 0 && t.indexOf('\r', at) > at
    }, { timeout: OVERLAY_MS, intervals: [50] }).toBe(true)
  } catch (err) {
    readings.atEnterFailure = { terminal: await terminalText(ctx!.page).catch(() => 'unread'), typed: typedText() }
    throw err
  }
  // No path, and no file name, typed: the key is the only way the picture went in.
  const typed = sincePress()
  expect(typed, 'no path typed into the tab').not.toContain(name)
  expect(typed, 'no path typed into the tab').not.toMatch(/[\\/]screenshots[\\/]/)
  expect(typed.split(ESC_V).length - 1, 'the key, once, as one write').toBe(1)
  // The picture is on this computer's clipboard afterwards (plan Q1), at its size.
  const png = await clipboardPng(ctx!.app)
  expect(png, 'a picture on the clipboard').not.toBeNull()
  expect(pngSize(png!), 'the clipboard picture is the press\'s').toEqual({ width, height })
  return name
}

/** The PNG of the picture on this computer's clipboard (main's Electron 44
 *  clipboard.read, image/png), or null. */
async function clipboardPng(app: ElectronApplication): Promise<Buffer | null> {
  const b64 = await app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    const item = items.find((it) => Array.isArray(it.types) && it.types.includes('image/png'))
    if (!item) return null
    const blob = await item.getType('image/png') as Blob
    return Buffer.from(await blob.arrayBuffer()).toString('base64')
  })
  return typeof b64 === 'string' ? Buffer.from(b64, 'base64') : null
}
/** A PNG's size, from its header. */
const pngSize = (png: Buffer): { width: number; height: number } => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) })

/** Press Snap, Rectangle; wait for the previous Snap's window; cancel it with
 *  the library's own Cancel message; wait until the button is usable again. */
async function pressAndCancelPrevious(): Promise<number> {
  const { app, page } = ctx!
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => w.id))
  const overlayShown = () => app.evaluate(({ BrowserWindow }, shown) =>
    BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && !shown.includes(w.id)), before)
  await expect(snapButton()).toBeEnabled({ timeout: CANCEL_MS })
  await snapButton().click()
  const started = performance.now()
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await expect.poll(overlayShown, { timeout: OVERLAY_MS, intervals: [50] }).toBe(true)
  const ms = Math.round(performance.now() - started)
  // The message the library's own Cancel button sends (electron-screenshots
  // preload: ipcRenderer.send('SCREENSHOTS:cancel')).
  await app.evaluate(({ ipcMain }) => { ipcMain.emit('SCREENSHOTS:cancel') })
  await expect.poll(overlayShown, { timeout: CANCEL_MS, intervals: [50] }).toBe(false)
  await expect(snapButton()).toBeEnabled({ timeout: CANCEL_MS })
  return ms
}

const noPressFolder = () => expect(fs.existsSync(path.join(ctx!.dataDir, 'electron-userdata', 'snap-capture'))).toBe(false)

/** A rectangle's picture size: the engine's crop (bmp.ts pixelRectFor), each
 *  edge rounded at the display's scale. */
const rectangleSize = (at: { x: number; y: number }, size: { width: number; height: number }, scale: number) => ({
  width: Math.round((at.x + size.width) * scale) - Math.round(at.x * scale),
  height: Math.round((at.y + size.height) * scale) - Math.round(at.y * scale),
})

/** The whole screen's picture size: today's cap (screenshot-capture.ts
 *  constrainToMaxDim), the longer side to 1920, the other kept in proportion. */
function wholeScreenSize(display: Disp): { width: number; height: number } {
  const { width: pw, height: ph } = display.physical
  if (Math.max(pw, ph) <= MAX_DIM) return { width: pw, height: ph }
  return pw >= ph ? { width: MAX_DIM, height: Math.round(ph * MAX_DIM / pw) } : { width: Math.round(pw * MAX_DIM / ph), height: MAX_DIM }
}

// D12: the Snap menu is never in a press's picture (aicc_planning#406).

/** A pixel tells D12's two page pictures of the menu's box (open, closed)
 *  apart when its colours differ by at least this much, summed over red, green
 *  and blue: 16 a channel on average, well above a JPEG's noise on flat
 *  colour. */
const MENU_PIXEL_GAP = 48
/** A box whose two page pictures differ on fewer pixels than this is not read. */
const MENU_MIN_PIXELS = 50
/** D12's three parts: the control (the page not slowed, the copy of the
 *  menu), then the page's CPU slowed 4 and 20 times (plan C3). */
const MENU_PARTS = [{ rate: 1, copy: true }, { rate: 4, copy: false }, { rate: 20, copy: false }] as const

type Box = { x: number; y: number; width: number; height: number }
type MenuAnswer = 'rectangle' | 'whole'
/** One D12 press as read. `app`: the box shows the app, its nearer page
 *  picture closer than half the mean gap between the two (run 45348436201's
 *  boxes showed a console window instead: nearer mean 42 to 44 a channel,
 *  gap 18 to 23). `seen`: the menu is in the picture. */
type MenuRead = { label: string; rate: number; copy: boolean; answer: MenuAnswer; box: Box; differing: number; nearerOpen: number; meanToOpen: number; meanToClosed: number; meanGap: number; app: boolean; seen: boolean }

/** The Snap menu's box on the screen and in the page, in DIP, its edges
 *  rounded outwards to whole DIP. The menu is the parent of its Rectangle
 *  item (ScreenshotButton.tsx), never the control's copy of it. */
async function menuBox(): Promise<{ screen: Box; inPage: Box }> {
  const r = await ctx!.page.evaluate(() => {
    const menu = Array.from(document.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').trim() === 'Rectangle' && !b.closest('[data-snap-menu-copy]'))?.parentElement
    if (!menu) return null
    const b = menu.getBoundingClientRect()
    return { x: b.left, y: b.top, width: b.width, height: b.height }
  })
  expect(r, 'the Snap menu is open').not.toBeNull()
  const { content, zoom } = await (await ctx!.app.browserWindow(ctx!.page)).evaluate((w) => ({ content: w.getContentBounds(), zoom: w.webContents.getZoomFactor() }))
  const x0 = Math.floor(content.x + r!.x * zoom)
  const y0 = Math.floor(content.y + r!.y * zoom)
  const x1 = Math.ceil(content.x + (r!.x + r!.width) * zoom)
  const y1 = Math.ceil(content.y + (r!.y + r!.height) * zoom)
  const screen = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  return { screen, inPage: { x: x0 - content.x, y: y0 - content.y, width: screen.width, height: screen.height } }
}

/** The page's own picture of a box (DIP in the page), as a PNG in base64. */
const pagePicture = async (box: Box): Promise<string> =>
  (await ctx!.app.browserWindow(ctx!.page)).evaluate(async (w, b) => (await w.webContents.capturePage(b)).toPNG().toString('base64'), box)

/** Two frames on the page: what it changed before them is drawn. */
const twoFrames = () => ctx!.page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

/** The control: a copy of the open menu laid over it, left on screen until
 *  dropMenuCopy takes it away once the overlay is up, so it is there when the
 *  picture is taken; not on a clock, as the helper's time varies (37 to 432 ms
 *  in six runs' readings). Test only: hidden from the page's roles, never
 *  clicked. */
const keepMenuCopy = () => ctx!.page.evaluate(() => {
  const menu = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent ?? '').trim() === 'Rectangle' && !b.closest('[data-snap-menu-copy]'))?.parentElement
  if (!menu) throw new Error('no Snap menu to copy')
  const b = menu.getBoundingClientRect()
  const copy = menu.cloneNode(true) as HTMLElement
  copy.setAttribute('aria-hidden', 'true')
  copy.setAttribute('inert', '')
  copy.setAttribute('data-snap-menu-copy', '')
  Object.assign(copy.style, { position: 'fixed', left: `${b.left}px`, top: `${b.top}px`, bottom: 'auto', width: `${b.width}px`, height: `${b.height}px`, margin: '0', zIndex: '2147483647', pointerEvents: 'none' })
  document.body.appendChild(copy)
})

/** Takes the control's copy of the menu away. */
const dropMenuCopy = () => ctx!.page.evaluate(() => {
  for (const el of Array.from(document.querySelectorAll('[data-snap-menu-copy]'))) el.remove()
})

/** Sets the app page's CPU slowing (CDP Emulation.setCPUThrottlingRate; 1 is
 *  none), through Playwright's CDP session, or main's own debugger when that
 *  session cannot open; answers which. */
async function pageCpuRate(): Promise<{ via: string; set: (rate: number) => Promise<void> }> {
  try {
    const cdp = await ctx!.page.context().newCDPSession(ctx!.page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    return { via: 'playwright cdp', set: async (rate) => { await cdp.send('Emulation.setCPUThrottlingRate', { rate }) } }
  } catch (err) {
    readings.menuCdpError = err instanceof Error ? err.message : String(err)
  }
  const win = await ctx!.app.browserWindow(ctx!.page)
  await win.evaluate((w) => { if (!w.webContents.debugger.isAttached()) w.webContents.debugger.attach('1.3') })
  return { via: 'electron debugger', set: async (rate) => { await win.evaluate((w, r) => w.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: r }), rate) } }
}

/** A fixed loop's time on the app's page, in ms: read at rate 1 and at a
 *  rate, it shows the slowing took. */
const pageLoopMs = () => ctx!.page.evaluate(() => {
  const started = performance.now()
  let x = 0
  for (let i = 0; i < 20_000_000; i++) x = (x + i) % 1_000_003
  return { ms: performance.now() - started, x }
}).then((r) => r.ms)

/** A saved picture's box (all of it, or `crop` in its pixels) read against the
 *  page's two pictures of it, each brought to the box's size: on the pixels
 *  where those two differ by MENU_PIXEL_GAP or more, how many are nearer the
 *  open one; the mean difference, a channel, to each and between the two; and
 *  the box as a PNG. */
const readMenuBox = (file: string, crop: Box | null, open: string, closed: string) => ctx!.app.evaluate(({ nativeImage }, a) => {
  const pic = a.crop ? nativeImage.createFromPath(a.file).crop(a.crop) : nativeImage.createFromPath(a.file)
  const { width, height } = pic.getSize()
  const sized = (b64: string) => {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
    const s = img.getSize()
    return s.width === width && s.height === height ? img : img.resize({ width, height, quality: 'best' })
  }
  const p = pic.toBitmap()
  const o = sized(a.open).toBitmap()
  const c = sized(a.closed).toBitmap()
  const n = Math.min(p.length, o.length, c.length)
  let differing = 0
  let nearerOpen = 0
  let toOpen = 0
  let toClosed = 0
  let gaps = 0
  for (let i = 0; i + 3 < n; i += 4) {
    let dOpen = 0
    let dClosed = 0
    let gap = 0
    for (let k = 0; k < 3; k++) {
      dOpen += Math.abs(p[i + k] - o[i + k])
      dClosed += Math.abs(p[i + k] - c[i + k])
      gap += Math.abs(o[i + k] - c[i + k])
    }
    toOpen += dOpen
    toClosed += dClosed
    gaps += gap
    if (gap >= a.gap) {
      differing++
      if (dOpen < dClosed) nearerOpen++
    }
  }
  const pixels = Math.max(1, Math.floor(n / 4))
  return {
    width, height, differing, nearerOpen, meanToOpen: toOpen / pixels / 3, meanToClosed: toClosed / pixels / 3,
    meanGap: gaps / pixels / 3, png: pic.toPNG().toString('base64'),
  }
}, { file, crop, open, closed, gap: MENU_PIXEL_GAP })

/** One D12 press: the menu's box and the page's two pictures of it (open with
 *  Rectangle under the pointer, as at the click; then closed again), the
 *  press (the page slowed to `rate` from just before the Rectangle click until
 *  the overlay is up; with `copy`, the control's copy of the menu), the
 *  answer (Rectangle drawn over the box, or Whole screen), and the saved
 *  picture's box read. Its three pictures go to $SNAP_E2E_OUT/menu. */
async function pressReadingMenu(label: string, answerWith: MenuAnswer, rate: number, copy: boolean, cpu: (rate: number) => Promise<void>): Promise<MenuRead> {
  const page = ctx!.page
  const rectangleItem = () => page.getByRole('button', { name: 'Rectangle' })
  const before = jpegs()
  await expect(snapButton()).toBeEnabled({ timeout: CANCEL_MS })
  await snapButton().click()
  const menu = await menuBox()
  await rectangleItem().hover()
  await twoFrames()
  const open = await pagePicture(menu.inPage)
  // The Snap button closes its own menu (ScreenshotButton toggleDropdown).
  await snapButton().click()
  await expect(rectangleItem()).toHaveCount(0, { timeout: CANCEL_MS })
  await twoFrames()
  const closed = await pagePicture(menu.inPage)
  let pressed: Awaited<ReturnType<typeof pressNew>> | undefined
  try {
    pressed = await pressNew({
      prefix: 'menu',
      menuOpen: async () => {
        expect((await menuBox()).screen, 'the menu opens where it was read').toEqual(menu.screen)
        await rectangleItem().hover()
        if (copy) await keepMenuCopy()
        await cpu(rate)
      },
      overlayUp: async () => {
        await cpu(1)
        if (copy) await dropMenuCopy()
      },
    })
  } finally {
    await cpu(1)
    if (copy) await dropMenuCopy().catch(() => undefined)
  }
  const { overlay, display, from } = pressed!
  const s = display.scaleFactor
  const box = { x: menu.screen.x - display.bounds.x, y: menu.screen.y - display.bounds.y, width: menu.screen.width, height: menu.screen.height }
  // Below the overlay's bar (16 DIP from the top, about 40 tall).
  expect(box.y, 'the menu is below the overlay\'s bar').toBeGreaterThanOrEqual(60)
  let width: number
  let height: number
  let answeredAt: number
  if (answerWith === 'rectangle') {
    ({ width, height } = rectangleSize(box, box, s))
    await overlay.mouse.move(box.x, box.y)
    await overlay.mouse.down()
    await overlay.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
    await overlay.mouse.move(box.x + box.width, box.y + box.height, { steps: 4 })
    await overlay.mouse.up()
    answeredAt = performance.now()
    await answer(overlay, () => overlay.keyboard.press('Enter'))
  } else {
    ({ width, height } = wholeScreenSize(display))
    answeredAt = performance.now()
    await answer(overlay, () => overlay.getByRole('button', { name: 'Whole screen' }).click())
  }
  await expectOverlayGone()
  const name = await expectSaved(before, answeredAt, width, height, { lit: false, prefix: 'menu' })
  await expect.poll(() => snapLines(from).length, { timeout: CANCEL_MS }).toBe(1)
  expect(snapLines(from)[0], 'the new Snap took the press').toMatch(answerWith === 'rectangle'
    ? /^\[snap\] new engine: a rectangle of display \d+, /
    : /^\[snap\] new engine: the whole screen of display \d+, /)
  // The whole screen's picture is cut at the box (its pixels, at the cap's size).
  const k = width / display.physical.width
  const crop = answerWith === 'whole'
    ? { x: Math.round(box.x * s * k), y: Math.round(box.y * s * k), width: Math.round(box.width * s * k), height: Math.round(box.height * s * k) }
    : null
  const r = await readMenuBox(path.join(shotsDir(), name), crop, open, closed)
  const dir = path.join(OUT, 'menu')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${label}-picture.png`), Buffer.from(r.png, 'base64'))
  fs.writeFileSync(path.join(dir, `${label}-open.png`), Buffer.from(open, 'base64'))
  fs.writeFileSync(path.join(dir, `${label}-closed.png`), Buffer.from(closed, 'base64'))
  const tenth = (v: number) => Math.round(v * 10) / 10
  return {
    label, rate, copy, answer: answerWith, box: menu.screen, differing: r.differing, nearerOpen: r.nearerOpen,
    meanToOpen: tenth(r.meanToOpen), meanToClosed: tenth(r.meanToClosed), meanGap: tenth(r.meanGap),
    app: Math.min(r.meanToOpen, r.meanToClosed) * 2 <= r.meanGap,
    seen: r.differing >= MENU_MIN_PIXELS && r.nearerOpen * 2 > r.differing,
  }
}

/** E2E_HEADLESS shows the app's window at -10000,-10000, off every display
 *  (src/main/index.ts, ready-to-show). Snap pictures the screen, so the
 *  window goes where a user has it: on the primary display, within its work
 *  area. (Run 45269811648 read the window's right and bottom edges at -8720
 *  and -9280: -10000 plus 1280 by 720.) Answers the window's bounds. C3
 *  passes `right`: the window's left edge that many DIP further right, its
 *  size unchanged. (The window is at least 1280 by 720 DIP, src/main/index.ts
 *  minWidth and minHeight, so on the runner's 1024 by 768 display it already
 *  runs past the display's right edge: run 45582381926 read 0,0 1280x720.) */
async function placeAppWindow(right = 0): Promise<unknown> {
  const area = await ctx!.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  const placed = { x: area.x + right, y: area.y, width: Math.min(1280, area.width), height: Math.min(720, area.height) }
  await (await ctx!.app.browserWindow(ctx!.page)).evaluate((w, b) => w.setBounds(b), placed)
  return (await ctx!.app.browserWindow(ctx!.page)).evaluate((w) => w.getBounds())
}

test.describe('Snap on Windows', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(process.platform !== 'win32', 'Snap on Windows: the runner is Windows')
  test.skip(!HELPER, 'the snap-e2e job only (ci.yml): it needs SNAP_E2E_HELPER, the helper that job built')

  test.beforeAll(async () => {
    test.setTimeout(LAUNCH_MS + 10_000)
    fs.mkdirSync(OUT, { recursive: true })
    expect(HELPER, 'SNAP_E2E_HELPER names the built helper').not.toBe('')
    expect(fs.existsSync(HELPER), `no helper at ${HELPER}`).toBe(true)
    const started = performance.now()
    ctx = await launchIsolatedApp({
      seedExtra: (dataDir) => { chooseSnap(dataDir, 'new'); seedDomTerminal(dataDir) },
      env: (dataDir) => ({
        PATH: pathWith(installStandInClaude(standInDir(dataDir))),
        CCC_E2E_SNAP_HELPER: HELPER,
        ...coldPowerShellEnv(dataDir),
      }),
    })
    readings.launchMs = Math.round(performance.now() - started)
    ctx.app.on('console', (m) => { mainLines.push(m.text()) })
    readings.appWindow = await placeAppWindow()
  })

  test.afterAll(async () => {
    test.setTimeout(120_000)
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'readings.json'), JSON.stringify(readings, null, 2))
    console.log(`[snap-e2e] readings ${JSON.stringify(readings)}`)
    await closeIsolatedApp(ctx)
    // Part two shares `ctx`: never leave it naming this closed app, whose
    // process id Windows may have given to another program by then.
    ctx = undefined
  })

  test('D1 START: one Claude Code tab opens and shows the Snap button', async () => {
    test.setTimeout(TAB_MS + 10_000)
    const page = ctx!.page
    const started = performance.now()
    await page.locator('[data-testid="panel-tab-saved"]').click()
    await page.locator('[data-testid="new-button"]').click()
    await page.locator('[data-testid="new-menu-config"]').click()
    await expect(page.locator('text=New saved config')).toBeVisible({ timeout: TAB_MS })
    await page.locator('[role="radiogroup"][aria-label="Provider"] label:has(input[value="claude"])').click()
    await page.locator('[role="radiogroup"][aria-label="Connection"] label:has(input[value="local"])').click()
    await page.locator('input[placeholder*="path"]').first().fill(ctx!.dataDir)
    await page.locator('input[placeholder="e.g. App Dev"]').fill(LABEL)
    await page.locator('[data-testid="session-dialog-submit"]').click()
    await expect(page.locator('text=New saved config')).toHaveCount(0, { timeout: TAB_MS })
    await expect(snapButton()).toBeVisible({ timeout: TAB_MS })
    readings.tabMs = Math.round(performance.now() - started)
    // The tab runs the stand-in on a terminal: a Snap's path is typed into it.
    try {
      await expect.poll(() => launches().some((l) => l.stdinTty === true), { timeout: TAB_MS, intervals: [100] }).toBe(true)
      await expect.poll(() => terminalText(page), { timeout: TAB_MS, intervals: [100] }).toContain('stand-in Claude Code ready')
    } finally {
      readings.launches = launches()
      readings.terminalAtStart = await terminalText(page).catch((e: Error) => `unread: ${e.message}`)
    }
  })

  test('R1 ADD-ONS AT START: what main has loaded before any press of the previous Snap', async () => {
    readings.loadedAtStart = await loadedModules(ctx!.app)
    console.log(`[snap-e2e] R1 loaded at start ${JSON.stringify(readings.loadedAtStart)}`)
  })

  for (let run = 1; run <= RUNS; run++) {
    test(`D2 RECTANGLE run ${run}: a 200 by 120 DIP drag and Enter give one JPEG of that size times the scale, typed into the tab`, async () => {
      test.setTimeout(PRESS_TEST_MS)
      const before = jpegs()
      const typedBefore = typedText().length
      const { overlay, display, start, from } = await pressNew()
      const s = display.scaleFactor
      const { width, height } = rectangleSize(start, DRAG, s)
      await overlay.mouse.move(start.x, start.y)
      await overlay.mouse.down()
      await overlay.mouse.move(start.x + DRAG.width / 2, start.y + DRAG.height / 2, { steps: 4 })
      await overlay.mouse.move(start.x + DRAG.width, start.y + DRAG.height, { steps: 4 })
      if (run === 1) await overlay.screenshot({ path: path.join(OUT, 'overlay-mid-drag.png') })
      await overlay.mouse.up()
      await expect(overlay.locator('#size')).toHaveText(`${Math.round(DRAG.width * s)} ${String.fromCharCode(0xd7)} ${Math.round(DRAG.height * s)}`)
      const answeredAt = performance.now()
      await answer(overlay, () => overlay.keyboard.press('Enter'))
      await expectOverlayGone()
      await expectSaved(before, answeredAt, width, height)
      expect(typedText().length).toBeGreaterThan(typedBefore)
      await expect.poll(() => snapLines(from).length, { timeout: CANCEL_MS }).toBe(1)
      const line = snapLines(from)[0]
      const m = /^\[snap\] new engine: a rectangle of display (\d+), (\d+)x(\d+); the helper took (\d+) ms; (.+)$/.exec(line)
      expect(m, line).not.toBeNull()
      expect(`${m![2]}x${m![3]}`).toBe(`${width}x${height}`)
      push('helperMs', Number(m![4]))
      expect(Number(m![4])).toBeLessThanOrEqual(HELPER_BOUND_MS)
      await expectDisplayList(m![5])
      noPressFolder()
    })
  }

  for (let run = 1; run <= RUNS; run++) {
    test(`D3 WHOLE SCREEN run ${run}: one JPEG of the display at its size, capped at 1920, typed into the tab`, async () => {
      test.setTimeout(PRESS_TEST_MS)
      const before = jpegs()
      const { overlay, display, from } = await pressNew()
      const { width: pw, height: ph } = display.physical
      const capped = wholeScreenSize(display)
      const answeredAt = performance.now()
      await answer(overlay, () => overlay.getByRole('button', { name: 'Whole screen' }).click())
      await expectOverlayGone()
      await expectSaved(before, answeredAt, capped.width, capped.height)
      await expect.poll(() => snapLines(from).length, { timeout: CANCEL_MS }).toBe(1)
      const line = snapLines(from)[0]
      const m = /^\[snap\] new engine: the whole screen of display (\d+), (\d+)x(\d+); the helper took (\d+) ms; (.+)$/.exec(line)
      expect(m, line).not.toBeNull()
      expect(`${m![2]}x${m![3]}`).toBe(`${pw}x${ph}`)
      push('helperMs', Number(m![4]))
      expect(Number(m![4])).toBeLessThanOrEqual(HELPER_BOUND_MS)
      await expectDisplayList(m![5])
      noPressFolder()
    })
  }

  for (let run = 1; run <= RUNS; run++) {
    test(`D4 ESCAPE run ${run}: no file, nothing typed, one line saying cancelled`, async () => {
      test.setTimeout(PRESS_TEST_MS)
      const before = jpegs()
      const typedBefore = typedText()
      const { overlay, from } = await pressNew()
      await answer(overlay, () => overlay.keyboard.press('Escape'))
      await expectOverlayGone()
      await expect.poll(() => snapLines(from).length, { timeout: CANCEL_MS }).toBe(1)
      const line = snapLines(from)[0]
      const m = /^\[snap\] new engine: cancelled; the helper took (\d+) ms; (.+)$/.exec(line)
      expect(m, line).not.toBeNull()
      push('helperMs', Number(m![1]))
      await expectDisplayList(m![2])
      // The line comes after the answer: a picture would have been saved before it.
      expect(jpegs()).toEqual(before)
      expect(typedText()).toBe(typedBefore)
      noPressFolder()
    })
  }

  test('D5 DEFAULT: with no choice saved, a press uses the new Snap', async () => {
    test.setTimeout(PRESS_TEST_MS)
    const { dataDir } = ctx!
    fs.writeFileSync(magicButtons(dataDir), JSON.stringify({ screenshotColor: '#00FFFF', autoDeleteDays: null }, null, 2))
    try {
      const before = jpegs()
      const { overlay, from } = await pressNew()
      await answer(overlay, () => overlay.keyboard.press('Escape'))
      await expectOverlayGone()
      await expect.poll(() => snapLines(from).length, { timeout: CANCEL_MS }).toBe(1)
      expect(snapLines(from)[0]).toMatch(/^\[snap\] new engine: cancelled; the helper took \d+ ms; /)
      expect(jpegs()).toEqual(before)
    } finally {
      chooseSnap(dataDir, 'new')
    }
  })

  test('D6 NOT LOADED BY THE NEW SNAP: no file of the previous Snap\'s package, and not its add-on, at start or after the new Snap\'s presses', async () => {
    const now = await loadedModules(ctx!.app)
    readings.loadedAfterNew = now
    const atStart = readings.loadedAtStart as Awaited<ReturnType<typeof loadedModules>>
    for (const [when, r] of [['at start (R1)', atStart], ['after D2 to D5', now]] as const) {
      expect(r.cacheRead, `${when}: main's module cache read`).toBe(true)
      expect(r.packageFilesInCache, `${when}: files of electron-screenshots`).toEqual([])
      expect(r.nativeInCache.filter((f) => /node-screenshots/i.test(f)), `${when}: node-screenshots in the cache`).toEqual([])
      expect(r.nativeInReport.filter((f) => /node-screenshots/i.test(f)), `${when}: node-screenshots in the report`).toEqual([])
    }
  })

  for (let run = 1; run <= RUNS; run++) {
    test(`D7 FORCED FAILURE run ${run}: a helper that is not there, and the previous Snap takes the press`, async () => {
      test.setTimeout(PRESS_TEST_MS)
      const { app, dataDir } = ctx!
      const missing = path.join(dataDir, 'no-helper', 'aicc-helper.exe')
      await app.evaluate((_e, p) => { process.env.CCC_E2E_SNAP_HELPER = p }, missing)
      try {
        const from = mark()
        push('pressMs', await pressAndCancelPrevious())
        await expect.poll(() => snapLines(from).length, { timeout: CANCEL_MS }).toBe(1)
        expect(snapLines(from)[0]).toMatch(/^\[snap\] new engine: the helper could not start \(ENOENT\); the helper took \d+ ms; the previous Snap takes this press$/)
      } finally {
        await app.evaluate((_e, p) => { process.env.CCC_E2E_SNAP_HELPER = p }, HELPER)
      }
    })
  }

  test('D8 PREVIOUS CHOSEN: no new-engine line, one line says the previous engine takes the press, and the previous Snap opens', async () => {
    test.setTimeout(PRESS_TEST_MS)
    const { dataDir } = ctx!
    chooseSnap(dataDir, 'previous')
    try {
      const from = mark()
      push('pressMs', await pressAndCancelPrevious())
      expect(snapLines(from)).toEqual([])
      expect(linesSince(from, '[snap] previous engine:')).toEqual(['[snap] previous engine: loaded; it takes this press'])
    } finally {
      chooseSnap(dataDir, 'new')
    }
  })

  test('R2 ADD-ONS AFTER THE PREVIOUS SNAP: what main has loaded once the previous Snap has run', async () => {
    readings.loadedAfterPrevious = await loadedModules(ctx!.app)
    console.log(`[snap-e2e] R2 loaded after the previous Snap ${JSON.stringify(readings.loadedAfterPrevious)}`)
  })

  test('D9 LOADED BY ITS FIRST PRESS: after the previous Snap\'s presses, main holds the package and its add-on', async () => {
    const r = readings.loadedAfterPrevious as Awaited<ReturnType<typeof loadedModules>>
    expect(r.cacheRead, 'main\'s module cache read').toBe(true)
    expect(r.packageFilesInCache.length, 'files of electron-screenshots').toBeGreaterThan(0)
    expect(r.nativeInCache.filter((f) => /node-screenshots/i.test(f)).length, 'node-screenshots in the cache').toBe(1)
  })

  test('D10 HELPER DIRECT: each picture at its physical size, matched to one of Electron\'s displays by bounds and scale', async () => {
    test.setTimeout(PRESS_TEST_MS)
    const folder = fs.mkdtempSync(path.join(OUT, 'capture-'))
    try {
      const run = await runHelper(['capture', '--out', folder])
      readings.directHelperMs = run.ms
      expect(run.code, `capture exited ${run.code}: ${run.stderr}`).toBe(0)
      const line = JSON.parse(run.stdout.trim()) as { displays: Array<{ file: string; left: number; top: number; width: number; height: number; scale: number; primary: boolean }> }
      readings.helperDisplays = line.displays
      const displays = await electronDisplays(ctx!.app)
      expect(line.displays.length).toBe(displays.length)
      for (const d of line.displays) {
        const buf = fs.readFileSync(path.join(folder, d.file))
        expect(buf.length, d.file).toBe(54 + d.width * d.height * 4)
        expect(buf.readInt32LE(18), `${d.file} width`).toBe(d.width)
        expect(buf.readInt32LE(22), `${d.file} height (positive: rows from the bottom)`).toBe(d.height)
        expect(buf.readUInt16LE(28), `${d.file} bits`).toBe(32)
        const match = displays.filter((e) => e.physical.x === d.left && e.physical.y === d.top && e.physical.width === d.width && e.physical.height === d.height)
        expect(match.length, `${d.file} at ${d.left},${d.top} ${d.width}x${d.height} matches one display: ${JSON.stringify(displays)}`).toBe(1)
        expect(Math.round(match[0].scaleFactor * 100), `${d.file} scale`).toBe(d.scale)
      }
    } finally {
      fs.rmSync(folder, { recursive: true, force: true })
    }
  })

  test('D11 SCALED PICTURE: in this Electron a picture made at 1.5 has no JPEG form, and its PNG at that scale is the whole picture', async () => {
    const r = await ctx!.app.evaluate(({ nativeImage }) => {
      const width = 6
      const height = 4
      const img = nativeImage.createFromBitmap(Buffer.alloc(width * height * 4, 255), { width, height, scaleFactor: 1.5 })
      const png = img.toPNG({ scaleFactor: 1.5 })
      return { empty: img.isEmpty(), jpegBytes: img.toJPEG(92).length, pngBytes: png.length, pngSize: nativeImage.createFromBuffer(png).getSize() }
    })
    readings.scaledPicture = r
    expect(r.empty).toBe(false)
    expect(r.jpegBytes, 'toJPEG gives nothing for a picture with no 1x form').toBe(0)
    expect(r.pngBytes).toBeGreaterThan(0)
    expect(r.pngSize).toEqual({ width: 6, height: 4 })
  })

  test('D12 MENU OUT OF THE PICTURE: the control\'s menu is seen in every picture, and with the page slowed 4 and 20 times the menu is in none', async () => {
    test.setTimeout(MENU_PARTS.length * RUNS * 2 * PRESS_TEST_MS + 60_000)
    // The app's window over every other, as it is when its user clicks its
    // menu. In run 45348436201 it was on top at D2 (overlay-mid-drag.png) but
    // a console window lay over the menu's box by D12 (every box showed that
    // window's log lines). The overlay still goes over it (overlay.ts:
    // 'screen-saver', moveTop).
    const win = await ctx!.app.browserWindow(ctx!.page)
    await win.evaluate((w) => { w.setAlwaysOnTop(true); w.moveTop() })
    const cpu = await pageCpuRate()
    const reads: MenuRead[] = []
    const slowing: Array<{ rate: number; atOneMs: number; atRateMs: number }> = []
    try {
      for (const { rate, copy } of MENU_PARTS) {
        if (rate !== 1) {
          await pageLoopMs()
          const atOneMs = await pageLoopMs()
          await cpu.set(rate)
          let atRateMs: number
          try { atRateMs = await pageLoopMs() } finally { await cpu.set(1) }
          slowing.push({ rate, atOneMs: Math.round(atOneMs), atRateMs: Math.round(atRateMs) })
        }
        for (let run = 1; run <= RUNS; run++) {
          for (const answerWith of ['rectangle', 'whole'] as const) {
            reads.push(await pressReadingMenu(`${copy ? 'control' : `x${rate}`}-${answerWith}-${run}`, answerWith, rate, copy, cpu.set))
          }
        }
      }
    } finally {
      await cpu.set(1).catch(() => undefined)
      await win.evaluate((w) => w.setAlwaysOnTop(false)).catch(() => undefined)
      readings.menuCpuVia = cpu.via
      readings.menuSlowing = slowing
      readings.menuReads = reads
      console.log(`[snap-e2e] D12 ${JSON.stringify({ via: cpu.via, slowing, reads })}`)
    }
    expect(slowing.filter((s) => s.atRateMs * 2 < s.atOneMs * s.rate), 'the page slowed to at least half of each rate').toEqual([])
    expect(reads.filter((r) => r.differing < MENU_MIN_PIXELS).map((r) => r.label), 'every box read: its two page pictures differ').toEqual([])
    expect(reads.filter((r) => !r.app).map((r) => r.label), 'every box shows the app, not another window').toEqual([])
    expect(reads.filter((r) => r.copy && !r.seen).map((r) => r.label), 'the control: the copy of the menu is seen').toEqual([])
    expect(reads.filter((r) => !r.copy && r.seen).map((r) => r.label), 'the menu is in no picture of the slowed page').toEqual([])
  })
})

// PART TWO (see the header): Snap into a Codex tab while Codex shows its
// warning count.

/** The Codex the job installed (its npm prefix), or '' off the job. */
const CODEX_PREFIX = process.env.SNAP_E2E_CODEX ? path.resolve(process.env.SNAP_E2E_CODEX) : ''
/** The Codex the test machine's readings used (P19; beta.17 C9). */
const CODEX_VERSION = '0.157.1'
const CODEX_LABEL = 'Snap Codex E2E'
const CODEX_FAKE_KEY = 'sk-e2e-fake-key-not-real'
/** Everything but loopback goes nowhere (as codex-real-launch.spec.ts). */
const DEAD_PROXY = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }
/** See the header. */
const CODEX_START_MS = 120_000
const CODEX_TURN_MS = 20_000
/** How far each C2 and C3 run moves its picture (DIP): C2's drag starts this
 *  much further right a run, C3 moves the app's window this much further
 *  right a run. Without it two presses could picture the same screen: in run
 *  45582381926 C2 run 3's picture was C2 run 2's byte for byte, and C3 run
 *  2's was C3 run 1's (Codex numbers each message's image [Image #1], so its
 *  screen after each turn is the same). */
const PICTURE_STEP = 16
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One request probe P11's stand-in saw (its onEvent; a body is never kept),
 *  each picture it carried named by its SHA-256. */
type StandInEvent = {
  ev: string; t: number; id: number; path?: string; kind?: string; tools?: number; stream?: boolean; model?: string | null
  images?: Array<{ way?: string; sha256?: string; rgbaSha256?: string; rgbSha256?: string; pixelsUnread?: string; kind?: string; bytes?: number; width?: number | null; height?: number | null }>
}
/** A PNG named by its decoded pixels (helper/probes/png-rgba.cjs), as the
 *  model stand-in names one: ADR-032's proof compares pixels, exactly. */
const { pngPixelHashes } = createRequire(__filename)('../../helper/probes/png-rgba.cjs') as { pngPixelHashes: (b: Buffer) => { rgbaSha256?: string; rgbSha256?: string; unread?: string } }
type StandIn = { listen: () => Promise<number>; close: () => Promise<void> }
const { createModelStandIn } = createRequire(__filename)('../../helper/probes/p11-model-stand-in.cjs') as { createModelStandIn: (o: { onEvent: (e: StandInEvent) => void }) => StandIn }
const standInEvents: StandInEvent[] = []
let codexSid = ''

/** The npm shim the job's install made. */
const codexShim = () => path.join(CODEX_PREFIX, 'codex.cmd')

/** The account folder's config: the model stand-in on loopback with no
 *  retries, the project trusted, and P19's tool server that cannot start.
 *  No model: the app names the one its config chose (`-m`). */
function codexConfigToml(port: number, projectDir: string): string {
  return [
    '# snap-e2e (plan 2.1.3-beta.18, 7.5): TEST HARNESS ONLY, a throwaway Codex home. The model is the loopback stand-in; no network.',
    'model_provider = "snape2e"',
    '',
    '[model_providers.snape2e]',
    'name = "snap-e2e model stand-in (loopback test harness)"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
    `[projects.'${projectDir}']`,
    'trust_level = "trusted"',
    '',
    // P19's warning launch (p19-scenarios.json): a tool server whose program is not there.
    '[mcp_servers.snape2eprobe]',
    `command = '${path.join(projectDir, 'snap-e2e-no-such-program')}'`,
    '',
  ].join('\n')
}

/** The job's Codex run once outside the app on the account's folder (the
 *  made-up key's sign-in, its check), as codex-real-launch.spec.ts runs it: no
 *  Codex or OpenAI variable of the runner's, the spec's home, the dead proxy,
 *  and through cmd.exe, since the shim is a .cmd. */
function runCodexCli(dataDir: string, realm: string, args: string[], input?: string) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(OPENAI_|CODEX_)/i.test(k)) continue
    env[k] = v
  }
  const home = isolatedHomeDir(dataDir)
  fs.mkdirSync(home, { recursive: true })
  Object.assign(env, { USERPROFILE: home, HOME: home, CODEX_HOME: realm, ...DEAD_PROXY })
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  return spawnSync(shell, ['/d', '/s', '/c', `""${codexShim()}" ${args.join(' ')}"`], { env, input, encoding: 'utf8', timeout: 60_000, windowsHide: true, windowsVerbatimArguments: true })
}

/** The Codex tab's screen as one text, each row's end trimmed. */
const codexScreen = async (): Promise<string> => (await terminalRows(ctx!.page)).map((r) => r.replace(/\s+$/, '')).join('\n')
/** Codex's composer and its footer on the screen's last rows that are not
 *  blank: the footer by its shape (the 9.2 rules' FOOTER: the app launches
 *  Codex with its config's model, `-m gpt-6-astra` in run 45578961836, so the
 *  footer does not carry the account config's model), the composer row (the
 *  prompt sign) right above it; and Codex's warning count under the footer
 *  (P19's recorded hint row: the warning sign, "1 warning . f2 to view"), or
 *  null. */
function codexRest(screen: string): { atRest: boolean; count: number | null } {
  const shown = screen.split('\n').filter((l) => l.trim() !== '')
  let footer = -1
  for (let i = shown.length - 1; i >= 0 && footer < 0; i--) if (FOOTER.test(shown[i])) footer = i
  if (footer < 1) return { atRest: false, count: null }
  const m = /\u26a0 (\d+) warnings?\b/.exec(shown.slice(footer + 1).join('\n'))
  return { atRest: /^ ?\u203a(?: |$)/.test(shown[footer - 1]), count: m ? Number(m[1]) : null }
}
const warningCount = (screen: string): number | null => codexRest(screen).count
const atRestWithCount = (screen: string) => { const r = codexRest(screen); return r.atRest && r.count !== null }

/** Every request Codex has sent its model (the stand-in's Responses route).
 *  Each is counted, whatever it carries: in run 45580311269 the one request a
 *  press made was the turn ("[Image #1]", the sentence, and the stand-in's
 *  "ok" on Codex's screen), and it carried no tools, so P19's note that a
 *  turn carries Codex's tools and a second request after it does not, made
 *  on P19's own launch, does not describe the app's. */
const codexTurns = () => standInEvents.filter((e) => e.ev === 'request' && e.path === '/v1/responses' && e.kind !== 'not-found')
/** The pictures pressed into the Codex tab so far, in order: since
 *  2.1.3-beta.21 (ADR-032) each by the hash of the decoded pixels of the PNG
 *  the app left on the clipboard (Codex re-encodes what it reads there), on
 *  the path route by the file's SHA-256. */
const codexSent: string[] = []
/** How a turn names a picture: its decoded pixels' hash when it is a PNG
 *  (the clipboard route), else its SHA-256 (the path route's JPEG). */
const turnPicture = (i: NonNullable<StandInEvent['images']>[number]): string => i.rgbaSha256 ?? i.sha256 ?? `${i.way ?? 'unknown'} (not inline)`
const sha256Of = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** Before a press into the Codex tab: Codex at rest, its warning count 1, on
 *  two reads 300 ms apart (a press made while the count shows). */
async function expectCodexAtRestWithCount(): Promise<void> {
  const read = async () => { const s = await codexScreen(); return atRestWithCount(s) && warningCount(s) === 1 }
  const twice = async () => { if (!(await read())) return false; await sleep(300); return read() }
  await expect.poll(twice, { timeout: CODEX_TURN_MS, intervals: [250] }).toBe(true)
}

/** After a press into the Codex tab: the one JPEG it saved (its size, not all
 *  black); one new-engine line; main's one line saying Codex's clipboard
 *  paste pasted and sent it (since 2.1.3-beta.21, ADR-032: the picture on the
 *  clipboard, Codex's own paste key, no path); the picture the app left on
 *  the clipboard at that size, its decoded pixels none of an earlier
 *  press's; and exactly one new turn at the stand-in, whose pictures are
 *  every picture pressed so far, in order, each once, the newest that
 *  picture by its decoded pixels (Codex sends the whole conversation each
 *  turn). Then Codex back at rest with its count, and still that one turn. */
async function expectSentToCodex(before: string[], turnsBefore: number, answeredAt: number, width: number, height: number, from: Mark, linePattern: RegExp): Promise<void> {
  await expect.poll(() => jpegs().filter((f) => !before.includes(f)).length, { timeout: OVERLAY_MS, intervals: [50] }).toBe(1)
  push('codexEnterToFileMs', Math.round(performance.now() - answeredAt))
  const savedAt = performance.now()
  const name = jpegs().find((f) => !before.includes(f))!
  const file = path.join(shotsDir(), name)
  const info = await jpegInfo(ctx!.app, file)
  expect(info.empty, name).toBe(false)
  expect({ width: info.width, height: info.height }, name).toEqual({ width, height })
  expect(info.lit, `${name}: pixels not near black, of ${info.pixels}`).toBeGreaterThan(info.pixels / 100)
  await expect.poll(() => snapLines(from).length, { timeout: CANCEL_MS }).toBe(1)
  expect(snapLines(from)[0]).toMatch(linePattern)
  try {
    await expect.poll(() => linesSince(from, '[codex-paste]').length, { timeout: CODEX_TURN_MS, intervals: [100] }).toBe(1)
    expect(linesSince(from, '[codex-paste]')[0]).toMatch(new RegExp(`^\\[codex-paste\\] ${codexSid}: the clipboard picture pasted and sent; `))
    expect(linesSince(from, '[codex-image]'), 'no path pasted').toEqual([])
    // The picture the app left on the clipboard (plan Q1), kept beside the
    // JPEG as the reference: the pixels Codex was given.
    const png = await clipboardPng(ctx!.app)
    expect(png, 'a picture on the clipboard').not.toBeNull()
    expect(pngSize(png!), 'the clipboard picture is the press\'s').toEqual({ width, height })
    fs.writeFileSync(path.join(OUT, `${name}.clipboard.png`), png!)
    const ref = pngPixelHashes(png!)
    expect(ref.unread, 'the clipboard picture decodes').toBeUndefined()
    // Each press's picture is made to differ from every earlier one (C2's
    // drag and C3's window move 16 DIP a run), so a turn that sent an earlier
    // press's picture again cannot pass as this one's.
    expect(codexSent, 'this press\'s picture differs from every earlier press\'s').not.toContain(ref.rgbaSha256)
    codexSent.push(ref.rgbaSha256!)
    await expect.poll(() => codexTurns().length, { timeout: CODEX_TURN_MS, intervals: [100] }).toBeGreaterThan(turnsBefore)
    push('codexFileToTurnMs', Math.round(performance.now() - savedAt))
    const turn = codexTurns()[turnsBefore]
    expect((turn.images ?? []).map(turnPicture), 'the turn\'s pictures: every picture pressed so far, in order, each once, by its pixels').toEqual(codexSent)
    const turnAt = performance.now()
    await expectCodexAtRestWithCount()
    push('codexTurnToRestMs', Math.round(performance.now() - turnAt))
    expect(codexTurns().length, 'one turn for the press').toBe(turnsBefore + 1)
  } catch (err) {
    readings.codexAtFailure = {
      screen: (await codexScreen().catch((e: Error) => `unread: ${e.message}`)).split('\n').filter((l) => l.trim()),
      lines: mainLines.slice(from.console).filter((l) => /codex|snap/i.test(l)).slice(-40),
      sent: codexSent,
    }
    throw err
  }
}

test.describe('Snap into a Codex tab on Windows while Codex shows its warning count', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(process.platform !== 'win32', 'Snap on Windows: the runner is Windows')
  test.skip(!HELPER, 'the snap-e2e job only (ci.yml): it needs SNAP_E2E_HELPER and SNAP_E2E_CODEX, the helper that job built and the Codex it installed')

  let standIn: StandIn | undefined
  let projectDir = ''

  test.beforeAll(async () => {
    // Part one's app is closed: if this hook fails before its own launch, the
    // afterAll below closes nothing rather than a stale process id.
    ctx = undefined
    test.setTimeout(LAUNCH_MS + 130_000)
    fs.mkdirSync(OUT, { recursive: true })
    // In the job this part runs or fails: it is never skipped there.
    expect(CODEX_PREFIX, 'SNAP_E2E_CODEX names the Codex the job installed').not.toBe('')
    expect(fs.existsSync(codexShim()), `no Codex at ${codexShim()}`).toBe(true)
    standIn = createModelStandIn({ onEvent: (e) => { standInEvents.push(e) } })
    const port = await standIn.listen()
    const started = performance.now()
    ctx = await launchIsolatedApp({
      seedExtra: (dataDir) => {
        chooseSnap(dataDir, 'new')
        seedCodexAccount(dataDir, { fake: false, domTerminal: true, method: 'apiKey' })
        projectDir = path.join(dataDir, 'codex-project')
        fs.mkdirSync(projectDir, { recursive: true })
        const realm = realmDirOf(dataDir)
        fs.writeFileSync(path.join(realm, 'config.toml'), codexConfigToml(port, projectDir))
        const login = runCodexCli(dataDir, realm, ['login', '--with-api-key'], `${CODEX_FAKE_KEY}\n`)
        if (login.status !== 0) throw new Error(`the made-up key's sign-in failed (exit ${login.status}): ${login.stderr}`)
        const status = runCodexCli(dataDir, realm, ['login', 'status'])
        if (!/Logged in using an API key/.test(`${status.stdout}${status.stderr}`)) throw new Error(`the account folder is not signed in with the made-up key: ${status.stdout}${status.stderr}`)
      },
      env: (dataDir) => ({
        PATH: [CODEX_PREFIX, ...pathWithoutCodex(process.env.PATH ?? '')].join(path.delimiter),
        // "Sign-in already on this computer": an empty folder of the spec's.
        CODEX_HOME: (() => { const d = path.join(dataDir, 'codex-home'); fs.mkdirSync(d, { recursive: true }); return d })(),
        CCC_E2E_SNAP_HELPER: HELPER,
        ...DEAD_PROXY,
        ...coldPowerShellEnv(dataDir),
      }),
    })
    readings.codexLaunchMs = Math.round(performance.now() - started)
    ctx.app.on('console', (m) => { mainLines.push(m.text()) })
    readings.codexAppWindow = await placeAppWindow()
  })

  test.afterAll(async () => {
    test.setTimeout(120_000)
    readings.codexRequests = standInEvents.filter((e) => e.ev === 'request').map(({ id, t, path: p, kind, tools, stream, model, images }) => ({ id, t, path: p, kind, tools, stream, model, images }))
    const out = Object.fromEntries(Object.entries(readings).filter(([k]) => k.startsWith('codex')))
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'codex-readings.json'), JSON.stringify(out, null, 2))
    console.log(`[snap-e2e] codex readings ${JSON.stringify(out)}`)
    await closeIsolatedApp(ctx)
    ctx = undefined
    await standIn?.close()
  })

  test('C1 START: a Codex 0.157.1 tab on the stand-in, with a tool server that cannot start, shows Codex\'s warning count and the Snap button', async () => {
    test.setTimeout(CODEX_START_MS + 60_000)
    const page = ctx!.page
    const discovered = await page.evaluate(async () => {
      const api = (window as unknown as { electronAPI: { providerAccounts: { discover: (id: string) => Promise<unknown> } } }).electronAPI
      return api.providerAccounts.discover('codex')
    }) as { ok: boolean; installation?: Record<string, unknown> }
    readings.codexDiscovery = discovered.installation
      ? { state: discovered.installation.discoveryState, version: discovered.installation.version, compatibility: discovered.installation.compatibility }
      : discovered
    expect(discovered.installation, JSON.stringify(discovered)).toMatchObject({ discoveryState: 'found', version: CODEX_VERSION })
    const started = performance.now()
    await createCodexConfig(page, { label: CODEX_LABEL, dir: projectDir })
    await openSession(page, CODEX_LABEL)
    codexSid = await activeSessionId(page)
    await expect(snapButton()).toBeVisible({ timeout: TAB_MS })
    // Codex's first screens, each answered once by the 9.2 rules, then its
    // composer, footer and warning count on two reads 300 ms apart.
    const answered: FirstScreenAnswer[] = []
    let shown = false
    try {
      const deadline = Date.now() + CODEX_START_MS
      while (Date.now() < deadline) {
        const next = nextFirstScreen(await terminalRows(page), answered)
        if (next.act === 'answer') {
          answered.push({ kind: next.kind, screen: await answerFirstScreen(page, codexSid, next.kind) })
          continue
        }
        if (atRestWithCount(await codexScreen())) {
          await sleep(300)
          if (atRestWithCount(await codexScreen())) { shown = true; break }
        }
        await sleep(250)
      }
    } finally {
      readings.codexStartMs = Math.round(performance.now() - started)
      readings.codexFirstScreens = answered.map((a) => a.kind)
      readings.codexScreenAtStart = (await codexScreen().catch((e: Error) => `unread: ${e.message}`)).split('\n').filter((l) => l.trim())
      readings.codexMainLines = mainLines.filter((l) => /codex/i.test(l)).slice(-60)
    }
    const screen = await codexScreen()
    expect(shown, `no composer, footer and warning count within ${CODEX_START_MS} ms; the screen:\n${screen}`).toBe(true)
    expect(warningCount(screen), `the warning count is the one tool server's; the screen:\n${screen}`).toBe(1)
  })

  for (let run = 1; run <= RUNS; run++) {
    test(`C2 RECTANGLE run ${run}: a 200 by 120 DIP drag and Enter while Codex shows its warning count go to Codex as one turn carrying the picture`, async () => {
      test.setTimeout(PRESS_TEST_MS + 2 * CODEX_TURN_MS)
      await expectCodexAtRestWithCount()
      const before = jpegs()
      const turnsBefore = codexTurns().length
      const { overlay, display, start, from } = await pressNew({ prefix: 'codex' })
      // A picture of its own each run (PICTURE_STEP). pressNew's fit check
      // leaves the room: the drag, at most 32 DIP further right, ends at
      // 272 DIP of the window's 1024 DIP on the runner's display.
      const at = { x: start.x + (run - 1) * PICTURE_STEP, y: start.y }
      push('codexDragX', at.x)
      const { width, height } = rectangleSize(at, DRAG, display.scaleFactor)
      await overlay.mouse.move(at.x, at.y)
      await overlay.mouse.down()
      await overlay.mouse.move(at.x + DRAG.width / 2, at.y + DRAG.height / 2, { steps: 4 })
      await overlay.mouse.move(at.x + DRAG.width, at.y + DRAG.height, { steps: 4 })
      await overlay.mouse.up()
      const answeredAt = performance.now()
      await answer(overlay, () => overlay.keyboard.press('Enter'))
      await expectOverlayGone()
      await expectSentToCodex(before, turnsBefore, answeredAt, width, height, from, /^\[snap\] new engine: a rectangle of display \d+, /)
    })
  }

  for (let run = 1; run <= RUNS; run++) {
    test(`C3 WHOLE SCREEN run ${run}: the whole screen while Codex shows its warning count goes to Codex as one turn carrying the picture`, async () => {
      test.setTimeout(PRESS_TEST_MS + 2 * CODEX_TURN_MS)
      // A picture of its own each run (PICTURE_STEP): the app's window moved
      // right, then Codex read at rest with its count, so the press is still
      // made while the count shows; the window goes back once the turn is read.
      const moved = await placeAppWindow((run - 1) * PICTURE_STEP)
      readings.codexWholeScreenWindow = [...((readings.codexWholeScreenWindow as unknown[] | undefined) ?? []), moved]
      await expectCodexAtRestWithCount()
      const before = jpegs()
      const turnsBefore = codexTurns().length
      const { overlay, display, from } = await pressNew({ prefix: 'codex' })
      const { width, height } = wholeScreenSize(display)
      const answeredAt = performance.now()
      await answer(overlay, () => overlay.getByRole('button', { name: 'Whole screen' }).click())
      await expectOverlayGone()
      await expectSentToCodex(before, turnsBefore, answeredAt, width, height, from, /^\[snap\] new engine: the whole screen of display \d+, /)
      await placeAppWindow()
    })
  }
})

// ===== PART THREE (plan 2.1.3-beta.21 phase 2, 2.1.7, 2.2 and 2.3; ADR-032) =====
// The clipboard route's probes and its load proof, each run only when the
// dispatch names it (the snap_e2e_paste input, SNAP_E2E_PASTE): `probe` runs
// PW2 and PW1; `gate` runs C2 on the path route and on the clipboard route,
// and C4, under the load grader. Real Claude Code 2.1.332 (SNAP_E2E_CLAUDE,
// installed by the job from its platform package with scripts off) and Codex
// 0.157.1 (SNAP_E2E_CODEX) run against probe P11's model stand-in, which
// names each PNG a turn carries by its decoded pixels (png-rgba.cjs).
//
// DECISION LINES, fixed before measuring.
//   PW2: one Electron 44 clipboard.write() with one item holding image/png
//     (the app's writer, src/main/paste/clipboard-writer.ts), then a Win32
//     format list of the clipboard (EnumClipboardFormats) and WinForms
//     Clipboard.GetImage() (Claude Code's read). Recorded: whether CF_DIB and
//     the registered PNG format are there together, and what GetImage reads.
//     Both CLIs reading the result is PW1's.
//   PW1: in a Codex 0.157.1 tab and a Claude Code 2.1.332 tab (the bundled
//     ConPTY), at 0, 1, 2 and 3 busy processes: a picture written by
//     Electron, then ESC v and then Ctrl+V into the CLI (pty:write, as xterm
//     would type them); the time from the key to a new "[Image #N]" on the
//     tab's screen (bound 15 s), then a sentence and Enter, and whether the
//     turn carries the same picture by its decoded pixels. THE WAITS: the
//     clipboard paste's placeholder wait (session-input
//     CLIPBOARD_PLACEHOLDER_WAIT_MS) is set to PW1's worst time to the
//     placeholder at 3 busy processes, over both CLIs, for the key the app
//     sends on Windows (ESC v), times 2 (THE FACTOR), at most 10 s, fixed in
//     code before the gate is dispatched. A CLI that shows no placeholder for
//     ESC v at 3 busy processes is diagnosed and the owner told; the path
//     does not come back.
//     READ, both runs that measured Claude Code. Run 46128029706 (the app on
//     a fresh, empty PowerShell module analysis cache, beta.20's D1
//     condition): Claude Code 2.1.332 showed no placeholder within the 15 s
//     bound in 7 of 8 presses, and one 13.7 s after its key; Codex 0.157.1
//     31 to 120 ms. Run 46128921672 (a warm PowerShell cache): Claude Code
//     926, 914, 1030 and 1250 ms after ESC v at 0 to 3 busy processes, no
//     placeholder for Ctrl+V on Windows; Codex 31 to 76 ms after either key;
//     every turn carried the picture by its decoded pixels. PW2 (the same
//     runs and runs 46126339163, 46127035163): one write left PNG, CF_DIBV5,
//     CF_BITMAP and CF_DIB, and GetImage read it. The gate ran with a wait of
//     2 x 1250 ms = 2.5 s, from the warm run alone. Review round 1 (R1-1)
//     applied the rule to every PW1 reading: the cold run's worst case is
//     over 15 s, twice that is over the cap, so the wait is the cap, 10 s.
//     The gate's clipboard-route presses stand at 10 s: the poll stops at
//     the placeholder, and every one of them showed it within 2.5 s.
//   GATE (one job, the Windows runner, --retries=0): the load grader at 0,
//     1, 2 and 3 busy processes (node, normal priority), each early and late
//     (GRADES), each count running BUSY_SETTLE_MS before its press (gate run
//     46129823039 started them at the press, and every path-route press
//     there pasted and sent, the paste meeting 61 to 75% total CPU). C2 on the path route (the test switch, CCC_E2E_PATH_ROUTE=1,
//     in its own app and serial group): each press recorded as a reading,
//     never asserted; then ONE assertion: at 3 busy processes at least one of
//     its two presses reaches Codex as text (main's image rule read "the
//     composer held N characters of the path, as text"; in run 46084512071
//     both did). C2 on the clipboard route (its own app and group): every
//     press asserted, as part two's C2 is. C4, Claude Code Snap on the
//     clipboard route (its own app and group): every press asserted, its
//     turn carrying the picture by its decoded pixels. A red on the clipboard
//     route, or in C4, is diagnosed, never retried. C2's bounds are
//     beta.20's (PRESS_TEST_MS, CODEX_TURN_MS); C4's are PRESS_TEST_MS plus 2
//     times CLAUDE_TURN_MS, never raised. The CPU is read through every group
//     (typeperf, once a second) for the diagnosis.
//   CLAUDE CODE'S OWN READ, ON A WARM POWERSHELL CACHE: Claude Code reads the
//     clipboard by Windows PowerShell 5.1 (WinForms Clipboard.GetImage). In
//     probe run 46128029706, with the app on a fresh, empty module analysis
//     cache (coldPowerShellEnv, beta.20's D1 condition for the first app), it
//     took the key ("Pasting..." in its footer) and its read did not end
//     within 15 s in 7 of 8 presses (one showed its placeholder 13.7 s after
//     its key): a cold cmdlet lookup took 21.6 to 27.4 s on this runner
//     (46040073797). A user's computer keeps that cache, so Claude Code's PW1
//     and C4 run on the runner's own cache, warmed first by the same command
//     (warmClaudeClipboardRead); the Codex groups keep beta.20's cold cache
//     (Codex reads the clipboard without PowerShell). This condition was
//     added after run 46128029706 measured, and it sets no wait: the app's
//     wait follows every PW1 reading, the cold run's included (R1-1 above).

const PASTE = process.env.SNAP_E2E_PASTE ?? ''
/** The folder holding the job's Claude Code 2.1.332 (claude.exe), or ''. */
const CLAUDE_DIR = process.env.SNAP_E2E_CLAUDE ? path.resolve(process.env.SNAP_E2E_CLAUDE) : ''
const CLAUDE_VERSION_UNDER_TEST = '2.1.332'
/** Fixed before PW1 runs (plan 2.3). */
const CLAUDE_TURN_MS = 20_000
/** PW1's bound on one key's placeholder (a measurement, not a wait the app keeps). */
const PW1_PLACEHOLDER_BOUND_MS = 15_000
/** The load grader, each count early and late. */
const GRADES = [0, 1, 2, 3, 3, 2, 1, 0] as const
/** How long each count of busy processes runs before its press, so the press
 *  meets a steady load, not the processes' start. Gate run 46129823039
 *  started them at the press: the paste met 61 to 75% total CPU at 3 busy
 *  processes (94% only after it), where run 46084512071's path-route
 *  failures met 86 to 94%. The same for every group, the clipboard route's
 *  and Claude Code's included. */
const BUSY_SETTLE_MS = 5_000
const PASTE_OUT = path.join(OUT, 'paste')
const CLAUDE_FAKE_KEY = 'sk-ant-e2e-fake-key-not-real-0000000000'
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
const CTRL_V_KEY = '\u0016'
const IMAGE_RE = /\[Image #\d{1,3}\]/g

/** A minimal environment for a process this part starts (never the runner's whole one). */
const minimalEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  SystemRoot: SYSTEM_ROOT, windir: SYSTEM_ROOT, PATH: path.join(SYSTEM_ROOT, 'System32'), ...extra,
})

/** `count` busy processes (node, normal priority), until stopped. */
function busy(count: number): () => number {
  const kids = Array.from({ length: count }, () => spawn(process.execPath, ['-e', 'for(;;){}'], { windowsHide: true, stdio: 'ignore', env: minimalEnv() }))
  return () => { let k = 0; for (const c of kids) { try { if (c.kill()) k++ } catch { /* gone */ } } return k }
}

/** The CPU read once a second into a CSV until stopped (typeperf). */
function cpuSampler(name: string): () => void {
  fs.mkdirSync(PASTE_OUT, { recursive: true })
  const child = spawn(path.join(SYSTEM_ROOT, 'System32', 'typeperf.exe'), ['\\Processor(_Total)\\% Processor Time', '\\System\\Processor Queue Length', '-si', '1', '-f', 'CSV', '-o', path.join(PASTE_OUT, `${name}-cpu.csv`), '-y'], { windowsHide: true, stdio: 'ignore', env: minimalEnv() })
  return () => { try { child.kill() } catch { /* gone */ } }
}

/** Run a PowerShell script (Windows PowerShell 5.1, -Sta) with a minimal
 *  environment; answers its output. */
function powershell(script: string): string {
  const temp = path.join(PASTE_OUT, 'ps-temp')
  fs.mkdirSync(temp, { recursive: true })
  const r = spawnSync(path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true, env: minimalEnv({ TEMP: temp, TMP: temp, PSModulePath: path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }),
  })
  return `${r.stdout ?? ''}${r.stderr ? ` [stderr] ${r.stderr}` : ''}`.trim()
}

/** PW2's Win32 reading of the clipboard: its formats, and what GetImage reads. */
function win32ClipboardReading(): { formats: string; getImage: string } {
  const formats = powershell([
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices; using System.Text;',
    'public static class Clip {',
    '  [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool CloseClipboard();',
    '  [DllImport("user32.dll")] public static extern uint EnumClipboardFormats(uint f);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClipboardFormatName(uint f, StringBuilder s, int n);',
    '}',
    '"@',
    '$out = @()',
    'if ([Clip]::OpenClipboard([IntPtr]::Zero)) { try { $f = 0; while (($f = [Clip]::EnumClipboardFormats($f)) -ne 0) { $sb = New-Object System.Text.StringBuilder 256; $n = [Clip]::GetClipboardFormatName($f, $sb, 256); $out += ("{0}={1}" -f $f, $(if ($n -gt 0) { $sb.ToString() } else { "" })) } } finally { [void][Clip]::CloseClipboard() } } else { $out += "not opened" }',
    '$out -join ","',
  ].join('\n'))
  const getImage = powershell('Add-Type -AssemblyName System.Windows.Forms; $i = [System.Windows.Forms.Clipboard]::GetImage(); if ($i) { "{0}x{1} {2}" -f $i.Width, $i.Height, $i.PixelFormat } else { "none" }')
  return { formats, getImage }
}

/** Write a picture onto the clipboard in main as the app's writer does (one
 *  clipboard.write of one image/png item): a 320 by 200 pattern of its own
 *  for `seed`, opaque. Answers the PNG read back (the reference). */
async function writePicture(app: ElectronApplication, seed: number): Promise<Buffer> {
  await app.evaluate(async ({ clipboard, nativeImage, ClipboardItem }, k) => {
    const width = 320
    const height = 200
    const bgra = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      bgra[i] = (x * 3 + k * 41) & 0xff; bgra[i + 1] = (y * 5 + k * 17) & 0xff; bgra[i + 2] = ((x ^ y) + k * 29) & 0xff; bgra[i + 3] = 255
    }
    const png = nativeImage.createFromBitmap(bgra, { width, height }).toPNG()
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
  }, seed)
  const back = await clipboardPng(app)
  if (!back) throw new Error('no picture on the clipboard after the write')
  return back
}

/** How many "[Image #N]" the tab on screen shows. */
const placeholdersOnScreen = async (): Promise<number> => ((await terminalRows(ctx!.page)).join('\n').match(IMAGE_RE) ?? []).length

/** Every request the stand-in saw since `from` that carries `rgba` (a
 *  picture by its decoded pixels). */
const requestsWith = (from: number, api: '/v1/responses' | '/v1/messages', rgba: string) => standInEvents.slice(from).filter((e) => e.ev === 'request' && e.path === api && (e.images ?? []).some((i) => i.rgbaSha256 === rgba))

/** Claude Code's config folder for the app's tab: onboarding done, the
 *  made-up key approved, the project trusted (as probe P11 seeds it). */
function seedClaudeConfig(dir: string, projectDir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const proj = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1, allowedTools: [] }
  // Every spelling of the folder: the temp folder can be named by its short
  // name (RUNNER~1) here and by its long one in Claude Code (probe run
  // 46127035163), each with either separator.
  const spellings = new Set<string>([projectDir])
  try { spellings.add(fs.realpathSync.native(projectDir)) } catch { /* the name given */ }
  try { spellings.add(fs.realpathSync(projectDir)) } catch { /* the name given */ }
  const projects: Record<string, typeof proj> = {}
  for (const p of spellings) { projects[p] = proj; projects[p.replace(/\\/g, '/')] = proj }
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: CLAUDE_VERSION_UNDER_TEST, theme: 'dark', numStartups: 1, autoUpdates: false,
    hasAcknowledgedCostThreshold: true, customApiKeyResponses: { approved: [CLAUDE_FAKE_KEY.slice(-20)], rejected: [] },
    projects,
  }, null, 2))
}

/** Launch an app with a Codex tab on the job's Codex 0.157.1, as part two's;
 *  `pathRoute` sets the test switch (the app is not packaged). */
async function launchCodexPasteApp(name: string, pathRoute: boolean): Promise<{ port: number; standIn: StandIn; projectDir: string }> {
  ctx = undefined
  codexSent.length = 0
  standInEvents.length = 0
  mainLines.length = 0
  expect(CODEX_PREFIX, 'SNAP_E2E_CODEX names the Codex the job installed').not.toBe('')
  const standIn = createModelStandIn({ onEvent: (e) => { standInEvents.push(e) } })
  const port = await standIn.listen()
  let projectDir = ''
  ctx = await launchIsolatedApp({
    seedExtra: (dataDir) => {
      chooseSnap(dataDir, 'new')
      seedCodexAccount(dataDir, { fake: false, domTerminal: true, method: 'apiKey' })
      projectDir = path.join(dataDir, 'codex-project')
      fs.mkdirSync(projectDir, { recursive: true })
      const realm = realmDirOf(dataDir)
      fs.writeFileSync(path.join(realm, 'config.toml'), codexConfigToml(port, projectDir))
      const login = runCodexCli(dataDir, realm, ['login', '--with-api-key'], `${CODEX_FAKE_KEY}\n`)
      if (login.status !== 0) throw new Error(`the made-up key's sign-in failed (exit ${login.status}): ${login.stderr}`)
    },
    env: (dataDir) => ({
      PATH: [CODEX_PREFIX, ...pathWithoutCodex(process.env.PATH ?? '')].join(path.delimiter),
      CODEX_HOME: (() => { const d = path.join(dataDir, 'codex-home'); fs.mkdirSync(d, { recursive: true }); return d })(),
      CCC_E2E_SNAP_HELPER: HELPER,
      ...DEAD_PROXY,
      ...coldPowerShellEnv(dataDir),
      CCC_E2E_PATH_ROUTE: pathRoute ? '1' : undefined,
    }),
  })
  ctx.app.on('console', (m) => { mainLines.push(m.text()) })
  await placeAppWindow()
  readings[`paste_${name}_launched`] = true
  return { port, standIn, projectDir }
}

/** Open the Codex tab and wait for Codex at rest with its warning count (part two's C1). */
async function openCodexPasteTab(projectDir: string, label: string): Promise<void> {
  const page = ctx!.page
  await createCodexConfig(page, { label, dir: projectDir })
  await openSession(page, label)
  codexSid = await activeSessionId(page)
  await expect(snapButton()).toBeVisible({ timeout: TAB_MS })
  const answered: FirstScreenAnswer[] = []
  const deadline = Date.now() + CODEX_START_MS
  while (Date.now() < deadline) {
    const next = nextFirstScreen(await terminalRows(page), answered)
    if (next.act === 'answer') { answered.push({ kind: next.kind, screen: await answerFirstScreen(page, codexSid, next.kind) }); continue }
    if (atRestWithCount(await codexScreen())) { await sleep(300); if (atRestWithCount(await codexScreen())) return }
    await sleep(250)
  }
  throw new Error(`no Codex composer with its count within ${CODEX_START_MS} ms:\n${await codexScreen()}`)
}

/** Claude Code's clipboard read, run once outside the app on the runner's
 *  own module analysis cache (the default one, under the runner's
 *  LOCALAPPDATA, which the app's Claude Code reads too), so the cache is
 *  warm as on a user's computer. Answers the time it took and its output. */
function warmClaudeClipboardRead(): { ms: number; out: string } {
  const temp = path.join(PASTE_OUT, 'ps-warm-temp')
  fs.mkdirSync(temp, { recursive: true })
  const t0 = Date.now()
  const r = spawnSync(path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Sta', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $i = [System.Windows.Forms.Clipboard]::GetImage(); if ($i) { "image" } else { "none" }'], {
    encoding: 'utf8', timeout: 180_000, windowsHide: true,
    env: minimalEnv({ TEMP: temp, TMP: temp, ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}), ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}), ...(process.env.PSModulePath ? { PSModulePath: process.env.PSModulePath } : {}) }),
  })
  return { ms: Date.now() - t0, out: `${r.stdout ?? ''}`.trim().slice(0, 200) }
}

/** Launch an app whose Claude Code is the job's 2.1.332, pointed at the stand-in. */
async function launchClaudePasteApp(name: string): Promise<{ standIn: StandIn; projectDir: string }> {
  ctx = undefined
  standInEvents.length = 0
  mainLines.length = 0
  expect(CLAUDE_DIR, 'SNAP_E2E_CLAUDE names the Claude Code the job installed').not.toBe('')
  expect(fs.existsSync(path.join(CLAUDE_DIR, 'claude.exe')), `no claude.exe in ${CLAUDE_DIR}`).toBe(true)
  // Twice: the first run writes the cache, the second reads it (both timed).
  readings[`paste_${name}_warmup`] = [warmClaudeClipboardRead(), warmClaudeClipboardRead()]
  const standIn = createModelStandIn({ onEvent: (e) => { standInEvents.push(e) } })
  const port = await standIn.listen()
  let projectDir = ''
  ctx = await launchIsolatedApp({
    seedExtra: (dataDir) => {
      chooseSnap(dataDir, 'new')
      seedDomTerminal(dataDir)
      projectDir = path.join(dataDir, 'claude-project')
      fs.mkdirSync(projectDir, { recursive: true })
      seedClaudeConfig(path.join(dataDir, 'claude-config'), projectDir)
    },
    env: (dataDir) => ({
      PATH: pathWith(CLAUDE_DIR),
      CLAUDE_CONFIG_DIR: path.join(dataDir, 'claude-config'),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: CLAUDE_FAKE_KEY,
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CCC_E2E_SNAP_HELPER: HELPER,
      ...DEAD_PROXY,
      // No coldPowerShellEnv: the runner's own, warmed cache (see the header).
    }),
  })
  ctx.app.on('console', (m) => { mainLines.push(m.text()) })
  await placeAppWindow()
  readings[`paste_${name}_launched`] = true
  return { standIn, projectDir }
}

/** Claude Code's prompt box on screen: a rule, the pointer row, a rule. */
const CLAUDE_READY_RE = /(?:^|\n) {0,2}\u2500{8,} *\n {0,2}[\u276f>](?: [^\n]*)?\n {0,2}\u2500{8,}/u
/** Claude Code's first screens and what answers each (as probe P11 answers them). */
const CLAUDE_FIRST_SCREENS: Array<{ re: RegExp; keys: string[] }> = [
  // 2.1.332's folder trust (probe run 46127035163): "No, exit" first and
  // highlighted, "Yes, I trust this folder" under it.
  { re: /No, exit[\s\S]*Yes, I trust this folder/, keys: ['\u001b[B', '\r'] },
  { re: /text style|Dark mode/i, keys: ['\r'] },
  { re: /use this API key/i, keys: ['\u001b[A', '\r'] },
  { re: /trust (the files in )?this folder/i, keys: ['\r'] },
  { re: /Press Enter to continue/i, keys: ['\r'] },
  // A picker not recorded yet: its own default, as Enter takes it.
  { re: /Enter to (?:confirm|select|continue)/i, keys: ['\r'] },
]
let claudeSid = ''
/** Claude Code at its prompt, at rest (no turn running), on two reads. */
async function claudeAtRest(): Promise<boolean> {
  const read = async () => { const t = await terminalText(ctx!.page); return CLAUDE_READY_RE.test(t) && !/esc to interrupt/i.test(t) }
  if (!(await read())) return false
  await sleep(300)
  return read()
}

/** Open a Claude Code tab (as D1 does) and wait for its prompt, answering its first screens. */
async function openClaudePasteTab(projectDir: string, label: string): Promise<void> {
  const page = ctx!.page
  await page.locator('[data-testid="panel-tab-saved"]').click()
  await page.locator('[data-testid="new-button"]').click()
  await page.locator('[data-testid="new-menu-config"]').click()
  await expect(page.locator('text=New saved config')).toBeVisible({ timeout: TAB_MS })
  await page.locator('[role="radiogroup"][aria-label="Provider"] label:has(input[value="claude"])').click()
  await page.locator('[role="radiogroup"][aria-label="Connection"] label:has(input[value="local"])').click()
  await page.locator('input[placeholder*="path"]').first().fill(projectDir)
  await page.locator('input[placeholder="e.g. App Dev"]').fill(label)
  await page.locator('[data-testid="session-dialog-submit"]').click()
  await expect(page.locator('text=New saved config')).toHaveCount(0, { timeout: TAB_MS })
  await expect(snapButton()).toBeVisible({ timeout: TAB_MS })
  claudeSid = await activeSessionId(page)
  const answered: string[] = []
  const shots: Array<{ atMs: number; screen: string[] }> = []
  const started = Date.now()
  let nextShot = 0
  const deadline = Date.now() + CODEX_START_MS
  let atRest = false
  try {
    while (Date.now() < deadline) {
      const text = await terminalText(page)
      if (Date.now() >= nextShot) { shots.push({ atMs: Date.now() - started, screen: text.split('\n').filter((l) => l.trim()).slice(-30) }); nextShot = Date.now() + 5_000 }
      const first = CLAUDE_FIRST_SCREENS.find((s) => s.re.test(text) && answered.filter((a) => a === s.re.source).length < 3)
      if (first && !CLAUDE_READY_RE.test(text)) {
        answered.push(first.re.source)
        for (const k of first.keys) { await ptyWrite(page, claudeSid, k); await sleep(300) }
        await sleep(700)
        continue
      }
      if (await claudeAtRest()) { atRest = true; return }
      await sleep(250)
    }
    throw new Error(`no Claude Code prompt within ${CODEX_START_MS} ms; the screen:\n${(await terminalText(page).catch(() => 'unread')).split('\n').filter((l) => l.trim()).slice(-25).join('\n')}`)
  } finally {
    const start = {
      atRest,
      startMs: Date.now() - started,
      answered,
      shots,
      screenAtEnd: (await terminalText(page).catch((e: Error) => `unread: ${e.message}`)).split('\n').filter((l) => l.trim()),
      requests: standInEvents.filter((e) => e.ev === 'request').map(({ t, path: p, kind, model, tools, stream }) => ({ t, path: p, kind, model, tools, stream })),
      mainLines: mainLines.filter((l) => /claude|paste|launch|pty|spawn|refus/i.test(l)).slice(-80),
    }
    readings.claudeStart = start
    savePaste(`${label.replace(/\s+/g, '-').toLowerCase()}-start`, start)
  }
}

/** One PW1 press: a picture written, the key typed, the time to a new
 *  placeholder; then the sentence and Enter, and whether the turn carried
 *  the picture by its pixels. */
async function pw1Press(cli: 'codex' | 'claude', key: string, seed: number, grade: number): Promise<Record<string, unknown>> {
  const sid = cli === 'codex' ? codexSid : claudeSid
  const api = cli === 'codex' ? '/v1/responses' : '/v1/messages'
  const r: Record<string, unknown> = { cli, key: key === ESC_V ? 'ESC v' : 'Ctrl+V', grade }
  const ref = pngPixelHashes(await writePicture(ctx!.app, seed))
  r.refUnread = ref.unread ?? null
  const before = await placeholdersOnScreen()
  const requestsBefore = standInEvents.length
  const stop = busy(grade)
  if (grade > 0) await sleep(BUSY_SETTLE_MS)
  const t0 = performance.now()
  try {
    await ptyWrite(ctx!.page, sid, key)
    let shownMs: number | null = null
    while (performance.now() - t0 < PW1_PLACEHOLDER_BOUND_MS) {
      if ((await placeholdersOnScreen()) > before) { shownMs = Math.round(performance.now() - t0); break }
      await sleep(25)
    }
    r.placeholderMs = shownMs
    if (shownMs === null) {
      r.screen = (await terminalRows(ctx!.page)).filter((l) => l.trim()).slice(-12)
      return r
    }
    await ptyWrite(ctx!.page, sid, ` p11 probe pw-${cli}-${seed}`)
    await sleep(500)
    await ptyWrite(ctx!.page, sid, '\r')
    const turnT0 = performance.now()
    while (performance.now() - turnT0 < (cli === 'codex' ? CODEX_TURN_MS : CLAUDE_TURN_MS)) {
      if (ref.rgbaSha256 && requestsWith(requestsBefore, api, ref.rgbaSha256).length > 0) break
      await sleep(100)
    }
    const carried = ref.rgbaSha256 ? requestsWith(requestsBefore, api, ref.rgbaSha256).length > 0 : false
    r.turnCarriedPicture = carried
    r.turnMs = Math.round(performance.now() - turnT0)
    const sent = standInEvents.slice(requestsBefore).filter((e) => e.ev === 'request' && e.path === api).map((e) => (e.images ?? []).slice(-1).map((i) => ({ kind: i.kind, width: i.width, height: i.height, rgb: i.rgbSha256 === ref.rgbSha256, unread: i.pixelsUnread })))
    r.turnImages = sent
    const restT0 = performance.now()
    while (performance.now() - restT0 < 20_000) {
      if (cli === 'codex' ? atRestWithCount(await codexScreen()) : await claudeAtRest()) break
      await sleep(250)
    }
    return r
  } finally {
    r.busyKilled = stop()
  }
}

function savePaste(name: string, value: unknown): void {
  fs.mkdirSync(PASTE_OUT, { recursive: true })
  fs.writeFileSync(path.join(PASTE_OUT, `${name}.json`), JSON.stringify(value, null, 2))
  console.log(`[snap-e2e] paste ${name} ${JSON.stringify(value)}`)
}

const pasteSkips = (want: 'probe' | 'gate') => {
  test.skip(process.platform !== 'win32', 'Snap on Windows: the runner is Windows')
  test.skip(!HELPER || PASTE !== want, `the snap-e2e job with snap_e2e_paste=${want} only (ci.yml)`)
}

test.describe('PW2: one Electron clipboard write of image/png, read back as Win32 formats', () => {
  test.describe.configure({ mode: 'serial' })
  pasteSkips('probe')
  let stopCpu: () => void = () => {}
  test.beforeAll(async () => {
    test.setTimeout(LAUNCH_MS + 30_000)
    stopCpu = cpuSampler('pw2')
    await launchCodexPasteApp('pw2', false)
  })
  test.afterAll(async () => { stopCpu(); await closeIsolatedApp(ctx); ctx = undefined })

  test('PW2: the formats one write leaves, and what GetImage reads', async () => {
    test.setTimeout(120_000)
    const png = await writePicture(ctx!.app, 7)
    const reading = { pngBytes: png.length, size: pngSize(png), ...win32ClipboardReading() }
    const names = reading.formats.split(',')
    const out = { ...reading, cfDib: names.some((f) => f.startsWith('8=')), cfDibV5: names.some((f) => f.startsWith('17=')), registeredPng: names.some((f) => /=PNG$/.test(f)) }
    savePaste('pw2', out)
    readings.pw2 = out
  })
})

for (const cli of ['codex', 'claude'] as const) {
  test.describe(`PW1 ${cli}: the time from the paste key to the placeholder, at 0 to 3 busy processes`, () => {
    test.describe.configure({ mode: 'serial' })
    pasteSkips('probe')
    const rows: Array<Record<string, unknown>> = []
    let standIn: StandIn | undefined
    let stopCpu: () => void = () => {}
    test.beforeAll(async () => {
      test.setTimeout(LAUNCH_MS + CODEX_START_MS + 60_000)
      stopCpu = cpuSampler(`pw1-${cli}`)
      if (cli === 'codex') {
        const a = await launchCodexPasteApp('pw1-codex', false)
        standIn = a.standIn
        await openCodexPasteTab(a.projectDir, 'PW1 Codex')
      } else {
        const a = await launchClaudePasteApp('pw1-claude')
        standIn = a.standIn
        await openClaudePasteTab(a.projectDir, 'PW1 Claude')
      }
    })
    test.afterAll(async () => {
      test.setTimeout(120_000)
      stopCpu()
      savePaste(`pw1-${cli}`, { rows, warmup: readings[`paste_pw1-${cli}_warmup`] ?? null, mainLines: mainLines.filter((l) => /paste|codex|claude/i.test(l)).slice(-80) })
      await closeIsolatedApp(ctx)
      ctx = undefined
      await standIn?.close()
    })

    test(`PW1 ${cli}: ESC v and Ctrl+V at each grade`, async () => {
      test.setTimeout(4 * 2 * (PW1_PLACEHOLDER_BOUND_MS + CLAUDE_TURN_MS + 25_000) + 60_000)
      let seed = cli === 'codex' ? 10 : 50
      for (const grade of [0, 1, 2, 3]) {
        for (const key of [ESC_V, CTRL_V_KEY]) {
          rows.push(await pw1Press(cli, key, ++seed, grade))
        }
      }
    })
  })
}

/** One press of the load grader: Snap, Rectangle, at `grade` busy processes,
 *  the drag moved a step a run so each press's picture is its own. */
async function gradedRectangle(i: number, grade: number, body: (p: { before: string[]; turnsBefore: number; answeredAt: number; width: number; height: number; from: Mark }) => Promise<void>): Promise<void> {
  const stop = busy(grade)
  try {
    if (grade > 0) await sleep(BUSY_SETTLE_MS)
    const before = jpegs()
    const turnsBefore = codexTurns().length
    const { overlay, display, start, from } = await pressNew({ prefix: 'paste' })
    const at = { x: start.x + (i % 4) * PICTURE_STEP, y: start.y + Math.floor(i / 4) * PICTURE_STEP }
    const { width, height } = rectangleSize(at, DRAG, display.scaleFactor)
    await overlay.mouse.move(at.x, at.y)
    await overlay.mouse.down()
    await overlay.mouse.move(at.x + DRAG.width / 2, at.y + DRAG.height / 2, { steps: 4 })
    await overlay.mouse.move(at.x + DRAG.width, at.y + DRAG.height, { steps: 4 })
    await overlay.mouse.up()
    const answeredAt = performance.now()
    await answer(overlay, () => overlay.keyboard.press('Enter'))
    await expectOverlayGone()
    await body({ before, turnsBefore, answeredAt, width, height, from })
  } finally {
    stop()
  }
}

test.describe('GATE C2 on the path route (the test switch): each press a reading, then one assertion', () => {
  test.describe.configure({ mode: 'serial' })
  pasteSkips('gate')
  const rows: Array<Record<string, unknown>> = []
  let standIn: StandIn | undefined
  let stopCpu: () => void = () => {}
  test.beforeAll(async () => {
    test.setTimeout(LAUNCH_MS + CODEX_START_MS + 60_000)
    stopCpu = cpuSampler('gate-c2-path')
    const a = await launchCodexPasteApp('gate-c2-path', true)
    standIn = a.standIn
    await openCodexPasteTab(a.projectDir, 'Gate C2 path')
  })
  test.afterAll(async () => {
    test.setTimeout(120_000)
    stopCpu()
    savePaste('gate-c2-path', rows)
    await closeIsolatedApp(ctx)
    ctx = undefined
    await standIn?.close()
  })

  GRADES.forEach((grade, i) => {
    test(`C2 path route, press ${i + 1}, ${grade} busy: a reading`, async () => {
      test.setTimeout(PRESS_TEST_MS + 2 * CODEX_TURN_MS)
      const r: Record<string, unknown> = { press: i + 1, grade, startedAt: Date.now() }
      try {
        await expectCodexAtRestWithCount()
        await gradedRectangle(i, grade, async ({ before, turnsBefore, from }) => {
          await expect.poll(() => jpegs().filter((f) => !before.includes(f)).length, { timeout: OVERLAY_MS, intervals: [50] }).toBe(1)
          const file = path.join(shotsDir(), jpegs().find((f) => !before.includes(f))!)
          const sha = sha256Of(file)
          await expect.poll(() => linesSince(from, '[codex-image]').some((l) => / pasted and sent; | not pasted /.test(l)), { timeout: CODEX_TURN_MS, intervals: [100] }).toBe(true)
          const lines = linesSince(from, '[codex-image]')
          r.lines = lines
          r.pasted = lines.some((l) => / pasted and sent; /.test(l))
          r.asText = lines.some((l) => /characters of the path, as text/.test(l))
          await expect.poll(() => codexTurns().length, { timeout: CODEX_TURN_MS, intervals: [100] }).toBeGreaterThan(turnsBefore)
          r.turnCarriedPicture = (codexTurns()[turnsBefore].images ?? []).some((im) => im.sha256 === sha)
        })
      } catch (e) {
        r.error = (e as Error).message.split('\n')[0].slice(0, 300)
      } finally {
        r.endedAt = Date.now()
        rows.push(r)
        await expect.poll(async () => atRestWithCount(await codexScreen()), { timeout: CODEX_TURN_MS, intervals: [250] }).toBe(true).catch(() => { r.notAtRestAfter = true })
      }
    })
  })

  test('C2 path route: at 3 busy processes at least one of its two presses reaches Codex as text', () => {
    const at3 = rows.filter((r) => r.grade === 3)
    expect(at3.length, 'both presses at 3 busy processes were read').toBe(2)
    expect(at3.some((r) => r.asText === true), `the path route's presses at 3 busy processes: ${JSON.stringify(at3)}`).toBe(true)
  })
})

test.describe('GATE C2 on the clipboard route: every press at every grade reaches Codex as its picture', () => {
  test.describe.configure({ mode: 'serial' })
  pasteSkips('gate')
  let standIn: StandIn | undefined
  let stopCpu: () => void = () => {}
  test.beforeAll(async () => {
    test.setTimeout(LAUNCH_MS + CODEX_START_MS + 60_000)
    stopCpu = cpuSampler('gate-c2-clipboard')
    const a = await launchCodexPasteApp('gate-c2-clipboard', false)
    standIn = a.standIn
    await openCodexPasteTab(a.projectDir, 'Gate C2 clipboard')
  })
  test.afterAll(async () => {
    test.setTimeout(120_000)
    stopCpu()
    savePaste('gate-c2-clipboard', { readings: Object.fromEntries(Object.entries(readings).filter(([k]) => k.startsWith('codex'))), requests: standInEvents.filter((e) => e.ev === 'request').map(({ t, path: p, kind, images }) => ({ t, path: p, kind, images })) })
    await closeIsolatedApp(ctx)
    ctx = undefined
    await standIn?.close()
  })

  GRADES.forEach((grade, i) => {
    test(`C2 clipboard route, press ${i + 1}, ${grade} busy: one turn carrying the picture by its pixels`, async () => {
      test.setTimeout(PRESS_TEST_MS + 2 * CODEX_TURN_MS)
      await expectCodexAtRestWithCount()
      await gradedRectangle(i, grade, async ({ before, turnsBefore, answeredAt, width, height, from }) => {
        await expectSentToCodex(before, turnsBefore, answeredAt, width, height, from, /^\[snap\] new engine: a rectangle of display \d+, /)
      })
    })
  })
})

test.describe('GATE C4: Claude Code Snap on the clipboard route, every press at every grade', () => {
  test.describe.configure({ mode: 'serial' })
  pasteSkips('gate')
  let standIn: StandIn | undefined
  let stopCpu: () => void = () => {}
  const rows: Array<Record<string, unknown>> = []
  test.beforeAll(async () => {
    test.setTimeout(LAUNCH_MS + CODEX_START_MS + 60_000)
    stopCpu = cpuSampler('gate-c4')
    const a = await launchClaudePasteApp('gate-c4')
    standIn = a.standIn
    await openClaudePasteTab(a.projectDir, 'Gate C4 Claude')
  })
  test.afterAll(async () => {
    test.setTimeout(120_000)
    stopCpu()
    savePaste('gate-c4', { rows, warmup: readings['paste_gate-c4_warmup'] ?? null, mainLines: mainLines.filter((l) => /paste|claude/i.test(l)).slice(-80) })
    await closeIsolatedApp(ctx)
    ctx = undefined
    await standIn?.close()
  })

  const sent: string[] = []
  GRADES.forEach((grade, i) => {
    test(`C4 press ${i + 1}, ${grade} busy: the picture on the clipboard, Claude Code's key, and a turn carrying the picture by its pixels`, async () => {
      test.setTimeout(PRESS_TEST_MS + 2 * CLAUDE_TURN_MS)
      const r: Record<string, unknown> = { press: i + 1, grade }
      rows.push(r)
      await expect.poll(claudeAtRest, { timeout: CLAUDE_TURN_MS, intervals: [250] }).toBe(true)
      const requestsBefore = standInEvents.length
      await gradedRectangle(i, grade, async ({ before, answeredAt, width, height, from }) => {
        await expect.poll(() => jpegs().filter((f) => !before.includes(f)).length, { timeout: OVERLAY_MS, intervals: [50] }).toBe(1)
        r.enterToFileMs = Math.round(performance.now() - answeredAt)
        await expect.poll(() => linesSince(from, `[paste] ${claudeSid}: Snap:`).length, { timeout: PRESS_TEST_MS, intervals: [100] }).toBe(1)
        r.pasteLine = linesSince(from, `[paste] ${claudeSid}: Snap:`)[0]
        expect(r.pasteLine).toBe(`[paste] ${claudeSid}: Snap: sent`)
        const png = await clipboardPng(ctx!.app)
        expect(png, 'a picture on the clipboard').not.toBeNull()
        expect(pngSize(png!)).toEqual({ width, height })
        const ref = pngPixelHashes(png!)
        expect(ref.unread, 'the clipboard picture decodes').toBeUndefined()
        expect(sent, 'this press\'s picture differs from every earlier press\'s').not.toContain(ref.rgbaSha256)
        sent.push(ref.rgbaSha256!)
        const turnT0 = performance.now()
        try {
          await expect.poll(() => requestsWith(requestsBefore, '/v1/messages', ref.rgbaSha256!).length, { timeout: CLAUDE_TURN_MS, intervals: [100] }).toBeGreaterThan(0)
        } finally {
          r.fileToTurnMs = Math.round(performance.now() - turnT0)
          r.turnImages = standInEvents.slice(requestsBefore).filter((e) => e.ev === 'request' && e.path === '/v1/messages').map((e) => (e.images ?? []).slice(-1).map((im) => ({ kind: im.kind, width: im.width, height: im.height, rgbaEqual: im.rgbaSha256 === ref.rgbaSha256, rgbEqual: im.rgbSha256 === ref.rgbSha256, unread: im.pixelsUnread })))
        }
      })
    })
  })
})
