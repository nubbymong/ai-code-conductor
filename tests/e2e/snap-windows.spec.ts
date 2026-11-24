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
 *      120 times the display's scale), not all black; its path reaches the tab
 *      as main's paste, then the sentence and Enter (since X1.2; the run ends
 *      once that Enter is typed); one line names a rectangle of that size, the
 *      helper's time
 *      (within the 2 s bound) and one entry per display at its physical size
 *      and scale; no overlay page is left, the button is usable again, and no
 *      press folder is left. Run 1 keeps a picture of the overlay mid-drag
 *      (overlay-mid-drag.png, the runner's desktop only).
 *   D3 WHOLE SCREEN, 3 runs: Whole screen gives one new JPEG of the display at
 *      its physical size (the longer side capped at 1920), not all black; its
 *      path reaches the tab as main's paste, then the sentence and Enter (the
 *      run ends once that Enter is typed); one line names the whole screen.
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
 * button showed (PowerShell's cold start, then the launch line), within
 * TAB_MS: under three times that reading, not ten, and not raised.
 * With X1.2 in (the beta.16 aggregate, run 45304028588 on 5a2f0f41), a
 * picture's sentence follows its paste by 1.5 s and its Enter by 2.2 s, and a
 * picture pressed meanwhile waited behind the one before it: 82 to 1818 ms
 * from the file to its path. Each picture test now ends at its own Enter,
 * within OVERLAY_MS: about four and a half times that 2.2 s, not ten, and not
 * raised.
 * The readings go to the log and to $SNAP_E2E_OUT/readings.json.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'

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
const push = (key: string, v: number) => { (readings[key] as number[]).push(v) }
let ctx: IsolatedApp | undefined
/** Every line main writes to its console (logInfo writes there too). */
const mainLines: string[] = []

/** A stand-in `claude`: every start is recorded in launches.jsonl beside it
 *  (its arguments, whether its input and output are a terminal, its pid);
 *  `--version` answers the app's floor; on a terminal it says it is ready,
 *  keeps what it is typed in typed.txt beside itself and echoes it, until its
 *  input ends; any other call ends at once. */
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
    "process.stdout.write('stand-in Claude Code ready' + String.fromCharCode(13, 10))",
    "process.stdin.on('data', (d) => { fs.appendFileSync(typed, d); process.stdout.write(d) })",
    "process.stdin.on('end', () => { record({ end: process.pid, at: Date.now() }); process.exit(0) })",
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'claude.cmd'), ['@ECHO off', `"${process.execPath}" "%~dp0stand-in-claude.js" %*`, ''].join('\r\n'))
  return dir
}
const standInDir = (dataDir: string) => path.join(dataDir, 'stand-in-claude')
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
 *  below the overlay's bar). */
async function pressNew(): Promise<{ overlay: Page; display: Disp; start: { x: number; y: number }; from: Mark }> {
  const { app, page } = ctx!
  const displays = await electronDisplays(app)
  await expect(snapButton()).toBeEnabled({ timeout: CANCEL_MS })
  const from = mark()
  await snapButton().click()
  const started = performance.now()
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await expect.poll(() => overlayPages(app).length, { timeout: OVERLAY_MS, intervals: [50] }).toBe(displays.length)
  const pages = overlayPages(app)
  for (const p of pages) await expect(p.locator('body.pictured')).toBeAttached({ timeout: OVERLAY_MS })
  push('overlayMs', Math.round(performance.now() - started))
  const ready = linesSince(from, '[snap] overlay pages ready').map((l) => /in (\d+) ms/.exec(l)?.[1]).filter(Boolean)
  if (ready.length) push('overlayReadyMs', Number(ready[0]))

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

/** The one JPEG a press saved, checked at its size and not all black, and its
 *  path typed into the tab. */
async function expectSaved(before: string[], answeredAt: number, width: number, height: number): Promise<void> {
  await expect.poll(() => jpegs().filter((f) => !before.includes(f)).length, { timeout: OVERLAY_MS, intervals: [50] }).toBe(1)
  push('enterToFileMs', Math.round(performance.now() - answeredAt))
  const savedAt = performance.now()
  const name = jpegs().find((f) => !before.includes(f))!
  const file = path.join(shotsDir(), name)
  const info = await jpegInfo(ctx!.app, file)
  expect(info.empty, name).toBe(false)
  expect({ width: info.width, height: info.height }, name).toEqual({ width, height })
  expect(info.lit, `${name}: pixels not near black, of ${info.pixels}`).toBeGreaterThan(info.pixels / 100)
  try {
    await expect.poll(typedText, { timeout: OVERLAY_MS, intervals: [50] }).toContain(`${path.sep}screenshots${path.sep}${name}`)
  } catch (err) {
    // What the tab showed and what the stand-in recorded, for the cause.
    readings.atTypedFailure = { terminal: await terminalText(ctx!.page).catch(() => 'unread'), launches: launches(), typed: typedText() }
    throw err
  }
  push('fileToTypedMs', Math.round(performance.now() - savedAt))
  // From the beta.16 aggregate (X1.2) main types a saved image into a local
  // Claude Code tab in three writes: the path as a bracketed paste, a space
  // and the sentence 1.5 s later, Enter 0.7 s after that (session-input
  // submitImage, IMAGE_PASTE_SETTLE_MS and IMAGE_ENTER_DELAY_MS). The press is
  // done when that Enter has reached the tab, so the next test reads a tab at
  // rest (D4's "types nothing") and the next picture's path does not wait
  // behind this one. An event wait inside the unchanged OVERLAY_MS.
  try {
    await expect.poll(() => {
      const t = typedText()
      const at = t.lastIndexOf(name)
      return at >= 0 && t.indexOf('\r', at) > at
    }, { timeout: OVERLAY_MS, intervals: [50] }).toBe(true)
  } catch (err) {
    readings.atEnterFailure = { terminal: await terminalText(ctx!.page).catch(() => 'unread'), typed: typedText() }
    throw err
  }
}

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

test.describe.configure({ mode: 'serial' })

test.describe('Snap on Windows', () => {
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
      }),
    })
    readings.launchMs = Math.round(performance.now() - started)
    ctx.app.on('console', (m) => { mainLines.push(m.text()) })
    // E2E_HEADLESS shows the app's window at -10000,-10000, off every display
    // (src/main/index.ts, ready-to-show). Snap pictures the screen, so the
    // window goes where a user has it: on the primary display, within its work
    // area. (Run 45269811648 read the window's right and bottom edges at
    // -8720 and -9280: -10000 plus 1280 by 720.)
    const area = await ctx.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
    const placed = { x: area.x, y: area.y, width: Math.min(1280, area.width), height: Math.min(720, area.height) }
    await (await ctx.app.browserWindow(ctx.page)).evaluate((w, b) => w.setBounds(b), placed)
    readings.appWindow = await (await ctx.app.browserWindow(ctx.page)).evaluate((w) => w.getBounds())
  })

  test.afterAll(async () => {
    test.setTimeout(120_000)
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'readings.json'), JSON.stringify(readings, null, 2))
    console.log(`[snap-e2e] readings ${JSON.stringify(readings)}`)
    await closeIsolatedApp(ctx)
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
      // The engine's crop (bmp.ts pixelRectFor): each edge rounded at the scale.
      const width = Math.round((start.x + DRAG.width) * s) - Math.round(start.x * s)
      const height = Math.round((start.y + DRAG.height) * s) - Math.round(start.y * s)
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
      // Today's cap (screenshot-capture.ts constrainToMaxDim): the longer side to 1920, the other kept in proportion.
      const capped = Math.max(pw, ph) <= MAX_DIM ? { width: pw, height: ph }
        : pw >= ph ? { width: MAX_DIM, height: Math.round(ph * MAX_DIM / pw) } : { width: Math.round(pw * MAX_DIM / ph), height: MAX_DIM }
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
})
