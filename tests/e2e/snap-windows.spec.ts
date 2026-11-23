/**
 * Snap on Windows, end to end on the GitHub runner's own desktop (plan
 * 2.1.3-beta.16, section A1; aicc_planning#401). Run ONLY by the snap-e2e job
 * in ci.yml (a dispatch), with `--retries=0 --workers=1`: never on the test
 * machine, never on a developer's PC (it presses Snap on the real screen).
 *
 * One app (launchIsolatedApp: every per-user folder in its own temp folder),
 * one Claude Code tab on a stand-in `claude` (the Snap button shows on agent
 * tabs only, session-capabilities.ts canSendImageToAgent; the runner has no
 * Claude Code), the built helper given through the test-only helper path
 * (CCC_E2E_SNAP_HELPER, from SNAP_E2E_HELPER), and the new Snap chosen
 * (magic-buttons.json, snapEngineWindows: 'new').
 *
 * DECISION LINES, fixed before the run (A1.1, the engine; the overlay, section
 * A2, is not in this build, so the engine's overlay fails by design and the
 * previous Snap takes every press, which is what these lines read):
 *   D1 START: the app starts and one Claude Code tab shows the Snap button.
 *   D2 NEW ENGINE, 3 runs: each Snap, Rectangle press runs the helper and logs
 *      one line naming its time (within the 2 s bound) and one entry per
 *      Electron display, at that display's physical size and scale; then the
 *      previous Snap opens, is cancelled, the button is usable again, and no
 *      press folder is left under the user data folder.
 *   D3 FORCED FAILURE, 3 runs: the test-only helper path names a helper that
 *      is not there: the line says the helper could not start (ENOENT), the
 *      previous Snap opens and is cancelled.
 *   D4 PREVIOUS CHOSEN: no new-engine line; the previous Snap opens and is
 *      cancelled.
 *   D5 HELPER DIRECT: the built helper's capture, run once from the test, has
 *      each picture's size equal its header and the line, each matched to one
 *      of Electron's displays by physical bounds and scale.
 *   The basic-user reading is the job's step before this one
 *   (scripts/ci/snap-basic-user.mjs). After the overlay is merged (A1.2), the
 *   drag, Whole screen and Escape lines and the overlay's picture join these.
 *
 * TIMEOUTS, set once from the skeleton's dispatch (run 45260050397, one
 * 1024x768 display at 100%): launch 2600 ms, tab 822 ms, the previous Snap's
 * window shown 783 ms after the press, cancelled in 157 ms, the helper's
 * capture 58 ms. Each bound below is about ten times its reading, and none is
 * raised to answer a red run (rule 27).
 * The readings go to the log and to $SNAP_E2E_OUT/readings.json.
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
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

// Bounds (see TIMEOUTS above).
const LAUNCH_MS = 30_000
const TAB_MS = 30_000
const OVERLAY_MS = 10_000
const CANCEL_MS = 5_000
const PRESS_TEST_MS = 30_000
/** The engine's own bound on the helper (helper-capture.ts HELPER_CAPTURE_BOUND_MS). */
const HELPER_BOUND_MS = 2_000

const readings: Record<string, unknown> = { pressMs: [] as number[], helperMs: [] as number[] }
let ctx: IsolatedApp | undefined
/** Every line main writes to its console (logInfo writes there too). */
const mainLines: string[] = []

/** A stand-in `claude`: answers `--version` with the app's floor; on a
 *  terminal it says it is ready and echoes what is typed until its input ends;
 *  any other call ends at once. */
function installStandInClaude(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'stand-in-claude.js'), [
    `if (process.argv[2] === '--version') { process.stdout.write('${CLAUDE_MIN_MANAGED_CLI_VERSION} (Claude Code)' + String.fromCharCode(10)); process.exit(0) }`,
    'if (!process.stdin.isTTY) process.exit(0)',
    "process.stdout.write('stand-in Claude Code ready' + String.fromCharCode(13, 10))",
    "process.stdin.on('data', (d) => process.stdout.write(d))",
    "process.stdin.on('end', () => process.exit(0))",
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'claude.cmd'), ['@ECHO off', `"${process.execPath}" "%~dp0stand-in-claude.js" %*`, ''].join('\r\n'))
  return dir
}

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

/** Electron's displays, with their physical bounds. */
const electronDisplays = (app: ElectronApplication) => app.evaluate(({ screen }) => screen.getAllDisplays().map((d) => ({
  id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, physical: screen.dipToScreenRect(null, d.bounds),
})))

/** Where we are in each source of main's lines: its console, and its log file
 *  (<data dir>/debug/app.log, debug-logger.ts), in case the console does not
 *  reach the test. */
type Mark = { console: number; fileLines: number }
const appLogLines = (): string[] => {
  try { return fs.readFileSync(path.join(ctx!.dataDir, 'debug', 'app.log'), 'utf8').split(/\r?\n/) } catch { return [] }
}
const mark = (): Mark => ({ console: mainLines.length, fileLines: appLogLines().length })

/** The new engine's lines since `from`: from main's console when it has any,
 *  else from the log file (the file's lines carry a time and a level first). */
function snapLines(from: Mark): string[] {
  const fromConsole = mainLines.slice(from.console).filter((l) => l.startsWith('[snap] new engine:'))
  if (fromConsole.length > 0) return fromConsole
  return appLogLines().slice(Math.max(0, from.fileLines - 1)).map((l) => l.slice(Math.max(0, l.indexOf('[snap] new engine:')))).filter((l) => l.startsWith('[snap] new engine:'))
}

/** Press Snap, Rectangle; wait for the previous Snap's window; cancel it with
 *  the library's own Cancel message; wait until the button is usable again. */
async function pressAndCancelPrevious(): Promise<number> {
  const { app, page } = ctx!
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => w.id))
  const overlayShown = () => app.evaluate(({ BrowserWindow }, shown) =>
    BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && !shown.includes(w.id)), before)
  const button = page.locator('[data-testid="snap-button"]').first()
  await expect(button).toBeEnabled({ timeout: CANCEL_MS })
  await button.click()
  const started = performance.now()
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await expect.poll(overlayShown, { timeout: OVERLAY_MS, intervals: [50] }).toBe(true)
  const ms = Math.round(performance.now() - started)
  // The message the library's own Cancel button sends (electron-screenshots
  // preload: ipcRenderer.send('SCREENSHOTS:cancel')).
  await app.evaluate(({ ipcMain }) => { ipcMain.emit('SCREENSHOTS:cancel') })
  await expect.poll(overlayShown, { timeout: CANCEL_MS, intervals: [50] }).toBe(false)
  await expect(button).toBeEnabled({ timeout: CANCEL_MS })
  return ms
}

test.describe.configure({ mode: 'serial' })

test.describe('Snap on Windows', () => {
  test.skip(process.platform !== 'win32', 'Snap on Windows: the runner is Windows')

  test.beforeAll(async () => {
    test.setTimeout(LAUNCH_MS + 10_000)
    fs.mkdirSync(OUT, { recursive: true })
    expect(HELPER, 'SNAP_E2E_HELPER names the built helper').not.toBe('')
    expect(fs.existsSync(HELPER), `no helper at ${HELPER}`).toBe(true)
    const started = performance.now()
    ctx = await launchIsolatedApp({
      seedExtra: (dataDir) => chooseSnap(dataDir, 'new'),
      env: (dataDir) => ({
        PATH: pathWith(installStandInClaude(path.join(dataDir, 'stand-in-claude'))),
        CCC_E2E_SNAP_HELPER: HELPER,
      }),
    })
    readings.launchMs = Math.round(performance.now() - started)
    ctx.app.on('console', (m) => { mainLines.push(m.text()) })
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
    await expect(page.locator('[data-testid="snap-button"]').first()).toBeVisible({ timeout: TAB_MS })
    readings.tabMs = Math.round(performance.now() - started)
  })

  for (let run = 1; run <= RUNS; run++) {
    test(`D2 NEW ENGINE run ${run}: the helper captures each display at its physical size and scale, then the previous Snap takes the press`, async () => {
      test.setTimeout(PRESS_TEST_MS)
      const { app, dataDir } = ctx!
      const from = mark()
      const ms = await pressAndCancelPrevious()
      ;(readings.pressMs as number[]).push(ms)
      await expect.poll(() => snapLines(from).length, { timeout: CANCEL_MS }).toBe(1)
      const line = snapLines(from)[0]
      const m = /^\[snap\] new engine: the overlay failed \(the overlay is not in this build\); the helper took (\d+) ms; (.+); the previous Snap takes this press$/.exec(line)
      expect(m, line).not.toBeNull()
      const helperMs = Number(m![1])
      ;(readings.helperMs as number[]).push(helperMs)
      expect(helperMs).toBeLessThanOrEqual(HELPER_BOUND_MS)
      // One entry per display, each at an Electron display's physical size and scale.
      const logged = m![2].split(', ').map((s) => /^display (\d+) (\d+)x(\d+) at (\d+)%( \(primary\))?$/.exec(s))
      expect(logged.every(Boolean), m![2]).toBe(true)
      const displays = await electronDisplays(app)
      readings.electronDisplays = displays
      expect(logged.length).toBe(displays.length)
      const want = displays.map((d) => `${d.physical.width}x${d.physical.height}@${Math.round(d.scaleFactor * 100)}`).sort()
      expect(logged.map((l) => `${l![2]}x${l![3]}@${l![4]}`).sort()).toEqual(want)
      // No press folder left.
      expect(fs.existsSync(path.join(dataDir, 'electron-userdata', 'snap-capture'))).toBe(false)
    })
  }

  for (let run = 1; run <= RUNS; run++) {
    test(`D3 FORCED FAILURE run ${run}: a helper that is not there, and the previous Snap takes the press`, async () => {
      test.setTimeout(PRESS_TEST_MS)
      const { app, dataDir } = ctx!
      const missing = path.join(dataDir, 'no-helper', 'aicc-helper.exe')
      await app.evaluate((_e, p) => { process.env.CCC_E2E_SNAP_HELPER = p }, missing)
      try {
        const from = mark()
        await pressAndCancelPrevious()
        await expect.poll(() => snapLines(from).length, { timeout: CANCEL_MS }).toBe(1)
        expect(snapLines(from)[0]).toMatch(/^\[snap\] new engine: the helper could not start \(ENOENT\); the helper took \d+ ms; the previous Snap takes this press$/)
      } finally {
        await app.evaluate((_e, p) => { process.env.CCC_E2E_SNAP_HELPER = p }, HELPER)
      }
    })
  }

  test('D4 PREVIOUS CHOSEN: no new-engine line, and the previous Snap opens', async () => {
    test.setTimeout(PRESS_TEST_MS)
    const { dataDir } = ctx!
    chooseSnap(dataDir, 'previous')
    try {
      const from = mark()
      await pressAndCancelPrevious()
      expect(snapLines(from)).toEqual([])
    } finally {
      chooseSnap(dataDir, 'new')
    }
  })

  test('D5 HELPER DIRECT: each picture at its physical size, matched to one of Electron\'s displays by bounds and scale', async () => {
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
})
