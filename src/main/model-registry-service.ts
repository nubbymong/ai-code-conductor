// The model registry every reader shares. Three layers, lowest first:
//
//  1. the file shipped with the build (resources/model-registry.json, a
//     static import: packaged-build-safe, the codex-pricing.json pattern);
//  2. the model data (2.1.3-beta.1): the same file as it stands on the
//     repository's model-data branch, read once at start-up in the
//     background, checked (model-registry-data.ts) and kept as the last good
//     copy in <resourcesDir>/CONFIG/model-data.json (only when that folder is
//     already there: it is config-manager's to make), so a new model needs no
//     release. On any failure the last good copy is used, else layer 1. Each
//     file carries a revision, and model data older than layer 1's is never
//     used: an older copy would put back the aliases, labels and prices a
//     newer build has since corrected;
//  3. the overlay, <resourcesDir>/sentinel/registry-overlay.json (the user's
//     and Sentinel's own additions; it wins per id).
//
// Layers 1 and 2 make the baseline (getBaseline); the overlay is merged onto
// it (getRegistry). A change to either is pushed to the renderer and to
// every subscriber as a hot reload, as before.
import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteFileSync } from './atomic-write'
import baselineJson from '../../resources/model-registry.json'
import {
  mergeRegistry, type ModelRegistry, type RegistryOverlay, type OverlayModelEntry,
} from '../shared/model-registry'
import { mergeModelData, modelDataText, parseModelData } from './model-registry-data'
import { fetchModelDataText, MODEL_DATA_MAX_BYTES, type ModelDataRead } from './model-registry-remote'
import { stripSpoofableText } from '../shared/safe-text'
import { logInfo } from './debug-logger'

/** The file shipped with the build, without its format version and its
 *  revision (fields of the file, not of the registry readers get). */
const { bundled, bundledRevision } = (() => {
  const { formatVersion: _format, revision, ...registry } = baselineJson as unknown as ModelRegistry & { formatVersion?: number; revision?: number }
  void _format
  return { bundled: registry as ModelRegistry, bundledRevision: Number.isInteger(revision) ? (revision as number) : 0 }
})()

let overlayDir: string | null = null         // <resourcesDir> root; sentinel/ created lazily
/** The model data in use (read just now, or the last good copy), if any, as
 *  the text it is kept as (its revision included). */
let modelData: string | null = null
let baseline: ModelRegistry = bundled
let merged: ModelRegistry = mergeRegistry(baseline, null)
/** The one read of a start (refreshModelRegistry). */
let refresh: Promise<boolean> | null = null
const reloadSubs = new Set<(reg: ModelRegistry) => void>()

function overlayPath(): string | null {
  return overlayDir ? path.join(overlayDir, 'sentinel', 'registry-overlay.json') : null
}

/** Where the last good model data is kept: the app's own config folder. */
export function modelDataFile(): string | null {
  return overlayDir ? path.join(overlayDir, 'CONFIG', 'model-data.json') : null
}

export function loadOverlay(): RegistryOverlay | null {
  const p = overlayPath()
  if (!p) return null
  try {
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as RegistryOverlay
  } catch (err) {
    logInfo(`[registry] corrupt overlay ignored: ${(err as Error).message}`)
    return null                              // fail-open: baseline still loads (spec §7)
  }
}

function writeOverlay(overlay: RegistryOverlay): void {
  const p = overlayPath()
  if (!p) return
  fs.mkdirSync(path.dirname(p), { recursive: true })
  atomicWriteFileSync(p, JSON.stringify(overlay, null, 2))   // atomic (spec §5)
}

export function reloadRegistry(): void {
  merged = mergeRegistry(baseline, loadOverlay())
  for (const fn of reloadSubs) { try { fn(merged) } catch { /* subscriber error must not break reload */ } }
}

export function getRegistry(): ModelRegistry { return merged }
/** The registry without the overlay: the bundled file with the model data. */
export function getBaseline(): ModelRegistry { return baseline }
/** The file shipped with the build, alone. What an overlay entry is retired
 *  against: only a release makes an entry of the user's own file redundant
 *  for good; the model data can change or go away. */
export function getBundledRegistry(): ModelRegistry { return bundled }
export function onRegistryReload(fn: (reg: ModelRegistry) => void): () => void {
  reloadSubs.add(fn); return () => reloadSubs.delete(fn)
}

export function applyOverlayEntry(entry: OverlayModelEntry): void {
  const overlay = loadOverlay() ?? {}
  const models = (overlay.models ?? []).filter((m) => m.id !== entry.id)
  models.push(entry)
  writeOverlay({ ...overlay, models })
  reloadRegistry()
}

export function removeOverlayEntry(id: string): void {
  const overlay = loadOverlay() ?? {}
  writeOverlay({ ...overlay, models: (overlay.models ?? []).filter((m) => m.id !== id) })
  reloadRegistry()
}

export function setOverlay(overlay: RegistryOverlay): void { writeOverlay(overlay); reloadRegistry() }

/** A reason as one plain, bounded line for the log. */
const plain = (reason: string): string => stripSpoofableText(String(reason), 200).replace(/\s+/g, ' ').trim()

const today = (): string => new Date().toISOString().slice(0, 10)

/** Checked model data with its revision. */
type ModelData = { data: ModelRegistry; revision: number }

/** Put model data (or none) to use: the baseline is rebuilt from it. */
function useModelData(got: ModelData | null): void {
  modelData = got ? modelDataText(got.data, got.revision) : null
  baseline = mergeModelData(bundled, got?.data ?? null, today())
}

const TOO_LARGE = 'larger than 256 KB'

/** The last good copy, checked exactly as a file just read is: the folder is
 *  the user's, so the copy is never trusted for having been written here.
 *  A copy older than the build's own file (kept by an earlier version) is
 *  removed: it would never be used again, and it would be wrong if it were. */
function readLastGood(): ModelData | null {
  const file = modelDataFile()
  if (!file) return null
  const unusable = (why: string): null => {
    logInfo(`[registry] the last good model data is not usable (${plain(why)}); using the bundled file`)
    return null
  }
  let text: string
  try {
    if (!fs.existsSync(file)) return null
    if (fs.statSync(file).size > MODEL_DATA_MAX_BYTES) return unusable(TOO_LARGE)
    text = fs.readFileSync(file, 'utf-8')
  } catch {
    return unusable('it could not be read')
  }
  const parsed = parseModelData(text, bundled)
  if (!parsed.ok) return unusable(parsed.reason)
  if (parsed.revision < bundledRevision) {
    let removed = true
    try { fs.rmSync(file, { force: true }) } catch { removed = false }
    logInfo(`[registry] the last good model data is older than this build's own (revision ${parsed.revision}, this build's ${bundledRevision}); ${removed ? 'removed, ' : ''}using the bundled file`)
    return null
  }
  return { data: parsed.data, revision: parsed.revision }
}

/**
 * The model data, read once per start, in the background: call it and do
 * not wait (start-up and the window never do). A file that passes the checks
 * is put to use at once, announced as a reload, and kept as the last good
 * copy. Anything else leaves what is in use (the last good copy, else the
 * bundled file) and logs one line with the reason.
 *
 * Resolves true when the registry changed; never rejects. A second call in
 * the same start is the same read. `deps.fetchText`: the test's stand-in.
 */
export function refreshModelRegistry(deps: { fetchText?: () => Promise<ModelDataRead> } = {}): Promise<boolean> {
  refresh ??= (async () => {
    const using = (): string => (modelData ? 'the last good copy' : 'the bundled file')
    let got: ModelDataRead
    try {
      got = await (deps.fetchText ?? fetchModelDataText)()
    } catch {
      got = { ok: false, reason: 'the read failed' }
    }
    let parsed = got.ok ? parseModelData(got.text, bundled) : got
    // A file older than the build's own (the branch lags behind a release)
    // is a failure like any other: the build's newer values stay.
    if (parsed.ok && parsed.revision < bundledRevision) {
      parsed = { ok: false, reason: `revision ${parsed.revision} is older than this build's own, ${bundledRevision}` }
    }
    if (!parsed.ok) {
      logInfo(`[registry] model data not read (${plain(parsed.reason)}); using ${using()}`)
      return false
    }
    const text = modelDataText(parsed.data, parsed.revision)
    if (modelData === text) return false                               // what is in use already
    useModelData(parsed)
    reloadRegistry()
    logInfo(`[registry] model data read: ${parsed.data.models.length} models, in use`)
    const file = modelDataFile()
    if (file) {
      try {
        // The config folder holds the app's secrets and is made owner-only by
        // config-manager at start-up, long before a read can end. It is never
        // made here: a folder made here would not be owner-only.
        if (!fs.statSync(path.dirname(file)).isDirectory()) throw new Error('no config folder')
        atomicWriteFileSync(file, text)
      } catch {
        logInfo('[registry] the model data could not be kept as the last good copy; it is in use for this run')
      }
    }
    return true
  })().catch(() => false)
  return refresh
}

/** Production init: call once at bootstrap with the resources directory.
 *  Synchronous and offline: the bundled file, the last good model data when
 *  there is one, and the overlay. The read itself is refreshModelRegistry. */
export function initModelRegistry(resourcesDir: string): void {
  overlayDir = resourcesDir
  refresh = null
  useModelData(readLastGood())
  reloadRegistry()
}

/** Test seam. */
export function _initRegistryForTest(dir: string): void { initModelRegistry(dir) }
