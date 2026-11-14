// A local launch picks its assistant from the provider registry.
//
// The PTY manager used to tell the two assistants apart by one name test and
// start Claude Code for everything else, so a session naming an assistant the
// app does not know started Claude Code in its place. A local launch now looks
// its provider up in the registry: one that is not registered, or whose package
// does not declare session launches, is refused with a plain sentence and
// nothing starts. Claude Code, named or by default, starts as before, and a
// terminal tab starts no assistant, so it is not asked and still opens.
//
// The real spawnPty over the real registry: the Claude Code package as the app
// ships it (its capability declarations included), with a stand-in session
// that hands back a fixed shell. node-pty records, nothing is started, and any
// other program a child-process call asks for is recorded and refused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  root: '',
  spawns: [] as Array<{ file: string; cwd: string }>,
  /** Any program a child-process call asked for (refused, never run). */
  otherChildren: [] as string[],
}))

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('node-pty', () => ({
  spawn: (file: string, _args: string[], opts: { cwd: string }) => {
    h.spawns.push({ file, cwd: opts.cwd })
    return { pid: 4343, cols: 80, rows: 24, process: file,
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
      write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }
  },
}))
// No program is started here: every child-process call is recorded and refused
// (afterEach checks there was none).
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  const refuse = (file: unknown): never => { h.otherChildren.push(String(file)); throw new Error('no program is started in this test') }
  return {
    ...real,
    execFile: ((file: string, _args: string[], _opts: unknown, cb?: (err: Error | null, stdout: string) => void) => {
      h.otherChildren.push(String(file))
      setTimeout(() => cb?.(new Error('no program is started in this test'), ''), 0)
      return { on() {}, kill() {}, unref() {} }
    }) as unknown as typeof real.execFile,
    spawn: refuse as unknown as typeof real.spawn,
    spawnSync: refuse as unknown as typeof real.spawnSync,
    execFileSync: refuse as unknown as typeof real.execFileSync,
    execSync: refuse as unknown as typeof real.execSync,
    exec: refuse as unknown as typeof real.exec,
    fork: refuse as unknown as typeof real.fork,
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.root, getDataDirectory: () => h.root, registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()), getConductorMcpPort: () => 0 }))
// No Claude CLI is asked for its version.
vi.mock('../../../src/main/claude-cli-version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/claude-cli-version')>()),
  ensureClaudeCliVersion: () => {},
  probeClaudeCliVersion: async () => null,
}))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: () => ({ value: {}, outcome: 'ok' }),
  getConfigDir: () => h.root,
}))
// No account: these launches run outside any account's folders, and nothing of
// a real account is read or changed.
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  getPrimaryProfileId: () => null,
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
  checkProfileCredentialFolders: () => Promise.resolve(),
  withProfileHome: (env: Record<string, string>) => ({ ...env }),
}))

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
const { PROVIDER_IDS } = await import('../../../src/shared/providers')
const { registerProviderPackage, _resetProviderRegistryForTest } = await import('../../../src/main/providers/core')
const { createClaudePackage } = await import('../../../src/main/providers/claude')

// Claude Code is the first provider id in the app's own list; the second is the
// other assistant the app knows, which this test never registers.
const [CLAUDE, OTHER] = PROVIDER_IDS
const SHELL = 'stand-in-shell'
const NOT_KNOWN = /is not one this app can start/

const win = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const ids = ['not-known', 'not-registered', 'no-launch', 'by-default', 'named', 'tab', 'tab-no-launch']
let project = ''

/** Register the Claude Code package as the app ships it, with a stand-in
 *  session, and `launch` as what it declares about starting sessions. */
function registerClaude(launch: 'supported' | 'unsupported' | 'unknown' | 'experimental' = 'supported'): void {
  const real = createClaudePackage()
  const session = Object.assign(Object.create(Object.getPrototypeOf(real.session) as object), real.session, {
    resolveBinary: () => ({ cmd: 'claude', args: [] }),
    buildSpawnCommand: () => ({ cmd: SHELL, args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop() {} }),
  })
  _resetProviderRegistryForTest()
  registerProviderPackage({ ...real, session, capabilities: { ...real.capabilities, 'session.launch': { state: launch } } })
}

beforeEach(() => {
  h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-launch-registry-')))
  project = path.join(h.root, 'project')
  fs.mkdirSync(project, { recursive: true })
  h.spawns.length = 0
  h.otherChildren.length = 0
  registerClaude()
})
afterEach(() => {
  for (const id of ids) { try { killPty(id) } catch { /* not started */ } }
  _resetProviderRegistryForTest()
  // TEST CLEANUP GUARD: only this test's own folder under the temp folder.
  if (path.basename(h.root).startsWith('pty-launch-registry-') && path.dirname(h.root) === fs.realpathSync.native(os.tmpdir())) {
    fs.rmSync(h.root, { recursive: true, force: true })
  }
  expect(h.otherChildren).toEqual([])
})

describe('a local launch of an assistant the registry does not hold', () => {
  // Mutation to prove this can fail: start Claude Code for every provider id
  // that is not the other assistant's (the bare `else` this replaced).
  it('an assistant the app does not know is refused: nothing starts, and Claude Code does not run in its place', () => {
    expect(() => spawnPty(win, 'not-known', { provider: 'elsewhere', cwd: project } as never)).toThrow(NOT_KNOWN)
    expect(h.spawns).toEqual([])
  })

  it('an assistant the app knows but has not registered is refused the same way', () => {
    expect(OTHER, 'the app lists a second assistant').toBeTruthy()
    expect(() => spawnPty(win, 'not-registered', { provider: OTHER, cwd: project } as never)).toThrow(NOT_KNOWN)
    expect(h.spawns).toEqual([])
  })

  it('the sentence names the assistant asked for, with nothing in it a terminal would act on', () => {
    let message = ''
    try { spawnPty(win, 'not-known', { provider: 'else\u001b[31mwhere', cwd: project } as never) } catch (e) { message = (e as Error).message }
    expect(message).toMatch(NOT_KNOWN)
    expect(message).toContain('else')
    expect(message).not.toContain('\u001b')
    expect(h.spawns).toEqual([])
  })
})

describe('a local launch of a registered assistant that does not declare session launches', () => {
  // Mutation to prove this can fail: do not ask the registry for the capability.
  for (const state of ['unsupported', 'unknown', 'experimental'] as const) {
    it(`declared ${state}: refused, and nothing starts`, () => {
      registerClaude(state)
      expect(() => spawnPty(win, 'no-launch', { provider: CLAUDE, cwd: project } as never)).toThrow(/cannot start sessions on this computer/)
      expect(h.spawns).toEqual([])
    })
  }
})

describe('what is unchanged', () => {
  it('a session that names no assistant starts Claude Code', () => {
    expect(() => spawnPty(win, 'by-default', { cwd: project })).not.toThrow()
    expect(h.spawns).toEqual([{ file: SHELL, cwd: project }])
  })

  it('a session that names Claude Code starts it', () => {
    expect(() => spawnPty(win, 'named', { provider: CLAUDE, cwd: project } as never)).not.toThrow()
    expect(h.spawns).toEqual([{ file: SHELL, cwd: project }])
  })

  it('a terminal tab starts no assistant and is not asked: it opens whatever assistant it names', () => {
    expect(() => spawnPty(win, 'tab', { shellOnly: true, provider: 'elsewhere', cwd: project } as never)).not.toThrow()
    expect(h.spawns).toHaveLength(1)
  })

  it('a terminal tab opens though the assistant it names declares no session launches', () => {
    registerClaude('unsupported')
    expect(() => spawnPty(win, 'tab-no-launch', { shellOnly: true, provider: CLAUDE, cwd: project } as never)).not.toThrow()
    expect(h.spawns).toHaveLength(1)
  })
})
