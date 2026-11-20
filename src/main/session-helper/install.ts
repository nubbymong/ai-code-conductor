/**
 * The helper's own copy on this computer.
 *
 * The installer puts the helper beside the app (resources/helper). Holders do
 * not run from there: a holder outlives the app, and on Windows a running
 * program cannot be replaced, so an update would fail while a terminal is
 * held. The app copies the helper into a per-user folder that does not roam
 * and is outside the install folder, one folder per version and hash
 * (`<version>-<first 12 hex of its SHA-256>`), and checks the copy against
 * the installed file before every holder start (docs/remote/helper-threat-model.md,
 * 3.1 and 3.10).
 *
 * On Windows, node-pty's bundled ConPTY (conpty.dll and the OpenConsole.exe
 * it starts) can go beside that copy, in a `conpty` folder: a holder asked
 * for the bundled ConPTY (the launch field `conpty`) loads it only from
 * there. It is checked against node-pty's installed files before every use,
 * the same way. Missing or unusable files make only the bundled ConPTY
 * unavailable; the helper itself works without them. The manager asks for
 * it with every copy (2.1.3-beta.7), for an agent session on the bundled
 * ConPTY, and checks it before each such launch (checkedConpty).
 */
import { createHash, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findNodePtyLibDir, nodePtyConptyDir } from '../bundled-conpty'
import { devDataRoot } from '../dev-data-root'
import { HELPER_FOLDER_RE } from './protocol'

export const HELPER_EXE_NAME = (platform: NodeJS.Platform = process.platform): string => (platform === 'win32' ? 'aicc-helper.exe' : 'aicc-helper')

/**
 * The per-user folder the helper lives in: never roaming, never the install
 * folder. A dev or test run keeps away from the installed app's holders: it
 * uses its own data root when it has one (dev-data-root.ts devDataRoot), and
 * otherwise a `dev` folder of its own inside the installed app's (which the
 * installed app's clean-up of old version folders leaves alone). A root that
 * is not a full path, by the rules of `platform`, is ignored and the folder
 * used with no override is used instead, so the root never puts the helper
 * under the folder the run started in. For a packaged build that is the
 * installed app's own folder, even in an end-to-end run.
 */
export function helperRootDir(opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; isPackaged: boolean }): string {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const home = opts.home ?? os.homedir()
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  const root = devDataRoot(env, opts.isPackaged, platform)
  if (root) return join(root, 'helper')
  // A LOCALAPPDATA that is not a full path is ignored too, for the same reason.
  const local = env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, 'AppData', 'Local')
  const installed = platform === 'win32'
    ? join(local, 'AI Code Conductor', 'helper')
    : platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'AI Code Conductor', 'helper')
      : join(home, '.ai-code-conductor', 'helper')
  return opts.isPackaged ? installed : join(installed, 'dev')
}

/**
 * Where a run of the app keeps a small record of its own, such as the vision
 * browser the helper started (vision-started.json) or the run's own pid and
 * creation time (app-run.json): the user data folder for an installed app,
 * and an E2E or dev run's own data root otherwise (dev-data-root.ts
 * devDataRoot). A dev run shares the user data folder with an installed app
 * on the same computer (docs/dev-alongside-prod.md), and must never read or
 * act on that app's records. A root that is not absolute gives no record at
 * all (null). `userData` is asked only when it is the folder used.
 */
export function instanceRecordPath(name: string, opts: { isPackaged: boolean; userData: () => string; env?: NodeJS.ProcessEnv }): string | null {
  const root = devDataRoot(opts.env ?? process.env, opts.isPackaged)
  if (root === null) return null
  return path.join(root ?? opts.userData(), name)
}

/** The codes Windows gives while another program (real-time scanning, an
 *  indexer) still has a just-written file open. */
const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
/** How long a busy file is waited for, in all. */
export const BUSY_WAIT_MS = 10_000

/**
 * Run `op`, and again while it fails because a file is busy, waiting a little
 * longer each time, up to `forMs` in all. Any other failure, or one still
 * busy at the end, is thrown as it is.
 */
export async function retryWhileBusy<T>(op: () => Promise<T>, opts: { forMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const forMs = opts.forMs ?? BUSY_WAIT_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let waited = 0
  let wait = 50
  for (;;) {
    try {
      return await op()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (!code || !BUSY_CODES.has(code) || waited + wait > forMs) throw err
      await sleep(wait)
      waited += wait
      wait = Math.min(wait * 2, 1000)
    }
  }
}

/** Where the installer put the helper: resources/helper in a packaged app,
 *  the Cargo build in a dev run. */
export function bundledHelperPath(opts: { isPackaged: boolean; resourcesPath: string; appPath: string; platform?: NodeJS.Platform }): string {
  const exe = HELPER_EXE_NAME(opts.platform)
  return opts.isPackaged
    ? path.join(opts.resourcesPath, 'helper', exe)
    : path.join(opts.appPath, 'helper', 'target', 'release', exe)
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const s = fs.createReadStream(file)
    s.on('data', (c) => hash.update(c))
    s.on('error', reject)
    s.on('end', () => resolve())
  })
  return hash.digest('hex')
}

export const versionFolderName = (version: string, sha256: string): string => `${version}-${sha256.slice(0, 12)}`

/**
 * A failure the Machines page shows as it is. `copy`: the copy could not be
 * put in place (a later terminal tries again); `mismatch`: it was, and does
 * not match the installed helper.
 */
export class InstallError extends Error {
  constructor(message: string, readonly kind: 'copy' | 'mismatch' | 'other' = 'other') {
    super(message)
  }
}

/** The bundled ConPTY's files, copied beside the helper (Windows). */
export const CONPTY_FILES = ['conpty.dll', 'OpenConsole.exe'] as const
/** The folder beside the helper's copy they go in: the holder looks there. */
export const CONPTY_FOLDER = 'conpty'

/**
 * The bundled ConPTY beside the helper's copy: usable, with each file's
 * SHA-256 taken from node-pty's installed file at start, or not, with why.
 */
export type ConptyCopy =
  | { available: true; dir: string; source: string; sha256: Readonly<Record<string, string>> }
  | { available: false; reason: string }

export interface InstalledHelper {
  /** The copy holders run from. */
  exe: string
  /** Its version folder. */
  folder: string
  /** The installed file's SHA-256, which the copy must match. */
  sha256: string
  version: string
  /** node-pty's bundled ConPTY beside the copy (Windows only). */
  conpty: ConptyCopy
  /**
   * The node-pty `conpty` folder this copy was asked to carry: undefined when
   * it was not asked, null when none was found. A copy made again (the whole
   * version folder) is given it again, so the bundled ConPTY is not lost.
   */
  conptySource: string | null | undefined
}

/**
 * Put the bundled helper's copy in place (or keep the one there that still
 * matches) and check it. A copy that does not match is made again once; when
 * that one does not match either, this fails.
 *
 * `conptySource` is node-pty's `conpty` folder (bundledConptySource): on
 * Windows its two files are copied beside the helper too. Left out, nothing
 * of it is copied. That part never fails the helper: it only makes the
 * bundled ConPTY unavailable, with the reason.
 *
 * A copy that matches is also kept as this run's checked copy
 * (checkedHelperCopySync).
 */
export async function installHelperCopy(opts: { bundled: string; root: string; version: string; sha256: string; platform?: NodeJS.Platform; conptySource?: string | null }): Promise<InstalledHelper> {
  const platform = opts.platform ?? process.platform
  const folder = path.join(opts.root, versionFolderName(opts.version, opts.sha256))
  const exe = path.join(folder, HELPER_EXE_NAME(platform))
  const placed = async (): Promise<InstalledHelper> => {
    checkedCopy = { exe, sha256: opts.sha256 }
    return {
      exe, folder, sha256: opts.sha256, version: opts.version,
      conpty: await installConptyCopy({ source: opts.conptySource, folder, platform }),
      conptySource: opts.conptySource,
    }
  }
  if (await copyMatches(exe, opts.sha256)) return placed()
  await makeCopy(opts.bundled, opts.root, folder, exe, platform)
  if (await copyMatches(exe, opts.sha256)) return placed()
  throw new InstallError('The session helper copy on this computer does not match the one installed with the app, so nothing is started through it.', 'mismatch')
}

const conptyUnavailable = (reason: string): ConptyCopy => ({ available: false, reason })

/**
 * Put node-pty's conpty.dll and OpenConsole.exe in the `conpty` folder of the
 * helper's version folder (or keep the copies there that match) and check
 * them. Never throws: anything that goes wrong makes only the bundled ConPTY
 * unavailable. `expected` holds the hashes taken at start, when there are any.
 */
async function installConptyCopy(opts: { source: string | null | undefined; folder: string; platform: NodeJS.Platform; expected?: Readonly<Record<string, string>> }): Promise<ConptyCopy> {
  if (opts.platform !== 'win32') return conptyUnavailable('the bundled ConPTY is for Windows only')
  if (opts.source === undefined) return conptyUnavailable('the bundled ConPTY was not asked for')
  if (opts.source === null) return conptyUnavailable("node-pty's bundled ConPTY was not found")
  const source = opts.source
  const dir = path.join(opts.folder, CONPTY_FOLDER)
  try {
    let sha256 = opts.expected
    if (!sha256) {
      const taken: Record<string, string> = {}
      for (const name of CONPTY_FILES) {
        const file = path.join(source, name)
        if (!(await isPlainFile(file))) return conptyUnavailable(`${file} is missing or not a plain file`)
        taken[name] = await sha256File(file)
      }
      sha256 = taken
    }
    const copy: ConptyCopy = { available: true, dir, source, sha256 }
    if (await conptyCopyMatches(dir, sha256)) return copy
    const inUse = await makeConptyCopy(source, opts.folder, dir)
    if (inUse) return inUse
    if (await conptyCopyMatches(dir, sha256)) return copy
    return conptyUnavailable("the bundled ConPTY's copy on this computer does not match the one installed with the app")
  } catch (err) {
    return conptyUnavailable(`the bundled ConPTY could not be copied into place: ${(err as Error).message}`)
  }
}

async function isPlainFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(file)).isFile()
  } catch {
    return false
  }
}

/** True when every file of the bundled ConPTY's copy is a plain file with the hash taken at start. */
async function conptyCopyMatches(dir: string, sha256: Readonly<Record<string, string>>): Promise<boolean> {
  for (const name of CONPTY_FILES) {
    if (!(await copyMatches(path.join(dir, name), sha256[name]))) return false
  }
  return true
}

/**
 * Copy node-pty's two files into `dir`: whole into a folder of their own
 * first, then moved into place, as the helper is, so a holder never loads a
 * half-written file. The staging folder is in the helper's version folder,
 * which no clean-up of old folders touches while it is the current one, and
 * it is removed again when the copy fails. Answers the bundled ConPTY as
 * unavailable when the old copy is in use; null once the copy is in place.
 */
async function makeConptyCopy(source: string, folder: string, dir: string): Promise<ConptyCopy | null> {
  const staging = path.join(folder, `.new-${randomBytes(6).toString('hex')}`)
  try {
    await fs.promises.mkdir(staging, { mode: 0o700 })
    for (const name of CONPTY_FILES) await fs.promises.copyFile(path.join(source, name), path.join(staging, name))
    // A running session holds the conpty.dll it loaded and the
    // OpenConsole.exe it runs, and Windows removes neither until that session
    // ends: waiting would only hold up the start. Tried once.
    try {
      await removeFolder(dir)
    } catch (err) {
      if (BUSY_CODES.has((err as NodeJS.ErrnoException)?.code ?? '')) {
        return conptyUnavailable(`the bundled ConPTY's copy is in use by a running session (or cannot be removed), so it is not replaced now: ${(err as Error).message}`)
      }
      throw err
    }
    // Only the just-written files can be busy here (real-time scanning).
    await retryWhileBusy(() => fs.promises.rename(staging, dir))
    return null
  } finally {
    // Gone already once the rename is done; otherwise what a failed copy left.
    await removeFolder(staging).catch(() => { /* tried again at the next start */ })
  }
}

/** One copy made again at a time for each folder: checks that find the same mismatch share it. */
const conptyRecopies = new Map<string, Promise<ConptyCopy>>()

/**
 * The check before every launch on the bundled ConPTY: the copy as it is when
 * it still matches what was taken at start; otherwise it is made again once
 * from node-pty's files, and is unavailable when that one does not match
 * either. Only the bundled ConPTY is then unavailable: the session starts
 * the usual way.
 */
export async function checkedConpty(info: InstalledHelper): Promise<ConptyCopy> {
  const copy = info.conpty
  if (!copy.available) return copy
  if (await conptyCopyMatches(copy.dir, copy.sha256)) return copy
  let again = conptyRecopies.get(copy.dir)
  if (!again) {
    const made = installConptyCopy({ source: copy.source, folder: info.folder, platform: 'win32', expected: copy.sha256 })
    again = made
    conptyRecopies.set(copy.dir, made)
    void made.finally(() => { if (conptyRecopies.get(copy.dir) === made) conptyRecopies.delete(copy.dir) })
  }
  return again
}

/**
 * node-pty's `conpty` folder (conpty.dll and OpenConsole.exe), by the one
 * lookup the app's own bundled node-pty spawn uses (bundled-conpty.ts
 * nodePtyConptyDir): beside the native module node-pty's loader finds first,
 * in a packaged app under app.asar.unpacked. Null off Windows, or when there
 * is none. Whether the two files are there is the copy's to say, with which
 * one is missing.
 */
export function bundledConptySource(deps: { platform?: NodeJS.Platform; arch?: string; nodePtyLibDir?: string | null; exists?: (p: string) => boolean } = {}): string | null {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return null
  const lib = 'nodePtyLibDir' in deps ? deps.nodePtyLibDir ?? null : findNodePtyLibDir()
  if (!lib) return null
  const exists = deps.exists ?? ((p: string) => { try { return fs.statSync(p).isFile() } catch { return false } })
  return nodePtyConptyDir(lib, platform, deps.arch ?? process.arch, exists)
}

/** The check before every holder start: true when the copy is still the installed helper. */
export async function copyMatches(exe: string, sha256: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(exe)
    if (!st.isFile()) return false
    return (await sha256File(exe)) === sha256
  } catch {
    return false
  }
}

/** The copy installHelperCopy last put in place and checked in this run,
 *  with the installed helper's SHA-256 it matched then. */
let checkedCopy: { exe: string; sha256: string } | null = null

/** The largest helper file checkedHelperCopySync reads. */
const CHECKED_COPY_MAX_BYTES = 64 * 1024 * 1024

/**
 * This run's checked copy of the helper (installHelperCopy), for a
 * short-lived use when the helper beside the app has gone: an uninstall for
 * all users can remove it while the app still runs. Answered only while its
 * file is still a plain file with the SHA-256 it matched, read again now,
 * synchronously (the quit uses it). Null when the session helper made no copy
 * this run, or the copy is missing or changed.
 */
export function checkedHelperCopySync(): string | null {
  const copy = checkedCopy
  if (!copy) return null
  try {
    const st = fs.lstatSync(copy.exe)
    if (!st.isFile() || st.size > CHECKED_COPY_MAX_BYTES) return null
    return createHash('sha256').update(fs.readFileSync(copy.exe)).digest('hex') === copy.sha256 ? copy.exe : null
  } catch {
    return null
  }
}

/** Test seam: forget this run's checked copy. */
export function _forgetCheckedHelperCopyForTest(): void {
  checkedCopy = null
}

async function makeCopy(bundled: string, root: string, folder: string, exe: string, platform: NodeJS.Platform): Promise<void> {
  try {
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 })
    // Copied whole into a folder of its own first, then moved into place, so
    // a holder never starts from a half-written file.
    const staging = path.join(root, `.new-${randomBytes(6).toString('hex')}`)
    await fs.promises.mkdir(staging, { mode: 0o700 })
    const staged = path.join(staging, path.basename(exe))
    await fs.promises.copyFile(bundled, staged)
    if (platform !== 'win32') await fs.promises.chmod(staged, 0o755)
    // Windows real-time scanning can hold a just-written program for
    // seconds, and a folder with a file open in it can be neither removed nor
    // renamed meanwhile: both wait for it.
    await retryWhileBusy(() => removeFolder(folder))
    await retryWhileBusy(() => fs.promises.rename(staging, folder))
  } catch (err) {
    throw new InstallError(`The session helper could not be copied into place: ${(err as Error).message}`, 'copy')
  }
}

/** Removes one folder this module made (a version folder or a staging one). */
async function removeFolder(folder: string): Promise<void> {
  await fs.promises.rm(folder, { recursive: true, force: true })
}

/**
 * Remove the version folders no holder still runs from: every one but the
 * current folder and the folders of `keepVersions`, and the staging folders a
 * failed copy left. `keepVersions` is every version a listed or live holder
 * reports, the current one included. A holder's record names its version, not
 * its folder, so every folder of such a version is kept, the current
 * version's other builds (another hash) included: a holder an update kept may
 * run from one of them. A spare folder of a kept version goes at a later
 * start, once no holder reports that version. Answers the folders removed.
 */
export async function removeOldVersionFolders(root: string, current: string, keepVersions: ReadonlySet<string>): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.promises.readdir(root)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    const full = path.join(root, name)
    if (full === current) continue
    const staging = name.startsWith('.new-')
    const m = HELPER_FOLDER_RE.exec(name)
    if (!staging && !m) continue
    if (m && keepVersions.has(m[1])) continue
    try {
      const st = await fs.promises.lstat(full)
      if (!st.isDirectory()) continue
      await removeFolder(full)
      removed.push(name)
    } catch { /* in use or gone: tried again at the next start */ }
  }
  return removed
}
