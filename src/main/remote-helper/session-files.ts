/**
 * A remote session's files on its host (2.1.3-beta.18, plan section 3.2;
 * aicc_planning#431): what core hands the two fixed scripts that read and
 * write them (./scripts.ts `reads` and `files`) and what it makes of their
 * answers. The names and the reads come from the tab's provider package (its
 * remote launch, providers/types.ts ProviderRemoteLaunch); core checks each
 * against its own alphabet before ssh starts, and none goes on a command
 * line but the layout of names and sizes. Paths and contents go on standard
 * input; a host's answer is data, decoded here and never run.
 *
 * This file imports nothing of Electron.
 */
import { decodeSettingsText } from '../settings-text'
import type { RemoteHostFile, RemoteHostRead, RemoteLaunch } from '../providers/types'
import { FILES_LAYOUT_RE, HOST_READ_MAX } from './scripts'
import type { ScriptResult } from './ssh-exec'

/** Host reads one launch may ask for, at most. */
export const HOST_READS_MAX = 16
/** One name in a host read's path: a plain name, never `.` or `..`. */
const READ_NAME_RE = /^[A-Za-z0-9._-]{1,255}$/
const READ_FROM: ReadonlySet<string> = new Set(['home', 'cwd', 'checkout'])
/** What a host read's exec says of a file it did not take. */
export const HOST_READ_SKIPS: ReadonlySet<string> = new Set(['link', 'type', 'owner', 'mode', 'size'])

/** Why a host read cannot be asked for, or null when it can. */
export function hostReadProblem(r: RemoteHostRead): string | null {
  if (!r || !READ_FROM.has(r.from)) return 'its folder is not home, cwd or checkout'
  if (typeof r.path !== 'string' || r.path.length === 0 || r.path.length > 1024) return 'its path is empty or long'
  const names = r.path.split('/')
  if (names.length > 16 || names.some((n) => !READ_NAME_RE.test(n) || n === '.' || n === '..')) return 'its path is not plain names joined by /'
  return null
}

/** A control character anywhere, a line end included. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/**
 * The `reads` script's standard input: the session folder on one line, then
 * one `<from> <path>` line per read. Throws, saying why, when the folder is
 * not absolute or holds a control character, when there are too many reads,
 * or when one of them cannot be asked for.
 */
export function hostReadsInput(cwd: string, reads: readonly RemoteHostRead[]): Buffer {
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || CONTROL_RE.test(cwd)) throw new Error('the session folder is not an absolute path the host can be given')
  if (reads.length > HOST_READS_MAX) throw new Error(`its provider asks for more than ${HOST_READS_MAX} files on the host`)
  for (const r of reads) {
    const why = hostReadProblem(r)
    if (why) throw new Error(`its provider asks for a host file that cannot be read (${why})`)
  }
  return Buffer.from(`${cwd}\n${reads.map((r) => `${r.from} ${r.path}\n`).join('')}`, 'utf8')
}

/** What the `reads` exec gave: each read's text (null when it was not read),
 *  in the reads' order, and the ones that were there and not taken, with why. */
export interface HostReadsAnswer {
  files: RemoteHostFile[]
  skipped: Array<{ read: RemoteHostRead; why: string }>
}

/** The bytes of one read, from its hex, or null when that does not read. */
function bytesOfHex(hex: string): Buffer | null {
  if (hex.length > HOST_READ_MAX * 2 || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return null
  return Buffer.from(hex, 'hex')
}

/**
 * Each read as the `reads` exec answered it: `f<i> ok <hex>` is its bytes,
 * decoded as a settings file is (UTF-16LE after an FF FE mark, else UTF-8, a
 * leading byte-order mark dropped: ../settings-text.ts); `f<i> skip <why>` is
 * one that was there and not taken; none is one that was not there. An
 * answer that does not read is a read not made, skipped as `unknown`.
 */
export function hostReadsOf(result: ScriptResult | null, reads: readonly RemoteHostRead[]): HostReadsAnswer {
  const files: RemoteHostFile[] = []
  const skipped: HostReadsAnswer['skipped'] = []
  reads.forEach((read, i) => {
    const said = result?.ok ? result.values.get(`f${i}`) : undefined
    let content: string | null = null
    const ok = said !== undefined ? /^ok ([0-9a-f]*)$/.exec(said) : null
    const bytes = ok ? bytesOfHex(ok[1]) : null
    if (bytes) {
      content = decodeSettingsText(bytes, bytes.length)
    } else if (said !== undefined) {
      const why = ok ? undefined : /^skip ([a-z]{1,16})$/.exec(said)?.[1]
      skipped.push({ read, why: why && HOST_READ_SKIPS.has(why) ? why : 'unknown' })
    }
    files.push({ from: read.from, path: read.path, content })
  })
  return { files, skipped }
}

/** A session file's name: plain, and never starting with a dot (the `files`
 *  script's staging names do). */
export const SESSION_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Session files one launch may give, at most, and their bytes in all. */
export const SESSION_FILES_MAX = 8
export const SESSION_FILES_BYTES_MAX = 4 * 1024 * 1024

/**
 * The `files` script's layout value and standard input for a launch's files:
 * `<name>:<size>` for each, joined by commas, and their bytes in that order.
 * Throws, saying why, on a name that is not plain, a name given twice, more
 * than SESSION_FILES_MAX files or more than SESSION_FILES_BYTES_MAX bytes.
 */
export function sessionFilesInput(files: RemoteLaunch['files']): { layout: string; stdin: Buffer } {
  if (files.length === 0 || files.length > SESSION_FILES_MAX) throw new Error(`its provider gives ${files.length} files for the session's folder (1 to ${SESSION_FILES_MAX} are taken)`)
  const seen = new Set<string>()
  const parts: Buffer[] = []
  const layout: string[] = []
  for (const f of files) {
    if (typeof f.name !== 'string' || !SESSION_FILE_NAME_RE.test(f.name) || seen.has(f.name)) throw new Error('its provider gives a session file whose name is not a plain one, or is given twice')
    seen.add(f.name)
    const bytes = Buffer.from(f.content, 'utf8')
    parts.push(bytes)
    layout.push(`${f.name}:${bytes.length}`)
  }
  const stdin = Buffer.concat(parts)
  if (stdin.length > SESSION_FILES_BYTES_MAX) throw new Error(`its provider's session files are over ${SESSION_FILES_BYTES_MAX} bytes`)
  const value = layout.join(',')
  if (!FILES_LAYOUT_RE.test(value)) throw new Error('its provider\'s session files cannot be given to the host')
  return { layout: value, stdin }
}

/**
 * The fields of `payload` that `keep` names (a nested field by its dotted
 * path), each a string of at most 4,096 characters, a finite number or a
 * boolean, in a new object of the same shape; nothing else. What a provider's
 * keep-list does not name never goes past here (docs/remote/helper-protocol.md,
 * payload allow-lists): an object or a list at a kept path is dropped too.
 */
export function keepFields(payload: Readonly<Record<string, unknown>>, keep: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of keep) {
    const names = p.split('.')
    if (names.some((n) => n === '' || n === '__proto__' || n === 'constructor' || n === 'prototype')) continue
    let at: unknown = payload
    for (const n of names) {
      at = at !== null && typeof at === 'object' && !Array.isArray(at) && Object.prototype.hasOwnProperty.call(at, n) ? (at as Record<string, unknown>)[n] : undefined
      if (at === undefined) break
    }
    const ok = (typeof at === 'string' && at.length <= 4096) || (typeof at === 'number' && Number.isFinite(at)) || typeof at === 'boolean'
    if (!ok) continue
    let into = out
    for (const n of names.slice(0, -1)) {
      const next = Object.prototype.hasOwnProperty.call(into, n) ? into[n] : undefined
      if (next === undefined) into = (into[n] = {}) as Record<string, unknown>
      else if (next !== null && typeof next === 'object') into = next as Record<string, unknown>
      else { into = {}; break }
    }
    into[names[names.length - 1]] = at
  }
  return out
}
