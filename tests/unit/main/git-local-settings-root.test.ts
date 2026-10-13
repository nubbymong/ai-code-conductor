// The canonical git root rule (src/main/git-local-settings-root.ts), run both
// ways: awaited, as the managed-launch gate runs it, and synchronously, as the
// session hooks writer runs it. One rule, so the two must always agree.
//
// The full layout matrix (symlinked .git entries, bare repositories, links the
// CLI refuses) is in tests/wp1/managed-launch.test.ts, which plants links and
// runs on CI and the VM only. These cases use plain folders and files in a
// fresh temp folder, so they run anywhere. On a host without user ids
// (Windows) process.geteuid is set to answer the uid the temp folder reports.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  posixCanonicalLocalSettingsRoot,
  posixCanonicalLocalSettingsRootSync,
  canonicalGitRootOf,
  readFully,
  GitPointerChangedError,
} from '../../../src/main/git-local-settings-root'

let tmp = ''
let home = ''
let saved: PropertyDescriptor | undefined

beforeEach(() => {
  // The real path: the rule walks from the real path of the working folder,
  // and the temp folder is itself reached through a link on some hosts
  // (macOS /var), so the roots it answers are real paths.
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'git-root-')))
  home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  saved = Object.getOwnPropertyDescriptor(process, 'geteuid')
  const uid = fs.statSync(tmp).uid
  Object.defineProperty(process, 'geteuid', { value: () => uid, configurable: true, writable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (saved) Object.defineProperty(process, 'geteuid', saved)
  else delete (process as unknown as Record<string, unknown>).geteuid
  if (tmp && path.basename(tmp).startsWith('git-root-')) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Both answers for `cwd`; they must be the same. */
async function both(cwd: string): Promise<string | null> {
  const awaited = await posixCanonicalLocalSettingsRoot(cwd, home)
  const sync = posixCanonicalLocalSettingsRootSync(cwd, home)
  expect(sync, `sync and awaited answers for ${cwd}`).toBe(awaited)
  return awaited
}

function checkout(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
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

describe('the canonical git root, awaited and synchronous', () => {
  it('a subfolder of a checkout: the checkout root; the root itself: none', async () => {
    const repo = path.join(tmp, 'repo')
    checkout(repo)
    const sub = path.join(repo, 'a', 'b')
    fs.mkdirSync(sub, { recursive: true })
    expect(await both(sub)).toBe(repo)
    expect(await both(repo)).toBeNull()
  })

  it('a linked worktree and a folder in it: the main checkout', async () => {
    const main = path.join(tmp, 'repo')
    checkout(main)
    const wt = path.join(tmp, 'wt')
    linkedWorktree(main, wt)
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    expect(await canonicalGitRootOf(wt)).toBe(main)
    expect(await both(wt)).toBe(main)
    expect(await both(path.join(wt, 'src'))).toBe(main)
  })

  it('a worktree pointer that does not point back, or a folder outside any checkout: none', async () => {
    const main = path.join(tmp, 'repo')
    checkout(main)
    const wt = path.join(tmp, 'wt')
    const gitdir = linkedWorktree(main, wt)
    fs.mkdirSync(path.join(tmp, 'other', '.git'), { recursive: true })
    fs.writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(tmp, 'other', '.git')}\n`)
    expect(await both(wt)).toBeNull()
    const loose = path.join(tmp, 'loose')
    fs.mkdirSync(loose, { recursive: true })
    expect(await both(loose)).toBeNull()
  })

  it('a checkout that is the home folder: none (the CLI skips it)', async () => {
    checkout(home)
    const sub = path.join(home, 'proj')
    fs.mkdirSync(sub, { recursive: true })
    expect(await both(sub)).toBeNull()
  })

  it('a root owned by another user: none', async () => {
    const repo = path.join(tmp, 'repo')
    checkout(repo)
    const sub = path.join(repo, 'pkg')
    fs.mkdirSync(sub, { recursive: true })
    const uid = fs.statSync(tmp).uid
    Object.defineProperty(process, 'geteuid', { value: () => uid + 1, configurable: true, writable: true })
    expect(await both(sub)).toBeNull()
  })

  it('no user ids (Windows): none, whatever the layout', async () => {
    delete (process as unknown as Record<string, unknown>).geteuid
    const repo = path.join(tmp, 'repo')
    checkout(repo)
    const sub = path.join(repo, 'pkg')
    fs.mkdirSync(sub, { recursive: true })
    expect(await both(sub)).toBeNull()
  })

  // The CLI's working folder is the native real path of process.cwd(), and
  // it walks up from there. A session folder reached through a link that
  // lands inside another checkout belongs to that checkout. No link is made
  // on this host: `link` is a plain folder, and the real path a link there
  // would have is answered by the real-path calls of both forms (the
  // real-link layout is in tests/wp1/managed-launch.test.ts, CI and VM only).
  // Mutation to prove this can fail: walk up from path.resolve(cwd).
  it('a session folder reached through a link into another checkout: that checkout\'s root, in both forms', async () => {
    const a = path.join(tmp, 'a')
    checkout(a)
    const b = path.join(tmp, 'b')
    checkout(b)
    const lands = path.join(b, 'sub')
    fs.mkdirSync(lands, { recursive: true })
    const link = path.join(a, 'link')
    fs.mkdirSync(link, { recursive: true })
    // As a plain folder it is in checkout A.
    expect(await both(link)).toBe(a)
    let target = lands
    const realNative = fs.realpathSync.native
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike, o?: unknown) =>
      path.resolve(String(p)) === link ? target : (realNative as (...x: unknown[]) => string)(p, o)) as typeof fs.realpathSync.native)
    const realAsync = fs.promises.realpath
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (p: fs.PathLike, o?: unknown) =>
      path.resolve(String(p)) === link ? target : (realAsync as (...x: unknown[]) => Promise<string>)(p, o)) as typeof fs.promises.realpath)
    expect(await both(link)).toBe(b)
    // A link to the other checkout's root itself: that root is the working
    // folder, so no separate root.
    target = b
    expect(await both(link)).toBeNull()
  })

  it('a worktree pointer that changes while it is read: both forms throw the same error', async () => {
    const main = path.join(tmp, 'repo')
    checkout(main)
    const wt = path.join(tmp, 'wt')
    linkedWorktree(main, wt)
    const pointer = path.join(wt, '.git')
    // A read that ends early: fewer bytes than the file measured.
    const syncFds = new Set<number>()
    const realOpenSync = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const fd = (realOpenSync as (...a: unknown[]) => number)(p, ...rest)
      if (String(p) === pointer) syncFds.add(fd)
      return fd
    }) as typeof fs.openSync)
    const realReadSync = fs.readSync
    vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, ...rest: unknown[]) =>
      syncFds.has(fd) ? 0 : (realReadSync as (...a: unknown[]) => number)(fd, ...rest)) as typeof fs.readSync)
    const realOpen = fs.promises.open
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      const h = await (realOpen as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest)
      if (String(p) !== pointer) return h
      return Object.assign(Object.create(h) as fs.promises.FileHandle, {
        stat: () => h.stat(),
        read: async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) }),
        close: () => h.close(),
      })
    }) as typeof fs.promises.open)
    expect(() => posixCanonicalLocalSettingsRootSync(wt, home)).toThrow(GitPointerChangedError)
    await expect(posixCanonicalLocalSettingsRoot(wt, home)).rejects.toThrow(GitPointerChangedError)
  })
})

describe('readFully', () => {
  it('reads to the end of the file through short reads', async () => {
    const f = path.join(tmp, 'f.txt')
    fs.writeFileSync(f, 'abcdefghij')
    const h = await fs.promises.open(f, 'r')
    try {
      const realRead = h.read.bind(h)
      const oneByte = Object.assign(Object.create(h) as fs.promises.FileHandle, {
        read: (buf: Buffer, offset: number, _length: number, position: number) => realRead(buf, offset, 1, position),
      })
      const buf = Buffer.alloc(32)
      expect(await readFully(oneByte, buf)).toBe(10)
      expect(buf.toString('utf8', 0, 10)).toBe('abcdefghij')
    } finally {
      await h.close()
    }
  })
})
