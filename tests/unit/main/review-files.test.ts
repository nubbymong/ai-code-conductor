// The named files of a `paths` review, read by the app for a reviewer that
// can read no file itself (review-diff.ts, produceReviewFiles). PURE: the
// file system is a model injected here, so a link, a second name or a swap
// can be staged without making one; the same rules against real links,
// junctions and hard links are tests/unit/main/review-files-real.test.ts
// (CI and the VM). The last block reads plain files in a temp folder, and
// checks the app's own file calls with spies (no link is made).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { produceReviewFiles, defaultReviewFilesDeps, reviewOpenFlags, REVIEW_DIFF_MAX_BYTES, REVIEW_FILE_LINE_BYTES, REVIEW_FILES_TIMEOUT_MS, REVIEW_FILES_BACKLOG_MESSAGE } from '../../../src/main/review-diff'
import type { ReviewFilesDeps, ReviewFileHandle, ReviewFilesBacklog } from '../../../src/main/review-diff'

interface Node { kind: 'file' | 'dir' | 'fifo' | 'device'; content: Buffer; dev: bigint; ino: bigint; nlink: number }
/** The moments another process can change the folder: just before a name is
 *  opened, just after, and just before a real path, or a name, is looked up. */
type Moment = 'open' | 'opened' | 'realpath' | 'lstat'

/** A small file system: plain paths, links by path, and nodes by real path.
 *  With `fdPaths`, an open file can say its own real path (as Linux can).
 *  An open file closes as Node's FileHandle does: close() returns, and the
 *  file is closed, only once every read still under way on it has returned. */
function world(platform: NodeJS.Platform = 'linux', opts: { fdPaths?: boolean } = {}) {
  let next = 10n
  const nodes = new Map<string, Node>()
  const links = new Map<string, string>()
  const reads: string[] = []
  const readSizes: number[] = []
  /** The files a close was asked for, and those it has closed. */
  const closing: string[] = []
  const closed: string[] = []
  /** How a read returns, where a test needs one that does not at once. */
  let readAs: ((max: number) => Promise<Buffer>) | null = null
  const sep = platform === 'win32' ? '\\' : '/'
  const folder = (p: string) => { if (!nodes.has(p) && !links.has(p)) nodes.set(p, { kind: 'dir', content: Buffer.alloc(0), dev: 1n, ino: next++, nlink: 2 }) }
  const file = (p: string, text: string | Buffer, over: Partial<Node> = {}) => {
    // The folders on its path exist too.
    for (let i = p.indexOf(sep, 1); i > 0; i = p.indexOf(sep, i + 1)) folder(p.slice(0, i))
    nodes.set(p, { kind: 'file', content: Buffer.isBuffer(text) ? text : Buffer.from(text), dev: 1n, ino: next++, nlink: 1, ...over })
  }
  const real = (p: string): string => {
    for (const [from, to] of links) {
      if (p === from) return real(to)
      if (p.startsWith(from + sep)) return real(to + p.slice(from.length))
    }
    return p
  }
  /** Every folder on the path resolved, the last name as it is (lstat). */
  const lpath = (p: string): string => { const i = p.lastIndexOf(sep); return i <= 0 ? p : real(p.slice(0, i)) + p.slice(i) }
  const enoent = () => { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; return e }
  let on: ((moment: Moment, p: string) => void) | null = null
  const deps: ReviewFilesDeps = {
    platform,
    realpath: vi.fn(async (p: string) => { on?.('realpath', p); return real(p) }),
    open: vi.fn(async (p: string): Promise<ReviewFileHandle> => {
      on?.('open', p)
      const r = real(p)
      const n = nodes.get(r)
      if (!n) throw enoent()
      on?.('opened', p)
      const reading = new Set<Promise<Buffer>>()
      return {
        stat: async () => ({ isFile: n.kind === 'file', isDirectory: n.kind === 'dir', size: n.content.length, nlink: n.nlink, dev: n.dev, ino: n.ino }),
        read: (max: number) => {
          reads.push(r)
          readSizes.push(max)
          const got = readAs ? readAs(max) : Promise.resolve(n.content.subarray(0, max))
          reading.add(got)
          const done = () => { reading.delete(got) }
          got.then(done, done)
          return got
        },
        ...(opts.fdPaths ? { realpath: async () => r } : {}),
        close: async () => {
          closing.push(r)
          await Promise.allSettled([...reading])
          closed.push(r)
        },
      }
    }),
    lstat: vi.fn(async (p: string) => {
      on?.('lstat', p)
      const q = lpath(p)
      // A link (or a junction) is reported as one, never as what it leads to.
      if (links.has(q)) return { isFile: false, isDirectory: false, isSymbolicLink: true, dev: 1n, ino: 0n, nlink: 1 }
      const n = nodes.get(q)
      if (!n) throw enoent()
      return { isFile: n.kind === 'file', isDirectory: n.kind === 'dir', isSymbolicLink: false, dev: n.dev, ino: n.ino, nlink: n.nlink }
    }),
  }
  nodes.set('/proj', { kind: 'dir', content: Buffer.alloc(0), dev: 1n, ino: 1n, nlink: 2 })
  /** The paths given to realpath, in order. */
  const resolved = () => vi.mocked(deps.realpath).mock.calls.map((c) => c[0])
  return {
    deps, nodes, links, reads, readSizes, closing, closed, file, real, resolved,
    on: (f: (moment: Moment, p: string) => void) => { on = f },
    /** Every read from now on returns as `f` says (null: at once, as before). */
    readWith: (f: ((max: number) => Promise<Buffer>) | null) => { readAs = f },
  }
}

const TOO_LARGE = { ok: false, message: 'the files are larger than 512 KB together; name fewer or smaller files' }
const TIMED_OUT = { ok: false, message: `the files could not be read within ${REVIEW_FILES_TIMEOUT_MS / 1000} seconds` }
/** What a request adds besides the files' text: each name as given, on the
 *  scope line, and each file's FILE line. */
const scopeBytes = (paths: string[]) => paths.reduce((n, p) => n + Buffer.byteLength(p) + 2, 0)
const lineBytes = (shown: string) => Buffer.byteLength(JSON.stringify(shown)) + REVIEW_FILE_LINE_BYTES
const isLink = (label: string) => ({ ok: false, message: `${label} is a link (a symbolic link or a junction), so it is not sent` })
const through = (label: string, folder: string) => ({ ok: false, message: `${label} is reached through a link or a junction (${folder}), so it is not sent` })

describe('the files of a paths review, read for a reviewer that reads no file itself', () => {
  it('reads each named file inside the project, in the order named, by the name given (relative, / separated)', async () => {
    const w = world()
    w.file('/proj/a.ts', 'const a = 1\n')
    w.file('/proj/src/b.ts', 'export const b = 2')
    const r = await produceReviewFiles({ cwd: '/proj', paths: ['src/b.ts', './a.ts'] }, w.deps)
    expect(r).toEqual({ ok: true, files: [{ path: 'src/b.ts', text: 'export const b = 2' }, { path: 'a.ts', text: 'const a = 1\n' }] })
  })

  it('a name that is a link, or a folder on its way that is one, is refused before anything is opened or resolved', async () => {
    const w = world()
    w.file('/home/u/.ssh/id_ed25519', 'SECRET')
    w.links.set('/proj/key', '/home/u/.ssh/id_ed25519')
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['key'] }, w.deps)).toEqual(isLink('"key"'))
    // A folder inside the project that is a link (or a junction) out of it.
    w.links.set('/proj/dot', '/home/u/.ssh')
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['dot/id_ed25519'] }, w.deps)).toEqual(through('"dot/id_ed25519"', '"dot"'))
    expect(w.deps.open).not.toHaveBeenCalled()
    expect(w.resolved()).toEqual(['/proj', '/proj'])
    expect(w.reads).toEqual([])
  })

  it('a link to a network share or to a device is never opened or resolved, so following it can have no effect', async () => {
    // Windows: opening a link to \\host\share would make the system connect
    // (and sign in) to that host; a link to a device opens the device.
    const w = world('win32')
    w.nodes.set('C:\\Proj', { kind: 'dir', content: Buffer.alloc(0), dev: 1n, ino: 2n, nlink: 1 })
    w.links.set('C:\\Proj\\share.txt', '\\\\host\\share\\f.txt')
    w.links.set('C:\\Proj\\net', '\\\\host\\share')
    w.links.set('C:\\Proj\\nul', '\\\\.\\NUL')
    expect(await produceReviewFiles({ cwd: 'C:\\Proj', paths: ['share.txt'] }, w.deps)).toEqual(isLink('"share.txt"'))
    expect(await produceReviewFiles({ cwd: 'C:\\Proj', paths: ['net\\f.txt'] }, w.deps)).toEqual(through('"net/f.txt"', '"net"'))
    expect(await produceReviewFiles({ cwd: 'C:\\Proj', paths: ['nul'] }, w.deps)).toEqual(isLink('"nul"'))
    expect(w.deps.open).not.toHaveBeenCalled()
    expect(w.resolved()).toEqual(['C:\\Proj', 'C:\\Proj', 'C:\\Proj'])
    // POSIX: a link to a device, and a folder link to an automounted share.
    const p = world()
    p.links.set('/proj/zero', '/dev/zero')
    p.links.set('/proj/mnt', '/net/host/share')
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['zero'] }, p.deps)).toEqual(isLink('"zero"'))
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['mnt/f'] }, p.deps)).toEqual(through('"mnt/f"', '"mnt"'))
    expect(p.deps.open).not.toHaveBeenCalled()
    expect(p.resolved()).toEqual(['/proj', '/proj'])
  })

  it('a link inside the project to another file in it is refused too; that file is read by its own name', async () => {
    const w = world()
    w.file('/proj/real.ts', 'x')
    w.links.set('/proj/alias.ts', '/proj/real.ts')
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['alias.ts'] }, w.deps)).toEqual(isLink('"alias.ts"'))
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['real.ts'] }, w.deps)).toEqual({ ok: true, files: [{ path: 'real.ts', text: 'x' }] })
  })

  it('a project reached through a link is judged by its real path', async () => {
    const w = world()
    w.links.set('/work', '/proj')
    w.file('/proj/a.ts', 'a')
    expect(await produceReviewFiles({ cwd: '/work', paths: ['a.ts'] }, w.deps)).toEqual({ ok: true, files: [{ path: 'a.ts', text: 'a' }] })
  })

  it('a file with a second name (a hard link) is refused: its other name may be anywhere', async () => {
    const w = world()
    w.file('/proj/k', 'SECRET', { nlink: 2 })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['k'] }, w.deps)).toEqual({ ok: false, message: '"k" has more than one name (a hard link), so it is not sent' })
    expect(w.deps.open).not.toHaveBeenCalled()
    // One name when it was looked at, a second one by the time it is opened.
    w.file('/proj/j', 'SECRET')
    w.on((m, p) => { if (m === 'open' && p === '/proj/j') w.nodes.get('/proj/j')!.nlink = 2 })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['j'] }, w.deps)).toEqual({ ok: false, message: '"j" has more than one name (a hard link), so it is not sent' })
    expect(w.reads).toEqual([])
  })

  it('a name swapped between the check and the open is refused: the file opened must be the one at its checked real path', async () => {
    // A plain file when looked at; a link out when opened; a plain file in the
    // project again before its real path is checked.
    const w = world()
    w.file('/outside/secret', 'SECRET')
    w.file('/proj/x', 'fine')
    w.on((m) => {
      if (m === 'open') { w.nodes.delete('/proj/x'); w.links.set('/proj/x', '/outside/secret') }
      if (m === 'opened') { w.links.delete('/proj/x'); w.file('/proj/x', 'fine') }
    })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['x'] }, w.deps)).toEqual({ ok: false, message: '"x" changed while it was being read' })
    expect(w.reads).toEqual([])
  })

  it('a name that is a link by the time it is opened is refused by the open, which does not follow it there, and nothing is read', async () => {
    // A plain file when looked at; a link when opened. Linux and macOS refuse
    // to open a link at the name itself for the app (ELOOP).
    const w = world()
    w.file('/proj/x', 'fine')
    const eloop = Object.assign(new Error('ELOOP'), { code: 'ELOOP' })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['x'] }, { ...w.deps, open: async () => { throw eloop } })).toEqual({ ok: false, message: '"x" changed while it was being read' })
    expect(w.reads).toEqual([])
  })

  it('a name swapped twice is refused: a plain file while its real path is found, a link out again when the name there is checked', async () => {
    // Opened as a link to a file outside; a plain file in the project when the
    // real path is looked up; the link again when the name at it is checked.
    // The check does not follow that link, so it does not see the outside file.
    const w = world()
    w.file('/outside/secret', 'SECRET')
    w.file('/proj/x', 'fine')
    let opened = false
    w.on((m, p) => {
      if (m === 'open') { w.nodes.delete('/proj/x'); w.links.set('/proj/x', '/outside/secret') }
      if (m === 'opened') { opened = true; w.links.delete('/proj/x'); w.file('/proj/x', 'fine') }
      if (m === 'lstat' && p === '/proj/x' && opened) { w.nodes.delete('/proj/x'); w.links.set('/proj/x', '/outside/secret') }
    })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['x'] }, w.deps)).toEqual({ ok: false, message: '"x" changed while it was being read' })
    expect(w.reads).toEqual([])
  })

  it('a name made a second name of the opened file before the check is refused: the file must still have one name', async () => {
    // Opened as a link to a file outside (one name then); before its real path
    // is found the name becomes a hard link to that same file, in the project.
    const w = world()
    w.file('/outside/secret', 'SECRET')
    const secret = w.nodes.get('/outside/secret')!
    w.file('/proj/x', 'fine')
    w.on((m, p) => {
      if (m === 'open') { w.nodes.delete('/proj/x'); w.links.set('/proj/x', '/outside/secret') }
      if (m === 'realpath' && p === '/proj/x') { w.links.delete('/proj/x'); w.nodes.set('/proj/x', secret); secret.nlink = 2 }
    })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['x'] }, w.deps)).toEqual({ ok: false, message: '"x" changed while it was being read' })
    expect(w.reads).toEqual([])
  })

  it('with the open file\'s own real path (as Linux gives it), a folder changed after the check is judged by where the file is', async () => {
    // A real folder in the project when looked at; a link out of it when the
    // name is opened; a real one again while the name could be looked up, and
    // the link again when the name is checked. The open file's own path is outside.
    const w = world('linux', { fdPaths: true })
    w.file('/outside/f', 'SECRET')
    w.file('/proj/sub/f', 'fine')
    let opened = false
    w.on((m, p) => {
      if (m === 'open') w.links.set('/proj/sub', '/outside')
      if (m === 'opened') { opened = true; w.links.delete('/proj/sub'); w.file('/proj/sub/f', 'fine') }
      if (m === 'lstat' && p === '/proj/sub/f' && opened) w.links.set('/proj/sub', '/outside')
    })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['sub/f'] }, w.deps)).toEqual({ ok: false, message: '"sub/f" is outside the project' })
    expect(w.reads).toEqual([])
    // And a plain file in the project is still read that way.
    const ok = world('linux', { fdPaths: true })
    ok.file('/proj/a.ts', 'a')
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['a.ts'] }, ok.deps)).toEqual({ ok: true, files: [{ path: 'a.ts', text: 'a' }] })
  })

  it('a folder, a pipe or a device is refused before it is opened; a missing name says so', async () => {
    const w = world()
    w.nodes.set('/proj/dir', { kind: 'dir', content: Buffer.alloc(0), dev: 1n, ino: 50n, nlink: 2 })
    w.nodes.set('/proj/fifo', { kind: 'fifo', content: Buffer.alloc(0), dev: 1n, ino: 51n, nlink: 1 })
    w.nodes.set('/proj/tty', { kind: 'device', content: Buffer.alloc(0), dev: 1n, ino: 52n, nlink: 1 })
    w.file('/proj/a.ts', 'a')
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['dir'] }, w.deps)).toEqual({ ok: false, message: '"dir" is a folder; name files' })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['fifo'] }, w.deps)).toEqual({ ok: false, message: '"fifo" is not a file; name files' })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['tty'] }, w.deps)).toEqual({ ok: false, message: '"tty" is not a file; name files' })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['gone.ts'] }, w.deps)).toEqual({ ok: false, message: '"gone.ts" was not found' })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['a.ts/b'] }, w.deps)).toEqual({ ok: false, message: '"a.ts/b" was not found' })
    expect(w.deps.open).not.toHaveBeenCalled()
    // What it is when opened is checked again: a plain file when looked at,
    // a pipe or a folder when opened.
    w.file('/proj/p', 'p')
    w.file('/proj/d', 'd')
    w.on((m, p) => {
      if (m === 'open' && p === '/proj/p') w.nodes.set('/proj/p', { kind: 'fifo', content: Buffer.alloc(0), dev: 1n, ino: 53n, nlink: 1 })
      if (m === 'open' && p === '/proj/d') w.nodes.set('/proj/d', { kind: 'dir', content: Buffer.alloc(0), dev: 1n, ino: 54n, nlink: 2 })
    })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['p'] }, w.deps)).toEqual({ ok: false, message: '"p" is not a file; name files' })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['d'] }, w.deps)).toEqual({ ok: false, message: '"d" is a folder; name files' })
    // An open that fails says why, as well as it can.
    const isDir = Object.assign(new Error('EISDIR'), { code: 'EISDIR' })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['a.ts'] }, { ...w.deps, open: async () => { throw isDir } })).toEqual({ ok: false, message: '"a.ts" is a folder; name files' })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['a.ts'] }, { ...w.deps, open: async () => { throw new Error('EACCES') } })).toEqual({ ok: false, message: '"a.ts" could not be read' })
    expect(w.reads).toEqual([])
  })

  it('binary content is named, not sent; only its name counts toward the bound', async () => {
    const w = world()
    w.file('/proj/logo.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.alloc(REVIEW_DIFF_MAX_BYTES * 2, 1)]))
    w.file('/proj/a.ts', 'a')
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['logo.png', 'a.ts'] }, w.deps)).toEqual({ ok: true, files: [{ path: 'logo.png', binary: true }, { path: 'a.ts', text: 'a' }] })
  })

  it('all of it together is bounded as a diff is: at the bound it is sent whole, past it the request is refused, never cut', async () => {
    // The bound counts the names on the scope line and the FILE lines too.
    const room = REVIEW_DIFF_MAX_BYTES - scopeBytes(['a', 'b']) - lineBytes('a') - lineBytes('b')
    const w = world()
    w.file('/proj/a', 'a'.repeat(Math.floor(room / 2)))
    w.file('/proj/b', 'b'.repeat(room - Math.floor(room / 2)))
    w.file('/proj/c', 'c')
    const whole = await produceReviewFiles({ cwd: '/proj', paths: ['a', 'b'] }, w.deps)
    expect(whole.ok && whole.files.map((f) => ('text' in f ? f.text.length : -1))).toEqual([Math.floor(room / 2), room - Math.floor(room / 2)])
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['a', 'b', 'c'] }, w.deps)).toEqual(TOO_LARGE)
  })

  it('each text file is read into a buffer of its own size (one byte more, to see it grow), and one that grew is refused, never cut', async () => {
    const w = world()
    w.file('/proj/a.ts', 'abc')
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['a.ts'] }, w.deps)).toEqual({ ok: true, files: [{ path: 'a.ts', text: 'abc' }] })
    // The second read is the text's own: its size and one byte, not the whole bound.
    expect(w.readSizes[1]).toBe(4)
    // A file that grew past the size it reported is refused.
    const g = world()
    g.file('/proj/grows', 'g'.repeat(REVIEW_DIFF_MAX_BYTES + 10))
    const open = g.deps.open
    g.deps.open = async (p) => { const h = await open(p); return { ...h, stat: async () => ({ ...(await h.stat()), size: 1 }) } }
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['grows'] }, g.deps)).toEqual({ ok: false, message: '"grows" changed while it was being read' })
  })

  it('many empty or binary files, or one file named again and again, are bounded too: the names count', async () => {
    const w = world()
    const names = Array.from({ length: 8000 }, (_, i) => `e${String(i).padStart(4, '0')}`)
    for (const name of names) w.file(`/proj/${name}`, '')
    expect(scopeBytes(names) + names.reduce((s, name) => s + lineBytes(name), 0)).toBeGreaterThan(REVIEW_DIFF_MAX_BYTES)
    expect(await produceReviewFiles({ cwd: '/proj', paths: names }, w.deps)).toEqual(TOO_LARGE)
    const b = world()
    for (const name of names) b.file(`/proj/${name}`, Buffer.from([0]))
    expect(await produceReviewFiles({ cwd: '/proj', paths: names }, b.deps)).toEqual(TOO_LARGE)
    // The same file named past the bound is refused before anything is opened.
    const d = world()
    d.file('/proj/a.ts', 'a')
    expect(await produceReviewFiles({ cwd: '/proj', paths: Array<string>(100000).fill('./a.ts') }, d.deps)).toEqual(TOO_LARGE)
    expect(d.deps.open).not.toHaveBeenCalled()
  })

  it('a file named twice is sent once', async () => {
    const w = world()
    w.file('/proj/a.ts', 'a')
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['a.ts', './a.ts'] }, w.deps)).toEqual({ ok: true, files: [{ path: 'a.ts', text: 'a' }] })
  })

  it('stops when the review is cancelled, and says when the project itself cannot be read', async () => {
    const w = world()
    w.file('/proj/a.ts', 'a')
    const ac = new AbortController()
    ac.abort()
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['a.ts'], signal: ac.signal }, w.deps)).toEqual({ ok: false, message: 'the review was cancelled' })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['a.ts'] }, { ...w.deps, realpath: async () => { throw new Error('EACCES') } })).toEqual({ ok: false, message: 'the project folder could not be read' })
    expect(w.reads).toEqual([])
  })

  it('Windows paths: a file under the project is inside it whatever the case of its letters; a name is shown with / separators', async () => {
    const w = world('win32')
    w.nodes.set('C:\\Proj', { kind: 'dir', content: Buffer.alloc(0), dev: 1n, ino: 2n, nlink: 1 })
    w.file('C:\\Proj\\src\\a.ts', 'a')
    // The project's real path in other letter case: the file is still inside it.
    w.deps.realpath = vi.fn(async (p: string) => (p.toLowerCase() === 'c:\\proj' ? 'c:\\PROJ' : w.real(p)))
    expect(await produceReviewFiles({ cwd: 'C:\\Proj', paths: ['src\\a.ts'] }, w.deps)).toEqual({ ok: true, files: [{ path: 'src/a.ts', text: 'a' }] })
    w.file('D:\\other\\s', 'SECRET')
    w.links.set('C:\\Proj\\j', 'D:\\other')
    expect(await produceReviewFiles({ cwd: 'C:\\Proj', paths: ['j\\s'] }, w.deps)).toEqual(through('"j/s"', '"j"'))
  })
})

describe('the files of a paths review are given up when they take too long or the review is cancelled', () => {
  afterEach(() => { vi.useRealTimers() })
  /** Never settles, as a read on a network folder gone stale can. */
  const never = <T>() => new Promise<T>(() => {})

  // The model's close waits for a read still under way, as Node's does, so a
  // request stopped during a hung read returns at once only because a call
  // made after the stop (the file's close, here) is given up straight away
  // (review-diff.ts, step()).

  it('a read that never returns is given up at the time bound, though the file\'s close waits for that read, as Node\'s does', async () => {
    vi.useFakeTimers()
    const w = world()
    w.file('/proj/a.ts', 'a')
    w.readWith(() => never<Buffer>())
    let out: unknown = 'still reading'
    void produceReviewFiles({ cwd: '/proj', paths: ['a.ts'] }, w.deps).then((r) => { out = r })
    await vi.advanceTimersByTimeAsync(REVIEW_FILES_TIMEOUT_MS - 1)
    expect(out).toBe('still reading')
    await vi.advanceTimersByTimeAsync(1)
    expect(out).toEqual(TIMED_OUT)
    // The close was asked for; it closes the file only once the read returns.
    expect(w.closing).toEqual(['/proj/a.ts'])
    expect(w.closed).toEqual([])
  })

  it('a look at a name, or an open, that never returns is given up too; a file opened after that is closed', async () => {
    vi.useFakeTimers()
    const w = world()
    w.file('/proj/a.ts', 'a')
    let out: unknown = 'still reading'
    void produceReviewFiles({ cwd: '/proj', paths: ['a.ts'] }, { ...w.deps, lstat: () => never() }).then((r) => { out = r })
    await vi.advanceTimersByTimeAsync(REVIEW_FILES_TIMEOUT_MS)
    expect(out).toEqual(TIMED_OUT)
    // An open that returns only after the bound: its file is closed then.
    let late!: (h: ReviewFileHandle) => void
    const handle = await w.deps.open('/proj/a.ts')
    const close = vi.fn(async () => {})
    out = 'still reading'
    void produceReviewFiles({ cwd: '/proj', paths: ['a.ts'] }, { ...w.deps, open: () => new Promise<ReviewFileHandle>((r) => { late = r }) }).then((r) => { out = r })
    await vi.advanceTimersByTimeAsync(REVIEW_FILES_TIMEOUT_MS)
    expect(out).toEqual(TIMED_OUT)
    late({ ...handle, close })
    await vi.advanceTimersByTimeAsync(0)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a cancel during a read that never returns stops the request at once, though the file\'s close waits for that read', async () => {
    const w = world()
    w.file('/proj/a.ts', 'a')
    const ac = new AbortController()
    w.readWith(() => { ac.abort(); return never<Buffer>() })
    let out: unknown = 'still reading'
    const run = produceReviewFiles({ cwd: '/proj', paths: ['a.ts'], signal: ac.signal }, w.deps).then((r) => { out = r })
    await Promise.race([run, new Promise((r) => setTimeout(r, 1000))])
    expect(out).toEqual({ ok: false, message: 'the review was cancelled' })
    expect(w.closing).toEqual(['/proj/a.ts'])
    expect(w.closed).toEqual([])
  })

  it('a file call left running by a stopped request holds back every new request until it returns: the threads the app reads files on are few', async () => {
    vi.useFakeTimers()
    const w = world()
    w.file('/proj/a.ts', 'a')
    w.file('/proj/b.ts', 'b')
    const backlog: ReviewFilesBacklog = { count: 0 }
    let release!: (b: Buffer) => void
    w.readWith(() => new Promise<Buffer>((r) => { release = r }))
    let out: unknown = 'still reading'
    void produceReviewFiles({ cwd: '/proj', paths: ['a.ts'] }, { ...w.deps, backlog }).then((r) => { out = r })
    await vi.advanceTimersByTimeAsync(REVIEW_FILES_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(out).toEqual(TIMED_OUT)
    // Two calls are left: the read, and the file's close, which waits for it.
    expect(backlog.count).toBe(2)
    // The next request, for any file, is refused before anything is looked at.
    vi.mocked(w.deps.lstat).mockClear()
    vi.mocked(w.deps.realpath).mockClear()
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['b.ts'] }, { ...w.deps, backlog })).toEqual({ ok: false, message: REVIEW_FILES_BACKLOG_MESSAGE })
    expect(w.deps.lstat).not.toHaveBeenCalled()
    expect(w.deps.realpath).not.toHaveBeenCalled()
    // Once that read returns, the file is closed and files are read again.
    release(Buffer.from('a'))
    w.readWith(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(w.closed).toEqual(['/proj/a.ts'])
    expect(backlog.count).toBe(0)
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['b.ts'] }, { ...w.deps, backlog })).toEqual({ ok: true, files: [{ path: 'b.ts', text: 'b' }] })
  })

  it('a cancelled request counts its calls left running the same way', async () => {
    const w = world()
    w.file('/proj/a.ts', 'a')
    const backlog: ReviewFilesBacklog = { count: 0 }
    const ac = new AbortController()
    let release!: (b: Buffer) => void
    w.readWith(() => { ac.abort(); return new Promise<Buffer>((r) => { release = r }) })
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['a.ts'], signal: ac.signal }, { ...w.deps, backlog })).toEqual({ ok: false, message: 'the review was cancelled' })
    await new Promise((r) => setTimeout(r, 0))
    expect(backlog.count).toBe(2)
    expect(await produceReviewFiles({ cwd: '/proj', paths: ['a.ts'] }, { ...w.deps, backlog })).toEqual({ ok: false, message: REVIEW_FILES_BACKLOG_MESSAGE })
    release(Buffer.from('a'))
    await new Promise((r) => setTimeout(r, 0))
    expect(w.closed).toEqual(['/proj/a.ts'])
    expect(backlog.count).toBe(0)
  })
})

describe('the files of a paths review, from a real folder (plain files only)', () => {
  let dir = ''
  afterEach(() => { vi.restoreAllMocks(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })

  it('reads plain files, refuses a folder and says when a name is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-review-files-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'a.ts'), 'const a = 1\n')
    writeFileSync(join(dir, 'src', 'b.ts'), 'export {}\r\n')
    expect(await produceReviewFiles({ cwd: dir, paths: ['a.ts', 'src/b.ts'] }, defaultReviewFilesDeps())).toEqual({ ok: true, files: [{ path: 'a.ts', text: 'const a = 1\n' }, { path: 'src/b.ts', text: 'export {}\r\n' }] })
    expect(await produceReviewFiles({ cwd: dir, paths: ['src'] }, defaultReviewFilesDeps())).toEqual({ ok: false, message: '"src" is a folder; name files' })
    expect(await produceReviewFiles({ cwd: dir, paths: ['nope.ts'] }, defaultReviewFilesDeps())).toEqual({ ok: false, message: '"nope.ts" was not found' })
  })

  it('an open file says its own real path on Linux only (/proc/self/fd), and it is the file\'s real path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-review-files-'))
    const f = join(dir, 'a.ts')
    writeFileSync(f, 'a')
    for (const [platform, has] of [['linux', true], ['darwin', false], ['win32', false]] as const) {
      const h = await defaultReviewFilesDeps(platform).open(f)
      try {
        expect(typeof h.realpath === 'function', platform).toBe(has)
        if (has && process.platform === 'linux') expect(await h.realpath!()).toBe(realpathSync(f))
      } finally { await h.close() }
    }
  })

  // The checks hold only if the app's own look at a name does not follow a
  // link: a stat there would see the file a link leads to, not the link.
  const linkStats = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true, dev: 7n, ino: 70n, nlink: 1n }

  it('the app\'s own look at a name does not follow it: it is lstat, never stat', async () => {
    const lstat = vi.spyOn(fsp, 'lstat').mockImplementation((async () => linkStats) as never)
    const stat = vi.spyOn(fsp, 'stat')
    expect(await defaultReviewFilesDeps().lstat(join(tmpdir(), 'ccc-review-files-none', 'x'))).toEqual({ isFile: false, isDirectory: false, isSymbolicLink: true, dev: 7n, ino: 70n, nlink: 1 })
    expect(lstat).toHaveBeenCalledWith(join(tmpdir(), 'ccc-review-files-none', 'x'), { bigint: true })
    expect(stat.mock.calls.filter(([p]) => String(p).includes('ccc-review-files-none'))).toEqual([])
  })

  it('a name the system says is a link is refused by the app\'s own reader, and never opened', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-review-files-'))
    const target = join(dir, 'a.ts')
    writeFileSync(target, 'SECRET')
    const realLstat = fsp.lstat.bind(fsp)
    vi.spyOn(fsp, 'lstat').mockImplementation((async (p: string, o: unknown) => (resolve(p) === resolve(target) ? linkStats : realLstat(p, o as never))) as never)
    const open = vi.spyOn(fsp, 'open')
    const r = await produceReviewFiles({ cwd: dir, paths: ['a.ts'] }, defaultReviewFilesDeps())
    expect(r).toEqual(isLink('"a.ts"'))
    expect(open.mock.calls.filter(([p]) => resolve(String(p)) === resolve(target))).toEqual([])
  })

  it('the app opens a named file for reading only, never waiting on a pipe and never through a link at the name, where the system has the flags', async () => {
    // Linux's values; Windows has O_RDONLY (0) only.
    const linux = { O_RDONLY: 0, O_NONBLOCK: 0o4000, O_NOCTTY: 0o400, O_NOFOLLOW: 0o400000 }
    expect(reviewOpenFlags(linux)).toBe(0o4000 | 0o400 | 0o400000)
    expect(reviewOpenFlags({ O_RDONLY: 0 })).toBe(0)
    dir = mkdtempSync(join(tmpdir(), 'ccc-review-files-'))
    const f = join(dir, 'a.ts')
    writeFileSync(f, 'a')
    const open = vi.spyOn(fsp, 'open')
    const h = await defaultReviewFilesDeps().open(f)
    await h.close()
    expect(open).toHaveBeenCalledWith(f, reviewOpenFlags())
  })

  it('the app\'s own reader counts the file calls left running across all its requests, not per request', () => {
    const backlog = defaultReviewFilesDeps().backlog
    expect(backlog).toBeDefined()
    expect(defaultReviewFilesDeps('linux').backlog).toBe(backlog)
    expect(backlog!.count).toBe(0)
  })
})
