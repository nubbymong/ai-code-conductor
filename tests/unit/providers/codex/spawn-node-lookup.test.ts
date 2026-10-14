// The node the Codex resume picker runs on, on Windows
// (src/main/providers/codex/spawn.ts resolveNodeExe): found in PATH's fully
// qualified folders, in PATH's order, read in this process with no shell and
// no process started; a relative PATH entry, and so the current folder, is
// never searched; a folder that does not answer is asked nothing more in that
// lookup; nothing found gives no node: never the bare name, which would be
// looked up outside the folders PATH names in full. With no node the resume
// list is skipped and Codex starts directly, as when the list is not deployed,
// and the log says why (2.1.1-beta.3, S10); on macOS and Linux likewise when
// the login shell names no node and the launch's own PATH holds none.
// Synthetic environments only (never this process's own); the disk is
// answered by an injected stat, or by a stubbed statSync (and accessSync) on
// the picker route.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'

const started: string[] = []
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execSync: vi.fn((cmd: unknown) => {
      started.push(String(cmd))
      throw new Error('no process is started to find node')
    }),
  }
})
// The disk, on the picker route: one file answers as node.exe, everything
// else as the real disk answers (a Windows path is not there on CI).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    statSync: vi.fn((p: unknown, o?: unknown) => {
      if (p === (globalThis as any).__nodeLookupFile) return { isFile: () => true } as import('fs').Stats
      return (actual.statSync as (a: unknown, b?: unknown) => import('fs').Stats)(p, o)
    }),
    // macOS and Linux: the same file may also be run (findOnPosixPath).
    accessSync: vi.fn((p: unknown, m?: unknown) => {
      if (p === (globalThis as any).__nodeLookupFile) return undefined
      return (actual.accessSync as (a: unknown, b?: unknown) => void)(p, m)
    }),
  }
})
// What the os module reports, forced per case; every other answer is the
// real one.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: vi.fn(() => (globalThis as any).__osPlatform ?? actual.platform()) }
})
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => (globalThis as any).__nodeLookupResDir ?? '', getDataDirectory: () => '' }))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))
vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: () => ({}),
  readConfigChecked: () => ({ outcome: 'absent', value: null }),
  getConfigDir: () => '/cfg',
}))
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const codexSpawn = await import('../../../../src/main/providers/codex/spawn')
const { __markScriptFoldersCheckedForTests } = await import('../../../../src/main/script-folders')
const { resolveNodeExe, __resetNodeExeCache, buildCodexSpawn } = codexSpawn
const { logInfo } = await import('../../../../src/main/debug-logger')
const SKIPPED = 'Node.js was not found, so the resume list was skipped and Codex starts directly'
type Stat = 'file' | 'none' | 'unreachable'

/** A stat that records every path it is asked and answers from `files`
 *  ('file') and `down` (a folder that does not answer). */
function disk(files: string[], down: string[] = []): { asked: string[]; statFile: (p: string) => Stat } {
  const asked: string[] = []
  return {
    asked,
    statFile: (p: string) => {
      asked.push(p)
      if (down.some((d) => p.toLowerCase().startsWith(d.toLowerCase() + '\\'))) return 'unreachable'
      return files.includes(p) ? 'file' : 'none'
    },
  }
}

beforeEach(() => {
  started.length = 0
  vi.mocked(logInfo).mockClear()
  __resetNodeExeCache()
})
afterEach(() => {
  delete (globalThis as any).__nodeLookupFile
  delete (globalThis as any).__nodeLookupResDir
  delete (globalThis as any).__osPlatform
  __resetNodeExeCache()
})

describe('node for the picker is found in PATH\'s absolute folders without starting a process', () => {
  it('the first fully qualified PATH folder holding node.exe gives it; relative entries are never asked', () => {
    const d = disk(['C:\\second\\node.exe', 'C:\\third\\node.exe'])
    const env = { Path: 'C:\\first;relative\\bin;.;.\\node_modules\\.bin;C:\\second;C:\\third' }
    expect(resolveNodeExe({ platform: 'win32', env, statFile: d.statFile })).toBe('C:\\second\\node.exe')
    expect(d.asked).toEqual(['C:\\first\\node.exe', 'C:\\second\\node.exe'])
    expect(started).toEqual([])
  })

  it('the current folder is never searched: only a PATH folder is ever asked', () => {
    // Only the folders PATH names in full are asked.
    const d = disk(['C:\\project\\node.exe'])
    const env = { PATH: '.;node_modules\\.bin;C:\\tools' }
    expect(resolveNodeExe({ platform: 'win32', env, statFile: d.statFile })).toBeNull()
    expect(d.asked).toEqual(['C:\\tools\\node.exe'])
    expect(started).toEqual([])
  })

  it('a folder that does not answer is asked once, and the walk goes on', () => {
    const d = disk(['C:\\third\\node.exe'], ['C:\\down'])
    const env = { PATH: 'C:\\down;C:\\down;C:\\third' }
    expect(resolveNodeExe({ platform: 'win32', env, statFile: d.statFile })).toBe('C:\\third\\node.exe')
    expect(d.asked.filter((p) => p.startsWith('C:\\down'))).toEqual(['C:\\down\\node.exe'])
    expect(started).toEqual([])
  })

  it('a quoted folder is read without its quotes; a share is read; a device path or a drive-relative entry is not', () => {
    const d = disk(['\\\\srv\\share\\node\\node.exe'])
    const env = { PATH: '\\\\?\\C:\\dev;\\\\.\\pipe\\x;C:rel;"C:\\Program Files\\nodejs";\\\\srv\\share\\node' }
    expect(resolveNodeExe({ platform: 'win32', env, statFile: d.statFile })).toBe('\\\\srv\\share\\node\\node.exe')
    expect(d.asked).toEqual(['C:\\Program Files\\nodejs\\node.exe', '\\\\srv\\share\\node\\node.exe'])
  })

  it('PATH is read by its Windows name in any spelling', () => {
    const d = disk(['C:\\n\\node.exe'])
    expect(resolveNodeExe({ platform: 'win32', env: { pAtH: 'C:\\n' }, statFile: d.statFile })).toBe('C:\\n\\node.exe')
  })

  it('no PATH folder holds node.exe: no node, never the bare name, and still no process started', () => {
    const d = disk([])
    expect(resolveNodeExe({ platform: 'win32', env: { PATH: 'C:\\a;C:\\b' }, statFile: d.statFile })).toBeNull()
    expect(resolveNodeExe({ platform: 'win32', env: {}, statFile: d.statFile })).toBeNull()
    expect(started).toEqual([])
  })

  it('a found node is kept for later launches under the same PATH, and looked up again under another', () => {
    const first = disk(['C:\\a\\node.exe'])
    expect(resolveNodeExe({ platform: 'win32', env: { PATH: 'C:\\a' }, statFile: first.statFile })).toBe('C:\\a\\node.exe')
    const again = disk([])
    expect(resolveNodeExe({ platform: 'win32', env: { PATH: 'C:\\a' }, statFile: again.statFile })).toBe('C:\\a\\node.exe')
    expect(again.asked).toEqual([])
    const other = disk(['C:\\b\\node.exe'])
    expect(resolveNodeExe({ platform: 'win32', env: { PATH: 'C:\\b' }, statFile: other.statFile })).toBe('C:\\b\\node.exe')
    expect(other.asked).toEqual(['C:\\b\\node.exe'])
  })
})

const WINDOWS_REALM = { executable: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd', env: { SystemRoot: 'C:\\Windows', Path: 'relative;C:\\ccc-test-only\\nodejs', CODEX_HOME: 'C:\\r' }, sessionsDir: 'C:\\r\\sessions' }
const POSIX_REALM = { executable: '/opt/codex/bin/codex', env: { PATH: '/ccc-test-only/bin', CODEX_HOME: '/r' }, sessionsDir: '/r/sessions' }

/** A Codex launch built for `platform` (process.platform forced), the picker
 *  deployed in a temp resources folder that is removed afterwards, as is any
 *  pick folder the launch made. `nodeFile`: the one file the disk answers as
 *  node. */
async function codexLaunch(platform: NodeJS.Platform, realm: typeof WINDOWS_REALM | typeof POSIX_REALM, nodeFile: string | null, useResumePicker = true): Promise<{ out: ReturnType<typeof buildCodexSpawn>; cmd: string; script: string; deployedScript: string }> {
  const fs = await vi.importActual<typeof import('fs')>('fs')
  const os = await vi.importActual<typeof import('os')>('os')
  const res = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-node-lookup-'))
  try {
    fs.mkdirSync(path.join(res, 'scripts'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(res, 'scripts', 'codex-resume-picker.js'), '// stub', { mode: 0o600 })
    // As the start does before a launch: the scripts folder made the user's alone.
    __markScriptFoldersCheckedForTests(res)
    ;(globalThis as any).__nodeLookupResDir = res
    if (nodeFile) (globalThis as any).__nodeLookupFile = nodeFile
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    let out!: ReturnType<typeof buildCodexSpawn>
    try {
      out = buildCodexSpawn({
        sessionId: 'sid', useResumePicker,
        realmLaunch: { executable: realm.executable, env: { ...realm.env }, sessionsDir: realm.sessionsDir },
        codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
      })
    } finally {
      if (orig) Object.defineProperty(process, 'platform', orig)
    }
    const pickDir = out.pickFile ? path.dirname(out.pickFile) : null
    if (pickDir && path.dirname(pickDir) === os.tmpdir() && /^ccc-codex-pick-/.test(path.basename(pickDir))) fs.rmSync(pickDir, { recursive: true, force: true })
    return { out, cmd: out.cmd, script: out.args[0], deployedScript: path.join(res, 'scripts', 'codex-resume-picker.js') }
  } finally {
    if (path.dirname(res) === os.tmpdir() && /^ccc-node-lookup-/.test(path.basename(res))) fs.rmSync(res, { recursive: true, force: true })
  }
}

/** The picker launch through the npm launcher with the launch built for
 *  Windows (process.platform 'win32'). */
async function pickerLaunchOnWindows(nodeFile: string | null = 'C:\\ccc-test-only\\nodejs\\node.exe'): Promise<{ out: ReturnType<typeof buildCodexSpawn>; cmd: string; script: string; deployedScript: string }> {
  return codexLaunch('win32', WINDOWS_REALM, nodeFile)
}

/** What a launch's route is: the program, its arguments, and its cmd.exe line. */
function route(out: ReturnType<typeof buildCodexSpawn>): { cmd: string; args: string[]; commandLine: string | undefined } {
  return { cmd: out.cmd, args: out.args, commandLine: out.commandLine }
}

describe('the picker route on Windows starts the node its session\'s PATH names', () => {
  it('the picker\'s executable is node.exe from the launch environment\'s PATH, found without a process', async () => {
    const launch = await pickerLaunchOnWindows()
    expect(launch.cmd).toBe('C:\\ccc-test-only\\nodejs\\node.exe')
    expect(launch.script).toBe(launch.deployedScript)
    expect(started).toEqual([])
  })

  it('the picker\'s node is looked up for the platform the launch is built for, whatever the os module reports', async () => {
    ;(globalThis as any).__osPlatform = 'linux'
    const launch = await pickerLaunchOnWindows()
    expect(launch.cmd).toBe('C:\\ccc-test-only\\nodejs\\node.exe')
    expect(started).toEqual([])
  })

  it('no node.exe in a folder the launch environment\'s PATH names in full: Codex starts directly, the log says why once, and no pick folder is made', async () => {
    const fs = await vi.importActual<typeof import('fs')>('fs')
    const os = await vi.importActual<typeof import('os')>('os')
    const picks = (): string[] => fs.readdirSync(os.tmpdir()).filter((n) => /^ccc-codex-pick-/.test(n))
    const before = picks()
    // The relative entry holds node.exe; it is never asked, and never started by name.
    ;(globalThis as any).__nodeLookupFile = 'relative\\node.exe'
    const launch = await pickerLaunchOnWindows(null)
    // The direct-start route, exactly as a launch that asks for no list.
    const direct = await codexLaunch('win32', WINDOWS_REALM, null, false)
    expect(route(launch.out)).toEqual(route(direct.out))
    expect(launch.out.commandLine).toContain('codex.cmd')
    expect(launch.out.args).not.toContain(launch.deployedScript)
    expect(launch.out.pickFile).toBeUndefined()
    expect(picks()).toEqual(before)
    expect(vi.mocked(logInfo).mock.calls.filter((c) => String(c[0]).includes('resume list'))).toEqual([[`[codex-spawn] sid: ${SKIPPED}`]])
    expect((codexSpawn as any).CODEX_RESUME_LIST_SKIPPED_NO_NODE).toBe(SKIPPED)
    expect(started).toEqual([])
  })
})

describe('the picker route on macOS and Linux starts a node the launch can run', () => {
  // The login shell is never really asked here: its answer is "no node"
  // (execSync throws), so resolveNodeExe gives the bare name.
  it('the bare node is in the launch environment\'s PATH: the picker starts on it, as before', async () => {
    const launch = await codexLaunch('darwin', POSIX_REALM, '/ccc-test-only/bin/node')
    expect(launch.cmd).toBe('node')
    expect(launch.script).toBe(launch.deployedScript)
    expect(vi.mocked(logInfo).mock.calls.filter((c) => String(c[0]).includes('resume list'))).toEqual([])
  })

  it('no node in the login shell\'s PATH nor in the launch environment\'s: Codex starts directly and the log says why once', async () => {
    const launch = await codexLaunch('linux', POSIX_REALM, null)
    const direct = await codexLaunch('linux', POSIX_REALM, null, false)
    expect(launch.cmd).toBe('/opt/codex/bin/codex')
    expect(route(launch.out)).toEqual(route(direct.out))
    expect(launch.out.args).not.toContain(launch.deployedScript)
    expect(launch.out.pickFile).toBeUndefined()
    expect(vi.mocked(logInfo).mock.calls.filter((c) => String(c[0]).includes('resume list'))).toEqual([[`[codex-spawn] sid: ${SKIPPED}`]])
  })

  it('pickerNodeFor: the login shell\'s node as found; the bare name only when the PATH holds it; Windows as resolveNodeExe', () => {
    const pickerNodeFor = (codexSpawn as any).pickerNodeFor as (env: Record<string, string | undefined>, platform: NodeJS.Platform) => string | null
    ;(globalThis as any).__nodeLookupFile = '/ccc-test-only/bin/node'
    expect(pickerNodeFor({ PATH: '/ccc-test-only/bin' }, 'linux')).toBe('node')
    expect(pickerNodeFor({ PATH: 'relative/bin:/elsewhere' }, 'linux')).toBeNull()
    expect(pickerNodeFor({}, 'darwin')).toBeNull()
    ;(globalThis as any).__nodeLookupFile = 'C:\\ccc-test-only\\nodejs\\node.exe'
    expect(pickerNodeFor({ Path: 'C:\\ccc-test-only\\nodejs' }, 'win32')).toBe('C:\\ccc-test-only\\nodejs\\node.exe')
    expect(pickerNodeFor({ Path: 'C:\\elsewhere' }, 'win32')).toBeNull()
  })
})
