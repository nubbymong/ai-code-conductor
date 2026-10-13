/**
 * E2E (#21): terminal http/https link handling in the REAL app + REAL xterm.
 *
 * Proves the user-visible behaviour of the fix (the flicker itself — a rapid
 * WebGL repaint — is not directly assertable, but the link wiring that the same
 * change adds is):
 *   1. Clicking an https link routes to shell.openExternal with the URL.
 *   2. Right-clicking a link offers "Copy link address", which puts the URL on
 *      the OS clipboard (exercises link detection → hover tracking → the context
 *      menu → the copy handler).
 *   3. (aicc_planning#126) The right-click does NOT also open the link: xterm
 *      activates a link on the mouseup of any button, and only a plain left
 *      click may open.
 *
 * Drives a local shell-only PTY (linkification is renderer-side text matching,
 * so local == tmux/SSH here). Windows-only (uses a powershell terminal config).
 */
import { test, expect } from '@playwright/test'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'

let ctx: IsolatedApp
let page: IsolatedApp['page']

const URL = 'https://example.com/ccce2e-21'

test.beforeAll(async () => {
  ctx = await launchIsolatedApp()
  page = ctx.page
})
test.afterAll(async () => {
  test.setTimeout(120000)
  await closeIsolatedApp(ctx)
})

async function openDialog() {
  const cancel = page.locator('button:has-text("Cancel")').first()
  if (await cancel.isVisible().catch(() => false)) await cancel.click()
  await page.locator('[data-testid="panel-tab-saved"]').click()
  await page.locator('[data-testid="new-button"]').click()
  await page.locator('[data-testid="new-menu-config"]').click()
  await expect(page.locator('text=New saved config')).toBeVisible({ timeout: 10000 })
}

let sid = ''
async function ptyWrite(text: string) {
  await page.evaluate(
    ([id, t]) => (window as unknown as { electronAPI: any }).electronAPI.pty.write(id, t),
    [sid, text] as const,
  )
}

/** Clear the screen and print the URL at row 0, then return a point on it. */
async function printUrlAndPoint(): Promise<{ x: number; y: number }> {
  await ptyWrite(`Clear-Host; Write-Host '${URL}'\r`)
  await page.waitForTimeout(1200)
  const screen = page.locator('[data-terminal-active] .xterm-screen').first()
  await expect(screen).toBeVisible()
  const box = await screen.boundingBox()
  if (!box) throw new Error('no .xterm-screen box')
  // Row 0 (top of the screen after Clear-Host), a few cells into the URL —
  // x=+30 is inside a 29-char URL for any plausible cell width; y=+6 is row 0.
  return { x: box.x + 30, y: box.y + 6 }
}

/** Move onto the link so xterm's linkifier computes it and fires hover. */
async function hoverLink(p: { x: number; y: number }) {
  await page.mouse.move(p.x - 20, p.y)
  await page.mouse.move(p.x, p.y, { steps: 8 })
  await page.waitForTimeout(500) // linkifier hover debounce
}

/**
 * electronAPI is a frozen contextBridge object, so intercept in MAIN: swap the
 * shell:openExternal IPC handler for a recorder (and empty the record). Safe to
 * call again: each call replaces the handler and starts a fresh record.
 */
async function recordOpenExternal() {
  await ctx.app.evaluate(({ ipcMain }) => {
    ;(globalThis as unknown as { __ext: string[] }).__ext = []
    ipcMain.removeHandler('shell:openExternal')
    ipcMain.handle('shell:openExternal', (_e, u: string) => {
      ;(globalThis as unknown as { __ext: string[] }).__ext.push(u)
      return true
    })
  })
}

async function openedUrls(): Promise<string[]> {
  return ctx.app.evaluate(() => (globalThis as unknown as { __ext: string[] }).__ext)
}

test.describe('#21 terminal link handling (real app, real xterm)', () => {
  test.skip(process.platform !== 'win32', 'uses a powershell terminal config')

  test.beforeAll(async () => {
    await openDialog()
    await page.locator('[role="radiogroup"][aria-label="Provider"] label:has(input[value="terminal"])').click()
    await page.locator('[role="radiogroup"][aria-label="Connection"] label:has(input[value="local"])').click()
    await expect(page.locator('text=Terminal startup')).toBeVisible({ timeout: 10000 })
    await page.locator('input[placeholder="npm run dev"]').fill('echo ready')
    await page.locator('input[placeholder="e.g. App Dev"]').fill('E2E Links')
    await page.locator('button:has-text("Create config")').click()
    const term = page.locator('[data-terminal-active]').first()
    await expect(term).toBeVisible({ timeout: 30000 })
    sid = (await term.getAttribute('data-terminal-session')) || ''
    expect(sid).toBeTruthy()
    await page.waitForTimeout(3000) // shell reaches its prompt
  })

  test('clicking an https link routes to shell.openExternal with the URL', async () => {
    test.setTimeout(120000)
    // The recorder proves the click routed the URL through the real
    // renderer→IPC path (safe-url validation is unit-tested separately).
    await recordOpenExternal()
    const p = await printUrlAndPoint()
    await hoverLink(p)
    await page.mouse.click(p.x, p.y)
    await page.waitForTimeout(400)
    const opened = await openedUrls()
    await page.screenshot({ path: 'test-results/21-link-click.png' }).catch(() => {})
    expect(opened, `expected shell.openExternal to be called with ${URL}`).toContain(URL)
  })

  test('right-click a link → "Copy link address" copies the URL to the clipboard', async () => {
    test.setTimeout(120000)
    await ctx.app.evaluate(({ clipboard }) => clipboard.writeText(''))
    await recordOpenExternal()
    const p = await printUrlAndPoint()
    await hoverLink(p)
    await page.mouse.click(p.x, p.y, { button: 'right' })
    const copyLink = page.locator('button:has-text("Copy link address")').first()
    await expect(copyLink).toBeVisible({ timeout: 5000 })
    // aicc_planning#126: the right-click opened the menu and nothing else. Same
    // settle time the left-click test gives the IPC to reach main.
    await page.waitForTimeout(400)
    expect(await openedUrls(), 'a right-click must not open the link').toEqual([])
    await copyLink.click()
    await page.waitForTimeout(300)
    const clip = await ctx.app.evaluate(({ clipboard }) => clipboard.readText())
    await page.screenshot({ path: 'test-results/21-copy-link.png' }).catch(() => {})
    expect(clip).toBe(URL)
    // The menu click is a left click near the link: if it ever reached xterm's
    // mouseup it would pass the button-0 gate, so check it opened nothing too.
    expect(await openedUrls(), 'right-click then Copy link address must not open the link').toEqual([])
  })
})
