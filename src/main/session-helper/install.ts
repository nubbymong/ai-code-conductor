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
 */
import { createHash, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { HELPER_FOLDER_RE } from './protocol'

export const HELPER_EXE_NAME = (platform: NodeJS.Platform = process.platform): string => (platform === 'win32' ? 'aicc-helper.exe' : 'aicc-helper')

/**
 * The per-user folder the helper lives in: never roaming, never the install
 * folder. A dev or test run never touches the installed app's holders: it
 * uses its own data folder when it has one, and otherwise a `dev` folder of
 * its own inside the installed app's (which the installed app's clean-up of
 * old version folders leaves alone).
 */
export function helperRootDir(opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; isPackaged: boolean }): string {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const home = opts.home ?? os.homedir()
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  if (env.CCC_E2E_DATA_DIR) return join(env.CCC_E2E_DATA_DIR, 'helper')
  if (!opts.isPackaged && env.CCC_DEV_DATA_DIR) return join(env.CCC_DEV_DATA_DIR, 'helper')
  const installed = platform === 'win32'
    ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'AI Code Conductor', 'helper')
    : platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'AI Code Conductor', 'helper')
      : join(home, '.ai-code-conductor', 'helper')
  return opts.isPackaged ? installed : join(installed, 'dev')
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

export interface InstalledHelper {
  /** The copy holders run from. */
  exe: string
  /** Its version folder. */
  folder: string
  /** The installed file's SHA-256, which the copy must match. */
  sha256: string
  version: string
}

/**
 * Put the bundled helper's copy in place (or keep the one there that still
 * matches) and check it. A copy that does not match is made again once; when
 * that one does not match either, this fails.
 */
export async function installHelperCopy(opts: { bundled: string; root: string; version: string; sha256: string; platform?: NodeJS.Platform }): Promise<InstalledHelper> {
  const platform = opts.platform ?? process.platform
  const folder = path.join(opts.root, versionFolderName(opts.version, opts.sha256))
  const exe = path.join(folder, HELPER_EXE_NAME(platform))
  const info: InstalledHelper = { exe, folder, sha256: opts.sha256, version: opts.version }
  if (await copyMatches(exe, opts.sha256)) return info
  await makeCopy(opts.bundled, opts.root, folder, exe, platform)
  if (await copyMatches(exe, opts.sha256)) return info
  throw new InstallError('The session helper copy on this computer does not match the one installed with the app, so nothing is started through it.', 'mismatch')
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
 * current folder, the staging folders a failed copy left, and the folders of
 * `keepVersions` (versions other than the current one that listed holders
 * report). A folder of the current version with another hash goes too: on
 * Windows one a holder still runs from cannot be removed and stays until the
 * next start; on macOS and Linux the program keeps running without its file.
 * Answers the folders removed.
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
