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
    expect(note()?.textContent).toBe('Model limits: not available (own sign-in)')
    expect(note()?.getAttribute('title')).toMatch(/^Not available: this machine uses its own sign-in\./)
    expect(bars()).toEqual(['5h rate limit utilisation', 'Weekly rate limit utilisation'])
    // No extra usage block, and no bar of any per-model limit.
    expect(container.textContent).not.toContain('extra:')
  })

  it('held, with no reading yet: "not available (no reading yet)", never a zero bar', () => {
    helperTab({ rateLimitCurrent: 30, usageBuckets: [], remoteUsageNotShown: 'no-reading', rateLimitExtra: { enabled: false, utilization: 0, usedUsd: 0, limitUsd: 0 } })
    draw()
    expect(note()?.textContent).toBe('Model limits: not available (no reading yet)')
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
