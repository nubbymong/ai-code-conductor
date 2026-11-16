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

export const HELPER_EXE_NAME = (platform: NodeJS.Platform = process.platform): string => (platform === 'win32' ? 'aicc-helper.exe' : 'aicc-helper')

/**
 * The per-user folder the helper lives in: never roaming, never the install
 * folder. A dev or test run uses its own data folder, so it never touches the
 * installed app's holders.
 */
export function helperRootDir(opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; isPackaged: boolean }): string {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const home = opts.home ?? os.homedir()
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  if (env.CCC_E2E_DATA_DIR) return join(env.CCC_E2E_DATA_DIR, 'helper')
  if (!opts.isPackaged && env.CCC_DEV_DATA_DIR) return join(env.CCC_DEV_DATA_DIR, 'helper')
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'AI Code Conductor', 'helper')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'AI Code Conductor', 'helper')
  return join(home, '.ai-code-conductor', 'helper')
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

/** A failure the Machines page shows as it is. */
export class InstallError extends Error {}

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
  throw new InstallError('The session helper copy on this computer does not match the one installed with the app, so nothing is started through it.')
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
    await removeFolder(folder)
    await fs.promises.rename(staging, folder)
  } catch (err) {
    throw new InstallError(`The session helper could not be copied into place: ${(err as Error).message}`)
  }
}

/** Removes one folder this module made (a version folder or a staging one). */
async function removeFolder(folder: string): Promise<void> {
  await fs.promises.rm(folder, { recursive: true, force: true })
}

/**
 * Remove the version folders no holder still runs from. `inUse` names the
 * versions the holders listed report; a folder of one of them is kept (on
 * Windows its program could not be removed while it runs anyway).
 * Answers the folders removed.
 */
export async function removeOldVersionFolders(root: string, current: string, inUse: ReadonlySet<string>): Promise<string[]> {
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
    const m = /^([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?)-[0-9a-f]{12}$/.exec(name)
    if (!staging && !m) continue
    if (m && inUse.has(m[1])) continue
    try {
      const st = await fs.promises.lstat(full)
      if (!st.isDirectory()) continue
      await removeFolder(full)
      removed.push(name)
    } catch { /* in use or gone: tried again at the next start */ }
  }
  return removed
}
