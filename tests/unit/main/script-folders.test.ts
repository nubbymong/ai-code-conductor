// script-folders.ts: the resources folder's scripts folders (scripts and
// scripts/lib), where the scripts the app's sessions run are
// deployed. Once a run, before the deploys, both go through the owner-only
// rule (asked once more for a folder it gave no read of; a folder passes only
// when it is the same folder after the answer as before the ask, and the lib
// folder only inside a scripts folder that passed); a launch takes a deployed
// script only once this run's deploys ran,
// only from a folder the rule passed in this run that is still that same
// folder and a real one, and only when the script is a plain file with one
// name. Otherwise it is refused, and the reason names the file or the folder
// by name, never a path. A folder the rule refuses, or a rule that fails, is
// said once at start, by the folder's name.
//
// [host] The rule is a stand-in (nothing is made owner-only, no process
// starts); the folders and files are real ones in a fresh temp folder, made
// with this user's modes (folders 0700, files 0600) whatever the runner's
// umask, and a link is read through a stubbed lstat (no link is made on this
// machine).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import nodeFs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const warned = vi.hoisted(() => [] as string[])
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: () => {},
  logError: () => {},
  logWarn: (...a: unknown[]) => { warned.push(a.map(String).join(' ')) },
}))

import {
  secureScriptFolders, scriptFoldersDeployed, scriptFoldersPending, awaitScriptFolders, scriptFolderRefusal,
  checkDeployedScript, __resetScriptFoldersForTests, SCRIPT_FOLDERS_LAUNCH_WAIT_MS,
} from '../../../src/main/script-folders'
import type { SecureScriptFolders } from '../../../src/main/script-folders'
import { deployScriptFile } from '../../../src/main/script-deploy'

const PREFIX = 'ccc-script-folders-'
/** A helper lib's name, as one deployed in the lib folder. */
const LIB_FILE = 'picker-lib.js'
let res = ''
let scripts = ''
let lib = ''
/** The paths the stub reads as a link (without following one). Their identity (volume and file
 *  id, the bigint read) stays the real one, so only the real-folder test can refuse them. */
let readsAsLink = new Set<string>()

/** The rule, answered: each folder made when missing (as the real rule does), `ok` per folder. */
function rule(ok: (dir: string) => boolean, detail = 'not owner-only'): SecureScriptFolders & { calls: string[][] } {
  const calls: string[][] = []
  const f = (async (dirs: readonly string[]) => {
    calls.push([...dirs])
    return dirs.map((dir) => {
      try { nodeFs.mkdirSync(dir, { mode: 0o700 }) } catch { /* there already */ }
      return ok(dir) ? { dir, ok: true, detail: 'owner-only' } : { dir, ok: false, detail }
    })
  }) as SecureScriptFolders & { calls: string[][] }
  f.calls = calls
  return f
}
const passAll = () => rule(() => true)

beforeEach(() => {
  res = nodeFs.realpathSync.native(nodeFs.mkdtempSync(join(tmpdir(), PREFIX)))
  scripts = join(res, 'scripts')
  lib = join(scripts, 'lib')
  readsAsLink = new Set()
  warned.length = 0
  __resetScriptFoldersForTests()
  const realLstat = nodeFs.lstatSync.bind(nodeFs)
  vi.spyOn(nodeFs, 'lstatSync').mockImplementation(((p: nodeFs.PathLike, o?: nodeFs.StatSyncOptions) => {
    if (readsAsLink.has(String(p)) && (o as { bigint?: boolean } | undefined)?.bigint !== true) {
      return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true, nlink: 1, mode: 0o120777 } as unknown as nodeFs.Stats
    }
    return realLstat(p, o as never)
  }) as typeof nodeFs.lstatSync)
  syncBuiltinESMExports()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  __resetScriptFoldersForTests()
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (res.startsWith(join(nodeFs.realpathSync.native(tmpdir()), PREFIX))) nodeFs.rmSync(res, { recursive: true, force: true })
})

/** The start, as index.ts runs it: the rule, then the deploys (here, one file), then the launches let go. */
async function start(secure: SecureScriptFolders, deploy: () => void = () => {}): Promise<void> {
  await secureScriptFolders(res, secure)
  deploy()
  scriptFoldersDeployed()
}
const plain = (p: string, text = '// the app\'s\n'): string => { nodeFs.writeFileSync(p, text, { mode: 0o600 }); return p }

describe('the start: the scripts folders through the owner-only rule, before the deploys', () => {
  it('the rule is asked once, for the scripts folder and then its lib folder, inside the resources folder', async () => {
    const r = passAll()
    await start(r)
    expect(r.calls).toEqual([[scripts, lib]])
    expect(warned).toEqual([])
  })

  it('both passed and the deploys ran: a plain script in either may be run', async () => {
    await start(passAll(), () => { plain(join(scripts, 'resume-picker.js')); plain(join(lib, LIB_FILE)) })
    expect(checkDeployedScript(join(scripts, 'resume-picker.js'))).toEqual({ ok: true })
    expect(checkDeployedScript(join(lib, LIB_FILE))).toEqual({ ok: true })
    expect(scriptFolderRefusal(scripts)).toBeNull()
    expect(scriptFolderRefusal(lib)).toBeNull()
  })

  // Mutation to prove this can fail: count a folder the rule refused as passed.
  it('the scripts folder refused: nothing in it may be run, and one warning names it and what is not used, never its path', async () => {
    await start(rule((d) => d !== scripts, 'the folder\'s own rights could not be made owner-only'), () => plain(join(scripts, 'resume-picker.js')))
    expect(checkDeployedScript(join(scripts, 'resume-picker.js'))).toEqual({ ok: false, absent: false, why: "the scripts folder in the resources folder was not made this user's alone in this run" })
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain("the scripts folder in the resources folder could not be made this user's alone")
    expect(warned[0]).toContain("the app's status line, the resume lists and the hook scripts deployed there are not used this run")
    expect(warned[0]).toContain('could not be made owner-only')
    expect(warned[0]).not.toContain(res)
  })

  it('only the lib folder refused: the scripts folder\'s scripts may be run, the lib\'s may not, and one warning says the resume list that loads it is not used', async () => {
    await start(rule((d) => d !== lib), () => { plain(join(scripts, 'resume-picker.js')); plain(join(lib, LIB_FILE)) })
    expect(checkDeployedScript(join(scripts, 'resume-picker.js'))).toEqual({ ok: true })
    expect(checkDeployedScript(join(lib, LIB_FILE))).toMatchObject({ ok: false, absent: false })
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('the lib folder in the resources folder')
    expect(warned[0]).toContain('the resume list that loads its helper is not used this run')
  })

  it('a rule that fails (it rejects): never throws, nothing may be run, and one warning', async () => {
    await expect(start(async () => { throw new Error('the rights could not be set or read (a test)') }, () => plain(join(res, 'scripts-made-anyway.js')))).resolves.toBeUndefined()
    nodeFs.mkdirSync(scripts, { mode: 0o700 })
    plain(join(scripts, 'resume-picker.js'))
    expect(checkDeployedScript(join(scripts, 'resume-picker.js'))).toMatchObject({ ok: false, absent: false })
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('the rights could not be set or read (a test)')
  })

  it('an answer that leaves a folder out: that folder is asked once more, then refused', async () => {
    const calls: string[][] = []
    await start(async (dirs) => { calls.push([...dirs]); for (const d of dirs) nodeFs.mkdirSync(d, { recursive: true, mode: 0o700 }); return [{ dir: scripts, ok: true }] })
    expect(calls).toEqual([[scripts, lib], [lib]])
    expect(scriptFolderRefusal(scripts)).toBeNull()
    expect(scriptFolderRefusal(lib)).toBe("was not made this user's alone in this run")
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('no answer')
  })

  // As the sign-in folders' check does (account-profiles.ts askRule and
  // passed): each folder's identity is read before the rule is asked, and the
  // folder recorded is the one the rule was asked about. Mutation to prove
  // this can fail: read the identity after the answer only.
  it('another folder put at the scripts folder\'s path while the rule ran: refused, with one warning', async () => {
    nodeFs.mkdirSync(lib, { recursive: true, mode: 0o700 })
    await start(async (dirs) => {
      nodeFs.renameSync(scripts, join(res, 'scripts-checked'))
      nodeFs.mkdirSync(lib, { recursive: true, mode: 0o700 })
      return dirs.map((dir) => ({ dir, ok: true, detail: 'owner-only' }))
    }, () => plain(join(scripts, 'resume-picker.js')))
    expect(scriptFolderRefusal(scripts)).toBe("was not made this user's alone in this run")
    expect(scriptFolderRefusal(lib)).toBe("was not made this user's alone in this run")
    expect(checkDeployedScript(join(scripts, 'resume-picker.js'))).toMatchObject({ ok: false, absent: false })
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain("the scripts folder in the resources folder could not be made this user's alone")
    expect(warned[0]).toContain('another folder took its place while it was checked')
  })

  // A cold Windows PowerShell can run past its bound once (the sign-in
  // folders ask once more for this, checkHomesAnswering): no read is not a
  // refusal. Mutation to prove this can fail: drop the second ask.
  it('no read of either folder the first time: asked once more, as one call, scripts first, and the second answer counts', async () => {
    const calls: string[][] = []
    await start(async (dirs) => {
      calls.push([...dirs])
      for (const d of dirs) nodeFs.mkdirSync(d, { recursive: true, mode: 0o700 })
      return calls.length === 1
        ? dirs.map((dir) => ({ dir, ok: false, detail: 'Windows PowerShell ran past its time limit', unread: true as const }))
        : dirs.map((dir) => ({ dir, ok: true, detail: 'owner-only' }))
    }, () => plain(join(scripts, 'resume-picker.js')))
    expect(calls).toEqual([[scripts, lib], [scripts, lib]])
    expect(scriptFolderRefusal(scripts)).toBeNull()
    expect(scriptFolderRefusal(lib)).toBeNull()
    expect(checkDeployedScript(join(scripts, 'resume-picker.js'))).toEqual({ ok: true })
    expect(warned).toEqual([])
  })

  it('a call that rejects the first time: asked once more, and the second answer counts', async () => {
    let n = 0
    await start(async (dirs) => {
      if (++n === 1) throw new Error('the call could not start (a test)')
      for (const d of dirs) nodeFs.mkdirSync(d, { recursive: true, mode: 0o700 })
      return dirs.map((dir) => ({ dir, ok: true }))
    })
    expect(n).toBe(2)
    expect(scriptFolderRefusal(scripts)).toBeNull()
    expect(scriptFolderRefusal(lib)).toBeNull()
    expect(warned).toEqual([])
  })

  it('no read of the lib folder alone: only it is asked again', async () => {
    const calls: string[][] = []
    await start(async (dirs) => {
      calls.push([...dirs])
      for (const d of dirs) nodeFs.mkdirSync(d, { recursive: true, mode: 0o700 })
      return dirs.map((dir) => (calls.length === 1 && dir === lib ? { dir, ok: false, detail: 'no read', unread: true as const } : { dir, ok: true }))
    })
    expect(calls).toEqual([[scripts, lib], [lib]])
    expect(scriptFolderRefusal(lib)).toBeNull()
    expect(warned).toEqual([])
  })

  it('no read the second time too: refused, by the second call\'s reason, in one warning', async () => {
    const calls: string[][] = []
    await start(async (dirs) => {
      calls.push([...dirs])
      return dirs.map((dir) => ({ dir, ok: false, detail: `no read in call ${calls.length}`, unread: true as const }))
    })
    expect(calls).toHaveLength(2)
    expect(scriptFolderRefusal(scripts)).toBe("was not made this user's alone in this run")
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('no read in call 2')
  })

  // The lib folder is only as safe as the scripts folder it is in, and on
  // Windows the rule refuses it with its parent. Mutation to prove this can
  // fail: pass the lib folder on its own answer.
  it('the scripts folder refused and the lib folder\'s own answer a pass: the lib folder is not passed, not said again, and nothing read is asked again', async () => {
    const r = rule((d) => d === lib)
    await start(r, () => plain(join(lib, LIB_FILE)))
    expect(r.calls).toEqual([[scripts, lib]])
    expect(scriptFolderRefusal(lib)).toBe("was not made this user's alone in this run")
    expect(checkDeployedScript(join(lib, LIB_FILE))).toMatchObject({ ok: false, absent: false })
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('the scripts folder in the resources folder')
  })

  it('both refused (the lib folder as its parent was): one warning, for the scripts folder', async () => {
    await start(async (dirs) => {
      for (const d of dirs) nodeFs.mkdirSync(d, { recursive: true, mode: 0o700 })
      return [{ dir: scripts, ok: false, detail: 'not owner-only' }, { dir: lib, ok: false, detail: 'its parent was refused' }]
    })
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('the scripts folder in the resources folder')
    expect(warned[0]).not.toContain('its parent was refused')
  })

  it('a resources folder that is not an absolute path: the rule is never asked, and one warning', async () => {
    const r = passAll()
    await secureScriptFolders('relative-res', r)
    scriptFoldersDeployed()
    expect(r.calls).toEqual([])
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('the resources folder is not an absolute path')
  })

  // The rule makes a missing folder only inside a parent that is there.
  // Mutation to prove this can fail: drop the making of the resources folder.
  it('a resources folder not there yet (a first start): it is made first, and both folders pass', async () => {
    const fresh = join(res, 'fresh-res')
    await secureScriptFolders(fresh, passAll())
    scriptFoldersDeployed()
    expect(scriptFolderRefusal(join(fresh, 'scripts'))).toBeNull()
    expect(scriptFolderRefusal(join(fresh, 'scripts', 'lib'))).toBeNull()
    expect(warned).toEqual([])
  })

  // Node's fs messages carry the full path ("EACCES: permission denied, chmod
  // '<path>'"), and so can the rule's reason on any system; the warning names
  // a folder by its name only. Mutation to prove this can fail: put the
  // reason in the warning as it is.
  it('a reason that carries the folder\'s path: the warning has its name, never a path', async () => {
    await start(rule((d) => d !== scripts, `EACCES: permission denied, chmod '${scripts}'`))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain("EACCES: permission denied, chmod 'scripts'")
    expect(warned[0]).not.toContain(res)
  })

  it('a call that rejects with another path in its message, quoted or not: the warning carries no path', async () => {
    const elsewhere = join(tmpdir(), 'ccc-elsewhere', 'lib')
    await start(async () => { throw new Error(`ENOENT: no such file or directory, lstat '${elsewhere}' (also at ${elsewhere})`) })
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain("lstat 'lib' (also at lib)")
    expect(warned[0]).not.toContain(tmpdir())
    expect(warned[0]).not.toContain('ccc-elsewhere')
  })

  it('a resources folder whose path has a space, named unquoted in the reason: it reads as the resources folder', async () => {
    const spaced = join(res, 'my res')
    await secureScriptFolders(spaced, async (dirs) => dirs.map((dir) => ({ dir, ok: false, detail: `cannot write ${dir} now` })))
    scriptFoldersDeployed()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('cannot write the resources folder')
    expect(warned[0]).not.toContain(res)
    expect(warned[0]).not.toContain('my res')
  })

  // A folder's name can hold a space, so an unquoted path in the reason does
  // not end at the first space: all of it up to its last separator goes, and
  // the folder or file is named by its name only. Mutation to prove this can
  // fail: end an unquoted path at the first space.
  it.each([
    ['drive path', 'Access to the path C:\\Users\\Jo Smith\\AppData\\Roaming\\x is denied', 'Access to the path x is denied', ['Jo', 'Smith', 'AppData', 'Roaming', 'Users']],
    ['share path', '\\\\nas\\share\\My Stuff\\res\\scripts', 'scripts', ['nas', 'share', 'My Stuff', 'Stuff']],
    ['path from the root', '/home/jo/My Docs/res/scripts', 'scripts', ['home', 'jo', 'My Docs', 'Docs']],
    ['path ending with a separator, in brackets,', 'cannot open (C:\\Jo Smith\\Docs\\) now', 'cannot open (Docs) now', ['Jo', 'Smith']],
  ])('an unquoted %s holding a space: the warning names it by its last name only', async (_label, reason, shown, gone) => {
    await start(rule((d) => d !== scripts, reason))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain(`(${shown})`)
    for (const part of gone) expect(warned[0]).not.toContain(part)
    expect(warned[0]).not.toMatch(/[\\/]/)
  })

  it('a long reason from the rule is cut short in the warning', async () => {
    await start(rule(() => false, 'x'.repeat(5000)))
    for (const w of warned) expect(w.length).toBeLessThan(700)
  })
})

describe('a launch: only from a folder passed in this run that is still that same folder', () => {
  // Mutation to prove this can fail: give a launch the folder before the deploys ran.
  it('while the rule or the deploys still run, nothing may be run, and the reason says so', async () => {
    let answer: (v: Array<{ dir: string; ok: boolean }>) => void = () => {}
    const running = secureScriptFolders(res, (dirs) => new Promise((resolve) => { for (const d of dirs) nodeFs.mkdirSync(d, { mode: 0o700 }); answer = resolve }))
    expect(scriptFoldersPending()).toBe(true)
    expect(scriptFolderRefusal(scripts)).toBe('is still being checked')
    answer([{ dir: scripts, ok: true }, { dir: lib, ok: true }])
    await running
    plain(join(scripts, 'resume-picker.js'))
    expect(scriptFoldersPending()).toBe(true)
    expect(checkDeployedScript(join(scripts, 'resume-picker.js'))).toEqual({ ok: false, absent: false, why: 'the scripts folder in the resources folder is still being checked' })
    scriptFoldersDeployed()
    expect(scriptFoldersPending()).toBe(false)
    expect(checkDeployedScript(join(scripts, 'resume-picker.js'))).toEqual({ ok: true })
  })

  it('nothing started this run (a launch before the start, or a test): nothing may be run', () => {
    nodeFs.mkdirSync(scripts, { mode: 0o700 })
    plain(join(scripts, 'resume-picker.js'))
    expect(checkDeployedScript(join(scripts, 'resume-picker.js'))).toMatchObject({ ok: false, absent: false })
  })

  // Mutation to prove this can fail: drop the identity test.
  it('another folder put at the scripts folder\'s path since the check: nothing in it may be run', async () => {
    await start(passAll())
    nodeFs.renameSync(scripts, join(res, 'scripts-checked'))
    nodeFs.mkdirSync(scripts, { mode: 0o700 })
    plain(join(scripts, 'resume-picker.js'))
    expect(checkDeployedScript(join(scripts, 'resume-picker.js'))).toEqual({ ok: false, absent: false, why: "the scripts folder in the resources folder is not the folder made this user's alone in this run" })
  })

  // Mutation to prove this can fail: drop the real-folder test.
  it('the scripts folder read as a link since the check: nothing in it may be run', async () => {
    await start(passAll(), () => plain(join(scripts, 'resume-picker.js')))
    readsAsLink.add(scripts)
    expect(scriptFolderRefusal(scripts)).toBe("is not the folder made this user's alone in this run")
  })

  it('a folder of another resources folder (the setting changed since the start): refused', async () => {
    await start(passAll())
    const other = nodeFs.mkdtempSync(join(res, 'other-'))
    nodeFs.mkdirSync(join(other, 'scripts'), { mode: 0o700 })
    expect(scriptFolderRefusal(join(other, 'scripts'))).toBe("was not made this user's alone in this run")
  })

  it('what sits at the script path: nothing there is absent (said nowhere); a directory holding index.js, or a link, is refused by the file\'s name', async () => {
    await start(passAll())
    const picker = join(scripts, 'resume-picker.js')
    expect(checkDeployedScript(picker)).toEqual({ ok: false, absent: true })
    nodeFs.mkdirSync(picker)
    plain(join(picker, 'index.js'))
    const dirCheck = checkDeployedScript(picker)
    expect(dirCheck).toEqual({ ok: false, absent: false, why: 'resume-picker.js in the resources folder is not a plain file with one name that only this user can change' })
    nodeFs.rmSync(picker, { recursive: true })
    plain(picker)
    readsAsLink.add(picker)
    expect(checkDeployedScript(picker)).toMatchObject({ ok: false, absent: false })
    expect(JSON.stringify(dirCheck)).not.toContain(res)
  })

  // A plain script this run's deploy could not bring up to date
  // (script-deploy.ts deployFailedThisRun) is not run, in a folder that
  // passed. Mutation to prove this can fail: drop the deployFailedThisRun
  // check in checkDeployedScript.
  it('a plain script whose deploy failed this run: refused by the file\'s name; once a deploy lands, it may be run', async () => {
    const picker = join(scripts, 'resume-picker.js')
    const source = join(res, 'resume-picker-source.js')
    await start(passAll(), () => {
      plain(picker, '// an older copy\n')
      // A source that cannot be read (a folder) fails the deploy, as a copy that cannot be replaced does.
      nodeFs.mkdirSync(source)
      expect(() => deployScriptFile(source, picker)).toThrow()
    })
    const check = checkDeployedScript(picker)
    expect(check).toEqual({ ok: false, absent: false, why: 'resume-picker.js in the resources folder could not be brought up to date this run' })
    expect(JSON.stringify(check)).not.toContain(res)
    nodeFs.rmdirSync(source)
    plain(source, '// the app\'s\n')
    expect(deployScriptFile(source, picker)).toBe('written')
    expect(checkDeployedScript(picker)).toEqual({ ok: true })
  })
})

describe('awaitScriptFolders: a local launch waits for the start, bounded', () => {
  it('nothing started, or all done: at once', async () => {
    await expect(awaitScriptFolders(10)).resolves.toBeUndefined()
    await start(passAll())
    await expect(awaitScriptFolders(10)).resolves.toBeUndefined()
  })

  it('while the start still runs: it goes on when the deploys have run', async () => {
    await secureScriptFolders(res, passAll())
    let done = false
    const waiting = awaitScriptFolders(60_000).then(() => { done = true })
    await new Promise((r) => setTimeout(r, 20))
    expect(done).toBe(false)
    scriptFoldersDeployed()
    await waiting
    expect(done).toBe(true)
  })

  // Mutation to prove this can fail: wait without a bound.
  it('past the bound it goes on anyway (the launch then starts without the scripts)', async () => {
    vi.useFakeTimers()
    await secureScriptFolders(res, passAll())
    let done = false
    const waiting = awaitScriptFolders().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(SCRIPT_FOLDERS_LAUNCH_WAIT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await waiting
    expect(done).toBe(true)
    expect(SCRIPT_FOLDERS_LAUNCH_WAIT_MS).toBe(5000)
  })
})
