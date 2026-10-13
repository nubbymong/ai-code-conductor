/**
 * What's New for a "seen" stamp no build of that version wrote (#369), against
 * the real app: the stamp names the RUNNING build, but the last build that
 * actually ran was 2.0.x. The stamp is not taken at its word: the launch reads
 * it as stamped ahead, the notes open, and they diff from the 2.0.x that ran.
 * So the run opens on the rename page (2.0.x predates the rename), then the
 * summary headed "What's new since 2.0.5", then the 2.0.x showcase set: every
 * page the 2.1 line and 2.1.1 added, in order (the stamped-ahead seed).
 *
 * The seed is as close to first-launch-whats-new.spec.ts's as the case
 * allows. The ONE witness of 2.0.x is `lastRunVersion`: setupVersion and
 * onboardingAppVersion name the running build, so neither the CLI setup page
 * nor a crossed-line re-onboard can open anything. Without the #369 clamp the
 * launch would read "same version" and show nothing at all, so the notes
 * opening is itself the proof that the clamp decided it.
 *
 * VM / CI ONLY: this launches the Electron app (never on the owner's
 * workstation).
 */
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { STEPS, ONBOARDING_VERSION } from '../../src/renderer/onboarding/steps'
import { emptyGitHubConfig } from '../../src/shared/github-constants'
import { currentTrainingVersion } from '../../src/renderer/training-steps'
import { isolatedLaunchEnv } from './helpers/isolated-env'

const APP_PATH = path.resolve(__dirname, '../../out/main/index.js')
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'),
).version as string

/** The 2.0.x build that last ran. Any 2.0 final works: everything the 2.1
 *  line added is new to it, and it is before the rename (2.1.0-beta.6). */
const LAST_RUN = '2.0.5'

/**
 * The showcase page ids in the order the pages run (showcase-pages.ts: the
 * 2.1 set, then the 2.1.1 set). For a 2.0.x upgrader with Claude Code on,
 * every page is new and none is left out (whatsnew-showcase.test.tsx pins
 * the same list for a 2.0.5 anchor). Read from the source, because that
 * module imports an SVG, which Playwright's loader cannot import.
 */
function showcaseIdsInOrder(): string[] {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/onboarding/showcase-pages.ts'), 'utf-8')
  const start = src.indexOf('export const SHOWCASES_21:')
  const end = src.indexOf('export const SHOWCASES:')
  if (start < 0 || end < start) throw new Error('showcase-pages.ts no longer reads as two page sets')
  return [...src.slice(start, end).matchAll(/^\s+id: '([A-Za-z0-9]+)',\s*$/gm)].map((m) => m[1])
}
const PAGE_IDS = showcaseIdsInOrder()

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication | undefined
let page: Page
let dataDir: string

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-e2e-stamped-ahead-'))
  const config = path.join(dataDir, 'resources', 'CONFIG')
  for (const sub of ['CONFIG', 'insights', 'screenshots', 'skills', 'scripts', 'status']) {
    fs.mkdirSync(path.join(dataDir, 'resources', sub), { recursive: true })
  }
  fs.writeFileSync(
    path.join(config, 'app-meta.json'),
    JSON.stringify({
      setupVersion: APP_VERSION,
      // Stamped ahead: names this build, which has never run here.
      lastSeenVersion: APP_VERSION,
      // The witness: what actually ran last.
      lastRunVersion: LAST_RUN,
      lastTrainingVersion: currentTrainingVersion(),
      hasCreatedFirstConfig: true,
      accountGateDecided: true,
      completedSteps: Object.fromEntries(STEPS.map((s) => [s.id, APP_VERSION])),
      onboardingCompletedVersion: ONBOARDING_VERSION,
      onboardingAppVersion: APP_VERSION,
    }),
  )
  fs.writeFileSync(
    path.join(config, 'settings.json'),
    JSON.stringify({
      loggingConsentSeen: true,
      loggingConsentVersion: 2,
      localMachineName: 'e2e-host',
      // A within-line move on stable, as first-launch-whats-new.spec.ts: the
      // channel decides nothing here. The one-time assistants question after
      // an update is left unanswered: it waits behind the notes
      // (bootGates.ts), and this spec never ends the notes run.
      updateChannel: 'stable',
      updateChannelChosen: true,
    }),
  )
  fs.writeFileSync(
    path.join(config, 'github-config.json'),
    JSON.stringify({ ...emptyGitHubConfig(), seenOnboardingVersion: 'permanent' }),
  )

  app = await electron.launch({
    args: [APP_PATH, `--user-data-dir=${path.join(dataDir, 'electron-userdata')}`],
    env: isolatedLaunchEnv(dataDir),
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (app) {
    try {
      await Promise.race([app.close(), new Promise<void>((r) => setTimeout(r, 5000))])
    } catch { /* ignore */ }
    try { app.process().kill() } catch { /* already gone */ }
  }
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

const ON = /(^|\s)on(\s|$)/

test('the stamp is read as stamped ahead: the notes open, on the rename page', async () => {
  await expect(page.locator('.ob-root')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('[data-ux-id="rename-page"]')).toBeVisible()
  await expect(page.locator('[data-ux-id="whatsnew-dot-rename"]')).toHaveClass(ON)
})

test('the run is the rename page, the summary, then the 2.0.x showcase set, in order', async () => {
  // The set read from the source is the 2.1 line's nine pages and 2.1.1's own.
  expect(PAGE_IDS.length).toBeGreaterThanOrEqual(14)
  const dots = page.locator('[data-ux-id="whatsnew-dots"] .wn-fdot')
  const ids = await dots.evaluateAll((els) => els.map((e) => e.getAttribute('data-ux-id')))
  expect(ids).toEqual(['whatsnew-dot-rename', 'whatsnew-dot-summary', ...PAGE_IDS.map((id) => `whatsnew-dot-${id}`)])
})

test('the summary diffs from the 2.0.x that last ran, not from the stamp', async () => {
  await page.locator('.ob-root .cta').click()
  await expect(page.locator('[data-ux-id="whatsnew-dot-summary"]')).toHaveClass(ON)
  await expect(page.locator('[data-ux-id="whatsnew-heading"]')).toHaveText(`What's new since ${LAST_RUN}`)
})

test('each showcase page follows in that order', async () => {
  const cta = page.locator('.ob-root .cta')
  for (const id of PAGE_IDS) {
    // "Next" and its arrow on every page before the last of the run.
    await expect(cta).toHaveText(/^Next\b/)
    await cta.click()
    await expect(page.locator(`[data-ux-id="showcase-page-${id}"]`)).toBeVisible()
    await expect(page.locator(`[data-ux-id="whatsnew-dot-${id}"]`)).toHaveClass(ON)
  }
  // The run has reached its end: no showcase page is left, so the button no
  // longer reads "Next" and "Skip the showcase" is gone (WhatsNewV2Step isLast).
  await expect(cta).not.toHaveText(/^Next\b/)
  await expect(page.locator('[data-ux-id="whatsnew-skip"]')).toHaveCount(0)
})
