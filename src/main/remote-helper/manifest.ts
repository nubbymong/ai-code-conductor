/**
 * The Linux helpers the installer carries, and their manifest (2.1.3-beta.17,
 * plan section A1's contract with A2; from 2.1.3-beta.19, section 1.3, one
 * per machine architecture): `resources/helper/manifest.json` lists each file
 * the installer put beside the Windows helper by its path (relative to
 * `resources/helper`, forward slashes), its version and its SHA-256. The
 * static Linux helpers are `linux-x64/aicc-helper` (x86-64) and
 * `linux-arm64/aicc-helper` (arm64, which Linux reports as aarch64).
 *
 * A machine gets only the file of its own architecture's row (LINUX_HELPER_ROWS),
 * and only once the app has hashed it again and found the manifest's hash: an
 * install that was changed after it was built uploads nothing. The
 * architecture a host reports (`uname -m`) only selects a row of that fixed
 * table, by equality, and never forms a path. The hash a host reports for its
 * copy is checked against the manifest too (machines.ts), never against host
 * data.
 */
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { HELPER_FOLDER_RE, SHA256_RE } from '../session-helper/protocol'

/** The x86-64 Linux helper's path in the manifest, and under resources/helper. */
export const LINUX_HELPER_PATH = 'linux-x64/aicc-helper'
/** The arm64 Linux helper's path in the manifest, and under resources/helper (2.1.3-beta.19). */
export const LINUX_ARM64_HELPER_PATH = 'linux-arm64/aicc-helper'
export const MANIFEST_NAME = 'manifest.json'

/** Where a dev run (not packaged) finds the helpers and the manifest, as A1's
 *  scripts put them before packaging (scripts/verify-bundled-helper.mjs
 *  LINUX_HELPERS and MANIFEST_SOURCE): the Helper job's helper-linux-musl
 *  artifact, the arm64 job's helper-linux-musl-arm64 artifact, and the
 *  manifest `node scripts/write-helper-manifest.mjs` writes for them (with
 *  --only-present, a dev run lists the ones it has). */
export const DEV_LINUX_HELPER = 'helper/target/helper-linux-musl/aicc-helper'
export const DEV_LINUX_ARM64_HELPER = 'helper/target/helper-linux-musl-arm64/aicc-helper'
export const DEV_MANIFEST = 'helper/target/helper-manifest/manifest.json'

/** A Linux machine architecture the app adds, as Linux's `uname -m` names it. */
export type LinuxArch = 'x86_64' | 'aarch64'

/** One row of the fixed table: a machine architecture and the one helper file
 *  for it. */
export interface LinuxHelperRow {
  arch: LinuxArch
  /** How the app names it to the user. */
  name: string
  /** Its path in the manifest, and under resources/helper. */
  path: string
  /** Where a dev run finds it. */
  dev: string
  /** The ELF machine its file is built for (EM_X86_64, EM_AARCH64). */
  machine: number
}

/** The fixed table (Add and Check, the routing, the cards): x86_64 takes
 *  linux-x64/aicc-helper and aarch64 takes linux-arm64/aicc-helper. Any other
 *  architecture (armv7l, armhf, ...) has no row and is refused. */
export const LINUX_HELPER_ROWS: readonly LinuxHelperRow[] = Object.freeze([
  Object.freeze<LinuxHelperRow>({ arch: 'x86_64', name: 'x86-64', path: LINUX_HELPER_PATH, dev: DEV_LINUX_HELPER, machine: 62 }),
  Object.freeze<LinuxHelperRow>({ arch: 'aarch64', name: 'arm64', path: LINUX_ARM64_HELPER_PATH, dev: DEV_LINUX_ARM64_HELPER, machine: 183 }),
])

/** The row of a machine's architecture as its host reported it, or null when
 *  the table has none. Compared by equality only: the host's text selects a
 *  row and never forms a path. */
export function linuxHelperRow(arch: unknown): LinuxHelperRow | null {
  for (const row of LINUX_HELPER_ROWS) if (row.arch === arch) return row
  return null
}

/** The helper a machine is given: its architecture and manifest path, its file
 *  here, version, SHA-256, size, and the folder it goes into on the host
 *  (`<version>-<first 12 hex>`). */
export interface BundledLinuxHelper {
  arch: LinuxArch
  path: string
  file: string
  version: string
  sha256: string
  size: number
  folder: string
}

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/

/** The manifest's entry for `wanted`, read strictly: an object with `files`
 *  (or a bare list) of `{ path, version, sha256 }`. Null when there is none. */
export function manifestEntry(json: unknown, wanted: string = LINUX_HELPER_PATH): { version: string; sha256: string } | null {
  const list = Array.isArray(json) ? json : json && typeof json === 'object' ? (json as { files?: unknown }).files : undefined
  if (!Array.isArray(list)) return null
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const { path: p, version, sha256 } = e as Record<string, unknown>
    if (typeof p !== 'string' || p.replace(/\\/g, '/') !== wanted) continue
    if (typeof version !== 'string' || !VERSION_RE.test(version)) return null
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) return null
    return { version, sha256 }
  }
  return null
}

/** The SHA-256 the manifest gives the helper of `arch`'s row: null when the
 *  architecture has no row, or the manifest no entry for it. Every compare of
 *  a machine's helper with this build's goes through this, by the machine's
 *  own architecture. */
export function manifestSha256For(json: unknown, arch: unknown): string | null {
  const row = linuxHelperRow(arch)
  return row ? (manifestEntry(json, row.path)?.sha256 ?? null) : null
}

/** Where this build keeps the manifest and one Linux helper. */
export interface BundledHelperPaths {
  manifest: string
  file: string
}

/** Where this build keeps the manifest and `row`'s Linux helper (x86-64 when
 *  none is named): resources/helper in an installed app (the package's
 *  layout); in a dev run, A1's places. */
export function bundledHelperPaths(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }, row: LinuxHelperRow = LINUX_HELPER_ROWS[0]): BundledHelperPaths {
  if (opts.isPackaged) {
    const dir = path.join(opts.resourcesPath, 'helper')
    return { manifest: path.join(dir, MANIFEST_NAME), file: path.join(dir, ...row.path.split('/')) }
  }
  return { manifest: path.join(opts.appPath, ...DEV_MANIFEST.split('/')), file: path.join(opts.appPath, ...row.dev.split('/')) }
}

/** The sentence for a build that carries no usable Linux helper. */
export const NO_LINUX_HELPER = 'This build of the app carries no Linux session helper, so no machine can be added from it.'
/** The sentence for an install whose Linux helper is not the one its manifest names. */
export const CHANGED_LINUX_HELPER = 'The Linux session helper in this install is not the one its manifest names, so it is not uploaded anywhere. Reinstall the app.'

/** A 64-bit little-endian ELF file for `machine`: the file a row may hand out. */
function elfFor(bytes: Buffer, machine: number): boolean {
  return bytes.length >= 64 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46 && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === machine
}

/** One row's helper, checked against the manifest read already: there and
 *  right (ok), not there (none: no entry, no file), or there and not the
 *  manifest's file or not built for the row's machine (changed). */
async function readRow(json: unknown, file: string, row: LinuxHelperRow): Promise<{ state: 'ok'; helper: BundledLinuxHelper } | { state: 'none' } | { state: 'changed' }> {
  const entry = manifestEntry(json, row.path)
  if (!entry) return { state: 'none' }
  let bytes: Buffer
  try {
    bytes = await fs.promises.readFile(file)
  } catch {
    return { state: 'none' }
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== entry.sha256 || !elfFor(bytes, row.machine)) return { state: 'changed' }
  const folder = `${entry.version}-${sha256.slice(0, 12)}`
  if (!HELPER_FOLDER_RE.test(folder)) return { state: 'none' }
  return { state: 'ok', helper: { arch: row.arch, path: row.path, file, version: entry.version, sha256, size: bytes.length, folder } }
}

async function readManifest(file: string): Promise<{ ok: true; json: unknown } | { ok: false }> {
  try {
    return { ok: true, json: JSON.parse(await fs.promises.readFile(file, 'utf8')) }
  } catch {
    return { ok: false }
  }
}

/**
 * One Linux helper at `paths` (`row`'s; x86-64 when none is named), checked:
 * the manifest reads, names the file, the file's SHA-256 is the manifest's and
 * it is built for the row's machine. Answers why not otherwise, in a plain
 * sentence.
 */
export async function readBundledLinuxHelper(paths: BundledHelperPaths, row: LinuxHelperRow = LINUX_HELPER_ROWS[0]): Promise<{ ok: true; helper: BundledLinuxHelper } | { ok: false; why: string }> {
  const m = await readManifest(paths.manifest)
  if (!m.ok) return { ok: false, why: NO_LINUX_HELPER }
  const r = await readRow(m.json, paths.file, row)
  if (r.state === 'changed') return { ok: false, why: CHANGED_LINUX_HELPER }
  if (r.state === 'none') return { ok: false, why: NO_LINUX_HELPER }
  return { ok: true, helper: r.helper }
}

/**
 * Every Linux helper this build carries, each checked as readBundledLinuxHelper
 * checks one, in the table's order. A package carries both (the packaging
 * check fails one without either); a dev run lists the ones it has. None, or
 * any one there that is not its manifest's file: none is offered, with the
 * plain sentence why.
 */
export async function readBundledLinuxHelpers(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): Promise<{ ok: true; helpers: BundledLinuxHelper[] } | { ok: false; why: string }> {
  const m = await readManifest(bundledHelperPaths(opts).manifest)
  if (!m.ok) return { ok: false, why: NO_LINUX_HELPER }
  const helpers: BundledLinuxHelper[] = []
  for (const row of LINUX_HELPER_ROWS) {
    const r = await readRow(m.json, bundledHelperPaths(opts, row).file, row)
    if (r.state === 'changed') return { ok: false, why: CHANGED_LINUX_HELPER }
    if (r.state === 'ok') helpers.push(r.helper)
  }
  return helpers.length > 0 ? { ok: true, helpers } : { ok: false, why: NO_LINUX_HELPER }
}
