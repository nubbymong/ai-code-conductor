// The app's side of a tab through the session helper on another machine (plan
// 2.1.3-beta.18, section 3.2; aicc_planning#431), as
// registerRemoteMachinesHandlers plugs it into remote step 1 (the deps'
// `signals`):
//  - a tool stream is served as the tab's session with no credential: the
//    record a credential's first issue would make, with none made or handed
//    out (recordHeldToolSession), then serveToolStream; no token is issued;
//  - a hook event goes to the session signals module as a remote one (its
//    transcript path kept from the binder);
//  - a status line goes to the status strip's helper ingest;
//  - the tab's end ends its hook state there (endHelperHooks);
//  - the tools are served only while the built-in tools are on and their
//    server has a port.
//
// PURE: ipcMain is the shared mock; the tool host, the signals module, the
// status ingest and the tools switch are stand-ins that record their calls.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as string[],
  port: 0,
  master: false,
  deps: [] as Array<Record<string, any>>,
}))

vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => ({ remoteSessionsThroughHelper: true }) }))
vi.mock('../../../src/main/remote-helper', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/remote-helper')>()),
  setRemoteHelperDeps: (d: Record<string, any>) => { h.deps.push(d) },
}))
vi.mock('../../../src/main/remote-helper/machines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/remote-helper/machines')>()),
  fileStore: () => ({ read: () => null, write: () => {} }),
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => h.port,
  recordHeldToolSession: (id: string, provider: string) => { h.calls.push(`record ${id} ${provider}`) },
  serveToolStream: (id: string) => { h.calls.push(`serve ${id}`); return true },
  issueMcpSessionToken: (id: string) => { h.calls.push(`issue ${id}`); return 'a-token' },
}))
vi.mock('../../../src/main/conductor-tools-switch', () => ({ conductorToolsMasterOn: () => h.master }))
vi.mock('../../../src/main/session-signals/hooks', () => ({
  helperHookEvent: (id: string, _e: unknown, opts?: { remote?: boolean }) => { h.calls.push(`event ${id} ${JSON.stringify(opts ?? {})}`) },
  endHelperHooks: (id: string) => { h.calls.push(`end hooks ${id}`) },
}))
vi.mock('../../../src/main/statusline-watcher', () => ({
  dispatchHelperStatus: (id: string, line: Record<string, unknown>) => { h.calls.push(`status ${id} ${JSON.stringify(line)}`) },
}))

const { registerRemoteMachinesHandlers } = await import('../../../src/main/ipc/remote-machines-handlers')

const win = { isDestroyed: () => false, webContents: { mainFrame: {} } } as never

beforeEach(() => {
  h.calls = []
  h.deps = []
  h.port = 0
  h.master = false
})

function signals() {
  registerRemoteMachinesHandlers(() => win, 'win32')
  expect(h.deps).toHaveLength(1)
  const s = h.deps[0].signals
  expect(s).toBeDefined()
  return s as { toolsServed(): boolean; status(id: string, l: unknown): void; event(id: string, e: unknown): void; serve(id: string, p: string, link: unknown): boolean; ended(id: string): void }
}

describe('the app\'s side of a helper tab', () => {
  it('a tool stream is served as the tab\'s session with no credential: recorded, then served, and no token issued', () => {
    const s = signals()
    const link = { send() {}, take() {}, close() {} }
    expect(s.serve('tab-remote', 'claude', link)).toBe(true)
    expect(h.calls).toEqual(['record tab-remote claude', 'serve tab-remote'])
    expect(h.calls.some((c) => c.startsWith('issue'))).toBe(false)
  })

  it('a hook event goes to the session signals module as a remote one; a status line to the helper ingest', () => {
    const s = signals()
    s.event('tab-remote', { seq: 1, kind: 'Stop', payload: { hook_event_name: 'Stop' } })
    s.status('tab-remote', { model: 'Opus' })
    expect(h.calls).toEqual(['event tab-remote {"remote":true}', 'status tab-remote {"model":"Opus"}'])
  })

  it('the tab\'s end ends its hook state in the session signals module (its ring and marks), for the tab only', () => {
    const s = signals()
    expect(typeof s.ended).toBe('function')
    s.ended('tab-remote')
    expect(h.calls).toEqual(['end hooks tab-remote'])
  })

  it('the tools are served only while the built-in tools are on and their server has a port', () => {
    const s = signals()
    const answers: boolean[] = []
    for (const [master, port] of [[false, 0], [true, 0], [false, 4123], [true, 4123]] as const) {
      h.master = master
      h.port = port
      answers.push(s.toolsServed())
    }
    expect(answers).toEqual([false, false, false, true])
  })

  it('off Windows nothing is plugged in', () => {
    registerRemoteMachinesHandlers(() => win, 'linux')
    expect(h.deps).toEqual([])
  })
})
