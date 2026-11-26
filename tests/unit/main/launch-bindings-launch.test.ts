// S16 step 3 (aicc_planning#375): pty-manager.ts calls a launch's bindings
// (src/main/sessions/launch-bindings.ts) once per launch, each at its place, and
// their unbinds once per end, in order. A Claude Code launch captures its
// account only after its process has started (B3). A Codex launch mints its
// hooks before its command is built, keeps them once it is built, takes its
// lease right before the spawn, and binds its pane and conversation after it.
// Every launch's logging run comes after its own bindings. A session's own exit
// removes its per-session files once, then its teardown drops the lease, the
// telemetry and the registrations, in that order. The module's own calls are
// held by tests/unit/main/launch-bindings.test.ts.
//
// Not checked here: an SSH launch (its branch is not touched by the move, and
// the live SSH matrix covers it); a kill's teardown, which runs the same
// cleanupSessionResources as an exit; what each binding does inside (the
// module test).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  journal: [] as string[],
  ptys: [] as Array<{ exit: Array<(e: { exitCode: number }) => void> }>,
  removedFiles: [] as string[],
}))

/** The module's functions, each recorded by name, then run as they are. */
vi.mock('../../../src/main/sessions/launch-bindings', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const wrapped: Record<string, unknown> = {}
  for (const [name, v] of Object.entries(real)) {
    wrapped[name] = typeof v === 'function' ? (...a: unknown[]) => { h.journal.push(name); return (v as (...x: unknown[]) => unknown)(...a) } : v
  }
  return wrapped
})
vi.mock('node-pty', () => ({
  spawn: () => {
    h.journal.push('spawn')
    const p = { exit: [] as Array<(e: { exitCode: number }) => void> }
    h.ptys.push(p)
    return {
      pid: 6000 + h.ptys.length,
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { p.exit.push(cb); return { dispose: () => {} } },
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
  },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => os.tmpdir(), getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
// [host] The real logger keeps its log inside the test's own folder, never the
// installed app's (tests/helpers/test-data-dir.ts).
const TEST_DATA = await vi.hoisted(async () => (await import('../../helpers/test-data-dir')).useTestDataDirectory())
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: () => 'tok',
  registerCodexReviewSession: () => {},
  registerClaudeReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
  releaseMcpSessionProvider: () => {},
}))
vi.mock('../../../src/main/providers', async () => (await import('../../helpers/codex-local-launch')).withCodexLocalLaunch(await (() => ({
  providerCapability: () => ({ enabled: true }),
  getProvider: (id: string) => ({
    resolveBinary: () => ({ cmd: 'claude', source: 'system' }),
    buildSpawnCommand: (opts: Record<string, any>) => {
      if (opts.provider !== 'codex') return { cmd: 'pwsh', args: [], env: {} }
      return { cmd: opts.realmLaunch.executable, args: [], env: { ...opts.realmLaunch.env }, hooksInstalled: !!opts.codexHooks }
    },
    ...(id === 'codex' ? { prepareSessionHooks: (sid: string) => ({ hookFile: `/tmp/codex-hooks/x/${sid}/hook.json`, dispose: () => {} }) } : {}),
    ingestSessionTelemetry: () => ({ stop: () => {} }),
  }),
}))()))
await (await import('../../helpers/codex-local-launch')).loadCodexLocalLaunch()
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({
  getGateway: () => ({
    status: () => ({ enabled: true, listening: true, port: 51234 }),
    registerSession: () => '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60',
    unregisterSession: () => {},
  }),
  isExactBindSourceActive: () => true,
}))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => '/nonexistent/settings.json',
  removeLocalSessionSettings: (sid: string) => { h.removedFiles.push(`settings:${sid}`) },
  writeLocalSessionMcpConfig: () => '/nonexistent/mcp.json',
  removeLocalSessionMcpConfig: (sid: string) => { h.removedFiles.push(`mcp:${sid}`) },
  removeLocalSessionStatusUrl: (sid: string) => { h.removedFiles.push(`status-url:${sid}`) },
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => { h.journal.push('captureClaudeAccount') },
  clearClaudeAccount: () => {},
  getAccountIdentity: () => null,
  pushAccountIdentity: () => {},
  startWatchingAccountIdentity: () => {},
  stopWatchingAccountIdentity: () => {},
  getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {} }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({
  getWatchdogManager: () => ({ startWatchdog: () => {}, stopWatchdog: () => {}, feedData: () => {}, noteRedrawTrigger: () => {}, noteResize: () => {} }),
  clampAnsiChunk: (d: string) => d,
}))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => os.tmpdir(),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => path.join(os.tmpdir(), 'ccc-no-such-profile'),
  setupProfileLinks: () => {},
  syncPrimaryCredentialsWithGlobal: () => {},
  backupProfileHomeToCanonical: () => {},
}))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: async () => ({ ok: true }) }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => null }))

/** pty-manager.ts registers its ports with the module once, as it loads. */
const atLoad = [...h.journal]
const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
const registeredAtLoad = h.journal.filter((n) => n === 'setLaunchBindingPorts').length - atLoad.filter((n) => n === 'setLaunchBindingPorts').length

const CODEX_SID = 'cx0000000000000000000007'
const CLAUDE_SID = 'cl0000000000000000000007'
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const codexLaunch = () => ({
  lease: { release: () => {}, accountId: 'acct-b1' },
  executable: '/proven/b1/codex',
  env: { PATH: '/usr/bin', CODEX_HOME: '/res/codex-realms/b1' },
  sessionsDir: '/res/codex-realms/b1/sessions',
})
const TEARDOWN = ['unbindCodexLease', 'unbindLaunchTelemetry', 'unbindLaunchRegistrations']
const BINDINGS = new Set(['mintCodexHooks', 'keepCodexHooks', 'bindCodexLease', 'bindCodexPane', 'bindCodexLaunch', 'bindClaudeLaunch', 'bindLoggingRun', 'unbindLaunchFiles', ...TEARDOWN, 'spawn', 'captureClaudeAccount'])
const seen = (): string[] => h.journal.filter((n) => BINDINGS.has(n))
const exitLast = (): void => { const p = h.ptys.at(-1)!; for (const cb of [...p.exit]) cb({ exitCode: 0 }) }

beforeEach(() => {
  for (const sid of [CODEX_SID, CLAUDE_SID]) { try { killPty(sid) } catch { /* none */ } }
  for (const p of h.ptys) for (const cb of [...p.exit]) cb({ exitCode: 0 })
  h.journal.length = 0
  h.ptys.length = 0
  h.removedFiles.length = 0
})

describe('pty-manager.ts and the launch bindings module', () => {
  it('registers its ports with the module once, as it loads', () => {
    void TEST_DATA
    expect(registeredAtLoad).toBe(1)
  })

  it('a Claude Code launch: its bindings once, after its process has started, then its logging run', () => {
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    // The spawn opens with the teardown of whatever the id had (killPty), then the launch.
    expect(seen()).toEqual([...TEARDOWN, 'spawn', 'bindClaudeLaunch', 'captureClaudeAccount', 'bindLoggingRun'])
  })

  it('a Codex launch: its hooks before the command, its lease before the spawn, its pane and conversation after it, then its logging run', () => {
    spawnPty(fakeWin, CODEX_SID, { cwd: os.tmpdir(), provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: codexLaunch() } as never)
    expect(seen()).toEqual([...TEARDOWN, 'mintCodexHooks', 'keepCodexHooks', 'bindCodexLease', 'spawn', 'bindCodexPane', 'bindCodexLaunch', 'bindLoggingRun'])
  })

  it('a session\'s own exit: its files once, then the teardown\'s three parts in order', () => {
    for (const [sid, opts] of [
      [CLAUDE_SID, { cwd: os.tmpdir() }],
      [CODEX_SID, { cwd: os.tmpdir(), provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: codexLaunch() }],
    ] as const) {
      spawnPty(fakeWin, sid, opts as never)
      h.journal.length = 0
      h.removedFiles.length = 0
      exitLast()
      expect(seen(), sid).toEqual(['unbindLaunchFiles', ...TEARDOWN])
      expect(h.removedFiles, sid).toEqual([`settings:${sid}`, `mcp:${sid}`, `status-url:${sid}`])
    }
  })
})
