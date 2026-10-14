/**
 * A managed launch hands the resume picker the folders its project-settings
 * gate checked (CCC_GATED_DIRS), and the picker relaunches the CLI only in a
 * folder it finds to be one of them (isGatedDir). The folder the CLI then
 * starts in is the one that check settled, never the worktree's spelling read
 * again: a link in that spelling pointed somewhere else after the check does
 * not move the CLI, nor its fresh-session fallback.
 *
 * Matched by real path, the CLI starts at the real path's own names below the
 * drive, so no folder outside the real path is passed through whichever links
 * the worktree's path holds. The drive is the one the worktree's path reaches
 * the folder through once its links are followed the way Claude Code names a
 * project folder (fs.realpathSync, the JS one), so a subst drive keeps the
 * conversation's project folder; it is taken only when the drive's own real
 * path holds the real path, and otherwise the CLI starts at the real path
 * itself.
 *
 * The disk is injected (`realpath` for the real path, `followLinks` for the
 * links followed) or, for the launch, answered through spies on Node's fs
 * over plain folders in the test's own temp folder. No link is made here;
 * the real link cases are in resume-picker-gated-links.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type Disk = (p: string) => unknown
type GateOpts = { realpath?: Disk; followLinks?: Disk; platform?: string }

// eslint-disable-next-line @typescript-eslint/no-var-requires
const picker = require('../../../scripts/resume-picker.js') as {
  isGatedDir: (dir: string, gated: string[], opts?: GateOpts) => string | null
  resolveRetargetCwd: (
    resumeId: string | null,
    sourceCwd: string | null,
    currentCwd: string,
    env: Record<string, string | undefined>,
    existsSync: (p: string) => boolean,
    opts?: GateOpts,
  ) => { cwd: string | null; refused?: string }
  resolveProjectDir: (claudeProjectsDir: string, cwd: string, realpath?: (p: string) => string) => string | null
  encodeProjectPath: (p: string) => string
  launchClaude: (resumeId: string, sourceCwd: string, deps: {
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => { status: number | null }
    exit: (code: number) => void
    argv: string[]
    env: Record<string, string | undefined>
    platform: string
    isFile: (p: string) => boolean
    cwd: string
  }) => void
}

const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
/** A disk that answers from a table and cannot read anything else. */
const table = (answers: Record<string, string>): Disk => (p) => {
  if (!(p in answers)) throw enoent(p)
  return answers[p]
}
const exists = (): boolean => true

// Mutation that must fail this block: start where the worktree is spelled
// (resolveRetargetCwd returning `sourceCwd` for a gated worktree).
describe('a worktree matched by its real path starts the CLI at that path, on the drive its links lead to', () => {
  // S: is a subst drive for C:\Subst. S:\L is a junction to S:\R\wt.
  const nativeDisk = table({
    'S:\\': 'C:\\Subst',
    'S:\\L': 'C:\\Subst\\R\\wt',
    'S:\\R\\wt': 'C:\\Subst\\R\\wt',
    'S:\\R': 'C:\\Subst\\R',
    'S:\\R\\main': 'C:\\Subst\\R\\main',
  })
  const followed = (p: string): string => (p === 'S:\\L' ? 'S:\\R\\wt' : path.win32.resolve(p))
  const win = { realpath: nativeDisk, followLinks: followed, platform: 'win32' }
  const env = { CCC_GATED_DIRS: JSON.stringify(['S:\\R\\main', 'S:\\R\\wt']) }

  it('a link to a gated folder starts in the folder it leads to, not at the link', () => {
    expect(picker.isGatedDir('S:\\L', ['S:\\R\\main', 'S:\\R\\wt'], win)).toBe('S:\\R\\wt')
    expect(picker.resolveRetargetCwd('abc', 'S:\\L', 'S:\\R\\main', env, exists, win)).toEqual({ cwd: 'S:\\R\\wt' })
    // A gated folder spelled as the set spells it starts where it is spelled.
    expect(picker.resolveRetargetCwd('abc', 'S:\\R\\wt', 'S:\\R\\main', env, exists, win)).toEqual({ cwd: 'S:\\R\\wt' })
  })

  // Mutation that must fail this case: start at the real path
  // (fs.realpathSync.native), which names a subst drive by the folder behind it.
  it('keeps the conversation\'s project folder: Claude Code names it from the same path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-gated-start-key-'))
    try {
      const projects = path.join(root, 'projects')
      const listed = path.join(projects, picker.encodeProjectPath('S:\\R\\wt'))
      fs.mkdirSync(listed, { recursive: true })
      // The picker lists the conversation from the worktree's spelling; Claude
      // Code started in `cwd` names its project folder from the same path.
      expect(picker.resolveProjectDir(projects, 'S:\\L', followed)).toBe(listed)
      const { cwd } = picker.resolveRetargetCwd('abc', 'S:\\L', 'S:\\R\\main', env, exists, win)
      expect(cwd).not.toBeNull()
      expect(picker.resolveProjectDir(projects, cwd as string, followed)).toBe(listed)
      // At the real path behind the subst drive the conversation is not found.
      expect(picker.resolveProjectDir(projects, 'C:\\Subst\\R\\wt', followed)).toBeNull()
    } finally {
      // TEST CLEANUP GUARD: only this case's own folder, by its prefix and parent.
      if (path.basename(root).startsWith('ccc-gated-start-key-') && path.dirname(root) === path.resolve(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('off Windows the same: a link starts in the folder it leads to', () => {
    const onDisk = table({ '/R/link': '/R/wt', '/R/wt': '/R/wt', '/R': '/R', '/': '/' })
    const posix = {
      realpath: (p: string) => onDisk(path.posix.resolve(p)),
      followLinks: (p: string) => (p === '/R/link' ? '/R/wt' : path.posix.resolve(p)),
      platform: 'linux',
    }
    expect(picker.isGatedDir('/R/link', ['/R/wt'], posix)).toBe('/R/wt')
    expect(picker.isGatedDir('/R/wt/', ['/R/wt'], posix)).toBe('/R/wt')
  })
})

// Mutations that must fail this block: start at the followed path whole, or
// with only its last name checked against its parent's real path (a link
// above it that the JS resolver leaves in place stays in it), or at the
// followed path when its drive cannot be read.
describe('below its drive, the folder a launch starts in names only the real path\'s own folders', () => {
  it('a link above the folder that the JS resolver does not follow is not started through', () => {
    // On Windows Node's JS resolver takes a junction whose target is not a
    // drive-letter path (a volume path, say) for a plain folder; the native
    // one follows it. D:\work\old is such a junction to C:\src.
    const win = {
      realpath: table({ 'D:\\work\\old\\repo': 'C:\\src\\repo', 'D:\\work\\old': 'C:\\src', 'D:\\': 'D:\\', 'C:\\src\\repo': 'C:\\src\\repo', 'C:\\': 'C:\\' }),
      followLinks: (p: string) => path.win32.resolve(p),
      platform: 'win32',
    }
    expect(picker.isGatedDir('D:\\work\\old\\repo', ['C:\\src\\repo'], win)).toBe('C:\\src\\repo')
    const env = { CCC_GATED_DIRS: JSON.stringify(['C:\\src\\repo']) }
    expect(picker.resolveRetargetCwd('abc', 'D:\\work\\old\\repo', 'C:\\src\\main', env, exists, win)).toEqual({ cwd: 'C:\\src\\repo' })
    // The same on the drive the folder is on: C:\work\vol is such a junction to C:\src.
    const sameDrive = {
      realpath: table({ 'C:\\work\\vol\\repo': 'C:\\src\\repo', 'C:\\work\\vol': 'C:\\src', 'C:\\src\\repo': 'C:\\src\\repo', 'C:\\': 'C:\\' }),
      followLinks: (p: string) => path.win32.resolve(p),
      platform: 'win32',
    }
    expect(picker.isGatedDir('C:\\work\\vol\\repo', ['C:\\src\\repo'], sameDrive)).toBe('C:\\src\\repo')
    // And as the last name.
    const last = {
      realpath: table({ 'D:\\work\\J': 'C:\\src\\repo', 'D:\\work': 'D:\\work', 'D:\\': 'D:\\', 'C:\\src\\repo': 'C:\\src\\repo' }),
      followLinks: (p: string) => path.win32.resolve(p),
      platform: 'win32',
    }
    expect(picker.isGatedDir('D:\\work\\J', ['C:\\src\\repo'], last)).toBe('C:\\src\\repo')
  })

  it('a spelling the disk read as a link and then as a folder of its own starts at the real path', () => {
    // At the first read R\W leads to the gated folder; read again, with its
    // links followed, it is a folder of its own: the CLI must not start there.
    const win = {
      realpath: table({ 'C:\\R\\W': 'C:\\G\\wt', 'C:\\G\\wt': 'C:\\G\\wt', 'C:\\R': 'C:\\R', 'C:\\': 'C:\\' }),
      followLinks: (p: string) => path.win32.resolve(p),
      platform: 'win32',
    }
    expect(picker.isGatedDir('C:\\R\\W', ['C:\\G\\wt'], win)).toBe('C:\\G\\wt')
    const env = { CCC_GATED_DIRS: JSON.stringify(['C:\\G\\wt']) }
    expect(picker.resolveRetargetCwd('abc', 'C:\\R\\W', 'C:\\G\\main', env, exists, win)).toEqual({ cwd: 'C:\\G\\wt' })
  })

  it('a path that cannot be followed, or whose drive cannot be read, starts at the real path', () => {
    const nativeDisk = table({ 'C:\\R\\wt-via': 'C:\\R\\wt', 'C:\\R\\wt': 'C:\\R\\wt' })
    const cannotFollow = { realpath: nativeDisk, followLinks: (p: string) => { throw enoent(p) }, platform: 'win32' }
    expect(picker.isGatedDir('C:\\R\\wt-via', ['C:\\R\\wt'], cannotFollow)).toBe('C:\\R\\wt')
    for (const answer of [undefined, null, '', 7]) {
      expect(picker.isGatedDir('C:\\R\\wt-via', ['C:\\R\\wt'], { ...cannotFollow, followLinks: () => answer }), String(answer)).toBe('C:\\R\\wt')
    }
    // Followed to a spelling of the gated folder (through a subst drive, S:),
    // whose drive cannot be read.
    const noDrive = { realpath: nativeDisk, followLinks: (p: string) => (p === 'C:\\R\\wt-via' ? 'S:\\wt' : p), platform: 'win32' }
    expect(picker.isGatedDir('C:\\R\\wt-via', ['C:\\R\\wt'], noDrive)).toBe('C:\\R\\wt')
  })

  it('a drive whose real path does not hold the real path is not taken', () => {
    // Followed to S:\wt, but S: is now a subst drive for another folder.
    const win = {
      realpath: table({ 'C:\\R\\wt-via': 'C:\\R\\wt', 'C:\\R\\wt': 'C:\\R\\wt', 'S:\\': 'C:\\Other' }),
      followLinks: (p: string) => (p === 'C:\\R\\wt-via' ? 'S:\\wt' : p),
      platform: 'win32',
    }
    expect(picker.isGatedDir('C:\\R\\wt-via', ['C:\\R\\wt'], win)).toBe('C:\\R\\wt')
    // A real path that only starts with the same letters is not held either.
    const prefix = { ...win, realpath: table({ 'C:\\R\\wt-via': 'C:\\R\\wt', 'C:\\R\\wt': 'C:\\R\\wt', 'S:\\': 'C:\\R\\w' }) }
    expect(picker.isGatedDir('C:\\R\\wt-via', ['C:\\R\\wt'], prefix)).toBe('C:\\R\\wt')
  })

  it('a mapped drive keeps its letter, as Claude Code names the project folder from it', () => {
    const share = '\\\\server\\share'
    const win = {
      realpath: table({ 'Z:\\repo': share + '\\repo', [share + '\\repo']: share + '\\repo', 'Z:\\': share }),
      followLinks: (p: string) => path.win32.resolve(p),
      platform: 'win32',
    }
    expect(picker.isGatedDir('Z:\\repo', [share + '\\repo'], win)).toBe('Z:\\repo')
    // The folder is the drive itself.
    const whole = { ...win, realpath: table({ 'Z:\\': share + '\\', [share + '\\']: share + '\\' }) }
    expect(picker.isGatedDir('Z:\\', [share + '\\'], whole)).toBe('Z:\\')
  })

  it('a name in another case, or an 8.3 name, starts at the name on disk, above the folder too', () => {
    const nativeDisk = table({ 'C:\\R\\WT': 'C:\\R\\wt', 'C:\\R\\WORKTR~1': 'C:\\R\\wt', 'C:\\R\\wt': 'C:\\R\\wt', 'C:\\R': 'C:\\R', 'C:\\': 'C:\\' })
    const win = { realpath: nativeDisk, followLinks: (p: string) => path.win32.resolve(p), platform: 'win32' }
    expect(picker.isGatedDir('C:\\R\\WT', ['C:\\R\\wt'], win)).toBe('C:\\R\\wt')
    expect(picker.isGatedDir('C:\\R\\WORKTR~1', ['C:\\R\\wt'], win)).toBe('C:\\R\\wt')
    // An 8.3 name or another case above it: the disk's names too. A name in
    // another case names the same project folder on a case-insensitive disk;
    // an 8.3 name names another one.
    const above = {
      realpath: table({
        'C:\\RUNNER~1\\wt': 'C:\\runneradmin\\wt',
        'C:\\RUNNER~1': 'C:\\runneradmin',
        'C:\\RunnerAdmin\\wt': 'C:\\runneradmin\\wt',
        'C:\\runneradmin\\wt': 'C:\\runneradmin\\wt',
        'C:\\': 'C:\\',
      }),
      followLinks: (p: string) => path.win32.resolve(p),
      platform: 'win32',
    }
    expect(picker.isGatedDir('C:\\RUNNER~1\\wt', ['C:\\runneradmin\\wt'], above)).toBe('C:\\runneradmin\\wt')
    expect(picker.isGatedDir('C:\\RunnerAdmin\\wt', ['C:\\runneradmin\\wt'], above)).toBe('C:\\runneradmin\\wt')
  })
})

// Mutation that must fail this block: take a real path with a name the
// system rewrites as the folder to start in.
describe('on Windows, a real path with a name ending in a dot or a space is not started in', () => {
  it('a link to such a folder is matched by its spelling alone', () => {
    const win = {
      realpath: table({ 'C:\\R\\W': 'C:\\R\\foo.', 'C:\\R\\g-link': 'C:\\R\\foo.', 'C:\\R': 'C:\\R' }),
      followLinks: (p: string) => (p === 'C:\\R\\W' || p === 'C:\\R\\g-link' ? 'C:\\R\\foo.' : path.win32.resolve(p)),
      platform: 'win32',
    }
    // The system would start the CLI in C:\R\foo, another folder.
    expect(picker.isGatedDir('C:\\R\\W', ['C:\\R\\g-link'], win)).toBeNull()
    // The set's own spelling still matches itself, and starts where it is spelled.
    expect(picker.isGatedDir('C:\\R\\g-link', ['C:\\R\\g-link'], win)).toBe('C:\\R\\g-link')
  })
})

describe('the links are followed through fs.realpathSync by default', () => {
  it('reads the followed path with the JS resolver and the real path with the native one', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('fs') as typeof import('fs')
    const realJs = nodeFs.realpathSync
    const followed: string[] = []
    const native: string[] = []
    const js = vi.spyOn(nodeFs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
      followed.push(String(p))
      return '/G/wt'
    }) as typeof fs.realpathSync)
    ;(nodeFs.realpathSync as unknown as { native: (p: fs.PathLike) => string }).native = (p) => {
      native.push(String(p))
      return String(p) === '/' ? '/' : '/G/wt'
    }
    try {
      expect(picker.isGatedDir('/R/link', ['/G/wt'], { platform: 'linux' })).toBe('/G/wt')
    } finally {
      js.mockRestore()
    }
    expect(nodeFs.realpathSync).toBe(realJs)
    expect(followed).toEqual(['/R/link'])
    expect(native).toEqual(['/R/link', '/G/wt', '/'])
  })
})

// The launch acts on that folder: both of its launches, the resume and the
// fresh-session fallback when the conversation is no longer there, start in
// it, and the conversation's companion folder is made for it. Plain folders in
// the test's own temp folder; the spies on Node's fs answer for a link at
// `link` that leads to the gated folder when the picker checks it, and to
// another folder after (each case says when).
describe('a launch into a link to a gated folder starts both of its launches in that folder', () => {
  const roots: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    // TEST CLEANUP GUARD: only this block's own folders, by their prefix and parent.
    for (const r of roots.splice(0)) {
      if (path.basename(r).startsWith('ccc-gated-start-launch-') && path.dirname(r) === path.resolve(os.tmpdir())) fs.rmSync(r, { recursive: true, force: true })
    }
  })

  it('the resume and its fallback both start in the gated folder after the link is pointed elsewhere', () => {
    const made = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-gated-start-launch-'))
    roots.push(made)
    const root = fs.realpathSync.native(made)
    const main = path.join(root, 'main')
    const gated = path.join(root, 'gated')
    const link = path.join(root, 'link')
    const elsewhere = path.join(root, 'elsewhere')
    for (const d of [main, gated, link, elsewhere]) fs.mkdirSync(d)
    let pointedElsewhere = false
    const leadsTo = (): string => (pointedElsewhere ? elsewhere : gated)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('fs') as typeof import('fs')
    const realJs = nodeFs.realpathSync
    const realNative = nodeFs.realpathSync.native
    vi.spyOn(nodeFs, 'realpathSync').mockImplementation(((p: fs.PathLike) => (String(p) === link ? leadsTo() : realJs(p))) as typeof fs.realpathSync)
    ;(nodeFs.realpathSync as unknown as { native: (p: fs.PathLike) => string }).native = (p) => (String(p) === link ? leadsTo() : realNative(p))

    const started: unknown[] = []
    const exits: number[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    picker.launchClaude('0f8fad5b-d9cb-469f-a165-70867728950e', link, {
      spawn: (_file, _args, opts) => {
        started.push(opts.cwd)
        if (started.length === 1) {
          // The link is pointed at another folder while the first CLI runs,
          // and that CLI reports the conversation gone.
          pointedElsewhere = true
          return { status: 1 }
        }
        return { status: 0 }
      },
      exit: (code) => { exits.push(code) },
      argv: [],
      env: { CCC_GATED_DIRS: JSON.stringify([main, gated]), SystemRoot: 'C:\\Windows', Path: 'C:\\native' },
      platform: 'win32',
      isFile: (p) => p === 'C:\\native\\claude.exe',
      cwd: main,
    })
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('starting fresh session')
    expect(started).toEqual([gated, gated])
    expect(exits).toEqual([0])
  })

  // Mutation that must fail this case: name the companion folder's project
  // folder from the worktree's spelling, read again after the check.
  it('the conversation\'s companion folder is made in the project folder of the folder the CLI starts in', () => {
    const made = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-gated-start-launch-'))
    roots.push(made)
    const root = fs.realpathSync.native(made)
    const main = path.join(root, 'main')
    const gated = path.join(root, 'gated')
    const link = path.join(root, 'link')
    const elsewhere = path.join(root, 'elsewhere')
    for (const d of [main, gated, link, elsewhere]) fs.mkdirSync(d)
    // The test's own home (tests/helpers/home-isolation.ts): a transcript of
    // the conversation under the project folder of each folder the link leads to.
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const projects = path.join(os.homedir(), '.claude', 'projects')
    const checked = path.join(projects, picker.encodeProjectPath(gated))
    const other = path.join(projects, picker.encodeProjectPath(elsewhere))
    try {
      for (const d of [checked, other]) {
        fs.mkdirSync(d, { recursive: true })
        fs.writeFileSync(path.join(d, `${uuid}.jsonl`), '{}\n')
      }
      // The link leads to the gated folder when the picker checks it, and is
      // pointed at another folder as soon as its links have been followed once.
      let followedOnce = false
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeFs = require('fs') as typeof import('fs')
      const realJs = nodeFs.realpathSync
      const realNative = nodeFs.realpathSync.native
      vi.spyOn(nodeFs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
        if (String(p) !== link) return realJs(p)
        const to = followedOnce ? elsewhere : gated
        followedOnce = true
        return to
      }) as typeof fs.realpathSync)
      ;(nodeFs.realpathSync as unknown as { native: (p: fs.PathLike) => string }).native = (p) => (String(p) === link ? (followedOnce ? elsewhere : gated) : realNative(p))
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const started: unknown[] = []
      picker.launchClaude(uuid, link, {
        spawn: (_file, _args, opts) => { started.push(opts.cwd); return { status: 0 } },
        exit: () => {},
        argv: [],
        env: { CCC_GATED_DIRS: JSON.stringify([main, gated]), SystemRoot: 'C:\\Windows', Path: 'C:\\native' },
        platform: 'win32',
        isFile: (p) => p === 'C:\\native\\claude.exe',
        cwd: main,
      })
      expect(started).toEqual([gated])
      expect(fs.existsSync(path.join(checked, uuid, 'subagents'))).toBe(true)
      expect(fs.existsSync(path.join(other, uuid))).toBe(false)
    } finally {
      // TEST CLEANUP GUARD: only the two project folders this case made, in the test's own home.
      for (const d of [checked, other]) {
        if (path.dirname(d) === projects && path.basename(d).startsWith(picker.encodeProjectPath(root))) fs.rmSync(d, { recursive: true, force: true })
      }
    }
  })
})
