// Which project hooks a LOCAL session inherits (resolveInheritedHooks).
//
// Claude Code (the repo's tracked pin, 2.1.278; see
// src/main/git-local-settings-root.ts) takes project settings from
// <cwd>/.claude/settings.json and local settings from
// <cwd>/.claude/settings.local.json and, on POSIX, from the canonical git
// root's .claude/settings.local.json too (the checkout root for a session in a
// subfolder, the main checkout for a session in a linked worktree), when that
// root, its .git and its .claude are the user's. It reads no other ancestor
// folder. The app lifts exactly those files into the session's --settings
// file: never from the home folder or a folder above it (case-insensitively on
// Windows), and on POSIX only when each .claude folder and file belongs to the
// user, is not a link, is not writable by others, and is writable by its group
// only when it is the user's own per-user group (the primary group, with the
// same number as the user id).
//
// Only resolveInheritedHooks is called, so no settings file is written and no
// folder is hardened: account-profiles is mocked to make sure of it. The real
// files live in a fresh temp folder; the POSIX owner checks are simulated by
// overriding the uid, gid and mode lstat/stat/fstat report.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

vi.mock('../../../src/main/account-profiles', () => ({
  atomicWriteSecure: vi.fn(),
  mkdirSecure: vi.fn(),
  hardenCredentialDir: vi.fn(),
}))
vi.mock('../../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))

import { resolveInheritedHooks } from '../../../src/main/hooks/session-hooks-writer'
import { logWarn } from '../../../src/main/debug-logger'

const POSIX = process.platform !== 'win32'
const MARKER = 'other-folder-hook'

function cmdHook(command: string, matcher = '') {
  return { matcher, hooks: [{ type: 'command', command }] }
}

/** Write a settings file with the given hooks. On POSIX the folder is made
 *  0755 and the file 0644, whatever the umask. */
function writeSettings(claudeDir: string, hooks: unknown, file = 'settings.json'): string {
  fs.mkdirSync(claudeDir, { recursive: true })
  const p = path.join(claudeDir, file)
  fs.writeFileSync(p, JSON.stringify({ hooks }))
  if (POSIX) {
    fs.chmodSync(claudeDir, 0o755)
    fs.chmodSync(p, 0o644)
  }
  return p
}

const commands = (m: Record<string, unknown[]>, ev: string): string[] =>
  ((m[ev] ?? []) as Array<{ hooks: Array<{ command: string }> }>).map((e) => e.hooks[0].command)

let root = ''
let home = ''

beforeEach(() => {
  vi.mocked(logWarn).mockClear()
  // The real path: the checkout root is found from the real path of the
  // session folder, and the temp folder is itself reached through a link on
  // some hosts (macOS /var).
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-scope-')))
  home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (root && path.basename(root).startsWith('hooks-scope-')) fs.rmSync(root, { recursive: true, force: true })
})

describe('resolveInheritedHooks: the folders it reads', () => {
  // Mutation to prove this can fail: walk up from cwd to the nearest ancestor
  // holding a .claude settings file.
  it('a session folder outside the home folder inherits nothing from a folder above it', () => {
    const cwd = path.join(root, 'shared', 'work', 'proj')
    fs.mkdirSync(cwd, { recursive: true })
    writeSettings(path.join(root, 'shared', '.claude'), { Stop: [cmdHook(MARKER)] })
    writeSettings(path.join(root, 'shared', 'work', '.claude'), { Stop: [cmdHook(MARKER)] }, 'settings.local.json')
    expect(commands(resolveInheritedHooks(cwd, home), 'Stop')).toEqual([])
  })

  it('a session folder inside the home folder inherits nothing from a folder above it either', () => {
    const cwd = path.join(home, 'proj', 'packages', 'app')
    fs.mkdirSync(cwd, { recursive: true })
    writeSettings(path.join(home, 'proj', '.claude'), { Stop: [cmdHook(MARKER)] })
    expect(commands(resolveInheritedHooks(cwd, home), 'Stop')).toEqual([])
  })

  // Mutation to prove this can fail: drop the "home folder or above it" check.
  it('a session folder above the home folder reads no project hooks', () => {
    writeSettings(path.join(root, '.claude'), { Stop: [cmdHook(MARKER)] })
    expect(commands(resolveInheritedHooks(root, home), 'Stop')).toEqual([])
  })

  // The cases that need a real link (a folder reached through a link, a
  // settings file or .claude that is a link) are in
  // session-hooks-inherit-scope-links.test.ts, which runs on CI and the VM.

  it('a session folder that is the home folder reads the user settings once and no project files', () => {
    writeSettings(path.join(home, '.claude'), { Stop: [cmdHook('user.sh')] })
    writeSettings(path.join(home, '.claude'), { Stop: [cmdHook(MARKER)] }, 'settings.local.json')
    expect(commands(resolveInheritedHooks(home, home), 'Stop')).toEqual(['user.sh'])
  })

  it('the session folder\'s own .claude, outside the home folder: user, project, local, in order, duplicates dropped', () => {
    const cwd = path.join(root, 'elsewhere', 'proj')
    fs.mkdirSync(cwd, { recursive: true })
    writeSettings(path.join(home, '.claude'), { UserPromptSubmit: [cmdHook('user.sh')] })
    writeSettings(path.join(cwd, '.claude'), { UserPromptSubmit: [cmdHook('project.sh')], Stop: [cmdHook('same.sh')] })
    writeSettings(path.join(cwd, '.claude'), { UserPromptSubmit: [cmdHook('local.sh')], Stop: [cmdHook('same.sh')] }, 'settings.local.json')
    const inherited = resolveInheritedHooks(cwd, home)
    expect(commands(inherited, 'UserPromptSubmit')).toEqual(['user.sh', 'project.sh', 'local.sh'])
    expect(commands(inherited, 'Stop')).toEqual(['same.sh'])
  })

  it('the session folder\'s own .claude inside the home folder is read too', () => {
    const cwd = path.join(home, 'proj')
    fs.mkdirSync(cwd, { recursive: true })
    writeSettings(path.join(cwd, '.claude'), { Stop: [cmdHook('project.sh')] })
    expect(commands(resolveInheritedHooks(cwd, home), 'Stop')).toEqual(['project.sh'])
  })

  // Windows compares folders without regard to case. Mutation to prove this
  // can fail: compare the home folder with a case-sensitive string equality.
  it.runIf(!POSIX)('Windows: the home folder spelled in another case is still the home folder, and so is a folder above it', () => {
    writeSettings(path.join(home, '.claude'), { Stop: [cmdHook(MARKER)] }, 'settings.local.json')
    expect(commands(resolveInheritedHooks(home.toUpperCase(), home), 'Stop')).toEqual([])
    expect(commands(resolveInheritedHooks(home, home.toLowerCase()), 'Stop')).toEqual([])
    writeSettings(path.join(root, '.claude'), { Stop: [cmdHook(MARKER)] })
    expect(commands(resolveInheritedHooks(root.toUpperCase(), home), 'Stop')).toEqual([])
  })

  // A folder below a drive root reads its own .claude only, and a session at
  // the drive root above the profile reads none. Same drive as the profile
  // here (the next case covers another drive). No real drive is touched:
  // reads and real paths under the made-up Q: drive are answered here.
  it.runIf(!POSIX)('Windows: a folder below a drive root reads its own .claude only, never the drive root\'s', () => {
    const fakeHome = 'Q:\\Users\\alice'
    const driveRootFile = 'Q:\\.claude\\settings.json'
    const seen: string[] = []
    const realRead = fs.readFileSync
    const realRealpath = fs.realpathSync
    const onQ = (p: unknown): p is string => typeof p === 'string' && /^q:\\/i.test(p)
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (onQ(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return realRealpath(p, o as never)
    }) as typeof fs.realpathSync)
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (onQ(p)) {
        seen.push(p)
        if (p.toLowerCase() === driveRootFile.toLowerCase()) return Buffer.from(JSON.stringify({ hooks: { Stop: [cmdHook(MARKER)] } }))
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return realRead(p, o as never)
    }) as typeof fs.readFileSync)
    expect(commands(resolveInheritedHooks('Q:\\dev\\proj', fakeHome), 'Stop')).toEqual([])
    expect(seen.filter((p) => /\\\.claude\\settings(\.local)?\.json$/i.test(p) && !p.startsWith(fakeHome))).toEqual([
      'Q:\\dev\\proj\\.claude\\settings.json',
      'Q:\\dev\\proj\\.claude\\settings.local.json',
    ])
    seen.length = 0
    // A session at the drive root above the profile reads no project files.
    expect(commands(resolveInheritedHooks('Q:\\', fakeHome), 'Stop')).toEqual([])
    expect(seen.filter((p) => !p.toLowerCase().startsWith(fakeHome.toLowerCase()))).toEqual([])
  })

  // A session on another drive than the profile (a worktree on F: with the
  // profile on C:). path.relative answers an absolute path across drives, and
  // that is not "at or above the home folder". No real drive is touched: reads
  // under the made-up P: and Q: drives are answered here. Mutation to prove
  // this can fail: drop the path.isAbsolute(rel) branch of isAtOrAbove (every
  // session on another drive than the profile then loses its project hooks).
  it.runIf(!POSIX)('Windows: a session folder on another drive than the profile reads its own .claude, and only that', () => {
    const fakeHome = 'P:\\Users\\alice'
    const cwd = 'Q:\\dev\\proj'
    const answers: Record<string, string> = {
      'q:\\dev\\proj\\.claude\\settings.json': JSON.stringify({ hooks: { Stop: [cmdHook('project.sh')] } }),
      'q:\\dev\\proj\\.claude\\settings.local.json': JSON.stringify({ hooks: { Stop: [cmdHook('local.sh')] } }),
      'q:\\dev\\.claude\\settings.json': JSON.stringify({ hooks: { Stop: [cmdHook(MARKER)] } }),
      'q:\\.claude\\settings.json': JSON.stringify({ hooks: { Stop: [cmdHook(MARKER)] } }),
    }
    const onFakeDrive = (p: unknown): p is string => typeof p === 'string' && /^[pq]:\\/i.test(p)
    const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    const realRead = fs.readFileSync
    const realRealpath = fs.realpathSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (onFakeDrive(p)) {
        const content = answers[p.toLowerCase()]
        if (content === undefined) throw enoent(p)
        return Buffer.from(content)
      }
      return realRead(p, o as never)
    }) as typeof fs.readFileSync)
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (onFakeDrive(p)) throw enoent(p)
      return realRealpath(p, o as never)
    }) as typeof fs.realpathSync)
    expect(path.isAbsolute(path.relative(cwd, fakeHome))).toBe(true)
    expect(commands(resolveInheritedHooks(cwd, fakeHome), 'Stop')).toEqual(['project.sh', 'local.sh'])
  })

  // Claude Code on Windows has no user ids, and reads local settings from the
  // session folder only, never from a git root (see the localSettings note in
  // src/main/git-local-settings-root.ts). So a Windows session in a subfolder
  // or a linked worktree inherits its own folder's files and nothing from the
  // checkout root or the main checkout.
  it.runIf(!POSIX)('Windows: a session in a linked worktree or a checkout subfolder reads its own .claude only, never the checkout root\'s', () => {
    const main = path.join(root, 'srv', 'repo')
    fs.mkdirSync(path.join(main, '.git'), { recursive: true })
    writeSettings(path.join(main, '.claude'), { Stop: [cmdHook(MARKER)] }, 'settings.local.json')
    const wt = path.join(root, 'srv', 'wt')
    const gitdir = path.join(main, '.git', 'worktrees', 'wt')
    fs.mkdirSync(gitdir, { recursive: true })
    fs.mkdirSync(wt, { recursive: true })
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`)
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n')
    fs.writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(wt, '.git')}\n`)
    writeSettings(path.join(wt, '.claude'), { Stop: [cmdHook('wt-project')] })
    expect(commands(resolveInheritedHooks(wt, home), 'Stop')).toEqual(['wt-project'])
    const sub = path.join(main, 'packages', 'app')
    writeSettings(path.join(sub, '.claude'), { Stop: [cmdHook('sub-project')] })
    expect(commands(resolveInheritedHooks(sub, home), 'Stop')).toEqual(['sub-project'])
  })
})

describe('resolveInheritedHooks: the POSIX owner and mode checks', () => {
  const EUID = 4242
  /** The user's own per-user group: the primary group (process.getegid), with
   *  the same number as the user id, as useradd makes it on Ubuntu and the
   *  RHEL family. */
  const PER_USER_GID = EUID
  /** macOS's staff group: every account's primary group there. */
  const STAFF_GID = 20
  /** The primary group process.getegid reports: PER_USER_GID unless a case
   *  sets another. */
  let egid = PER_USER_GID
  /** A group other users are in too. */
  const SHARED_GID = 100
  type Meta = { uid?: number; gid?: number; mode?: number }
  let meta: Record<string, Meta> = {}
  let saved: { geteuid?: PropertyDescriptor; getegid?: PropertyDescriptor } | null = null
  /** The path each descriptor the code under test opened was opened at. */
  const fdPaths = new Map<number, string>()

  /** What logWarn was given, one call per line. */
  const warned = (): string => vi.mocked(logWarn).mock.calls.map((c) => c.join(' ')).join('\n')

  /** Report the uid, gid and permission bits from `meta` (default: the user's,
   *  in the user's primary group, 0755 folder, 0644 file) for every path under
   *  the temp folder, through lstat, stat and fstat. */
  function simulatePosix(): void {
    if (!saved) {
      saved = {
        geteuid: Object.getOwnPropertyDescriptor(process, 'geteuid'),
        getegid: Object.getOwnPropertyDescriptor(process, 'getegid'),
      }
    }
    Object.defineProperty(process, 'geteuid', { value: () => EUID, configurable: true, writable: true })
    Object.defineProperty(process, 'getegid', { value: () => egid, configurable: true, writable: true })
    fdPaths.clear()
    const realLstat = fs.lstatSync
    const realStat = fs.statSync
    const realOpen = fs.openSync
    const realFstat = fs.fstatSync
    const fake = (st: fs.Stats, p: string): fs.Stats => {
      if (!path.resolve(p).startsWith(root)) return st
      const m = meta[path.resolve(p)] ?? {}
      const out = Object.assign(Object.create(Object.getPrototypeOf(st) as object) as fs.Stats, st)
      out.uid = m.uid ?? EUID
      out.gid = m.gid ?? egid
      out.mode = (st.mode & ~0o7777) | (m.mode ?? (st.isDirectory() ? 0o755 : 0o644))
      return out
    }
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => fake(realLstat(p, o as never) as fs.Stats, String(p))) as typeof fs.lstatSync)
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: unknown) => fake(realStat(p, o as never) as fs.Stats, String(p))) as typeof fs.statSync)
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      const fd = realOpen(p, flags ?? 'r', mode)
      fdPaths.set(fd, String(p))
      return fd
    }) as typeof fs.openSync)
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, o?: unknown) => {
      const st = realFstat(fd, o as never) as fs.Stats
      const p = fdPaths.get(fd)
      return p === undefined ? st : fake(st, p)
    }) as typeof fs.fstatSync)
  }

  beforeEach(() => { meta = {}; egid = PER_USER_GID })
  afterEach(() => {
    if (!saved) return
    for (const k of ['geteuid', 'getegid'] as const) {
      const d = saved[k]
      if (d) Object.defineProperty(process, k, d)
      else delete (process as unknown as Record<string, unknown>)[k]
    }
    saved = null
  })

  function project(): { cwd: string; claude: string; json: string; local: string } {
    const cwd = path.join(root, 'srv', 'work')
    const claude = path.join(cwd, '.claude')
    const json = writeSettings(claude, { Stop: [cmdHook(MARKER)] })
    const local = writeSettings(claude, { Stop: [cmdHook('own-local')] }, 'settings.local.json')
    return { cwd, claude, json, local }
  }

  it('a .claude folder and files of the user\'s, not writable by others, are read, and nothing is logged', () => {
    const p = project()
    simulatePosix()
    expect(commands(resolveInheritedHooks(p.cwd, home), 'Stop')).toEqual([MARKER, 'own-local'])
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a session folder with no .claude reads nothing and logs nothing', () => {
    const cwd = path.join(root, 'srv', 'bare')
    fs.mkdirSync(cwd, { recursive: true })
    simulatePosix()
    expect(commands(resolveInheritedHooks(cwd, home), 'Stop')).toEqual([])
    expect(logWarn).not.toHaveBeenCalled()
  })

  // Claude Code reads a settings file that starts with FF FE as UTF-16LE and
  // drops a leading byte-order mark (src/main/settings-text.ts), so the hooks
  // of a file saved with a UTF-8 BOM or as UTF-16LE run in a plain session.
  // The user file goes through readHooksFrom, the project files through the
  // owner-checked read. Mutation to prove this can fail: parse each file as
  // UTF-8 text as it stands.
  it('settings files saved with a UTF-8 byte-order mark or as UTF-16LE give their hooks, the user file included', () => {
    const json = (command: string): string => JSON.stringify({ hooks: { Stop: [cmdHook(command)] } })
    const bomUtf8 = (command: string): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json(command), 'utf8')])
    const utf16le = (command: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json(command), 'utf16le')])
    const cwd = path.join(root, 'srv', 'enc')
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), utf16le('user-utf16'))
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), bomUtf8('project-bom'))
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), utf16le('local-utf16'))
    simulatePosix()
    expect(commands(resolveInheritedHooks(cwd, home), 'Stop')).toEqual(['user-utf16', 'project-bom', 'local-utf16'])
    expect(logWarn).not.toHaveBeenCalled()
  })

  // With a per-user group and umask 002 (the default on Ubuntu and the RHEL
  // family) mkdir, git clone and Claude Code make the folder 0775 and the
  // files 0664, group-owned by the user's own per-user group. Mutation to
  // prove this can fail: refuse every group-writable folder or file.
  it('a .claude folder and files writable by the user\'s own per-user group (umask 002) are read', () => {
    const p = project()
    meta = { [p.claude]: { mode: 0o775 }, [p.json]: { mode: 0o664 }, [p.local]: { mode: 0o664 } }
    simulatePosix()
    expect(commands(resolveInheritedHooks(p.cwd, home), 'Stop')).toEqual([MARKER, 'own-local'])
    expect(logWarn).not.toHaveBeenCalled()
  })

  // A primary group other accounts share is not a per-user group, even though
  // it is the user's own: on macOS every account's is staff (gid 20), and a
  // new file takes its folder's group. Mutation to prove this can fail:
  // accept a group-writable folder or file whenever its group is the user's
  // primary group.
  it('a primary group other accounts share (macOS staff) does not make a group-writable .claude or file usable, in the session folder or the checkout root', () => {
    const p = project()
    egid = STAFF_GID
    meta = { [p.claude]: { mode: 0o775 } }
    simulatePosix()
    expect(commands(resolveInheritedHooks(p.cwd, home), 'Stop')).toEqual([])
    expect(warned()).toContain(`${p.claude} (mode)`)
    vi.restoreAllMocks()
    vi.mocked(logWarn).mockClear()
    meta = { [p.json]: { mode: 0o664 }, [p.local]: { mode: 0o664 } }
    simulatePosix()
    expect(commands(resolveInheritedHooks(p.cwd, home), 'Stop')).toEqual([])
    expect(warned()).toContain(`${p.json} (mode)`)
    expect(warned()).toContain(`${p.local} (mode)`)
    vi.restoreAllMocks()
    vi.mocked(logWarn).mockClear()
    // The same group, not group-writable: read as usual.
    meta = {}
    simulatePosix()
    expect(commands(resolveInheritedHooks(p.cwd, home), 'Stop')).toEqual([MARKER, 'own-local'])
    expect(logWarn).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    // The checkout root's .claude, group-writable under that shared group.
    const repo = path.join(root, 'srv', 'repo')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    const rootClaude = path.join(repo, '.claude')
    writeSettings(rootClaude, { Stop: [cmdHook('root-local')] }, 'settings.local.json')
    const sub = path.join(repo, 'pkg')
    fs.mkdirSync(sub, { recursive: true })
    meta = { [rootClaude]: { mode: 0o775 } }
    simulatePosix()
    expect(commands(resolveInheritedHooks(sub, home), 'Stop')).toEqual([])
    expect(warned()).toContain(`${rootClaude} (mode)`)
  })

  // A folder name can carry characters that display text in another order
  // (the bidi overrides) or fake a second line. Mutation to prove this can
  // fail: log the path raw.
  it('a skipped path is logged with its control and spoofing characters replaced', () => {
    const rlo = String.fromCharCode(0x202e)
    const cwd = path.join(root, 'srv', `work${rlo}txt.sh`)
    const claude = path.join(cwd, '.claude')
    writeSettings(claude, { Stop: [cmdHook(MARKER)] })
    meta[claude] = { uid: 5000 }
    simulatePosix()
    expect(commands(resolveInheritedHooks(cwd, home), 'Stop')).toEqual([])
    expect(warned()).not.toContain(rlo)
    expect(warned()).toContain(`${path.join(root, 'srv', 'work txt.sh', '.claude')} (owner)`)
  })

  // Mutation to prove this can fail: drop the owner check on the .claude folder.
  it('a .claude folder another user owns is skipped, even holding files of the user\'s, and the skip is logged', () => {
    const p = project()
    meta[p.claude] = { uid: 5000 }
    simulatePosix()
    expect(commands(resolveInheritedHooks(p.cwd, home), 'Stop')).toEqual([])
    expect(warned()).toContain(`${p.claude} (owner)`)
  })

  // Mutation to prove this can fail: drop the others-writable check or the
  // group check on the .claude folder.
  it('a .claude folder writable by others, or by a group other than the user\'s own, is skipped and logged', () => {
    const p = project()
    for (const m of [{ mode: 0o777 }, { mode: 0o757 }, { mode: 0o775, gid: SHARED_GID }, { mode: 0o770, gid: SHARED_GID }]) {
      meta[p.claude] = m
      vi.mocked(logWarn).mockClear()
      simulatePosix()
      expect(commands(resolveInheritedHooks(p.cwd, home), 'Stop'), JSON.stringify(m)).toEqual([])
      expect(warned(), JSON.stringify(m)).toContain(`${p.claude} (mode)`)
      vi.restoreAllMocks()
    }
  })

  // Mutation to prove this can fail: drop the owner, others-writable or group
  // check on the file.
  it('a settings file another user owns, or writable by others or by another group, is skipped and logged; the other one is still read', () => {
    const p = project()
    const cases: Array<[Meta, string]> = [
      [{ uid: 5000 }, 'owner'],
      [{ mode: 0o646 }, 'mode'],
      [{ mode: 0o666 }, 'mode'],
      [{ mode: 0o664, gid: SHARED_GID }, 'mode'],
    ]
    for (const [m, why] of cases) {
      meta = { [p.json]: m }
      vi.mocked(logWarn).mockClear()
      simulatePosix()
      expect(commands(resolveInheritedHooks(p.cwd, home), 'Stop'), JSON.stringify(m)).toEqual(['own-local'])
      expect(warned(), JSON.stringify(m)).toContain(`${p.json} (${why})`)
      expect(warned(), JSON.stringify(m)).not.toContain(p.local)
      vi.restoreAllMocks()
    }
  })

  // The checkout root's settings.local.json, which Claude Code also reads on
  // POSIX for a session in a subfolder of a checkout, or in a linked worktree
  // (from the main checkout). Found by the launch gate's own resolver.
  describe('the checkout root\'s settings.local.json', () => {
    /** A checkout at `dir`: a real .git folder, and the root's own two
     *  settings files (its settings.json is one Claude does NOT read for a
     *  session elsewhere). */
    function checkout(dir: string): { claude: string; local: string } {
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
      const claude = path.join(dir, '.claude')
      writeSettings(claude, { Stop: [cmdHook(MARKER)] })
      const local = writeSettings(claude, { Stop: [cmdHook('root-local')] }, 'settings.local.json')
      return { claude, local }
    }
    /** A linked worktree of `main` at `wt`, laid out as git worktree add does. */
    function linkedWorktree(main: string, wt: string): string {
      const gitdir = path.join(main, '.git', 'worktrees', path.basename(wt))
      fs.mkdirSync(gitdir, { recursive: true })
      fs.mkdirSync(wt, { recursive: true })
      fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`)
      fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n')
      fs.writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(wt, '.git')}\n`)
      return gitdir
    }

    // Mutation to prove this can fail: read only the session folder's own
    // .claude.
    it('a session in a subfolder of a checkout also runs the checkout root\'s local hooks, after its own, and not the root\'s settings.json', () => {
      const repo = path.join(root, 'srv', 'repo')
      checkout(repo)
      const sub = path.join(repo, 'packages', 'app')
      writeSettings(path.join(sub, '.claude'), { Stop: [cmdHook('sub-project')] })
      writeSettings(path.join(sub, '.claude'), { Stop: [cmdHook('sub-local')] }, 'settings.local.json')
      const bare = path.join(repo, 'docs')
      fs.mkdirSync(bare, { recursive: true })
      simulatePosix()
      expect(commands(resolveInheritedHooks(sub, home), 'Stop')).toEqual(['sub-project', 'sub-local', 'root-local'])
      // A subfolder with no .claude of its own still gets the root's local hooks.
      expect(commands(resolveInheritedHooks(bare, home), 'Stop')).toEqual(['root-local'])
      expect(logWarn).not.toHaveBeenCalled()
    })

    // Mutation to prove this can fail: stop at the worktree (do not follow
    // its pointer to the main checkout).
    it('a session in a linked worktree also runs the MAIN checkout\'s local hooks, and not its settings.json', () => {
      const main = path.join(root, 'srv', 'repo')
      checkout(main)
      const wt = path.join(root, 'srv', 'wt')
      linkedWorktree(main, wt)
      writeSettings(path.join(wt, '.claude'), { Stop: [cmdHook('wt-project')] })
      const wtSub = path.join(wt, 'src')
      fs.mkdirSync(wtSub, { recursive: true })
      // A worktree inside the main checkout, as the app and Claude Code place them.
      const nested = path.join(main, '.claude', 'worktrees', 'agent-1')
      linkedWorktree(main, nested)
      simulatePosix()
      expect(commands(resolveInheritedHooks(wt, home), 'Stop')).toEqual(['wt-project', 'root-local'])
      expect(commands(resolveInheritedHooks(wtSub, home), 'Stop')).toEqual(['root-local'])
      expect(commands(resolveInheritedHooks(nested, home), 'Stop')).toEqual(['root-local'])
      expect(logWarn).not.toHaveBeenCalled()
    })

    // Mutation to prove this can fail: drop the back-pointer comparison. The
    // pointer names a .git that exists, so only the comparison refuses it.
    it('a worktree whose git folder does not point back at it is not followed to the main checkout', () => {
      const main = path.join(root, 'srv', 'repo')
      checkout(main)
      const wt = path.join(root, 'srv', 'wt')
      const gitdir = linkedWorktree(main, wt)
      fs.mkdirSync(path.join(root, 'srv', 'other', '.git'), { recursive: true })
      fs.writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(root, 'srv', 'other', '.git')}\n`)
      simulatePosix()
      expect(commands(resolveInheritedHooks(wt, home), 'Stop')).toEqual([])
    })

    it('the session folder that is the checkout root reads its local file once', () => {
      const repo = path.join(root, 'srv', 'repo')
      checkout(repo)
      simulatePosix()
      expect(commands(resolveInheritedHooks(repo, home), 'Stop')).toEqual([MARKER, 'root-local'])
    })

    // Claude Code's own rule: the root, its .git and its .claude must be the
    // user's, or Claude reads only the session folder's files. Not a skip of
    // ours, so nothing is logged.
    it('a checkout root, .git or .claude another user owns is not read, as Claude Code does not read it', () => {
      const repo = path.join(root, 'srv', 'repo')
      const { claude } = checkout(repo)
      const sub = path.join(repo, 'pkg')
      fs.mkdirSync(sub, { recursive: true })
      for (const p of [repo, path.join(repo, '.git'), claude]) {
        meta = { [p]: { uid: 5000 } }
        vi.mocked(logWarn).mockClear()
        simulatePosix()
        expect(commands(resolveInheritedHooks(sub, home), 'Stop'), p).toEqual([])
        expect(logWarn, p).not.toHaveBeenCalled()
        vi.restoreAllMocks()
      }
    })

    // Mutation to prove this can fail: skip the folder or the file checks on
    // the root's .claude.
    it('a checkout root\'s .claude or local file another user owns, writable by others or by another group, or not a folder, is skipped and logged', () => {
      const repo = path.join(root, 'srv', 'repo')
      const { claude, local } = checkout(repo)
      const sub = path.join(repo, 'pkg')
      fs.mkdirSync(sub, { recursive: true })
      const cases: Array<[string, Meta, string]> = [
        [claude, { mode: 0o777 }, `${claude} (mode)`],
        [claude, { mode: 0o775, gid: SHARED_GID }, `${claude} (mode)`],
        [local, { uid: 5000 }, `${local} (owner)`],
        [local, { mode: 0o666 }, `${local} (mode)`],
        [local, { mode: 0o664, gid: SHARED_GID }, `${local} (mode)`],
      ]
      for (const [p, m, line] of cases) {
        meta = { [p]: m }
        vi.mocked(logWarn).mockClear()
        simulatePosix()
        expect(commands(resolveInheritedHooks(sub, home), 'Stop'), line).toEqual([])
        expect(warned(), line).toContain(line)
        vi.restoreAllMocks()
      }
      // A root whose .claude is a file, not a folder.
      const flat = path.join(root, 'srv', 'flat')
      fs.mkdirSync(path.join(flat, '.git'), { recursive: true })
      fs.writeFileSync(path.join(flat, '.claude'), '{}')
      const flatSub = path.join(flat, 'pkg')
      fs.mkdirSync(flatSub, { recursive: true })
      meta = {}
      vi.mocked(logWarn).mockClear()
      simulatePosix()
      expect(commands(resolveInheritedHooks(flatSub, home), 'Stop')).toEqual([])
      expect(warned()).toContain(`${path.join(flat, '.claude')} (type)`)
    })

    // Mutation to prove this can fail: drop the "home folder or above it"
    // check on the root.
    it('never a checkout root that is the home folder or a folder above it', () => {
      // The home folder is a checkout (dotfiles): Claude Code itself skips it.
      // (Its .claude/settings.json is the USER file, so only a local file here.)
      fs.mkdirSync(path.join(home, '.git'), { recursive: true })
      writeSettings(path.join(home, '.claude'), { Stop: [cmdHook(MARKER)] }, 'settings.local.json')
      const inHome = path.join(home, 'proj')
      fs.mkdirSync(inHome, { recursive: true })
      // The temp folder above the home folder is a checkout too.
      checkout(root)
      const outside = path.join(root, 'srv', 'work')
      fs.mkdirSync(outside, { recursive: true })
      simulatePosix()
      expect(commands(resolveInheritedHooks(inHome, home), 'Stop')).toEqual([])
      expect(commands(resolveInheritedHooks(outside, home), 'Stop')).toEqual([])
      expect(logWarn).not.toHaveBeenCalled()
    })

    // Mutation to prove this can fail: drop the log of an unreadable root.
    it('a worktree pointer that changes while it is read leaves the root unread, and says so', () => {
      const main = path.join(root, 'srv', 'repo')
      checkout(main)
      const wt = path.join(root, 'srv', 'wt')
      linkedWorktree(main, wt)
      simulatePosix()
      const realRead = fs.readSync
      vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, ...rest: unknown[]) =>
        fdPaths.get(fd) === path.join(wt, '.git') ? 0 : (realRead as (...a: unknown[]) => number)(fd, ...rest)) as typeof fs.readSync)
      expect(commands(resolveInheritedHooks(wt, home), 'Stop')).toEqual([])
      expect(warned()).toContain(`the app did not add the checkout root's local hooks for ${wt} to this session's settings file: which checkout root Claude Code reads could not be determined (a git pointer changed while it was read)`)
      // Not the owner and mode explanation, which says nothing about this.
      expect(warned()).not.toContain('It adds a project .claude folder')
    })

    // The root lookup can fail for a reason other than a git pointer that
    // changed; the line says so and does not name a pointer. Mutation to
    // prove this can fail: one message for every error, naming the pointer.
    it('a root lookup that fails for another reason leaves the root unread, and says the lookup failed', async () => {
      const repo = path.join(root, 'srv', 'repo')
      checkout(repo)
      const sub = path.join(repo, 'pkg')
      fs.mkdirSync(sub, { recursive: true })
      vi.resetModules()
      vi.doMock('../../../src/main/git-local-settings-root', async (importOriginal) => {
        const real = await importOriginal<typeof import('../../../src/main/git-local-settings-root')>()
        return { ...real, posixCanonicalLocalSettingsRootSync: () => { throw Object.assign(new Error('read failed'), { code: 'EIO' }) } }
      })
      try {
        const fresh = await import('../../../src/main/hooks/session-hooks-writer')
        const logger = await import('../../../src/main/debug-logger')
        vi.mocked(logger.logWarn).mockClear()
        simulatePosix()
        expect(commands(fresh.resolveInheritedHooks(sub, home), 'Stop')).toEqual([])
        const lines = vi.mocked(logger.logWarn).mock.calls.map((c) => c.join(' ')).join('\n')
        expect(lines).toContain(`the app did not add the checkout root's local hooks for ${sub} to this session's settings file: which checkout root Claude Code reads could not be determined (the lookup failed: EIO)`)
        expect(lines).not.toContain('git pointer')
      } finally {
        vi.doUnmock('../../../src/main/git-local-settings-root')
        vi.resetModules()
      }
    })

    // Claude Code walks up from the REAL path of the folder it starts in, so a
    // session folder reached through a link that lands inside another checkout
    // takes that checkout's local file, not the one around the link. No link
    // is made on this host: `link` is a plain folder, and the real path a link
    // there would have is answered here (the real-link case is in
    // session-hooks-inherit-scope-links.test.ts, CI and VM only). Mutation to
    // prove this can fail: walk up from path.resolve(cwd).
    it('a session folder reached through a link into another checkout takes that checkout\'s local hooks, not those around the link', () => {
      const a = path.join(root, 'srv', 'a')
      fs.mkdirSync(path.join(a, '.git'), { recursive: true })
      writeSettings(path.join(a, '.claude'), { Stop: [cmdHook('a-local')] }, 'settings.local.json')
      const b = path.join(root, 'srv', 'b')
      fs.mkdirSync(path.join(b, '.git'), { recursive: true })
      writeSettings(path.join(b, '.claude'), { Stop: [cmdHook('b-local')] }, 'settings.local.json')
      const lands = path.join(b, 'sub')
      fs.mkdirSync(lands, { recursive: true })
      const link = path.join(a, 'link')
      fs.mkdirSync(link, { recursive: true })
      simulatePosix()
      // As a plain folder it is in checkout A.
      expect(commands(resolveInheritedHooks(link, home), 'Stop')).toEqual(['a-local'])
      const realNative = fs.realpathSync.native
      vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike, o?: unknown) =>
        path.resolve(String(p)) === link ? lands : (realNative as (...x: unknown[]) => string)(p, o)) as typeof fs.realpathSync.native)
      expect(commands(resolveInheritedHooks(link, home), 'Stop')).toEqual(['b-local'])
      expect(logWarn).not.toHaveBeenCalled()
    })
  })

  // A skipped folder or file is one the app does not ADD to the session's
  // settings file; Claude Code still applies the project's own files itself.
  // The line names every reason a skip can have. Mutation to prove this can
  // fail: say the skipped hooks are not inherited, or leave out the type
  // reason.
  it('the skip line says the app did not add them, explains every reason, type included, and that Claude Code still applies its own files', () => {
    const p = project()
    meta[p.json] = { mode: 0o666 }
    simulatePosix()
    expect(commands(resolveInheritedHooks(p.cwd, home), 'Stop')).toEqual(['own-local'])
    const line = warned()
    expect(line).toContain(`the app did not add the hooks of ${p.json} (mode) to this session's settings file`)
    for (const reason of ['(owner)', '(mode)', '(link)', '(type)']) expect(line, reason).toContain(reason)
    expect(line).toContain('a real folder and a regular file (type)')
    expect(line).toContain('Claude Code itself still applies the project\'s own settings files')
    expect(line).not.toContain('not inherited')
  })
})
