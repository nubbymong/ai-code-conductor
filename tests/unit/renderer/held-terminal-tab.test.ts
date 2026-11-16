// @vitest-environment jsdom
/**
 * The Machines page's Re-attach (2.1.3-beta.6, plan section B): the session
 * helper names the tab that shows a held terminal, and the page shows it.
 * An open tab is brought forward (on its partner terminal, for a partner); a
 * held terminal no tab shows gets a new Terminal only tab with the id the
 * helper bound it to; an answer naming no usable tab shows nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import { listenGoToSession } from '../../../src/renderer/lib/goToSession'
import { showHeldTerminalTab } from '../../../src/renderer/utils/heldTerminalTab'
import { DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'

describe('Re-attach shows the tab the helper named', () => {
  let show: ReturnType<typeof vi.fn>
  let off: () => void

  beforeEach(() => {
    useSessionStore.setState({ sessions: [{ id: 's-open', label: 'API' }] as never, activeSessionId: null })
    show = vi.fn()
    off = listenGoToSession(show)
  })
  afterEach(() => off())

  it('no tab in the answer: nothing to show, and that is not a failure', () => {
    expect(showHeldTerminalTab(undefined)).toBe(true)
    expect(show).not.toHaveBeenCalled()
  })

  it('a held terminal no tab shows: a new Terminal only tab with the bound id, brought forward', () => {
    expect(showHeldTerminalTab({ id: 'newtab0123456789abcdef01', label: 'Terminal', open: true, partner: false })).toBe(true)
    const added = useSessionStore.getState().sessions.find((s) => s.id === 'newtab0123456789abcdef01')
    expect(added).toMatchObject({ id: 'newtab0123456789abcdef01', label: 'Terminal', shellOnly: true, sessionType: 'local', workingDirectory: '' })
    expect(useSessionStore.getState().activeSessionId).toBe('newtab0123456789abcdef01')
    expect(show).toHaveBeenCalledWith('newtab0123456789abcdef01', { partner: false })
  })

  it('a partner terminal whose tab is open: that tab, on its partner terminal', () => {
    expect(showHeldTerminalTab({ id: 's-open', label: 'API, partner terminal', open: false, partner: true })).toBe(true)
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().activeSessionId).toBe('s-open')
    expect(show).toHaveBeenCalledWith('s-open', { partner: true })
  })

  it('an open tab the helper asks to open again is not added twice', () => {
    expect(showHeldTerminalTab({ id: 's-open', label: 'Terminal', open: true, partner: false })).toBe(true)
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(show).toHaveBeenCalledWith('s-open', { partner: false })
  })

  it('an id of the wrong shape, or a tab that is gone, shows nothing', () => {
    expect(showHeldTerminalTab({ id: '../x', label: 'Terminal', open: true, partner: false })).toBe(false)
    expect(showHeldTerminalTab(null as never)).toBe(false)
    expect(showHeldTerminalTab({ id: 's-gone', label: 'Terminal', open: false, partner: true })).toBe(false)
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(show).not.toHaveBeenCalled()
  })

  it('a long label is cut to 120 characters', () => {
    showHeldTerminalTab({ id: 'newtab0123456789abcdef02', label: 'x'.repeat(500), open: true, partner: false })
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'newtab0123456789abcdef02')?.label).toHaveLength(120)
  })
})

describe('the setting', () => {
  it('is off by default, and Settings, General names it as the plan does', () => {
    expect(DEFAULT_SETTINGS.plainTerminalsThroughHelper).toBe(false)
    const page = readFileSync(resolve(__dirname, '../../../src/renderer/components/SettingsPage.tsx'), 'utf8')
    expect(page).toContain('Plain terminals through the session helper')
    expect(page).toContain('data-testid="setting-plain-terminals-helper"')
  })
})
