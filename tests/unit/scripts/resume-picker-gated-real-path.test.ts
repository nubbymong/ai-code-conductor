/**
 * The resume picker relaunches the CLI only in a folder of the gated set a
 * managed launch hands it (CCC_GATED_DIRS). A folder is in the set when the
 * disk says it is the same folder as one of the set's entries: their real
 * paths (fs.realpathSync.native) are equal. Two names that differ only in case
 * are one folder on a case-insensitive volume and two folders on a folder made
 * case-sensitive, so the disk decides, never the text. A path whose real path
 * cannot be read matches only its own spelling: separators, a trailing
 * separator and the drive letter's case settled, a folder name's case
 * never.
 *
 * isGatedDir answers with the folder a launch into a matched folder starts in,
 * or null; which folder that is, is asserted in
 * resume-picker-gated-start-folder.test.ts. Here only whether it matches.
 *
 * The disk is injected (`realpath`, `followLinks`, `platform`) so each kind of
 * volume is asserted on every system, and the host's own disk is used where it
 * is the kind a case needs. Nothing here plants a link or changes a folder's
 * settings; the link spellings are in resume-picker-gated-links.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type Disk = (p: string) => unknown
type GateOpts = { realpath?: Disk; followLinks?: Disk; platform?: string }

/** Links followed on an injected disk, which has none to follow: the spelling
 *  as given. A matched folder's drive is then asked for its real path. */
const noLinks: Disk = (p) => p

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
}

const W = path.win32
const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
/** Resolved as Windows resolves it, the drive letter as the disk reports it. */
const onDisk = (p: string): string => W.resolve(p).replace(/^[a-z](?=:)/, (c) => c.toUpperCase())

/** A folder made case-sensitive on Windows: each folder is its own real path,
 *  in its own case; a name that is not one of them is not there. */
function caseSensitiveWindowsDisk(folders: string[]): Disk {
  const known = new Set(folders.map(onDisk))
  return (p) => {
    const r = onDisk(p)
    if (!known.has(r)) throw enoent(p)
    return r
  }
}

/** A case-insensitive Windows volume (the default): every spelling of a folder
 *  resolves to its one real path, in the case on disk. */
function caseInsensitiveWindowsDisk(folders: string[]): Disk {
  const byName = new Map(folders.map((f) => [W.resolve(f).toLowerCase(), onDisk(f)]))
  return (p) => {
    const r = byName.get(W.resolve(p).toLowerCase())
    if (r === undefined) throw enoent(p)
    return r
  }
}

/** A case-sensitive macOS or Linux volume. */
function caseSensitivePosixDisk(folders: string[]): Disk {
  const known = new Set(folders.map((f) => path.posix.resolve(f)))
  return (p) => {
    const r = path.posix.resolve(p)
    if (!known.has(r)) throw enoent(p)
    return r
  }
}

const unreadable: Disk = (p) => { throw Object.assign(new Error(`EPERM: ${p}`), { code: 'EPERM' }) }
/** Only the named spellings can be read; every other path cannot. */
const onlyReads = (...readable: string[]): Disk => (p) => {
  if (!readable.includes(p)) throw enoent(p)
  return W.resolve(p)
}

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
/** A fresh folder under the host's temp folder, spelled as the disk spells it. */
function hostFolder(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-gated-real-'))
  roots.push(r)
  return fs.realpathSync.native(r)
}

// Mutation that must fail this block: match names case-blind on Windows.
describe('on a folder made case-sensitive, a name that differs from a gated one only in case is another folder', () => {
  const disk = caseSensitiveWindowsDisk(['C:\\R\\repo', 'C:\\R\\REPO', 'C:\\R\\wt', 'C:\\R\\WT', 'C:\\R\\other'])
  const win = { followLinks: noLinks, realpath: disk, platform: 'win32' }

  it('the launch folder is matched in its own name only, never in another case', () => {
    const gated = ['C:\\R\\repo', 'C:\\R\\other']
    expect(picker.isGatedDir('C:\\R\\REPO', gated, win)).toBeNull()
    // git lists a worktree with forward slashes on Windows.
    expect(picker.isGatedDir('C:/R/REPO', gated, win)).toBeNull()
    expect(picker.isGatedDir('C:\\R\\repo', gated, win)).not.toBeNull()
    expect(picker.isGatedDir('C:/R/repo', gated, win)).not.toBeNull()
    expect(picker.isGatedDir('c:/R/repo/', gated, win)).not.toBeNull()
  })

  it('a resume there is refused, and one in a gated folder still goes ahead', () => {
    const env = { CCC_GATED_DIRS: JSON.stringify(['C:\\R\\repo', 'C:\\R\\other']) }
    const exists = () => true
    expect(picker.resolveRetargetCwd('abc', 'C:\\R\\REPO', 'C:\\R\\repo', env, exists, win)).toEqual({ cwd: null, refused: 'C:\\R\\REPO' })
    expect(picker.resolveRetargetCwd('abc', 'C:/R/REPO', 'C:\\R\\repo', env, exists, win)).toEqual({ cwd: null, refused: 'C:/R/REPO' })
    // It starts in the folder the match was made on (this disk's real path:
    // its drive is not one it can read).
    expect(picker.resolveRetargetCwd('abc', 'C:/R/other', 'C:\\R\\repo', env, exists, win)).toEqual({ cwd: 'C:\\R\\other' })
  })

  it('a gated worktree\'s name in another case is refused too', () => {
    const gated = ['C:\\R\\repo', 'C:\\R\\wt']
    expect(picker.isGatedDir('C:\\R\\WT', gated, win)).toBeNull()
    expect(picker.isGatedDir('C:\\R\\wt', gated, win)).not.toBeNull()
  })

  it('on macOS and Linux a case-sensitive volume follows the same rule', () => {
    const disk = caseSensitivePosixDisk(['/R/repo', '/R/REPO'])
    for (const platform of ['darwin', 'linux']) {
      expect(picker.isGatedDir('/R/REPO', ['/R/repo'], { followLinks: noLinks, realpath: disk, platform })).toBeNull()
      expect(picker.isGatedDir('/R/repo/', ['/R/repo'], { followLinks: noLinks, realpath: disk, platform })).not.toBeNull()
    }
  })

  it('on this machine\'s own disk, when its temp folder tells two such names apart', (ctx) => {
    const root = hostFolder()
    const lower = path.join(root, 'repo')
    const upper = path.join(root, 'REPO')
    fs.mkdirSync(lower)
    try {
      fs.mkdirSync(upper)
    } catch (e) {
      // A case-insensitive volume (the default on Windows and macOS) holds one
      // folder under both names: the cases above stand in for it.
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') { ctx.skip(); return }
      throw e
    }
    expect(picker.isGatedDir(upper, [lower])).toBeNull()
    expect(picker.isGatedDir(lower, [upper])).toBeNull()
    expect(picker.isGatedDir(lower + path.sep, [lower])).not.toBeNull()
  })
})

// Mutation that must fail this block: compare the spellings alone, without
// asking the disk.
describe('on a case-insensitive volume, every spelling of a gated folder is still that folder', () => {
  it('drive letter case, separators, a trailing separator, dot parts and the name\'s case', () => {
    const win = { followLinks: noLinks, realpath: caseInsensitiveWindowsDisk(['C:\\R\\repo', 'C:\\R\\other']), platform: 'win32' }
    const gated = ['C:\\R\\repo']
    for (const spelling of ['c:\\R\\repo', 'C:/R/repo', 'c:/r/REPO/', 'C:\\R\\Repo\\', 'C:\\R\\.\\repo', 'C:\\R\\other\\..\\repo']) {
      expect(picker.isGatedDir(spelling, gated, win), spelling).not.toBeNull()
    }
    expect(picker.isGatedDir('C:\\R\\other', gated, win)).toBeNull()
    // The app keeps the launch folder as it was typed; git lists it in the case on disk.
    expect(picker.isGatedDir('C:/R/repo', ['c:\\r\\REPO'], win)).not.toBeNull()
    const env = { CCC_GATED_DIRS: JSON.stringify(['c:\\r\\REPO']) }
    expect(picker.resolveRetargetCwd('abc', 'C:/R/repo', 'c:\\r\\REPO', env, () => true, win)).toEqual({ cwd: 'C:\\R\\repo' })
  })

  it.runIf(process.platform === 'win32')('on this machine\'s own disk (Windows)', () => {
    const repo = path.join(hostFolder(), 'repo')
    const other = path.join(path.dirname(repo), 'other')
    fs.mkdirSync(repo)
    fs.mkdirSync(other)
    const spellings = [
      repo.toUpperCase(),
      repo.toLowerCase(),
      repo.charAt(0).toLowerCase() + repo.slice(1),
      repo.replace(/\\/g, '/'),
      repo + '\\',
      '\\\\?\\' + repo,
    ]
    for (const s of spellings) {
      expect(picker.isGatedDir(s, [repo]), s).not.toBeNull()
      expect(picker.isGatedDir(repo, [s]), s).not.toBeNull()
    }
    expect(picker.isGatedDir(other, [repo])).toBeNull()
    expect(picker.isGatedDir(other.toUpperCase(), [repo])).toBeNull()
  })

  it('on this machine\'s own disk, a trailing separator and a dot part are still the folder', () => {
    const repo = path.join(hostFolder(), 'repo')
    fs.mkdirSync(repo)
    expect(picker.isGatedDir(repo + path.sep, [repo])).not.toBeNull()
    expect(picker.isGatedDir(path.dirname(repo) + path.sep + '.' + path.sep + 'repo', [repo])).not.toBeNull()
    expect(picker.isGatedDir(repo, [repo + path.sep])).not.toBeNull()
  })
})

// Mutation that must fail this block: fall back to a case-blind compare when
// the disk cannot answer.
describe('a path whose real path cannot be read matches only its own spelling', () => {
  it('a name in another case is not taken for a gated folder when either side cannot be read', () => {
    for (const disk of [unreadable, onlyReads('C:\\R\\repo'), onlyReads('C:\\R\\REPO')]) {
      const win = { followLinks: noLinks, realpath: disk, platform: 'win32' }
      expect(picker.isGatedDir('C:\\R\\REPO', ['C:\\R\\repo'], win)).toBeNull()
      expect(picker.isGatedDir('c:\\r\\repo', ['C:\\R\\repo'], win)).toBeNull()
      expect(picker.isGatedDir('C:\\R\\repo', ['C:\\R\\REPO'], win)).toBeNull()
    }
  })

  it('the same spelling still matches: separators, a trailing separator and the drive letter settled', () => {
    const win = { followLinks: noLinks, realpath: unreadable, platform: 'win32' }
    expect(picker.isGatedDir('C:\\R\\repo', ['C:\\R\\repo'], win)).not.toBeNull()
    expect(picker.isGatedDir('c:/R/repo/', ['C:\\R\\repo'], win)).not.toBeNull()
    expect(picker.isGatedDir('C:\\R\\repo', ['c:/R/repo/'], win)).not.toBeNull()
    expect(picker.isGatedDir('\\\\server\\share\\repo\\', ['\\\\server\\share\\repo'], win)).not.toBeNull()
    // A server or share name is not a drive letter: spelled as given.
    expect(picker.isGatedDir('\\\\SERVER\\share\\repo', ['\\\\server\\share\\repo'], win)).toBeNull()
    const posix = { followLinks: noLinks, realpath: unreadable, platform: 'linux' }
    expect(picker.isGatedDir('/R/REPO', ['/R/repo'], posix)).toBeNull()
    expect(picker.isGatedDir('/R/repo/', ['/R/repo'], posix)).not.toBeNull()
    expect(picker.isGatedDir('/R//repo', ['/R/repo'], posix)).not.toBeNull()
  })

  it('off Windows, a spelling with a parent part is kept as written when the disk cannot be asked', () => {
    // After a link, `..` is the link target's parent, not the folder the text
    // names, so the text alone cannot say which folder it is.
    const posix = { followLinks: noLinks, realpath: unreadable, platform: 'linux' }
    expect(picker.isGatedDir('/R/link/../repo', ['/R/repo'], posix)).toBeNull()
    expect(picker.isGatedDir('/R/repo', ['/R/link/../repo'], posix)).toBeNull()
    expect(picker.isGatedDir('/R/link/../repo', ['/R/link/../repo'], posix)).not.toBeNull()
  })

  it('a resolver that answers with no path is one that cannot answer', () => {
    for (const answer of [undefined, null, '', 7]) {
      const win = { followLinks: noLinks, realpath: () => answer, platform: 'win32' }
      expect(picker.isGatedDir('C:\\R\\REPO', ['C:\\R\\repo'], win), String(answer)).toBeNull()
      expect(picker.isGatedDir('C:\\R\\repo', ['C:\\R\\repo'], win), String(answer)).not.toBeNull()
    }
  })

  it('a resume into a name in another case is refused when the disk cannot be asked', () => {
    const env = { CCC_GATED_DIRS: JSON.stringify(['C:\\R\\repo']) }
    expect(picker.resolveRetargetCwd('abc', 'C:\\R\\REPO', 'C:\\R\\repo', env, () => true, { followLinks: noLinks, realpath: unreadable, platform: 'win32' }))
      .toEqual({ cwd: null, refused: 'C:\\R\\REPO' })
  })

  it('on this machine\'s own disk, a folder that is not there is matched by its spelling alone', () => {
    const gone = path.join(hostFolder(), 'gone')
    expect(picker.isGatedDir(gone, [gone])).not.toBeNull()
    expect(picker.isGatedDir(gone + path.sep, [gone])).not.toBeNull()
    expect(picker.isGatedDir(path.join(path.dirname(gone), 'GONE'), [gone])).toBeNull()
  })
})

// On Windows a folder name ending in a dot or a space is opened as written by
// Node's fs, while the system drops that ending before it starts a program in
// the folder. The disk's answer for such a path is about another folder than
// the one the CLI would run in, so the path is matched by its spelling alone.
// The launch gate (hasWin32RewrittenComponent) looks for such a name in the
// resolved path only; the picker looks in the path as written too (the case
// below where a parent part follows such a name). Mutation that must fail
// this block: ask the disk for such a path.
describe('on Windows, a path with a name ending in a dot or a space is matched by its spelling alone', () => {
  it('is not taken for the gated folder its name as written leads to on disk', () => {
    const asked: string[] = []
    // The names as written are links to the launch folder on this disk.
    const disk: Disk = (p) => {
      asked.push(p)
      const r = onDisk(p)
      return r === 'C:\\R\\repo' || /\\(M\.|M |M\.\\x|N\. \\x)$/.test(r) ? 'C:\\R\\repo' : r
    }
    const win = { followLinks: noLinks, realpath: disk, platform: 'win32' }
    const gated = ['C:\\R\\repo']
    for (const spelled of ['C:\\R\\M.', 'C:\\R\\M ', 'C:/R/M.', 'C:\\R\\M.\\x', 'C:\\R\\N. \\x', '\\\\?\\C:\\R\\M.']) {
      expect(picker.isGatedDir(spelled, gated, win), JSON.stringify(spelled)).toBeNull()
    }
    expect(asked.filter((p) => p !== 'C:\\R\\repo')).toEqual([])
    const env = { CCC_GATED_DIRS: JSON.stringify(gated) }
    expect(picker.resolveRetargetCwd('abc', 'C:\\R\\M.', 'C:\\R\\repo', env, () => true, win)).toEqual({ cwd: null, refused: 'C:\\R\\M.' })
  })

  it('the same spelling still matches itself, and a dot part or a parent part is not such a name', () => {
    const win = { followLinks: noLinks, realpath: caseInsensitiveWindowsDisk(['C:\\R\\repo']), platform: 'win32' }
    expect(picker.isGatedDir('C:\\R\\M.', ['C:\\R\\M.'], win)).not.toBeNull()
    expect(picker.isGatedDir('C:\\R\\.\\REPO', ['C:\\R\\repo'], win)).not.toBeNull()
    expect(picker.isGatedDir('C:\\R\\x\\..\\REPO', ['C:\\R\\repo'], win)).not.toBeNull()
    // Such a name as written counts, even where a parent part takes it away.
    expect(picker.isGatedDir('C:\\R\\x.\\..\\REPO', ['C:\\R\\repo'], win)).toBeNull()
    expect(picker.isGatedDir('C:\\R\\x.\\..\\repo', ['C:\\R\\repo'], win)).not.toBeNull()
  })

  it('a gated entry spelled that way is matched by its spelling alone too', () => {
    const disk: Disk = (p) => (/M\.$/.test(p) ? 'C:\\R\\repo' : onDisk(p))
    expect(picker.isGatedDir('C:\\R\\repo', ['C:\\R\\M.'], { followLinks: noLinks, realpath: disk, platform: 'win32' })).toBeNull()
  })

  it('off Windows such a name is an ordinary name, and the disk decides', () => {
    const disk: Disk = (p) => (p === '/R/M.' || p === '/R/repo' ? '/R/repo' : path.posix.resolve(p))
    expect(picker.isGatedDir('/R/M.', ['/R/repo'], { followLinks: noLinks, realpath: disk, platform: 'linux' })).not.toBeNull()
    expect(picker.isGatedDir('/R/M.', ['/R/repo'], { followLinks: noLinks, realpath: disk, platform: 'darwin' })).not.toBeNull()
  })
})

describe('the disk is asked through fs.realpathSync.native, once a path', () => {
  it('reads the real path with the native resolver by default', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('fs') as typeof import('fs')
    const asked: string[] = []
    const spy = vi.spyOn(nodeFs.realpathSync, 'native').mockImplementation(((p: fs.PathLike) => {
      asked.push(String(p))
      return 'same-folder'
    }) as typeof fs.realpathSync.native)
    try {
      expect(picker.isGatedDir('/R/one', ['/R/two'])).not.toBeNull()
    } finally {
      spy.mockRestore()
    }
    expect(asked).toEqual(['/R/one', '/R/two'])
  })

  it('each path is read at most once a call, however often the set names it', () => {
    const asked: string[] = []
    const disk: Disk = (p) => { asked.push(p); return W.resolve(p) }
    expect(picker.isGatedDir('C:\\R\\x', ['C:\\R\\a', 'C:\\R\\a', 'C:\\R\\b', 'C:\\R\\a'], { followLinks: noLinks, realpath: disk, platform: 'win32' })).toBeNull()
    expect(asked).toEqual(['C:\\R\\x', 'C:\\R\\a', 'C:\\R\\b'])
  })

  it('stops at the first folder that matches, and then reads only the drive of the folder it starts in', () => {
    const asked: string[] = []
    const disk: Disk = (p) => { asked.push(p); return W.resolve(p).toLowerCase() }
    expect(picker.isGatedDir('C:\\R\\A', ['C:\\R\\a', 'C:\\R\\b'], { followLinks: noLinks, realpath: disk, platform: 'win32' })).not.toBeNull()
    expect(asked).toEqual(['C:\\R\\A', 'C:\\R\\a', 'C:\\'])
  })
})
