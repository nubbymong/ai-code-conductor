// @vitest-environment jsdom
/**
 * The status strip of a tab through the session helper on another machine
 * (plan 2.1.3-beta.19, section 3; aicc_planning#434): where this computer
 * holds the tab's account, its per-model weekly bars and extra usage, from
 * this computer's own reading; where it does not, the strip says "not
 * available" with the reason, beside the five-hour and weekly figures the
 * host's own status line gives. Never an empty or zero bar for a missing
 * source. The harness is session-status-strip-surface.test.tsx's.
 *
 * The clock is pinned (PR 763 fix round 7): the strip draws a window's bar
 * only while its reset is still ahead of Date.now(), and the 1280 px case
 * names a fixed weekly reset, so with the real clock it would go red after
 * 2026-11-30T09:00Z (session-status-strip-weekly-only.test.tsx went red so
 * at 20:22Z on 2026-11-26). Only Date is faked.
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

/** The time these readings were taken at: before every reset they name. */
const READ_AT = new Date('2026-11-26T15:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(READ_AT)
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
  vi.useRealTimers()
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
 * min-w-0 clipping sibling before it is clipped.
 */
describe('the note is never clipped by the strip\'s middle row (text smoke #36)', () => {
  it('a helper tab at 1280 px: the note is a shrink-0 child of the strip after the clipped row, not inside it; its label is short', () => {
    helperTab({ rateLimitCurrent: 30, rateLimitWeekly: 40, usageBuckets: [], remoteUsageNotShown: 'no-reading', modelName: 'Opus 5.5' })
    draw()
    const n = note()!
    expect(n).not.toBeNull()
    // Not inside any clipping row.
    for (let el = n.parentElement; el && el !== container; el = el.parentElement) {
      expect((el.classList.contains('overflow-hidden') || el.classList.contains('overflow-x-clip')) && el.classList.contains('min-w-0'), `clipped by ${el.className}`).toBe(false)
    }
    // Its own parent is the strip's row, beside the clipped middle row, which comes before it.
    const middle = n.parentElement!.querySelector(':scope > .overflow-x-clip.min-w-0')
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
    const middle = n.parentElement!.querySelector(':scope > .overflow-x-clip.min-w-0') as HTMLElement
    expect(middle).not.toBeNull()
    expect(middle.contains(container.querySelector('[aria-label="Weekly rate limit utilisation"]'))).toBe(true)
    // The row's basis is its content: never flex-1's 0.
    expect(middle.classList.contains('flex-auto')).toBe(true)
    expect(middle.classList.contains('flex-1')).toBe(false)
    // The note shrinks first and furthest, with an ellipsis; its reason stays
    // in its title. Since PR 763 fix round 9 it stops at three characters.
    for (const c of ['min-w-[3ch]', 'truncate', 'shrink-[1000]']) expect(n.classList.contains(c), c).toBe(true)
    expect(n.classList.contains('shrink-0')).toBe(false)
    expect(n.getAttribute('title')).toMatch(/^Not available: this machine uses its own sign-in\./)
    // Nothing else beside the row takes the space it needs: every other child of the strip's row is shrink-0.
    for (const el of [...n.parentElement!.children]) if (el !== middle && el !== n) expect((el as HTMLElement).classList.contains('shrink-0') || el.getAttribute('aria-hidden') === 'true', (el as HTMLElement).className).toBe(true)
  })

  /**
   * PR 763 fix round 9 (the 2.1.3-beta.19 release smoke re-read, its item 8;
   * j01-strip-zoom.png): at the default 1280x768 window, on an SSH Persistent
   * tab through the helper, the note shrank to 0 px (it could be neither seen
   * nor hovered) and the row was still 15 px short (628 px for 643), so the
   * weekly meter showed "Weekly: [bar] --", its "%" cut off. Now the note
   * stops at three characters, the row's items sit 8 px apart (gap-2, was 12),
   * and the context meter's track is the one item in the row that gives way
   * (64 px down to 24 px) before the row is cut. jsdom lays nothing out, so
   * this pins the classes; tests/e2e/session-strip-1280.spec.ts measures
   * them in the real app at 1280x768. Red on 38e0edcb. Since PR 763 fix
   * round 10 the row is the text row inside the strip's telemetry, and the
   * meters follow it there (the next case).
   */
  it('at 1280 px: the note keeps three characters, the row is gap-2, and only the context track may shrink in the row', () => {
    helperTab({ inputTokens: 500, contextWindowSize: 1_000_000, contextPercent: 0, costUsd: 0.5159, linesAdded: 0, totalDurationMs: 77_000, usageBuckets: [], remoteUsageNotShown: 'no-reading', modelName: 'Opus 5.5' })
    settingsState.settings.statusLine = { font: 'sans', fontSize: 11, showRateLimits: true, showTokens: true, showContextBar: true, showCost: true, showLinesChanged: true, showDuration: true }
    draw()
    const n = note()!
    expect(n).not.toBeNull()
    expect(n.classList.contains('min-w-[3ch]')).toBe(true)
    expect(n.classList.contains('min-w-0')).toBe(false)
    const telemetry = n.parentElement!.querySelector(':scope > .overflow-x-clip.min-w-0') as HTMLElement
    expect(telemetry).not.toBeNull()
    expect(telemetry.classList.contains('gap-2')).toBe(true)
    const middle = telemetry.querySelector(':scope > .overflow-hidden.min-w-0') as HTMLElement
    expect(middle).not.toBeNull()
    expect(middle.classList.contains('gap-2')).toBe(true)
    expect(middle.classList.contains('gap-3')).toBe(false)
    // The context meter draws no box of its own: its track and percentage are the row's items.
    const ctx = middle.querySelector(':scope > [data-testid="strip-context"]') as HTMLElement
    expect(ctx).not.toBeNull()
    expect(ctx.classList.contains('contents')).toBe(true)
    const [track, pct] = [...ctx.children] as HTMLElement[]
    for (const c of ['w-16', 'min-w-6']) expect(track.classList.contains(c), c).toBe(true)
    expect(track.classList.contains('shrink-0')).toBe(false)
    expect(pct.textContent).toBe('0%')
    expect(pct.classList.contains('shrink-0')).toBe(true)
    // Every other item of the row keeps its width.
    const items = [...middle.children].filter((el) => el !== ctx) as HTMLElement[]
    expect(items.length).toBeGreaterThanOrEqual(4)
    for (const el of items) expect(el.classList.contains('shrink-0'), el.className).toBe(true)
    // The waiting meters follow the row, outside its cut.
    const pending = container.querySelector('[data-testid="statusline-pending"]') as HTMLElement
    expect(pending).not.toBeNull()
    expect(middle.contains(pending)).toBe(false)
    expect(middle.nextElementSibling).toBe(pending)
  })

  /**
   * PR 763 fix round 10 (the second pass on fix round 9): fix round 9 sized
   * the row to a fresh tab's waiting meters. Once the meters have readings,
   * each adds its reset time ("resets 3:00 pm", "resets Nov 30 10:00 am"; on
   * by default), about 230 px at 12 px text, and a working session's row
   * about 60 px more; the row's cut, at its right end where the meters were,
   * took the Weekly meter again at 1280, on a helper tab and on a local tab
   * alike. Now the meters follow the text row inside the strip's telemetry,
   * not in it, and give way only down to each meter's label, bar and
   * percentage: the reset texts go first, in a grid column whose minimum is
   * nothing, with an ellipsis and the time in the bar's title. jsdom lays
   * nothing out, so this pins the classes; the e2e case at 1024 px measures
   * them. Red on 9c11d407: the meters were the row's last item.
   */
  it('a helper tab whose meters have readings: the meters follow the text row, and only their reset texts may give way', () => {
    helperTab({
      inputTokens: 250_300, contextWindowSize: 1_000_000, contextPercent: 25, costUsd: 12.5159, linesAdded: 152, linesRemoved: 38, totalDurationMs: 8_040_000,
      rateLimitCurrent: 12, rateLimitCurrentResets: '2026-11-26T19:00:00Z', rateLimitWeekly: 34, rateLimitWeeklyResets: '2026-11-30T10:00:00Z',
      usageBuckets: [], remoteUsageNotShown: 'no-reading', modelName: 'Opus 5.5',
    })
    settingsState.settings.statusLine = { font: 'sans', fontSize: 11, showRateLimits: true, showResetTime: true, showTokens: true, showContextBar: true, showCost: true, showLinesChanged: true, showDuration: true }
    draw()
    const n = note()!
    expect(n).not.toBeNull()
    const telemetry = n.parentElement!.querySelector(':scope > .overflow-x-clip.min-w-0') as HTMLElement
    expect(telemetry).not.toBeNull()
    for (const c of ['flex-auto', 'min-w-0', 'overflow-x-clip']) expect(telemetry.classList.contains(c), c).toBe(true)
    const middle = telemetry.querySelector(':scope > .overflow-hidden.min-w-0') as HTMLElement
    expect(middle).not.toBeNull()
    expect(middle.textContent).toContain('API eq $12.5159')
    expect(middle.textContent).toContain('-38')
    // The text row does not grow, so the meters follow its last item.
    expect(middle.classList.contains('flex-initial')).toBe(true)
    expect(middle.classList.contains('flex-auto')).toBe(false)
    const weekly = container.querySelector('[aria-label="Weekly rate limit utilisation"]') as HTMLElement
    expect(weekly).not.toBeNull()
    // The meters are not in the row's cut: the item right after it.
    expect(middle.contains(weekly)).toBe(false)
    const meters = middle.nextElementSibling as HTMLElement
    expect(meters).not.toBeNull()
    expect(meters.contains(weekly)).toBe(true)
    expect(meters.parentElement).toBe(telemetry)
    // They shrink first inside the telemetry, never below their content's minimum, and no text in them wraps.
    for (const c of ['shrink-[10]', 'whitespace-nowrap']) expect(meters.classList.contains(c), c).toBe(true)
    for (const c of ['min-w-0', 'overflow-hidden', 'shrink-0']) expect(meters.classList.contains(c), c).toBe(false)
    // Each meter: its label, bar and percentage keep their width; its reset
    // text is the one part with a minimum of nothing, its time in the title.
    const meterEls = [...meters.children] as HTMLElement[]
    expect(meterEls.length).toBe(2)
    for (const m of meterEls) {
      const [label, bar, pctEl, reset] = [...m.children] as HTMLElement[]
      for (const el of [label, bar, pctEl]) expect(el.classList.contains('shrink-0'), el.className).toBe(true)
      expect(bar.getAttribute('role')).toBe('progressbar')
      expect(pctEl.textContent).toMatch(/^\d+%$/)
      for (const c of ['grid', 'grid-cols-[minmax(0,max-content)]', 'min-w-0']) expect(reset.classList.contains(c), c).toBe(true)
      const text = reset.firstElementChild as HTMLElement
      for (const c of ['min-w-0', 'truncate']) expect(text.classList.contains(c), c).toBe(true)
      expect(text.textContent).toMatch(/^resets /)
      expect(m.getAttribute('title')).toContain(text.textContent!)
    }
    expect(meterEls.map((m) => m.children[2].textContent)).toEqual(['12%', '34%'])
  })
})

/**
 * PR 763 fix round 11 (the recheck of fix rounds 9 and 10): fix round 10 left
 * the review count and the Copilot meter as shrink-0 items of the telemetry,
 * after the meters, so the whole text row gave way before either lost a
 * pixel (a headless probe of the 1280 px e2e spec's markup with the app's
 * CSS and font: at a 1024 px strip with the release smoke's controls, a
 * local tab with readings and the Copilot meter kept 164.5 px of its
 * 416.6 px row, the 153.3 px chip whole). Before fix round 10 they were the
 * row's last items and were cut first. Now they sit in one tail after the
 * meters that gives way first inside the telemetry. jsdom lays nothing out,
 * so this pins the classes; the fourth case of
 * tests/e2e/session-strip-1280.spec.ts measures them. Red on 4798802: the
 * chip's telemetry item was its own shrink-0 root. Fix round 12: the tail
 * has no clip of its own, so where it does not shrink the chip's 2 px focus
 * ring is drawn whole; where it does, the telemetry's clip cuts it, and that
 * clip is `overflow-x-clip`, no scroll container, so keyboard focus on a
 * hidden chip cannot scroll the row out of view (it scrolled 166 px with
 * `overflow-hidden` in the e2e spec's frame). Red on 58e27cba.
 */
describe('the Copilot meter gives way first inside the telemetry (PR 763 fix round 11)', () => {
  /** A local tab (no note) with readings, and the Copilot meter on. */
  const localTabWithCopilot = (showCopilot: boolean) => {
    sessionState.sessions = [{
      id: 's1', provider: 'claude', status: 'working',
      inputTokens: 250_300, contextWindowSize: 1_000_000, contextPercent: 25, costUsd: 12.5159, linesAdded: 152, linesRemoved: 38, totalDurationMs: 8_040_000,
      rateLimitCurrent: 12, rateLimitCurrentResets: '2026-11-26T19:00:00Z', rateLimitWeekly: 34, rateLimitWeeklyResets: '2026-11-30T10:00:00Z',
    }]
    settingsState.settings.githubAiUsageEnabled = true
    settingsState.settings.statusLine = { font: 'sans', fontSize: 11, showRateLimits: true, showResetTime: true, showTokens: true, showContextBar: true, showCost: true, showLinesChanged: true, showDuration: true, showCopilot }
  }

  it('a local tab with readings: the chip and its separator are in a tail after the meters that shrinks first, to nothing, with no clip of its own', () => {
    localTabWithCopilot(true)
    draw()
    expect(note()).toBeNull()
    const chip = container.querySelector('[data-ai-usage-chip]') as HTMLElement
    expect(chip).not.toBeNull()
    const telemetry = chip.closest('.flex-auto.min-w-0') as HTMLElement
    expect(telemetry).not.toBeNull()
    // The telemetry clips across, as no scroll container: focus cannot scroll it.
    expect(telemetry.classList.contains('overflow-x-clip')).toBe(true)
    expect(telemetry.classList.contains('overflow-hidden')).toBe(false)
    const tail = [...telemetry.children].find((el) => el.contains(chip)) as HTMLElement
    for (const c of ['shrink-[1000]', 'min-w-0']) expect(tail.classList.contains(c), c).toBe(true)
    expect(tail.classList.contains('shrink-0')).toBe(false)
    // No clip of its own: it would cut the chip's focus ring when there is room.
    expect(tail.classList.contains('overflow-hidden')).toBe(false)
    expect(tail.contains(container.querySelector('[data-copilot-separator]'))).toBe(true)
    // After the meters, and the telemetry's last item.
    const weekly = container.querySelector('[aria-label="Weekly rate limit utilisation"]') as HTMLElement
    const meters = [...telemetry.children].find((el) => el.contains(weekly)) as HTMLElement
    expect(meters).toBeDefined()
    expect(meters).not.toBe(tail)
    expect(meters.compareDocumentPosition(tail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(telemetry.lastElementChild).toBe(tail)
  })

  it('with neither the review count nor the Copilot meter shown, the tail is empty and draws nothing', () => {
    localTabWithCopilot(false)
    draw()
    expect(container.querySelector('[data-ai-usage-chip]')).toBeNull()
    const weekly = container.querySelector('[aria-label="Weekly rate limit utilisation"]') as HTMLElement
    const telemetry = weekly.closest('.flex-auto.min-w-0.overflow-x-clip') as HTMLElement
    expect(telemetry).not.toBeNull()
    const tail = telemetry.lastElementChild as HTMLElement
    expect(tail.contains(weekly)).toBe(false)
    expect(tail.childNodes.length).toBe(0)
    expect(tail.classList.contains('empty:hidden')).toBe(true)
  })
})
