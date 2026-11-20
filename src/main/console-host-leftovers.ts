/**
 * Console hosts a run of the app left when it was ended from outside
 * (aicc_planning #330, Windows only).
 *
 * Each terminal tab is a pseudoconsole, and Windows starts its console host
 * (conhost.exe, or node-pty's bundled OpenConsole.exe) as a child of this
 * main process. Only closing the pseudoconsole ends that host on purpose.
 * When the app is ended from outside (Task Manager, a crash), nothing closes
 * it, and on some Windows builds the host keeps running, idle, until sign-out
 * (measured on the test VM: the Claude Code tab's host, 4 of 11 kills).
 *
 * So, once at start-up, the app runs the session helper's console-hosts mode
 * with the record of the run before (its main process's pid and creation
 * time, in app-run.json in this run's data folder: the user data folder for
 * an installed app, a dev or E2E run's own data root otherwise, so a dev run
 * never reads or replaces an installed app's record). The helper ends each
 * console host whose parent is that pid, made after that run started and
 * before the helper did and before any process that has the pid now, of this
 * user, and ends nothing while that pid still has that creation time
 * (docs/remote/helper-protocol.md section 15, "Console hosts a run left").
 * The helper also names the process that started it, this one, by pid and
 * creation time, and that becomes the record for the next start. A clean quit
 * removes the record: its terminals are closed, so nothing is left to look for.
 *
 * The record is read strictly (a pid and a creation time of digits, at most
 * 1 KiB); anything else is removed and ignored. No helper in this install (a
 * development run without a build, or a helper an uninstall removed) means
 * nothing is looked for and the record stays for a later start. A data root
 * that is not absolute gives no record, so nothing is looked for either.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import { app } from 'electron'
import { atomicWriteFileSync } from './atomic-write'
import { bundledHelperPath, instanceRecordPath } from './session-helper/install'
import { logError, logInfo } from './debug-logger'

/** The record of this run, in this run's data folder (runRecordPath). */
export const RUN_RECORD_FILE = 'app-run.json'
/** A record larger than this is not one the app wrote. */
export const RUN_RECORD_MAX_BYTES = 1024
/** How long the helper's console-hosts mode may take. */
const HELPER_TIMEOUT_MS = 10_000
/** The most of the helper's answer that is read. */
const HELPER_MAX_OUTPUT = 64 * 1024

/** A run: its main process's pid and creation time, in the form the helper prints. */
export interface RunRecord {
  pid: number
  created: string
}

function isPid(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 0xffffffff
}

function isCreated(v: unknown): v is string {
  return typeof v === 'string' && /^\d{1,20}$/.test(v)
}

/** One JSON object on one line with exactly `keys`, or null. */
function strictObject(text: string, keys: string): Record<string, unknown> | null {
  const line = String(text ?? '').trim()
  if (line === '' || /[\r\n]/.test(line)) return null
  let v: unknown
  try { v = JSON.parse(line) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  return Object.keys(o).join(',') === keys ? o : null
}

/** The record, read strictly: exactly a pid and a creation time of digits. Anything else is null. */
export function parseRunRecord(text: string): RunRecord | null {
  const o = strictObject(text, 'pid,created')
  if (!o || !isPid(o.pid) || !isCreated(o.created)) return null
  return { pid: o.pid, created: o.created }
}

/** The one line the helper's console-hosts mode prints, read strictly. */
export function parseConsoleHostsAnswer(stdout: string): (RunRecord & { ended: number }) | null {
  const o = strictObject(stdout, 'pid,created,ended')
  if (!o || !isPid(o.pid) || !isCreated(o.created)) return null
  if (typeof o.ended !== 'number' || !Number.isSafeInteger(o.ended) || o.ended < 0) return null
  return { pid: o.pid, created: o.created, ended: o.ended }
}

/** What one run of the helper gave. */
export interface HelperRun {
  ok: boolean
  stdout: string
  stderr: string
  /** Why it failed, when it did. */
  why?: string
}

/** What the clean-up needs from the app, the disk and the helper (tests give fakes). */
export interface LeftoverPorts {
  platform: NodeJS.Platform
  /** This main process's pid. */
  ownPid: number
  /** The record file's full path. */
  recordFile: string
  /** The helper beside the app, or null when this install has none. */
  helperPath(): string | null
  /** The file's text, or null when it is not there or is larger than `max` bytes ('large'). */
  readFile(file: string, max: number): string | null | 'large'
  writeFile(file: string, text: string): void
  removeFile(file: string): void
  runHelper(helper: string, args: string[]): Promise<HelperRun>
  /** Run `fn` once when the app quits cleanly. */
  onQuit(fn: () => void): void
  log(line: string): void
  logError(line: string): void
}

/**
 * Once at start-up: end the console hosts the run before left, and record
 * this run for the next start (see the module comment). Never throws.
 */
export async function endLeftoverConsoleHosts(ports: LeftoverPorts): Promise<void> {
  if (ports.platform !== 'win32') return
  try {
    let record: RunRecord | null = null
    const text = ports.readFile(ports.recordFile, RUN_RECORD_MAX_BYTES)
    if (text !== null) {
      record = text === 'large' ? null : parseRunRecord(text)
      if (!record) {
        ports.log('[console-hosts] The record of the run before could not be read; it is removed and ignored')
        try { ports.removeFile(ports.recordFile) } catch { /* gone already */ }
      }
    }
    const helper = ports.helperPath()
    if (!helper) {
      ports.log('[console-hosts] The session helper is not in this install, so no console host of an earlier run is looked for')
      return
    }
    const args = ['console-hosts', ...(record ? ['--pid', String(record.pid), '--created', record.created] : [])]
    const run = await ports.runHelper(helper, args)
    const notes = run.stderr.trim().slice(0, 1000)
    if (!run.ok) {
      ports.log(`[console-hosts] The session helper could not look for console hosts of an earlier run (${(run.why || notes || 'no reason given').slice(0, 300)}); this run is not recorded`)
      return
    }
    const answer = parseConsoleHostsAnswer(run.stdout)
    if (!answer || answer.pid !== ports.ownPid) {
      ports.log('[console-hosts] The session helper\'s answer could not be read, or names another process; this run is not recorded')
      return
    }
    if (answer.ended > 0) ports.log(`[console-hosts] Ended ${answer.ended} console host(s) an earlier run left when it was ended from outside`)
    if (notes) ports.log(`[console-hosts] ${notes}`)
    const mine: RunRecord = { pid: answer.pid, created: answer.created }
    ports.writeFile(ports.recordFile, JSON.stringify(mine))
    ports.onQuit(() => {
      // Only this run's record: a later start may have written its own.
      const now = ports.readFile(ports.recordFile, RUN_RECORD_MAX_BYTES)
      const read = typeof now === 'string' ? parseRunRecord(now) : null
      if (read && read.pid === mine.pid && read.created === mine.created) {
        try { ports.removeFile(ports.recordFile) } catch { /* gone already */ }
      }
    })
  } catch (err) {
    ports.logError(`[console-hosts] Looking for console hosts of an earlier run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Where this run keeps its record: the user data folder for an installed app,
 * an E2E or dev run's own data root otherwise, by the rule in dev-data-root.ts
 * devDataRoot (through session-helper/install.ts instanceRecordPath, as
 * vision-started.json is placed). A dev run shares the user data folder with
 * an installed app on the same computer, and must never hand that app's run
 * to the helper or write over its record. Null when there is no folder to use
 * (a data root that is not absolute).
 */
function runRecordPath(): string | null {
  try {
    return instanceRecordPath(RUN_RECORD_FILE, { isPackaged: app.isPackaged, userData: () => app.getPath('userData') })
  } catch { return null }
}

/** The ports of the running app, with its record at `recordFile`. */
function appPorts(recordFile: string): LeftoverPorts {
  return {
    platform: process.platform,
    ownPid: process.pid,
    recordFile,
    helperPath: () => {
      try {
        const p = bundledHelperPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), platform: 'win32' })
        return fs.existsSync(p) ? p : null
      } catch { return null }
    },
    readFile: (file, max) => {
      let size: number
      try { size = fs.statSync(file).size } catch { return null }
      if (size > max) return 'large'
      try { return fs.readFileSync(file, 'utf8') } catch { return null }
    },
    writeFile: (file, text) => atomicWriteFileSync(file, text, { mode: 0o600 }),
    removeFile: (file) => fs.rmSync(file, { force: true }),
    runHelper: (helper, args) => new Promise<HelperRun>((resolve) => {
      try {
        execFile(helper, args, { windowsHide: true, timeout: HELPER_TIMEOUT_MS, maxBuffer: HELPER_MAX_OUTPUT, encoding: 'utf8' }, (err, stdout, stderr) => {
          const why = err ? ((err as { killed?: unknown }).killed === true ? `no answer within ${HELPER_TIMEOUT_MS / 1000} s` : (err instanceof Error ? err.message : String(err))) : undefined
          resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), why })
        })
      } catch (err) {
        resolve({ ok: false, stdout: '', stderr: '', why: err instanceof Error ? err.message : String(err) })
      }
    }),
    onQuit: (fn) => { app.once('will-quit', () => { try { fn() } catch { /* best effort */ } }) },
    log: (line) => logInfo(line),
    logError: (line) => logError(line),
  }
}

/** The start-up call (index.ts): runs in the background, never throws. */
export function endLeftoverConsoleHostsAtStart(): void {
  if (process.platform !== 'win32') return
  const recordFile = runRecordPath()
  if (!recordFile) {
    logInfo('[console-hosts] This run has no data folder for its record, so no console host of an earlier run is looked for')
    return
  }
  void endLeftoverConsoleHosts(appPorts(recordFile))
}
