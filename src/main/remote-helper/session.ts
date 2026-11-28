/**
 * A Claude Code SSH tab through the session helper on its machine
 * (2.1.3-beta.17, plan section A2; ADR-030 S25's first session kind; plan
 * v3's R9 holder and R10's launch with no typed line).
 *
 * The tab's terminal is the same HelperPty a local held session uses
 * (../session-helper/helper-pty.ts): a holder started by one exec
 * (`hold --detach`, which prints its record), then a connection whose stream
 * is a long `ssh -T` exec of the helper's `bridge` mode, so the holder's
 * frames (protocol section 15) ride ssh's pipes: no typed setup or launch
 * line, no sentinel parsing, no ConPTY between the app and the host. The
 * launch starts the CLI through the host user's login shell
 * (`<shell> -il -c 'exec "$0" "$@"' <program> <args>`, ADR-030 D8), values as
 * arguments, so what the user's rc files set reaches the CLI as on the usual
 * path; the `-il` PATH is the one the machine's record keeps. The program, its
 * arguments and the CLI's own variables come from the tab's provider package
 * (its remote launch, providers/types.ts ProviderRemoteLaunch; 2.1.3-beta.18
 * section 2); this file names no flag or variable of a CLI.
 *
 * The clipboard stand-in (2.1.3-beta.21; ADR-032; docs/remote/helper-protocol.md
 * section 15): a launch on a Linux host that asks for it (its `clipStandIn`;
 * clipStandInFolder) has the session's `files` exec write the stand-in's two
 * scripts, `xclip` and `wl-paste`, into the session's `bin/` folder there,
 * and that folder goes first on the CLI's PATH: inside the `-c` wrapper,
 * after the rc files, for a login shell of the sh family
 * (CLIP_STAND_IN_WRAPPER), else in front of the host account's PATH. The
 * CLI's own image paste then reads the picture the app sent the session;
 * nothing of this computer is named there.
 *
 * Its own files (2.1.3-beta.18 section 3.2): before the hold, one exec reads
 * the host files the provider names (its hostReads: for Claude Code, the
 * settings files whose hooks the session keeps), as data, and beside it
 * (2.1.3-beta.19 section 3) one exec of the helper's field mode reads the
 * field that names the account the CLI is signed in as (its accountField),
 * for the tab's status line and header: ./host-reads.ts readHostForStart,
 * which every start of the tab runs, launch or attach; after the hold and
 * before the launch, one exec writes the files the provider's launch gives
 * into the session's own folder there (`~/.aicc/<did>/sessions/<sid>/`,
 * 0700), contents on standard input. They name the helper's path, its store
 * and the session id on the host: never an address, a port or a credential of
 * this computer. The folder goes at the session's end (`unsession`), and the
 * next Check removes any whose holder is gone (`sweep`); a quit does not wait
 * for the unsession exec, so a folder a quit leaves goes at the next start's
 * list of kept sessions (2.1.3-beta.19 section 6.3: ./kept.ts listKept), or
 * at that Check. A session kept until it is ended keeps its folder.
 *
 * A dropped link (the ssh child ended, or a pong that never came) attaches
 * again from the last byte seen, with the holder's replay: HelperPty asks for
 * a new connection, and this driver tries a new bridge exec after 1, 2, 4, 8,
 * 16, 32 and 32 s (section 11's 1 to 16 s, then two tries more: 95 s of
 * waiting in all, inside a plain SSH tab's holder's two-minute away clock; a
 * kept session's holder has none), never after a
 * sign-in or host key failure, a hash mismatch, or a
 * bridge that finds no holder. A plain SSH tab (its holder has the away
 * clock) ends its session when it is closed or the app quits (`term.end`), as
 * a plain SSH session ends then (D13); a tab closed just as its link drops
 * sends its end once more, over a link of its own.
 *
 * An SSH Persistent tab (2.1.3-beta.19 section 1.2; ADR-030 S25's second
 * kind, D13, D19) has a holder that runs until it is ended (`hold
 * --until-ended`, ./kept.ts): closing the tab, a quit and an app update let go
 * of it (HelperPty.release: a term.detach, never a term.end, and no exit keys);
 * so does a link that stays down past the tries above (a Restart attaches
 * again; an attach again that finds no holder means the session is over
 * there, and the tab says so). Only End ends it (endKept: term.end over a
 * link of its own, then its folder). A start whose hold finds a holder for its
 * session (exit 3) asks list mode: one that runs until it is ended is
 * attached to (its replay, its newest status and its queued hook events,
 * once), and nothing is launched; a clock holder an earlier run left, or an
 * until-ended one with nothing launched in it, is ended first. The
 * host reads and the account field read (./host-reads.ts readHostForStart)
 * run again at such an attach, so its label and the source of its weekly bars
 * are set again (section 1.1's contract). The hold's record says the kind it
 * started (protocol.ts readRecord); a holder of the other kind than the tab
 * asked for is ended at once, and nothing is launched.
 *
 * Its status line, hook events and tools (2.1.3-beta.18 section 3.2): the
 * tab's connections ack `status`, `hooks` and `mcp`, and ./signals.ts routes
 * what comes on them: the status line to the tab's strip, the hook events to
 * the session signals module (attention, the canvas turn boundary, the
 * Watchdog), each tool stream to the tool host as the tab's session, with no
 * credential, the tool set an SSH tab has (the image fetch tool an image
 * paste and Snap use included). Its account label comes from the account
 * field each start reads on the host (./host-reads.ts readHostForStart), and
 * its per-model weekly buckets and extra usage from this computer's own usage
 * reading of that account, through the usage source its provider package
 * hands (statusline-watcher.ts setHelperAccount); the helper reads no
 * credential and calls no network. Prompt buttons and broadcast type into it by the
 * usual rule for a Claude Code tab.
 *
 * Its account (2.1.3-beta.20 section 3, Sign in on this machine): a tab whose
 * config names an account (`account`) reads the machine's sign-ins first, in
 * one exec (./host-accounts.ts readMachineAccounts), and starts on the
 * account's own folder there when it is signed in in it, on the machine's
 * own sign-in when that is the account, and otherwise starts nothing: no
 * holder, no CLI, and its note, and the renderer's notice, say why
 * (HostLaunchRefusal). On its own folder, the folder's links and settings
 * copy are brought up to date before the hold (`account refresh`). A sign-in
 * tab makes the account's folder instead (`account make`) and reads nothing:
 * its launch is the CLI's own sign-in in that folder.
 *
 * This file imports nothing of Electron.
 */
import { createHash } from 'crypto'
import type { IDisposable, IEvent, IPty } from 'node-pty'
import { HolderConnection, HolderError } from '../session-helper/connection'
import { HelperPty, LOST_EXIT_CODE, NothingStartedError, type HelperPtyDriver } from '../session-helper/helper-pty'
import { checkLaunch, readListing, readRecord, type HolderRecord, type LaunchSpec } from '../session-helper/protocol'
import { stripSpoofableText } from '../../shared/safe-text'
import type { ProviderId } from '../../shared/providers/ids'
import type { ProviderRemoteLaunch, RemoteAccounts, RemoteHelperCommands, RemoteHostFile, RemoteHostRead, RemoteLaunch, RemoteLaunchOptions } from '../providers/types'
import type { HostAccountNotice, HostLaunchRefusal } from '../../shared/host-accounts'
import { accountBinding, machineAccounts, prepareAccountFolder, readMachineAccounts, type HostProfile } from './host-accounts'
import { holderLabel, type HolderKind } from './scripts'
import { untilEnded } from './kept'
import { afterHashLine, exitText, localSshEnd, newNonce, notStartedLogLine, openScriptStream, readHashLine, readScriptResult, runScript, sshFailure, type SshRunner, type SshTarget } from './ssh-exec'
import { sessionFilesInput } from './session-files'
import { readHostForStart } from './host-reads'
import { RemoteSignals, type RemoteSignalDeps } from './signals'
import { machineName, refusalText, type RemoteMachineRecord } from './machines'

/** The helper's session id for a remote tab: always the same for the same app
 *  id, never one a local terminal or agent session gets (`rm` and 30 hex). */
export function remoteSessionId(appPtyId: string): string {
  return `rm${createHash('sha256').update(`aicc-remote-session\0${appPtyId}`, 'utf8').digest('hex').slice(0, 30)}`
}

/** The waits between tries for a dropped link: section 11's 1, 2, 4, 8, 16 s, then 32 s twice; 95 s in all, inside a plain SSH tab's two-minute away clock. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 32000, 32000]
/** How long a bridge exec may take to pass its hash line, and the hello after it. */
export const BRIDGE_OPEN_MS = 30_000
export const BRIDGE_HELLO_MS = 20_000

/** The folder a session starts in: the config's remote path made absolute
 *  against the host's home (`~`, `~/x`, a relative path), else the home. */
export function remoteCwd(remotePath: string | undefined, home: string): string {
  const p = (remotePath ?? '').trim()
  if (!p || p === '~') return home
  if (p.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${p.slice(2)}`
  if (p.startsWith('/')) return p
  return `${home.replace(/\/+$/, '')}/${p}`
}

/** The host account's own variables for a remote launch: what the probe read
 *  on the host (its home folder, user, login shell and PATH). Never a profile
 *  folder of this computer, so not the managed-launch choke point's; the
 *  profile-home guard in tests/wp1/managed-launch.test.ts names this one line. */
const hostAccountEnv = (m: RemoteMachineRecord): Record<string, string> => ({
  HOME: m.home, USER: m.user, LOGNAME: m.user, SHELL: m.shell, PATH: m.path,
})

/** The login shell's `-c` text that starts the CLI (ADR-030 D8): the program
 *  is `$0`, its arguments follow. */
export const PLAIN_WRAPPER = 'exec "$0" "$@"'

/**
 * 2.1.3-beta.21 (ADR-032; docs/remote/helper-protocol.md section 15, the
 * clipboard stand-in): the `-c` text for a launch whose CLI reads a picture
 * through the stand-in. After the rc files it puts the session's bin/ folder
 * first on PATH, then starts the program as PLAIN_WRAPPER does. The folder is
 * the first argument after the program (`$1`, shifted off before the exec),
 * so no host path is in the text; an empty PATH gets the folder alone, never
 * a trailing colon, which would put the working folder on PATH.
 */
export const CLIP_STAND_IN_WRAPPER = 'PATH="$1${PATH:+:$PATH}"; export PATH; shift; exec "$0" "$@"'

/** What the stand-in's folder may not hold: PATH's separator, a control
 *  character, and the two characters the `files` script never writes into a
 *  script (a single quote and a backslash; scripts.ts CLIP_STAND_IN). */
const STAND_IN_UNSAFE_RE = /[:'\\\u0000-\u001f\u007f]/

/**
 * The clipboard stand-in's folder for a launch, `<session folder>/bin`, when
 * the launch asks for the stand-in, machine `m` is a Linux host (where Claude
 * Code reads a picture through `xclip` or `wl-paste`, ADR-032's table; on
 * macOS it reads the pasteboard, which the stand-in does not serve) and the
 * folder can go on PATH and into the stand-in's scripts; null otherwise: then
 * no bin/ is written and PATH is the host account's. `sessionFolder`: the
 * session's own folder on the host (RemoteHelperCommands' `folder`).
 */
export function clipStandInFolder(m: Pick<RemoteMachineRecord, 'os'>, cli: Pick<RemoteLaunch, 'clipStandIn'>, sessionFolder: string | undefined): string | null {
  if (cli.clipStandIn !== true || m.os !== 'Linux' || typeof sessionFolder !== 'string') return null
  const folder = sessionFolder.replace(/\/+$/, '')
  if (!folder.startsWith('/') || STAND_IN_UNSAFE_RE.test(folder)) return null
  return `${folder}/bin`
}

/** The session helper's commands for session `sid` on machine `m`, by the
 *  layout the scripts keep there (scripts.ts: `~/.aicc/<did>/helper/<folder>/aicc-helper`,
 *  `~/.aicc/<did>/store` and, for the session's own files,
 *  `~/.aicc/<did>/sessions/<sid>`), from the home folder the machine's check read. */
export function remoteHelperCommands(m: RemoteMachineRecord, sid: string): RemoteHelperCommands {
  const device = `${m.home.replace(/\/+$/, '')}/.aicc/${m.did}`
  return { helperPath: `${device}/helper/${m.helper.folder}/aicc-helper`, store: `${device}/store`, sid, folder: `${device}/sessions/${sid}` }
}

/** A tab's launch through the helper, as its provider gave it before anything
 *  was read on the host (./index.ts remoteLaunchOf). The driver reads the
 *  host files it names, asks the launch again with them, and writes its files. */
export interface RemoteLaunchPlan {
  /** The tab's provider, whose session the tool host serves. */
  readonly provider: ProviderId
  readonly via: ProviderRemoteLaunch
  readonly options: RemoteLaunchOptions
  readonly helper: RemoteHelperCommands
  /** The host files to read first (the provider's hostReads), in order. */
  readonly reads: readonly RemoteHostRead[]
  /** The launch asked with every read not made: its program, arguments and
   *  variables are the spec's, and the launch asked with the reads must give
   *  the same. */
  readonly first: RemoteLaunch
  readonly spec: LaunchSpec
}

/**
 * What the CLI is started with on the host: the provider's program,
 * arguments and variables (`cli`, its remote launch), through the host
 * user's login shell when that is of the sh family, with the host account's
 * variables, LANG and TERM first and the terminal's own (`terminalEnv`: its
 * light or dark scheme) last. Throws when `cli.env` names a variable this
 * sets itself: the provider's launch never replaces one.
 *
 * 2.1.3-beta.21: a launch that asks for the clipboard stand-in
 * (`cli.clipStandIn`, with `sessionFolder` the session's own folder on the
 * host), on a Linux host (clipStandInFolder), gets that folder's bin/ first
 * on PATH: inside the `-c` wrapper, after the rc files (CLIP_STAND_IN_WRAPPER,
 * the folder its first argument after the program), for a login shell of the
 * sh family; for one outside it, which runs no rc file here, in front of the
 * host account's PATH.
 */
export function remoteLaunchSpec(m: RemoteMachineRecord, cli: Pick<RemoteLaunch, 'program' | 'args' | 'env' | 'clipStandIn'>, terminalEnv: Readonly<Record<string, string>>, remotePath: string | undefined, cols: number, rows: number, sessionFolder?: string): LaunchSpec {
  const bin = clipStandInFolder(m, cli, sessionFolder)
  const argv = !m.shellIsSh
    ? [cli.program, ...cli.args]
    : bin
      ? [m.shell, '-il', '-c', CLIP_STAND_IN_WRAPPER, cli.program, bin, ...cli.args]
      : [m.shell, '-il', '-c', PLAIN_WRAPPER, cli.program, ...cli.args]
  const own: Record<string, string> = {
    ...hostAccountEnv(m),
    LANG: m.lang ?? 'C.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor',
  }
  if (bin && !m.shellIsSh) own.PATH = m.path ? `${bin}:${m.path}` : bin
  const taken = new Set([...Object.keys(own), ...Object.keys(terminalEnv)].map((k) => k.toUpperCase()))
  for (const k of Object.keys(cli.env)) {
    if (taken.has(k.toUpperCase())) throw new Error(`the provider's launch sets ${k}, which the session helper's launch sets itself`)
  }
  const env: Record<string, string> = { ...own, ...cli.env, ...terminalEnv }
  return { argv, cwd: remoteCwd(remotePath, m.home), env, cols, rows }
}

class Emitter<T> {
  private listeners: Array<(e: T) => void> = []
  readonly event: IEvent<T> = (listener: (e: T) => unknown): IDisposable => {
    const fn = (e: T) => { listener(e) }
    this.listeners.push(fn)
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== fn) } }
  }
  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try { l(e) } catch { /* a listener's throw is its own */ }
    }
  }
}

/** A terminal that only says why it could not start, then ends. */
export class NoticePty implements IPty {
  readonly pid = 0
  readonly process = 'ssh'
  handleFlowControl = false
  private readonly data = new Emitter<string>()
  private readonly exit = new Emitter<{ exitCode: number; signal?: number }>()
  private over = false
  constructor(text: string, readonly cols: number, readonly rows: number) {
    setTimeout(() => {
      if (this.over) return
      this.data.fire(`\r\n[${text}]\r\n`)
      this.end()
    }, 0)
  }
  get onData(): IEvent<string> { return this.data.event }
  get onExit(): IEvent<{ exitCode: number; signal?: number }> { return this.exit.event }
  private end(): void { if (!this.over) { this.over = true; this.exit.fire({ exitCode: 1 }) } }
  write(): void { /* nothing runs */ }
  resize(): void { /* nothing to size */ }
  clear(): void { /* nothing shown but the note */ }
  pause(): void { /* nothing flows */ }
  resume(): void { /* nothing flows */ }
  kill(): void { this.end() }
}

/** Sessions of a remote tab still ending, by helper session id: a new holder
 *  for the same id waits for its end (a Restart reuses the id). */
const endings = new Map<string, Promise<void>>()
const ENDING_WAIT_MS = 10_000

async function afterEnding(sid: string): Promise<void> {
  const done = endings.get(sid)
  if (!done) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([done, new Promise<void>((r) => { timer = setTimeout(r, ENDING_WAIT_MS) })]).catch(() => { /* ended either way */ })
  if (timer) clearTimeout(timer)
}

/** An error that no new try will mend: no reconnect after it (section 11). */
class FinalError extends Error {}

/**
 * 2.1.3-beta.20 section 3: a tab's account on its machine. `plan` (the
 * session options') is the launch on the account's own folder there; `own`
 * is the same launch on the machine's own sign-in, taken when the read finds
 * the account signed in as that. A sign-in tab (`signIn`) has no `own`: its
 * launch is the CLI's own sign-in in the account's folder, which its start
 * makes.
 */
export interface RemoteTabAccount {
  profileId: string
  via: RemoteAccounts
  signIn: boolean
  own?: { plan: RemoteLaunchPlan; spec: LaunchSpec }
  /** The tab started nothing for its account: where the renderer is told. */
  notice?: (n: HostAccountNotice) => void
  /** Final review round 2 (F2-1): the app's account aliases (host-accounts.ts
   *  accountAliasesOf), so its refusal names the account as the renderer does. */
  aliases?: Readonly<Record<string, string>>
}
/** The bridge found no holder for the session (exit 3): it is gone. */
class GoneError extends FinalError {}

/** What a start of a tab's session found: a holder it started (`attach`
 *  false: its launch follows), or one that runs until it is ended, kept for
 *  this tab's session (`attach` true: attached to, nothing launched). */
export interface HeldStart {
  record: HolderRecord
  attach: boolean
}

export interface RemoteSessionOptions {
  appPtyId: string
  machine: RemoteMachineRecord
  installId: string
  runner: SshRunner
  spec: LaunchSpec
  log: (message: string) => void
  /** The launch its provider gave (2.1.3-beta.18 section 3.2): the host files
   *  read first, the session's files written before the launch and removed at
   *  its end, and the keep-lists. Absent: none of that, the spec alone. */
  plan?: RemoteLaunchPlan
  /** Where the tab's status line, hook events and tool streams go. Absent:
   *  its connections ask for none of them. */
  signals?: RemoteSignalDeps
  /** The back-off for a dropped link; tests shorten it. */
  reconnectDelaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
  /** The holder's kind (2.1.3-beta.19 section 1.2): `away` (a plain SSH
   *  tab's; the default) or `until-ended` (an SSH Persistent tab's). */
  kind?: HolderKind
  /** 2.1.3-beta.20 section 3: the tab's account on the machine. Absent: the
   *  machine's own sign-in, read nowhere (a config with no account). */
  account?: RemoteTabAccount
}

/** HelperPty's driver for a remote tab: every step is an exec over ssh. */
export class RemoteDriver implements HelperPtyDriver {
  /** Set once the tab is closed: no new try starts. */
  closed = false
  /** The bridge exec's ssh process now (for the host line and the e2e job). */
  linkPid: number | undefined
  /** `direct` starts no program: it only says why (a NoticePty). */
  readonly startsNothing = true as const
  private why = ''
  /** Phase 5 round 4 (R4-2): a `why` that names its own next steps, so its
   *  note adds none (set with it, by failWith). */
  private whySteps: string | undefined
  private readonly connected = new Set<string>()
  private readonly target: SshTarget
  private readonly sleep: (ms: number) => Promise<void>
  /** The tab's status line, hook events and tool streams; none without a plan and the app's side. */
  private readonly signals: RemoteSignals | undefined
  /** Set once the session's files were sent to the host: its end removes the folder. */
  private filesSent = false
  /** 2.1.3-beta.21 (ADR-032): true exactly when this driver's `files` exec
   *  (one per driver, at its launch) answered `clip ok`, so the CLI it
   *  launched has the session's bin/ first on PATH and its image paste reads
   *  the picture the app sends. False when the launch did not ask, the host
   *  is not Linux, or the scripts were not written. It stays as it is while
   *  the tab re-attaches over its link (bin/ stays with the session's
   *  folder). A start that attaches to a kept session runs no `files` exec,
   *  so a driver that launched nothing (a kept tab after the app restarts)
   *  has false, although that session's CLI may have the stand-in: the host
   *  is not asked yet. The app route that reads this (plan block 5.1, its
   *  App bullet) decides readiness on attach too. */
  clipStandInReady = false
  /** The start prepare() made, for HelperPty's hold to take (once). */
  private prepared: { record: HolderRecord } | { error: Error } | undefined
  /** This tab's holder runs until it is ended, its own or one it attached to. */
  private untilEnded: boolean
  /** The start attached to a holder kept for this tab's session. */
  private adopted = false
  /** The tab was attached to its holder at least once. */
  private everAttached = false
  /** The tab's terminal attached to its holder at least once. */
  get wasAttached(): boolean { return this.everAttached }
  /** End was asked for (the close question's End, Remove of a session left running, or End on its machine's card): the holder may be ended from here. */
  endAsked = false
  /** The link stayed down past every try: the kept session is let go of. */
  keptLost = false
  /** The tab's attach again found no holder for its session (the bridge's exit 3): it is over on the machine. */
  keptGone = false
  /** 2.1.3-beta.20 section 3.1.7: the launch this start runs: the session
   *  options' (on the account's own folder, for a tab on an account), or the
   *  account's launch on the machine's own sign-in once its read found that. */
  private current: { plan: RemoteLaunchPlan | undefined; spec: LaunchSpec }
  /** Where this start's account read put it: its own folder, or the machine's own sign-in. */
  private boundTo: 'folder' | 'own' | undefined
  /** The tab started nothing for its account: why, for its note. */
  private accountRefused: HostLaunchRefusal | undefined
  /** The launch this start runs (section 3.1.7): its spec is what the CLI starts with. */
  get spec(): LaunchSpec { return this.current.spec }

  constructor(private readonly o: RemoteSessionOptions) {
    this.current = { plan: o.plan, spec: o.spec }
    this.target = { host: o.machine.host, port: o.machine.port, user: o.machine.user }
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    const plan = o.plan
    if (plan && o.signals) {
      this.signals = new RemoteSignals({ appPtyId: o.appPtyId, provider: plan.provider, via: plan.via, launch: plan.first, tools: plan.options.tools, deps: o.signals, log: o.log })
    }
    this.untilEnded = o.kind === 'until-ended'
  }

  /** A driver that only ends one kept session (End on the Machines card). */
  static forEnd(o: Pick<RemoteSessionOptions, 'appPtyId' | 'machine' | 'installId' | 'runner' | 'log' | 'signals'>): RemoteDriver {
    const spec: LaunchSpec = { argv: ['aicc-end'], cwd: o.machine.home, env: {}, cols: 80, rows: 24 }
    return new RemoteDriver({ ...o, spec, kind: 'until-ended' })
  }

  /** The tab's session runs on past this tab: the holder is not ended from
   *  here (it runs until it is ended, End was not asked for, and the tab let
   *  go of it, or attached to it and has not shown it yet). */
  private keepsRunning(): boolean {
    return this.untilEnded && !this.endAsked && (this.keptLost || (this.adopted && !this.everAttached))
  }

  private values(nonce: string, ...rest: string[]): string[] {
    const m = this.o.machine
    return [nonce, m.did, this.o.installId, m.helper.folder, m.helper.sha256, ...rest]
  }

  private failWith(why: string, ownSteps = false): never {
    this.why = why
    this.whySteps = ownSteps ? why : undefined
    throw new Error(why)
  }

  /**
   * The host files the launch needs are read first (when its provider names
   * any), then the holder is started, then the session's own files are
   * written (when the launch gives any), all before HelperPty sends the
   * launch. A start that fails after its holder started ends that holder.
   * A start that finds a holder kept for this tab's session until it is
   * ended (2.1.3-beta.19) attaches to it: the reads still run, and its files,
   * written at its launch, are not written again (its end removes them).
   */
  async prepare(sid: string, label: string, abandoned: () => boolean): Promise<HeldStart> {
    await afterEnding(sid)
    if (this.o.account) {
      const refused = await this.bindAccount(this.o.account)
      if (refused) {
        // 2.1.3-beta.20 fix round (NIT-8): an attach starts no CLI. A session
        // kept for this tab runs on with the sign-in it started with, so its
        // account's read only names its state (the read went to the
        // renderer) and never stops the attach; a launch it does stop.
        const kept = this.untilEnded && !abandoned() ? await this.keptFor(sid) : null
        if (!kept) this.refuseForAccount(this.o.account, refused)
        this.o.log(`[remote-helper] ${sid}: a session kept for this tab runs on ${this.o.machine.host}; attaching to it, nothing is launched (its account reads ${refused.state} there)`)
        const first = this.current.plan?.first
        if (first) {
          this.signals?.launched(first)
          this.filesSent = first.files.length > 0
        }
        this.adopted = true
        this.untilEnded = true
        return { record: kept, attach: true }
      }
    }
    if (abandoned()) throw new NothingStartedError('the tab was closed while it started')
    const plan = this.current.plan
    const read = plan ? await this.launchWithReads(plan, sid) : undefined
    const launch = read?.launch
    if (abandoned()) throw new NothingStartedError('the tab was closed while it started')
    // Its own folder's links and settings copy, before any holder starts.
    if (read && this.o.account && !this.o.account.signIn && this.boundTo === 'folder') await this.refreshAccountFolder(this.o.account, read.files)
    const held = await this.startHolder(sid, label, abandoned)
    if (held.attach) {
      this.adopted = true
      this.untilEnded = true
    }
    if (launch) {
      this.signals?.launched(launch)
      if (held.attach) this.filesSent = launch.files.length > 0
      else if (launch.files.length > 0) await this.writeFiles(sid, held.record, launch)
    }
    return held
  }

  /** What prepare() made, for HelperPty's hold to take. */
  setPrepared(p: { record: HolderRecord } | { error: Error }): void { this.prepared = p }

  /** HelperPty's start: the holder prepare() started (RemoteHelperPty always
   *  prepares first, so an attach never reaches a launch). */
  async hold(sid: string, label: string, abandoned: () => boolean): Promise<HolderRecord> {
    const p = this.prepared
    this.prepared = undefined
    if (p) {
      if ('error' in p) throw p.error
      return p.record
    }
    const held = await this.prepare(sid, label, abandoned)
    if (held.attach) throw new NothingStartedError('a session kept for this tab was found after its start began')
    return held.record
  }

  /**
   * The launch asked with what this start read on the host (readHostForStart:
   * the host files, each null when the provider names none or the exec did
   * not take it, one log line each; and the account field, which goes to the
   * tab's status line and header). Throws, saying why, when the host could
   * not be reached, the exec refused, or the launch's program, arguments or
   * variables are not the ones its spec was built from.
   */
  private async launchWithReads(plan: RemoteLaunchPlan, sid: string): Promise<{ launch: RemoteLaunch; files: RemoteHostFile[] }> {
    let files: Awaited<ReturnType<typeof readHostForStart>>['files']
    try {
      files = (await readHostForStart({ runner: this.o.runner, machine: this.o.machine, installId: this.o.installId, log: this.o.log, ...(this.signals ? { signals: this.signals } : {}) }, plan, sid)).files
    } catch (err) {
      this.failWith((err as Error).message)
    }
    let launch: RemoteLaunch
    try {
      launch = plan.via.launch(plan.options, this.o.machine, plan.helper, files)
    } catch (err) {
      this.failWith(`its provider's launch could not be made: ${(err as Error).message}`)
    }
    const same = launch.program === plan.first.program && JSON.stringify(launch.args) === JSON.stringify(plan.first.args) && JSON.stringify(launch.env) === JSON.stringify(plan.first.env)
    if (!same) this.failWith('its provider\'s launch changed its program, arguments or variables with what was read on the host')
    // 2.1.3-beta.21: the spec's PATH was built with the first launch's stand-in.
    if ((launch.clipStandIn === true) !== (plan.first.clipStandIn === true)) this.failWith('its provider\'s launch changed whether it reads pictures through the clipboard stand-in with what was read on the host')
    return { launch, files }
  }

  /**
   * 2.1.3-beta.20 section 3.1.7: which sign-in this start runs on. A sign-in
   * tab makes the account's folder (`account make`; its settings copy left
   * as it is) and reads nothing. Any other tab on an account reads the
   * machine's sign-ins (one exec) and starts on the account's own folder when
   * it is signed in there, on the machine's own sign-in when that is the
   * account (its launch is `own`), and otherwise answers why it may not
   * launch (prepare then starts nothing, unless a session kept for this tab
   * runs there to attach to). A folder signed in as another account is
   * never used.
   */
  private async bindAccount(a: RemoteTabAccount): Promise<HostLaunchRefusal | null> {
    const m = this.o.machine
    const ctx = { runner: this.o.runner, installId: this.o.installId, log: this.o.log }
    if (a.signIn) {
      // Final review round 4 (F4-1): a sign-in tab for an account this
      // computer no longer holds makes no folder and signs nothing in there:
      // the app could never start a tab on it.
      let heldNow: readonly HostProfile[] | null
      try { heldNow = await a.via.profiles() } catch { heldNow = null }
      if (heldNow && !heldNow.some((p) => p.id === a.profileId)) this.failWith('its account is no longer on this computer, so nothing was made or signed in there. Start a tab on an account signed in there', true)
      const made = await prepareAccountFolder(ctx, m, a.via, a.profileId, 'make', 'keep')
      // Round 2 (R1): a folder there with another install's mark is never made over by a sign-in.
      // Phase 5 round 3 (R3-1): what it says follows the one Adopt rule, from
      // the machine's last read (no exec): Adopt only while every such folder
      // there is for this computer's accounts.
      if (!made.ok && made.refused === 'account-folder-elsewhere') {
        let last: ReturnType<typeof machineAccounts> | null = null
        try { last = machineAccounts(m.did, await a.via.profiles()) } catch { last = null }
        const named = !!last && last.readAt !== null && (last.elsewhere ?? []).includes(a.profileId)
        // Round 4 (R4-2), round 5 (R5-1): each of these notes names its own
        // steps only, so none gets the generic "Press Check ... Sign in on
        // this machine again" after it. After Adopt the next step is Sign in
        // again, with no Check: the Adopt dialog reads the machine again.
        if (named && last?.mayBeEarlierInstall === true) this.failWith(`the account's folder on ${m.host} carries another install's mark, and nothing of it was changed. It may be this computer's own from an earlier install of the app: if so, choose Adopt on the machine's card on the Machines page, then choose Sign in on this machine again`, true)
        // A sign-in from here cannot help, so this one names no Sign in on this machine.
        if (named) this.failWith(`the account's folder on ${m.host} is used by the app on another computer, and nothing of it was changed. Sign it in there from that computer, or start a tab on an account signed in there`, true)
        this.failWith(`the account's folder on ${m.host} carries another install's mark, and nothing of it was changed. Press Check on the Machines page: if the machine's card then says it may be this computer's own from an earlier install, choose Adopt on the machine's card, then Sign in on this machine again; if it is the app's on another computer, sign it in there from that computer`, true)
      }
      if (!made.ok) this.failWith(`the account's folder could not be made on ${m.host}: ${made.why}`)
      this.boundTo = 'folder'
      return null
    }
    const accounts = await readMachineAccounts(ctx, m, a.via)
    let profiles: readonly HostProfile[] | null
    try { profiles = await a.via.profiles() } catch { profiles = null }
    const bound = accountBinding(accounts, a.profileId, m, machineName(m), profiles, a.aliases)
    if ('refused' in bound) return bound.refused
    if (bound.via === 'own') {
      if (!a.own) this.failWith('its account is the machine\'s own sign-in there, and no launch on that was made')
      this.current = { plan: a.own.plan, spec: a.own.spec }
    }
    this.boundTo = bound.via
    return null
  }

  /** The tab starts nothing for its account: its note, and the renderer's notice, say why. */
  private refuseForAccount(a: RemoteTabAccount, refused: HostLaunchRefusal): never {
    this.accountRefused = refused
    this.o.log(`[remote-helper] ${this.o.appPtyId}: nothing started, because its account is ${refused.state} on ${this.o.machine.host}`)
    try { a.notice?.({ kind: 'launch-refused', sessionId: this.o.appPtyId, refusal: refused }) } catch { /* the app's own */ }
    this.why = refused.text
    throw new FinalError(refused.text)
  }

  /** The holder list mode shows for `sid` that runs until it is ended and has
   *  launched its program: a session kept for this tab, to attach to. */
  private async keptFor(sid: string): Promise<HolderRecord | null> {
    try {
      const found = await this.leftover(sid)
      return found && untilEnded(found) && found.child !== 'waiting' ? found : null
    } catch {
      return null
    }
  }

  /** The account's own folder brought up to date before a launch on it
   *  (`account refresh`): its links, and its settings copy made from the
   *  host user's own settings this start read. A folder that went since the
   *  read, or one that does not take the refresh, fails the start. */
  private async refreshAccountFolder(a: RemoteTabAccount, files: readonly RemoteHostFile[]): Promise<void> {
    const m = this.o.machine
    let content: string | null
    try {
      content = a.via.settingsCopy(files).content
    } catch (err) {
      this.o.log(`[remote-helper] ${this.o.appPtyId}: the account's settings copy could not be made (${(err as Error).message}); it has none`)
      content = null
    }
    const done = await prepareAccountFolder({ runner: this.o.runner, installId: this.o.installId, log: this.o.log }, m, a.via, a.profileId, 'refresh', content)
    if (!done.ok) this.failWith(done.gone ? `its account's folder on ${m.host} is not there any more; sign it in there again from the Machines page` : done.why)
  }

  /** The session's own files into its folder on the host (the `files` exec).
   *  On any failure its holder is ended first, then the start fails saying why.
   *  2.1.3-beta.21: the same exec writes the clipboard stand-in's two scripts
   *  into the session's bin/ folder when the launch asks for them (`clip`,
   *  with the helper's folder, which they name); a stand-in it could not write
   *  fails nothing: the start goes on, and the log says why. */
  private async writeFiles(sid: string, record: HolderRecord, launch: RemoteLaunch): Promise<void> {
    const host = this.o.machine.host
    let why: string | null = null
    const standIn = clipStandInFolder(this.o.machine, launch, this.current.plan?.helper.folder) !== null
    try {
      const { layout, stdin } = sessionFilesInput(launch.files)
      const nonce = newNonce()
      this.filesSent = true
      const r = await runScript(this.o.runner, this.target, 'files', [nonce, this.o.machine.did, this.o.installId, sid, layout, this.o.machine.helper.folder, standIn ? 'clip' : 'none'], { stdin })
      if (r.notStarted) this.o.log(notStartedLogLine(host, r.stderr))
      const failed = sshFailure(r)
      const result = failed ? null : readScriptResult(r.stdout, nonce)
      if (failed) why = `${host} could not be reached: ${failed}`
      else if (!result) why = `${host} did not answer the session helper's write of the session's files`
      else if (!result.ok) why = `the session's files could not be written on ${host}: ${refusalText(result.refused)}`
      else if (standIn) this.standInWritten(sid, result.values.get('clip'))
    } catch (err) {
      why = (err as Error).message
    }
    if (why === null) return
    await this.endHolder(record)
    this.failWith(why)
  }

  /** What the `files` exec said of the clipboard stand-in (`clip ok`, or the
   *  word for why it wrote none): one log line when it wrote none. */
  private standInWritten(sid: string, said: string | undefined): void {
    this.clipStandInReady = said === 'ok'
    if (this.clipStandInReady) return
    const why = said !== undefined && /^[a-z-]{1,40}$/.test(said) ? said : 'no answer'
    this.o.log(`[remote-helper] ${sid}: the clipboard stand-in was not written on ${this.o.machine.host} (${why}); image paste in this tab is not available`)
  }

  /** A holder this start made and cannot use: ended over a link of its own. */
  private async endHolder(record: HolderRecord): Promise<void> {
    let conn: HolderConnection | undefined
    try {
      conn = await this.connectOnce(record, false)
      await conn.request({ t: 'term.end' })
    } catch (err) {
      this.o.log(`[remote-helper] ${record.session}: the holder started for this tab could not be ended (${(err as Error).message}); ${this.untilEnded ? 'the Machines page lists it, with End' : 'its away clock ends it'}`)
    } finally {
      conn?.close()
    }
  }

  /** The session's own folder goes (the `unsession` exec), once its holder
   *  ended. Never throws; one that is not removed goes at the next start's
   *  list of kept sessions, or at the next Check. */
  private async removeFolder(sid: string): Promise<void> {
    const host = this.o.machine.host
    try {
      const nonce = newNonce()
      const r = await runScript(this.o.runner, this.target, 'unsession', [nonce, this.o.machine.did, this.o.installId, sid])
      const failed = sshFailure(r)
      const result = failed ? null : readScriptResult(r.stdout, nonce)
      if (!result?.ok) this.o.log(`[remote-helper] ${sid}: the session's folder on ${host} was not removed (${failed ?? (result ? refusalText(result.refused) : 'no answer')}); the next start's list of kept sessions, or the next Check, removes it`)
    } catch (err) {
      this.o.log(`[remote-helper] ${sid}: the session's folder on ${host} was not removed (${(err as Error).message}); the next start's list of kept sessions, or the next Check, removes it`)
    }
  }

  private async startHolder(sid: string, label: string, abandoned: () => boolean): Promise<HeldStart> {
    const host = this.o.machine.host
    for (let attempt = 0; attempt < 2; attempt++) {
      if (abandoned()) throw new NothingStartedError('the tab was closed while it started')
      const nonce = newNonce()
      const r = await runScript(this.o.runner, this.target, 'hold', this.values(nonce, sid, holderLabel(label), this.o.kind ?? 'away'))
      const failed = sshFailure(r)
      if (r.notStarted) this.o.log(notStartedLogLine(host, r.stderr))
      if (failed) this.failWith(`${host} could not be reached: ${failed}`)
      const hash = readHashLine(r.stdout, nonce)
      if (!hash) this.failWith(`${host} did not answer the session helper (is it still added? press Check on the Machines page)`)
      if (hash.state !== 'ok') this.failWith(`the session helper file on ${host} did not pass its hash check (${hash.state}); press Check on the Machines page`)
      if (r.code === 3) {
        const found = attempt === 0 && !abandoned() ? await this.leftover(sid) : null
        // 2.1.3-beta.19: a holder that runs until it is ended keeps this tab's
        // session (a quit, an update, Leave running, a link that stayed down):
        // the tab attaches to it, and nothing is launched.
        if (found && untilEnded(found) && found.child !== 'waiting') {
          this.o.log(`[remote-helper] ${sid}: a session kept for this tab runs on ${host}; attaching to it, nothing is launched`)
          return { record: found, attach: true }
        }
        // A clock holder left for this tab's session (an app crash or update
        // within its away clock): ended first, so two CLIs never run on one
        // conversation. So is an until-ended one with nothing launched in it
        // (an app that ended between its hold and its launch): it holds no
        // session to come back to.
        if (found) { await this.endLeftover(found); continue }
        if (attempt === 0 && !abandoned()) { this.o.log(`[remote-helper] ${sid}: a holder runs for it, and list mode does not show it`); continue }
        this.failWith(`a session the app could not end still runs for this tab on ${host}`)
      }
      if (r.code !== 0) this.failWith(`the session helper on ${host} could not start a holder (${exitText(r)}: ${r.stderr.trim().slice(0, 200)})`)
      const line = afterHashLine(r.stdout, nonce).split(/\r?\n/).find((l) => l.startsWith('{'))
      let held: HolderRecord | null = null
      try { held = line ? readRecord(JSON.parse(line), 'unix') : null } catch { held = null }
      if (!held || held.session !== sid) this.failWith(`the session helper on ${host} started a holder whose record does not read`)
      // The kind it was asked for, by its record: a holder of the other kind
      // (one that would end by a clock the tab was told it has not, or one
      // that would never end by itself) is ended at once, and nothing is launched.
      if (untilEnded(held) !== (this.o.kind === 'until-ended')) {
        await this.endHolder(held)
        this.failWith(`the session helper on ${host} started a holder of another kind than this tab asked for; press Check on the Machines page`)
      }
      return { record: held, attach: false }
    }
    this.failWith(`a holder for this tab could not be started on ${host}`)
  }

  /** The holder that runs for `sid`, by list mode; null when list mode does not show it. */
  private async leftover(sid: string): Promise<HolderRecord | null> {
    const nonce = newNonce()
    const r = await runScript(this.o.runner, this.target, 'list', this.values(nonce))
    const line = readHashLine(r.stdout, nonce)?.state === 'ok' ? afterHashLine(r.stdout, nonce).split(/\r?\n/).find((l) => l.startsWith('{')) : undefined
    const listing = line ? readListing(line, 'unix') : null
    return listing?.sessions.find((s) => s.session === sid) ?? null
  }

  /** A holder an earlier run left for this tab's session that is not attached to: a clock holder (a crash or an update within its away clock), or an until-ended one with nothing launched in it. Ended. */
  private async endLeftover(rec: HolderRecord): Promise<void> {
    this.o.log(`[remote-helper] ${rec.session}: a holder an earlier run left for this tab is ended first`)
    let conn: HolderConnection | undefined
    try {
      conn = await this.connectOnce(rec)
      await conn.request({ t: 'term.end' })
    } catch (err) {
      this.o.log(`[remote-helper] ${rec.session}: the earlier holder could not be ended: ${(err as Error).message}`)
    } finally {
      conn?.close()
    }
  }

  /**
   * End (2.1.3-beta.19 section 1.2): a kept session ended over a link of its
   * own (term.end), then its folder (unsession) and the app's hook state for
   * its tab. A holder already gone counts as ended. Never throws.
   */
  async endKept(record: HolderRecord): Promise<{ ok: true } | { ok: false; why: string }> {
    this.endAsked = true
    let conn: HolderConnection | undefined
    try {
      conn = await this.connectOnce(record, false)
      await conn.request({ t: 'term.end' })
    } catch (err) {
      if (!(err instanceof GoneError)) return { ok: false, why: (err as Error).message }
    } finally {
      conn?.close()
    }
    await this.removeFolder(record.session)
    try { this.o.signals?.ended(this.o.appPtyId) } catch { /* the app's own */ }
    return { ok: true }
  }

  async connect(record: HolderRecord): Promise<HolderConnection> {
    // A kept session let go of (its link stayed down, or no holder was found
    // for it) is ended only by End, over a link of its own (endKept): no link
    // is tried here for the end the tab's give-up sends, which wrapRequests
    // would refuse; it used to go through every try again.
    if (this.keptLost && this.untilEnded && !this.endAsked) throw new FinalError('a session kept until it is ended was let go of: only End ends it')
    const again = this.connected.has(record.nonce)
    // A closed tab gets one try (its end, term.end); only a tab still open
    // waits out a dropped link.
    const delays = again && !this.closed ? [0, ...(this.o.reconnectDelaysMs ?? RECONNECT_DELAYS_MS)] : [0]
    let last: Error = new Error('no try was made')
    for (const d of delays) {
      if (d > 0) await this.sleep(d)
      if (d > 0 && this.closed) break
      try {
        const conn = await this.connectOnce(record, true, true)
        this.connected.add(record.nonce)
        return conn
      } catch (err) {
        last = err as Error
        if (err instanceof GoneError) this.keptGone = true
        if (err instanceof FinalError) break
        // The reason says which side ended (ssh-exec.ts openScriptStream): the
        // ssh link on this computer, or the helper on the machine.
        if (again) this.o.log(`[remote-helper] ${record.session}: the link to ${this.o.machine.host} is not back yet (${last.message})`)
      }
    }
    this.why = last.message
    throw last
  }

  /**
   * Two requests on a connection get more than a plain failure.
   *
   * A launch the holder refuses (the config's remote folder is not there, so
   * the CLI cannot start in it): the tab's note names the folder and the
   * holder's words, not "it did not answer" (HelperPty then ends the holder
   * and shows direct()).
   *
   * A tab closed just as its link dropped: HelperPty sends the end over the
   * connection it still has, and the link takes it down with it (the
   * connection closes before the holder answers, so the holder never got it,
   * or ended and could not say so). Such an end goes once more, over a link of
   * its own; a holder already gone answers that with a bridge exit 3, and the
   * end is done. Any other request fails as it did.
   */
  private wrapRequests(conn: HolderConnection, record: HolderRecord): void {
    const request = conn.request.bind(conn)
    conn.request = async (msg, onReply) => {
      // A session kept until it is ended is ended only by End (2.1.3-beta.19):
      // not by a link given up on, nor by a take-over whose attach failed.
      if (msg.t === 'term.end' && this.keepsRunning()) throw new Error('a session kept until it is ended is ended only by End')
      try {
        return await request(msg, onReply)
      } catch (err) {
        if (msg.t === 'term.launch') {
          this.why = `Claude Code could not be started in ${this.o.spec.cwd} on ${this.o.machine.host}: ${stripSpoofableText((err as Error).message, 200)}`
        }
        if (msg.t !== 'term.end' || !this.closed || !(err instanceof HolderError) || err.code !== 'io') throw err
        this.o.log(`[remote-helper] ${record.session}: the link dropped as the tab closed; its end goes once more on a new link`)
        const again = await this.connectOnce(record, false)
        try {
          return await again.request(msg, onReply)
        } finally {
          again.close()
        }
      }
    }
  }

  /** One bridge exec, and the holder's hello over it. `tabs`: a connection of
   *  the tab's own (connect), which asks for its status line, hook events and
   *  tool streams and is routed by ./signals.ts; an end's own link asks for
   *  none of them. */
  private async connectOnce(record: HolderRecord, endAgain = true, tabs = false): Promise<HolderConnection> {
    const nonce = newNonce()
    let opened: Awaited<ReturnType<typeof openScriptStream>>
    try {
      opened = await openScriptStream(this.o.runner, this.target, 'bridge', this.values(nonce, record.session), nonce, BRIDGE_OPEN_MS)
    } catch (err) {
      const e = err as Error & { final?: boolean; startError?: string }
      if (typeof e.startError === 'string') this.o.log(notStartedLogLine(this.o.machine.host, e.startError))
      throw e.final ? new FinalError(e.message) : e
    }
    this.linkPid = opened.pid
    const asks = tabs ? this.signals?.asks : undefined
    try {
      const conn = await HolderConnection.open({
        record,
        os: 'unix',
        // The endpoint is on the host: the bridge, as this user there, connects to it.
        checkEndpointFolder: () => null,
        openStream: async () => opened.stream,
        helloTimeoutMs: BRIDGE_HELLO_MS,
        ...(asks?.hooks ? { hooks: true } : {}),
        ...(asks?.mcp ? { mcp: true } : {}),
        ...(asks?.status ? { status: true } : {}),
      })
      if (endAgain) this.wrapRequests(conn, record)
      if (asks) this.signals?.connected(conn)
      return conn
    } catch (err) {
      // ssh's exit status first (a bridge that found no holder exits 3; ssh
      // gives it just after its output ends, and the stream, ended by that
      // output's end, leaves ssh that moment: ssh-exec.ts EXIT_AFTER_OUTPUT_MS),
      // then the stream goes, and with it ssh if it still runs.
      let timer: ReturnType<typeof setTimeout> | undefined
      const r = await Promise.race([opened.result, new Promise<null>((res) => { timer = setTimeout(() => res(null), 2000) })])
      if (timer) clearTimeout(timer)
      opened.stream.destroy()
      if (r?.code === 3) throw new GoneError(`no holder runs for this tab on ${this.o.machine.host} any more`)
      // Any other exit of the bridge before its hello is named, so the tab's
      // note says it; a usage error (2: a helper without the mode) is not
      // tried again, and exit 1 may be. An exit no remote command gives
      // (outside 0 to 255: ssh ended by force on this computer) is named as
      // the ssh link's, signed (2.1.3-beta.18 fix round, item 3).
      if (typeof r?.code === 'number') {
        const local = localSshEnd({ code: r.code })
        const why = local !== null
          ? `${(err as Error).message} (the ssh link on this computer ended: ${local})`
          : `${(err as Error).message} (the session helper's bridge on ${this.o.machine.host} exited ${r.code})`
        throw r.code === 2 ? new FinalError(why) : new Error(why)
      }
      throw err
    }
  }

  direct(): IPty {
    const m = this.o.machine
    // 2.1.3-beta.20 section 3.1.7: a tab that started nothing for its account says only why, and its steps.
    if (this.accountRefused) return new NoticePty(this.accountRefused.text, this.o.spec.cols, this.o.spec.rows)
    // A tab whose session the helper keeps never takes the usual path
    // (2.1.3-beta.19): its note names only the steps that reach it again.
    // A sign-in tab neither (2.1.3-beta.20 fix round, NIT-11): the usual
    // path signs nothing in. Phase 5 rounds 4 and 5 (R4-2, R5-1): a why that
    // names its own steps (every note on a folder with another install's
    // mark) gets no others.
    const next = this.why !== '' && this.why === this.whySteps
      ? ''
      : this.o.account?.signIn
        ? 'Press Check on the Machines page, then choose Sign in on this machine again.'
        : this.untilEnded
          ? 'Press Check on the Machines page, then Restart; a session it keeps there is listed on that page, with End.'
          : 'Press Check on the Machines page, or turn the remote sessions switch off in Settings for the usual SSH path.'
    return new NoticePty(`This tab could not start through the session helper on ${m.host}: ${this.why || 'it did not answer'}.${next ? ` ${next}` : ''}`, this.o.spec.cols, this.o.spec.rows)
  }

  ending(sid: string, done: Promise<void>): void {
    // Once the holder ended, the app's hook state for the tab goes (its feed
    // ring and its overflow and lost-event marks, as a held session's on this
    // computer go), then the session's own folder, when its files were sent;
    // a new holder for the same id (a Restart, which reuses the tab's id)
    // waits for all of it.
    // A session kept until it is ended and only let go of keeps its folder.
    const whole = done.catch(() => { /* ended either way */ })
      .then(() => { try { this.o.signals?.ended(this.o.appPtyId) } catch { /* the app's own */ } })
      .then(() => (this.filesSent && !this.keepsRunning() ? this.removeFolder(sid) : undefined))
    endings.set(sid, whole)
    void whole.finally(() => { if (endings.get(sid) === whole) endings.delete(sid) })
  }

  /** Called once, at the tab's first attach to its holder: its CLI runs there
   *  (launched by this start, or kept there and attached to). The Watchdog arms
   *  then (2.1.3-beta.19 fix round). */
  onFirstAttach: (() => void) | undefined

  attachedChanged(_sid: string, attached: boolean): void {
    // The Machines page reads tabs and list mode, not attaches; a kept
    // session shown once may be ended from here only by End.
    if (!attached || this.everAttached) return
    this.everAttached = true
    try { this.onFirstAttach?.() } catch { /* the app's own */ }
  }

  log(message: string): void { this.o.log(message) }
}

/** Input a tab typed while its start was still finding its holder, at most. */
const EARLY_INPUT_MAX = 1024 * 1024

/**
 * The tab's terminal: a HelperPty over the remote driver, shaped as node-pty's
 * IPty. Its pid is 0: the holder's and the CLI's are the host's, and must
 * never be taken for a process on this computer.
 *
 * Its start first finds its holder (the driver's prepare: the host reads, the
 * hold, the session's files), and only then makes the HelperPty: one that
 * launches in the holder it started, or (2.1.3-beta.19) one that takes over
 * a holder kept for this tab's session until it is ended, which launches
 * nothing. What the tab typed or sized meanwhile goes to it once it is made.
 *
 * A tab whose holder runs until it is ended is let go of when it is closed,
 * at a quit or an app update (kill: HelperPty.release), and ended only by
 * end(): End's term.end over a link of its own.
 */
export class RemoteHelperPty implements IPty {
  readonly pid = 0
  readonly sid: string
  readonly machineDid: string
  /** 2.1.3-beta.20 section 3: the tab's account (its profile id), when its config names one. */
  readonly profileId: string | undefined
  private inner: HelperPty | undefined
  private readonly driver: RemoteDriver
  private readonly data = new Emitter<string>()
  private readonly running = new Emitter<void>()
  private readonly exit = new Emitter<{ exitCode: number; signal?: number }>()
  private readonly endedP: Promise<void>
  private resolveEnded!: () => void
  /** Before the HelperPty is made: what the tab typed, its last size, and a close. */
  private early: { input: Array<string | Buffer>; bytes: number; size?: { cols: number; rows: number }; killed: boolean } = { input: [], bytes: 0, killed: false }
  /** The holder the start found, once it is known. */
  private held: HeldStart | undefined
  /** The start's find of its holder, settled: the holder it found, or why it
   *  failed. End asked before it settles waits for it (end()). */
  private readonly preparing: Promise<HeldStart | Error>
  private exited = false

  constructor(private readonly o: RemoteSessionOptions) {
    this.sid = remoteSessionId(o.appPtyId)
    this.machineDid = o.machine.did
    this.driver = new RemoteDriver(o)
    this.driver.onFirstAttach = () => this.running.fire()
    // Both launches a tab on an account may run are checked before anything starts.
    for (const spec of [o.spec, ...(o.account?.own ? [o.account.own.spec] : [])]) {
      const problem = checkLaunch(spec, 'unix')
      if (problem) throw new Error(`the launch cannot go through the session helper: ${problem.why}`)
    }
    this.profileId = o.account?.profileId
    this.endedP = new Promise<void>((r) => { this.resolveEnded = r })
    const prepared = this.driver.prepare(this.sid, o.appPtyId, () => this.early.killed && !this.driver.endAsked)
    this.preparing = prepared.then((held) => held, (err: unknown) => (err instanceof Error ? err : new Error(String(err))))
    void prepared.then((held) => this.started(held), (err: Error) => this.startFailed(err))
  }

  /** The holder was found: the HelperPty that shows it is made. */
  private started(held: HeldStart): void {
    this.held = held
    // Closed while it started: with End asked, end() ends the holder itself,
    // whatever its kind, so no terminal is made for it; else a kept session
    // stays as it was, and a holder this start made (no program in it yet)
    // is ended through its HelperPty.
    if (this.early.killed && (this.driver.endAsked || held.attach)) { this.finishEarly(0); return }
    this.driver.setPrepared({ record: held.record })
    this.make(held.attach ? held.record : undefined)
  }

  private startFailed(err: Error): void {
    // Closed while it started: nothing to show (End asked meanwhile answers
    // this error: end()).
    if (this.early.killed) { this.finishEarly(0); return }
    this.driver.setPrepared({ error: err })
    this.make(undefined)
  }

  private make(adopt: HolderRecord | undefined): void {
    // Its provider (the launch plan's) decides a queued lone Enter's wait (2.1.3-beta.19 section 6.2).
    // The launch its start chose (2.1.3-beta.20 section 3.1.7: on its account's folder, or on the machine's own sign-in).
    const inner = new HelperPty({ sid: this.sid, label: this.o.appPtyId, spec: this.driver.spec, driver: this.driver, redraw: 'nudge', ...(adopt ? { adopt } : {}), ...(this.o.plan ? { provider: this.o.plan.provider } : {}) })
    this.inner = inner
    inner.onData((d) => this.data.fire(d))
    inner.onExit((e) => {
      // A link that stayed down past every try: a kept session is let go of,
      // never ended (the Restart attaches again), and the tab says so. One
      // whose attach again found no holder is over on the machine: the tab
      // says that instead (its Restart starts a new session on the conversation).
      if (e.exitCode === LOST_EXIT_CODE) {
        this.driver.keptLost = true
        if (this.untilEnded && !this.driver.endAsked) {
          this.data.fire(this.driver.keptGone
            ? `\r\n[This tab's session on ${this.o.machine.host} is over: no session helper holds it there any more (it ended there, or the machine restarted). Restart starts a new session and resumes the conversation.]\r\n`
            : `\r\n[This tab is no longer attached to its session on ${this.o.machine.host} (the link stayed down, or another tab took it). The session runs on there, kept by the session helper: Restart attaches to it again, and the Machines page lists it, with End.]\r\n`)
        }
      }
      this.exited = true
      this.exit.fire(e)
    })
    void inner.ended.then(() => this.resolveEnded())
    const { input, size, killed } = this.early
    this.early = { input: [], bytes: 0, killed: false }
    if (size) inner.resize(size.cols, size.rows)
    for (const d of input) this.write(d)
    if (killed) this.kill()
  }

  private finishEarly(exitCode: number): void {
    if (this.exited) return
    this.exited = true
    this.exit.fire({ exitCode })
    this.resolveEnded()
  }

  get cols(): number { return this.inner?.cols ?? this.early.size?.cols ?? this.o.spec.cols }
  get rows(): number { return this.inner?.rows ?? this.early.size?.rows ?? this.o.spec.rows }
  get process(): string { return 'ssh' }
  get handleFlowControl(): boolean { return false }
  set handleFlowControl(_v: boolean) { /* not used */ }
  get onData(): IEvent<string> { return this.data.event }
  get onExit(): IEvent<{ exitCode: number; signal?: number }> { return this.exit.event }
  /** Fires once, at the tab's first attach to its holder: the CLI runs there
   *  (the helper's own "it runs" signal; a usual SSH tab's is its
   *  claude-running latch), launched by this start or kept there and attached to. */
  get onRunning(): IEvent<void> { return this.running.event }
  /** The bridge exec's ssh process now, when there is one. */
  get linkPid(): number | undefined { return this.driver.linkPid }
  /** Settles once the session is over, or let go of. */
  get ended(): Promise<void> { return this.endedP }
  get throughHelper(): boolean { return this.inner?.throughHelper ?? true }
  /** The holder runs until it is ended (an SSH Persistent tab's, or one this
   *  tab attached to): closing the tab lets go of it. */
  get untilEnded(): boolean { return (this.o.kind ?? 'away') === 'until-ended' || this.held?.attach === true }
  /** The start attached to a session kept for this tab (nothing launched). */
  get attachedToKept(): boolean { return this.held?.attach === true }
  /** The tab showed its session at least once. */
  get everShown(): boolean { return this.driver.wasAttached }
  /** 2.1.3-beta.21: this start wrote the clipboard stand-in (RemoteDriver clipStandInReady). */
  get clipStandInReady(): boolean { return this.driver.clipStandInReady }

  write(data: string | Buffer): void {
    if (this.inner) { this.inner.write(data); return }
    const n = typeof data === 'string' ? Buffer.byteLength(data) : data.length
    if (this.early.bytes + n > EARLY_INPUT_MAX) return
    this.early.input.push(data)
    this.early.bytes += n
  }

  resize(cols: number, rows: number): void {
    if (this.inner) this.inner.resize(cols, rows)
    else this.early.size = { cols, rows }
  }
  clear(): void { this.inner?.clear() }
  pause(): void { this.inner?.pause() }
  resume(): void { this.inner?.resume() }

  /** A close, a Restart, a quit or an update. A holder that runs until it is
   *  ended is let go of (no term.end); any other ends its session. */
  kill(signal?: string): void {
    this.driver.closed = true
    const inner = this.inner
    if (!inner) { this.early.killed = true; return }
    if (this.untilEnded && !this.driver.endAsked && inner.release()) {
      this.o.log(`[remote-helper] ${this.sid}: let go of; its session runs on until it is ended`)
    }
    inner.kill(signal)
  }

  /**
   * End (2.1.3-beta.19 section 1.2): the session is ended, whatever its kind,
   * by term.end over a link of its own, then its folder goes; the terminal
   * is let go of first, so nothing else is sent to the holder. Answers what
   * the end did. Asked while the start still finds its holder, it waits for
   * that start: the holder it found is ended here; a start that failed ended
   * nothing, and the answer says why (a session kept there runs on).
   */
  async end(): Promise<{ ok: true } | { ok: false; why: string }> {
    this.driver.endAsked = true
    this.driver.closed = true
    const inner = this.inner
    const record = inner?.heldRecord ?? this.held?.record
    if (inner) {
      inner.release()
      inner.kill()
    } else {
      this.early.killed = true
    }
    if (record) return this.driver.endKept(record)
    const found = await this.preparing
    if (found instanceof Error) return { ok: false, why: found.message }
    return this.driver.endKept(found.record)
  }
}
