// aicc_planning#93: an SSH session's setup asks for the remote attention hook
// under the same switch that gives a local session its hooks (Settings, Hooks:
// HTTP Hooks Gateway, `hooksEnabled`, on unless turned off), for the host setup and the container
// setup alike. The real spawnPty SSH branch; node-pty, Electron and the
// credential issuer faked; nothing is dialled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  setupOpts: [] as Array<{ includeAttention?: boolean }>,
  dataCbs: [] as Array<(d: string) => void>,
}))

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))
vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 5252, process: 'ssh',
    onData: (cb: (d: string) => void) => { h.dataCbs.push(cb); return { dispose: () => {} } },
    onExit: () => ({ dispose: () => {} }),
    write: () => {}, resize: () => {}, kill: () => {},
  }),
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({ getWatchdogManager: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: (key: string) => (key === 'settings' ? h.settings : null),
  readConfigChecked: (key: string) => (key === 'settings' ? { value: h.settings, outcome: 'ok' } : { value: null, outcome: 'absent' }),
}))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()),
  getConductorMcpPort: () => 4100,
  issueMcpSessionToken: () => 'tok',
}))

const { spawnPty, getSshFlow, killPty, _getSshEntryNonceForTest } = await import('../../../src/main/pty-manager')
const { entrySentinel } = await import('../../../src/shared/container-command')
const { registerProvider } = await import('../../../src/main/providers')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')

const real = new ClaudeProvider()
registerProvider(Object.assign(Object.create(ClaudeProvider.prototype) as object, real, {
  configureRemoteSettings: (_sid: string, _path: string, _hooks: unknown, opts: { includeAttention?: boolean }) => { h.setupOpts.push({ ...opts }); return 'echo setup' },
  windowsRemoteSetupCommand: (_sid: string, opts: { includeAttention?: boolean }) => { h.setupOpts.push({ ...opts }); return 'echo setup' },
}) as never)

const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const SSH = { username: 'dev', host: 'box.example.com', port: 2222, remotePath: '~' }
const feed = (d: string): void => { for (const cb of h.dataCbs) cb(d) }
let seq = 0
let SID = ''

beforeEach(() => {
  vi.useFakeTimers()
  SID = `sshattnsw${String(++seq).padStart(15, '0')}`
  h.settings = {}; h.setupOpts = []; h.dataCbs = []
})
afterEach(() => {
  try { killPty(SID) } catch { /* gone */ }
  vi.useRealTimers()
})

const hostSetup = (): void => {
  spawnPty(fakeWin, SID, { ssh: SSH } as never)
  getSshFlow(SID)!.launchClaude()
  vi.advanceTimersByTime(300)
}
const containerSetup = (): void => {
  spawnPty(fakeWin, SID, { ssh: { ...SSH, runtime: { type: 'container', container: 'ccc-test' } } } as never)
  feed('Welcome\r\n')
  vi.advanceTimersByTime(1500)
  getSshFlow(SID)!.runPostCommand()
  vi.advanceTimersByTime(300)
  feed(`${entrySentinel(_getSshEntryNonceForTest(SID)!, 'IN')}\r\nuser@container:~$ `)
  getSshFlow(SID)!.launchClaude()
  feed(`${entrySentinel(_getSshEntryNonceForTest(SID)!, 'HERE')}\r\n`)
  vi.advanceTimersByTime(300)
}

describe('the SSH setups ask for the remote attention hook', () => {
  // Mutation to prove this can fail: drop includeAttention from the host setupOpts.
  it('host setup: on by default, as a local session\'s hooks are', () => {
    hostSetup()
    expect(h.setupOpts).toHaveLength(1)
    expect(h.setupOpts[0].includeAttention).toBe(true)
  })

  it('host setup: off when the HTTP Hooks Gateway switch is turned off', () => {
    h.settings = { hooksEnabled: false }
    hostSetup()
    expect(h.setupOpts[0].includeAttention).toBe(false)
  })

  it('container setup: on by default, off when the HTTP Hooks Gateway switch is turned off', () => {
    containerSetup()
    expect(h.setupOpts[0].includeAttention).toBe(true)
    try { killPty(SID) } catch { /* gone */ }
    SID = `sshattnsw${String(++seq).padStart(15, '0')}`
    h.settings = { hooksEnabled: false }; h.setupOpts = []; h.dataCbs = []
    containerSetup()
    expect(h.setupOpts[0].includeAttention).toBe(false)
  })
})
