// @vitest-environment jsdom
/**
 * The status strip of a tab through the session helper on another machine
 * (plan 2.1.3-beta.19, section 3; aicc_planning#434): where this computer
 * holds the tab's account, its per-model weekly bars and extra usage, from
 * this computer's own reading; where it does not, the strip says "not
 * available" with the reason, beside the five-hour and weekly figures the
 * host's own status line gives. Never an empty or zero bar for a missing
 * source. The harness is session-status-strip-surface.test.tsx's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mutable mock state so individual tests can vary session/settings/profiles.
const sessionState: any = { sessions: [{ id: 's1', provider: 'claude', contextPercent: 10 }] }
const settingsState: any = { settings: { statusLine: { font: 'sans', fontSize: 11 }, theme: 'dark', accountAliases: {}, accountColourOverrides: {} } }
const profilesState: any = { profiles: [] }
const restartState = vi.hoisted(() => ({ restart: vi.fn() }))

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel(sessionState),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore, DEFAULT_STATUS_LINE: { font: 'sans', fontSize: 11 } }
})
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel: any) => sel(profilesState),
}))
vi.mock('../../../src/renderer/hooks/useCodexReviewUsage', () => ({ useCodexReviewUsage: () => null }))
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({ useRestartSession: () => ({ restart: restartState.restart }) }))
vi.mock('../../../src/renderer/hooks/useSwitchAccount', () => ({ useSwitchAccount: () => () => {} }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const { default: SessionStatusStrip } = await import('../../../src/renderer/components/SessionStatusStrip')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as any).window.electronAPI = { pty: { write: vi.fn() } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Reset to defaults each test.
  sessionState.sessions = [{ id: 's1', provider: 'claude', contextPercent: 10 }]
  settingsState.settings = { statusLine: { font: 'sans', fontSize: 11 }, theme: 'dark', accountAliases: {}, accountColourOverrides: {} }
  profilesState.profiles = []
  restartState.restart.mockClear()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const note = () => container.querySelector('[data-testid="remote-usage-not-shown"]') as HTMLElement | null
const bars = () => [...container.querySelectorAll('[role="progressbar"]')].map((b) => b.getAttribute('aria-label') ?? '')
/** A helper tab (an SSH Claude Code tab) with the rate-limit meters on. */
const helperTab = (extra: Record<string, unknown> = {}) => {
  sessionState.sessions = [{ id: 's1', provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u' }, contextPercent: 10, status: 'working', ...extra }]
  settingsState.settings.statusLine = { font: 'sans', fontSize: 11, showRateLimits: true }
}
const draw = () => act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })

describe('a helper tab\'s per-model weekly bars and extra usage', () => {
  it('an account this computer does not hold: the host\'s five-hour and weekly bars, then "not available" with the reason', () => {
    helperTab({ rateLimitCurrent: 30, rateLimitWeekly: 40, usageBuckets: [], remoteUsageNotShown: 'own-sign-in' })
    draw()
    expect(note()?.textContent).toBe('Model limits: not available')
    expect(note()?.getAttribute('title')).toMatch(/^Not available: this machine uses its own sign-in\./)
    expect(bars()).toEqual(['5h rate limit utilisation', 'Weekly rate limit utilisation'])
    // No extra usage block, and no bar of any per-model limit.
    expect(container.textContent).not.toContain('extra:')
  })

  it('held, with no current reading: "not available", the reason in its title, never a zero bar', () => {
    helperTab({ rateLimitCurrent: 30, usageBuckets: [], remoteUsageNotShown: 'no-reading', rateLimitExtra: { enabled: false, utilization: 0, usedUsd: 0, limitUsd: 0 } })
    draw()
    expect(note()?.textContent).toBe('Model limits: not available')
    expect(note()?.getAttribute('title')).toMatch(/has no current usage reading for it\.$/)
    expect(container.textContent).not.toContain('extra:')
    expect(container.textContent).not.toMatch(/\b0%/)
  })

  it('before the host\'s first status: the waiting meters and the reason, no value', () => {
    helperTab({ remoteUsageNotShown: 'own-sign-in', usageBuckets: [] })
    draw()
    expect(container.querySelectorAll('[data-testid="rate-limit-pending"]').length).toBe(2)
    expect(note()).not.toBeNull()
    expect(container.textContent).not.toMatch(/\d+%/)
  })

  it('an account this computer holds: its bars, per-model weekly too, and its extra usage; no note', () => {
    helperTab({
      rateLimitCurrent: 30,
      usageBuckets: [
        { key: 'session:', label: '5h', group: 'session', percent: 12, resetsAt: '', severity: 'normal' },
        { key: 'weekly_all:', label: 'Weekly', group: 'weekly', percent: 40, resetsAt: '', severity: 'normal' },
        { key: 'weekly:Fable', label: 'Fable', group: 'weekly', percent: 63, resetsAt: '', severity: 'normal' },
      ],
      rateLimitExtra: { enabled: true, utilization: 25, usedUsd: 5, limitUsd: 20 },
    })
    draw()
    expect(note()).toBeNull()
    expect(bars()).toEqual(['5h rate limit utilisation', 'Weekly rate limit utilisation', 'Fable rate limit utilisation'])
    expect(container.textContent).toContain('extra: $5.00/$20')
  })

  it('a tab with no reason (today\'s SSH tab, a local tab) shows no note', () => {
    helperTab({ rateLimitCurrent: 30 })
    draw()
    expect(note()).toBeNull()
  })
})

/**
 * 2.1.3-beta.19 text smoke (#36): at 1280x768 with the sidebar open the note
 * showed only its first 7 px (an "M" between "Weekly: --%" and the model
 * pill): it sat inside the strip's middle row, which is flex-1, min-w-0 and
 * overflow-hidden (it clips what does not fit), at x 1036 of a row ending at
 * 1043, needing 263 px. It is now a shrink-0 sibling AFTER that row, so the
 * row gives way and the note keeps its whole width inside the strip, at any
 * window width; and its label is short, its reason in the title.
 *
 * jsdom lays nothing out, so this pins the structure that decides it: in a
 * flex row, a shrink-0 child is never narrower than its content, and only the
 * min-w-0 overflow-hidden sibling before it is clipped.
 */
describe('the note is never clipped by the strip\'s middle row (text smoke #36)', () => {
  it('a helper tab at 1280 px: the note is a shrink-0 child of the strip after the clipped row, not inside it; its label is short', () => {
    helperTab({ rateLimitCurrent: 30, rateLimitWeekly: 40, usageBuckets: [], remoteUsageNotShown: 'no-reading', modelName: 'Opus 5.5' })
    draw()
    const n = note()!
    expect(n).not.toBeNull()
    // Not inside any clipping row.
    for (let el = n.parentElement; el && el !== container; el = el.parentElement) {
      expect(el.classList.contains('overflow-hidden') && el.classList.contains('min-w-0'), `clipped by ${el.className}`).toBe(false)
    }
    // Its own parent is the strip's row, beside the clipped middle row, which comes before it.
    const middle = n.parentElement!.querySelector(':scope > .overflow-hidden.min-w-0')
    expect(middle).not.toBeNull()
    expect(middle!.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(middle!.contains(n)).toBe(false)
    expect(n.textContent).toBe('Model limits: not available')
    expect(n.textContent!.length).toBeLessThanOrEqual(27)
  })

  /**
   * 2.1.3-beta.19 release smoke (g04-header-rocky.png, o06 and q04 on the
   * owner's Raspberry Pi 5 (arm64)): at 1280x768, with the host's weekly figure
   * and no 5-hour one, the note kept its whole width and the middle row was
   * cut where the note began: "5h: not reported  W  Model limits: not
   * available". The row was `flex-1` (a basis of 0: it gets only what the
   * others leave) beside a note that did not shrink. Now the row's basis is
   * its content (`flex-auto`) and the note may shrink a thousand times as
   * much, to nothing, with an ellipsis and its reason in its title: when the
   * strip is too narrow the note gives way first, and the weekly meter keeps
   * its width. jsdom lays nothing out, so this pins the classes that decide it.
   */
  it('a helper tab at 1280 px with a weekly figure only: the weekly bar beside the note, and the note gives way first', () => {
    helperTab({ rateLimitWeekly: 75, rateLimitWeeklyResets: '2026-11-30T09:00:00Z', usageBuckets: [], remoteUsageNotShown: 'own-sign-in', modelName: 'Opus 5.5' })
    draw()
    const n = note()!
    expect(n).not.toBeNull()
    expect(container.querySelector('[data-testid="rate-limit-not-reported"]')?.textContent).toBe('5h:not reported')
    expect(bars()).toEqual(['Weekly rate limit utilisation'])
    const middle = n.parentElement!.querySelector(':scope > .overflow-hidden.min-w-0') as HTMLElement
    expect(middle).not.toBeNull()
    expect(middle.contains(container.querySelector('[aria-label="Weekly rate limit utilisation"]'))).toBe(true)
    // The row's basis is its content: never flex-1's 0.
    expect(middle.classList.contains('flex-auto')).toBe(true)
    expect(middle.classList.contains('flex-1')).toBe(false)
    // The note shrinks first and furthest, with an ellipsis; its reason stays in its title.
    for (const c of ['min-w-0', 'truncate', 'shrink-[1000]']) expect(n.classList.contains(c), c).toBe(true)
    expect(n.classList.contains('shrink-0')).toBe(false)
    expect(n.getAttribute('title')).toMatch(/^Not available: this machine uses its own sign-in\./)
    // Nothing else beside the row takes the space it needs: every other child of the strip's row is shrink-0.
    for (const el of [...n.parentElement!.children]) if (el !== middle && el !== n) expect((el as HTMLElement).classList.contains('shrink-0') || el.getAttribute('aria-hidden') === 'true', (el as HTMLElement).className).toBe(true)
  })
})
