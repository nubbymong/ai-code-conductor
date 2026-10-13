// HOST QUARANTINE: plants real symlinks, junctions and hard links in a temp folder (on Windows, the links to a network share by running mklink). [CI] [VM] only -- never run on the owner's machine.
//
// The files of a paths review are read by the app for a reviewer that can
// read no file itself (review-diff.ts, produceReviewFiles): a name that is a
// link or a junction, or is reached through one, is refused before it is
// opened, and so is a second name of a file; a name changed after that is
// refused by the open itself or by the checks made on the open file.
// Nothing outside the project is ever sent. The same rules against a
// modelled file system are tests/unit/main/review-files.test.ts (host-safe).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { produceReviewFiles, defaultReviewFilesDeps } from '../../../src/main/review-diff'

const IS_WIN = process.platform === 'win32'
// 192.0.2.1 is a documentation address: nothing answers there.
const WIN_SHARE = '\\\\192.0.2.1\\share'
let base = ''
let project = ''
let outside = ''

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-review-files-real-'))
  project = path.join(base, 'proj')
  outside = path.join(base, 'outside')
  fs.mkdirSync(project)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET-OUTSIDE\n')
  fs.writeFileSync(path.join(project, 'a.ts'), 'const a = 1\n')
})
afterEach(() => { if (base) fs.rmSync(base, { recursive: true, force: true }) })

const read = (paths: string[], cwd = project) => produceReviewFiles({ cwd, paths }, defaultReviewFilesDeps())

/** The app's own deps, with every name it opens recorded. */
function counting() {
  const deps = defaultReviewFilesDeps()
  const opened: string[] = []
  const open = deps.open
  deps.open = async (p) => { opened.push(p); return open(p) }
  return { deps, opened }
}

/** A link at `at` to `to`, or null where this system will not make one
 *  (a Windows file symlink needs the privilege to make it). */
function link(to: string, at: string, type?: 'file' | 'dir' | 'junction'): true | null {
  try { fs.symlinkSync(to, at, type); return true } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return null
    throw e
  }
}

/** Windows: a symbolic link at `at` to `to`, a path on the documentation share, made by
 *  mklink (`dir`: a folder link). The test home guard fails closed on making any link to
 *  a share, since it cannot tell where a share leads, so the share path reaches mklink
 *  through its environment, where the guard does not expand %VAR%; the link's own place
 *  is on the command line, where the guard checks it. Making a link reads nothing at its target. */
function linkToShare(to: string, at: string, type: 'file' | 'dir'): void {
  if (to !== WIN_SHARE && !to.startsWith(WIN_SHARE + '\\')) throw new Error(`only the documentation share is linked this way, not ${to}`)
  execFileSync('cmd.exe', ['/d', '/c', 'mklink', ...(type === 'dir' ? ['/D'] : []), at, '%REVIEW_FILES_SHARE_PATH%'], {
    env: { ...process.env, REVIEW_FILES_SHARE_PATH: to },
    stdio: 'pipe',
  })
}

describe('a paths review against real links (review-diff.ts, produceReviewFiles)', () => {
  it('a folder in the project that is a junction (Windows) or a symlink (POSIX) out of it is refused unopened, and nothing outside is sent', async () => {
    fs.symlinkSync(outside, path.join(project, 'out'), IS_WIN ? 'junction' : 'dir')
    const { deps, opened } = counting()
    const r = await produceReviewFiles({ cwd: project, paths: ['out/secret.txt'] }, deps)
    expect(r).toEqual({ ok: false, message: '"out/secret.txt" is reached through a link or a junction ("out"), so it is not sent' })
    expect(opened).toEqual([])
    expect(JSON.stringify(r)).not.toContain('SECRET-OUTSIDE')
  })

  it('a second name (a hard link) of a file outside the project is refused unopened', async () => {
    fs.linkSync(path.join(outside, 'secret.txt'), path.join(project, 'copy.txt'))
    const { deps, opened } = counting()
    const r = await produceReviewFiles({ cwd: project, paths: ['copy.txt'] }, deps)
    expect(r).toEqual({ ok: false, message: '"copy.txt" has more than one name (a hard link), so it is not sent' })
    expect(opened).toEqual([])
  })

  it('a file symlink to a file outside the project is refused unopened', async (ctx) => {
    if (!link(path.join(outside, 'secret.txt'), path.join(project, 'key'), 'file')) { ctx.skip(); return }
    const { deps, opened } = counting()
    expect(await produceReviewFiles({ cwd: project, paths: ['key'] }, deps)).toEqual({ ok: false, message: '"key" is a link (a symbolic link or a junction), so it is not sent' })
    expect(opened).toEqual([])
  })

  it('a link to a network share, or to a device, is never opened, so nothing connects to the share or opens the device', async (ctx) => {
    // Nothing answers at the share's documentation address, and nothing here asks.
    const share = IS_WIN ? WIN_SHARE : '//192.0.2.1/share'
    const device = IS_WIN ? '\\\\.\\NUL' : '/dev/zero'
    // The device link is made first: where this system gives no privilege to make a
    // link, the case is skipped.
    if (!link(device, path.join(project, 'dev'), 'file')) { ctx.skip(); return }
    if (IS_WIN) {
      linkToShare(path.join(share, 'f.txt'), path.join(project, 'remote.txt'), 'file')
      linkToShare(share, path.join(project, 'net'), 'dir')
    } else {
      link(path.join(share, 'f.txt'), path.join(project, 'remote.txt'), 'file')
      link(share, path.join(project, 'net'), 'dir')
    }
    const { deps, opened } = counting()
    expect(await produceReviewFiles({ cwd: project, paths: ['remote.txt'] }, deps)).toEqual({ ok: false, message: '"remote.txt" is a link (a symbolic link or a junction), so it is not sent' })
    expect(await produceReviewFiles({ cwd: project, paths: ['dev'] }, deps)).toEqual({ ok: false, message: '"dev" is a link (a symbolic link or a junction), so it is not sent' })
    expect(await produceReviewFiles({ cwd: project, paths: ['net/f.txt'] }, deps)).toEqual({ ok: false, message: '"net/f.txt" is reached through a link or a junction ("net"), so it is not sent' })
    expect(opened).toEqual([])
  })

  it.skipIf(IS_WIN)('a named pipe in the project is refused unopened, without waiting for a writer (POSIX)', async () => {
    execFileSync('mkfifo', [path.join(project, 'fifo')])
    const { deps, opened } = counting()
    expect(await produceReviewFiles({ cwd: project, paths: ['fifo'] }, deps)).toEqual({ ok: false, message: '"fifo" is not a file; name files' })
    expect(opened).toEqual([])
  })

  it.skipIf(IS_WIN)('a name made a link out just before the open is refused by the open itself, which does not follow a link at the name (POSIX)', async () => {
    // A plain file when looked at; as another process could, it is replaced
    // by a link to the outside file just before the open. The open does not
    // follow it (O_NOFOLLOW), so the outside file is never opened.
    const x = path.join(project, 'x')
    const secret = path.join(outside, 'secret.txt')
    fs.writeFileSync(x, 'fine\n')
    const deps = defaultReviewFilesDeps()
    const open = deps.open
    deps.open = async (p) => { fs.unlinkSync(x); fs.symlinkSync(secret, x); return open(p) }
    const r = await produceReviewFiles({ cwd: project, paths: ['x'] }, deps)
    expect(r).toEqual({ ok: false, message: '"x" changed while it was being read' })
    expect(JSON.stringify(r)).not.toContain('SECRET-OUTSIDE')
  })

  it.skipIf(IS_WIN)('a name made a second name of an outside file after the open is refused: the name at the real path must be the file opened (POSIX)', async () => {
    // The plain file is opened; before its real path is found, the name is
    // replaced by a hard link to the outside file, so the name's real path is
    // in the project but the file there is not the one opened.
    const x = path.join(project, 'x')
    const secret = path.join(outside, 'secret.txt')
    fs.writeFileSync(x, 'fine\n')
    const deps = defaultReviewFilesDeps()
    const open = deps.open
    deps.open = async (p) => ({ ...(await open(p)), realpath: undefined })
    const realpath = deps.realpath
    deps.realpath = async (p) => {
      if (p === x) { fs.unlinkSync(x); fs.linkSync(secret, x) }
      return realpath(p)
    }
    const r = await produceReviewFiles({ cwd: project, paths: ['x'] }, deps)
    expect(r).toEqual({ ok: false, message: '"x" changed while it was being read' })
    expect(JSON.stringify(r)).not.toContain('SECRET-OUTSIDE')
  })

  it.skipIf(IS_WIN)('the opened file given a second name outside the project before the check is refused: it must still have one name (POSIX)', async () => {
    // One name when it is opened and looked at through its handle; a second
    // name, outside the project, before the name at its real path is checked.
    const x = path.join(project, 'x')
    fs.writeFileSync(x, 'fine\n')
    const deps = defaultReviewFilesDeps()
    const open = deps.open
    deps.open = async (p) => ({ ...(await open(p)), realpath: undefined })
    const realpath = deps.realpath
    deps.realpath = async (p) => {
      if (p === x) fs.linkSync(x, path.join(outside, 'x2'))
      return realpath(p)
    }
    expect(await produceReviewFiles({ cwd: project, paths: ['x'] }, deps)).toEqual({ ok: false, message: '"x" changed while it was being read' })
  })

  it.runIf(process.platform === 'linux')('a folder made a link out at the open and a real folder again after it is judged by the open file\'s own path (Linux)', async () => {
    // A real folder when looked at; replaced by a link out of the project
    // just before the open, and by a real folder holding a plain file of the
    // same name just after it. The open file's own real path (/proc/self/fd)
    // is still outside.
    const sub = path.join(project, 'sub')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'secret.txt'), 'fine\n')
    const deps = defaultReviewFilesDeps()
    const open = deps.open
    deps.open = async (p) => {
      fs.rmSync(sub, { recursive: true, force: true })
      fs.symlinkSync(outside, sub, 'dir')
      const h = await open(p)
      fs.unlinkSync(sub)
      fs.mkdirSync(sub)
      fs.writeFileSync(path.join(sub, 'secret.txt'), 'fine\n')
      return h
    }
    const r = await produceReviewFiles({ cwd: project, paths: ['sub/secret.txt'] }, deps)
    expect(r).toEqual({ ok: false, message: '"sub/secret.txt" is outside the project' })
    expect(JSON.stringify(r)).not.toContain('SECRET-OUTSIDE')
  })

  it('a project reached through a junction or symlink is judged by its real path: its own files are read', async () => {
    const via = path.join(base, 'via')
    fs.symlinkSync(project, via, IS_WIN ? 'junction' : 'dir')
    expect(await read(['a.ts'], via)).toEqual({ ok: true, files: [{ path: 'a.ts', text: 'const a = 1\n' }] })
  })
})
