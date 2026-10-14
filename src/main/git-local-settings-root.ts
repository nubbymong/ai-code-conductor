// Where Claude Code reads a working directory's `settings.local.json` from on
// POSIX: the CANONICAL GIT ROOT rule of the pinned 2.1.278, mirrored once and
// shared by its two readers.
//
//   - the managed-launch project-settings GATE (managed-launch-diagnostics.ts),
//     which must read the files the CLI reads before it lets a launch start;
//   - the session hooks writer (hooks/session-hooks-writer.ts), which lifts the
//     hooks the CLI would apply into a session's --settings file, because a
//     --settings `hooks` key replaces them.
//
// Both must answer from the SAME rule, so it lives here and nowhere else. It
// was moved from managed-launch-diagnostics.ts, together with readFully (the
// gate's bounded settings read), AND rewritten as generator steps run by
// runSync/runAsync (below). The move kept the algorithm and its decisions:
// each `await` became a `yield*`, and posixCanonicalLocalSettingsRoot takes
// the home folder as an optional parameter (production callers omit it and
// get os.homedir(), as before). Its full layout matrix is still driven
// through that module's seams (tests/wp1/managed-launch.test.ts, which runs
// on CI and the VM only), and tests/unit/main/git-local-settings-root.test.ts
// runs both forms, awaited and synchronous, on plain folders anywhere.
//
// ONE ALGORITHM, TWO WAYS TO RUN IT. The gate awaits it (a working directory on
// an unreachable share must not block the main thread; see the scan notes in
// managed-launch-diagnostics.ts). The hooks writer runs inside the synchronous
// spawn path, which already reads the session folder's own `.claude`
// synchronously, so it needs a synchronous answer. Each step is therefore a
// generator that YIELDS the filesystem call it needs (`FsCall`) and receives
// the answer; `runAsync` answers through `fs.promises`, `runSync` through the
// synchronous `fs` calls. Every decision is made in the one generator body,
// so the two cannot drift apart. The calls are looked up on the `fs` module
// at the moment they run, so a test that spies on `fs.promises.open` or
// `fs.lstatSync` still sees every call.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripSpoofableText } from '../shared/safe-text'

/** A file, as `runSync` opens it (a descriptor) or as `runAsync` does (a handle). */
type OpenFile = number | fs.promises.FileHandle

/** One filesystem call a step needs answered. */
type FsCall =
  | { call: 'lstat'; p: string }
  | { call: 'stat'; p: string }
  | { call: 'realpath'; p: string }
  | { call: 'readlink'; p: string }
  | { call: 'open'; p: string; flags: number }
  | { call: 'fstat'; file: OpenFile }
  | { call: 'read'; file: OpenFile; buf: Buffer; offset: number; length: number; position: number }
  | { call: 'close'; file: OpenFile }

/** A step: yields the calls it needs, returns `T`. */
type Io<T> = Generator<FsCall, T, unknown>

function* lstatIo(p: string): Io<fs.Stats> { return (yield { call: 'lstat', p }) as fs.Stats }
function* statIo(p: string): Io<fs.Stats> { return (yield { call: 'stat', p }) as fs.Stats }
function* realpathIo(p: string): Io<string> { return (yield { call: 'realpath', p }) as string }
function* readlinkIo(p: string): Io<Buffer> { return (yield { call: 'readlink', p }) as Buffer }
function* openIo(p: string, flags: number): Io<OpenFile> { return (yield { call: 'open', p, flags }) as OpenFile }
function* fstatIo(file: OpenFile): Io<fs.Stats> { return (yield { call: 'fstat', file }) as fs.Stats }
function* readIo(file: OpenFile, buf: Buffer, offset: number, length: number, position: number): Io<number> {
  return (yield { call: 'read', file, buf, offset, length, position }) as number
}
function* closeIo(file: OpenFile): Io<void> { yield { call: 'close', file } }

function answerSync(c: FsCall): unknown {
  switch (c.call) {
    case 'lstat': return fs.lstatSync(c.p)
    case 'stat': return fs.statSync(c.p)
    // The native realpath, as fs.promises.realpath is.
    case 'realpath': return fs.realpathSync.native(c.p)
    case 'readlink': return fs.readlinkSync(c.p, { encoding: 'buffer' })
    case 'open': return fs.openSync(c.p, c.flags)
    case 'fstat': return fs.fstatSync(c.file as number)
    case 'read': return fs.readSync(c.file as number, c.buf, c.offset, c.length, c.position)
    case 'close': return fs.closeSync(c.file as number)
  }
}

async function answerAsync(c: FsCall): Promise<unknown> {
  switch (c.call) {
    case 'lstat': return fs.promises.lstat(c.p)
    case 'stat': return fs.promises.stat(c.p)
    case 'realpath': return fs.promises.realpath(c.p)
    case 'readlink': return fs.promises.readlink(c.p, { encoding: 'buffer' })
    case 'open': return fs.promises.open(c.p, c.flags)
    case 'fstat': return (c.file as fs.promises.FileHandle).stat()
    case 'read': return (await (c.file as fs.promises.FileHandle).read(c.buf, c.offset, c.length, c.position)).bytesRead
    case 'close': return (c.file as fs.promises.FileHandle).close()
  }
}

/** Run a step with synchronous calls. A call that throws is thrown INTO the
 *  step, where its own try/catch decides, exactly as an awaited rejection is. */
function runSync<T>(step: Io<T>): T {
  let next = step.next()
  while (!next.done) {
    let answer: unknown
    try {
      answer = answerSync(next.value)
    } catch (err) {
      next = step.throw(err)
      continue
    }
    next = step.next(answer)
  }
  return next.value
}

/** Run a step with `fs.promises` calls. */
async function runAsync<T>(step: Io<T>): Promise<T> {
  let next = step.next()
  while (!next.done) {
    let answer: unknown
    try {
      answer = await answerAsync(next.value)
    } catch (err) {
      next = step.throw(err)
      continue
    }
    next = step.next(answer)
  }
  return next.value
}

/** A path as it may be written to the app log (see ../shared/safe-text.ts). */
const describePath = (p: string): string => stripSpoofableText(p, 300)

/** The most a `.git` pointer file or a `commondir` / `gitdir` file inside a
 *  linked worktree's git directory is read: they hold one path each. */
const MAX_GIT_POINTER_BYTES = 4096

/**
 * Read `file` from offset 0 into `buf` until end of file or until `buf` is
 * full, and return how many bytes arrived.
 *
 * ONE `FileHandle.read` IS A PREFIX, NOT THE FILE. A read may legally return
 * fewer bytes than asked for -- routinely on network and FUSE filesystems, and
 * on any file a signal or a concurrent writer interrupts -- and the gate used to
 * take the first answer as the whole file: a valid prefix was parsed (or failed
 * to parse, and so reported nothing) while the unread bytes carried the
 * authority setting (exact-head review, BLOCKER). The loop keeps the fixed
 * allocation: the buffer is still the bound, so a file that grows mid-read
 * stops at `buf.length`, and the caller sizes it at cap + 1 to see the growth.
 * Every iteration advances by at least one byte or ends the loop, so a
 * filesystem that returns one byte per read costs up to cap + 1 reads: bounded,
 * and the launch never waits on it past the gate's deadline, but the scan holds
 * its thread-ceiling slot until it settles (code-quality review, noted).
 */
function* readFullyIo(file: OpenFile, buf: Buffer): Io<number> {
  let total = 0
  while (total < buf.length) {
    const bytesRead = yield* readIo(file, buf, total, buf.length - total, total)
    if (bytesRead <= 0) break
    total += bytesRead
  }
  return total
}

/** `readFullyIo` on an open `fs.promises` handle (the gate's settings read). */
export function readFully(handle: fs.promises.FileHandle, buf: Buffer): Promise<number> {
  return runAsync(readFullyIo(handle, buf))
}

/** A git pointer file that changed while it was being read. Not a miss: a miss
 *  leaves the root at the worktree, and the root the CLI reads may be the main
 *  checkout, so a scan that meets this reports `unreadable` instead of reading
 *  one root and calling the other clean. */
export class GitPointerChangedError extends Error {}

/** The text of a small pointer file, or null when it is absent, a symlink,
 *  not a regular file, or larger than a pointer file can be. Bounded as the
 *  settings read is: a fixed buffer, read to end of file (a short read would
 *  hand the worktree rule a truncated path, and the root the CLI uses would go
 *  unread), and a byte count that differs from the measured size -- the file
 *  changed mid-read, grown past the cap or not -- throws
 *  `GitPointerChangedError` rather than returning a spliced path or a miss
 *  (independent review of the exact-head fix: this read had the loop but not
 *  the settings read's size check). */
function* readGitPointerIo(file: string, followSymlink = false): Io<string | null> {
  let handle: OpenFile | null = null
  try {
    if (!followSymlink && (yield* lstatIo(file)).isSymbolicLink()) return null
    handle = yield* openIo(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
    const stat = yield* fstatIo(handle)
    if (!stat.isFile() || stat.size > MAX_GIT_POINTER_BYTES) return null
    const buf = Buffer.allocUnsafe(MAX_GIT_POINTER_BYTES + 1)
    const bytesRead = yield* readFullyIo(handle, buf)
    if (bytesRead !== stat.size) throw new GitPointerChangedError(`${describePath(file)} changed while it was being read`)
    return buf.toString('utf8', 0, bytesRead)
  } catch (err) {
    if (err instanceof GitPointerChangedError) throw err
    return null
  } finally {
    if (handle !== null) {
      try { yield* closeIo(handle) } catch { /* already closed */ }
    }
  }
}

/**
 * The CLI's root-entry predicate (`Ce` in the pinned 2.1.278; its walk `Kt`
 * asks it of `<dir>/.git` at every level): a directory or a regular file by
 * `lstat`; a SYMLINK only when its text is NUL-free valid UTF-8 (`lCt`), names
 * nothing on another host or a network mount (`Li`), every component of the
 * target -- and of every link met on the way, forty deep -- is a plain entry
 * (`Q` -> `re`), and the target is a directory or a regular file. A link the
 * CLI refuses is NOT a root, and the CLI walks past it to a higher one; the
 * first port of this followed every link with a bare `stat`, so it stopped at
 * a link the CLI skipped and never read the root the CLI used (adversarial
 * confirmation pass, MAJOR). Each helper below is named for the function it
 * transcribes; the two the win32/linux builds stub to false (`so`, `jt`, the
 * darwin volume rule) are left out and recorded as a macOS residual.
 */
function* isGitRootEntryIo(entry: string, dir: string): Io<boolean> {
  try {
    const st = yield* lstatIo(entry)
    if (st.isSymbolicLink()) {
      const target = yield* readLinkTextIo(entry)
      if (target === null) return false
      if (linkTargetIsElsewhere(target, dir)) return false
      if (!(yield* linkPathIsPlainIo(target, dir))) return false
      const real = yield* statIo(entry)
      return real.isDirectory() || real.isFile()
    }
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

/** `isGitRootEntryIo`, awaited (the gate's test seam). */
export function isGitRootEntry(entry: string, dir: string): Promise<boolean> {
  return runAsync(isGitRootEntryIo(entry, dir))
}

/** `lCt`: the link text, or null when it holds a NUL or is not valid UTF-8. */
function* readLinkTextIo(link: string): Io<string | null> {
  try {
    const raw = yield* readlinkIo(link)
    const text = raw.toString('utf8')
    if (text.includes(String.fromCharCode(0)) || !Buffer.from(text, 'utf8').equals(raw)) return null
    return text
  } catch {
    return null
  }
}

const DEVICE_PREFIX_RE = /^[\\/]\?\?[\\/]/
const UNC_DEVICE_RE = /^[\\/]{2}[?.][\\/]/
const DOT_SEGMENT_RE = /(^|[\\/])\.{1,2}[. ]*([\\/]|$)/
const ABSOLUTE_RE = /^(?:[/\\]|[A-Za-z]:[/\\])/
const ROOT_PREFIX_RE = /^(?:[/\\]{2}[^/\\]+[/\\][^/\\]+[/\\]?|[A-Za-z]:[/\\]|[/\\])/
const SEPARATORS_RE = /[/\\]+/
const TRAILING_SEPARATOR_RE = /[\\/]$/

/** `$5`: an NT object path (`\??\`), before or after win32 normalisation. */
function isNtObjectPath(t: string): boolean {
  return DEVICE_PREFIX_RE.test(t) || (t.includes('??') && DEVICE_PREFIX_RE.test(path.win32.normalize(t)))
}
/** `Nn`: two leading separators, or an NT object path. */
function isUncLike(t: string): boolean {
  return /^[\\/]{2}/.test(t) || isNtObjectPath(t)
}
/** `e$`: the UNC host, lower-cased; null for a device path that is not `UNC\`. */
function uncHostOf(t: string): string | null {
  if (/^[\\/]{2}[?.][\\/](?!unc[\\/])/i.test(t)) return null
  const m = t.match(/^[\\/]{2}(?:[?.][\\/]unc[\\/])?([^\\/]+)/i)
  return m?.[1]?.replace(/[A-Z]/g, (c) => c.toLowerCase()) ?? null
}
/** `_Se`: a UNC-like path that is a device path, has a dot segment, or names a host other than `base`'s. */
function isForeignUnc(t: string, base: string): boolean {
  if (!isUncLike(t)) return false
  if (UNC_DEVICE_RE.test(t) || isNtObjectPath(t)) return true
  if (DOT_SEGMENT_RE.test(t)) return true
  const host = uncHostOf(t)
  return host === null || host !== uncHostOf(base)
}
/** The segments of an absolute POSIX path with `.` and `..` folded, or null when it is not absolute. */
function foldedPosixSegments(t: string): string[] | null {
  if (!t.startsWith('/')) return null
  const out: string[] = []
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  return out
}
/** `FV`: under `/network` (case-insensitive) by its first folded segment. */
function isNetworkMount(t: string): boolean {
  if (!t.startsWith('/')) return false
  const out: string[] = []
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
    if (out.length === 1 && out[0].toLowerCase() === 'network') return true
  }
  return false
}
/** `QS`: exactly `/net`, the automounter root. */
function isNetRoot(t: string): boolean {
  const segs = foldedPosixSegments(t)
  return segs !== null && segs.length === 1 && segs[0].toLowerCase() === 'net'
}
/** `Li`: the link text, as written and as resolved against `dir`, is on another host or a network mount. */
function linkTargetIsElsewhere(text: string, dir: string): boolean {
  const resolved = path.resolve(dir, text)
  if (isForeignUnc(text, dir) || isForeignUnc(resolved, dir)) return true
  for (const o of [text, resolved]) if (isNetworkMount(o) || isNetRoot(o)) return true
  return false
}
/** `en`: the kind of an entry by `lstat`; any error but a missing path is `other`. */
function* entryKindIo(p: string): Io<'symlink' | 'file' | 'dir' | 'other' | 'absent'> {
  try {
    const st = yield* lstatIo(p)
    if (st.isSymbolicLink()) return 'symlink'
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'other'
  }
}
/** `Q`: the target -- as written under `dir`, and as resolved -- walks clean. */
function* linkPathIsPlainIo(text: string, dir: string): Io<boolean> {
  if (!(yield* pathWalksPlainIo(ABSOLUTE_RE.test(text) ? text : dir + path.sep + text, 40))) return false
  return yield* pathWalksPlainIo(path.resolve(dir, text), 40)
}
/** `re`: every component of `p` is a plain entry; a link met on the way is validated and followed, `depth` deep. */
function* pathWalksPlainIo(p: string, depth: number): Io<boolean> {
  if (depth <= 0) return false
  const m = ROOT_PREFIX_RE.exec(p)
  let prefix = m ? m[0] : ''
  const segs = p.slice(prefix.length).split(SEPARATORS_RE)
  for (let u = 0; u < segs.length; u += 1) {
    const seg = segs[u]
    if (seg === '' || seg === '.') continue
    if (seg === '..') { prefix = path.dirname(prefix); continue }
    prefix = path.join(prefix, seg)
    if (isNetworkMount(prefix)) return false
    const kind = yield* entryKindIo(prefix)
    if (kind === 'other') return false
    if (kind === 'symlink') {
      const text = yield* readLinkTextIo(prefix)
      if (text === null) return false
      if (linkTargetIsElsewhere(text, path.dirname(prefix))) return false
      const head = ABSOLUTE_RE.test(text) ? text : path.dirname(prefix) + path.sep + text
      const rest = segs.slice(u + 1).join(path.sep)
      const next = rest ? (TRAILING_SEPARATOR_RE.test(head) ? head + rest : head + path.sep + rest) : head
      return yield* pathWalksPlainIo(next, depth - 1)
    }
  }
  return true
}

/**
 * The directory the CLI treats as the CANONICAL root of a checkout whose
 * `.git` entry is at `root` -- which is `root` itself for an ordinary clone,
 * and the MAIN checkout for a LINKED WORKTREE.
 *
 * Mirrored from the pinned 2.1.278 (`Bt`, the `canonicalRootByRoot` resolver):
 * a `.git` FILE reading `gitdir: <dir>` names the worktree's private git
 * directory under `<main>/.git/worktrees/<name>`; `<dir>/commondir` names the
 * shared git directory (`<main>/.git`); `<dir>/gitdir` must point back at this
 * worktree's own `.git`; and the parent of `<dir>` must be `<common>/worktrees`.
 * When all of that holds the canonical root is `dirname(<common>)`, the main
 * checkout -- and on POSIX that is where the CLI reads `settings.local.json`
 * from for a launch inside the worktree. The first version of this walked up
 * to the worktree and stopped, so a helper declared in the MAIN checkout's
 * local settings applied to every managed session in every linked worktree of
 * the repository with a clean verdict -- and this repo's own session model
 * puts every session in a linked worktree (adversarial re-attack, BLOCKER).
 * Any pointer that does not validate leaves the root as it was, exactly as
 * the CLI does; neither pointer file may be a symlink. A pointer that changed
 * while it was read is neither valid nor invalid: `GitPointerChangedError`
 * propagates, and the scan reports it as uncertainty.
 */
function* canonicalGitRootOfIo(root: string): Io<string> {
  const entry = path.join(root, '.git')
  try {
    // `stat`, following a symlink: the CLI reads a symlinked `.git` FILE
    // through it (`ve` -> readFileSync). The pointer files INSIDE the git
    // directory stay symlink-refused (`tA`).
    if (!(yield* statIo(entry)).isFile()) return root
  } catch {
    return root
  }
  const text = (yield* readGitPointerIo(entry, true))?.trim()
  if (!text || !text.startsWith('gitdir:')) return root
  const gitdir = path.resolve(root, text.slice(7).trim())
  const commonText = (yield* readGitPointerIo(path.join(gitdir, 'commondir')))?.trim()
  if (!commonText) return root
  const common = path.resolve(gitdir, commonText)
  if (path.dirname(gitdir) !== path.join(common, 'worktrees')) return root
  const backText = (yield* readGitPointerIo(path.join(gitdir, 'gitdir')))?.trim()
  if (!backText) return root
  try {
    const back = yield* realpathIo(path.resolve(gitdir, backText))
    if (back !== path.join(yield* realpathIo(root), '.git')) return root
  } catch {
    return root
  }
  if (path.basename(common) !== '.git') {
    // A shared directory not named `.git` (a bare repository): the CLI treats
    // it as the root itself unless it holds a `.git` of its own, asked with
    // the SAME predicate as the walk (`Bt`: `Ce(R(a,".git"),a)`) -- a bare
    // `stat` here took a link the CLI refuses as that `.git`, stayed at the
    // worktree, and never read the bare directory's local settings the CLI
    // applied (adversarial confirmation pass, round 6, MAJOR).
    return (yield* isGitRootEntryIo(path.join(common, '.git'), common)) ? root : common
  }
  return path.dirname(common)
}

/** `canonicalGitRootOfIo`, awaited (the gate's test seam). */
export function canonicalGitRootOf(root: string): Promise<string> {
  return runAsync(canonicalGitRootOfIo(root))
}

/**
 * Where the CLI reads `settings.local.json` from on POSIX, when that is NOT
 * the working directory -- or `null` when it is.
 *
 * Measured on the pinned 2.1.278: `localSettings` resolves to the CANONICAL
 * GIT ROOT of the working directory when (a) the platform has uid semantics
 * (`process.geteuid`), so never on win32; (b) the root differs from the
 * working directory and from the real home directory; and (c) the root, its
 * `.git` entry and its `.claude` entry (when present) are all owned by the
 * current user. The working directory's own `settings.local.json` is then
 * ALSO read, as the legacy location. `settings.json` stays at the working
 * directory in every case. A gate that read only the working directory
 * therefore missed the file the CLI reads from the repository root for every
 * launch in a subdirectory of an owned checkout (adversarial review, MAJOR,
 * POSIX only).
 *
 * The root is found the way the CLI finds it: from the REAL path of the
 * working directory (the CLI's own working directory is the native realpath
 * of process.cwd()), walk up for a `.git` entry the
 * CLI's `Ce` accepts (`isGitRootEntry`: a directory or a regular file, or a
 * symlink that passes the CLI's own text, host and path checks and lands on
 * one -- the first version walked past every symlinked `.git`, the second
 * followed every one, and each missed a root the CLI used: adversarial final
 * pass MINOR, confirmation pass MAJOR) -- with no depth bound other than the filesystem root
 * -- the CLI's walk has none, and a bound the CLI does not share is a layout
 * in which the CLI finds a root this gate does not; then a linked worktree's
 * pointer is followed to the main checkout (`canonicalGitRootOf`).
 *
 * `homeDir` is the home directory to compare with; production callers omit it
 * (os.homedir()), and the hooks writer's tests pass their own.
 */
function* posixCanonicalLocalSettingsRootIo(cwd: string, homeDir?: string): Io<string | null> {
  if (typeof process.geteuid !== 'function') return null
  // The CLI keeps the real path of its working directory (the native
  // realpath of process.cwd()) and walks up from that, so a session folder
  // reached through a link is looked up where the link lands, which may be
  // inside another checkout. The resolved path stands in only when the real
  // path cannot be read.
  let resolved = path.resolve(cwd)
  try {
    resolved = yield* realpathIo(resolved)
  } catch { /* keep the resolved path */ }
  let dir = resolved
  let root: string | null = null
  for (;;) {
    if (yield* isGitRootEntryIo(path.join(dir, '.git'), dir)) { root = dir; break }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (root === null) return null
  root = yield* canonicalGitRootOfIo(root)
  if (root === resolved) return null
  try {
    if (root === (yield* realpathIo(homeDir ?? os.homedir()))) return null
  } catch {
    return null
  }
  try {
    const uid = process.geteuid()
    const rootUid = (yield* statIo(root)).uid
    const gitUid = (yield* lstatIo(path.join(root, '.git'))).uid
    let claudeUid: number | null = null
    try { claudeUid = (yield* lstatIo(path.join(root, '.claude'))).uid } catch { /* absent: not a veto */ }
    if (rootUid !== uid || gitUid !== uid || (claudeUid !== null && claudeUid !== uid)) return null
  } catch {
    return null
  }
  return root
}

/** The CLI's POSIX local-settings root for `cwd`, awaited (the launch gate). */
export function posixCanonicalLocalSettingsRoot(cwd: string, homeDir?: string): Promise<string | null> {
  return runAsync(posixCanonicalLocalSettingsRootIo(cwd, homeDir))
}

/** The same answer, synchronously (the session hooks writer, which runs in
 *  the synchronous spawn path). Throws `GitPointerChangedError` as the
 *  awaited form rejects with it. */
export function posixCanonicalLocalSettingsRootSync(cwd: string, homeDir?: string): string | null {
  return runSync(posixCanonicalLocalSettingsRootIo(cwd, homeDir))
}
