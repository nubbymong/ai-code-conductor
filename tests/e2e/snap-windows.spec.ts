/**
 * Snap on Windows, end to end on the GitHub runner's own desktop (plan
 * 2.1.3-beta.16, section A1; aicc_planning#401). Run ONLY by the snap-e2e job
 * in ci.yml (a dispatch), with `--retries=0 --workers=1`: never on the test
 * machine, never on a developer's PC (it presses Snap on the real screen).
 *
 * SKELETON (A1's first commit). It reads the times the full check's timeouts
 * are set from (rule 29), and that the pieces the new engine stands on work on
 * the runner:
 *   1. the app starts (launchIsolatedApp, every per-user folder in its own temp
 *      folder) and one Claude Code tab opens, on a stand-in `claude` (the Snap
 *      button shows on agent tabs only, session-capabilities.ts
 *      canSendImageToAgent; the runner has no Claude Code);
 *   2. Snap, Rectangle, with today's engine (electron-screenshots): its overlay
 *      window shows, it is cancelled with the library's own cancel message,
 *      and the button is usable again;
 *   3. the built helper's `capture` runs once at the test-only helper path
 *      (SNAP_E2E_HELPER; the app is given it as CCC_E2E_SNAP_HELPER): its line,
 *      each picture's size against its BMP header, and each display matched to
 *      one of Electron's by physical bounds (screen.dipToScreenRect).
 * The readings go to the log and to $SNAP_E2E_OUT/skeleton-readings.json.
 *
 * The timeouts here are the skeleton's own, wide on purpose: it is the run
 * that measures. The full check sets each test's timeout once, from these
 * readings, and never raises one to answer a red run.
 */
import { test, expect } from '@playwright/test'
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

const readings: Record<string, unknown> = {}
let ctx: IsolatedApp | undefined

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
  const rest = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter((d) => d && !CLI_NAMES.some((n) => {
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

test.describe.configure({ mode: 'serial' })

test.describe('Snap on Windows (skeleton)', () => {
  test.skip(process.platform !== 'win32', 'Snap on Windows: the runner is Windows')

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    fs.mkdirSync(OUT, { recursive: true })
    expect(HELPER, 'SNAP_E2E_HELPER names the built helper').not.toBe('')
    expect(fs.existsSync(HELPER), `no helper at ${HELPER}`).toBe(true)
    const started = performance.now()
    ctx = await launchIsolatedApp({
      env: (dataDir) => ({
        PATH: pathWith(installStandInClaude(path.join(dataDir, 'stand-in-claude'))),
        CCC_E2E_SNAP_HELPER: HELPER,
      }),
    })
    readings.launchMs = Math.round(performance.now() - started)
  })

  test.afterAll(async () => {
    test.setTimeout(120_000)
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'skeleton-readings.json'), JSON.stringify(readings, null, 2))
    console.log(`[snap-e2e] readings ${JSON.stringify(readings)}`)
    await closeIsolatedApp(ctx)
  })

  test('one Claude Code tab opens and shows the Snap button', async () => {
    test.setTimeout(180_000)
    const page = ctx!.page
    const started = performance.now()
    await page.locator('[data-testid="panel-tab-saved"]').click()
    await page.locator('[data-testid="new-button"]').click()
    await page.locator('[data-testid="new-menu-config"]').click()
    await expect(page.locator('text=New saved config')).toBeVisible({ timeout: 30_000 })
    await page.locator('[role="radiogroup"][aria-label="Provider"] label:has(input[value="claude"])').click()
    await page.locator('[role="radiogroup"][aria-label="Connection"] label:has(input[value="local"])').click()
    await page.locator('input[placeholder*="path"]').first().fill(ctx!.dataDir)
    await page.locator('input[placeholder="e.g. App Dev"]').fill(LABEL)
    await page.locator('[data-testid="session-dialog-submit"]').click()
    await expect(page.locator('text=New saved config')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('[data-testid="snap-button"]').first()).toBeVisible({ timeout: 120_000 })
    readings.tabMs = Math.round(performance.now() - started)
    await page.screenshot({ path: path.join(OUT, 'skeleton-tab.png') }).catch(() => {})
  })

  test('Snap, Rectangle, with today\'s engine: its overlay shows, is cancelled, and the button is usable again', async () => {
    test.setTimeout(120_000)
    const { app, page } = ctx!
    // The library's window is any visible window the app did not show before the press.
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => w.id))
    const overlays = () => app.evaluate(({ BrowserWindow }, shown) =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed() && w.isVisible() && !shown.includes(w.id))
        .map((w) => ({ title: w.getTitle(), bounds: w.getBounds(), onTop: w.isAlwaysOnTop() })), before)
    const overlayShown = async () => (await overlays()).length > 0
    const button = page.locator('[data-testid="snap-button"]').first()
    await button.click()
    const started = performance.now()
    await page.getByRole('button', { name: 'Rectangle' }).click()
    await expect.poll(overlayShown, { timeout: 60_000, intervals: [50] }).toBe(true)
    readings.previousOverlayMs = Math.round(performance.now() - started)
    readings.previousOverlayWindows = await overlays()
    // The message the library's own Cancel button sends (electron-screenshots
    // preload: ipcRenderer.send('SCREENSHOTS:cancel')).
    const cancelled = performance.now()
    await app.evaluate(({ ipcMain }) => { ipcMain.emit('SCREENSHOTS:cancel') })
    await expect.poll(overlayShown, { timeout: 30_000, intervals: [50] }).toBe(false)
    await expect(button).toBeEnabled({ timeout: 30_000 })
    readings.previousCancelMs = Math.round(performance.now() - cancelled)
  })

  test('the built helper captures each display at its physical size, and each matches one of Electron\'s displays', async () => {
    test.setTimeout(120_000)
    const folder = fs.mkdtempSync(path.join(OUT, 'capture-'))
    try {
      const run = await runHelper(['capture', '--out', folder])
      readings.helperMs = run.ms
      readings.helperExit = run.code
      expect(run.code, `capture exited ${run.code}: ${run.stderr}`).toBe(0)
      const line = JSON.parse(run.stdout.trim()) as { displays: Array<{ file: string; left: number; top: number; width: number; height: number; dpi: number; scale: number; primary: boolean }> }
      const electronDisplays = await ctx!.app.evaluate(({ screen }) => screen.getAllDisplays().map((d) => ({
        id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, physical: screen.dipToScreenRect(null, d.bounds),
      })))
      readings.displays = line.displays.map((d) => ({ file: d.file, left: d.left, top: d.top, width: d.width, height: d.height, scale: d.scale, primary: d.primary }))
      readings.electronDisplays = electronDisplays
      expect(line.displays.length).toBe(electronDisplays.length)
      for (const d of line.displays) {
        const buf = fs.readFileSync(path.join(folder, d.file))
        expect(buf.length, d.file).toBe(54 + d.width * d.height * 4)
        expect(buf.readInt32LE(18), `${d.file} width`).toBe(d.width)
        expect(buf.readInt32LE(22), `${d.file} height (positive: rows from the bottom)`).toBe(d.height)
        expect(buf.readUInt16LE(28), `${d.file} bits`).toBe(32)
        const match = electronDisplays.filter((e) => e.physical.x === d.left && e.physical.y === d.top && e.physical.width === d.width && e.physical.height === d.height)
        expect(match.length, `${d.file} at ${d.left},${d.top} ${d.width}x${d.height} matches one display: ${JSON.stringify(electronDisplays)}`).toBe(1)
        expect(Math.round(match[0].scaleFactor * 100), `${d.file} scale`).toBe(d.scale)
      }
    } finally {
      fs.rmSync(folder, { recursive: true, force: true })
    }
  })
})
