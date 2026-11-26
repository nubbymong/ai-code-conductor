/**
 * A tab whose session the session helper keeps until it is ended (plan
 * 2.1.3-beta.19 section 1.2; aicc_planning#437), in the renderer:
 *
 * - main's flow state marks it (`kept`) and the saved set is written at once,
 *   so a crash keeps the mark; buildSessionState saves the mark for it and
 *   for no other tab;
 * - its close asks Leave running or End, naming the helper; Leave running
 *   records a 'helper' entry with its machine's device id and sends no end;
 *   End ends it through main's helper door (never tmux's), and one that was
 *   not ended is left recorded as running;
 * - a Machines card's rows from a list answer: Re-attach where the app holds
 *   a config for it, End only where it holds none, and neither for a session
 *   a tab shows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionState, DetachedRemote } from '../../../src/shared/types'
import type { RemoteKeptSession } from '../../../src/shared/remote-machines'

const save = vi.fn((_s: SessionState) => Promise.resolve(true))
const endRemote = vi.fn(() => Promise.resolve())
const endTab = vi.fn((_id: string, _did?: string) => Promise.resolve({ ok: true, message: 'Ended.' }))

vi.stubGlobal('window', {
  electronAPI: {
    webview: { forget: vi.fn(() => Promise.resolve(true)) },
    pty: { write: vi.fn(), kill: vi.fn() },
    session: { save },
    ssh: { endRemote },
    machines: { remote: { endTab } },
  },
})

const killSessionPty = vi.fn()
vi.mock('../../../src/renderer/ptyTracker', () => ({
  killSessionPty: (id: string) => killSessionPty(id),
  clearSpawned: vi.fn(),
}))

const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useDetachedRemotesStore } = await import('../../../src/renderer/stores/detachedRemotesStore')
const { useSshCloseStore, requestCloseSession, leaveRunningAndClose, endRemoteAndClose } = await import('../../../src/renderer/stores/sshCloseStore')
const { buildSessionState } = await import('../../../src/renderer/session-persistence')
const { markKeptByHelper } = await import('../../../src/renderer/utils/keptByHelper')
const { keptRows } = await import('../../../src/renderer/utils/keptRows')

const DID = '0123456789abcdef0123456789abcdef'
const keptSession = (over: Record<string, unknown> = {}) => ({
  id: 'kept-1',
  configId: 'cfg-pi',
  label: 'Pi',
  workingDirectory: '',
  color: '#fff',
  status: 'idle',
  createdAt: 1,
  sessionType: 'ssh',
  provider: 'claude',
  sshConfig: { host: 'pi.lan', port: 22, username: 'nick', remotePath: '~/work' },
  remoteVia: 'helper',
  remoteDid: DID,
  ...over,
}) as never

beforeEach(() => {
  save.mockClear()
  endRemote.mockClear()
  endTab.mockClear()
  killSessionPty.mockClear()
  endTab.mockImplementation(() => Promise.resolve({ ok: true, message: 'Ended.' }))
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  useDetachedRemotesStore.setState({ entries: [] })
  useSshCloseStore.setState({ pending: null })
})

describe('the mark', () => {
  it('main\'s flow state marks the tab and writes the saved set at once (a crash keeps it)', () => {
    useSessionStore.setState({ sessions: [keptSession({ remoteVia: undefined, remoteDid: undefined })], activeSessionId: 'kept-1' })
    markKeptByHelper('kept-1', DID)
    const s = useSessionStore.getState().sessions[0] as { remoteVia?: string; remoteDid?: string }
    expect(s.remoteVia).toBe('helper')
    expect(s.remoteDid).toBe(DID)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].sessions[0]).toMatchObject({ id: 'kept-1', remoteVia: 'helper', remoteDid: DID })
    // Marked once: the same answer again writes nothing.
    markKeptByHelper('kept-1', DID)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('a local tab is never marked, and a device id that is not one is refused', () => {
    useSessionStore.setState({ sessions: [keptSession({ sessionType: 'local', remoteVia: undefined, remoteDid: undefined })], activeSessionId: 'kept-1' })
    markKeptByHelper('kept-1', DID)
    markKeptByHelper('kept-1', 'not-a-did')
    expect((useSessionStore.getState().sessions[0] as { remoteVia?: string }).remoteVia).toBeUndefined()
    expect(save).not.toHaveBeenCalled()
  })

  it('the saved set carries the mark for a marked SSH tab only (absent otherwise, so a tab saved before beta.19 reads as tmux)', () => {
    useSessionStore.setState({ sessions: [keptSession(), keptSession({ id: 'tmux-1', remoteVia: undefined, remoteDid: undefined })], activeSessionId: 'kept-1' })
    const saved = buildSessionState().sessions
    expect(saved.find((s) => s.id === 'kept-1')).toMatchObject({ remoteVia: 'helper', remoteDid: DID })
    const tmux = saved.find((s) => s.id === 'tmux-1')!
    expect('remoteVia' in tmux).toBe(false)
    expect('remoteDid' in tmux).toBe(false)
  })
})

describe('closing a kept tab', () => {
  it('asks Leave running or End, naming the helper', () => {
    useSessionStore.setState({ sessions: [keptSession()], activeSessionId: 'kept-1' })
    requestCloseSession('kept-1')
    expect(useSshCloseStore.getState().pending).toMatchObject({ sessionId: 'kept-1', helper: true })
    expect(killSessionPty).not.toHaveBeenCalled()
  })

  it('Leave running records a helper entry with its machine, closes the tab, and sends no end', () => {
    useSessionStore.setState({ sessions: [keptSession()], activeSessionId: 'kept-1' })
    leaveRunningAndClose('kept-1')
    const entries = useDetachedRemotesStore.getState().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ sessionId: 'kept-1', mux: 'helper', did: DID, configId: 'cfg-pi' })
    expect(endTab).not.toHaveBeenCalled()
    expect(endRemote).not.toHaveBeenCalled()
    expect(killSessionPty).toHaveBeenCalledWith('kept-1')
    expect(useSessionStore.getState().sessions).toHaveLength(0)
  })

  it('End ends it through the helper (never tmux), drops its entry and closes the tab', async () => {
    useSessionStore.setState({ sessions: [keptSession()], activeSessionId: 'kept-1' })
    useDetachedRemotesStore.setState({ entries: [{ sessionId: 'kept-1', host: 'pi.lan', username: 'nick', remotePath: '~/work', mux: 'helper', did: DID, label: 'Pi', detachedAt: 1 }] })
    await endRemoteAndClose('kept-1')
    expect(endTab).toHaveBeenCalledWith('kept-1', DID)
    expect(endRemote).not.toHaveBeenCalled()
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(0)
    expect(killSessionPty).toHaveBeenCalledWith('kept-1')
    expect(useSessionStore.getState().sessions).toHaveLength(0)
  })

  it('an End its machine did not answer leaves it recorded as running, so it is still offered', async () => {
    endTab.mockImplementation(() => Promise.resolve({ ok: false, message: 'pi.lan could not be reached' }))
    useSessionStore.setState({ sessions: [keptSession()], activeSessionId: 'kept-1' })
    await endRemoteAndClose('kept-1')
    expect(useDetachedRemotesStore.getState().entries).toMatchObject([{ sessionId: 'kept-1', mux: 'helper', did: DID }])
    expect(useSessionStore.getState().sessions).toHaveLength(0)
  })

  it('a tmux tab\'s End still goes to tmux\'s door, as before', async () => {
    useSessionStore.setState({ sessions: [keptSession({ id: 'tmux-1', remoteVia: undefined, remoteDid: undefined, sshTmuxPersistent: true })], activeSessionId: 'tmux-1' })
    await endRemoteAndClose('tmux-1')
    expect(endRemote).toHaveBeenCalledTimes(1)
    expect(endTab).not.toHaveBeenCalled()
  })
})

describe('a Machines card\'s rows, from a list answer', () => {
  const row = (appSessionId: string | null, over: Partial<RemoteKeptSession> = {}): RemoteKeptSession => ({ sid: `rm${'0'.repeat(29)}${appSessionId?.length ?? 0}`, appSessionId, untilEnded: true, attached: false, running: true, ...over })
  const config = { id: 'cfg-pi', label: 'Pi', sessionType: 'ssh', sshConfig: { host: 'pi.lan', port: 22, username: 'nick', remotePath: '~/work' } } as never
  const entry: DetachedRemote = { sessionId: 'left-1', configId: 'cfg-pi', host: 'pi.lan', username: 'nick', remotePath: '~/work', port: 22, mux: 'helper', did: DID, label: 'Pi work', detachedAt: 1 }
  it('a session left running with its config: named by its entry, with the config Re-attach opens it through', () => {
    const [r] = keptRows([row('left-1')], [entry], [config], new Set(), new Map())
    expect(r).toMatchObject({ label: 'Pi work', open: false })
    expect(r.config).toBe(config)
  })
  it('a session the app holds no config for: End only (no config)', () => {
    const [r] = keptRows([row('gone-1')], [], [config], new Set(), new Map())
    expect(r.config).toBeUndefined()
    expect(r.label).toBe('Session gone-1')
  })
  it('a session a tab shows: open, named by its tab', () => {
    const [r] = keptRows([row('open-1')], [], [config], new Set(['open-1']), new Map([['open-1', 'My tab']]))
    expect(r).toMatchObject({ open: true, label: 'My tab' })
  })
  it('a holder whose label names no app session is listed with a plain name', () => {
    const [r] = keptRows([row(null)], [], [config], new Set(), new Map())
    expect(r).toMatchObject({ label: 'A session', open: false, config: undefined })
  })
})
