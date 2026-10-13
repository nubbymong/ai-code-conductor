// A local Claude session whose saved config still carries a Claude Code
// version pinned in an older release starts the installed Claude Code
// (2.1.1-beta.3), on every route a launch line takes: a fresh launch through
// the resume list (the line names the Claude Code the list starts, in
// CCC_CLAUDE_BIN), a fresh launch without it, and an exact resume of a
// restored tab. The folder of pinned versions is never asked about it, the
// launch's checks are made for the installed Claude Code, and the line
// carries the same options as a launch with no pin. The pin itself is left
// in the config.
//
// The real spawnPty, the real launch line builder (watched) and the real
// resolveClaudeBinary behind the provider; node-pty records the line and no
// process starts. The folder of pinned versions is a stand-in that answers
// with a launcher for ANY version and records every question, so a launch
// that still consulted it would name that launcher. The folder an older
// release made for the pinned version is also there on disk, in the resources
// folder, with a launcher of every name in it, so a launch that worked out
// that path itself, without asking the stand-in, would find one and name it.
// The installed Claude Code is the answer the PATH lookup keeps
// (claude-cli-probe.ts), and on Windows node.exe for the resume list is
// answered here, never by this runner's PATH.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  writes: [] as string[], infos: [] as string[], builds: [] as Array<{ claudeBin: string; pickerScript?: string | null; resumeUuid?: string }>,
  files: { settings: '', mcp: '', plugin: '' }, res: '',
  /** Every question put to the folder of pinned versions. */
  asked: [] as string[],
}))

const WIN = process.platform === 'win32'
const INSTALLED = WIN ? 'C:\\Users\\u\\.local\\bin\\claude.exe' : '/usr/local/bin/claude'
const PIN = WIN ? 'C:\\Res\\claude-versions\\2.0.5\\node_modules\\.bin\\claude.cmd' : '/res/claude-versions/2.0.5/node_modules/.bin/claude'
const PINNED = { legacyVersion: { enabled: true, version: '2.0.5' } }
const UUID = '0b9c2a1e-5d7f-4c3b-9a8e-1f2d3c4b5a69'

vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 7605, process: 'x',
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
vi.mock('../../../src/main/legacy-version-manager', () => ({
  resolveVersionBinary: (v: string) => { h.asked.push(`resolveVersionBinary ${v}`); return PIN },
  isVersionInstalled: (v: string) => { h.asked.push(`isVersionInstalled ${v}`); return true },
  installVersion: async (v: string) => { h.asked.push(`installVersion ${v}`); return { ok: true } },
  legacyCliPin: (l?: { version: string }) => { h.asked.push(`legacyCliPin ${l?.version}`); return l ? { version: l.version, installed: true } : undefined },
}))
// The installed Claude Code: the answer the PATH lookup keeps.
vi.mock('../../../src/main/claude-cli-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/claude-cli-probe')>()),
  recentClaudeOnWindows: () => INSTALLED,
  recentClaudeInLoginShellPath: () => ({ path: '/usr/local/bin:/usr/bin', claude: INSTALLED }),
}))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  return { ...actual, findOnWindowsPath: (...a: Parameters<typeof actual.findOnWindowsPath>) => (a[0].length === 1 && a[0][0] === 'node.exe' ? 'C:\\nodejs\\node.exe' : actual.findOnWindowsPath(...a)) }
})
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.res, getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: (m: string) => { h.infos.push(String(m)) }, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()
  return {
    ...actual,
    resolveResumeLaunch: (target?: { uuid: string; cwd: string }) => (target ? { resumeUuid: target.uuid, claudeCwd: target.cwd } : null),
    buildClaudeLaunchCommand: (o: Parameters<typeof actual.buildClaudeLaunchCommand>[0]) => {
      h.builds.push({ claudeBin: o.claudeBin, pickerScript: o.pickerScript, resumeUuid: o.resumeUuid })
      return actual.buildClaudeLaunchCommand(o)
    },
  }
})
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()), getConductorMcpPort: () => 0 }))
// The provider's resolveBinary is the real resolveClaudeBinary.
vi.mock('../../../src/main/providers', async () => {
  const { resolveClaudeBinary } = await import('../../../src/main/providers/claude/spawn')
  return {
    getProvider: () => ({
      resolveBinary: (legacy?: { enabled: boolean; version: string }) => resolveClaudeBinary(legacy),
      buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }),
      ingestSessionTelemetry: () => ({ stop: () => {} }),
    }),
  }
})
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
  readConfigChecked: () => ({ value: {}, outcome: 'ok' }),
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
const { __markScriptFoldersCheckedForTests, __resetScriptFoldersForTests } = await import('../../../src/main/script-folders')
const { LEGACY_PIN_NOT_USED } = await import('../../../src/shared/legacy-version')

const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
let tmp = ''
let seq = 0
let SID = ''

beforeEach(() => {
  SID = `pinnotused${String(++seq).padStart(16, '0')}`
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-pin-not-used-')))
  h.files.settings = path.join(tmp, 'settings-x.json')
  h.files.mcp = path.join(tmp, 'mcp-x.json')
  h.files.plugin = path.join(tmp, 'plugin')
  h.res = path.join(tmp, 'res')
  fs.writeFileSync(h.files.settings, '{}')
  fs.writeFileSync(h.files.mcp, '{}')
  fs.mkdirSync(h.files.plugin)
  fs.mkdirSync(path.join(h.res, 'scripts'), { recursive: true, mode: 0o700 })
  // The resume list is deployed, in a scripts folder the start made the user's alone.
  fs.writeFileSync(path.join(h.res, 'scripts', 'resume-picker.js'), '// picker\n', { mode: 0o600 })
  __markScriptFoldersCheckedForTests(h.res)
  // The folder an older release made for the pinned version, as it was left
  // on disk: a launcher of every name, and a node.exe beside them.
  const bin = path.join(h.res, 'claude-versions', PINNED.legacyVersion.version, 'node_modules', '.bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const name of ['claude.cmd', 'claude.exe', 'claude.ps1', 'claude', 'node.exe']) fs.writeFileSync(path.join(bin, name), 'left by an older release\n')
  h.writes = []
  h.infos = []
  h.builds = []
  h.asked = []
})
afterEach(() => {
  try { killPty(SID) } catch { /* not started */ }
  __resetScriptFoldersForTests()
  // TEST CLEANUP GUARD: only this test's own folder under the temp folder.
  if (path.basename(tmp).startsWith('ccc-pin-not-used-') && path.dirname(tmp) === fs.realpathSync.native(os.tmpdir())) {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

/** Starts a Claude session with `options` and returns its launch line. */
const launch = async (options: Record<string, unknown>): Promise<string> => {
  spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, ...options })
  const deadline = Date.now() + 5_000
  while (!h.writes.some((w) => w.includes('--settings')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  const line = (h.writes.find((w) => w.includes('--settings')) ?? '').replace(/\r$/, '')
  expect(line, 'a launch line was written').not.toBe('')
  expect(h.builds).toHaveLength(1)
  return line
}

/** How the line names the Claude Code the resume list starts. */
const forwarded = (bin: string): string => (WIN ? `$env:CCC_CLAUDE_BIN = '${bin}'` : `export CCC_CLAUDE_BIN='${bin}'`)

describe('a saved config with a Claude Code version pinned in an older release', () => {
  it('a fresh launch through the resume list: the list is handed the installed Claude Code, never the pinned launcher', async () => {
    const line = await launch({ useResumePicker: true, ...PINNED })
    expect(h.builds[0].pickerScript).toBe(path.join(h.res, 'scripts', 'resume-picker.js'))
    expect(h.builds[0].claudeBin).toBe(INSTALLED)
    expect(line).toContain(forwarded(INSTALLED))
    expect(line).not.toContain(PIN)
    expect(line).not.toContain('claude-versions')
    expect(h.asked).toEqual([])
  })

  it('a fresh launch without the resume list: the installed Claude Code itself', async () => {
    const line = await launch({ ...PINNED })
    expect(h.builds[0].claudeBin).toBe(INSTALLED)
    expect(line).toContain(`'${INSTALLED}'`)
    expect(line).not.toContain(PIN)
    expect(line).not.toContain('claude-versions')
    expect(h.asked).toEqual([])
  })

  it('an exact resume of a restored tab: the installed Claude Code resumes the conversation', async () => {
    fs.mkdirSync(path.join(tmp, 'conv'))
    const line = await launch({ useResumePicker: true, resume: { uuid: UUID, cwd: path.join(tmp, 'conv') }, ...PINNED })
    expect(h.builds[0].resumeUuid).toBe(UUID)
    expect(h.builds[0].claudeBin).toBe(INSTALLED)
    expect(line).toContain(`'${INSTALLED}' --resume ${UUID}`)
    expect(line).not.toContain(PIN)
    expect(line).not.toContain('claude-versions')
    expect(h.asked).toEqual([])
  })

  it('the line carries the same options as a launch with no pin (the canvas plugin included)', async () => {
    const pinned = await launch({ useResumePicker: true, ...PINNED })
    killPty(SID)
    h.writes = []
    h.builds = []
    SID = `pinnotused${String(++seq).padStart(16, '0')}`
    const plain = await launch({ useResumePicker: true })
    expect(pinned).toContain(' --plugin-dir ')
    const options = (l: string): string[] => l.split(' ').filter((w) => w.startsWith('--'))
    expect(options(pinned)).toEqual(options(plain))
  })

  it('one plain log line says the pin is not used, and no line names the pinned launcher', async () => {
    await launch({ useResumePicker: true, ...PINNED })
    expect(h.infos.filter((m) => m.includes(LEGACY_PIN_NOT_USED))).toHaveLength(1)
    for (const m of h.infos) expect(m).not.toContain('claude-versions')
  })

  it('a config with no pin says nothing about one', async () => {
    await launch({ useResumePicker: true })
    expect(h.infos.filter((m) => m.includes(LEGACY_PIN_NOT_USED))).toEqual([])
    expect(h.builds[0].claudeBin).toBe(INSTALLED)
  })
})
