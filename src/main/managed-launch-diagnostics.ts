// Layers 3 and 4 of the managed launch: the project-settings GATE and the
// visible preflight record.
//
// READ THIS BEFORE TRUSTING ANYTHING HERE. The gate refuses a launch whose
// working directory carries a DETECTABLE override in its own settings files
// (`.claude/settings.json`, `.claude/settings.local.json`): a credential
// helper, an account pin, a provider switch or an endpoint redirect, as the
// authority manifest defines them. The preflight is the RECORD of what a
// launch did -- the refusal included -- not a proof that a session is isolated.
// What neither can see is a recorded boundary:
//
//   - settings changed AFTER the process started;
//   - remote / organisation-managed settings, which the CLI fetches from the
//     server for a signed-in account;
//   - another process of the same OS user acting on the realm;
//   - a directory the gate cannot read safely (a network path) or in time,
//     which launches UNCHECKED with a warning rather than a refusal;
//   - anything a future CLI version reads that this version does not.
//
// There is no host-side control any more: the flag that suppressed these at
// run time also stopped the profile's own login (owner decision, 2026-09-22;
// evidence Parts 7 and 8). Refusing before launch is what this app can do
// honestly; the rest it says.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { logInfo, logWarn } from './debug-logger'
import { managedLaunchPreflightFor, authoritySettingsKeysFor } from './providers'
import { peekClaudeCliVersion, ensureClaudeCliVersion, claudeCliProbeAllowed } from './claude-cli-version'
import { decodeSettingsText } from './settings-text'
import { GitPointerChangedError, readFully, isGitRootEntry, canonicalGitRootOf, posixCanonicalLocalSettingsRoot } from './git-local-settings-root'
// From the shared state module, NOT from account-profiles: the choke point in
// account-profiles calls this recorder, so importing back would make the launch
// path and its own diagnostics a cycle (see ./managed-launch-state.ts).
import { lastSettingsSanitiseFor, lastAmbientStripFor } from './managed-launch-state'
import { boundNames } from '../shared/providers'
import { stripSpoofableText } from '../shared/safe-text'
import type { ManagedLaunchPreflight, ManagedLaunchPreflightInput, ProjectGateResult, ProjectScanSkipReason } from '../shared/providers'

/** A launch the USER started, or a PROBE this app ran by itself.
 *
 *  They are not interchangeable on the panel. `readClaudeCliAuth` runs a real
 *  managed launch -- it gets the full hardening, and its report is worth having
 *  in the log -- but it fires on every Accounts row mount, every auth-method
 *  toggle and every session right-click. Treating it as the newest launch meant
 *  OPENING the Accounts panel replaced the report the panel was about to show
 *  with the probe's, displacing exactly the project-settings finding this round
 *  added (adversarial review, MAJOR). */
export type { ManagedLaunchKind } from '../shared/providers'
import type { ManagedLaunchKind } from '../shared/providers'

/** The internal record. `home` is an ABSOLUTE path and therefore carries the OS
 *  username, so it stays in the main process and never reaches the wire.
 *  `input` is kept with the record, for the tests and the log. */
interface StoredReport {
  home: string
  profileId: string
  sessionId: string
  kind: ManagedLaunchKind
  at: number
  /** Monotonic record order. `at` has millisecond resolution, so two launches
   *  in the same tick cannot be ordered by it -- and "newest first" is what the
   *  panel answers with. */
  seq: number
  preflight: ManagedLaunchPreflight
  input: ManagedLaunchPreflightInput
}

/** What a renderer receives: scoped to ONE profile, with no absolute path. */
export interface ManagedLaunchReport {
  profileId: string
  sessionId: string
  kind: ManagedLaunchKind
  at: number
  preflight: ManagedLaunchPreflight
}

/** Bounded so a long-running app cannot accumulate one entry per session for
 *  the life of the process. The newest are the ones anybody looks at.
 *
 *  TWO rings, and that is the point. One shared ring meant probes evicted
 *  launches: this app runs an auth-status probe on every Accounts row mount, so
 *  sixteen panel opens on a three-account install pushed every real launch out
 *  and the panel fell back to showing a probe with no findings -- the exact
 *  report this round exists to surface, invisible again (adversarial re-attack,
 *  MAJOR). Probes are worth keeping and worth logging; they are not worth a
 *  launch's slot. */
const MAX_REPORTS = 50
const MAX_PROBE_REPORTS = 20
const reports: StoredReport[] = []
const probeReports: StoredReport[] = []
let nextSeq = 0
const ringFor = (kind: ManagedLaunchKind): StoredReport[] => (kind === 'probe' ? probeReports : reports)

/** Project- and local-scope settings files, in the order the CLI reads them.
 *  The app never writes or modifies either: they belong to the repository. */
const PROJECT_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const

/** The largest settings file the gate reads, and it is the CLI's OWN cap:
 *  Claude Code 2.1.278 reads a settings file through a `maxBytes` of
 *  2,097,152 and reports one over it as unreadable, applying nothing. The two
 *  must match exactly: a gate cap below the CLI's was a window (128 KiB to
 *  2 MiB) in which a repository's settings file was too big for the gate and
 *  small enough for the CLI (adversarial review, MAJOR). A file over the cap
 *  is `not-scanned` with reason `over-cap`, never clean (exact-head review):
 *  the pinned CLI skips it too, but that is a fact about one CLI version, and
 *  the gate did not read the file. The fixed-buffer read stays, so the cost is
 *  bounded by the cap, not by what the file is at the moment of reading. */
const MAX_PROJECT_SETTINGS_BYTES = 2 * 1024 * 1024

// At most MAX_REPORTED_NAMES key names reach the panel; the rest become a
// count (`boundNames`, shared with the settings-copy finding so the two bounds
// cannot drift). Not cosmetic: settings keys are JSON properties and the `env`
// match is case-insensitive, so ONE authority name can appear under hundreds
// of spellings in a file that is still inside the size cap -- which turned the
// finding text into a megabyte of string, crossing IPC and rendering into a
// single list item (adversarial review, MINOR).

/** A path as it may be written to the app log: control and spoofing
 *  characters out (see ../shared/safe-text.ts). The log sink escapes only CR
 *  and LF, and a working directory is user-chosen text. */
const describePath = (p: string): string => stripSpoofableText(p, 300)

/** A path as it may reach the TERMINAL or the ACCOUNTS PANEL: the same strip,
 *  and the user's home directory shortened to `~` -- an absolute path under
 *  the home carries the OS username, which this module keeps off the wire
 *  everywhere else (spec review, MINOR). The rest of the path stays, because
 *  "which directory" is the whole point of naming it. */
export function displayPath(p: string): string {
  let home = ''
  try { home = os.homedir() } catch { /* no home to shorten */ }
  // Case-insensitively on Windows: a configured directory arrives in whatever
  // case the user typed it, and a miss here is the username on the wire
  // (code-quality review, MINOR).
  const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const under = home !== '' && (fold(p) === fold(home) || fold(p).startsWith(fold(home) + path.sep))
  const shortened = under ? '~' + p.slice(home.length) : p
  return stripSpoofableText(shortened, 300)
}

/** What one `.claude/settings*.json` turned out to be. Only `absent` and
 *  `keys` are certain; `uncertain` carries why (see ProjectScanSkipReason). */
type SettingsFileScan =
  | { readonly kind: 'absent' }
  | { readonly kind: 'keys'; readonly keys: readonly string[] }
  | { readonly kind: 'uncertain'; readonly reason: 'unreadable' | 'over-cap' | 'classifier-unavailable' }

/** The authority `keys` of `file` (a `.claude/settings*.json`), read under the
 *  size cap and the regular-file rule, to end of file.
 *
 *  THREE OUTCOMES, AND ONLY TWO OF THEM ARE CLEAN. The first version returned
 *  `null` for everything that was not a list of keys -- absent, unreadable,
 *  over the cap, not a regular file, no classifier -- and the caller read
 *  `null` as "nothing to report", so each of those produced a CLEAN verdict
 *  that was cached and launched with no warning (exact-head review, BLOCKER).
 *  Now:
 *   - `absent`: the file (or its `.claude` directory) does not exist -- the
 *     CLI reads nothing there either;
 *   - `keys`: the file was read IN FULL and classified; an empty list is a
 *     clean file. A file read in full that the CLI's strict parser rejects is
 *     classified as carrying nothing, which is what the CLI applies from it
 *     (measured, evidence Part 9) -- that is a certain answer, not a failure;
 *   - `uncertain`: anything else. The gate does not know what the file
 *     carries, and says so as `not-scanned` with the reason. */
async function authorityKeysOfSettingsFile(file: string): Promise<SettingsFileScan> {
  let handle: fs.promises.FileHandle | null = null
  try {
    // O_NONBLOCK on the OPEN, not only on the read. On POSIX, opening a FIFO
    // for reading blocks until a writer appears -- BEFORE the `isFile()` check
    // below can refuse it -- so the check that was written against "the read
    // blocks" never ran: the open itself held the threadpool thread, and the
    // FIFO test below was red on Linux the first time it was run there (this
    // branch had only ever been tested on Windows). With O_NONBLOCK the open
    // returns at once and the fstat does the refusing. A regular file is not
    // affected by the flag; Windows has no such flag and the constant is
    // absent there, hence the fallback to 0.
    try {
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // Nothing there: the one open failure that is an answer.
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
      return { kind: 'uncertain', reason: 'unreadable' }
    }
    const stat = await handle.stat()
    // A FIFO, a device or a directory is not a settings file, and its `size`
    // tells you nothing about what reading it would cost. It is also not
    // ABSENT, so it is not clean either.
    if (!stat.isFile()) return { kind: 'uncertain', reason: 'unreadable' }
    if (stat.size > MAX_PROJECT_SETTINGS_BYTES) return { kind: 'uncertain', reason: 'over-cap' }
    // Read into a FIXED buffer rather than calling `handle.readFile()`. That
    // helper re-stats the handle and allocates for whatever the file is at
    // that moment, so the check above was advisory rather than a bound: with a
    // concurrent local writer, a file that stat'd at 7 bytes was measured
    // coming back at 314 MB, decoded and parsed on the main thread
    // (adversarial round 4). The buffer is the bound, and `readFully` fills
    // it to end of file rather than trusting one read.
    // cap + 1, and a byte past the cap is over the cap. Reading exactly the cap
    // would hand JSON.parse a truncated prefix of a file that grew -- possibly
    // cut mid-character -- and report whatever survived as if it were the file.
    const buf = Buffer.allocUnsafe(MAX_PROJECT_SETTINGS_BYTES + 1)
    const bytesRead = await readFully(handle, buf)
    if (bytesRead > MAX_PROJECT_SETTINGS_BYTES) return { kind: 'uncertain', reason: 'over-cap' }
    // Fewer or more bytes than the file had when it was measured: it changed
    // while it was being read, and what arrived is not a file that ever
    // existed whole. Not clean.
    if (bytesRead !== stat.size) return { kind: 'uncertain', reason: 'unreadable' }
    // Decoded as the CLI decodes it: a byte-order mark selects the encoding and
    // is dropped, so a BOM-prefixed or UTF-16 file the CLI parses is one the
    // gate parses too (adversarial review, design lens; see ./settings-text.ts).
    const raw = decodeSettingsText(buf, bytesRead)
    let keys: readonly string[] | null
    try {
      keys = authoritySettingsKeysFor('claude', raw)
    } catch (err) {
      logWarn(`[managed-launch] project settings not classified: ${stripSpoofableText(err instanceof Error ? err.message : String(err), 300)}`)
      return { kind: 'uncertain', reason: 'classifier-unavailable' }
    }
    // `null` means there was nobody to ask (no registered provider), which is
    // not the same as "this file carries nothing".
    if (keys === null) {
      logWarn(`[managed-launch] project settings not classified: no registered Claude package to ask`)
      return { kind: 'uncertain', reason: 'classifier-unavailable' }
    }
    return { kind: 'keys', keys }
  } catch {
    // The handle opened and a stat or a read then failed.
    return { kind: 'uncertain', reason: 'unreadable' }
  } finally {
    await handle?.close().catch(() => {})
  }
}

// The canonical git root rule (where the CLI reads `settings.local.json` on
// POSIX) lives in ./git-local-settings-root.ts, shared with the session hooks
// writer so both read the files the CLI reads. These seams keep its tests here.

/** TEST SEAM for the root-entry predicate. */
export const _isGitRootEntryForTest = isGitRootEntry

/** TEST SEAM for the worktree pointer rule. */
export const _canonicalGitRootOfForTest = canonicalGitRootOf

/** TEST SEAM for the POSIX git-root rule, so a test can drive it on a
 *  fixture checkout without a launch. */
export const _posixCanonicalLocalSettingsRootForTest = posixCanonicalLocalSettingsRoot

/**
 * Authority-bearing keys a PROJECT's own settings carry, for the report.
 *
 * ASYNC, AND NEVER SYNCHRONOUS -- read the next paragraph before making it so.
 * The first version of this ran `statSync` + `readFileSync` inside
 * `withProfileHome`, which is called synchronously by every launch. A working
 * directory on an unreachable share (a sleeping NAS, a VPN that dropped, a
 * stale mapped drive -- no attacker required) then blocked the ELECTRON MAIN
 * THREAD for the SMB timeout: measured at 42 seconds, twice, on two unrelated
 * dead hosts, per file, per launch. A `try/catch` cannot catch a blocking
 * syscall.
 *
 * It is now awaited by the launch GATE (`gateManagedLaunch`), which every
 * launch path runs before it composes the environment, under a deadline and a
 * thread ceiling. Three further bounds, each from a measured failure:
 *   - the handle is OPENED and `fstat`ed, and anything that is not a regular
 *     file is refused, because `size` is 0 for a FIFO and for a character
 *     device -- so the size cap passed and the read blocked forever (POSIX) or
 *     ran to 2 GiB on `/dev/zero`;
 *   - the cap is on the file, and the classification no longer produces a
 *     sanitised COPY it would throw away: a pretty-printing stringify is
 *     O(depth^2), so a nested file UNDER the old 1 MiB cap cost 3.4 s of CPU;
 *   - the whole amendment is raced against a short deadline, so a slow path
 *     that is merely slow rather than dead still costs nothing visible.
 *
 * The files read are the ones the CLI reads for this directory: its own
 * `settings.json` and `settings.local.json`, plus, on POSIX only, the
 * repository root's `settings.local.json` when the CLI would canonicalise to
 * it (see `posixCanonicalLocalSettingsRoot`).
 *
 * It never modifies anything it reads. These files belong to the repository;
 * what a managed session does about them is REFUSE to start, not an edit.
 */
async function projectAuthoritySettingsKeys(cwd: string | null): Promise<ProjectScan> {
  if (!cwd) return { keys: [], uncertain: null }
  // The directory the gate reads must be the directory the CLI will run in.
  // Node's fs does not apply Win32 path normalisation (it prefixes `\\?\`);
  // CreateProcess does. A working directory spelled `C:\proj.` was ENOENT here
  // -- both files "absent", a clean verdict -- while a CLI spawned with that
  // cwd ran in `C:\proj` and applied its settings (adversarial round 8, MAJOR,
  // through a cloud agent's raw project path). Asked of the RESOLVED path: a
  // `..` after a dotted component (`C:\ghost.\..\proj`) is removed lexically
  // by both Node and CreateProcess, the gate reads the same folder the CLI
  // runs in, and the raw spelling turned that REFUSAL into a warning (final
  // ADR-009 confirmation pass, MAJOR).
  if (process.platform === 'win32' && hasWin32RewrittenComponent(path.resolve(cwd))) return { keys: [], uncertain: 'path-spelling' }
  const found: string[] = []
  let uncertain: ProjectScanSkipReason | null = null
  const take = (label: string, scan: SettingsFileScan): void => {
    if (scan.kind === 'keys') for (const key of scan.keys) found.push(`${label}: ${key}`)
    else if (scan.kind === 'uncertain') uncertain ??= scan.reason
  }
  for (const name of PROJECT_SETTINGS_FILES) take(name, await authorityKeysOfSettingsFile(path.join(cwd, '.claude', name)))
  let root: string | null = null
  try {
    root = await posixCanonicalLocalSettingsRoot(cwd)
  } catch (err) {
    // Which root the CLI reads is unknown, so its local settings are too. The
    // working directory's own files still count: a key found there refuses.
    if (!(err instanceof GitPointerChangedError)) throw err
    uncertain ??= 'unreadable'
  }
  if (root !== null) take('settings.local.json (repository root)', await authorityKeysOfSettingsFile(path.join(root, '.claude', 'settings.local.json')))
  return { keys: boundNames(found), uncertain }
}

/** A path with a component CreateProcess rewrites before it starts a program:
 *  measured on Windows 11, it drops trailing dots from EVERY component and a
 *  trailing space from the last (a middle component ending in a space fails to
 *  spawn at all), so a component ending in either is a spelling whose folder is
 *  not the one Node's fs opens. */
function hasWin32RewrittenComponent(p: string): boolean {
  return p.split(/[\\/]/).some((c) => c !== '' && c !== '.' && c !== '..' && /[. ]$/.test(c))
}

/** What a directory's scan found: every authority key it could name, and the
 *  first reason it could not be certain of a file, if any. */
interface ProjectScan {
  readonly keys: readonly string[]
  readonly uncertain: ProjectScanSkipReason | null
}

/** One verdict from one scan. A refusal stands whatever else was uncertain --
 *  a named authority key is reason enough; with no key, any uncertainty is
 *  `not-scanned`, never `clean`. */
function verdictOfScan(scan: ProjectScan): ProjectGateResult {
  if (scan.keys.length > 0) return { status: 'refused', keys: scan.keys }
  if (scan.uncertain !== null) return { status: 'not-scanned', reason: scan.uncertain }
  return { status: 'clean' }
}

/** TEST SEAM. The scan on its own, so a test can assert that it RETURNS on a
 *  path that would block a read -- an assertion the amended report cannot
 *  carry, because "no finding" is what both a refused scan and a blocked one
 *  look like from outside. */
export const _projectAuthoritySettingsKeysForTest = projectAuthoritySettingsKeys

/** How long the launch gate waits for the project scan. It is ON the launch
 *  path now -- the session does not start until it answers -- so it is set for
 *  a slow local disk, not for a dead share, which is refused before any syscall.
 *  Past it the launch goes ahead UNCHECKED, with a warning on the report. */
const PROJECT_GATE_DEADLINE_MS = 3000

/**
 * At most TWO project scans hold a filesystem thread at any time.
 *
 * The deadline above bounds the PROMISE, not the syscall. `fs.promises.open`
 * takes no AbortSignal (checked against Node 24: the third argument is `mode`),
 * so a gate that gives up still leaves the open running on the libuv THREADPOOL
 * until the OS gives up -- 42 seconds on an unreachable share. The pool has four
 * threads by default and this app never raises it, so four such launches stall
 * every other threadpool consumer in the main process: all of `fs.promises`,
 * and `dns.lookup`, which is how `http`/`https` resolve a hostname. Measured at
 * 21 seconds of stalled local reads and DNS (adversarial re-attack, BLOCKER).
 *
 * The deadline cannot fix that; only not starting the call can. The count of
 * scans STARTED AND NOT SETTLED is the bound, at half the default pool, and it
 * is decremented only when a scan really settles -- a watchdog that "released"
 * anything earlier was one more stranded thread per window (adversarial round
 * 5, BLOCKER). Two launches into the same directory share ONE scan. At the
 * ceiling a launch waits for a slot until its deadline, then goes ahead
 * unchecked with a warning: two wedged mounts cost this check, not the app.
 */
let outstandingProjectScans = 0
/** Half of libuv's default four-thread pool. The other half stays available to
 *  everything else in the main process however badly a mount is wedged. */
const MAX_OUTSTANDING_PROJECT_SCANS = 2
/** One scan per directory at a time; concurrent launches into it share it. */
const inFlightScans = new Map<string, Promise<ProjectGateResult>>()
let projectScanCeilingLogged = false
/** The last verdict per directory, for `peekGateVerdict`. */
const recentVerdicts = new Map<string, { verdict: ProjectGateResult; at: number }>()
/** How long a verdict may be reused by a caller that cannot await. Well inside
 *  the "settings edited after launch" boundary this app already records. */
const GATE_VERDICT_REUSE_MS = 5000
/** The verdict the gate last ANSWERED per directory, `not-scanned` included,
 *  for `lastGateAnswer`: the latest answer for that folder to any caller in
 *  this process, not one launch's own. Unlike `recentVerdicts`, which keeps
 *  what a scan found even when every launch waiting for it had given up, this
 *  is what the caller was told: a scan that answered after its deadline is
 *  `timed-out` here. An entry older than the reuse window is dropped when the
 *  next answer is written. */
const lastGateAnswers = new Map<string, { verdict: ProjectGateResult; at: number }>()

/** Test seam: the counters are process-wide, so a suite that strands a scan on
 *  purpose has to be able to put them back. */
export function _resetProjectScanStateForTest(): void {
  outstandingProjectScans = 0
  inFlightScans.clear()
  recentVerdicts.clear()
  lastGateAnswers.clear()
  projectScanCeilingLogged = false
}
/** Test seam: the counters as they stand, so a test can assert on the ceiling
 *  episode without spying on the logger. */
export function _projectScanStateForTest(): { inFlight: number; outstanding: number; ceilingLogged: boolean } {
  return { inFlight: inFlightScans.size, outstanding: outstandingProjectScans, ceilingLogged: projectScanCeilingLogged }
}

/**
 * A path whose root is a network share, judged WITHOUT touching the disk.
 *
 * UNC only, which is the shape that produced the measured freeze and the one
 * that can be recognised from the string alone. A MAPPED DRIVE (`Z:` pointing
 * at the same dead host) is not detectable without a call that can itself
 * block, so it is not attempted -- the thread ceiling is what bounds that case,
 * and saying so is better than a check that pretends to cover it.
 *
 * Two leading separators are not enough on their own. The Win32 device and
 * extended-length prefixes (`\\?\` and `\\.\`) start the same way and are
 * followed by a LOCAL drive (`\\?\C:\proj`, which is how a long path arrives)
 * or a local volume (`\\?\Volume{...}\`) -- and a launch there was declined as
 * a network path, unchecked, with a warning that named the wrong reason
 * (adversarial review, MAJOR). Under such a prefix, `UNC\` names a share and
 * is network; a drive letter or a volume is local and is scanned; anything
 * else (`GLOBALROOT`, a device name) is opaque and treated as network, because
 * an unchecked launch with a warning beats a read that can block.
 */
function isUncPath(p: string): boolean {
  const s = p.replace(/\//g, '\\')
  const device = /^\\\\[?.]\\(.*)$/s.exec(s)
  if (device) {
    const rest = device[1]
    if (/^[A-Za-z]:(?:\\|$)/.test(rest)) return false
    if (/^Volume\{[^\\]*\}(?:\\|$)/i.test(rest)) return false
    const unc = /^UNC\\([^\\]+)(?:\\|$)/i.exec(rest)
    if (unc) return !isLoopbackHost(unc[1])
    return true
  }
  const share = /^\\\\([^\\]+)(?:\\|$)/.exec(s)
  if (!share) return false
  return !isLoopbackHost(share[1])
}

/** A UNC host that is THIS machine. `\\localhost\C$\proj` is a spelling of a
 *  local directory -- the CLI reads it and applies what it finds -- and the
 *  first version of the rule above declined it as a network path, which is
 *  the not-scanned, launch-anyway bucket: a directory the CLI reads with a
 *  verdict the gate never formed, chosen by spelling alone (adversarial
 *  re-attack, MAJOR). Loopback by name or address, or this host's own name,
 *  is local and is scanned; a local read that the share refuses fails closed
 *  as an absent file, which is what the CLI sees too. */
function isLoopbackHost(host: string): boolean {
  // A trailing dot is the DNS root: `localhost.` and `0--1.ipv6-literal.net.`
  // resolve exactly as the undotted names do, and a suffix rule that did not
  // see past the dot put the dotted spelling in the not-scanned bucket
  // (adversarial confirmation pass, MAJOR, measured). Strip it first.
  let h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  // The IPv6 forms Windows resolves as a UNC host: the *.ipv6-literal.net
  // spelling (`0--1.ipv6-literal.net`, `-` for `:`, `s` for a zone `%`),
  // the full eight-hextet form, and -- measured on this box, contrary to the
  // first note here -- `::1` and `[::1]` themselves. The first rule
  // enumerated `::1` and its zero-padded twin and missed the literal.net
  // form, leaving it in the not-scanned, launch-anyway bucket for a directory
  // the CLI reads (adversarial final pass, MAJOR). Normalise, then compare.
  if (h.endsWith('.ipv6-literal.net')) h = h.slice(0, -'.ipv6-literal.net'.length).replace(/-/g, ':').replace(/s/g, '%')
  h = h.replace(/%.*$/, '')
  if (h === 'localhost' || h === '127.0.0.1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  const v6 = normaliseIpv6(h)
  let mappedV4: string | null = null
  if (v6 !== null) {
    if (v6 === '0:0:0:0:0:0:0:1') return true
    // An IPv4-mapped address, ::ffff:a.b.c.d, in either spelling: loopback
    // when it maps 127/8, and otherwise compared below as the IPv4 it maps.
    const m = /^0:0:0:0:0:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6)
    if (m) {
      const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16)
      if (hi >> 8 === 127) return true
      mappedV4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
    }
  }
  // This machine's OWN addresses are UNC hosts for itself: `\\\\192.168.1.20\\C$`
  // and the ipv6-literal.net spelling of its own link-local or ULA address
  // (zone included) resolve to the local admin share exactly as `localhost`
  // does, and a rule that knew this host only by NAME left every one of them
  // in the not-scanned bucket (adversarial confirmation pass, MAJOR,
  // measured). Compare against every address the OS reports right now.
  for (const own of ownAddresses()) {
    if (own.includes(':')) { if (v6 !== null && normaliseIpv6(own) === v6) return true }
    else if (own === h || own === mappedV4) return true
  }
  let self = ''
  try { self = os.hostname().toLowerCase() } catch { /* no name to compare */ }
  if (self === '') return false
  // The name as given, its .local form, and its short form: a host whose name
  // is fully qualified is reached as `\\\\box\\share` far more often than as
  // `\\\\box.corp.example\\share` (spec review, INFO).
  const short = self.split('.')[0]
  return h === self || h === `${self}.local` || (short !== '' && h === short)
}

/** Every IPv4 and IPv6 address on this machine's interfaces, zone stripped,
 *  lower-cased; empty when the OS will not say. Read on each call: interfaces
 *  come and go, and the classification is asked only of a UNC-shaped path. */
function ownAddresses(): string[] {
  const out: string[] = []
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const entry of list ?? []) {
        if (typeof entry?.address !== 'string' || entry.address === '') continue
        out.push(entry.address.toLowerCase().replace(/%.*$/, ''))
      }
    }
  } catch { /* no interfaces to compare */ }
  return out
}

/** An IPv6 address as eight lower-case hextets with no leading zeros, or null
 *  when `text` is not one. `::` expands; a dotted IPv4 tail folds into the
 *  last two hextets. */
function normaliseIpv6(text: string): string | null {
  if (!text.includes(':') || !/^[0-9a-f:.]+$/.test(text)) return null
  let body = text
  const v4 = /(?:^|:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(body)
  if (v4) {
    const oct = v4.slice(1, 5).map((o) => parseInt(o, 10))
    if (oct.some((o) => o > 255)) return null
    body = body.slice(0, body.length - v4[0].length + (v4[0].startsWith(':') ? 1 : 0)) + ((oct[0] << 8) | oct[1]).toString(16) + ':' + ((oct[2] << 8) | oct[3]).toString(16)
  }
  const parts = body.split('::')
  if (parts.length > 2) return null
  const head = parts[0] === '' ? [] : parts[0].split(':')
  const tail = parts.length === 2 ? (parts[1] === '' ? [] : parts[1].split(':')) : []
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (parts.length === 1 && head.length !== 8)) return null
  const all = [...head, ...Array.from({ length: fill }, () => '0'), ...tail]
  if (all.length !== 8 || all.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null
  return all.map((x) => parseInt(x, 16).toString(16)).join(':')
}

/** TEST SEAM for the loopback rule: host in, verdict out. */
export const _isLoopbackHostForTest = isLoopbackHost

/** TEST SEAM for the network-path rule: string in, verdict out, no disk. */
export const _isUncPathForTest = isUncPath

/** The cache and in-flight key for a directory: ONE SPELLING, ONE VERDICT.
 *  The first version lower-cased the key everywhere, so on Linux and macOS
 *  `/Proj` and `/proj` -- two directories -- shared a verdict (adversarial
 *  review, MAJOR); the second folded only on Windows, and the re-attack showed
 *  an NTFS directory with per-directory case sensitivity enabled (no admin
 *  needed) where `proj` and `Proj` are two directories there too. So no
 *  folding at all: a directory reached under another spelling is scanned
 *  again, which costs a read, where a shared key could cost a verdict. */
function scanKeyFor(cwd: string): string {
  return path.resolve(cwd)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.())

/**
 * THE LAUNCH GATE. Decide, before a managed session starts in `cwd`, whether
 * the project's own settings files carry anything that would redirect it.
 *
 * Returns, never throws:
 *   - `clean`        -- both files were read (or are absent) and carry no
 *                        authority key; the launch may proceed;
 *   - `refused`      -- at least one authority key was found; the caller MUST
 *                        refuse the launch and name `keys` (file and key, never
 *                        a value -- `projectAuthoritySettingsKeys` produces
 *                        names only);
 *   - `not-scanned`  -- the files could not be read safely, in full, or in
 *                        time, or could not be classified; the caller proceeds
 *                        and the report carries a WARNING. A network path is
 *                        never read on the launch path; the thread ceiling and
 *                        the deadline are two more; an unreadable, over-cap or
 *                        unclassifiable file and a failed scan are the rest.
 *                        Never cached, and never reported as clean.
 *
 * Owner decision 2026-09-22: a detectable repository override fails visibly
 * BEFORE launch. What is not detectable is a recorded boundary, not a claim.
 * The files are never modified.
 *
 * Each answer is also kept for `lastGateAnswer`.
 */
export async function gateManagedLaunch(cwd: string): Promise<ProjectGateResult> {
  const verdict = await gateManagedLaunchOnce(cwd)
  const now = Date.now()
  for (const [key, hit] of lastGateAnswers) if (now - hit.at > GATE_VERDICT_REUSE_MS) lastGateAnswers.delete(key)
  lastGateAnswers.set(scanKeyFor(cwd), { verdict, at: now })
  return verdict
}

/** The verdict `gateManagedLaunch` last answered for `cwd`, `not-scanned`
 *  included, or undefined when it has answered none within the reuse window.
 *  It is the latest answer for that folder to any caller in this process, so
 *  it is a launch's own answer only when read straight after that launch's own
 *  gate of `cwd` has answered, with no `await` in between (see
 *  `gatePickerSiblingDirs`). A scan that settled after its launch's deadline
 *  does not turn that launch's `timed-out` into its own verdict here (it does
 *  in `peekGateVerdict`). */
function lastGateAnswer(cwd: string): ProjectGateResult | undefined {
  const hit = lastGateAnswers.get(scanKeyFor(cwd))
  if (!hit || Date.now() - hit.at > GATE_VERDICT_REUSE_MS) return undefined
  return hit.verdict
}

async function gateManagedLaunchOnce(cwd: string): Promise<ProjectGateResult> {
  if (isUncPath(cwd)) {
    logInfo(`[managed-launch] project settings in ${describePath(cwd)} not checked -- the working directory is a network path`)
    return { status: 'not-scanned', reason: 'network-path' }
  }
  const key = scanKeyFor(cwd)
  const deadlineAt = Date.now() + PROJECT_GATE_DEADLINE_MS
  let scan = inFlightScans.get(key)
  if (!scan) {
    // Wait for a slot under the ceiling, but only until the deadline: a wedged
    // mount elsewhere must not hold this launch for ever.
    while (outstandingProjectScans >= MAX_OUTSTANDING_PROJECT_SCANS) {
      if (Date.now() >= deadlineAt) {
        // Logged once per ceiling EPISODE: the flag is cleared when a scan
        // settles and the count drops back under the ceiling (code-quality
        // review, MINOR). The ceiling is transient, not a switch.
        if (!projectScanCeilingLogged) {
          projectScanCeilingLogged = true
          logWarn(`[managed-launch] project settings not checked -- ${outstandingProjectScans} earlier checks have not returned and each still holds a filesystem thread; checks resume when one settles`)
        }
        return { status: 'not-scanned', reason: 'thread-ceiling' }
      }
      await sleep(25)
      scan = inFlightScans.get(key)
      if (scan) break
    }
    if (!scan) {
      outstandingProjectScans += 1
      scan = projectAuthoritySettingsKeys(cwd)
        // A scan that FAILED is not a scan that found nothing: it used to be
        // caught into an empty key list and cached as clean (exact-head
        // review, BLOCKER).
        .catch((err): ProjectScan => {
          logWarn(`[managed-launch] project settings check in ${describePath(cwd)} failed: ${stripSpoofableText(err instanceof Error ? err.message : String(err), 300)}`)
          return { keys: [], uncertain: 'scan-failed' }
        })
        .then((outcome) => {
          // The verdict is cached and a refusal logged HERE, once, when the
          // scan settles -- not by each waiter after the race, which wrote the
          // cache and the log line once per concurrent launch into the same
          // directory (code-quality review, MINOR). A scan that settles after
          // every waiter gave up still leaves its verdict for the next caller:
          // the verdict is true whoever waited for it. Only a clean or a
          // refused verdict is ever cached; an uncertain one is asked afresh,
          // and it also EVICTS the one before it: a clean verdict from the last
          // scan is not the answer once a newer scan could not be certain, and
          // `peekGateVerdict` would otherwise hand it out for the rest of its
          // reuse window (independent review of the exact-head fix).
          const verdict = verdictOfScan(outcome)
          if (verdict.status !== 'not-scanned') recentVerdicts.set(key, { verdict, at: Date.now() })
          else recentVerdicts.delete(key)
          if (verdict.status === 'refused') {
            // The directory is named HERE, in the log, where the launch's own
            // refusal text (file and key only) cannot say which of several
            // directories a multi-directory launch was refused for.
            logWarn(`[managed-launch] project settings in ${describePath(cwd)} refuse a managed launch: ${verdict.keys.join(', ')}`)
          } else if (verdict.status === 'not-scanned') {
            logInfo(`[managed-launch] project settings in ${describePath(cwd)} not checked -- ${verdict.reason}`)
          }
          return verdict
        })
        .finally(() => {
          // The THREAD is back only now.
          outstandingProjectScans = Math.max(0, outstandingProjectScans - 1)
          if (outstandingProjectScans < MAX_OUTSTANDING_PROJECT_SCANS) projectScanCeilingLogged = false
          if (inFlightScans.get(key) === scan) inFlightScans.delete(key)
        })
      inFlightScans.set(key, scan)
    }
  }
  const remaining = Math.max(0, deadlineAt - Date.now())
  const verdict = await Promise.race([
    scan,
    sleep(remaining).then(() => null),
  ])
  if (verdict === null) {
    logInfo(`[managed-launch] project settings in ${describePath(cwd)} not checked -- the check did not answer within ${PROJECT_GATE_DEADLINE_MS} ms`)
    return { status: 'not-scanned', reason: 'timed-out' }
  }
  // Only a clean or a refused verdict is ever cached (see peekGateVerdict),
  // and the scan cached it itself when it settled: no `not-scanned` verdict --
  // the three returns above, or an uncertain scan -- ever produces one.
  return verdict
}

/**
 * THE LAUNCH GATE over EVERY directory a launch might run in.
 *
 * The interactive PTY path does not always run where it was configured: an
 * exact resume relaunches the CLI in the conversation's own directory, taken
 * from the persisted resume target or from the transcript, and for a session
 * that ran in its designated worktree that is the COMMON case, not an edge.
 * A gate that checked only the configured directory therefore gated a
 * directory the session did not run in and left the one it did unchecked
 * (adversarial review, BLOCKER). The resume decision itself is made late, in
 * the Claude branch, with side effects (it consumes the self-captured target
 * and may relocate a transcript), so it is not hoisted; instead every
 * directory the spawn could land in is gated here, and one verdict covers them:
 *
 *   - any `refused` refuses, with each key prefixed by the directory it was
 *     found in when more than one was gated, so the refusal names the file the
 *     user must fix;
 *   - otherwise any `not-scanned` warns (the first reason wins);
 *   - otherwise clean.
 *
 * A directory the launch does not use in the end (the resume target that turns
 * out to be gone, so the spawn falls back to the configured one) is gated too:
 * an absent directory is clean, and a present one with an authority key is
 * one the user asked to resume in. Over-refusal is the fail-closed side.
 *
 * The OTHER worktrees the resume picker could open are not merged in here:
 * each is gated on its own by `gatePickerSiblingDirs`, and
 * a refused or unchecked one is kept out of the picker's set rather than
 * refusing the launch.
 */
export async function gateManagedLaunchDirs(cwds: readonly string[]): Promise<ProjectGateResult> {
  const unique = [...new Set(cwds.filter((c) => typeof c === 'string' && c.length > 0))]
  if (unique.length === 0) return { status: 'clean' }
  if (unique.length === 1) return gateManagedLaunch(unique[0])
  // ONE AT A TIME: a launch holds at most one of the two scan slots however
  // many directories it gates, so a resume launch cannot push a concurrent
  // launch into the thread ceiling, which is the not-scanned, launch-anyway
  // bucket (adversarial re-attack, MINOR). The deadline is per directory.
  const results: Array<{ cwd: string; result: ProjectGateResult }> = []
  for (const cwd of unique) results.push({ cwd, result: await gateManagedLaunch(cwd) })
  return mergeProjectGateResults(results)
}

/** One verdict for several directories (see `gateManagedLaunchDirs`). Pure,
 *  and exported for its test. Keys are already bounded per directory; the
 *  directory set is the configured directory and the resume target's (the
 *  picker's other worktrees are gated apart, `gatePickerSiblingDirs`) -- each
 *  directory's keys are prefixed by its own path and bounded by its own scan,
 *  and no "and N more" is re-counted across them. */
export function mergeProjectGateResults(
  results: ReadonlyArray<{ cwd: string; result: ProjectGateResult }>,
): ProjectGateResult {
  const refusedKeys: string[] = []
  let skipped: ProjectScanSkipReason | undefined
  for (const { cwd, result } of results) {
    if (result.status === 'refused') {
      // The prefix names a directory the user chose, or one a transcript
      // named: stripped and bounded before it can reach the Accounts panel,
      // like everything else that crosses to the renderer (re-attack, MINOR).
      for (const k of result.keys) refusedKeys.push(results.length > 1 ? `${displayPath(cwd)}: ${k}` : k)
    } else if (result.status === 'not-scanned' && skipped === undefined) {
      skipped = result.reason
    }
  }
  if (refusedKeys.length > 0) return { status: 'refused', keys: refusedKeys }
  if (skipped !== undefined) return { status: 'not-scanned', reason: skipped }
  return { status: 'clean' }
}

/**
 * The resume picker's OTHER worktrees, each gated on its own.
 *
 * The launch's own folders (the configured one and the resume target's)
 * decide the launch, through `gateManagedLaunchDirs`. Each other worktree the
 * picker lists is gated here, one at a time (the same one-slot discipline),
 * and only a CLEAN one goes into the set the picker is handed with the
 * launch's own folders (CCC_GATED_DIRS). A refused or unchecked one never
 * decides the launch: it is left out of that set, and the log names each
 * folder left out and why.
 *
 * A candidate that is one of `launchDirs` is skipped (already gated as the
 * launch's own), and candidates are de-duplicated, by `sameFolder`: the same
 * path, or on Windows a path that differs only in case and that the disk
 * resolves to the same real path. Names are compared case-blind on Windows
 * because the configured folder arrives in whatever case the user typed and
 * git lists it in the case on disk; the real path is asked as well because a
 * folder made case-sensitive (fsutil, or one WSL created) can hold two
 * worktrees whose names differ only in case, and each of those is gated on
 * its own. A path whose real path cannot be read is gated. The real paths are
 * asked within the gate's own deadline, and never for a network path, which
 * is compared by its spelling alone; no answer in time counts as not the same
 * folder, so that candidate is gated on its own as well. On Windows a clean
 * sibling whose name differs only in case from one the gate did not find
 * clean (`leftOut`) is not handed to the picker either, and the log says why.
 * A sibling left out only because it has no folder (below) does not keep out
 * such a twin: the picker takes a name in another case for a folder of its set
 * only when the disk resolves both to one real path.
 *
 * A sibling with no folder at its path when it is gated (git keeps a worktree
 * whose folder was deleted, as a prunable record) is clean to the gate, which
 * reads nothing there, and is left out all the same: no CLI can be resumed
 * there when the session starts, and a folder made there later was never
 * checked. The log names it with the same line. The folder is asked for only
 * once the gate has answered clean, so only a path the gate has just read in
 * time is asked of the disk again, and an answer that does not come within the
 * gate's own deadline counts as no folder.
 *
 * `launch` is the launch's own folders to hand to the picker with the clean
 * siblings (`clean`). The first of `launchDirs` is the configured folder, where
 * the session itself starts, and is always handed over. For each other one
 * (the resume target's folder) the disk is asked whether a folder is there
 * only when the gate's latest answer for that folder, within the reuse window,
 * is clean, and never for a network path, as for a sibling. That answer
 * (`launchVerdict`) is read for every launch folder when this is called,
 * before anything here awaits. The caller gates `launchDirs` and calls this
 * straight after that gate has answered, with no `await` in between, so the
 * answer read is its own launch's; a caller that cannot do that passes its
 * own per-folder answers as `launchVerdict`. An absent resume target is
 * clean to that gate too, the launch then starts in the configured folder
 * instead, and the target is left out and logged like a sibling with no
 * folder. For any other answer (refused, not checked or timed out, or none on
 * record) the disk is not asked and the folder is handed over as before: the
 * gate has already decided the launch on it, and the folder check would be one
 * more read of a path the gate chose not to read or could not read in time.
 *
 * The picker takes a folder for one in its set only when isGatedDir
 * (scripts/resume-picker.js) finds the two to be one folder: one real path on
 * disk, or, where it does not take the disk's answer, one spelling as it
 * settles them. So it refuses a folder left out here unless that folder is a
 * folder of the set under another spelling or through a link, and it matches
 * a path whose folder names differ only in case from one in the set only when
 * the disk resolves both to one real path. `gate`, `platform`, `realpath`,
 * `isFolder` and `launchVerdict` are for tests.
 */
export async function gatePickerSiblingDirs(
  launchDirs: readonly string[],
  candidates: readonly string[],
  gate: (cwd: string) => Promise<ProjectGateResult> = gateManagedLaunch,
  platform: NodeJS.Platform = process.platform,
  realpath: (p: string) => Promise<string | null> = realFolderPath,
  isFolder: (p: string) => Promise<boolean> = isFolderOnDisk,
  launchVerdict: (cwd: string) => ProjectGateResult | undefined = lastGateAnswer,
): Promise<{ launch: string[]; clean: string[]; leftOut: Array<{ dir: string; result: ProjectGateResult }> }> {
  // The fold decides only whether the real paths are worth asking for: two
  // paths that differ in more than case are never the same folder here.
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  // Which launch folders the disk may be asked about, decided before anything
  // below awaits, so the answers read are the ones the caller's own gate left.
  const seen: string[] = launchDirs.filter((d) => typeof d === 'string')
  const askFolder = seen.map((dir, i) => i > 0 && !isUncPath(dir) && launchVerdict(dir)?.status === 'clean')
  const sameFolder = async (a: string, b: string): Promise<boolean> => {
    if (a === b) return true
    if (fold(a) !== fold(b)) return false
    // A network path is not read here either: compared by its spelling alone.
    if (isUncPath(a) || isUncPath(b)) return false
    const real = await Promise.race([
      Promise.all([realpath(a), realpath(b)]),
      sleep(PROJECT_GATE_DEADLINE_MS).then(() => null),
    ])
    return real !== null && real[0] !== null && real[0] === real[1]
  }
  // Whether a folder is there, as the disk answers within the gate's own
  // deadline: a mount that stops answering holds the launch no longer than a
  // scan of it would. No answer in time, or a failure, is no folder.
  const folderInTime = (dir: string): Promise<boolean> =>
    Promise.race([isFolder(dir).catch(() => false), sleep(PROJECT_GATE_DEADLINE_MS).then(() => false)])
  const noFolder = 'there was no folder there when the session started'
  const launch: string[] = []
  const clean: string[] = []
  const leftOut: Array<{ dir: string; result: ProjectGateResult }> = []
  const reasons: Array<{ dir: string; why: string }> = []
  for (const [i, dir] of seen.entries()) {
    if (!askFolder[i] || await folderInTime(dir)) launch.push(dir)
    else reasons.push({ dir, why: noFolder })
  }
  for (const dir of candidates) {
    if (typeof dir !== 'string' || dir.length === 0) continue
    let known = false
    for (const s of seen) if (await sameFolder(s, dir)) { known = true; break }
    if (known) continue
    seen.push(dir)
    const result = await gate(dir)
    if (result.status === 'clean') {
      if (await folderInTime(dir)) clean.push(dir)
      else reasons.push({ dir, why: noFolder })
      continue
    }
    leftOut.push({ dir, result })
    // The scan already bounded the keys (its own "and N more" included);
    // bounding them again would re-count that element as one more key.
    reasons.push({
      dir,
      why: result.status === 'refused'
        ? `its project settings refuse a managed launch (${result.keys.join(', ')})`
        : `its project settings were not checked (${result.reason})`,
    })
  }
  // Decided once every sibling is known, because a clean sibling found later
  // can differ only in case from one left out earlier. On Windows such a
  // clean sibling is not handed to the picker either.
  const twinLeftOut = (d: string): string | undefined =>
    platform === 'win32' ? leftOut.find((l) => fold(l.dir) === fold(d))?.dir : undefined
  const offered = clean.filter((d) => twinLeftOut(d) === undefined)
  for (const { dir, why } of reasons) {
    logWarn(`[managed-launch] the resume picker will not open conversations in ${describePath(dir)} for this launch: ${why}`)
  }
  for (const dir of clean) {
    const twin = twinLeftOut(dir)
    if (twin !== undefined) logWarn(`[managed-launch] the resume picker will not open conversations in ${describePath(dir)} for this launch: ${describePath(twin)}, whose name differs from it only in case, was left out`)
  }
  return { launch, clean: offered, leftOut }
}

/** A folder's real path as the disk reports it (on Windows the case on disk,
 *  links resolved), or null when it cannot be read. Off the main thread. */
async function realFolderPath(p: string): Promise<string | null> {
  try { return await fs.promises.realpath(p) } catch { return null }
}

/** Whether a folder is at `p` (a link to one counts), off the main thread. Any
 *  failure to tell is no folder. */
async function isFolderOnDisk(p: string): Promise<boolean> {
  try { return (await fs.promises.stat(p)).isDirectory() } catch { return false }
}

/**
 * A recent verdict for `cwd`, SYNCHRONOUSLY, or undefined when there is none
 * fresh enough. For the two launch paths that must stay synchronous up to
 * their spawn -- the auth-status probe and the headless runner, where
 * overlapping calls for one profile deliberately share a single subprocess so
 * that two CLIs cannot race one single-use refresh token -- an `await` before
 * the spawn would reopen that race. They ask here first and await the gate
 * only on a miss, which is the first call for a directory and once per
 * `GATE_VERDICT_REUSE_MS` after. A `not-scanned` verdict is never reused: it
 * is worth a fresh attempt.
 */
export function peekGateVerdict(cwd: string): ProjectGateResult | undefined {
  const hit = recentVerdicts.get(scanKeyFor(cwd))
  if (!hit || Date.now() - hit.at > GATE_VERDICT_REUSE_MS) return undefined
  return hit.verdict
}

/** The preflight of a launch while Claude Code is switched off: its version
 *  was not checked because nothing may run the Claude CLI then, which is not
 *  the "version not verified" fault the report otherwise raises. */
function versionNotCheckedWhileOff(p: ManagedLaunchPreflight): ManagedLaunchPreflight {
  const findings = p.findings.filter((f) => f.id !== 'cli-version-unverified')
  if (findings.length === p.findings.length) return p
  findings.unshift({
    id: 'cli-version-not-checked-off',
    severity: 'info',
    title: 'Claude Code is off',
    detail: 'Its version is not checked while it is off. Turn it on in Settings, Accounts.',
  })
  return { ...p, findings, ok: !findings.some((f) => f.severity === 'blocked') }
}

/**
 * Run the preflight for one composed managed launch and record it.
 *
 * Never throws and never blocks: it is called on the spawn path, and a
 * diagnostic that can break a launch is worse than no diagnostic. The project
 * gate has ALREADY answered by the time this runs -- its result is passed in
 * -- so nothing here touches the filesystem, and the refusal itself is the
 * caller's (`withProfileHome` throws after recording), not this function's.
 *
 * `gate` is `null` for a launch with no working directory to gate; the report
 * then says nothing about project settings, which is honest for a launch that
 * inherits the app's own directory.
 */
export function recordManagedLaunchPreflight(
  sessionId: string,
  profileId: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  gate: ProjectGateResult | null = null,
  kind: ManagedLaunchKind = 'launch',
  /** A refusal decided AFTER the gate, by the spawn itself: the directory it
   *  would use is not one the verdict covers (see pty-manager's
   *  assertGatedDirectory). Recorded here so the panel shows it. */
  extra: {
    launchDirectoryUnverified?: string
    /** The launch runs a pinned legacy CLI instead of the installed one
     *  (ManagedLaunchContext); the provider decides which version it checks. */
    pinnedCli?: { version: string; installed: boolean }
  } = {},
): ManagedLaunchPreflight | null {
  try {
    // If the boot probe never answered (the CLI was installed after launch, or
    // one probe failed), start another now. Fire-and-forget: this launch still
    // reports `unknown`, the next one will not. Never while Claude Code is
    // switched off (the probe skips itself then; see below for the report).
    ensureClaudeCliVersion()
    const input: ManagedLaunchPreflightInput = {
      env,
      cliVersion: peekClaudeCliVersion(),
      ...(extra.pinnedCli?.version ? { pinnedCli: extra.pinnedCli } : {}),
      // `'not-evaluated'`, never `undefined`: a launch that did not build the
      // profile home has no sanitise result, and saying nothing read as clean.
      sanitizedSettings: lastSettingsSanitiseFor(home) ?? 'not-evaluated',
      strippedAmbient: lastAmbientStripFor(home) ?? undefined,
      ...(gate?.status === 'refused' ? { repositorySettingsKeys: gate.keys } : {}),
      ...(gate?.status === 'not-scanned' ? { projectScanSkipped: gate.reason } : {}),
      ...(extra.launchDirectoryUnverified ? { launchDirectoryUnverified: extra.launchDirectoryUnverified } : {}),
    }
    const measured = managedLaunchPreflightFor('claude', input)
    if (!measured) return null
    // WP2: with Claude Code switched off no version check runs, so a version
    // nobody checked is not a fault to raise (a shell pinned to an account is
    // the one managed launch left then): the report says Claude Code is off.
    const preflight = !claudeCliProbeAllowed() && !input.cliVersion ? versionNotCheckedWhileOff(measured) : measured
    const report: StoredReport = { home, profileId, sessionId, kind, at: Date.now(), seq: nextSeq++, preflight, input }
    const ring = ringFor(kind)
    const max = kind === 'probe' ? MAX_PROBE_REPORTS : MAX_REPORTS
    ring.push(report)
    if (ring.length > max) ring.splice(0, ring.length - max)
    logPreflight(sessionId, preflight)
    return preflight
  } catch (e) {
    logWarn(`[managed-launch] preflight failed for session ${sessionId}: ${(e as Error)?.message ?? e}`)
    return null
  }
}

function logPreflight(sessionId: string, preflight: ManagedLaunchPreflight): void {
  for (const f of preflight.findings) {
    const line = `[managed-launch] session ${sessionId}: ${f.id} -- ${f.title}: ${f.detail}${f.action ? ` -> ${f.action}` : ''}`
    if (f.severity === 'info') logInfo(line)
    else logWarn(line)
  }
  if (preflight.findings.length === 0) {
    logInfo(`[managed-launch] session ${sessionId}: preflight clean (Claude Code ${preflight.compatibility.found ?? 'unknown'}) -- a record of what the launch did, not a claim of isolation`)
  }
}

/**
 * Newest first, for ONE profile. The `profileId` argument is required.
 *
 * It used to hand the whole process-wide ring buffer to any caller, which made
 * the diagnostic leak across the boundary it exists to defend (adversarial
 * review, MAJOR 5). Three things crossed per account with nothing saying which
 * account they belonged to: the absolute profile-home path, and therefore the OS
 * username; the settings keys stripped from THAT account's copy; and the ambient
 * variable names stripped from THAT account's environment -- which is enough to
 * tell one account's owner that another routes through Bedrock or a corporate
 * proxy. The panel then deduped by finding id, so a second account's occurrence
 * was not merely unattributed, it was invisible.
 *
 * `home` is deliberately not returned: it is an absolute path, the caller
 * already knows which profile it asked for, and the id is what the UI needs.
 */
export function listManagedLaunchReports(profileId: string): readonly ManagedLaunchReport[] {
  if (typeof profileId !== 'string' || profileId.length === 0) return []
  // Both rings, newest first overall. They are kept apart so a probe cannot
  // EVICT a launch, not so the caller sees a different set: the panel still
  // wants a probe when a profile has nothing else, and `kind` is what lets it
  // prefer one over the other.
  return [...reports, ...probeReports]
    .filter((r) => r.profileId === profileId)
    .sort((a, b) => b.seq - a.seq)
    .map((r) => ({ profileId: r.profileId, sessionId: r.sessionId, kind: r.kind, at: r.at, preflight: r.preflight }))
}

export function _resetManagedLaunchReportsForTest(): void {
  reports.length = 0
  probeReports.length = 0
  nextSeq = 0
}
