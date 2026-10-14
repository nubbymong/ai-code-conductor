// HOST QUARANTINE: plants directory junctions and symbolic links in its own temp folder. [CI] [VM] only -- never run on the owner's machine.
// The link spellings of resume-picker-gated-real-path.test.ts, kept here so
// the host-safe file plants none. The resume picker matches a folder against
// the gated set of a managed launch (CCC_GATED_DIRS) by its real path, so a
// link or junction that leads to a gated folder is that folder, and one that
// leads anywhere else is not, whatever it is called, and a launch into it
// starts in the folder the link led to when it was matched. Real folders in a
// temp folder; nothing is started (the launch's spawn is injected).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, rmdirSync, unlinkSync, symlinkSync, realpathSync, writeFileSync } from 'fs'
import { join, dirname, basename, sep } from 'path'
import { tmpdir } from 'os'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const picker = require('../../../scripts/resume-picker.js') as {
  isGatedDir: (dir: string, gated: string[]) => string | null
  resolveRetargetCwd: (
    resumeId: string | null,
    sourceCwd: string | null,
    currentCwd: string,
    env: Record<string, string | undefined>,
    existsSync: (p: string) => boolean,
  ) => { cwd: string | null; refused?: string }
  resolveProjectDir: (claudeProjectsDir: string, cwd: string) => string | null
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

const isWin = process.platform === 'win32'
const temps: string[] = []
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ccc-gated-links-'))
  temps.push(d)
  return realpathSync.native(d)
}
/** Removes, recursively, only a folder this file made: its own prefix, directly in the temp folder. */
const removeOwn = (d: string): void => {
  if (dirname(d) === tmpdir() && /^ccc-gated-links-/.test(basename(d))) rmSync(d, { recursive: true, force: true })
}
afterEach(() => {
  for (const d of temps.splice(0)) removeOwn(d)
})
const link = (target: string, at: string): void => symlinkSync(target, at, isWin ? 'junction' : 'dir')
/** Removes the link itself, never what it leads to. */
const unlink = (at: string): void => (isWin ? rmdirSync(at) : unlinkSync(at))

describe('a link spelling is matched by the folder it leads to', () => {
  it('a link to a gated folder is that folder, in either direction', () => {
    const root = temp()
    const repo = join(root, 'repo')
    const via = join(root, 'via')
    mkdirSync(repo)
    link(repo, via)
    expect(picker.isGatedDir(via, [repo])).toBe(repo)
    expect(picker.isGatedDir(repo, [via])).toBe(repo)
    const env = { CCC_GATED_DIRS: JSON.stringify([repo]) }
    // It starts in the folder the link leads to, not at the link.
    expect(picker.resolveRetargetCwd('abc', via, join(root, 'here'), env, () => true)).toEqual({ cwd: repo })
  })

  it('a link to a folder outside the set is refused, whatever it is called', () => {
    const root = temp()
    const repo = join(root, 'repo')
    const other = join(root, 'other')
    mkdirSync(repo)
    mkdirSync(other)
    const named = join(root, 'repo-too')
    link(other, named)
    expect(picker.isGatedDir(named, [repo])).toBeNull()
    const env = { CCC_GATED_DIRS: JSON.stringify([repo]) }
    expect(picker.resolveRetargetCwd('abc', named, repo, env, () => true)).toEqual({ cwd: null, refused: named })
  })

  it('on Windows, a link whose name ends in a dot or a space is matched by its spelling alone', () => {
    // Node's fs makes and opens such a name as written; the system drops the
    // ending before it starts a program there, so the CLI would run in the
    // folder without it, not where the link leads. Elsewhere it is an
    // ordinary name, and the link is matched by the folder it leads to.
    const root = temp()
    const repo = join(root, 'repo')
    mkdirSync(repo)
    for (const name of ['via.', 'via ']) {
      const at = join(root, name)
      link(repo, at)
      expect(picker.isGatedDir(at, [repo]), JSON.stringify(name)).toBe(isWin ? null : repo)
      const env = { CCC_GATED_DIRS: JSON.stringify([repo]) }
      expect(picker.resolveRetargetCwd('abc', at, join(root, 'here'), env, () => true)).toEqual(isWin ? { cwd: null, refused: at } : { cwd: repo })
    }
  })

  it('a parent part after a link is matched where the system takes it', () => {
    // root/a/l leads to root/b/c. On Windows a path's `..` is settled on its
    // text before the disk is asked, so root/a/l/../x is root/a/x; on macOS
    // and Linux it is settled on the disk, past the link, so it is root/b/x.
    const root = temp()
    mkdirSync(join(root, 'a', 'x'), { recursive: true })
    mkdirSync(join(root, 'b', 'c'), { recursive: true })
    mkdirSync(join(root, 'b', 'x'))
    link(join(root, 'b', 'c'), join(root, 'a', 'l'))
    const spelled = [root, 'a', 'l', '..', 'x'].join(sep)
    // It starts where the system takes it, too.
    expect(picker.isGatedDir(spelled, [join(root, 'a', 'x')])).toBe(isWin ? join(root, 'a', 'x') : null)
    expect(picker.isGatedDir(spelled, [join(root, 'b', 'x')])).toBe(isWin ? null : join(root, 'b', 'x'))
  })
})

// A launch through a link starts in the folder the link led to when it was
// matched. Mutation that must fail this block: start at the worktree's
// spelling (resolveRetargetCwd returning `sourceCwd`).
describe('a launch through a link starts in the folder it was matched to', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('the resume and its fresh-session fallback both start there after the link is pointed elsewhere', () => {
    const root = temp()
    const main = join(root, 'main')
    const repo = join(root, 'repo')
    const other = join(root, 'other')
    const via = join(root, 'via')
    for (const d of [main, repo, other]) mkdirSync(d)
    link(repo, via)
    const started: unknown[] = []
    const exits: number[] = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    picker.launchClaude('0f8fad5b-d9cb-469f-a165-70867728950e', via, {
      spawn: (_file, _args, opts) => {
        started.push(opts.cwd)
        if (started.length === 1) {
          // Pointed at another folder while the first CLI runs, which then
          // reports the conversation gone.
          unlink(via)
          link(other, via)
          return { status: 1 }
        }
        return { status: 0 }
      },
      exit: (code) => { exits.push(code) },
      argv: [],
      env: { CCC_GATED_DIRS: JSON.stringify([main, repo]), SystemRoot: 'C:\\Windows', Path: 'C:\\native' },
      platform: 'win32',
      isFile: (p) => p === 'C:\\native\\claude.exe',
      cwd: main,
    })
    expect(started).toEqual([repo, repo])
    expect(exits).toEqual([0])
  })

  it('the conversation\'s project folder is the one the picker listed it from', () => {
    const root = temp()
    const repo = join(root, 'repo')
    const via = join(root, 'via')
    mkdirSync(repo)
    link(repo, via)
    const projects = join(root, 'projects')
    // Named as Claude Code names it: from the real path, links followed.
    const listed = join(projects, picker.encodeProjectPath(realpathSync(via)))
    mkdirSync(listed, { recursive: true })
    writeFileSync(join(listed, 'x.jsonl'), '{}\n')
    expect(picker.resolveProjectDir(projects, via)).toBe(listed)
    const env = { CCC_GATED_DIRS: JSON.stringify([repo]) }
    const { cwd } = picker.resolveRetargetCwd('abc', via, join(root, 'here'), env, () => true)
    expect(cwd).toBe(repo)
    expect(picker.resolveProjectDir(projects, cwd as string)).toBe(listed)
  })
})
