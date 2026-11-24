/**
 * The Linux helper the installer carries, and its manifest (2.1.3-beta.17,
 * plan section A1's contract with A2): `resources/helper/manifest.json` lists
 * each file the installer put beside the Windows helper by its path (relative
 * to `resources/helper`, forward slashes), its version and its SHA-256; the
 * static Linux helper is `linux-x64/aicc-helper`.
 *
 * A machine gets only that file, and only once the app has hashed it again
 * and found the manifest's hash: an install that was changed after it was
 * built uploads nothing. The hash a host reports for its copy is checked
 * against the manifest too (machines.ts), never against host data.
 */
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { HELPER_FOLDER_RE, SHA256_RE } from '../session-helper/protocol'

/** The Linux helper's path in the manifest, and under resources/helper. */
export const LINUX_HELPER_PATH = 'linux-x64/aicc-helper'
export const MANIFEST_NAME = 'manifest.json'

/** The helper a machine is given: its file here, version, SHA-256, size, and
 *  the folder it goes into on the host (`<version>-<first 12 hex>`). */
export interface BundledLinuxHelper {
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

/** Where this build keeps the helper folder: resources/helper in an installed
 *  app; in a dev run, the Helper job's static Linux build with a manifest
 *  written beside it (helper/target/helper-linux-musl). */
export function bundledHelperDir(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return opts.isPackaged ? path.join(opts.resourcesPath, 'helper') : path.join(opts.appPath, 'helper', 'target', 'helper-linux-musl')
}

/** The sentence for a build that carries no usable Linux helper. */
export const NO_LINUX_HELPER = 'This build of the app carries no Linux session helper, so no machine can be added from it.'

/**
 * The Linux helper of the helper folder `dir`, checked: the manifest reads,
 * names the file, and the file's SHA-256 is the manifest's. Answers why not
 * otherwise, in a plain sentence.
 */
export async function readBundledLinuxHelper(dir: string): Promise<{ ok: true; helper: BundledLinuxHelper } | { ok: false; why: string }> {
  let json: unknown
  try {
    json = JSON.parse(await fs.promises.readFile(path.join(dir, MANIFEST_NAME), 'utf8'))
  } catch {
    return { ok: false, why: NO_LINUX_HELPER }
  }
  const entry = manifestEntry(json)
  if (!entry) return { ok: false, why: NO_LINUX_HELPER }
  const file = path.join(dir, ...LINUX_HELPER_PATH.split('/'))
  let bytes: Buffer
  try {
    bytes = await fs.promises.readFile(file)
  } catch {
    return { ok: false, why: NO_LINUX_HELPER }
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== entry.sha256) return { ok: false, why: 'The Linux session helper in this install is not the one its manifest names, so it is not uploaded anywhere. Reinstall the app.' }
  const folder = `${entry.version}-${sha256.slice(0, 12)}`
  if (!HELPER_FOLDER_RE.test(folder)) return { ok: false, why: NO_LINUX_HELPER }
  return { ok: true, helper: { file, version: entry.version, sha256, size: bytes.length, folder } }
}
