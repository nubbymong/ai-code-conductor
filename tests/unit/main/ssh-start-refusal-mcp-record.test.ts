// An SSH start that is refused before its ssh
// process exists leaves no MCP session record behind.
//
// The SSH branch records the launch's MCP credential (issueMcpSessionToken)
// before it starts ssh, so a remote Claude kept running in tmux is served the
// moment the tunnel is up. Two refusals can stop a start before any PTY is
// registered: no ssh.exe in a folder PATH names (sshProgram throws
// SSH_NOT_ON_PATH), and node-pty refusing the start itself. In beta.2 both
// came after the credential was issued and neither reached the exit path that
// releases the record, so it stayed live until the tab was closed or started
// again. Now the ssh.exe lookup runs at the top of the SSH branch, before the
// credential is issued, and a node-pty refusal after the issue releases the
// record in the catch around pty.spawn. Each refusal leaves the session
// holding no record, and a start that goes ahead still holds one.
//
// The real spawnPty SSH branch and the real MCP session records, with a fixed
// install secret and a fake MCP port; node-pty, Electron and the Windows PATH
// lookup's file test faked. Nothing is started and no host is dialled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../src/main/install-secret', () => ({ getInstallSecret: () => 'k'.repeat(64) }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()),
  getConductorMcpPort: () => 55555,
}))

const h = vi.hoisted(() => ({
  platform: 'win32' as NodeJS.Platform,
  /** Every candidate is a file when true; none is when false. */
  every: true,
  /** What the fake node-pty does with a start: refuse it, or hand back a PTY. */
  spawnRefuses: false,
  ptySpawns: [] as string[],
}))

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => h.platform,
}))

vi.mock('node-pty', () => ({
  spawn: (file: string) => {
    h.ptySpawns.push(file)
    if (h.spawnRefuses) throw new Error('__spawn_refused__')
    return {
      pid: 7171, process: 'ssh',
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {}, resize: () => {}, kill: () => {},
    }
  },
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({ getWatchdogManager: () => null }))
vi.mock('../../../src/main/bundled-conpty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/bundled-conpty')>()),
  bundledConptyChoice: () => ({ kind: 'bundled', options: { useConpty: true, useConptyDll: true }, dir: '/np/prebuilds/win32-x64' }),
}))
vi.mock('../../../src/main/debug-logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/debug-logger')>()
  const quiet = (): void => {}
  return { ...real, logDebug: quiet, logTrace: quiet, logInfo: quiet, logWarn: quiet, logError: quiet }
})
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  return {
    ...real,
    findOnWindowsPath: (names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
      real.findOnWindowsPath(names, env, () => h.every, order),
  }
})

const { spawnPty, killPty, SSH_NOT_ON_PATH } = await import('../../../src/main/pty-manager')
const { mcpSessionProvider } = await import('../../../src/main/conductor-mcp-server')
const { registerProvider } = await import('../../../src/main/providers')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const fakeWin = { webContents: { send() {} }, isDestroyed: () => false } as never
/** A persistent host: its record takes the form that outlasts an app restart. */
const SSH = { username: 'me', host: 'box.example.com', port: 2222, remotePath: '~/proj' }
const savedPath = process.env.PATH
let seq = 0
let SID = ''

beforeEach(() => {
  SID = `sshrefusal${String(++seq).padStart(10, '0')}`
  h.platform = 'win32'
  h.every = true
  h.spawnRefuses = false
  h.ptySpawns.length = 0
})
afterEach(() => {
  try { killPty(SID) } catch { /* gone */ }
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
})

describe('an SSH start refused before its ssh process exists leaves no MCP session record', () => {
  // Mutation to prove this can fail: move the ssh program lookup to after
  // issueMcpSessionToken and outside the try around pty.spawn (or drop both
  // the early lookup and that catch, as in beta.2). Moving it into the
  // pty.spawn call inside the try is not caught here: the catch then releases
  // the record, which is the same outcome by another path.
  it('no ssh.exe in a folder PATH names: refused, and the session holds no record', () => {
    process.env.PATH = '.;tools' // only folders PATH names relatively: never read
    expect(mcpSessionProvider(SID)).toBeNull()
    expect(() => spawnPty(fakeWin, SID, { ssh: SSH } as never)).toThrow(SSH_NOT_ON_PATH)
    expect(h.ptySpawns).toEqual([])
    expect(mcpSessionProvider(SID)).toBeNull()
  })

  // Mutation to prove this can fail: drop the release in the catch around the
  // SSH branch's pty.spawn.
  it('node-pty refuses the start: the refusal is passed on, and the session holds no record', () => {
    process.env.PATH = 'C:\\Tools\\OpenSSH'
    h.spawnRefuses = true
    expect(() => spawnPty(fakeWin, SID, { ssh: SSH } as never)).toThrow('__spawn_refused__')
    expect(h.ptySpawns).toEqual(['C:\\Tools\\OpenSSH\\ssh.exe'])
    expect(mcpSessionProvider(SID)).toBeNull()
  })

  it('a start that goes ahead still holds its record, until the session is torn down', () => {
    process.env.PATH = 'C:\\Tools\\OpenSSH'
    spawnPty(fakeWin, SID, { ssh: SSH } as never)
    expect(h.ptySpawns).toEqual(['C:\\Tools\\OpenSSH\\ssh.exe'])
    expect(mcpSessionProvider(SID)).toBe('claude')
    killPty(SID)
    expect(mcpSessionProvider(SID)).toBeNull()
  })

  it('off Windows a refusal by node-pty leaves no record either', () => {
    h.platform = 'linux'
    h.spawnRefuses = true
    expect(() => spawnPty(fakeWin, SID, { ssh: SSH } as never)).toThrow('__spawn_refused__')
    expect(h.ptySpawns).toEqual(['ssh'])
    expect(mcpSessionProvider(SID)).toBeNull()
  })
})
