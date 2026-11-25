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
    // Its note sends Claude Code and Codex to the switch below it (2.1.3-beta.7, PR review).
    const plain = page.indexOf('data-testid="setting-plain-terminals-helper"')
    const block = page.slice(plain, page.indexOf('</label>', plain))
    expect(block).toContain('Claude Code and Codex sessions have their own switch below, and SSH sessions are not affected.')
    expect(block).not.toContain('Claude Code, Codex and SSH sessions are not affected.')
  })

  it('the agent sessions\' setting (2.1.3-beta.7) is off by default too, beside it, and its note says what a crash and Windows do', () => {
    expect(DEFAULT_SETTINGS.agentSessionsThroughHelper).toBe(false)
    const page = readFileSync(resolve(__dirname, '../../../src/renderer/components/SettingsPage.tsx'), 'utf8')
    const plain = page.indexOf('data-testid="setting-plain-terminals-helper"')
    const agents = page.indexOf('data-testid="setting-agent-sessions-helper"')
    expect(plain).toBeGreaterThan(0)
    expect(agents).toBeGreaterThan(plain)
    const block = page.slice(agents, page.indexOf('</label>', agents))
    expect(block).toContain('checked={settings.agentSessionsThroughHelper === true}')
    expect(block).toContain('onChange={(e) => save({ agentSessionsThroughHelper: e.target.checked })}')
    expect(block).toContain('Claude Code and Codex sessions through the session helper')
    // Q1: ended after a crash, the tab resumes; Q2: the whole tree ends on Windows.
    expect(block).toContain('when you open the app again, the session is ended and its tab resumes the conversation as before.')
    expect(block).toContain('On Windows, ending a session also ends every program it started, even one it opened in a window of its own.')
    // 2.1.3-beta.9, plan section B1: the same switch carries Insights' report terminal.
    expect(block).toContain("Insights' Claude Code report runs this way too.")
    // 2.1.3-beta.17, plan section B1 (the release smoke): an update keeps it running, and its tab takes it over.
    expect(block).toContain('On Windows it keeps running through an app update when you choose Save sessions, for up to two minutes until the new version opens: resume your sessions within five minutes of that and its tab takes the same session over.')
  })
})
