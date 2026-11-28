/**
 * The Linux machines added on the Machines page (2.1.3-beta.17, plan section
 * A2; ADR-030 S24 and S25, plan v3's R3 in part and R6's provisioning half).
 *
 * Add, on a saved SSH config with key sign-in, in this order, each step only
 * once the one before it passed:
 *   1. prepare: nothing reaches the machine. The app checks its own Linux
 *      helpers against the installer's manifest and hands the renderer the
 *      question to ask (each file it may send, x86-64 and arm64, with its
 *      size and SHA-256, and where it goes) with a one-time token that holds
 *      those hashes. No token, no upload: Add takes only a token prepare
 *      made, once, within ten minutes.
 *   2. probe: what the host is (Linux on x86-64 or arm64 only), its home and
 *      login shell, and where `claude` is, through one `-il` lookup (P6's
 *      fallback). Its `uname -m` answer only selects a row of the fixed table
 *      (manifest.ts LINUX_HELPER_ROWS: x86_64 or aarch64) and never forms a
 *      path; the file of that row is the one sent, and on Add it must be the
 *      one the question named for that row.
 *   3. install: the file goes on standard input into a new temporary folder,
 *      is set 0700 and hashed there; the app compares that hash with the
 *      manifest's. Equal: commit moves it into its folder. Not equal (or no
 *      hash tool on the host): discard removes it, and the device folder this
 *      Add made is removed too, so a failed Add leaves nothing.
 *   4. `version` and `selftest --nonce`, through the launcher, which hashes
 *      the file again before each start.
 *   5. the record: OS, architecture, home, login shell, the CLI's path and
 *      the PATH from the `-il` lookup, the helper's file (its manifest path),
 *      version, hash and folder, and the check. A failed self-test leaves the
 *      machine added but not checked: no tab goes through the helper there
 *      until a Check passes.
 *
 * Check runs the probe, version and self-test again (and installs this
 * build's helper for the machine's architecture first when the machine has
 * another). Every compare of a machine's helper with this build's uses the
 * manifest entry of that machine's architecture. Remove is refused while
 * a tab runs through the helper there or the helper lists a session; then one
 * fixed script deletes `~/.aicc/<did>` after reading its owner marker
 * (scripts.ts).
 *
 * The records live in one JSON file in this install's own data folder (not
 * the shared resources folder), with this install's id; a dev or test run
 * keeps its own. Only a missing file is made; one that is there but does not
 * read is left as it is, and every use of it fails (RECORDS_UNREAD).
 *
 * This file imports nothing of Electron.
 */
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { parseSelfTestResult, parseVersionLine, readListing } from '../session-helper/protocol'
import { CLI_READ_MAX, DID_RE, INSTALL_ID_RE } from './scripts'
import { isCodexModelId, type InstalledCodexModels } from '../../shared/model-registry'
import { classifyCodexVersion, parseCodexVersion } from '../providers/codex/cli-contract'
import { codexModelListRead, parseCodexModelCatalogue } from '../providers/codex/model-catalogue'
import {
  afterHashLine, newNonce, notStartedLogLine, readHashLine, readScriptResult, runScript, sshFailure, targetProblem,
  type ExecResult, type SshRunner, type SshTarget,
} from './ssh-exec'
import { LINUX_HELPER_ROWS, linuxHelperRow, type BundledLinuxHelper, type LinuxArch } from './manifest'
import type { RemoteActionResult, RemoteAddCandidate, RemoteConsent, RemoteMachineView, RemoteRemoveOptions } from '../../shared/remote-machines'
import { REMOTE_OTHER_HELPER, REMOTE_TOKEN_RE } from '../../shared/remote-machines'

/** What the app keeps of one added machine. */
export interface RemoteMachineRecord {
  did: string
  host: string
  port: number
  user: string
  label: string
  addedAt: number
  os: string
  arch: string
  home: string
  shell: string
  /** The login shell is of the sh family: the CLI starts through it (`-il`). */
  shellIsSh: boolean
  /** Where `claude` is: from the `-il` lookup, else the exec's PATH; null: not found. */
  claudePath: string | null
  /** The PATH a session's CLI starts with: the `-il` lookup's, else the exec's. */
  path: string
  lang: string | null
  /** The helper installed there: its file (its manifest path, the row of the
   *  machine's architecture), version, SHA-256 and folder. */
  helper: { path: string; version: string; sha256: string; folder: string }
  check: { at: number; ok: boolean; detail?: string }
  /** What the last Check read of logind (2.1.3-beta.19 section 1.2): its
   *  KillUserProcesses and the user's Linger (`yes`, `no`, or '' when it did
   *  not read) and its KillExcludeUsers (user names). Absent on a record no
   *  Check of this build wrote: read as not known (logoutCleanUp). */
  logind?: { kill: string; exclude: string; linger: string }
  /** 2.1.3-beta.21 (aicc_planning#446): where `codex` is there, from the
   *  same `-il` lookup as Claude Code's (else the exec's PATH), its version
   *  (`codex --version`; null when it did not read), and the models its own
   *  picker lists there, read at the Check (absent when that read gave no
   *  list). Absent: Codex was not found there, or no Check of this build
   *  wrote the record (a machine added before 2.1.3-beta.21 gets it at its
   *  next Check). A review on the machine runs this Codex. */
  codex?: { path: string; version: string | null; models?: HostCodexModels }
  /** The exec's git there, its version (`2.43.0`); absent when it did not read. */
  git?: string
  /** The probes PV1 and PV2's line there (scripts.ts REVIEW_PROBES_FILE), as
   *  the last Check read it: the Codex and the git versions they passed with. */
  reviewProbes?: { codex: string; git: string }
}

/** The model list a machine's Codex offers (installed-codex-models.ts's shape). */
export type HostCodexModels = InstalledCodexModels

/** A version as the record keeps it. */
const RECORD_VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/
/** A reasoning level's name, as the catalogue gives it (model-catalogue.ts). */
const LEVEL_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** A model list as the record keeps it, read strictly; null when anything is off. */
function readHostCodexModels(v: unknown): HostCodexModels | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.version !== 'string' || !RECORD_VERSION_RE.test(o.version) || !Array.isArray(o.models) || o.models.length === 0 || o.models.length > 256) return null
  const models: Array<{ id: string; label: string; efforts?: string[] }> = []
  for (const m of o.models as unknown[]) {
    if (!m || typeof m !== 'object') return null
    const e = m as Record<string, unknown>
    if (!isCodexModelId(e.id)) return null
    const label = hostText(e.label, 64) ?? e.id
    if (e.efforts !== undefined && (!Array.isArray(e.efforts) || e.efforts.length > 16 || !e.efforts.every((x) => typeof x === 'string' && LEVEL_NAME_RE.test(x)))) return null
    models.push({ id: e.id, label, ...(Array.isArray(e.efforts) ? { efforts: [...(e.efforts as string[])] } : {}) })
  }
  return { version: o.version, models }
}

/** The record's Codex, read strictly; null when it names none or is off. */
function readHostCodex(v: unknown): RemoteMachineRecord['codex'] | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const p = hostPath(o.path, 4096)
  if (!p) return null
  const version = typeof o.version === 'string' && RECORD_VERSION_RE.test(o.version) ? o.version : null
  const models = o.models === undefined ? null : readHostCodexModels(o.models)
  return { path: p, version, ...(models ? { models } : {}) }
}

/** `git --version`'s first line (`git version 2.43.0`) as the record keeps it. */
export function gitVersionOf(line: string | undefined): string | null {
  const m = /^git version (\d{1,6}\.\d{1,6}(?:\.\d{1,6}){0,2})(?:[ .][\x21-\x7e ]{0,80})?$/.exec((line ?? '').trim())
  return m ? m[1] : null
}

/** The probes' line (REVIEW_PROBES_FILE) as the record keeps it. */
export function reviewProbesOf(line: string | undefined): { codex: string; git: string } | null {
  const m = /^aicc-review-probes 1 codex (\S{1,64}) git (\S{1,64})$/.exec((line ?? '').trim())
  return m && RECORD_VERSION_RE.test(m[1]) && /^\d{1,6}\.\d{1,6}(?:\.\d{1,6}){0,2}$/.test(m[2]) ? { codex: m[1], git: m[2] } : null
}

/** Whether a machine's logind ends the user's processes at logout, as its
 *  last Check read it (2.1.3-beta.19 section 1.2): `on` when KillUserProcesses
 *  is yes and the user is not in KillExcludeUsers; `off` when it is no, or the
 *  user is excluded; `unknown` on a record no Check of this build wrote (no
 *  logind field: a Check mends it); `unread` when this build's Check read
 *  nothing (no loginctl there, or no logind: no Check changes it). Only `off`
 *  lets an SSH Persistent tab's session outlive its connection there
 *  (route.ts). The user's Linger is read and shown, and decides nothing: a
 *  holder runs in the login's own scope, which KillUserProcesses ends whatever
 *  Linger says. */
export type LogoutCleanUp = 'on' | 'off' | 'unknown' | 'unread'
export function logoutCleanUp(m: Pick<RemoteMachineRecord, 'logind' | 'user'>): LogoutCleanUp {
  const l = m.logind
  if (!l) return 'unknown'
  if (l.kill === 'no') return 'off'
  if (l.kill === 'yes') return l.exclude.split(/\s+/).includes(m.user) ? 'off' : 'on'
  return 'unread'
}

/** The card's line for a machine where SSH Persistent tabs keep the usual
 *  path (logind), or undefined where they may go through the helper. */
export function persistentNote(m: Pick<RemoteMachineRecord, 'logind' | 'user'>): string | undefined {
  const c = logoutCleanUp(m)
  if (c === 'off') return undefined
  const linger = m.logind?.linger === 'yes' || m.logind?.linger === 'no' ? `, Linger ${m.logind.linger}` : ''
  if (c === 'on') return `SSH Persistent tabs keep the usual SSH path here: its logind ends your processes when you log out (KillUserProcesses yes${linger}).`
  if (c === 'unread') return 'SSH Persistent tabs keep the usual SSH path here: its last check got no answer from logind (no loginctl there, or no logind).'
  return 'SSH Persistent tabs keep the usual SSH path here: its last check did not read whether logind ends your processes when you log out. Press Check.'
}

/** A machine as its card names it (2.1.3-beta.19 release smoke): its label,
 *  then user@host:port. The notices of an Add, a Check, a Remove and an End
 *  name it so, not by its bare address, and so does its card's Remove
 *  question (the view's name, PR 763 fix round 9). */
export function machineName(m: Pick<RemoteMachineRecord, 'label' | 'user' | 'host' | 'port'>): string {
  return `${hostText(m.label, 200) ?? `${m.user}@${m.host}`} (${m.user}@${m.host}:${m.port})`
}

const LOGIND_WORD = /^(yes|no)$/
const LOGIND_USERS = /^[A-Za-z0-9_.@ -]{0,1024}$/
/** What a probe or a saved record says of logind, read strictly. */
function readLogind(kill: unknown, exclude: unknown, linger: unknown): { kill: string; exclude: string; linger: string } {
  return {
    kill: typeof kill === 'string' && LOGIND_WORD.test(kill) ? kill : '',
    exclude: typeof exclude === 'string' && LOGIND_USERS.test(exclude) ? exclude.trim() : '',
    linger: typeof linger === 'string' && LOGIND_WORD.test(linger) ? linger : '',
  }
}

interface RecordsFile {
  v: 1
  installId: string
  machines: RemoteMachineRecord[]
}

/** Where the records are kept. Tests hand one in memory. */
export interface MachineStore {
  /** The records as stored; null only when there are none yet (no file).
   *  Throws when they are there but do not read. */
  read(): unknown
  write(value: RecordsFile): void
}

/** What every use of records that are there but do not read throws: they are
 *  never written over, so no added machine and no install id is lost. */
export const RECORDS_UNREAD = 'the remote machines file does not read; it was left as it is'

/** The records file: written whole (a temporary file, flushed, then a rename),
 *  owner-only. A missing file reads as null; any other failure (a busy file, a
 *  file that does not parse) throws. */
export function fileStore(file: string): MachineStore {
  return {
    read: () => {
      let text: string
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
      return JSON.parse(text)
    },
    write: (value) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      const fd = fs.openSync(tmp, 'w', 0o600)
      try {
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, file)
    },
  }
}

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
/** Host text: at most `max` characters, no control or format character. */
function hostText(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL.test(v) ? v : null
}
/** A host path: absolute, at most `max` bytes, no control or format character. */
function hostPath(v: unknown, max = 1024): string | null {
  const s = hostText(v, max)
  return s && s.startsWith('/') && Buffer.byteLength(s, 'utf8') <= max ? s : null
}
const LANG_RE = /^[A-Za-z0-9_.@-]{1,64}$/

/** One record, read strictly; null when any field is off. */
function readRecord(v: unknown): RemoteMachineRecord | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const helper = r.helper as Record<string, unknown> | undefined
  const check = r.check as Record<string, unknown> | undefined
  if (typeof r.did !== 'string' || !DID_RE.test(r.did)) return null
  if (targetProblem({ host: r.host, port: r.port, user: r.user })) return null
  if (!helper || typeof helper.version !== 'string' || typeof helper.sha256 !== 'string' || typeof helper.folder !== 'string') return null
  if (!/^[0-9a-f]{64}$/.test(helper.sha256) || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?-[0-9a-f]{12}$/.test(helper.folder)) return null
  if (!check || typeof check.at !== 'number' || typeof check.ok !== 'boolean') return null
  const home = hostPath(r.home)
  const shell = hostPath(r.shell, 4096)
  const p = hostText(r.path, 32767)
  if (!home || !shell || !p) return null
  // A record from before 2.1.3-beta.19 has no architecture's file named: its
  // architecture (x86_64 when it has none) gives the row.
  const arch = hostText(r.arch, 64) ?? 'x86_64'
  const file = LINUX_HELPER_ROWS.find((row) => row.path === helper.path)?.path ?? linuxHelperRow(arch)?.path ?? LINUX_HELPER_ROWS[0].path
  return {
    did: r.did, host: r.host as string, port: r.port as number, user: r.user as string,
    label: hostText(r.label, 200) ?? `${r.user}@${r.host}`,
    addedAt: typeof r.addedAt === 'number' ? r.addedAt : 0,
    os: hostText(r.os, 64) ?? 'Linux', arch,
    home, shell, shellIsSh: r.shellIsSh === true,
    claudePath: r.claudePath === null ? null : hostPath(r.claudePath, 4096),
    path: p, lang: typeof r.lang === 'string' && LANG_RE.test(r.lang) ? r.lang : null,
    helper: { path: file, version: helper.version, sha256: helper.sha256, folder: helper.folder },
    check: { at: check.at, ok: check.ok, ...(typeof check.detail === 'string' ? { detail: check.detail.slice(0, 300) } : {}) },
    ...(r.logind && typeof r.logind === 'object' ? { logind: readLogind((r.logind as Record<string, unknown>).kill, (r.logind as Record<string, unknown>).exclude, (r.logind as Record<string, unknown>).linger) } : {}),
    ...readReviewFields(r),
  }
}

/** 2.1.3-beta.21: a record's Codex, git and probes fields, read strictly;
 *  each one off is left out. */
function readReviewFields(r: Record<string, unknown>): Pick<RemoteMachineRecord, 'codex' | 'git' | 'reviewProbes'> {
  const codex = readHostCodex(r.codex)
  const git = typeof r.git === 'string' && /^\d{1,6}\.\d{1,6}(?:\.\d{1,6}){0,2}$/.test(r.git) ? r.git : null
  const probes = r.reviewProbes && typeof r.reviewProbes === 'object' ? reviewProbesOf(`aicc-review-probes 1 codex ${String((r.reviewProbes as Record<string, unknown>).codex)} git ${String((r.reviewProbes as Record<string, unknown>).git)}`) : null
  return { ...(codex ? { codex } : {}), ...(git ? { git } : {}), ...(probes ? { reviewProbes: probes } : {}) }
}

/** A saved session config, as much of it as Add reads. */
export interface SavedConfigLike {
  id?: unknown
  label?: unknown
  sessionType?: unknown
  sshConfig?: {
    host?: unknown
    port?: unknown
    username?: unknown
    hasPassword?: unknown
    remoteOs?: unknown
  }
}

/** A machine's architecture as the app names it to the user (as the consent
 *  and Add's refusal do): x86-64 and arm64, not Linux's own x86_64 and
 *  aarch64 (2.1.3-beta.19 text smoke #31); any other as the host reports it. */
const ARCH_NAME: Readonly<Record<string, string>> = { x86_64: 'x86-64', aarch64: 'arm64' }

/** Plain sentences of the flow. */
export const MACHINE_TEXT = {
  noConsent: 'Nothing was sent: the question was not answered, or it was asked more than ten minutes ago. Press Add again.',
  notFound: 'That machine is not on this computer\'s list.',
  notLinux: (os: string, arch: string) => `It is ${os} on ${arch}. This preview adds Linux x86-64 or arm64 machines only.`,
  noArchHelper: (name: string) => `This build of the app carries no session helper for Linux ${name} machines, so nothing was installed on it.`,
  changed: 'The app\'s Linux helper changed after the question was asked, so nothing was sent. Press Add again.',
  noHashTool: 'The machine has no sha256sum, shasum or openssl, so the helper file cannot be checked there. Nothing was left on it.',
  hashMismatch: (hex: string) => `The file on the machine did not match the installer's (SHA-256 ${hex.slice(0, 12)}), so it was removed and nothing was left on it.`,
  inUse: (n: number) => `${n === 1 ? 'A tab runs' : `${n} tabs run`} through the session helper on this machine. Close ${n === 1 ? 'it' : 'them'} first.`,
  holds: (n: number) => `The session helper on this machine still holds ${n === 1 ? 'a session' : `${n} sessions`}. End ${n === 1 ? 'it' : 'them'} first: a session kept until it is ended is listed on this machine's card, with End; a plain SSH tab's ends when you close the tab, or two minutes after a lost connection.`,
}

/** The refusal words a script prints, as sentences. */
const REFUSED: Record<string, string> = {
  'home-not-absolute': 'its home folder is not an absolute path',
  'home-is-root': 'its home folder is /',
  'home-not-a-folder': 'its home folder is not a real folder',
  'home-not-yours': 'its home folder belongs to another user',
  'home-open-to-others': 'its home folder, or a folder above it, can be written by other users',
  'home-folder-owner': 'a folder above its home belongs to another user',
  'aicc-folder-not-private': '~/.aicc there is not a private folder of yours',
  'device-folder-not-private': 'the helper\'s folder there is not a private folder of yours',
  'not-this-install': 'the helper\'s folder there belongs to another install of the app',
  'cannot-make-aicc-folder': '~/.aicc could not be made there',
  'cannot-make-device-folder': 'the helper\'s folder could not be made there',
  'cannot-write-owner': 'the helper\'s folder could not be marked as this install\'s',
  'cannot-make-helper-folder': 'the helper\'s folder could not be made there',
  'helper-folder-not-private': 'the helper\'s folder there is not private',
  busy: 'another upload to it is under way',
  'short-upload': 'the upload did not arrive whole',
  'cannot-set-mode': 'the helper file\'s mode could not be set',
  'nothing-staged': 'the uploaded file was not there to put in place',
  'cannot-replace': 'an older copy could not be replaced',
  'cannot-place': 'the file could not be put in place',
  'cannot-remove': 'its folder could not be removed',
  'still-there': 'its folder is still there',
  // A session's own files (2.1.3-beta.18 section 3.2: the files, unsession and sweep scripts).
  'bad-session': 'the session id is not one the helper takes',
  'cannot-make-sessions-folder': 'the sessions folder could not be made there',
  'sessions-folder-not-private': 'the sessions folder there is not a private folder of yours',
  'cannot-make-session-folder': 'the session\'s folder could not be made there',
  'session-folder-not-private': 'the session\'s folder there is not a private folder of yours',
  'short-file': 'a file did not arrive whole',
  'file-is-a-folder': 'a folder there has the name of one of the session\'s files',
  held: 'its holder still runs',
  // An account's own folder (2.1.3-beta.20 section 3: the accounts, account and signout scripts).
  'accounts-folder-not-private': '~/.aicc/accounts there is not a private folder of yours',
  'cannot-make-accounts-folder': '~/.aicc/accounts could not be made there',
  'cannot-make-account-folder': 'the account\'s folder could not be made there',
  'account-folder-not-the-apps': 'a folder there has the account\'s name but was not made by the app',
  'account-folder-elsewhere': 'the account\'s folder there was made by the app on another computer, which signs it in and out itself',
  'account-folder-not-private': 'the account\'s folder there is not a private folder of yours',
  'cannot-write-marker': 'the account\'s folder could not be marked as the app\'s',
  'cannot-make-shared-folder': 'a shared folder in ~/.claude could not be made there',
  'shared-folder-not-a-folder': '~/.claude there is not a folder',
  'shared-folder-not-yours': '~/.claude there belongs to another user',
  'cannot-relink': 'a link in the account\'s folder could not be replaced',
  'cannot-link': 'a link in the account\'s folder could not be made',
  'settings-is-a-folder': 'a folder there has the name of the account\'s settings file',
  'bad-profile': 'the account\'s id is not one the app makes',
}

/** A refusal word a script printed, as a sentence. */
export function refusalText(word: string | null): string {
  return (word && REFUSED[word]) || `it refused (${word ?? 'no reason given'})`
}

export interface MachinesDeps {
  runner: SshRunner
  store: MachineStore
  /** This build's Linux helpers, one per architecture it carries, each checked
   *  against its manifest (manifest.ts readBundledLinuxHelpers). */
  bundled: () => Promise<{ ok: true; helpers: BundledLinuxHelper[] } | { ok: false; why: string }>
  /** The helper file's bytes, for the upload. */
  readFile?: (file: string) => Promise<Buffer>
  /** How many open tabs go through the helper on this machine. */
  inUse: (did: string) => number
  /** 2.1.3-beta.20 section 3.1.8: Remove signs out each account signed in on
   *  the machine (each account folder there) once its holders are listed,
   *  before the helper goes; a sign-out that fails stops Remove. Absent:
   *  none. */
  signOutAccounts?: (m: RemoteMachineRecord) => Promise<{ ok: boolean; message: string }>
  /** For a machine that does not answer: the accounts still signed in there
   *  and where to end each, as a sentence that starts with a space ('' for
   *  none). Absent: none. */
  accountsLeft?: (m: RemoteMachineRecord) => Promise<string>
  /** A machine Remove took off the list: what the app keeps of it for the
   *  run goes (its accounts' last read). */
  forgotten?: (did: string) => void
  log: (message: string) => void
  now?: () => number
  random?: () => string
}

/** A prepared Add: what the user was asked about, until its token is used.
 *  `offered`: the SHA-256 of each file the question named, by architecture. */
interface Pending {
  target: SshTarget
  label: string
  offered: Partial<Record<LinuxArch, string>>
  expires: number
}

/** The question asked before anything is sent: each file this build may send,
 *  with its size and the first 12 of its SHA-256; the machine's own answer
 *  picks one. */
export function consentText(target: string, helpers: readonly BundledLinuxHelper[]): string {
  const name = (h: BundledLinuxHelper) => linuxHelperRow(h.arch)?.name ?? h.arch
  const files = helpers.map((h) => `${name(h)} (${(h.size / (1024 * 1024)).toFixed(1)} MB, SHA-256 ${h.sha256.slice(0, 12)})`)
  const which = files.length > 1
    ? `${files.join(' or ')}, whichever the machine says it is`
    : `${files[0]} (this build carries no other, so only a Linux ${name(helpers[0])} machine can be added)`
  return `Install the session helper on ${target}? One file, ${which}, into ~/.aicc in your account there. No root, no service: nothing runs when no session uses it. Remove takes it away.`
}

/** The SHA-256 of each helper, by architecture. */
function hashesOf(helpers: readonly BundledLinuxHelper[]): Partial<Record<LinuxArch, string>> {
  const out: Partial<Record<LinuxArch, string>> = {}
  for (const h of helpers) out[h.arch] = h.sha256
  return out
}

export const CONSENT_TTL_MS = 10 * 60_000

export class RemoteMachines {
  private readonly pending = new Map<string, Pending>()
  private busy = new Set<string>()

  constructor(private readonly deps: MachinesDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private rand(): string { return this.deps.random?.() ?? randomBytes(16).toString('hex') }

  /** The records. Only none at all (null) makes this install's id and writes
   *  it; records that are there but do not read, or hold no valid install id or
   *  list, throw and are left as they are. */
  private load(): RecordsFile {
    const raw = this.deps.store.read()
    if (raw === null) {
      const made: RecordsFile = { v: 1, installId: this.rand(), machines: [] }
      this.deps.store.write(made)
      return made
    }
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<RecordsFile>
    if (typeof r.installId !== 'string' || !INSTALL_ID_RE.test(r.installId) || !Array.isArray(r.machines)) throw new Error(RECORDS_UNREAD)
    return { v: 1, installId: r.installId, machines: r.machines.map(readRecord).filter((m): m is RemoteMachineRecord => m !== null) }
  }

  private save(f: RecordsFile): void { this.deps.store.write(f) }

  /** This install's id (section 1's marker holds it), made once. */
  installId(): string { return this.load().installId }

  list(): RemoteMachineRecord[] { return this.load().machines }

  get(did: string): RemoteMachineRecord | undefined { return this.list().find((m) => m.did === did) }

  /** The machine added for this host, port and user. */
  findByTarget(t: { host: string; port: number; username: string }): RemoteMachineRecord | undefined {
    return this.list().find((m) => m.host === t.host && m.port === t.port && m.user === t.username)
  }

  /** The cards. `bundledSha256`: the SHA-256 of this build's Linux helper for
   *  an architecture (null: none for it), asked with each machine's own. A
   *  machine holding another reads not checked, and says Check updates it, as
   *  the routing sends its tabs the usual way (route.ts). */
  views(bundledSha256: (arch: string) => string | null): RemoteMachineView[] {
    return this.list().map((m) => {
      const want = bundledSha256(m.arch)
      const other = want !== null && m.helper.sha256 !== want
      const lastCheck = other ? { at: m.check.at, ok: false, detail: REMOTE_OTHER_HELPER } : m.check
      return {
        did: m.did, label: m.label, name: machineName(m), target: `${m.user}@${m.host}:${m.port}`, checked: lastCheck.ok, lastCheck,
        helperVersion: m.helper.version, system: `${m.os} ${ARCH_NAME[m.arch] ?? m.arch}`, inUse: this.deps.inUse(m.did),
        ...(persistentNote(m) ? { persistentNote: persistentNote(m) } : {}),
      }
    })
  }

  /** The saved SSH configs Add offers, each with whether it can be added. */
  candidates(configs: unknown): RemoteAddCandidate[] {
    if (!Array.isArray(configs)) return []
    const added = this.list()
    const out: RemoteAddCandidate[] = []
    for (const c of configs as SavedConfigLike[]) {
      if (!c || c.sessionType !== 'ssh' || !c.sshConfig || typeof c.id !== 'string') continue
      const s = c.sshConfig
      const target = { host: s.host, port: s.port, user: s.username }
      const label = typeof c.label === 'string' && c.label ? c.label.slice(0, 200) : `${String(s.username)}@${String(s.host)}`
      const shown = `${String(s.username)}@${String(s.host)}:${String(s.port)}`
      const problem = targetProblem(target)
      const why = problem ? `It cannot be added: ${problem}.`
        : s.hasPassword === true ? 'It signs in with a password. The session helper uses key sign-in only in this preview.'
          : s.remoteOs === 'windows' ? 'Its remote OS is set to Windows. This preview adds Linux machines only.'
            : added.some((m) => m.host === s.host && m.port === s.port && m.user === s.username) ? 'Added already.'
              : undefined
      out.push({ configId: c.id, label, target: shown, addable: !why, ...(why ? { why } : {}) })
    }
    return out
  }

  /** Step 1: the question, with a one-time token. Nothing reaches the machine. */
  async prepare(configs: unknown, configId: string): Promise<RemoteConsent> {
    const cand = this.candidates(configs).find((c) => c.configId === configId)
    if (!cand) return { ok: false, message: 'That saved config is not an SSH config this computer has.' }
    if (!cand.addable) return { ok: false, message: cand.why ?? 'It cannot be added.' }
    const b = await this.deps.bundled()
    if (!b.ok) return { ok: false, message: b.why }
    const s = (configs as SavedConfigLike[]).find((c) => c && c.id === configId)!.sshConfig!
    const target: SshTarget = { host: s.host as string, port: s.port as number, user: s.username as string }
    for (const [k, p] of this.pending) if (p.expires <= this.now()) this.pending.delete(k)
    const token = this.rand()
    this.pending.set(token, { target, label: cand.label, offered: hashesOf(b.helpers), expires: this.now() + CONSENT_TTL_MS })
    return { ok: true, token, target: cand.target, text: consentText(cand.target, b.helpers) }
  }

  /** Steps 2 to 5, on the token prepare made (the user's yes). */
  async add(token: unknown): Promise<RemoteActionResult> {
    const p = typeof token === 'string' && REMOTE_TOKEN_RE.test(token) ? this.pending.get(token) : undefined
    if (typeof token === 'string') this.pending.delete(token)
    if (!p || p.expires <= this.now()) return { ok: false, message: MACHINE_TEXT.noConsent }
    const key = `${p.target.user}@${p.target.host}:${p.target.port}`
    if (this.busy.has(key)) return { ok: false, message: 'That machine is being added already.' }
    if (this.findByTarget({ host: p.target.host, port: p.target.port, username: p.target.user })) return { ok: false, message: 'That machine is added already. Use Check.' }
    this.busy.add(key)
    try {
      const b = await this.deps.bundled()
      if (!b.ok) return { ok: false, message: b.why }
      // Every file the question named must still be this build's, before the
      // machine is reached; the one sent is then the probe's row's (provision).
      const now = hashesOf(b.helpers)
      for (const [arch, sha256] of Object.entries(p.offered)) if (now[arch as LinuxArch] !== sha256) return { ok: false, message: MACHINE_TEXT.changed }
      const did = this.rand()
      const made = await this.provision({ did, target: p.target, label: p.label, helpers: b.helpers, offered: p.offered, first: true, addedAt: this.now() })
      if (!made.ok) return made
      const f = this.load()
      f.machines = [...f.machines.filter((m) => m.did !== did), made.record]
      this.save(f)
      this.deps.log(`[remote-helper] added ${key} (${did.slice(0, 8)}): ${made.record.check.ok ? 'checked' : `not checked: ${made.record.check.detail ?? ''}`}`)
      const name = machineName(made.record)
      return { ok: true, message: made.record.check.ok ? `Added ${name}. Its self-test passed.` : `Added ${name}, but it is not checked: ${made.record.check.detail}. Press Check to try again, or Remove.` }
    } finally {
      this.busy.delete(key)
    }
  }

  /** Check: probe, version and self-test again (and this build's helper for its architecture first, when the machine has another). */
  async check(did: unknown): Promise<RemoteActionResult> {
    const m = typeof did === 'string' && DID_RE.test(did) ? this.get(did) : undefined
    if (!m) return { ok: false, message: MACHINE_TEXT.notFound }
    const key = `${m.user}@${m.host}:${m.port}`
    if (this.busy.has(key)) return { ok: false, message: 'That machine is busy with another action.' }
    this.busy.add(key)
    try {
      const b = await this.deps.bundled()
      if (!b.ok) return { ok: false, message: b.why }
      const made = await this.provision({ did: m.did, target: { host: m.host, port: m.port, user: m.user }, label: m.label, helpers: b.helpers, first: false, addedAt: m.addedAt, known: m })
      const f = this.load()
      const record = made.ok ? made.record : { ...m, check: { at: this.now(), ok: false, detail: made.message } }
      f.machines = f.machines.map((x) => (x.did === m.did ? record : x))
      this.save(f)
      this.deps.log(`[remote-helper] checked ${key} (${m.did.slice(0, 8)}): ${record.check.ok ? 'passed' : `failed: ${record.check.detail ?? ''}`}`)
      // 2.1.3-beta.19 text smoke (#33): a Check that put this build's helper there says so.
      const name = machineName(m)
      if (record.check.ok) return { ok: true, message: made.ok && made.installed ? `${name}: this build's session helper is installed there, and it passed its check.` : `${name} passed its check.` }
      return { ok: false, message: `${name} did not pass its check: ${record.check.detail}` }
    } finally {
      this.busy.delete(key)
    }
  }

  /** Remove: refused while a tab or a held session runs there; then (2.1.3-beta.20
   *  section 3.1.8) each account signed in there is signed out, then the one
   *  fixed removal script. `forget` (the machine did not answer, and the user
   *  chose to remove it anyway): the app forgets it without reaching it, and
   *  the answer names the accounts still signed in there and where to end
   *  each. */
  async remove(did: unknown, opts: RemoteRemoveOptions = {}): Promise<RemoteActionResult> {
    const m = typeof did === 'string' && DID_RE.test(did) ? this.get(did) : undefined
    if (!m) return { ok: false, message: MACHINE_TEXT.notFound }
    const n = this.deps.inUse(m.did)
    if (n > 0) return { ok: false, message: MACHINE_TEXT.inUse(n) }
    const left = async (): Promise<string> => {
      try { return (await this.deps.accountsLeft?.(m)) ?? '' } catch { return '' }
    }
    if (opts.forget === true) {
      const text = await left()
      this.forget(m)
      this.deps.log(`[remote-helper] forgot ${m.user}@${m.host}:${m.port} (${m.did.slice(0, 8)}) without reaching it`)
      return { ok: true, message: `The app forgot ${machineName(m)}; its folder in ~/.aicc there stays.${text}` }
    }
    const target = { host: m.host, port: m.port, user: m.user }
    const install = this.installId()
    // The holders first: a session still held there keeps the folder.
    const nonce = newNonce()
    const listed = await runScript(this.deps.runner, target, 'list', [nonce, m.did, install, m.helper.folder, m.helper.sha256])
    const failed = this.sshFailed(m.host, listed)
    // 2.1.3-beta.20 section 5: marked, so the card asks again in the
    // not-answering words, with Remove anyway (`forget`).
    if (failed) return { ok: false, notAnswering: true, message: `${m.host} could not be reached: ${failed}.${await left()}` }
    const hash = readHashLine(listed.stdout, nonce)
    if (hash?.state === 'ok') {
      const line = afterHashLine(listed.stdout, nonce).split(/\r?\n/).find((l) => l.startsWith('{'))
      const listing = line ? readListing(line, 'unix') : null
      if (!listing) return { ok: false, message: `The session helper on ${m.host} did not list its sessions, so nothing was removed.` }
      if (listing.sessions.length > 0) return { ok: false, message: MACHINE_TEXT.holds(listing.sessions.length) }
    }
    // 2.1.3-beta.20 section 3.1.8: the accounts signed in there, signed out first.
    let signedOut = ''
    if (this.deps.signOutAccounts) {
      const s = await this.deps.signOutAccounts(m)
      if (!s.ok) return { ok: false, message: s.message }
      signedOut = s.message ? ` ${s.message}` : ''
    }
    const removed = await this.runRemove(target, m.did, install)
    if (!removed.ok) return signedOut ? { ok: false, message: `${removed.message}${signedOut}` } : removed
    this.forget(m)
    this.deps.log(`[remote-helper] removed ${m.user}@${m.host}:${m.port} (${m.did.slice(0, 8)})`)
    return { ok: true, message: `Removed the session helper from ${machineName(m)}.${signedOut}` }
  }

  /** The machine off the list, and what the app keeps of it for the run. */
  private forget(m: RemoteMachineRecord): void {
    const f = this.load()
    f.machines = f.machines.filter((x) => x.did !== m.did)
    this.save(f)
    try { this.deps.forgotten?.(m.did) } catch { /* the app's own */ }
  }

  private async runRemove(target: SshTarget, did: string, install: string): Promise<RemoteActionResult> {
    const nonce = newNonce()
    const r = await runScript(this.deps.runner, target, 'remove', [nonce, did, install])
    const failed = this.sshFailed(target.host, r)
    if (failed) return { ok: false, message: `${target.host} could not be reached: ${failed}.` }
    const res = readScriptResult(r.stdout, nonce)
    if (!res) return { ok: false, message: `${target.host} did not say whether the helper's folder was removed.` }
    if (!res.ok) return { ok: false, message: `Nothing was removed: ${refusalText(res.refused)}.` }
    return { ok: true, message: 'removed' }
  }

  /**
   * Probe, install when the machine lacks this build's helper for its
   * architecture, version and self-test. `helpers`: this build's, one per
   * architecture it carries; the probe's answer picks one through the fixed
   * table. `offered`: on Add, the hashes the question named, by architecture
   * (the file sent must be the one named for its row). `first`: the machine's
   * first connection (a host key not known yet is kept); a failure then
   * removes what this Add made.
   */
  private async provision(a: { did: string; target: SshTarget; label: string; helpers: readonly BundledLinuxHelper[]; offered?: Partial<Record<LinuxArch, string>>; first: boolean; addedAt: number; known?: RemoteMachineRecord }): Promise<{ ok: true; record: RemoteMachineRecord; installed: boolean } | { ok: false; message: string }> {
    const { did, target } = a
    const install = this.installId()
    const fail = async (message: string, cleanUp: boolean): Promise<{ ok: false; message: string }> => {
      if (cleanUp) {
        const gone = await this.runRemove(target, did, install).catch(() => ({ ok: false, message: '' }))
        if (!gone.ok) this.deps.log(`[remote-helper] ${target.host}: what the failed Add made could not be removed (${gone.message})`)
      }
      return { ok: false, message }
    }
    // 2. probe
    let nonce = newNonce()
    const probed = await runScript(this.deps.runner, target, 'probe', [nonce, did, install], { firstConnection: a.first })
    const pf = this.sshFailed(target.host, probed)
    if (pf) return { ok: false, message: `${target.host} could not be reached: ${pf}.` }
    const probe = readScriptResult(probed.stdout, nonce)
    if (!probe) return { ok: false, message: `${target.host} did not answer the session helper's questions (is /bin/sh there?).` }
    if (!probe.ok) return { ok: false, message: `${target.host} was not used: ${refusalText(probe.refused)}.` }
    const os = hostText(probe.values.get('os'), 64) ?? 'unknown'
    const arch = hostText(probe.values.get('arch'), 64) ?? 'unknown'
    // The host's answer only selects a row of the fixed table, by equality;
    // the file is the row's, never a path made from the answer.
    const row = os === 'Linux' ? linuxHelperRow(arch) : null
    if (!row) return { ok: false, message: MACHINE_TEXT.notLinux(os, arch) }
    const helper = a.helpers.find((h) => h.arch === row.arch && h.path === row.path)
    if (!helper) return { ok: false, message: MACHINE_TEXT.noArchHelper(row.name) }
    if (a.offered && a.offered[row.arch] !== helper.sha256) return { ok: false, message: MACHINE_TEXT.changed }
    const home = hostPath(probe.values.get('home'))
    const shell = hostPath(probe.values.get('shell'), 4096)
    if (!home || !shell) return { ok: false, message: `${target.host} gave a home folder or login shell the session helper does not take.` }
    if (a.known && a.known.home !== home) return { ok: false, message: `Its home folder is not the one it had when it was added (${a.known.home}). Remove it and add it again.` }
    const shellIsSh = /\/(bash|zsh|sh|dash|ksh|mksh|ash|yash)$/.test(shell)
    const ilPath = hostText(probe.values.get('il-path'), 32767)
    const execPath = hostText(probe.values.get('path'), 32767) ?? '/usr/local/bin:/usr/bin:/bin'
    const claudePath = hostPath(probe.values.get('il-claude'), 4096) ?? hostPath(probe.values.get('claude'), 4096)
    // 2.1.3-beta.21 (aicc_planning#446): Codex there, by the same lookup, and
    // its version; the exec's git; the probes PV1 and PV2's line.
    const codexPath = hostPath(probe.values.get('il-codex'), 4096) ?? hostPath(probe.values.get('codex'), 4096)
    const codexVersion = parseCodexVersion(probe.values.get('il-codex-version') || probe.values.get('codex-version') || '')
    const git = gitVersionOf(probe.values.get('git'))
    const reviewProbes = reviewProbesOf(probe.values.get('review-probes'))
    const lang = probe.values.get('lang')
    // 3. install, unless the machine has this helper already in place
    const inPlace = a.known && a.known.helper.sha256 === helper.sha256 && a.known.check.ok
    if (!inPlace) {
      nonce = newNonce()
      const bytes = await (this.deps.readFile ?? fs.promises.readFile)(helper.file)
      if (bytes.length !== helper.size) return { ok: false, message: 'The app\'s Linux helper changed while it was being read. Try again.' }
      const up = await runScript(this.deps.runner, target, 'install', [nonce, did, install, String(helper.size)], { stdin: bytes, timeoutMs: 180_000 })
      const uf = this.sshFailed(target.host, up)
      if (uf) return fail(`${target.host} could not be reached: ${uf}.`, a.first)
      const res = readScriptResult(up.stdout, nonce)
      if (!res) return fail(`${target.host} did not say whether the upload arrived.`, a.first)
      if (!res.ok) return fail(`Nothing was installed: ${refusalText(res.refused)}.`, a.first)
      const staged = nonce
      const reported = res.values.get('hash') ?? 'none'
      // The host's hash against the installer's manifest: never against host data.
      if (reported !== helper.sha256) {
        await this.discard(target, did, install, staged)
        this.deps.log(`[remote-helper] ${target.host}: the uploaded file's hash was ${reported === 'none' ? 'not read (no hash tool)' : reported.slice(0, 12)}, not the manifest's ${helper.sha256.slice(0, 12)}; removed`)
        return fail(reported === 'none' ? MACHINE_TEXT.noHashTool : MACHINE_TEXT.hashMismatch(reported), a.first)
      }
      nonce = newNonce()
      const put = await runScript(this.deps.runner, target, 'commit', [nonce, did, install, helper.folder, staged])
      const cf = this.sshFailed(target.host, put)
      if (cf) return fail(`${target.host} could not be reached: ${cf}.`, a.first)
      const cr = readScriptResult(put.stdout, nonce)
      if (!cr?.ok) return fail(`The file could not be put in place: ${refusalText(cr?.refused ?? null)}.`, a.first)
    }
    // 4. version and self-test, through the launcher
    const checked = await this.selfCheck(target, did, install, helper)
    // 5. at a Check, the session folders whose holder is gone (2.1.3-beta.18
    // section 3.2), and the earlier builds' helper folders while no holder
    // has a record (2.1.3-beta.19)
    if (checked.ok && !a.first) await this.sweep(target, did, install, helper)
    const record: RemoteMachineRecord = {
      did, host: target.host, port: target.port, user: target.user, label: a.label, addedAt: a.addedAt,
      os, arch: row.arch, home, shell, shellIsSh, claudePath,
      path: shellIsSh && ilPath ? ilPath : execPath,
      lang: typeof lang === 'string' && LANG_RE.test(lang) ? lang : null,
      helper: { path: helper.path, version: helper.version, sha256: helper.sha256, folder: helper.folder },
      check: { at: this.now(), ok: checked.ok, ...(checked.ok ? {} : { detail: checked.why }) },
      logind: readLogind(probe.values.get('logind-kill'), probe.values.get('logind-exclude'), probe.values.get('linger')),
      ...(git ? { git } : {}),
      ...(reviewProbes ? { reviewProbes } : {}),
    }
    if (codexPath) {
      // The model list is read only from a Codex this app can use, with the helper checked there.
      const usable = codexVersion !== null && classifyCodexVersion(codexVersion) !== 'too-old'
      const models = checked.ok && usable ? await this.readCodexModels(target, did, install, codexVersion) : null
      record.codex = { path: codexPath, version: codexVersion, ...(models ? { models } : {}) }
    }
    if (checked.ok && !claudePath) record.check = { at: record.check.at, ok: false, detail: 'Claude Code was not found on it (not on the PATH of its login shell)' }
    return { ok: true, record, installed: !inPlace }
  }

  /**
   * 2.1.3-beta.21 (aicc_planning#446): the models Codex's own picker lists on
   * the machine (the `cliread` script, with the Codex package's read: its list in
   * a fresh, empty Codex home there), read by the Codex package's own reader
   * (model-catalogue.ts parseCodexModelCatalogue), for `version`. Null, with
   * one log line, when it gives no list: a review there then takes no model
   * by name. Never throws.
   */
  private async readCodexModels(target: SshTarget, did: string, install: string, version: string): Promise<HostCodexModels | null> {
    const nonce = newNonce()
    const no = (why: string): null => {
      this.deps.log(`[remote-helper] ${target.host}: the Codex model list there was not read (${why}); a review there takes no model by name until a Check reads it`)
      return null
    }
    let r: ExecResult
    try {
      r = await runScript(this.deps.runner, target, 'cliread', [nonce, did, install, codexModelListRead.program, codexModelListRead.words.join(','), codexModelListRead.configVariable], { stdoutMax: 2 * CLI_READ_MAX + 64 * 1024 })
    } catch (err) {
      return no((err as Error).message)
    }
    const failed = this.sshFailed(target.host, r)
    if (failed) return no(failed)
    const res = readScriptResult(r.stdout, nonce)
    if (!res) return no('no answer')
    if (!res.ok) return no(refusalText(res.refused))
    const hex = res.values.get('out') ?? ''
    if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return no('its output does not read')
    const text = Buffer.from(hex, 'hex').toString('utf8')
    const marker = `AICC-CLI ${nonce}\n`
    const at = text.indexOf(marker)
    if (at < 0) return no('Codex did not start through the login shell there')
    const models = parseCodexModelCatalogue(text.slice(at + marker.length))
    if (!models) return no('Codex did not print a model list this app reads')
    return { version, models: models.map((m) => ({ id: m.id, label: m.label, ...(m.efforts ? { efforts: [...m.efforts] } : {}) })) }
  }

  /** sshFailure; an ssh that never started also logs the error its start got. */
  private sshFailed(host: string, r: ExecResult): string | null {
    if (r.notStarted) this.deps.log(notStartedLogLine(host, r.stderr))
    return sshFailure(r)
  }

  private async discard(target: SshTarget, did: string, install: string, staged: string): Promise<void> {
    const nonce = newNonce()
    const r = await runScript(this.deps.runner, target, 'discard', [nonce, did, install, staged]).catch((): ExecResult => ({ code: null, stdout: '', stderr: '', timedOut: false }))
    const res = readScriptResult(r.stdout, nonce)
    if (!res?.ok) this.deps.log(`[remote-helper] ${target.host}: the upload that did not match could not be removed (${refusalText(res?.refused ?? null)})`)
  }

  /** The session folders a tab's end could not remove (its link was down, the
   *  app quit first): each one whose holder is gone goes, after list mode
   *  removes the records of holders that are gone. From 2.1.3-beta.19 the
   *  earlier builds' helper folders go first, when no holder has a record
   *  (scripts.ts SWEEP_EARLIER_HELPERS); this build's folder never. One log
   *  line for each count above 0; a failure changes nothing of the Check's
   *  answer. */
  private async sweep(target: SshTarget, did: string, install: string, helper: BundledLinuxHelper): Promise<void> {
    const nonce = newNonce()
    const r = await runScript(this.deps.runner, target, 'sweep', [nonce, did, install, helper.folder, helper.sha256]).catch((): ExecResult => ({ code: null, stdout: '', stderr: '', timedOut: false }))
    const failed = sshFailure(r)
    const res = failed ? null : readScriptResult(r.stdout, nonce)
    const helpers = res?.values.get('helpers') ?? ''
    if (/^[1-9][0-9]{0,5}$/.test(helpers)) this.deps.log(`[remote-helper] ${target.host}: removed ${helpers} earlier helper folder(s), as no session is held there`)
    const swept = res?.values.get('swept') ?? ''
    if (!res?.ok) this.deps.log(`[remote-helper] ${target.host}: its session folders were not checked (${failed ?? (res ? refusalText(res.refused) : 'no answer')})`)
    else if (/^[1-9][0-9]{0,5}$/.test(swept)) this.deps.log(`[remote-helper] ${target.host}: removed ${swept} session folder(s) whose holder is gone`)
  }

  /** `version` then `selftest`, both through the launcher's hash check. */
  private async selfCheck(target: SshTarget, did: string, install: string, helper: BundledLinuxHelper): Promise<{ ok: true } | { ok: false; why: string }> {
    let nonce = newNonce()
    const v = await runScript(this.deps.runner, target, 'version', [nonce, did, install, helper.folder, helper.sha256])
    const vf = this.sshFailed(target.host, v)
    if (vf) return { ok: false, why: `it could not be reached (${vf})` }
    const vh = readHashLine(v.stdout, nonce)
    if (vh?.state !== 'ok') return { ok: false, why: `the helper file there did not pass its hash check (${vh?.state ?? 'no answer'})` }
    const version = parseVersionLine(afterHashLine(v.stdout, nonce).split(/\r?\n/)[0] ?? '')
    if (version !== helper.version) return { ok: false, why: `the helper there reports version ${version ?? 'nothing'}, not ${helper.version}` }
    nonce = newNonce()
    const s = await runScript(this.deps.runner, target, 'selftest', [nonce, did, install, helper.folder, helper.sha256])
    const sf = this.sshFailed(target.host, s)
    if (sf) return { ok: false, why: `it could not be reached (${sf})` }
    if (readHashLine(s.stdout, nonce)?.state !== 'ok') return { ok: false, why: 'the helper file there did not pass its hash check' }
    const report = parseSelfTestResult(afterHashLine(s.stdout, nonce), nonce)
    if (!report) return { ok: false, why: 'its self-test gave no result' }
    if (!report.ok) {
      const bad = report.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')
      return { ok: false, why: `its self-test failed (${bad || 'no check named'})` }
    }
    return { ok: true }
  }
}
