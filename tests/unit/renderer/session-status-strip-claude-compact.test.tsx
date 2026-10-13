// @vitest-environment jsdom
/**
 * The status strip's Compact, model and effort controls on a Claude session
 * type into Claude Code only at its ready, empty prompt: the terminal's live
 * screen, read by src/shared/claude-screen.ts. On any other screen (a turn
 * running, a question or picker up, text already typed, a view of the
 * history, no terminal) they type nothing and the strip says why for a
 * moment. Each press types its line once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import * as S from '../shared/claude-screens'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const sessionState: any = { sessions: [], updateSession: vi.fn() }
const settingsState: any = { settings: {} }

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign((sel: any) => sel(sessionState), { getState: () => sessionState }),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore, DEFAULT_STATUS_LINE: { font: 'sans', fontSize: 11 } }
})
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel: any) => sel({ profiles: [] }),
}))
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({ useRestartSession: () => ({ restart: vi.fn() }) }))
vi.mock('../../../src/renderer/hooks/useSwitchAccount', () => ({ useSwitchAccount: () => () => {} }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const { default: SessionStatusStrip } = await import('../../../src/renderer/components/SessionStatusStrip')
const { registerScreenReader } = await import('../../../src/renderer/components/terminal/screenRegistry')

let container: HTMLDivElement
let root: Root
let write: ReturnType<typeof vi.fn>
const screens = new Map<string, S.Row[]>()
const unregister: Array<() => void> = []

const claude = (over: Record<string, unknown> = {}) => ({
  id: 's1', provider: 'claude', createdAt: 1000, contextPercent: 10, model: 'claude-fable-5', modelName: 'Fable 5', ...over,
})
const render = (id = 's1') => act(() => { root.render(createElement(SessionStatusStrip, { sessionId: id })) })
const button = (title: string) => container.querySelector(`[title="${title}"]`) as HTMLButtonElement | null
const note = () => container.querySelector('[role="status"]')?.textContent ?? null
const writes = () => write.mock.calls.map((c) => [c[0], c[1]])
/** The terminal of `id` and what its live screen shows. */
const showing = (id: string, rows: S.Row[]) => {
  screens.set(id, rows)
  if (!unregister.some((u) => (u as any).id === id)) {
    const off: any = registerScreenReader(id, () => screens.get(id) ?? null)
    off.id = id
    unregister.push(off)
  }
}
const compact = () => act(() => { button('Compact the conversation')!.click() })
/** A row of the open model popup, by its label. */
const popupRow = (match: (label: string) => boolean): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => {
    const label = b.querySelector('span')?.textContent ?? ''
    return match(label)
  })
const pickModel = () => {
  act(() => { button('Model')!.click() })
  const row = popupRow((l) => l.includes('Opus') && !l.includes('1M'))
  expect(row, 'an Opus row in the popup').toBeTruthy()
  act(() => { row!.click() })
}
const pickEffort = (label = 'High') => {
  act(() => { button('Model')!.click() })
  const row = popupRow((l) => l === label)
  expect(row, `the ${label} effort row`).toBeTruthy()
  act(() => { row!.click() })
}

beforeEach(() => {
  vi.useFakeTimers()
  write = vi.fn()
  ;(globalThis as any).window.electronAPI = { pty: { write } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sessionState.sessions = [claude()]
  sessionState.updateSession = vi.fn()
  settingsState.settings = { statusLine: { font: 'sans', fontSize: 11, showEffort: true }, theme: 'dark', accountAliases: {}, accountColourOverrides: {} }
  screens.clear()
})
afterEach(() => {
  // Let every pending timer run (a send's settle time) before the real
  // timers come back, so no session is left waiting into the next test.
  act(() => { vi.advanceTimersByTime(60_000) })
  act(() => { root.unmount() })
  container.remove()
  for (const off of unregister.splice(0)) off()
  vi.useRealTimers()
})

describe("Compact on a Claude session types only at Claude Code's ready prompt", () => {
  it("compact types once at claude's ready prompt", () => {
    showing('s1', S.READY)
    render()
    compact()
    expect(writes()).toEqual([['s1', '/compact\n']])
    expect(note()).toBeNull()
  })

  it('compact types once at every shape of the ready, empty prompt', () => {
    const shapes = [
      S.READY_NEW, S.READY_ASCII, S.READY_SUGGESTION, S.READY_SUGGESTION_WRAPPED, S.READY_UNDER_QUESTION_PROSE, S.READY_TALL_FOOTER,
      S.READY_UNDER_ERROR_ADVICE, S.READY_UNDER_ERROR_ADVICE_NARROW, S.READY_UNDER_RETRY_OUTPUT,
    ]
    for (const rows of shapes) {
      write.mockClear()
      showing('s1', rows)
      render()
      compact()
      expect(writes()).toEqual([['s1', '/compact\n']])
      act(() => { vi.advanceTimersByTime(5_000) })
    }
  })

  it('compact types nothing while claude is not at its prompt, and says so for a moment', () => {
    const notAtPrompt = [
      S.TOOL_QUESTION, S.TOOL_QUESTION_NARROW, S.FILE_QUESTION, S.EDIT_QUESTION, S.TRUST, S.TRUST_NARROW, S.MODEL_PICKER,
      S.PICKER_UNDER_OLD_PROMPT, S.PICKER_UNDER_OLD_PROMPT_NB, S.NUMBERED_PICKER_IN_SIDES_UNDER_OLD_PROMPT_NB, S.QUESTION_UNDER_OLD_PROMPT,
      S.BASH_MODE, S.SHELL,
    ]
    for (const rows of notAtPrompt) {
      showing('s1', rows)
      render()
      compact()
      expect(writes()).toEqual([])
      expect(note()).toMatch(/Claude Code is not at its prompt, so nothing was sent/)
      act(() => { vi.advanceTimersByTime(60_000) })
      expect(note()).toBeNull()
    }
  })

  it('the note shows its whole text on hover, since a long one is cut short', () => {
    showing('s1', S.SCROLLED_BACK)
    render()
    compact()
    const shown = container.querySelector('[role="status"]')
    expect(shown?.textContent).toMatch(/Scroll to the bottom, then try again/)
    expect(shown?.getAttribute('title')).toBe(shown?.textContent)
  })

  it('compact types nothing during a turn, over typed text, over a view of the history, or with no terminal', () => {
    for (const [rows, said] of [
      [S.BUSY, /busy/], [S.BUSY_NARROW, /busy/],
      [S.TYPED, /already typed/], [S.TYPED_FROM_SECOND_ROW, /already typed/], [S.TYPED_ONE_BEFORE_GHOST, /already typed/],
      [S.SCROLLED_BACK, /scrolled back/], [S.SCROLLED_BACK_UNDER_STATUS_BAR, /scrolled back/], [null, /not at its prompt/],
    ] as const) {
      if (rows) showing('s1', rows as S.Row[])
      else for (const off of unregister.splice(0)) off()
      render()
      compact()
      expect(writes()).toEqual([])
      expect(note()).toMatch(said)
      act(() => { vi.advanceTimersByTime(60_000) })
    }
  })

  it('a second press right after a send types nothing more until the screen has had time to change', () => {
    showing('s1', S.READY)
    render()
    compact()
    compact()
    expect(writes()).toEqual([['s1', '/compact\n']])
    expect(note()).toMatch(/just sent/)
    act(() => { vi.advanceTimersByTime(5_000) })
    compact()
    expect(writes()).toEqual([['s1', '/compact\n'], ['s1', '/compact\n']])
  })

  it('types into the session the strip shows, by its own screen', () => {
    sessionState.sessions = [claude(), claude({ id: 's2' })]
    showing('s1', S.TOOL_QUESTION)
    showing('s2', S.READY)
    render('s2')
    compact()
    expect(writes()).toEqual([['s2', '/compact\n']])
    render('s1')
    act(() => { vi.advanceTimersByTime(5_000) })
    compact()
    expect(writes()).toEqual([['s2', '/compact\n']])
  })

  it('the wait after a send holds only the session it was sent to', () => {
    sessionState.sessions = [claude(), claude({ id: 's2' })]
    showing('s1', S.READY)
    showing('s2', S.READY)
    render('s2')
    compact()
    render('s1')
    compact()
    expect(writes()).toEqual([['s2', '/compact\n'], ['s1', '/compact\n']])
    expect(note()).toBeNull()
  })
})

describe("the model and effort pills on a Claude session type only at Claude Code's ready prompt", () => {
  it('a model types nothing while claude is not at its prompt', () => {
    showing('s1', S.TOOL_QUESTION)
    render()
    pickModel()
    expect(writes()).toEqual([])
    expect(note()).toMatch(/not at its prompt/)
  })

  it("a model types once at claude's ready prompt", () => {
    showing('s1', S.READY)
    render()
    pickModel()
    expect(writes()).toEqual([['s1', '/model opus\n']])
    expect(note()).toBeNull()
  })

  it('an effort types nothing and is not recorded while claude is not at its prompt', () => {
    showing('s1', S.TRUST)
    render()
    pickEffort()
    expect(writes()).toEqual([])
    expect(sessionState.updateSession).not.toHaveBeenCalled()
    expect(note()).toMatch(/not at its prompt/)
  })

  it("an effort types once at claude's ready prompt and is recorded on the session", () => {
    showing('s1', S.READY)
    render()
    pickEffort()
    expect(writes()).toEqual([['s1', '/effort high\n']])
    expect(sessionState.updateSession).toHaveBeenCalledWith('s1', { effortLevel: 'high' })
  })
})
