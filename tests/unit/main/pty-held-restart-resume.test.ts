// [host] 2.1.3-beta.19 fix round, item HELDRESTART (pre-existing, seen on the
// published signed beta.18 too): a HELD Claude Code tab's Restart showed the
// list of earlier conversations instead of carrying on with its conversation.
//
// A Restart is two doors (useRestartSession): the kill (`pty:kill`, reason
// 'restart'), then the spawn. T8b reads the conversation's resume target at
// the top of the spawn, off the transcript binder, which the old run's exit
// clears (endRun). A plain tab's CLI takes longer to exit than the spawn
// takes to come, so the spawn still finds it. A held session's exit reaches
// the app about 20 ms after the kill, before the spawn (about 40 ms): on the
// VM, 'Killing PTY' 05:53:18.682Z, 'PTY exited ... code 1' 18.704Z,
// 'Spawning PTY' 18.724Z, then 'Launching Claude ... (resumePicker=true,
// resume=none)'. So the Restart's kill reads the target too, before the
// session is killed, and the spawn that follows uses it when the binder no
// longer holds one.
//
// Real spawnPty and killPty, a fake node-pty whose processes end when the
// test says, and a fake transcript binder that forgets a run's bind at its
// end, as the real one does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type FakeProc = { cwd: string; killed: number; pid: number; exit: () => void }
const h = vi.hoisted(() => ({
  procs: [] as Array<{ cwd: string; killed: number; pid: number; exit: () => void }>,
  logs: [] as string[],
  /** The binder's exact binds, by session id: a transcript path. */
  bound: new Map<string, string>(),
}))

vi.mock('node-pty', () => ({
  spawn: (_cmd: string, _args: unknown, opts: { cwd: string }) => {
    const exits: Array<(e: { exitCode: number }) => void> = []
    let ended = false
    const rec = {
      cwd: opts.cwd,
      killed: 0,
      pid: process.pid,
      exit: () => { if (ended) return; ended = true; for (const cb of [...exits]) cb({ exitCode: 1 }) },
    }
    h.procs.push(rec)
    return {
      pid: rec.pid, process: 'x',
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose: () => {} } },
      write: () => {}, resize: () => {}, kill: () => { rec.killed++ },
    }
  },
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => os.tmpdir(), getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (m: string) => { h.logs.push(m) }, logWarn: (m: string) => { h.logs.push(m) }, logError: (m: string) => { h.logs.push(m) }, logDebug: () => {},
}))
// The binder: an exact bind per session, forgotten at the run's end (endRun), as the real one.
vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => null,
  getTranscriptBinder: () => ({
    getExactResumeTarget: (id: string) => h.bound.get(id) ?? null,
    getLatestTranscriptPath: (id: string) => h.bound.get(id) ?? null,
    registerRun: () => {},
    notifyTranscriptPath: () => {},
    endRun: (id: string) => { h.bound.delete(id) },
  }),
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 0, registerCodexReviewSession: () => {}, registerClaudeReviewSession: () => {}, unregisterCodexReviewSession: () => {}, releaseMcpSessionProvider: () => {} }))
vi.mock('../../../src/main/providers', async () => (await import('../../helpers/provider-package-parts')).withProviderPackageParts(await (() => ({
  providerCapability: () => ({ enabled: true }),
  getProvider: (id: string) => (id === 'codex'
    ? { buildSpawnCommand: () => ({ cmd: '/proven/codex', args: [], env: {}, logLine: '' }), ingestSessionTelemetry: () => ({ stop: () => {} }) }
    : { resolveBinary: () => ({ cmd: 'claude', source: 'system' }), buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }), ingestSessionTelemetry: () => ({ stop: () => {} }) }),
}))()))
await (await import('../../helpers/provider-package-parts')).loadProviderPackageParts()
vi.mock('../../../src/main/canvas/codex-canvas-launch', () => ({ prepareCodexCanvasLaunch: () => ({ designatedWorktree: null, guidance: null }) }))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {}, writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
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
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
}))

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
const { claudeProjectDirName } = await import('../../../src/main/logging/transcript-discovery')
type SpawnOpts = NonNullable<Parameters<typeof spawnPty>[2]>

const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const UUID = '671210ff-e528-4528-ae98-928a2b6d68ab'
let tmp = ''
let project = ''
let seq = 0
const ids: string[] = []
const newId = (): string => { const id = `hrst${String(++seq).padStart(20, '0')}`; ids.push(id); return id }
function claude(id: string, extra: Partial<SpawnOpts> = {}): FakeProc {
  spawnPty(fakeWin, id, { cwd: project, cols: 100, rows: 30, ...extra })
  return h.procs[h.procs.length - 1]
}
/** The conversation the run is on, as the binder holds it once its hook named it. */
function onConversation(id: string): void {
  // The transcript where Claude Code keeps it (the isolated test home), its first line naming its folder.
  const dir = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(project))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${UUID}.jsonl`)
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: project })}\n`)
  h.bound.set(id, file)
}
/** The resume the last Claude Code launch of this test went with ('none' or a uuid), from its launch line. */
const lastResume = (_id: string): string | undefined => {
  const all = h.logs.filter((l) => l.startsWith('[pty-manager] Launching Claude')).map((l) => /resume=([^)\s]+)/.exec(l)?.[1] ?? '')
  return all[all.length - 1]
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-held-restart-')))
  project = path.join(tmp, 'project')
  fs.mkdirSync(project, { recursive: true })
  h.procs = []
  h.logs = []
  h.bound.clear()
})
afterEach(() => {
  for (const p of h.procs) p.exit()
  for (const id of ids.splice(0)) { try { killPty(id, { reason: 'close' }) } catch { /* not started */ } }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a Claude Code Restart carries on with its conversation', () => {
  it('[host] a held session: its exit comes between the Restart\'s kill and its spawn, and the spawn still resumes the conversation', () => {
    const id = newId()
    const first = claude(id)
    onConversation(id)
    // The Restart: its kill, the held session's exit at once (the binder forgets its bind), then its spawn.
    killPty(id, { reason: 'restart' })
    first.exit()
    expect(h.bound.has(id)).toBe(false)
    claude(id, { useResumePicker: true })
    expect(lastResume(id)).toBe(UUID)
    expect(h.logs.some((l) => l.includes(`T8b captured resume target for ${id}: uuid=${UUID}`))).toBe(true)
  })

  it('[host] a plain session (its exit comes after the spawn) is unchanged: the spawn resumes it', () => {
    const id = newId()
    const first = claude(id)
    onConversation(id)
    killPty(id, { reason: 'restart' })
    claude(id, { useResumePicker: true })
    first.exit()
    expect(lastResume(id)).toBe(UUID)
  })

  it('[host] the target a Restart\'s kill read is used once: a later start of the same tab with no conversation known resumes nothing', () => {
    const id = newId()
    const first = claude(id)
    onConversation(id)
    killPty(id, { reason: 'restart' })
    first.exit()
    const second = claude(id)
    expect(lastResume(id)).toBe(UUID)
    // The second run's own end, with no bind: a start after it has no target.
    killPty(id)
    second.exit()
    claude(id, { useResumePicker: true })
    expect(lastResume(id)).toBe('none')
  })

  it('[host] a close is not a Restart: a start of the same id after it resumes nothing from before', () => {
    const id = newId()
    const first = claude(id)
    onConversation(id)
    killPty(id, { reason: 'close' })
    first.exit()
    claude(id, { useResumePicker: true })
    expect(lastResume(id)).toBe('none')
  })

  it('[host] a Codex session\'s Restart takes nothing of this: no Claude resume target is read for it', () => {
    const id = newId()
    spawnPty(fakeWin, id, { cwd: project, cols: 100, rows: 30, provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: { lease: { release: vi.fn() }, executable: '/proven/codex', env: { CODEX_HOME: path.join(tmp, 'codex-home') }, sessionsDir: path.join(tmp, 'codex-home', 'sessions'), home: path.join(tmp, 'codex-home') } as unknown as SpawnOpts['codexLaunch'] })
    const first = h.procs[h.procs.length - 1]
    // A bind the binder would hold for the id (it never does for Codex): not read for a Codex Restart.
    onConversation(id)
    killPty(id, { reason: 'restart' })
    first.exit()
    claude(id, { useResumePicker: true })
    expect(h.logs.some((l) => l.includes(`T8b captured resume target for ${id}`))).toBe(false)
    expect(lastResume(id)).toBe('none')
  })
})
