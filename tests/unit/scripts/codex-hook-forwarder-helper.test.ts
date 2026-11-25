// 2.1.3-beta.18, plan section 5 (ADR-030 S12, aicc_planning#433): the Codex
// hook forwarder (scripts/ccc-codex-hook.js) of a session the session helper
// holds runs the helper's hook mode named in its environment, with the event
// on its standard input, and posts nothing. Codex keys the trust it records
// on the hook command's text, so the command stays the same for every
// session; the forwarder chooses. It trusts the named program no more than
// the hook file (plan review finding 10): it runs it only when its real path
// is this user's helper copy as the app lays it out (no link at any level
// the app made, one plain file with one name), the store is that helper
// folder's own and the session of the helper's shape; anything else, or only
// some of the three variables named, does nothing at all.
//
// Host-safe: plain folders and files in this test's own temp folder, never a
// link. A link at a level the app made is stood in for by `fsx`, the file
// system the forwarder is handed (its real path answered as a link would
// make it); the real-link counterparts of the hook file's checks are in the
// quarantined tests/unit/scripts/codex-hook-forwarder.test.ts. Nothing is
// started: the spawn is a stand-in.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, lstatSync } from 'fs'
import * as fs from 'fs'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { HOOK_MODE_ENV, SID_RE, HELPER_FOLDER_RE } from '../../../src/main/session-helper/protocol'
import { HELPER_EXE_NAME } from '../../../src/main/session-helper/install'

type Helper = { exe: string }
type Fsx = { realpathSync: { native: (p: string) => string }; lstatSync: (p: string, o: { bigint: true }) => fs.BigIntStats }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fwd = require('../../../scripts/ccc-codex-hook.js') as {
  readHelper: (env: Record<string, string | undefined>, platform?: NodeJS.Platform, fsx?: Fsx) => Helper | null | false
  runHook: (helper: Helper, body: Buffer, done: () => void, spawnFn?: unknown) => void
  chooseRoute: (env: Record<string, string | undefined>, platform?: NodeJS.Platform, fsx?: Fsx) => { hook: Helper } | { post: { port: number; sid: string; token: string } } | null
  HELPER_ENV: { helper: string; store: string; session: string }
  HELPER_TIMEOUT_MS: number
}

const SID = 'ag0123456789abcdef0123456789abcd'
const TOKEN = '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60'
const TEST_PREFIX = 's5-fwd-helper-'
const EXE = HELPER_EXE_NAME(process.platform)
const made: string[] = []

/** A fresh folder of this test's own, as the folder the app's helper folder is in. */
function above(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), TEST_PREFIX)))
  made.push(d)
  return d
}
/** The helper copy as the app lays it out: `<above>/<root>/<version>/<exe>`, and the store beside the version folder. */
function layout(rootName = 'helper', folder = '0.1.0-0123456789ab', at = above()): { exe: string; store: string; root: string; at: string } {
  const root = join(at, rootName)
  const exe = join(root, folder, EXE)
  mkdirSync(dirname(exe), { recursive: true })
  writeFileSync(exe, 'MZ the helper copy')
  mkdirSync(join(root, 'store'), { recursive: true })
  return { exe, store: join(root, 'store'), root, at }
}
const heldEnv = (l: { exe: string; store: string }, over: Record<string, string | undefined> = {}) => ({ AICC_HELPER_PATH: l.exe, AICC_HELPER_STORE: l.store, AICC_HELPER_SESSION: SID, ...over })

afterEach(() => {
  vi.useRealTimers()
  // TEST CLEANUP GUARD: only the folders this test made, by their own prefix, under the temp folder.
  for (const d of made.splice(0)) {
    if (!basename(d).startsWith(TEST_PREFIX) || dirname(d) !== realpathSync.native(tmpdir())) continue
    rmSync(d, { recursive: true, force: true })
  }
})

describe('the hook mode a held session names (readHelper)', () => {
  it('names the same three variables the session helper gives a held launch, and reads the shapes the helper has', () => {
    expect(fwd.HELPER_ENV).toEqual(HOOK_MODE_ENV)
    // Its own copies of the shapes agree with the app's (protocol.ts SID_RE, HELPER_FOLDER_RE), case by case.
    const l = layout()
    for (const id of [SID, 'ab345678', 'A_b-1234567890123456789012345678', 'ab34567', '_b345678', 'ab3456789012345678901234567890123', 'ab3456.8']) {
      expect(fwd.readHelper(heldEnv(l, { AICC_HELPER_SESSION: id })) !== false, id).toBe(SID_RE.test(id))
    }
    for (const folder of ['0.1.0-0123456789ab', '2.1.3-beta.18-0123456789ab', '0.1.0-0123456789AB', '0.1-0123456789ab', '0.1.0-0123456789a']) {
      const at = layout('helper', folder)
      expect(fwd.readHelper(heldEnv(at)) !== false, folder).toBe(HELPER_FOLDER_RE.test(folder))
    }
  })

  it('not held (none of the three named): null, so the hook file\'s route goes on as before', () => {
    expect(fwd.readHelper({})).toBeNull()
    expect(fwd.readHelper({ CCC_CODEX_HOOK_FILE: 'x', CLAUDE_MULTI_SESSION_ID: 's' })).toBeNull()
  })

  it('this user\'s helper copy as the app lays it out, its store and a session of the helper\'s shape: run', () => {
    const l = layout()
    expect(fwd.readHelper(heldEnv(l))).toEqual({ exe: l.exe })
    // A dev run's helper folder (`helper/dev`) too.
    const dev = layout('dev', '0.1.0-0123456789ab', join(above(), 'helper'))
    expect(fwd.readHelper(heldEnv(dev))).toEqual({ exe: dev.exe })
  })

  it('only some of the three named, or a session of another shape: false (nothing is done, nothing posted)', () => {
    const l = layout()
    expect(fwd.readHelper({ AICC_HELPER_PATH: l.exe })).toBe(false)
    expect(fwd.readHelper({ AICC_HELPER_STORE: l.store, AICC_HELPER_SESSION: SID })).toBe(false)
    expect(fwd.readHelper(heldEnv(l, { AICC_HELPER_SESSION: '' }))).toBe(false)
    for (const bad of ['short', '-ag0123456789', 'ag0123456789abcdef0123456789abcdef0', 'ag01234567\n89abcdef', '../../x1234567']) {
      expect(fwd.readHelper(heldEnv(l, { AICC_HELPER_SESSION: bad })), bad).toBe(false)
    }
  })

  it('a helper path outside the app\'s helper folder is not run: another name, no version folder, another folder\'s, a relative path, a store that is not its own, a file that is not there or not a file', () => {
    const l = layout()
    const no = (env: Record<string, string | undefined>, what: string) => expect(fwd.readHelper(env), what).toBe(false)
    // Another program in the version folder.
    const other = join(dirname(l.exe), process.platform === 'win32' ? 'node.exe' : 'node')
    writeFileSync(other, 'MZ another program')
    no(heldEnv(l, { AICC_HELPER_PATH: other }), 'another name')
    // The helper's name, outside a version folder.
    const loose = join(l.root, EXE)
    writeFileSync(loose, 'MZ a loose copy')
    no(heldEnv(l, { AICC_HELPER_PATH: loose }), 'no version folder')
    // A version folder of another shape.
    const odd = layout('helper', 'latest', l.at)
    no(heldEnv(odd), 'a version folder of another shape')
    // A copy in a folder that is not the helper folder (named otherwise), with its own store.
    const stray = layout('elsewhere')
    no(heldEnv(stray), 'not the helper folder')
    // Relative.
    no(heldEnv(l, { AICC_HELPER_PATH: join('helper', '0.1.0-0123456789ab', EXE) }), 'a relative path')
    // A store that is not the helper folder's own.
    no(heldEnv(l, { AICC_HELPER_STORE: stray.store }), 'another helper folder\'s store')
    no(heldEnv(l, { AICC_HELPER_STORE: join(l.root, 'store', 'deeper') }), 'a folder inside its store')
    no(heldEnv(l, { AICC_HELPER_STORE: 'store' }), 'a relative store')
    // Not there, or a folder of the helper's name.
    no(heldEnv(layoutMissing()), 'not there')
    const dirAt = join(l.root, '0.2.0-0123456789ab', EXE)
    mkdirSync(dirAt, { recursive: true })
    no(heldEnv(l, { AICC_HELPER_PATH: dirAt }), 'a folder')
    // A control character.
    no(heldEnv(l, { AICC_HELPER_PATH: `${l.exe}\n` }), 'a control character')
  })

  it('a helper copy reached through a link at any level the app made is not run, nor one with more than one name', () => {
    const l = layout()
    const realFs: Fsx = { realpathSync: { native: (p: string) => realpathSync.native(p) }, lstatSync: (p, o) => lstatSync(p, o) }
    expect(fwd.readHelper(heldEnv(l), undefined, realFs)).toEqual({ exe: l.exe })
    // The version folder a junction to another folder: the copy's real path is not the path below the helper folder's.
    const elsewhere = join(above(), 'planted', '0.1.0-0123456789ab', EXE)
    const viaLink = (from: string, to: string): Fsx => ({ ...realFs, realpathSync: { native: (p: string) => (p === from ? to : realpathSync.native(p)) } })
    expect(fwd.readHelper(heldEnv(l), undefined, viaLink(l.exe, elsewhere))).toBe(false)
    // The helper folder itself a link (to a helper folder elsewhere, of the same name).
    expect(fwd.readHelper(heldEnv(l), undefined, viaLink(l.exe, join(dirname(elsewhere), '..', '..', 'helper', '0.1.0-0123456789ab', EXE)))).toBe(false)
    // The program a link to itself (its real path the same, the entry a link).
    const asLink: Fsx = { ...realFs, lstatSync: (p, o) => Object.assign(Object.create(Object.getPrototypeOf(lstatSync(p, o))), lstatSync(p, o), { isSymbolicLink: () => true }) }
    expect(fwd.readHelper(heldEnv(l), undefined, asLink)).toBe(false)
    // A hard link: two names.
    const twoNames: Fsx = { ...realFs, lstatSync: (p, o) => Object.assign(Object.create(Object.getPrototypeOf(lstatSync(p, o))), lstatSync(p, o), { nlink: 2n }) }
    expect(fwd.readHelper(heldEnv(l), undefined, twoNames)).toBe(false)
    // A real path that cannot be read.
    const unreadable: Fsx = { ...realFs, realpathSync: { native: () => { throw new Error('EACCES') } } }
    expect(fwd.readHelper(heldEnv(l), undefined, unreadable)).toBe(false)
  })
})

/** A layout whose program is not there. */
function layoutMissing(): { exe: string; store: string } {
  const l = layout()
  rmSync(l.exe, { force: true })
  return l
}

/** A hook file laid out as the app makes it (no link), for the gateway's route. */
function hookFile(sid = 'sess-1'): string {
  const dir = join(above(), 'codex-hooks', 'ccc-codex-hook-abc123')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'hook.json')
  writeFileSync(file, JSON.stringify({ v: 1, port: 51234, sid, token: TOKEN }))
  return file
}

describe('where an event goes (chooseRoute)', () => {
  it('a held session: its hook mode, never the gateway, even with a good hook file beside it', () => {
    const l = layout()
    const env = { ...heldEnv(l), CCC_CODEX_HOOK_FILE: hookFile(), CLAUDE_MULTI_SESSION_ID: 'sess-1' }
    expect(fwd.chooseRoute(env)).toEqual({ hook: { exe: l.exe } })
  })

  it('the three named and not all checked: nowhere, the hook file beside them not used either', () => {
    const l = layout()
    const file = hookFile()
    expect(fwd.chooseRoute({ ...heldEnv(l, { AICC_HELPER_SESSION: 'bad' }), CCC_CODEX_HOOK_FILE: file, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
    expect(fwd.chooseRoute({ AICC_HELPER_PATH: l.exe, CCC_CODEX_HOOK_FILE: file, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
  })

  it('not held: the gateway, by the hook file, as before', () => {
    const file = hookFile()
    expect(fwd.chooseRoute({ CCC_CODEX_HOOK_FILE: file, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toEqual({ post: { port: 51234, sid: 'sess-1', token: TOKEN } })
    expect(fwd.chooseRoute({})).toBeNull()
  })
})

/** A stand-in child: its stdin, and what it was started with. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; kill: () => void; killed: number }
  child.stdin = new PassThrough()
  child.killed = 0
  child.kill = () => { child.killed++ }
  return child
}

describe('running the hook mode (runHook)', () => {
  it('`<helper> hook` with no shell, no window and its output not read; the event on its standard input, whole; done once, when it exits', async () => {
    const child = fakeChild()
    const calls: Array<[string, string[], Record<string, unknown>]> = []
    const got: Buffer[] = []
    child.stdin.on('data', (c: Buffer) => got.push(c))
    const ended = new Promise<void>((r) => child.stdin.on('finish', () => r()))
    const done = vi.fn()
    const body = Buffer.from(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }))
    fwd.runHook({ exe: 'C:\\h\\0.1.0-0123456789ab\\aicc-helper.exe' }, body, done, (file: string, args: string[], opts: Record<string, unknown>) => { calls.push([file, args, opts]); return child })
    await ended
    expect(calls).toEqual([['C:\\h\\0.1.0-0123456789ab\\aicc-helper.exe', ['hook'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, shell: false }]])
    expect(Buffer.concat(got).equals(body)).toBe(true)
    expect(done).not.toHaveBeenCalled()
    child.emit('exit', 0)
    child.emit('error', new Error('late'))
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('a program that cannot start: done once (an error, or a spawn that throws)', () => {
    const child = fakeChild()
    const done = vi.fn()
    fwd.runHook({ exe: '/x/helper/0.1.0-0123456789ab/aicc-helper' }, Buffer.from('{}'), done, () => child)
    child.emit('error', new Error('ENOENT'))
    child.emit('exit', null)
    expect(done).toHaveBeenCalledTimes(1)
    const done2 = vi.fn()
    fwd.runHook({ exe: '/x/helper/0.1.0-0123456789ab/aicc-helper' }, Buffer.from('{}'), done2, () => { throw new Error('EACCES') })
    expect(done2).toHaveBeenCalledTimes(1)
  })

  it('one that does not end: stopped, and done once, after HELPER_TIMEOUT_MS (within the forwarder\'s own deadline)', () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const done = vi.fn()
    fwd.runHook({ exe: '/x/helper/0.1.0-0123456789ab/aicc-helper' }, Buffer.from('{}'), done, () => child)
    vi.advanceTimersByTime(fwd.HELPER_TIMEOUT_MS - 1)
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(child.killed).toBe(1)
    expect(done).toHaveBeenCalledTimes(1)
    child.emit('exit', null)
    expect(done).toHaveBeenCalledTimes(1)
    expect(fwd.HELPER_TIMEOUT_MS).toBeLessThan(4000)
  })
})
