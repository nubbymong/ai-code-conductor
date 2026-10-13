// A local Claude launch that opens the resume list runs the deployed picker
// (resources/scripts/resume-picker.js) only when it is a plain file with one
// name (isPlainScriptFile), in a scripts folder this run made the user's
// alone (script-folders.ts). Anything else at that path (a directory, a link,
// a hard link, whatever left it there, a deploy that failed included) is
// refused with a warning naming the file; a scripts folder the start did not
// make the user's alone, or another folder put in its place since, is refused
// with a warning naming the folder; and Claude Code starts directly, as when
// the picker is not deployed. The picker is looked up on every local launch,
// and a refusal is said only for a launch that asked for the resume list.
// The real spawnPty and the real launch line builder, watched; node-pty
// records the line, and no process starts. Links and hard links are stood in
// through a stubbed lstat (this machine is never asked to make one), and the
// start's folder check through the module's test mark. The scripts folder
// and the picker are made with this user's modes (0700, 0600), whatever the
// runner's umask. Mutations to prove this can fail: take the picker path
// whenever fs.existsSync(path) holds; take it without the folder check.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  writes: [] as string[], warns: [] as string[], builds: [] as Array<{ pickerScript?: string | null }>,
  files: { settings: '', mcp: '', plugin: '' }, res: '', bin: 'claude',
  lstat: null as null | ((p: unknown) => unknown),
}))

// What a path reads as without following a link, where a case stands one in.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    lstatSync: vi.fn((p: unknown, o?: unknown) => {
      const stub = h.lstat?.(p)
      if (stub) return stub
      return (actual.lstatSync as (a: unknown, b?: unknown) => import('fs').Stats)(p, o)
    }),
  }
})
vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 7603, process: 'x',
    onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }),
    write: (d: string) => { h.writes.push(String(d)) }, resize: () => {}, kill: () => {},
  }),
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.res, getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: (m: string) => { h.warns.push(String(m)) }, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()
  return {
    ...actual,
    resolveResumeLaunch: () => null,
    buildClaudeLaunchCommand: (o: Parameters<typeof actual.buildClaudeLaunchCommand>[0]) => {
      h.builds.push({ ...o })
      return actual.buildClaudeLaunchCommand(o)
    },
  }
})
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()), getConductorMcpPort: () => 0 }))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({ resolveBinary: () => ({ cmd: h.bin, source: 'system' }), buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }), ingestSessionTelemetry: () => ({ stop: () => {} }) }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: h.bin, source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => h.files.plugin }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => h.files.settings, removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => h.files.mcp, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: (key: string) => ({ value: key === 'settings' ? {} : {}, outcome: 'ok' }),
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
const { __markScriptFoldersCheckedForTests, __resetScriptFoldersForTests, secureScriptFolders, scriptFoldersDeployed } = await import('../../../src/main/script-folders')

const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const PICKER_REFUSED = /resume-picker\.js in the resources folder is not a plain file with one name/
const FOLDER_REFUSED = /the scripts folder in the resources folder (was not made this user's alone in this run|is not the folder made this user's alone in this run); the resume list is skipped and Claude Code starts directly/
/** Any warning about the picker or its folder, however worded. */
const PICKER_SAID = /resume-picker\.js in the resources folder|the scripts folder in the resources folder/
let tmp = ''
let seq = 0
let SID = ''
const picker = (): string => path.join(h.res, 'scripts', 'resume-picker.js')
/** How a stand-in reads, without following a link. */
const standIn = (isFile: boolean, nlink: number) => ({ isFile: () => isFile, isSymbolicLink: () => !isFile, isDirectory: () => false, nlink, mode: isFile ? 0o100600 : 0o120777 })

beforeEach(() => {
  SID = `plainpicker${String(++seq).padStart(15, '0')}`
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-claude-picker-plain-')))
  h.files.settings = path.join(tmp, 'settings-x.json')
  h.files.mcp = path.join(tmp, 'mcp-x.json')
  h.files.plugin = path.join(tmp, 'plugin')
  h.res = path.join(tmp, 'res')
  fs.writeFileSync(h.files.settings, '{}')
  fs.writeFileSync(h.files.mcp, '{}')
  fs.mkdirSync(h.files.plugin)
  fs.mkdirSync(path.join(h.res, 'scripts'), { recursive: true, mode: 0o700 })
  h.bin = process.platform === 'win32' ? 'C:\\Users\\u\\.local\\bin\\claude.exe' : 'claude'
  h.writes = []
  h.warns = []
  h.builds = []
  h.lstat = null
  // As the start does before any launch: the scripts folder made the user's alone.
  __markScriptFoldersCheckedForTests(h.res)
})
afterEach(() => {
  try { killPty(SID) } catch { /* not started */ }
  h.lstat = null
  __resetScriptFoldersForTests()
  // TEST CLEANUP GUARD: only this test's own folder under the temp folder.
  if (path.basename(tmp).startsWith('ccc-claude-picker-plain-') && path.dirname(tmp) === fs.realpathSync.native(os.tmpdir())) {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

/** Starts a fresh session that asks for the resume list (unless told not to), and waits for its launch line. */
const launch = async (askForTheList = true): Promise<void> => {
  spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, ...(askForTheList ? { useResumePicker: true } : {}) })
  const deadline = Date.now() + 5_000
  while (!h.writes.some((w) => w.includes('--settings')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  expect(h.writes.some((w) => w.includes('--settings'))).toBe(true)
  expect(h.builds).toHaveLength(1)
}

describe('a fresh local Claude session: the resume list runs only from a plain file with one name', () => {
  it('a plain picker: it is handed to the launch line, and nothing is said', async () => {
    fs.writeFileSync(picker(), '// picker\n', { mode: 0o600 })
    await launch()
    expect(h.builds[0].pickerScript).toBe(picker())
    expect(h.warns.filter((w) => PICKER_REFUSED.test(w))).toEqual([])
  })

  it('nothing there (not deployed yet): no picker, and nothing said', async () => {
    await launch()
    expect(h.builds[0].pickerScript).toBeNull()
    expect(h.warns.filter((w) => PICKER_REFUSED.test(w))).toEqual([])
  })

  it('a directory holding index.js at the picker path: no picker, the launch line never names it, and one warning by the file\'s name', async () => {
    fs.mkdirSync(picker())
    fs.writeFileSync(path.join(picker(), 'index.js'), '// not the app\'s\n')
    await launch()
    expect(h.builds[0].pickerScript).toBeNull()
    expect(h.writes.join('\n')).not.toContain('resume-picker.js')
    const said = h.warns.filter((w) => PICKER_REFUSED.test(w))
    expect(said).toHaveLength(1)
    expect(said[0]).not.toContain(h.res)
  })

  it('a picker with another name (a hard link): no picker, and one warning', async () => {
    fs.writeFileSync(picker(), '// picker\n', { mode: 0o600 })
    h.lstat = (p) => (p === picker() ? standIn(true, 2) : null)
    await launch()
    expect(h.builds[0].pickerScript).toBeNull()
    expect(h.warns.filter((w) => PICKER_REFUSED.test(w))).toHaveLength(1)
  })

  it('a picker that is a link: no picker, and one warning', async () => {
    fs.writeFileSync(picker(), '// picker\n', { mode: 0o600 })
    h.lstat = (p) => (p === picker() ? standIn(false, 1) : null)
    await launch()
    expect(h.builds[0].pickerScript).toBeNull()
    expect(h.warns.filter((w) => PICKER_REFUSED.test(w))).toHaveLength(1)
  })
})

describe('a fresh local Claude session: the resume list runs only from a scripts folder this run made the user\'s alone', () => {
  it('the start never checked the folder: a plain picker is not run, and one warning names the folder, never its path', async () => {
    fs.writeFileSync(picker(), '// picker\n', { mode: 0o600 })
    __resetScriptFoldersForTests()
    await launch()
    expect(h.builds[0].pickerScript).toBeNull()
    expect(h.writes.join('\n')).not.toContain('resume-picker.js')
    const said = h.warns.filter((w) => FOLDER_REFUSED.test(w))
    expect(said).toHaveLength(1)
    expect(said[0]).not.toContain(h.res)
  })

  it('the owner-only rule refused the folder at start: a plain picker is not run, and one warning', async () => {
    fs.writeFileSync(picker(), '// picker\n', { mode: 0o600 })
    await secureScriptFolders(h.res, async (dirs) => dirs.map((dir) => ({ dir, ok: false, detail: 'not owner-only' })))
    scriptFoldersDeployed()
    h.warns = []
    await launch()
    expect(h.builds[0].pickerScript).toBeNull()
    expect(h.warns.filter((w) => FOLDER_REFUSED.test(w))).toHaveLength(1)
  })

  it('the rule passed the folder at start: the picker is run, and nothing is said', async () => {
    fs.writeFileSync(picker(), '// picker\n', { mode: 0o600 })
    await secureScriptFolders(h.res, async (dirs) => dirs.map((dir) => ({ dir, ok: true })))
    scriptFoldersDeployed()
    await launch()
    expect(h.builds[0].pickerScript).toBe(picker())
    expect(h.warns.filter((w) => FOLDER_REFUSED.test(w) || PICKER_REFUSED.test(w))).toEqual([])
  })

  it('another folder put at the scripts folder\'s path since the check: the picker in it is not run, and one warning', async () => {
    const scripts = path.join(h.res, 'scripts')
    fs.renameSync(scripts, path.join(h.res, 'scripts-checked'))
    fs.mkdirSync(scripts, { mode: 0o700 })
    fs.writeFileSync(picker(), '// picker\n', { mode: 0o600 })
    await launch()
    expect(h.builds[0].pickerScript).toBeNull()
    expect(h.warns.filter((w) => FOLDER_REFUSED.test(w))).toHaveLength(1)
  })
})

describe('a fresh local Claude session that does not ask for the resume list', () => {
  // The picker is looked up on every local launch; only one that asked for
  // the resume list says why it cannot have it. Mutation to prove this can
  // fail: warn whatever the launch asked for.
  it('a directory holding index.js at the picker path: no picker, and nothing said', async () => {
    fs.mkdirSync(picker())
    fs.writeFileSync(path.join(picker(), 'index.js'), '// not the app\'s\n')
    await launch(false)
    expect(h.builds[0].pickerScript).toBeNull()
    expect(h.warns.filter((w) => PICKER_SAID.test(w))).toEqual([])
  })

  it('a scripts folder the start never checked: no picker, and nothing said', async () => {
    fs.writeFileSync(picker(), '// picker\n', { mode: 0o600 })
    __resetScriptFoldersForTests()
    await launch(false)
    expect(h.builds[0].pickerScript).toBeNull()
    expect(h.warns.filter((w) => PICKER_SAID.test(w))).toEqual([])
  })

  it('the same refusal for a launch that asks for the list: said once', async () => {
    fs.writeFileSync(picker(), '// picker\n', { mode: 0o600 })
    __resetScriptFoldersForTests()
    await launch(true)
    expect(h.warns.filter((w) => PICKER_SAID.test(w))).toHaveLength(1)
  })
})
