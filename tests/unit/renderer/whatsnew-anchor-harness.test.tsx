// @vitest-environment jsdom
/**
 * O1/O2 (2026-10-11): where the release-notes run diffs FROM, as the REAL
 * harness and App hand it to the notes page.
 *
 * The beta.2 page read the RAW stamp, live (`meta.lastSeenVersion`, subscribed),
 * and the harness read `seenVersion()` live at mount. But App stamps
 * `lastRunVersion` with the running build during boot, before the notes run
 * mounts, which turns the #369 clamp into a no-op for both. Now App reads the
 * clamped seen version from the meta it loaded, BEFORE that stamp, and the
 * harness fixes the run's anchor from it once.
 *
 * Verifies:
 *   - the notes page gets the anchor from the boot value, not the live meta;
 *   - with no boot value (the harness mounted before App read it) the live,
 *     still unstamped, meta is read, clamped;
 *   - the anchor is keyed to the final release (a tester's beta.2 -> 2.1.0);
 *   - each link (boot value, clamp, running build) is pinned by a value that
 *     does not floor to 2.1.0, so cutting it fails a test;
 *   - the setup pages new since (stepsNewSince) use the same boot value;
 *   - O3: the last page's hint names the Codex question when it follows,
 *     and never says "Nothing to set up";
 *   - App captures the boot value before it stamps, and hands it over.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const CURRENT = '2.1.1-beta.3'
;(globalThis as any).__APP_VERSION__ = CURRENT

// The notes page as a stand-in that shows what the harness handed it.
vi.mock('../../../src/renderer/onboarding/WhatsNewV2Step', () => ({
  WhatsNewV2Step: (props: { onNext: () => void; anchor?: string; hint?: string; fresh?: boolean }) => (
    <div data-testid="page" data-page={props.fresh ? 'whatsNewV2Fresh' : 'whatsNewV2'} data-anchor={props.anchor ?? '(none)'} data-hint={props.hint ?? ''}>
      <button type="button" data-testid="stub-next" onClick={() => props.onNext()}>Next</button>
    </div>
  ),
}))
vi.mock('../../../src/renderer/onboarding/WelcomeStep', async () => ({ WelcomeStep: (await import('./onboarding-flow-stubs')).stub('welcome') }))
vi.mock('../../../src/renderer/onboarding/CommandBarStep', async () => ({ CommandBarStep: (await import('./onboarding-flow-stubs')).stub('commandBar') }))
vi.mock('../../../src/renderer/onboarding/FindClaudeStep', async () => ({ FindClaudeStep: (await import('./onboarding-flow-stubs')).stub('findClaude') }))
vi.mock('../../../src/renderer/onboarding/CompatibilityStep', async () => ({ CompatibilityStep: (await import('./onboarding-flow-stubs')).stub('compatibility') }))
vi.mock('../../../src/renderer/onboarding/AccountsStep', async () => ({ AccountsStep: (await import('./onboarding-flow-stubs')).stub('accounts') }))
vi.mock('../../../src/renderer/onboarding/GitHubStep', async () => ({ GitHubStep: (await import('./onboarding-flow-stubs')).stub('github') }))
vi.mock('../../../src/renderer/onboarding/StatusLineStep', async () => ({ StatusLineStep: (await import('./onboarding-flow-stubs')).stub('statusline') }))
vi.mock('../../../src/renderer/onboarding/BuiltinToolsStep', async () => ({ BuiltinToolsStep: (await import('./onboarding-flow-stubs')).stub('builtinTools') }))
vi.mock('../../../src/renderer/onboarding/TransparencyStep', async () => ({ TransparencyStep: (await import('./onboarding-flow-stubs')).stub('transparency') }))
vi.mock('../../../src/renderer/onboarding/FinishStep', async () => ({ FinishStep: (await import('./onboarding-flow-stubs')).FinishStub }))
vi.mock('../../../src/renderer/onboarding/CodexSetupStep', async () => ({ CodexSetupStep: (await import('./onboarding-flow-stubs')).CodexSetupStub }))
vi.mock('../../../src/renderer/onboarding/settle', () => ({ settleOnboardingFinish: vi.fn(), settleWhatsNewOnly: vi.fn() }))

;(globalThis as any).window.electronPlatform = 'win32'

const { OnboardingHarness } = await import('../../../src/renderer/onboarding/OnboardingHarness')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useAppMetaStore } = await import('../../../src/renderer/stores/appMetaStore')
const gate: any = await import('../../../src/renderer/onboarding/whats-new-gate')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexAnswered: true }, isLoaded: true })
  // What the live meta says once App has booted this build: seen and ran.
  useAppMetaStore.setState({ meta: { lastSeenVersion: CURRENT, lastRunVersion: CURRENT } })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  ;(globalThis as any).__APP_VERSION__ = CURRENT
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const pageIds = async (): Promise<string[]> => {
  const seen: string[] = []
  for (let i = 0; i < 20; i++) {
    const p = byTest('page')
    if (!p) return seen
    const id = p.getAttribute('data-page')!
    if (seen[seen.length - 1] === id) return seen // the last page's Next ended the run
    seen.push(id)
    const n = byTest('stub-next')
    if (!n) return seen
    await act(async () => { n.click() })
  }
  return seen
}

async function mountNotes(bootSeenVersion?: string) {
  const props: any = { onComplete: vi.fn(), whatsNewOnly: true }
  if (bootSeenVersion !== undefined) props.bootSeenVersion = bootSeenVersion
  await act(async () => { root.render(<OnboardingHarness {...props} />) })
}

const notes = () => container.querySelector('[data-page="whatsNewV2"]') as HTMLElement

describe('the notes run diffs from the boot snapshot', () => {
  it('the page gets the anchor from App\'s boot value, not from the live, already stamped meta', async () => {
    await mountNotes('2.1.0')
    expect(notes().getAttribute('data-anchor')).toBe('2.1.0')
  })

  it('a beta tester\'s boot value is keyed to the final release: beta.2 -> 2.1.0', async () => {
    await mountNotes('2.1.1-beta.2')
    expect(notes().getAttribute('data-anchor')).toBe('2.1.0')
  })

  it('with no boot value (mounted before App read it), the live unstamped meta is read, clamped (#369)', async () => {
    // Stamped ahead: the stamp names the running build, which never ran.
    useAppMetaStore.setState({ meta: { lastSeenVersion: CURRENT, lastRunVersion: '2.1.0' } })
    await mountNotes()
    expect(notes().getAttribute('data-anchor')).toBe('2.1.0')
  })

  // The tests above pass on a 2.1.1 prerelease build whatever the plumbing
  // does, because every seen version from 2.1.0 up to this build floors to
  // 2.1.0 there. The ones below use values that do NOT floor to 2.1.0, so
  // each fails when one link is cut.
  it('a boot value older than the prerelease floor is kept: the live, stamped meta is not read', async () => {
    // Cut: the harness anchors from seenVersion() (live) and not the boot value -> 2.1.0.
    await mountNotes('2.0.0')
    expect(notes().getAttribute('data-anchor')).toBe('2.0.0')
  })

  it('a prerelease of an older release counts as that release, which needs the running build (rc.17 -> 2.1.0)', async () => {
    // Cut: whatsNewAnchorFrom passes no currentVersion -> the last 2.0 final.
    await mountNotes('2.1.0-rc.17')
    expect(notes().getAttribute('data-anchor')).toBe('2.1.0')
  })

  it('with no boot value, the live meta is clamped to what last ran (#369), below the prerelease floor', async () => {
    // Cut: seenVersion() returns the raw stamp -> this build -> 2.1.0.
    useAppMetaStore.setState({ meta: { lastSeenVersion: CURRENT, lastRunVersion: '2.0.0' } })
    await mountNotes()
    expect(notes().getAttribute('data-anchor')).toBe('2.0.0')
  })

  it('on a final build, a stamp written ahead of it diffs from the build that ran (2.1.1 stamped, 2.1.0 ran)', async () => {
    // No prerelease floor on a final build: without the clamp this is 2.1.1,
    // and the page would show nothing new.
    ;(globalThis as any).__APP_VERSION__ = '2.1.1'
    useAppMetaStore.setState({ meta: { lastSeenVersion: '2.1.1', lastRunVersion: '2.1.0' } })
    await mountNotes()
    expect(notes().getAttribute('data-anchor')).toBe('2.1.0')
  })

  it('on the final 2.1.1, a tester who ran its beta.3 still diffs from 2.1.0 (owner rule)', async () => {
    ;(globalThis as any).__APP_VERSION__ = '2.1.1'
    await mountNotes('2.1.1-beta.3')
    expect(notes().getAttribute('data-anchor')).toBe('2.1.0')
  })

  it('the setup pages new since use the same boot value (stepsNewSince)', async () => {
    // The command bar page shipped in 2.1.0-beta.17: new to someone whose
    // boot snapshot says beta.16, though the live meta says this build.
    await mountNotes('2.1.0-beta.16')
    expect(await pageIds()).toEqual(['whatsNewV2', 'commandBar'])
  })
})

describe('O3: the last page promises only what is true', () => {
  it('names the Codex question when it follows the notes', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexAnswered: false }, isLoaded: true })
    await mountNotes('2.1.0')
    expect(notes().getAttribute('data-hint')).toBe('Your settings carried over. Next: one question about Codex.')
  })

  it('says only that the settings carried over when Codex is answered', async () => {
    await mountNotes('2.1.0')
    const hint = notes().getAttribute('data-hint')!
    expect(hint).toBe('Your settings carried over.')
    expect(hint).not.toMatch(/Nothing to set up/)
  })
})

describe('App hands the harness the boot value', () => {
  const app = readFileSync(resolve(__dirname, '../../../src/renderer/App.tsx'), 'utf8')

  it('seenVersionOf is the #369 clamp of a meta snapshot', () => {
    expect(gate.seenVersionOf({ lastSeenVersion: CURRENT, lastRunVersion: '2.1.0' })).toBe('2.1.0')
    expect(gate.seenVersionOf({ lastSeenVersion: '2.1.0', setupVersion: '2.1.0-rc.17' })).toBe('2.1.0-rc.17')
    expect(gate.seenVersionOf({})).toBeUndefined()
  })

  it('captures it from the boot snapshot BEFORE stamping lastRunVersion, and passes it to the harness', () => {
    const capture = app.indexOf('setBootSeenVersion(seenVersionOf(appMeta))')
    const stamp = app.indexOf('useAppMetaStore.getState().update({ lastRunVersion: __APP_VERSION__ })')
    expect(capture, 'App captures the boot seen version').toBeGreaterThan(0)
    expect(stamp).toBeGreaterThan(0)
    expect(capture, 'captured before the stamp').toBeLessThan(stamp)
    // No await between them: React renders the harness only after both.
    expect(app.slice(capture, stamp)).not.toMatch(/\bawait\b/)
    expect(app).toContain('bootSeenVersion={bootSeenVersion}')
  })
})
