// P3.10 (rows 43, 46, 47, 63): a Codex launch carries the app's hooks when main
// hands it a hook file (the Hooks gateway on and listening), as a Claude launch
// carries its http hooks in its settings file: the same command for every
// session (Codex's trust of a reviewed hook lasts while it is unchanged), the
// session named by the environment the hook inherits (its id, and the hook
// file's path; never the token). None without a hook file, before the
// forwarder is deployed, or when the command cannot be given safely on the
// launch's route.
// P3.10 round 1: through the npm .cmd shim from a resources folder whose path
// is not a plain word, the launch runs the app's plain-path copy of the
// wrapper under the user's local app data folder, checked before each use
// (V3); the picker is told which conversations other tabs are on, and Codex
// is not (V2). Nothing is started: the node lookup is a fake.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync, renameSync } from 'fs'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn(() => (process.platform === 'win32' ? 'C:\\node\\node.exe\n' : '/usr/local/bin/node\n')) }
})
// The disk, for the picker route's node lookup on Windows: one fixed node.exe
// (named in the picker launches' PATH below) answers as a file; every other
// path as the real disk answers.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    statSync: vi.fn((p: unknown, o?: unknown) => {
      if (p === 'C:\\ccc-test-only\\nodejs\\node.exe') return { isFile: () => true } as import('fs').Stats
      return (actual.statSync as (a: unknown, b?: unknown) => import('fs').Stats)(p, o)
    }),
    // What a path reads as without following a link, where a case stands one
    // in (a hard link or a link, which this machine is never asked to make).
    lstatSync: vi.fn((p: unknown, o?: unknown) => {
      const stub = (globalThis as any).__mockLstat?.(p)
      if (stub) return stub
      return (actual.lstatSync as (a: unknown, b?: unknown) => import('fs').Stats)(p, o)
    }),
  }
})
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => (globalThis as any).__mockResourcesDir ?? '',
  getDataDirectory: () => (globalThis as any).__mockResourcesDir ?? '',
}))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  mcpSessionToken: () => 'tok',
  issueMcpSessionToken: () => 'tok',
}))
const warns = vi.hoisted(() => [] as string[])
vi.mock('../../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/debug-logger')>()),
  logWarn: (...a: unknown[]) => { warns.push(a.map(String).join(' ')) },
}))
// [host] The real logger kept above keeps its log inside the test's own folder, never
// the installed app's (tests/helpers/test-data-dir.ts).
const TEST_DATA = await vi.hoisted(async () => (await import('../../../helpers/test-data-dir')).useTestDataDirectory())
vi.mock('../../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  // The built-in tools switches' checked read: a fresh install, so no
  // settings file on disk decides it.
  readConfigChecked: () => ({ outcome: 'absent', value: null }),
  getConfigDir: () => (globalThis as any).__mockResourcesDir ?? '/cfg',
}))

import { CodexProvider } from '../../../../src/main/providers/codex'
import { codexHookCommand, codexHookConfigArgs, codexPlainWrapperDir, __setCodexLocalAppDataForTests, __resetCodexHookFoldersForTests, CODEX_HOOK_FILE_ENV, CODEX_HOOK_FOLDERS_RETRY_MS } from '../../../../src/main/providers/codex/hooks'
import { codexCmdExeTarget, CODEX_OPEN_ELSEWHERE_ENV } from '../../../../src/main/providers/codex/spawn'
import { __markScriptFoldersCheckedForTests, __resetScriptFoldersForTests, secureScriptFolders, scriptFoldersDeployed } from '../../../../src/main/script-folders'
import { deployScriptFile } from '../../../../src/main/script-deploy'

const TEST_PREFIX = 'p310-spawn-hooks-'
const made: string[] = []
function tempDir(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), TEST_PREFIX)))
  made.push(d)
  return d
}
function resources(deploy = true, sub?: string): string {
  const top = tempDir()
  const d = sub ? join(top, sub) : top
  mkdirSync(join(d, 'scripts'), { recursive: true, mode: 0o700 })
  if (deploy) {
    writeFileSync(join(d, 'scripts', 'ccc-codex-hook.js'), '// test copy', { mode: 0o600 })
    writeFileSync(join(d, 'scripts', 'ccc-codex-hook.cmd'), 'rem test copy', { mode: 0o600 })
  }
  ;(globalThis as any).__mockResourcesDir = d
  // As the start does before a launch: the scripts folder made the user's alone.
  __markScriptFoldersCheckedForTests(d)
  return d
}
afterEach(() => {
  vi.useRealTimers()
  __resetScriptFoldersForTests()
  ;(globalThis as any).__mockResourcesDir = undefined
  __setCodexLocalAppDataForTests(null)
  __resetCodexHookFoldersForTests()
  warns.length = 0
  // TEST CLEANUP GUARD: only the folders this test made, by their own prefix, under the temp folder.
  for (const d of made.splice(0)) {
    if (!basename(d).startsWith(TEST_PREFIX) || dirname(d) !== realpathSync.native(tmpdir())) continue
    rmSync(d, { recursive: true, force: true })
  }
})

const exe = process.platform === 'win32' ? 'C:\\codex\\codex.exe' : '/opt/codex/bin/codex'
const launch = { executable: exe, env: { PATH: process.platform === 'win32' ? 'C:\\Windows;C:\\ccc-test-only\\nodejs' : '/usr/bin', CODEX_HOME: '/res/r1', SystemRoot: 'C:\\Windows' }, sessionsDir: '/res/r1/sessions' }
const hookFile = join(tmpdir(), 'codex-hooks', 'ccc-codex-hook-abc', 'hook.json')
const opts = { sessionId: 'sess-1', realmLaunch: launch, codexOptions: { permissionsPreset: 'standard' as const } }
const ID = '019dd000-0001-7000-8000-0000000000c1'
const ID_B = '019dd000-0001-7000-8000-0000000000c2'

/** Round 4: the owner-only rule, answered here: each folder made when missing,
 *  `ok` its verdict. */
function secureWith(ok: boolean) {
  return async (dirs: readonly string[]) => dirs.map((dir) => {
    try { mkdirSync(dir, { mode: 0o700 }) } catch { /* there already */ }
    return { dir, ok, detail: ok ? 'owner-only' : 'not this user\'s alone' }
  })
}

function hookArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) if (args[i] === '-c' && /^hooks\./.test(args[i + 1] ?? '')) out.push(args[i + 1])
  return out
}
/** The picker, deployed (a stub), so a launch through it is visible. */
function deployPicker(res: string): void {
  writeFileSync(join(res, 'scripts', 'codex-resume-picker.js'), '// stub', { mode: 0o600 })
}
/** A realm in `res` with this conversation's rollout, run in `cwd`. */
function realmWith(res: string, id: string, cwd: string): string {
  const at = new Date(Date.now() - 2 * 24 * 3600 * 1000)
  const sessions = join(res, 'realm', 'sessions')
  const dir = join(sessions, String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, '0'), String(at.getUTCDate()).padStart(2, '0'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `rollout-2026-09-25T10-00-00-${id}.jsonl`), JSON.stringify({ timestamp: at.toISOString(), type: 'session_meta', payload: { id, cwd, cli_version: '0.155.1' } }) + '\n')
  return sessions
}

describe('buildCodexSpawn: the app\'s hooks', () => {
  it('with a hook file: the six hooks, the hook file named in the environment, and hooksInstalled', () => {
    const res = resources()
    const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    const command = codexHookCommand(join(res, 'scripts'), process.platform, false)!
    expect(command).not.toBeNull()
    expect(hookArgs(out.args)).toEqual(hookArgs(codexHookConfigArgs(command)))
    expect(hookArgs(out.args).length).toBe(6)
    expect(out.env[CODEX_HOOK_FILE_ENV]).toBe(hookFile)
    expect(out.env.CLAUDE_MULTI_SESSION_ID).toBe('sess-1')
    expect(out.hooksInstalled).toBe(true)
    // The token is never on the command line or in the environment.
    expect(JSON.stringify(out)).not.toMatch(/0f8b6a2c|token/i)
  })

  it('without a hook file (the Hooks gateway off or not listening): no hooks, nothing named', () => {
    resources()
    const out = new CodexProvider().buildSpawnCommand(opts)
    expect(hookArgs(out.args)).toEqual([])
    expect(out.env[CODEX_HOOK_FILE_ENV]).toBeUndefined()
    expect(out.hooksInstalled).toBe(false)
  })

  it('before the forwarder is deployed: no hooks (Codex would run a missing command)', () => {
    resources(false)
    const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    expect(hookArgs(out.args)).toEqual([])
    expect(out.env[CODEX_HOOK_FILE_ENV]).toBeUndefined()
    expect(out.hooksInstalled).toBe(false)
  })

  it('a hook file path that is not absolute, or holds a control character, is not handed on', () => {
    resources()
    for (const bad of ['hook.json', `${hookFile}\n`]) {
      const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile: bad } })
      expect(out.hooksInstalled, JSON.stringify(bad)).toBe(false)
      expect(out.env[CODEX_HOOK_FILE_ENV]).toBeUndefined()
    }
  })

  it('the resume picker and an exact resume forward the same hooks as a direct launch (round 1, N1: each built as named)', () => {
    const res = resources()
    deployPicker(res)
    const direct = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    const picker = new CodexProvider().buildSpawnCommand({ ...opts, useResumePicker: true, codexHooks: { hookFile } })
    expect(basename(picker.args[0])).toBe('codex-resume-picker.js')
    expect(hookArgs(picker.args)).toEqual(hookArgs(direct.args))
    expect(picker.hooksInstalled).toBe(true)
    const sessionsDir = realmWith(res, ID, res)
    const exact = new CodexProvider().buildSpawnCommand({ ...opts, realmLaunch: { ...launch, sessionsDir }, resume: { uuid: ID, cwd: res }, codexHooks: { hookFile } })
    expect(exact.resumeId).toBe(ID)
    expect(exact.args.slice(0, 2)).toEqual(['resume', ID])
    expect(hookArgs(exact.args)).toEqual(hookArgs(direct.args))
    expect(exact.hooksInstalled).toBe(true)
  })

  it('round 1 (V2): the picker is told which conversations other tabs are on (ids only, bounded); Codex itself is not', () => {
    const res = resources()
    deployPicker(res)
    const picker = new CodexProvider().buildSpawnCommand({ ...opts, useResumePicker: true, codexOpenElsewhere: [ID, 'not-an-id', ID_B] })
    expect(picker.env[CODEX_OPEN_ELSEWHERE_ENV]).toBe(`${ID},${ID_B}`)
    const none = new CodexProvider().buildSpawnCommand({ ...opts, useResumePicker: true, codexOpenElsewhere: [] })
    expect(none.env[CODEX_OPEN_ELSEWHERE_ENV]).toBeUndefined()
    const direct = new CodexProvider().buildSpawnCommand({ ...opts, codexOpenElsewhere: [ID] })
    expect(direct.env[CODEX_OPEN_ELSEWHERE_ENV]).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('Windows, through the npm .cmd shim: a plain wrapper path passes cmd.exe; a path with a space gives no hooks, and the launch still starts', () => {
    const res = resources()
    const shim = 'C:\\npm\\codex.cmd'
    const plain = codexHookCommand(join(res, 'scripts'), 'win32', true)
    const out = new CodexProvider().buildSpawnCommand({ ...opts, realmLaunch: { ...launch, executable: shim }, codexHooks: { hookFile } })
    if (plain) {
      expect(out.hooksInstalled).toBe(true)
      expect(() => codexCmdExeTarget(shim, hookArgs(codexHookConfigArgs(plain)).flatMap((a) => ['-c', a]), launch.env)).not.toThrow()
    } else {
      expect(out.hooksInstalled).toBe(false)
    }
    expect(out.commandLine).toBeTruthy()
  })
})

// What a hook event runs is taken only when it is a plain file with one name
// (isPlainScriptFile): the forwarder, and on Windows the wrapper and the
// forwarder it starts from its own folder. Anything else there (a directory,
// a link, a hard link) is refused with a warning naming the file, and the
// launch starts without hooks. Mutation to prove this can fail: take the
// target whenever fs.statSync(target).isFile() holds (it follows a link,
// counts no other name, and on Windows reads the wrapper only).
describe('the hook command runs only plain files with one name', () => {
  const HOOK_REFUSED = /for the app's hooks is not a plain file with one name/
  /** How a stand-in reads, without following a link. */
  const standIn = (isFile: boolean, nlink: number) => ({ isFile: () => isFile, isSymbolicLink: () => !isFile, isDirectory: () => false, nlink, mode: isFile ? 0o100600 : 0o120777 })
  /** What a hook event runs, by platform: the forwarder, and on Windows the wrapper too. */
  const runs = (res: string): string[] => [join(res, 'scripts', 'ccc-codex-hook.js'), ...(process.platform === 'win32' ? [join(res, 'scripts', 'ccc-codex-hook.cmd')] : [])]
  afterEach(() => { delete (globalThis as any).__mockLstat })

  it('a directory holding index.js at the forwarder, beside a plain wrapper: no hooks, and one warning naming the file', () => {
    const res = resources(false)
    writeFileSync(join(res, 'scripts', 'ccc-codex-hook.cmd'), 'rem test copy', { mode: 0o600 })
    mkdirSync(join(res, 'scripts', 'ccc-codex-hook.js'))
    writeFileSync(join(res, 'scripts', 'ccc-codex-hook.js', 'index.js'), '// not the app\'s')
    const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    expect(out.hooksInstalled).toBe(false)
    expect(hookArgs(out.args)).toEqual([])
    expect(out.env[CODEX_HOOK_FILE_ENV]).toBeUndefined()
    const said = warns.filter((w) => HOOK_REFUSED.test(w))
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('ccc-codex-hook.js')
    // The launch check's own words (checkDeployedScript), since on macOS and
    // Linux a file that is not this user's, or that others may write to, is refused here too.
    expect(said[0]).toContain('is not a plain file with one name that only this user can change; this launch starts without hooks')
    expect(said[0]).not.toContain(res)
  })

  it('a file with another name (a hard link) at any of them: no hooks, and a warning naming it', () => {
    const res = resources(true)
    for (const p of runs(res)) {
      warns.length = 0
      ;(globalThis as any).__mockLstat = (q: unknown) => (q === p ? standIn(true, 2) : null)
      const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
      expect(out.hooksInstalled, basename(p)).toBe(false)
      expect(hookArgs(out.args)).toEqual([])
      expect(warns.filter((w) => HOOK_REFUSED.test(w) && w.includes(basename(p)))).toHaveLength(1)
    }
  })

  it('a link at any of them: no hooks, and a warning naming it', () => {
    const res = resources(true)
    for (const p of runs(res)) {
      warns.length = 0
      ;(globalThis as any).__mockLstat = (q: unknown) => (q === p ? standIn(false, 1) : null)
      const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
      expect(out.hooksInstalled, basename(p)).toBe(false)
      expect(warns.filter((w) => HOOK_REFUSED.test(w) && w.includes(basename(p)))).toHaveLength(1)
    }
  })

  it('plain files with one name: hooks, and nothing said; nothing deployed: no hooks, and nothing said either', () => {
    resources(true)
    expect(new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } }).hooksInstalled).toBe(true)
    resources(false)
    expect(new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } }).hooksInstalled).toBe(false)
    expect(warns.filter((w) => HOOK_REFUSED.test(w))).toEqual([])
  })

  it.runIf(process.platform === 'win32')('Windows: a plain wrapper with no forwarder beside it gives no hooks (the wrapper would start nothing of the app\'s)', () => {
    const res = resources(false)
    writeFileSync(join(res, 'scripts', 'ccc-codex-hook.cmd'), 'rem test copy', { mode: 0o600 })
    const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    expect(out.hooksInstalled).toBe(false)
    expect(warns.filter((w) => HOOK_REFUSED.test(w))).toEqual([])
  })
})

// The hooks run only from the scripts folder the start made the user's alone
// in this run (script-folders.ts): the forwarder and its wrapper run from
// there, and the npm shim route's plain-path copies are judged against its
// bytes. Mutation to prove this can fail: drop the folder check in
// buildCodexSpawnCommand.
describe('the hook command runs only from the scripts folder made the user\'s alone in this run', () => {
  const FOLDER_REFUSED = /the scripts folder in the resources folder (was not made this user's alone in this run|is not the folder made this user's alone in this run); this launch starts without hooks/

  it('the start never checked it: no hooks, nothing named, and one warning naming the folder, never its path', () => {
    const res = resources(true)
    __resetScriptFoldersForTests()
    const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    expect(out.hooksInstalled).toBe(false)
    expect(hookArgs(out.args)).toEqual([])
    expect(out.env[CODEX_HOOK_FILE_ENV]).toBeUndefined()
    const said = warns.filter((w) => FOLDER_REFUSED.test(w))
    expect(said).toHaveLength(1)
    expect(said[0]).not.toContain(res)
  })

  it('the owner-only rule refused it at start: no hooks, and one warning', async () => {
    const res = resources(true)
    await secureScriptFolders(res, async (dirs) => dirs.map((dir) => ({ dir, ok: false, detail: 'not owner-only' })))
    scriptFoldersDeployed()
    warns.length = 0
    const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    expect(out.hooksInstalled).toBe(false)
    expect(warns.filter((w) => FOLDER_REFUSED.test(w))).toHaveLength(1)
  })

  it('the rule passed it at start: hooks, and nothing said', async () => {
    const res = resources(true)
    await secureScriptFolders(res, async (dirs) => dirs.map((dir) => ({ dir, ok: true })))
    scriptFoldersDeployed()
    warns.length = 0
    expect(new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } }).hooksInstalled).toBe(true)
    expect(warns.filter((w) => FOLDER_REFUSED.test(w))).toEqual([])
  })

  // Nor when this run's deploy could not bring the forwarder, or on Windows
  // its wrapper, up to date (script-deploy.ts deployFailedThisRun). A source
  // that cannot be read (a folder) fails the deploy, as a copy that cannot be
  // replaced does. Mutations to prove this can fail: drop that check in
  // buildCodexSpawnCommand; check the forwarder only.
  const HOOK_STALE = (name: string) => `${name} for the app's hooks could not be brought up to date this run; this launch starts without hooks`
  it('the forwarder\'s deploy failed this run: no hooks, and one warning naming the file, never its path', () => {
    const res = resources(true)
    mkdirSync(join(res, 'a-folder.js'))
    expect(() => deployScriptFile(join(res, 'a-folder.js'), join(res, 'scripts', 'ccc-codex-hook.js'))).toThrow()
    warns.length = 0
    const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    expect(out.hooksInstalled).toBe(false)
    expect(hookArgs(out.args)).toEqual([])
    const said = warns.filter((w) => w.includes(HOOK_STALE('ccc-codex-hook.js')))
    expect(said).toHaveLength(1)
    expect(said[0]).not.toContain(res)
  })

  it.runIf(process.platform === 'win32')('the wrapper\'s deploy failed this run: no hooks, and one warning naming it', () => {
    const res = resources(true)
    mkdirSync(join(res, 'a-folder.cmd'))
    expect(() => deployScriptFile(join(res, 'a-folder.cmd'), join(res, 'scripts', 'ccc-codex-hook.cmd'))).toThrow()
    warns.length = 0
    const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    expect(out.hooksInstalled).toBe(false)
    expect(warns.filter((w) => w.includes(HOOK_STALE('ccc-codex-hook.cmd')))).toHaveLength(1)
  })

  it('another folder put at its path since the check: no hooks, and one warning', () => {
    const res = resources(true)
    renameSync(join(res, 'scripts'), join(res, 'scripts-checked'))
    mkdirSync(join(res, 'scripts'), { mode: 0o700 })
    writeFileSync(join(res, 'scripts', 'ccc-codex-hook.js'), '// test copy', { mode: 0o600 })
    writeFileSync(join(res, 'scripts', 'ccc-codex-hook.cmd'), 'rem test copy', { mode: 0o600 })
    const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    expect(out.hooksInstalled).toBe(false)
    expect(warns.filter((w) => FOLDER_REFUSED.test(w))).toHaveLength(1)
  })

  it.runIf(process.platform === 'win32')('the npm shim route: the staged plain-path copy is not run either while the scripts folder is not the user\'s alone', async (ctx) => {
    const res = resources(true, 'AI Code Conductor')
    const lad = tempDir()
    __setCodexLocalAppDataForTests(lad)
    if (!codexPlainWrapperDir(lad, res)) { ctx.skip(); return }
    const viaShim = () => new CodexProvider().buildSpawnCommand({ ...opts, realmLaunch: { ...launch, executable: 'C:\\npm\\codex.cmd' }, codexHooks: { hookFile } })
    expect(await new CodexProvider().prepareHookFolders(res, secureWith(true))).toBe(true)
    expect(viaShim().hooksInstalled).toBe(true)
    __resetScriptFoldersForTests()
    warns.length = 0
    expect(viaShim().hooksInstalled).toBe(false)
    expect(warns.filter((w) => FOLDER_REFUSED.test(w))).toHaveLength(1)
  })
})

describe('round 1 (V3): the npm shim route from a resources folder with a space', () => {
  it.runIf(process.platform === 'win32')('runs the plain-path copy under the local app data folder once staged and checked; a changed copy, none staged, or a spaced local app data folder gives no hooks; a direct launch keeps PowerShell\'s call', async (ctx) => {
    const res = resources(true, 'AI Code Conductor')
    const lad = tempDir()
    __setCodexLocalAppDataForTests(lad)
    const plainDir = codexPlainWrapperDir(lad, res)
    // Where this host's test folders have no plain-word path there is nothing to show.
    if (!plainDir) { ctx.skip(); return }
    const shim = 'C:\\npm\\codex.cmd'
    const viaShim = () => new CodexProvider().buildSpawnCommand({ ...opts, realmLaunch: { ...launch, executable: shim }, codexHooks: { hookFile } })
    // Not staged yet: no hooks, and the launch still starts.
    const before = viaShim()
    expect(before.hooksInstalled).toBe(false)
    expect(before.commandLine).toBeTruthy()
    expect(await new CodexProvider().prepareHookFolders(res, secureWith(true))).toBe(true)
    const out = viaShim()
    expect(out.hooksInstalled).toBe(true)
    const command = join(plainDir, 'ccc-codex-hook.cmd')
    expect(out.commandLine).toContain(`command='${command}'`)
    expect(out.commandLine).not.toContain('AI Code Conductor')
    expect(out.env[CODEX_HOOK_FILE_ENV]).toBe(hookFile)
    // A copy changed since it was staged is never run.
    writeFileSync(join(plainDir, 'ccc-codex-hook.cmd'), 'rem someone else')
    expect(viaShim().hooksInstalled).toBe(false)
    // A local app data folder whose path has a space: no plain copy, no hooks.
    __setCodexLocalAppDataForTests(join(lad, 'Riley Smith'))
    expect(viaShim().hooksInstalled).toBe(false)
    // A direct launch from the spaced resources folder is PowerShell's call of its own path, as before.
    const direct = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    expect(direct.hooksInstalled).toBe(true)
    expect(hookArgs(direct.args)).toEqual(hookArgs(codexHookConfigArgs(`& '${join(res, 'scripts', 'ccc-codex-hook.cmd')}'`)))
  })
})

describe('round 2 (R7): a plain-path copy that could not be made is said', () => {
  it.runIf(process.platform === 'win32')('the preparation logs it, and the shim route then has no hooks', async (ctx) => {
    const res = resources(true, 'AI Code Conductor')
    const lad = tempDir()
    __setCodexLocalAppDataForTests(lad)
    if (!codexPlainWrapperDir(lad, res)) { ctx.skip(); return }
    // The owner-only rule does not take: nothing staged, and it says so.
    await new CodexProvider().prepareHookFolders(res, secureWith(false))
    expect(warns.some((w) => /plain-path copy of the hook wrapper could not be made/.test(w))).toBe(true)
    const out = new CodexProvider().buildSpawnCommand({ ...opts, realmLaunch: { ...launch, executable: 'C:\\npm\\codex.cmd' }, codexHooks: { hookFile } })
    expect(out.hooksInstalled).toBe(false)
    // A local app data folder whose path is not a plain word: said too.
    warns.length = 0
    __resetCodexHookFoldersForTests()
    __setCodexLocalAppDataForTests(join(lad, 'Riley Smith'))
    await new CodexProvider().prepareHookFolders(res, secureWith(true))
    expect(warns.some((w) => /is not a plain word/.test(w))).toBe(true)
  })
})

// Round 4 (P1, P2): the hook folders are prepared asynchronously (only while
// Codex is on, src/main/codex-hook-folders.ts); a launch uses them only once
// prepared, and a folder the rule cannot make this user's alone means no hooks.
describe('round 4: hook folders that are not ready, or not this user\'s alone, give no hooks, and say so', () => {
  it('a launch before any preparation starts without hooks, said', () => {
    resources(true)
    expect(new CodexProvider().prepareSessionHooks('sess-1', 51234, '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60')).toBeNull()
    expect(warns.some((w) => /no hook folder for sess-1/.test(w))).toBe(true)
  })

  it('at the preparation and at a launch; once prepared, hooks and nothing said', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const res = resources(true)
    mkdirSync(join(res, 'codex-hooks'))
    expect(await new CodexProvider().prepareHookFolders(res, secureWith(false))).toBe(false)
    expect(warns.some((w) => /the hook folder in the data folder is not a real folder that this user alone owns/.test(w))).toBe(true)
    warns.length = 0
    expect(new CodexProvider().prepareSessionHooks('sess-1', 51234, '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60')).toBeNull()
    expect(warns.some((w) => /no hook folder for sess-1/.test(w))).toBe(true)
    // Round 5 (G3): within the retry wait the failure is the answer, and nothing more is said.
    warns.length = 0
    expect(await new CodexProvider().prepareHookFolders(res, secureWith(true))).toBe(false)
    expect(warns).toEqual([])
    // Past it, made the user's: hooks, and nothing said.
    vi.setSystemTime(Date.now() + CODEX_HOOK_FOLDERS_RETRY_MS)
    expect(await new CodexProvider().prepareHookFolders(res, secureWith(true))).toBe(true)
    vi.useRealTimers()
    const h = new CodexProvider().prepareSessionHooks('sess-1', 51234, '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60')
    expect(h).not.toBeNull()
    h?.dispose()
    expect(warns).toEqual([])
  })

  it('the deploy copies the scripts only: it makes no hook folder and prepares nothing', async () => {
    const res = resources(false)
    await new CodexProvider().deployResumePickerScript(res)
    expect(existsSync(join(res, 'codex-hooks'))).toBe(false)
    expect(new CodexProvider().prepareSessionHooks('sess-1', 51234, '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60')).toBeNull()
  })
})

describe("the test's own log folder", () => {
  it("[host] the real logger keeps its log inside the test's own folder", async () => {
    const { getLogDir } = await import('../../../../src/main/debug-logger')
    expect(getLogDir()).toBe(join(TEST_DATA, 'debug'))
  })
})
