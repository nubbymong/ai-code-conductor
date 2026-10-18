// @vitest-environment jsdom
/**
 * aicc_planning#117: a config set to "Always start a new conversation" never
 * asks to resume. A fresh launch and a plain Restart / Recover of its session
 * do not arm the resume picker; an explicit "Restart and pick a conversation"
 * still does. A config without the flag behaves exactly as before.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/ptyTracker', () => ({
  killSessionPty: vi.fn(),
  clearSpawned: vi.fn(),
  hasSpawned: vi.fn(() => false),
  markSpawned: vi.fn(),
}))
const markSessionForResumePicker = vi.fn()
vi.mock('../../../src/renderer/utils/resumePicker', () => ({
  markSessionForResumePicker: (...a: unknown[]) => markSessionForResumePicker(...a),
  shouldUseResumePicker: vi.fn(() => false),
}))

const { configStartsNewConversation, consumeKeepsConversation, markSessionKeepsConversation, spawnStartsNewConversation } = await import('../../../src/renderer/utils/alwaysNewConversation')
const { useLaunchSessionAction } = await import('../../../src/renderer/hooks/useLaunchConfig')
const { useRestartSession } = await import('../../../src/renderer/hooks/useRestartSession')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useConfigStore } = await import('../../../src/renderer/stores/configStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
import type { Session } from '../../../src/renderer/stores/sessionStore'

const cfg = (over: Record<string, unknown> = {}): any => ({
  id: 'cfg-1', label: 'worker', workingDirectory: 'C:/proj', color: '#fff',
  sessionType: 'local', provider: 'claude', allowMultiSpawn: true, ...over,
})
const session = (over: Partial<Session> = {}): Session => ({
  id: 's1', label: 'worker', workingDirectory: 'C:/proj', model: '', color: '#fff', status: 'idle',
  createdAt: 1, sessionType: 'local', provider: 'claude', configId: 'cfg-1', ...over,
} as Session)

function runHook<T>(hook: () => T, use: (value: T) => void): void {
  function Harness() {
    const value = hook()
    React.useEffect(() => { use(value) }, [])
    return null
  }
  const root: Root = createRoot(document.createElement('div'))
  act(() => { root.render(React.createElement(Harness)) })
  act(() => { root.unmount() })
}

beforeEach(() => {
  markSessionForResumePicker.mockReset()
  useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
  useConfigStore.setState({ configs: [] })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexEnabled: true } })
  ;(globalThis as any).window.electronAPI = { pty: { kill: vi.fn() } }
})

describe('configStartsNewConversation', () => {
  it('is true only for a config whose flag is true', () => {
    const configs = [cfg({ id: 'a', alwaysNewConversation: true }), cfg({ id: 'b', alwaysNewConversation: false }), cfg({ id: 'c' })]
    expect(configStartsNewConversation(configs, 'a')).toBe(true)
    expect(configStartsNewConversation(configs, 'b')).toBe(false)
    expect(configStartsNewConversation(configs, 'c')).toBe(false)
  })

  it('is false for a missing config or no config id (today\'s behaviour)', () => {
    expect(configStartsNewConversation([cfg({ alwaysNewConversation: true })], 'gone')).toBe(false)
    expect(configStartsNewConversation([cfg({ alwaysNewConversation: true })], undefined)).toBe(false)
    expect(configStartsNewConversation(undefined, 'cfg-1')).toBe(false)
  })
})

describe('spawnStartsNewConversation (TerminalView freshConversation)', () => {
  const on = { pickerArmed: false, keepsConversation: false, configStartsNew: true }
  it('is true only for a flagged config with no picker and no keep', () => {
    expect(spawnStartsNewConversation(on)).toBe(true)
    expect(spawnStartsNewConversation({ ...on, configStartsNew: false })).toBe(false)
    expect(spawnStartsNewConversation({ ...on, pickerArmed: true })).toBe(false)
    expect(spawnStartsNewConversation({ ...on, keepsConversation: true })).toBe(false)
    expect(spawnStartsNewConversation({ ...on, shellOnly: true })).toBe(false)
  })

  it('the keep mark is one-shot', () => {
    expect(consumeKeepsConversation('k1')).toBe(false)
    markSessionKeepsConversation('k1')
    expect(consumeKeepsConversation('k1')).toBe(true)
    expect(consumeKeepsConversation('k1')).toBe(false)
  })
})

describe('wiring (read from the source: TerminalView and the switch are not mounted here)', () => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const code = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8').replace(/\r\n/g, '\n').replace(/^[ \t]*\/\/.*$/gm, '')

  it('TerminalView decides by spawnStartsNewConversation, consuming the keep on every spawn', () => {
    const tv = code('src/renderer/components/TerminalView.tsx')
    expect(tv).toMatch(/const freshConversation = spawnStartsNewConversation\(\{\s*shellOnly,\s*pickerArmed: useResumePicker,\s*keepsConversation: sessionKeepsConversation\(sessionId\),/)
    // the keep is spent by the spawn that starts, not by the decision
    expect(tv).toMatch(/const spawnToken = markSpawned\(sessionId\)\s*consumeKeepsConversation\(sessionId\)/)
    // a fresh spawn sends no restored target, sends the flag, and gives a refused one its target back
    expect(tv).toContain('!shellOnly && !freshConversation && session?.resumeUuid && session?.resumeCwd')
    expect(tv).toContain('...(freshConversation ? { freshConversation: true } : {})')
    expect(tv).toContain('const keptTarget = resume ?? droppedResume')
  })

  it('both Switch account paths restart with keepConversation', () => {
    const sw = code('src/renderer/hooks/useSwitchAccount.ts')
    expect(sw).toContain('restart({ profileId: newProfileId }, { keepConversation: true })')
    expect(sw).toContain('restart({ providerAccountId: target.id }, { keepConversation: true })')
  })
})

describe('launch', () => {
  it('a config with the flag launches without arming the resume picker', () => {
    let id = ''
    runHook(useLaunchSessionAction, (launch) => { id = launch(cfg({ alwaysNewConversation: true })) })
    expect(id).toBeTruthy()
    expect(useSessionStore.getState().getSession(id)).toBeDefined()
    expect(markSessionForResumePicker).not.toHaveBeenCalled()
  })

  it('a config without the flag still arms it (unchanged)', () => {
    let id = ''
    runHook(useLaunchSessionAction, (launch) => { id = launch(cfg()) })
    expect(markSessionForResumePicker).toHaveBeenCalledWith(id)
  })

  it('several launches of a flagged config arm nothing', () => {
    const ids: string[] = []
    runHook(useLaunchSessionAction, (launch) => { for (let i = 0; i < 3; i++) ids.push(launch(cfg({ alwaysNewConversation: true }))) })
    expect(ids.filter(Boolean)).toHaveLength(3)
    expect(markSessionForResumePicker).not.toHaveBeenCalled()
  })
})

describe('restart and recover', () => {
  function restartOf(s: Session, use: (r: ReturnType<typeof useRestartSession>) => void) {
    useSessionStore.setState({ sessions: [s], activeSessionId: s.id })
    runHook(() => useRestartSession(s), use)
  }

  it('a plain Restart of a flagged Claude session does not arm the picker', () => {
    useConfigStore.setState({ configs: [cfg({ alwaysNewConversation: true })] })
    restartOf(session(), (r) => { expect(r.restart()).toBe(true) })
    expect(markSessionForResumePicker).not.toHaveBeenCalled()
  })

  it('"Restart and pick a conversation" still arms it on a flagged session', () => {
    useConfigStore.setState({ configs: [cfg({ alwaysNewConversation: true })] })
    restartOf(session(), (r) => { r.restart(undefined, { pickConversation: true }) })
    expect(markSessionForResumePicker).toHaveBeenCalledWith('s1')
  })

  it('a plain Restart of an unflagged Claude session arms it (unchanged)', () => {
    useConfigStore.setState({ configs: [cfg()] })
    restartOf(session(), (r) => { r.restart() })
    expect(markSessionForResumePicker).toHaveBeenCalledWith('s1')
  })

  it('a Switch account restart (keepConversation) on a flagged session behaves as before and marks the keep', () => {
    useConfigStore.setState({ configs: [cfg({ alwaysNewConversation: true })] })
    restartOf(session(), (r) => { r.restart({ profileId: 'p2' }, { keepConversation: true }) })
    // a Claude restart arms the picker by default, as it always has
    expect(markSessionForResumePicker).toHaveBeenCalledWith('s1')
    expect(consumeKeepsConversation('s1')).toBe(true)
    expect(consumeKeepsConversation('s1')).toBe(false)
  })

  it('a plain Restart or Recover clears a keep a torn-down view never spent', () => {
    useConfigStore.setState({ configs: [cfg({ alwaysNewConversation: true })] })
    markSessionKeepsConversation('s1')
    restartOf(session(), (r) => { r.restart() })
    expect(consumeKeepsConversation('s1')).toBe(false)
    markSessionKeepsConversation('s1')
    restartOf(session(), (r) => { r.recover() })
    expect(consumeKeepsConversation('s1')).toBe(false)
  })

  it('Recover arms it only without the flag', () => {
    useConfigStore.setState({ configs: [cfg({ alwaysNewConversation: true })] })
    restartOf(session(), (r) => { r.recover() })
    expect(markSessionForResumePicker).not.toHaveBeenCalled()
    useConfigStore.setState({ configs: [cfg()] })
    restartOf(session(), (r) => { r.recover() })
    expect(markSessionForResumePicker).toHaveBeenCalledWith('s1')
  })
})
