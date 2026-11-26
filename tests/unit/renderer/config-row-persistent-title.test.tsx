// @vitest-environment jsdom
/**
 * A saved SSH Persistent config's chip title names what keeps its sessions
 * (plan 2.1.3-beta.19 section 1.2; the Rocky host line's finding 2): the row
 * read "kept alive in tmux" for a config whose tabs the session helper keeps,
 * also beside the amber count of a session it kept. The row now makes the
 * choice the session card and the header pill make (remoteVia 'helper'),
 * lifted to the config: a session of it the helper keeps (an open tab marked
 * so, or one left running there) names the helper; a config on the usual path
 * keeps the tmux title; one whose path nothing has decided yet (the switch on,
 * no session of it) names both.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SETTINGS = vi.hoisted(() => ({ settings: { codexEnabled: true, remoteSessionsThroughHelper: true } as Record<string, unknown> }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(SETTINGS)
  useSettingsStore.getState = () => SETTINGS
  return { useSettingsStore }
})
vi.mock('../../../src/renderer/hooks/useLaunchConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/hooks/useLaunchConfig')>()),
  useLaunchConfig: () => () => '',
}))

const { default: ConfigRow } = await import('../../../src/renderer/components/sidebar/ConfigRow')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useDetachedRemotesStore } = await import('../../../src/renderer/stores/detachedRemotesStore')
const { persistentKeeperOf } = await import('../../../src/renderer/components/sidebar/transportBadge')

const HELPER_TITLE = 'Persistent SSH session, kept by the session helper on its machine until you end it; a dropped connection or a quit reattaches'
const TMUX_TITLE = 'Persistent SSH session — kept alive in tmux; a dropped connection reattaches'
const DID = '0123456789abcdef0123456789abcdef'

const config: any = {
  id: 'cfg-pi', label: 'Pi', workingDirectory: '~', color: '', sessionType: 'ssh', provider: 'claude',
  sshConfig: { host: 'pi.lan', port: 22, username: 'nick', remotePath: '~/work' },
}
const entry = (mux: 'helper' | 'tmux'): any => ({
  sessionId: `left-${mux}`, configId: config.id, host: 'pi.lan', username: 'nick', remotePath: '~/work', port: 22,
  mux, ...(mux === 'helper' ? { did: DID } : {}), label: 'Pi', detachedAt: 1,
})
const tab = (remoteVia?: 'helper'): any => ({
  id: `tab-${remoteVia ?? 'tmux'}`, configId: config.id, label: 'Pi', workingDirectory: '~', model: '', color: '', status: 'idle', createdAt: 0,
  sessionType: 'ssh', provider: 'claude', sshConfig: config.sshConfig, ...(remoteVia ? { remoteVia, remoteDid: DID } : {}),
})

describe('a saved SSH Persistent config row\'s chip title', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    SETTINGS.settings.remoteSessionsThroughHelper = true
    useSessionStore.setState({ sessions: [] })
    useDetachedRemotesStore.setState({ entries: [] })
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    useSessionStore.setState({ sessions: [] })
    useDetachedRemotesStore.setState({ entries: [] })
  })

  const title = (): string => {
    act(() => root.render(React.createElement(ConfigRow, { config, onLaunch: () => {}, onEdit: () => {}, onDelete: () => {}, onContextMenu: () => {} } as any)))
    return container.querySelector('[data-testid="ssh-persistent-badge"]')?.getAttribute('title') ?? ''
  }

  it('a config whose session the helper keeps, left running (the amber count\'s entry): names the helper, not tmux', () => {
    useDetachedRemotesStore.setState({ entries: [entry('helper')] })
    expect(title()).toBe(HELPER_TITLE)
    expect(title()).not.toContain('tmux')
  })

  it('a config with an open tab the helper keeps: names the helper, also with the switch turned off since', () => {
    useSessionStore.setState({ sessions: [tab('helper')] })
    expect(title()).toBe(HELPER_TITLE)
    SETTINGS.settings.remoteSessionsThroughHelper = false
    expect(title()).toBe(HELPER_TITLE)
  })

  it('a config on the usual path keeps the tmux title: the switch off, or a session of it under tmux', () => {
    SETTINGS.settings.remoteSessionsThroughHelper = false
    expect(title()).toBe(TMUX_TITLE)
    SETTINGS.settings.remoteSessionsThroughHelper = true
    useDetachedRemotesStore.setState({ entries: [entry('tmux')] })
    expect(title()).toBe(TMUX_TITLE)
    useDetachedRemotesStore.setState({ entries: [] })
    useSessionStore.setState({ sessions: [tab()] })
    expect(title()).toBe(TMUX_TITLE)
  })

  it('a config whose path nothing has decided (the switch on, no session of it) names both, never only tmux', () => {
    const t = title()
    expect(t).toContain('by the session helper or in tmux')
    expect(t).not.toBe(TMUX_TITLE)
    expect(t).not.toContain('—')
  })

  it('the rule itself: a helper mark wins; the switch off or a usual-path session is tmux; nothing decided is either', () => {
    expect(persistentKeeperOf({ switchOn: false, openTabs: [], leftRunning: ['helper'] })).toBe('helper')
    expect(persistentKeeperOf({ switchOn: true, openTabs: [undefined, 'helper'], leftRunning: [] })).toBe('helper')
    expect(persistentKeeperOf({ switchOn: false, openTabs: [], leftRunning: [] })).toBe('tmux')
    expect(persistentKeeperOf({ switchOn: true, openTabs: [undefined], leftRunning: [] })).toBe('tmux')
    expect(persistentKeeperOf({ switchOn: true, openTabs: [], leftRunning: ['tmux'] })).toBe('tmux')
    expect(persistentKeeperOf({ switchOn: true, openTabs: [], leftRunning: [] })).toBe('either')
  })
})
