// 2.1.3-beta.17, plan section B1 (S16 step 5, aicc_planning#412): a restored
// Claude Code tab whose session an app update kept running takes it over in
// place of its launch. pty-manager.ts asks the launch bindings once, before
// the provider branches (takeOverKeptLaunch); when the session helper keeps a
// session for the tab, nothing is spawned and no launch line is typed, the
// launch's bindings are made again for the running CLI (the tool host's record
// with no credential, the account capture and the registrations, the status
// line's address file only where its launch wrote one), and the session's
// entry, logging run and transcript binding follow, by the saved conversation
// from the folder it runs in. Its exit ends it as a launch's does. A Codex
// tab (B1.2) asks with the account its launch is prepared on; taken over, its
// kept hook file is written again with this run's port and a new token, and
// its lease, conversation and telemetry are bound with no spawn; one not
// written again has its kept folder removed. A tab the helper keeps nothing
// for, or one prepared on another account (a Codex lease's, or the account a
// Claude Code launch names), launches as before. A take-over whose bindings
// fail removes what its launch left on disk, as a failed launch does. A
// take-over that is not indexed opens its not-indexed windows (indexing-gaps.ts)
// from when the update let go of it, never later than now.
//
// The session helper is a stand-in behind the seam (kept-launches.ts
// setKeptTakeOver); tests/unit/main/session-helper-take-over.test.ts holds the
// manager to the take-over itself. The harness is
// tests/unit/main/launch-bindings-launch.test.ts's.
//
// Not checked here: an SSH launch (its branch is not touched); a terminal tab
// (it starts no provider, so localLaunch is null and nothing is asked).
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  journal: [] as string[],
  ptys: [] as Array<{ exit: Array<(e: { exitCode: number }) => void> }>,
  removedFiles: [] as string[],
  records: [] as Array<[string, string]>,
  urlWrites: [] as Array<[string, string]>,
  urlDir: '',
  mcpPort: 0,
  logOn: false,
  runStarts: [] as Array<Record<string, unknown>>,
  registered: [] as Array<[string, string]>,
  bound: [] as Array<[string, string]>,
  rewrites: [] as Array<[string, string, number, string]>,
  disposed: [] as string[],
  captureThrows: false,
  recordThrows: false,
  telemetry: [] as Array<Record<string, unknown>>,
  /** The kept hook folders the Codex provider was asked to remove. */
  hookFoldersRemoved: [] as string[],
  /** Whether the Hooks gateway stand-in is listening. */
  gwListening: true,
  /** What the config stand-in answers for the app's settings. */
  settings: {} as Record<string, unknown>,
  /** What the last take-over answered pty-manager.ts (takeOverKeptLaunch). */
  takenOver: null as { since: number } | null,
}))

/** The module's functions, each recorded by name, then run as they are; what
 *  a take-over answers is kept. */
vi.mock('../../../src/main/sessions/launch-bindings', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const wrapped: Record<string, unknown> = {}
  for (const [name, v] of Object.entries(real)) {
    wrapped[name] = typeof v === 'function'
      ? (...a: unknown[]) => {
        h.journal.push(name)
        const r = (v as (...x: unknown[]) => unknown)(...a)
        if (name === 'takeOverKeptLaunch') h.takenOver = r as { since: number } | null
        return r
      }
      : v
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
vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => (h.logOn ? { runStart: (r: Record<string, unknown>) => { h.runStarts.push(r) }, runEnd: () => {} } : null),
  getTranscriptBinder: () => (h.logOn
    ? {
      registerRun: (sid: string, cwd: string) => { h.registered.push([sid, cwd]) },
      notifyTranscriptPath: (sid: string, p: string) => { h.bound.push([sid, p]) },
      endRun: () => {},
      getExactResumeTarget: () => null,
      getLatestTranscriptPath: () => null,
    }
    : null),
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => h.mcpPort,
  issueMcpSessionToken: () => 'tok',
  recordHeldToolSession: (sid: string, provider: string) => { if (h.recordThrows) throw new Error('the stand-in record failed'); h.journal.push('recordHeldToolSession'); h.records.push([sid, provider]) },
  registerCodexReviewSession: () => {},
  registerClaudeReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
  releaseMcpSessionProvider: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  providerCapability: () => ({ enabled: true }),
  tryGetProvider: () => ({ statusPostUrl: (sid: string, _r: unknown, port: number) => `http://127.0.0.1:${port}/status?cccSessionId=${sid}&token=new-run` }),
  getProvider: (id: string) => ({
    resolveBinary: () => ({ cmd: 'claude', source: 'system' }),
    buildSpawnCommand: (opts: Record<string, any>) => {
      if (opts.provider !== 'codex') return { cmd: 'pwsh', args: [], env: {} }
      return { cmd: opts.realmLaunch.executable, args: [], env: { ...opts.realmLaunch.env }, hooksInstalled: !!opts.codexHooks }
    },
    ...(id === 'codex' ? {
      prepareSessionHooks: (sid: string) => ({ hookFile: `/tmp/codex-hooks/x/${sid}/hook.json`, dispose: () => {} }),
      rewriteSessionHooks: (dir: string, sid: string, port: number, secret: string) => { h.rewrites.push([dir, sid, port, secret]); return { hookFile: path.join(dir, 'hook.json'), dispose: () => { h.disposed.push(dir) } } },
      removeSessionHookFolder: (dir: string) => { h.hookFoldersRemoved.push(dir) },
    } : {}),
    ingestSessionTelemetry: (_sid: string, o: Record<string, unknown>) => { h.telemetry.push(o); return { stop: () => {} } },
  }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({
  getGateway: () => ({
    status: () => ({ enabled: true, listening: h.gwListening, port: 51234 }),
    registerSession: () => { h.journal.push('gatewaySecret'); return '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60' },
    unregisterSession: () => {},
  }),
  isExactBindSourceActive: () => true,
}))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => { h.journal.push('injectHooks') } }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => { h.journal.push('writeSettings'); return '/nonexistent/settings.json' },
  removeLocalSessionSettings: (sid: string) => { h.removedFiles.push(`settings:${sid}`) },
  writeLocalSessionMcpConfig: () => { h.journal.push('writeMcpConfig'); return '/nonexistent/mcp.json' },
  removeLocalSessionMcpConfig: (sid: string) => { h.removedFiles.push(`mcp:${sid}`) },
  removeLocalSessionStatusUrl: (sid: string) => { h.removedFiles.push(`status-url:${sid}`) },
  getLocalSessionStatusUrlPath: (sid: string) => path.join(h.urlDir, `ccc-status-${sid}.url`),
  writeLocalSessionStatusUrl: (sid: string, url: string) => { h.urlWrites.push([sid, url]); return path.join(h.urlDir, `ccc-status-${sid}.url`) },
  noteKeptLaunchStatusLine: () => { h.journal.push('noteKeptLaunchStatusLine') },
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: (sid: string, profile: string | undefined) => { if (h.captureThrows) throw new Error('the stand-in capture failed'); h.journal.push(`captureClaudeAccount:${profile ?? 'default'}`) },
  clearClaudeAccount: () => {},
  getAccountIdentity: () => null,
  getClaudeProfileId: () => null,
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
  readConfig: (name: string) => (name === 'settings' ? h.settings : {}),
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

const { spawnPty, killPty, writePty, holdsCodexLaunchLease, getKeptCodexConversation, REMOVED_ACCOUNT_REFUSAL } = await import('../../../src/main/pty-manager')
const { setKeptTakeOver } = await import('../../../src/main/sessions/kept-launches')
const { notIndexedSnapshot, resetIndexingGapsForTests, conversationKey } = await import('../../../src/main/logging/indexing-gaps')
const { codexFolderKey } = await import('../../../src/main/logging/codex-folder-key')

h.urlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-takeover-url-'))
afterAll(() => {
  setKeptTakeOver(null)
  if (path.basename(h.urlDir).startsWith('ccc-takeover-url-')) fs.rmSync(h.urlDir, { recursive: true, force: true })
})

const CODEX_SID = 'cx0000000000000000000008'
const CLAUDE_SID = 'cl0000000000000000000008'
const CONV = '019dd000-0003-7000-8000-00000000003c'
/** The folder the kept CLI was launched in (its conversation's own; not the configured one). */
const LAUNCH_FOLDER = path.join(os.tmpdir(), 'ccc-takeover-launch-folder')
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const codexLaunch = () => ({
  lease: { release: () => {}, accountId: 'acct-b1' },
  executable: '/proven/b1/codex',
  env: { PATH: '/usr/bin', CODEX_HOME: '/res/codex-realms/b1' },
  sessionsDir: '/res/codex-realms/b1/sessions',
})
const TEARDOWN = ['unbindCodexLease', 'unbindLaunchTelemetry', 'unbindLaunchRegistrations']
const WATCHED = new Set(['mintCodexHooks', 'keepCodexHooks', 'bindCodexLease', 'bindCodexPane', 'bindCodexLaunch', 'bindClaudeLaunch', 'bindLoggingRun', 'unbindLaunchFiles', ...TEARDOWN, 'spawn', 'recordHeldToolSession', 'gatewaySecret', 'injectHooks', 'writeSettings', 'writeMcpConfig', 'noteKeptLaunchStatusLine'])
const seen = (): string[] => h.journal.filter((n) => WATCHED.has(n) || n.startsWith('captureClaudeAccount'))
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** The terminal of the kept session the stand-in helper hands over, and what reached it. */
interface KeptPty { pid: number; kills: number; writes: string[]; data: Array<(d: string) => void>; exit: Array<(e: { exitCode: number }) => void> }
let kept: KeptPty | null
/** Each take-over the stand-in helper was asked for. */
let asked: Array<{ sessionId: string; provider: string; size: { cols: number; rows: number }; account?: string | null }>

function keepFor(sessionId: string, folder: string | null = LAUNCH_FOLDER, rec: { account?: string | null; hookFolder?: string | null; at?: number } = {}): void {
  setKeptTakeOver((sid, provider, size, account) => {
    asked.push({ sessionId: sid, provider, size, account })
    if (sid !== sessionId) return null
    // As the manager: a launch prepared on another account takes nothing over.
    if (account !== undefined && account !== (rec.account ?? null)) return null
    const p: KeptPty = { pid: 7777, kills: 0, writes: [], data: [], exit: [] }
    kept = p
    const pty = {
      pid: p.pid, cols: size.cols, rows: size.rows, process: 'pwsh', handleFlowControl: false,
      onData: (cb: (d: string) => void) => { p.data.push(cb); return { dispose: () => {} } },
      onExit: (cb: (e: { exitCode: number }) => void) => { p.exit.push(cb); return { dispose: () => {} } },
      write: (d: string) => { p.writes.push(d) },
      resize: () => {}, clear: () => {}, pause: () => {}, resume: () => {}, kill: () => { p.kills++ },
    }
    return { pty: pty as never, kept: { conversation: CONV, account: rec.account ?? null, hookFolder: rec.hookFolder ?? null, folder, at: rec.at ?? 0 } }
  })
}

beforeEach(() => {
  for (const sid of [CODEX_SID, CLAUDE_SID]) { try { killPty(sid) } catch { /* none */ } }
  for (const p of h.ptys) for (const cb of [...p.exit]) cb({ exitCode: 0 })
  if (kept) for (const cb of [...kept.exit]) cb({ exitCode: 0 })
  kept = null
  asked = []
  setKeptTakeOver(null)
  h.journal.length = 0
  h.ptys.length = 0
  h.removedFiles.length = 0
  h.records.length = 0
  h.urlWrites.length = 0
  h.logOn = false
  h.mcpPort = 0
  h.runStarts.length = 0
  h.registered.length = 0
  h.bound.length = 0
  h.rewrites.length = 0
  h.disposed.length = 0
  h.captureThrows = false
  h.recordThrows = false
  h.telemetry.length = 0
  h.hookFoldersRemoved.length = 0
  h.gwListening = true
  h.settings = {}
  h.takenOver = null
  resetIndexingGapsForTests()
  for (const f of fs.readdirSync(h.urlDir)) fs.rmSync(path.join(h.urlDir, f), { force: true })
})

describe('pty-manager.ts: a restored tab takes over the session an update kept running', () => {
  it('a Claude Code tab the helper keeps a session for: no spawn, no files, no gateway secret, no launch line; the record with no credential, the account capture and registrations, then its logging run', async () => {
    void TEST_DATA
    keepFor(CLAUDE_SID)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    expect(asked).toEqual([{ sessionId: CLAUDE_SID, provider: 'claude', size: { cols: 120, rows: 30 } }])
    // bindClaudeLaunch runs inside the module (its account capture shows it).
    expect(seen()).toEqual([...TEARDOWN, 'recordHeldToolSession', 'noteKeptLaunchStatusLine', 'captureClaudeAccount:default', 'bindLoggingRun'])
    expect(h.records).toEqual([[CLAUDE_SID, 'claude']])
    // No launch line, past the 300 ms a launch types it at.
    await tick(400)
    expect(kept!.writes).toEqual([])
    // The session's entry is the kept terminal: what the tab types reaches the same CLI.
    writePty(CLAUDE_SID, 'next prompt')
    expect(kept!.writes).toEqual(['next prompt'])
    // No status line address file was written by its launch: none is written now.
    expect(h.urlWrites).toEqual([])
  })

  it('a take-over whose bindings fail after it attached: its CLI is ended, nothing is launched in its place, what its launch left on disk goes, and the spawn fails as a launch\'s does', () => {
    keepFor(CLAUDE_SID)
    h.captureThrows = true
    expect(() => spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)).toThrow('the stand-in capture failed')
    expect(kept!.kills).toBe(1)
    expect(seen()).toEqual([...TEARDOWN, 'recordHeldToolSession', 'noteKeptLaunchStatusLine'])
    // No exit handler of this session removes them: the failure does, as a failed launch's does.
    expect(h.removedFiles).toEqual([`settings:${CLAUDE_SID}`, `mcp:${CLAUDE_SID}`, `status-url:${CLAUDE_SID}`])
  })

  it('a Codex take-over whose bindings fail before its hook file is written again: its files and its kept hook folder go', () => {
    const hookFolder = path.join(os.tmpdir(), 'codex-hooks', 'ccc-codex-hook-kept3')
    keepFor(CODEX_SID, LAUNCH_FOLDER, { account: 'acct-b1', hookFolder })
    h.recordThrows = true
    expect(() => spawnPty(fakeWin, CODEX_SID, { cwd: os.tmpdir(), provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: codexLaunch() } as never)).toThrow('the stand-in record failed')
    expect(kept!.kills).toBe(1)
    expect(h.rewrites).toEqual([])
    expect(h.removedFiles).toEqual([`settings:${CODEX_SID}`, `mcp:${CODEX_SID}`, `status-url:${CODEX_SID}`])
    expect(h.hookFoldersRemoved).toEqual([hookFolder])
  })

  it('a Claude Code tab whose launch names another account than the kept session\'s (Ask each time, another account picked): asked with that account, nothing taken over, and the launch goes on as before', () => {
    keepFor(CLAUDE_SID, LAUNCH_FOLDER, { account: 'profile-a' })
    // The launch's own account rule follows (this harness sets up no account, so it refuses: no kept CLI runs on in its place).
    expect(() => spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir(), profileId: 'profile-b' } as never)).toThrow(REMOVED_ACCOUNT_REFUSAL)
    expect(asked).toEqual([{ sessionId: CLAUDE_SID, provider: 'claude', size: { cols: 120, rows: 30 }, account: 'profile-b' }])
    expect(kept).toBeNull()
    expect(seen()).not.toContain('recordHeldToolSession')
  })

  it('a Claude Code tab whose launch names the account the kept session runs on: taken over, on that account', () => {
    keepFor(CLAUDE_SID, LAUNCH_FOLDER, { account: 'profile-a' })
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir(), profileId: 'profile-a' } as never)
    expect(asked).toEqual([{ sessionId: CLAUDE_SID, provider: 'claude', size: { cols: 120, rows: 30 }, account: 'profile-a' }])
    expect(seen()).toEqual([...TEARDOWN, 'recordHeldToolSession', 'noteKeptLaunchStatusLine', 'captureClaudeAccount:profile-a', 'bindLoggingRun'])
    writePty(CLAUDE_SID, 'next prompt')
    expect(kept!.writes).toEqual(['next prompt'])
  })

  it('its logging run and transcript binding: the folder its CLI runs in and its saved conversation, from the take-over', () => {
    h.logOn = true
    keepFor(CLAUDE_SID)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    expect(h.runStarts).toEqual([expect.objectContaining({ sessionId: CLAUDE_SID, projectCwd: LAUNCH_FOLDER, provider: 'claude' })])
    expect(h.registered).toEqual([[CLAUDE_SID, LAUNCH_FOLDER]])
    expect(h.bound).toHaveLength(1)
    expect(h.bound[0][0]).toBe(CLAUDE_SID)
    expect(path.basename(h.bound[0][1])).toBe(`${CONV}.jsonl`)
  })

  it('a record with no folder (an earlier version\'s): the configured folder', () => {
    h.logOn = true
    keepFor(CLAUDE_SID, null)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    expect(h.registered).toEqual([[CLAUDE_SID, os.tmpdir()]])
  })

  it('not indexed (logging off in Settings): its conversation\'s window opens when the update let go of it, so what its CLI wrote while no app ran is in it', () => {
    h.settings = { loggingEnabled: false }
    const releasedAt = Date.now() - 60_000
    keepFor(CLAUDE_SID, LAUNCH_FOLDER, { at: releasedAt })
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    expect(notIndexedSnapshot().conversations[conversationKey(`${CONV}.jsonl`)]).toEqual([[releasedAt, null]])
  })

  it('a Codex tab not indexed: its launch folder\'s cover window opens when the update let go of it', () => {
    h.settings = { loggingEnabled: false }
    const releasedAt = Date.now() - 60_000
    keepFor(CODEX_SID, LAUNCH_FOLDER, { account: 'acct-b1', at: releasedAt })
    spawnPty(fakeWin, CODEX_SID, { cwd: os.tmpdir(), provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: codexLaunch() } as never)
    expect(notIndexedSnapshot().conversations[codexFolderKey(LAUNCH_FOLDER)]).toEqual([[releasedAt, null]])
  })

  it.each([
    ['does not say when (an earlier version\'s)', () => 0],
    ['says a time later than now (the clock was set back)', () => Date.now() + 3_600_000],
  ])('not indexed, a record that %s: its window opens at the take-over', (_what, at) => {
    h.settings = { loggingEnabled: false }
    keepFor(CLAUDE_SID, LAUNCH_FOLDER, { at: at() })
    const before = Date.now()
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    const after = Date.now()
    // The take-over's own answer, never later than now (indexing-gaps.ts also
    // clamps a window's start to now, so the window alone would not show it).
    expect(h.takenOver!.since).toBeGreaterThanOrEqual(before)
    expect(h.takenOver!.since).toBeLessThanOrEqual(after)
    const windows = notIndexedSnapshot().conversations[conversationKey(`${CONV}.jsonl`)]
    expect(windows).toHaveLength(1)
    expect(windows[0][1]).toBeNull()
    expect(windows[0][0]).toBeGreaterThanOrEqual(before)
    expect(windows[0][0]).toBeLessThanOrEqual(after)
  })

  it('its launch wrote a status line address file: written again with this run\'s address', () => {
    fs.writeFileSync(path.join(h.urlDir, `ccc-status-${CLAUDE_SID}.url`), 'http://127.0.0.1:1/status?cccSessionId=x&token=last-run')
    h.mcpPort = 19333
    keepFor(CLAUDE_SID)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    expect(h.urlWrites).toEqual([[CLAUDE_SID, `http://127.0.0.1:19333/status?cccSessionId=${CLAUDE_SID}&token=new-run`]])
  })

  it('its own exit ends it as a launch\'s exit does: its files once, then the teardown\'s three parts', () => {
    keepFor(CLAUDE_SID)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    h.journal.length = 0
    for (const cb of [...kept!.exit]) cb({ exitCode: 0 })
    expect(seen()).toEqual(['unbindLaunchFiles', ...TEARDOWN])
    expect(h.removedFiles).toEqual([`settings:${CLAUDE_SID}`, `mcp:${CLAUDE_SID}`, `status-url:${CLAUDE_SID}`])
  })

  it('a Claude Code tab the helper keeps nothing for: asked, then launched as before', () => {
    keepFor('cl0000000000000000000099')
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    expect(asked.map((a) => a.sessionId)).toEqual([CLAUDE_SID])
    expect(seen()).toEqual([...TEARDOWN, 'spawn', 'bindClaudeLaunch', 'captureClaudeAccount:default', 'writeSettings', 'gatewaySecret', 'injectHooks', 'writeMcpConfig', 'bindLoggingRun'])
  })

  it('a Codex tab the helper keeps a session for (B1.2), on the account its launch is prepared on: no spawn, no new hook folder; its kept hook file written again with this run\'s port and a new token, its lease, its conversation and its telemetry by the saved conversation; its exit removes the kept folder', () => {
    const hookFolder = path.join(os.tmpdir(), 'codex-hooks', 'ccc-codex-hook-kept1')
    keepFor(CODEX_SID, LAUNCH_FOLDER, { account: 'acct-b1', hookFolder })
    const launch = codexLaunch()
    spawnPty(fakeWin, CODEX_SID, { cwd: os.tmpdir(), provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: launch } as never)
    expect(asked).toEqual([{ sessionId: CODEX_SID, provider: 'codex', size: { cols: 120, rows: 30 }, account: 'acct-b1' }])
    // No spawn, no hook folder of a launch (mintCodexHooks), no command built (keepCodexHooks).
    expect(seen()).toEqual([...TEARDOWN, 'recordHeldToolSession', 'gatewaySecret', 'bindLoggingRun'])
    expect(h.records).toEqual([[CODEX_SID, 'codex']])
    expect(h.rewrites).toEqual([[hookFolder, CODEX_SID, 51234, '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60']])
    expect(h.hookFoldersRemoved).toEqual([]) // written again: its folder stays for the CLI's hooks
    expect(holdsCodexLaunchLease(CODEX_SID, launch.lease as never)).toBe(true)
    expect(getKeptCodexConversation(CODEX_SID)).toEqual({ uuid: CONV, cwd: LAUNCH_FOLDER })
    expect(h.telemetry).toEqual([expect.objectContaining({ cwd: LAUNCH_FOLDER, sessionsDir: launch.sessionsDir, resumeId: CONV })])
    // The session's entry is the kept terminal.
    writePty(CODEX_SID, 'next prompt')
    expect(kept!.writes).toEqual(['next prompt'])
    // Its own exit: the rewritten hook file's folder goes with the session's resources.
    for (const cb of [...kept!.exit]) cb({ exitCode: 0 })
    expect(h.disposed).toEqual([hookFolder])
  })

  it('a Codex tab whose kept session has no hook folder: nothing written, no token minted', () => {
    keepFor(CODEX_SID, LAUNCH_FOLDER, { account: 'acct-b1' })
    spawnPty(fakeWin, CODEX_SID, { cwd: os.tmpdir(), provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: codexLaunch() } as never)
    expect(seen()).toEqual([...TEARDOWN, 'recordHeldToolSession', 'bindLoggingRun'])
    expect(h.rewrites).toEqual([])
    expect(h.hookFoldersRemoved).toEqual([]) // written again: its folder stays for the CLI's hooks
  })

  it('a Codex tab whose kept hook file is not written again (the Hooks gateway not listening): no rewrite, no token, and its kept folder goes now', () => {
    const hookFolder = path.join(os.tmpdir(), 'codex-hooks', 'ccc-codex-hook-kept2')
    keepFor(CODEX_SID, LAUNCH_FOLDER, { account: 'acct-b1', hookFolder })
    h.gwListening = false
    spawnPty(fakeWin, CODEX_SID, { cwd: os.tmpdir(), provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: codexLaunch() } as never)
    expect(seen()).toEqual([...TEARDOWN, 'recordHeldToolSession', 'bindLoggingRun'])
    expect(h.rewrites).toEqual([])
    // Its file names the last run's port and token: the folder is handed to the provider to remove.
    expect(h.hookFoldersRemoved).toEqual([hookFolder])
  })

  it('a Codex tab whose launch is prepared on another account: asked with that account, then launched as before', () => {
    keepFor(CODEX_SID, LAUNCH_FOLDER, { account: 'acct-other' })
    spawnPty(fakeWin, CODEX_SID, { cwd: os.tmpdir(), provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: codexLaunch() } as never)
    expect(asked.map((a) => a.account)).toEqual(['acct-b1'])
    expect(seen()).toEqual([...TEARDOWN, 'mintCodexHooks', 'gatewaySecret', 'keepCodexHooks', 'bindCodexLease', 'spawn', 'bindCodexPane', 'bindCodexLaunch', 'bindLoggingRun'])
  })
})
