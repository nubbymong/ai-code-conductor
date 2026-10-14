// A managed launch hands the resume picker (CCC_GATED_DIRS) its own folders
// only where a folder is there once the gate has answered: the configured
// folder always, the resume target's folder only when it exists. A resume
// target with no folder is clean to the gate (it reads nothing there), the
// launch starts in the configured folder, and a folder made at that path later
// was never checked, so it is never in the set, and a launch that would land
// there is refused.
//
// The real spawnPty, the real project gate and the real launch-folder check
// (gatePickerSiblingDirs) on this test's own temp folders. node-pty records
// the start and no process starts: the picker's git list is answered here and
// every other program a child-process call asks for is recorded and refused.
// The account's folders are stood in (no folder of a real account is read or
// changed), and the resume decision takes the real helper's folder rule (the
// target's folder must be there) without reading the home folder.
//
// Mutation to prove this can fail: build the set from every launch folder
// (`[...gateDirs, ...clean]`), as before the launch folders were checked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  spawns: [] as Array<{ cwd: string; env: Record<string, string | undefined> }>,
  warns: [] as string[],
  /** What `git worktree list --porcelain` answers, or null for "git failed". */
  worktreePorcelain: null as string | null,
  /** Any other program a child-process call asked for (refused, never run). */
  otherChildren: [] as string[],
  profileHome: '',
  res: '',
  /** The account's sign-in folder check, held open by a case that needs to act between the gate and the launch. */
  credentialCheck: null as Promise<void> | null,
}))
const PROFILE = 'gatedtargetprofile'
const UUID = '11111111-2222-3333-4444-555555555555'
const PICKER_GIT = path.join(os.tmpdir(), 'stand-in-bin', 'git')

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('node-pty', () => ({
  spawn: (_cmd: string, _args: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => {
    h.spawns.push({ cwd: opts.cwd, env: opts.env })
    return { pid: 4343, cols: 80, rows: 24, process: 'x',
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
      write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }
  },
}))
// The picker's worktree list is answered here; anything else is recorded and
// refused, never started (afterEach checks there was none).
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  const refuse = (file: unknown): never => { h.otherChildren.push(String(file)); throw new Error('no program is started in this test') }
  return {
    ...real,
    execFile: ((file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      if (file === PICKER_GIT && Array.isArray(args) && args.includes('worktree')) {
        setTimeout(() => (h.worktreePorcelain === null ? cb(new Error('git failed'), '') : cb(null, h.worktreePorcelain)), 0)
        return { on() {}, kill() {} }
      }
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
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: () => {}, logError: () => {}, logDebug: () => {},
  logWarn: (...a: unknown[]) => { h.warns.push(a.map(String).join(' ')) },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.res, getDataDirectory: () => h.res, registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
// The real helper resumes only when the target's folder is a folder (and its
// transcript is there, taken as there); with none it drops the resume.
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()),
  resolveResumeLaunch: (target?: { uuid: string; cwd: string }) => {
    if (!target) return null
    try { return fs.statSync(target.cwd).isDirectory() ? { resumeUuid: target.uuid, claudeCwd: target.cwd } : null } catch { return null }
  },
  recoverOrphanResumeLaunch: () => null,
}))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()), getConductorMcpPort: () => 0 }))
vi.mock('../../../src/main/providers/claude/spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/providers/claude/spawn')>()),
  resolveClaudeBinary: () => ({ cmd: 'claude', args: [] }),
  resolveHostColorScheme: () => 'dark',
}))
// The launch gate asks for the Claude CLI's version: answered as on a machine
// with none, so no Claude CLI is started.
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
  getConfigDir: () => h.res,
}))
// A managed account stood in: its home is this test's folder, and nothing is
// read from or changed on a real account's folders.
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: (id: string) => id === PROFILE,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => h.profileHome,
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
  checkProfileCredentialFolders: () => h.credentialCheck ?? Promise.resolve(),
  withProfileHome: (env: Record<string, string>, home: string | null) => (home ? { ...env, USERPROFILE: home } : env),
}))

const { spawnPty, killPty, _setPickerGitLookupForTest } = await import('../../../src/main/pty-manager')
const { _resetProjectScanStateForTest } = await import('../../../src/main/managed-launch-diagnostics')
const consumers = await import('../../../src/main/profile-consumers')
const { registerFakeClaudePackage } = await import('../../helpers/claude-package')

const messages: string[] = []
const payloads: Array<[string, unknown]> = []
const win = {
  webContents: { send: (channel: string, payload?: unknown) => { messages.push(channel); payloads.push([channel, payload]) } },
  isDestroyed: () => false,
} as never
const ids = ['target-here', 'target-gone', 'picker-target-gone', 'picker-target-here', 'target-made-late']
let tmp = ''

const until = async (cond: () => boolean, why: string): Promise<void> => {
  const deadline = Date.now() + 8000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  if (!cond()) throw new Error(`timed out waiting: ${why}`)
}
const folder = (name: string): string => {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir)
  return dir
}
const gatedSet = (i = 0): string[] => JSON.parse(h.spawns[i].env.CCC_GATED_DIRS ?? 'null') as string[]
const porcelain = (...dirs: string[]): string => dirs.map((d) => `worktree ${d}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/x\n`).join('\n')
const keptOut = (dir: string): string[] => h.warns.filter((w) => w.includes(`${path.basename(dir)} for this launch: there was no folder there when the session started`))
const terminalText = (id: string): string => payloads.filter(([c]) => c === `pty:data:${id}`).map(([, p]) => String(p)).join('')

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-gated-target-')))
  h.profileHome = folder('profile-home')
  h.res = folder('res')
  h.spawns.length = 0; h.warns.length = 0; h.otherChildren.length = 0
  h.worktreePorcelain = null
  h.credentialCheck = null
  messages.length = 0; payloads.length = 0
  _resetProjectScanStateForTest()
  consumers._resetProfileConsumersForTest()
  registerFakeClaudePackage({ resolveBinary: () => ({ cmd: 'claude', args: [] }) } as never)
  _setPickerGitLookupForTest(async () => PICKER_GIT)
})
afterEach(() => {
  for (const id of ids) { try { killPty(id) } catch { /* not started */ } }
  _setPickerGitLookupForTest(null)
  consumers._resetProfileConsumersForTest()
  _resetProjectScanStateForTest()
  // TEST CLEANUP GUARD: only this test's own folder under the temp folder.
  if (path.basename(tmp).startsWith('ccc-gated-target-') && path.dirname(tmp) === fs.realpathSync.native(os.tmpdir())) {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  expect(h.otherChildren).toEqual([])
})

describe('a managed exact resume: the resume target is in the gated set only when its folder is there', () => {
  it('a target with a folder: the launch runs there, and both folders are in CCC_GATED_DIRS', async () => {
    const configured = folder('configured')
    const target = folder('target')
    spawnPty(win, 'target-here', { profileId: PROFILE, cwd: configured, resume: { uuid: UUID, cwd: target } })
    await until(() => h.spawns.length === 1, 'the managed launch to start after the gate')
    expect(h.spawns[0].cwd).toBe(target)
    expect(gatedSet()).toEqual([configured, target])
    expect(keptOut(target)).toEqual([])
  })

  it('a target with no folder: the launch starts in the configured folder, and the target is not in CCC_GATED_DIRS', async () => {
    const configured = folder('configured')
    const target = path.join(tmp, 'target-gone')
    expect(fs.existsSync(target)).toBe(false)
    spawnPty(win, 'target-gone', { profileId: PROFILE, cwd: configured, resume: { uuid: UUID, cwd: target } })
    await until(() => h.spawns.length === 1, 'the managed launch to start after the gate')
    expect(h.spawns[0].cwd).toBe(configured)
    expect(gatedSet()).toEqual([configured])
    expect(keptOut(target)).toHaveLength(1)
  })
})

describe('a managed resume-picker launch whose resume target is a worktree git still lists', () => {
  it('with no folder at the target (a prunable worktree): the picker is handed the configured folder and the clean sibling, never the target', async () => {
    const configured = folder('configured')
    const sibling = folder('sibling')
    const target = path.join(tmp, 'target-gone')
    h.worktreePorcelain = porcelain(configured, target, sibling)
    spawnPty(win, 'picker-target-gone', { profileId: PROFILE, cwd: configured, useResumePicker: true, resume: { uuid: UUID, cwd: target } })
    await until(() => h.spawns.length === 1, 'the picker launch to start after the gate')
    expect(h.spawns[0].cwd).toBe(configured)
    expect(gatedSet()).toEqual([configured, sibling])
    expect(keptOut(target)).toHaveLength(1)
  })

  it('with a folder at the target: the target is handed over with the configured folder', async () => {
    const configured = folder('configured')
    const target = folder('target')
    h.worktreePorcelain = porcelain(configured, target)
    spawnPty(win, 'picker-target-here', { profileId: PROFILE, cwd: configured, useResumePicker: true, resume: { uuid: UUID, cwd: target } })
    await until(() => h.spawns.length === 1, 'the picker launch to start after the gate')
    expect(gatedSet()).toEqual([configured, target])
  })
})

describe('a folder made at an absent resume target after the gate', () => {
  it('is never launched in: the launch is refused, in the terminal, and nothing starts', async () => {
    const configured = folder('configured')
    const target = path.join(tmp, 'target-late')
    let release: () => void = () => {}
    h.credentialCheck = new Promise<void>((r) => { release = r })
    spawnPty(win, 'target-made-late', { profileId: PROFILE, cwd: configured, resume: { uuid: UUID, cwd: target } })
    // The gate and the launch-folder check have answered (the target had no
    // folder); the launch is still held by the account's folder check.
    await until(() => keptOut(target).length === 1, 'the gate to find no folder at the resume target')
    expect(h.spawns).toHaveLength(0)
    // A folder appears there, with project settings the gate never read.
    fs.mkdirSync(path.join(target, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo not-checked' }))
    release()
    await until(() => messages.includes('pty:exit:target-made-late') || h.spawns.length > 0, 'the held launch to settle')
    expect(h.spawns.map((s) => s.cwd)).toEqual([])
    expect(messages).toContain('pty:exit:target-made-late')
    expect(terminalText('target-made-late')).toContain('resume directory')
    expect(terminalText('target-made-late')).toContain('not a directory the project-settings gate checked')
  })
})
