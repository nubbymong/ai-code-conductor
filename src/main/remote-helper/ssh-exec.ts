/**
 * The ssh commands remote step 1 runs (2.1.3-beta.17, plan section A2;
 * ADR-030 S24 and S25; docs/remote/helper-protocol.md sections 2, 4 and 6).
 *
 * Every command the app starts on a host is an exec over ssh, never a line
 * typed into a shell: one ssh by absolute path, with protocol section 2's
 * fixed options a key-only host needs (BatchMode, no terminal, no shared
 * connection, no forward, no agent, no escape character), the user's own ssh
 * configuration otherwise, and an environment taken from a short allow-list,
 * never the app's own. A fixed option the local ssh's `ssh -V` does not know
 * is left out (each one names the version that brought it).
 *
 * The command is always `/bin/sh -c '<script>' aicc <values...>`: ssh joins
 * its words into one string the host's login shell parses, so the script text
 * holds no single quote, backslash or line end (scripts.ts checks it), and
 * every value is checked against its own small alphabet before ssh starts.
 * Nothing a host reported is ever put on a command line. Content (the
 * helper's file) goes on standard input.
 *
 * Output is read only from marked lines carrying the exec's own nonce
 * (`AICC-HASH <nonce> ...`, `AICC-RESULT <nonce> ...`); what a host's rc files
 * print before them is discarded, up to 64 KiB, as section 6 says.
 *
 * This file imports nothing of Electron, so CI runs it under Node
 * (tests/live/remote-helper-device.live.ts).
 */
import { spawn as nodeSpawn, execFile } from 'child_process'
import type { ChildProcess, SpawnOptions } from 'child_process'
import { randomBytes } from 'crypto'
import { Duplex } from 'stream'
import { scriptCommand, type ScriptName } from './scripts'

/** A host as a saved SSH config names it: its name or address, port and user. */
export interface SshTarget {
  host: string
  port: number
  user: string
}

/** Section 2's patterns: a value that breaks its pattern stops before ssh starts. */
export const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,63}$/
export const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/

/** Why this target cannot be handed to ssh, or null when it can. */
export function targetProblem(t: { host?: unknown; port?: unknown; user?: unknown }): string | null {
  if (typeof t.host !== 'string' || !TARGET_RE.test(t.host)) return 'its host name is not one the session helper takes (letters, digits, dots, dashes, colons)'
  if (typeof t.user !== 'string' || !USER_RE.test(t.user)) return 'its user name is not one the session helper takes'
  if (!Number.isInteger(t.port) || (t.port as number) < 1 || (t.port as number) > 65535) return 'its port is not 1 to 65535'
  return null
}

/** The `major.minor` of an `ssh -V` line (`OpenSSH_9.6p1 ...`,
 *  `OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2`), or null. */
export function parseSshVersion(text: string): [number, number] | null {
  const m = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/.exec(text)
  return m ? [Number(m[1]), Number(m[2])] : null
}

const atLeast = (v: [number, number] | null, major: number, minor: number): boolean =>
  !!v && (v[0] > major || (v[0] === major && v[1] >= minor))

/** One fixed option and the ssh version that brought it. */
interface FixedOption { opt: string; since?: [number, number] }

/** Section 2's fixed options for a one-shot exec on a key-only host. */
const FIXED: readonly FixedOption[] = [
  { opt: 'BatchMode=yes' },
  { opt: 'ForwardAgent=no' },
  { opt: 'ForwardX11=no' },
  { opt: 'ForwardX11Trusted=no' },
  { opt: 'GSSAPIDelegateCredentials=no' },
  { opt: 'ClearAllForwardings=yes' },
  { opt: 'Tunnel=no' },
  { opt: 'PermitLocalCommand=no' },
  { opt: 'ControlMaster=no' },
  { opt: 'ControlPath=none' },
  { opt: 'RemoteCommand=none' },
  { opt: 'UpdateHostKeys=no' },
  { opt: 'ConnectTimeout=8' },
  // A dropped link shows as one within about 45 s, so the bridge exec ends.
  { opt: 'ServerAliveInterval=15' },
  { opt: 'ServerAliveCountMax=3' },
  { opt: 'SetEnv=AICC_NONE=1', since: [7, 8] },
  { opt: 'StdinNull=no', since: [8, 7] },
  { opt: 'SessionType=default', since: [8, 7] },
  { opt: 'ForkAfterAuthentication=no', since: [8, 7] },
  { opt: 'EnableEscapeCommandline=no', since: [9, 2] },
]

export interface ExecArgvOptions {
  /** The local ssh's version (`ssh -V`); null leaves every versioned option out. */
  version: [number, number] | null
  /** The machine's first connection (Add): a host key not known yet is
   *  accepted and kept, as a plain SSH tab does; every later exec takes only
   *  the key known then. */
  firstConnection?: boolean
}

/**
 * ssh's arguments for one exec of `command` on `target`. Throws when the
 * target breaks its patterns, before anything starts.
 */
export function execArgv(target: SshTarget, opts: ExecArgvOptions, command: string): string[] {
  const problem = targetProblem(target)
  if (problem) throw new Error(`The machine cannot be reached through the session helper: ${problem}.`)
  const args = ['-a', '-x', '-T', '-e', 'none']
  for (const f of FIXED) if (!f.since || atLeast(opts.version, f.since[0], f.since[1])) args.push('-o', f.opt)
  args.push('-o', `StrictHostKeyChecking=${opts.firstConnection ? 'accept-new' : 'yes'}`)
  args.push('-p', String(target.port), '-l', target.user, '--', target.host, command)
  return args
}

/** The variables an ssh the app starts may see (section 2): this list, never
 *  the app's own environment. The Windows ones let ssh.exe find the user's
 *  profile (its ~/.ssh) and its own files. */
const ENV_ALLOW = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'SSH_AUTH_SOCK', 'KRB5CCNAME',
  'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'ALLUSERSPROFILE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
  'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
]

export function sshEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && ENV_ALLOW.includes(k.toUpperCase())) out[k] = v
  }
  return out
}

/** A new nonce for one exec: 32 lower-case hex. */
export const newNonce = (): string => randomBytes(16).toString('hex')

/** What one exec gave back. */
export interface ExecResult {
  /** ssh's exit status (the remote command's, once it ran), or null when it
   *  was ended by a signal or never started. */
  code: number | null
  /** The signal that ended ssh on this computer (POSIX), when one did. */
  signal?: string
  stdout: string
  /** At most 64 KiB of it (section 12), for the log. */
  stderr: string
  /** It ran past its time and was ended. */
  timedOut: boolean
  /** ssh never started on this computer: no ssh was found, or it failed
   *  before it had a process id. Set by the app alone, never read from
   *  anything ssh or the host printed. */
  notStarted?: true
}

/** sshFailure's words for an ssh that never started on this computer. A
 *  remote action never reads PATH again, so a change to it takes a restart. */
export const SSH_NOT_STARTED = 'ssh could not be started on this computer (is OpenSSH installed, and is its folder on PATH as a full path? Restart the app after a change to PATH)'

/** The log line for an ssh that never started: the error its start got and
 *  nothing else (no environment, no command line), on one line, bounded. It
 *  tells a blocked ssh.exe from a missing one. */
export function notStartedLogLine(host: string, error: string): string {
  return `[remote-helper] ${host}: ssh could not be started on this computer: ${error.replace(/\s+/g, ' ').trim().slice(0, 300)}`
}

/** The most standard output a one-shot exec keeps; more ends it. */
export const EXEC_STDOUT_MAX = 2 * 1024 * 1024
/** Standard error kept for the log (section 12). */
export const STDERR_MAX = 64 * 1024
/** What rc files may print before the first marked line (section 6). */
export const PREAMBLE_MAX = 64 * 1024
/** A one-shot exec, from ssh's start (section 10). */
export const EXEC_TIMEOUT_MS = 60_000

export type SpawnFn = (file: string, args: readonly string[], opts: SpawnOptions) => ChildProcess

/** How the remote module starts ssh: tests hand fakes. */
export interface SshRunner {
  /** ssh's absolute path (Windows: the system OpenSSH, found as a plain SSH tab finds it). */
  sshPath(): string
  /** `ssh -V`'s version: kept once read; null (no ssh, or no version read)
   *  is asked again at the next call. */
  version(): Promise<[number, number] | null>
  spawn: SpawnFn
  env(): Record<string, string>
}

/** The runner of the real ssh. */
export function nodeSshRunner(sshPath: () => string, env: () => NodeJS.ProcessEnv = () => process.env): SshRunner {
  let version: Promise<[number, number] | null> | null = null
  return {
    sshPath,
    version: () => {
      if (version) return version
      // sshPath() throws when no ssh is found (sshProgram), and an `ssh -V`
      // that fails after it started (a kept path gone, its time out) reads no
      // version. Either reads as unknown and is not kept, so the next call
      // reads again (an ssh installed later is found), and an exec meets its
      // own failure at its spawn. A version read is kept for the run.
      let settle: (v: [number, number] | null) => void = () => {}
      const read = new Promise<[number, number] | null>((resolve) => { settle = resolve })
      try {
        execFile(sshPath(), ['-V'], { windowsHide: true, timeout: 10_000, env: sshEnv(env()) }, (_err, stdout, stderr) => {
          settle(parseSshVersion(`${stderr ?? ''}${stdout ?? ''}`))
        })
      } catch {
        return Promise.resolve(null)
      }
      version = read
      void read.then((v) => { if (v === null && version === read) version = null })
      return version
    },
    spawn: (file, args, opts) => nodeSpawn(file, args, opts),
    env: () => sshEnv(env()),
  }
}

/** Why an exec's ssh failed, in plain words; null when ssh itself did not fail. */
export function sshFailure(r: Pick<ExecResult, 'code' | 'stderr' | 'timedOut' | 'notStarted'>): string | null {
  if (r.notStarted) return SSH_NOT_STARTED
  if (r.timedOut) return 'the machine did not answer in time'
  if (r.code !== 255) return null
  const t = r.stderr
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(t)) return 'its host key is not the one known for it (or not known yet): connect to it once with a plain SSH tab, then try again'
  if (/Permission denied/i.test(t)) return 'it did not take a key sign-in (the session helper types no password or passphrase: a key with a passphrase works only through the ssh agent)'
  if (/Could not resolve|Name or service not known|No such host is known/i.test(t)) return 'its host name was not found'
  if (/Connection refused/i.test(t)) return 'it refused the connection'
  if (/timed out|No route to host|Network is unreachable/i.test(t)) return 'it did not answer'
  return 'ssh could not connect to it'
}

/**
 * How ssh ended on this computer, when its exit is not a remote command's: a
 * signal (POSIX), or an exit status no remote command gives (outside 0 to
 * 255; Windows' -1, from a process ended by force, reads 4294967295 unsigned
 * and is printed signed). Null for a remote command's exit (0 to 255), or none.
 * 2.1.3-beta.18 fix round, item 3: such an end was told as the session
 * helper's on the machine.
 */
export function localSshEnd(r: Pick<ExecResult, 'code' | 'signal'>): string | null {
  if (r.signal) return `ssh ended by ${r.signal}`
  if (r.code === null) return null
  const signed = r.code > 0x7fffffff ? r.code - 0x100000000 : r.code
  return signed >= 0 && signed <= 255 ? null : `ssh exit ${signed}`
}

/** An exec's exit for a message: how ssh ended on this computer
 *  (localSshEnd), or the remote command's exit status. */
export function exitText(r: Pick<ExecResult, 'code' | 'signal'>): string {
  return localSshEnd(r) ?? `exit ${r.code ?? 'unknown'}`
}

/** An authentication or host key failure: never tried again by itself (section 11). */
export function isFinalSshFailure(r: Pick<ExecResult, 'code' | 'stderr'>): boolean {
  return r.code === 255 && /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Permission denied/i.test(r.stderr)
}

/**
 * Run one fixed script on `target` and collect what it prints. Never throws
 * for a failed ssh: the result says how it ended. `stdin`, when given, is
 * written whole and then closed; otherwise standard input closes at once.
 */
export async function runScript(
  runner: SshRunner,
  target: SshTarget,
  script: ScriptName,
  values: readonly string[],
  opts: { firstConnection?: boolean; stdin?: Buffer; timeoutMs?: number; stdoutMax?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  // A host read's exec prints its files as hex (2.1.3-beta.18 section 3.2), so it may keep more.
  const stdoutMax = opts.stdoutMax ?? EXEC_STDOUT_MAX
  const command = scriptCommand(script, values)
  const args = execArgv(target, { version: await runner.version(), firstConnection: opts.firstConnection }, command)
  return new Promise<ExecResult>((resolve) => {
    let child: ChildProcess
    try {
      child = runner.spawn(runner.sshPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: runner.env() })
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: (err as Error).message.slice(0, STDERR_MAX), timedOut: false, notStarted: true })
      return
    }
    const out: Buffer[] = []
    let outBytes = 0
    let err = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => { timedOut = true; try { child.kill() } catch { /* gone */ } }, opts.timeoutMs ?? EXEC_TIMEOUT_MS)
    timer.unref?.()
    // 2.1.3-beta.21: a stop (a review's cancel) ends ssh, so the exec closes
    // on the host and what it started there is ended (the run mode, run.rs).
    const stop = () => { try { child.kill() } catch { /* gone */ } }
    if (opts.signal?.aborted) stop()
    else opts.signal?.addEventListener('abort', stop, { once: true })
    child.stdout?.on('data', (c: Buffer) => {
      outBytes += c.length
      if (outBytes > stdoutMax) { try { child.kill() } catch { /* gone */ } return }
      out.push(c)
    })
    child.stderr?.on('data', (c: Buffer) => { if (err.length < STDERR_MAX) err += c.toString('utf8').slice(0, STDERR_MAX - err.length) })
    const done = (code: number | null, notStarted = false, signal?: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', stop)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: err, timedOut, ...(signal ? { signal } : {}), ...(notStarted ? { notStarted: true as const } : {}) })
    }
    // A spawn that failed (no process id) never started ssh.
    child.on('error', (e) => { err += e.message; done(null, child.pid === undefined) })
    child.on('close', (code, signal) => done(typeof code === 'number' ? code : null, false, signal))
    child.stdin?.on('error', () => { /* ssh ended first: its exit says why */ })
    if (opts.stdin) child.stdin?.end(opts.stdin)
    else child.stdin?.end()
  })
}

/** The marked lines of one exec: `<marker> <nonce> <rest>`, in order. Only
 *  lines carrying `nonce` count; a first one that starts later than
 *  PREAMBLE_MAX bytes into the output does not count either. */
export function markedLines(stdout: string, marker: 'AICC-RESULT' | 'AICC-HASH', nonce: string): string[] {
  const prefix = `${marker} ${nonce} `
  const lines = stdout.split(/\r?\n/)
  const out: string[] = []
  let at = 0
  let first = true
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      if (first && Buffer.byteLength(stdout.slice(0, at), 'utf8') > PREAMBLE_MAX) return []
      first = false
      out.push(line.slice(prefix.length))
    }
    at += line.length + 1
  }
  return out
}

/** A fixed script's result: its `key value` lines, and how it ended
 *  (`end ok`, or `end refused <reason>`). */
export interface ScriptResult {
  values: Map<string, string>
  ok: boolean
  refused: string | null
}

export function readScriptResult(stdout: string, nonce: string): ScriptResult | null {
  const values = new Map<string, string>()
  let end: string | null = null
  for (const line of markedLines(stdout, 'AICC-RESULT', nonce)) {
    const space = line.indexOf(' ')
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? '' : line.slice(space + 1)
    if (key === 'end') { end = value; break }
    if (!values.has(key)) values.set(key, value)
  }
  if (end === null) return null
  const ok = end === 'ok'
  const refused = ok ? null : (/^refused ([a-z-]{1,40})$/.exec(end)?.[1] ?? 'unknown')
  return { values, ok, refused }
}

/** The launcher's hash line (section 13): its state and hex, or null when
 *  there is none for this nonce. Only the first counts. */
export function readHashLine(stdout: string, nonce: string): { state: string; hex: string } | null {
  const line = markedLines(stdout, 'AICC-HASH', nonce)[0]
  if (line === undefined) return null
  const [state, hex = ''] = line.split(' ')
  return { state, hex }
}

/** What the launcher printed after its hash line: the helper's own output. */
export function afterHashLine(stdout: string, nonce: string): string {
  const prefix = `AICC-HASH ${nonce} `
  const at = stdout.indexOf(prefix)
  if (at < 0) return ''
  const nl = stdout.indexOf('\n', at)
  return nl < 0 ? '' : stdout.slice(nl + 1)
}

/** How long ssh has to exit by itself once the host's side has ended, before
 *  a destroyed ExecStream ends it. */
export const EXIT_AFTER_OUTPUT_MS = 2_000

/**
 * A stream over one long exec's pipes (the bridge, plan section A2): what the
 * host prints before the launcher's `AICC-HASH <nonce> ok` line (rc files) is
 * dropped, up to PREAMBLE_MAX bytes, and the bytes after that line are the
 * holder's own (its hello line first, then section 15's frames). Writing goes
 * to ssh's standard input; ending it ends that input; destroying it ends ssh,
 * but once the host's side has ended only after EXIT_AFTER_OUTPUT_MS: ssh
 * closes its output when the host's side ends and exits with the host's
 * status a moment later, and that status says what the host said (a
 * bridge's 3: no holder for the session). The stream ends itself at that
 * output's end, and used to end ssh with it before its exit, so a re-attach
 * that found no holder read as a link not back yet (2.1.3-beta.19 section
 * 1.2, the Rocky host line's finding 1).
 */
export class ExecStream extends Duplex {
  private passed = false
  private head = Buffer.alloc(0)
  private ended = false

  constructor(private readonly child: ChildProcess, private readonly nonce: string, private readonly onHashLine: (state: string, hex: string) => void) {
    // Not half open: once the host's side has ended and been read, the stream
    // ends and closes, as a socket does, so a reader waiting on 'close' (the
    // hello) hears it.
    super({ allowHalfOpen: false })
    child.stdout?.on('data', (c: Buffer) => this.fromHost(c))
    child.stdout?.on('end', () => this.hostEnded())
    child.on('close', () => this.hostEnded())
    child.on('error', (e) => this.destroy(e))
    child.stdin?.on('error', () => { /* ssh ended first */ })
  }

  private fromHost(c: Buffer): void {
    if (this.passed) { if (!this.push(c)) this.child.stdout?.pause(); return }
    this.head = Buffer.concat([this.head, c])
    const marker = Buffer.from(`AICC-HASH ${this.nonce} `)
    for (;;) {
      const nl = this.head.indexOf(0x0a)
      if (nl < 0) break
      const line = this.head.subarray(0, nl)
      this.head = this.head.subarray(nl + 1)
      if (line.subarray(0, marker.length).equals(marker)) {
        const [state, hex = ''] = line.subarray(marker.length).toString('utf8').replace(/\r$/, '').split(' ')
        this.onHashLine(state, hex)
        if (state !== 'ok') { this.destroy(new Error(`the helper file on the machine did not pass its hash check (${state})`)); return }
        this.passed = true
        const rest = this.head
        this.head = Buffer.alloc(0)
        if (rest.length > 0) this.push(rest)
        return
      }
    }
    if (this.head.length > PREAMBLE_MAX) this.destroy(new Error('the machine printed more than 64 KiB before the session helper answered'))
  }

  private hostEnded(): void {
    if (this.ended) return
    this.ended = true
    this.push(null)
  }

  get started(): boolean { return this.passed }

  override _read(): void { this.child.stdout?.resume() }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    const stdin = this.child.stdin
    if (!stdin || stdin.destroyed) { cb(new Error('the connection to the machine has ended')); return }
    stdin.write(chunk, (e) => cb(e ?? null))
  }

  override _final(cb: (e?: Error | null) => void): void {
    try { this.child.stdin?.end() } catch { /* gone */ }
    cb()
  }

  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    try { this.child.stdin?.destroy() } catch { /* gone */ }
    const child = this.child
    const running = () => child.exitCode === null && child.signalCode === null
    const end = () => { try { if (running()) child.kill() } catch { /* gone */ } }
    if (this.ended && running()) {
      const timer = setTimeout(end, EXIT_AFTER_OUTPUT_MS)
      timer.unref?.()
      child.once('close', () => clearTimeout(timer))
    } else {
      end()
    }
    cb(err)
  }
}

/**
 * Start one long exec of `script` and answer its stream once the launcher's
 * hash line said `ok` (ExecStream). Rejects, with ssh ended, when ssh fails,
 * the hash line says anything else, or nothing comes within `timeoutMs`. The
 * error carries `final`, and, when ssh never started, `startError`: the error
 * its start got, for the caller's log (notStartedLogLine).
 */
export async function openScriptStream(
  runner: SshRunner,
  target: SshTarget,
  script: ScriptName,
  values: readonly string[],
  nonce: string,
  timeoutMs: number,
): Promise<{ stream: ExecStream; pid: number | undefined; result: Promise<ExecResult> }> {
  const command = scriptCommand(script, values)
  const args = execArgv(target, { version: await runner.version() }, command)
  let child: ChildProcess
  try {
    child = runner.spawn(runner.sshPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: runner.env() })
  } catch (e) {
    // No ssh found, or none that could be spawned: nothing started.
    throw Object.assign(new Error(SSH_NOT_STARTED), { final: false, startError: e instanceof Error ? e.message : String(e) })
  }
  let err = ''
  child.stderr?.on('data', (c: Buffer) => { if (err.length < STDERR_MAX) err += c.toString('utf8').slice(0, STDERR_MAX - err.length) })
  const result = new Promise<ExecResult>((resolve) => {
    let done = false
    const settle = (code: number | null, notStarted = false, signal?: string | null) => {
      if (!done) { done = true; resolve({ code, stdout: '', stderr: err, timedOut: false, ...(signal ? { signal } : {}), ...(notStarted ? { notStarted: true as const } : {}) }) }
    }
    child.on('close', (code, signal) => settle(typeof code === 'number' ? code : null, false, signal))
    // A spawn that failed (no process id) never started ssh.
    child.on('error', (e) => { err += e.message; settle(null, child.pid === undefined) })
  })
  return new Promise((resolve, reject) => {
    let settled = false
    const stream = new ExecStream(child, nonce, (state) => {
      if (settled || state !== 'ok') return
      settled = true
      clearTimeout(timer)
      resolve({ stream, pid: child.pid, result })
    })
    // `final`: no new try will mend it (a sign-in or host key failure, a hash
    // that is not the app's, no holder for the session): section 11.
    const fail = (why: string, final: boolean, startError?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.destroy()
      reject(Object.assign(new Error(why), { final, ...(startError === undefined ? {} : { startError }) }))
    }
    const timer = setTimeout(() => fail('the machine did not answer in time', false), timeoutMs)
    timer.unref?.()
    stream.on('error', (e) => {
      if (child.pid === undefined) fail(SSH_NOT_STARTED, false, e.message)
      else fail(e.message, /hash check/.test(e.message))
    })
    // Which side ended: ssh on this computer (killed: the link was cut), or
    // the helper's launcher on the machine (its exit status).
    const endedWords = (r: ExecResult): string => {
      if (r.code === 3) return 'no session helper holds this session on the machine'
      const local = localSshEnd(r)
      return local !== null
        ? `the ssh link on this computer ended before the session helper answered (${local})`
        : `the session helper on the machine ended before it answered (exit ${r.code ?? 'unknown'})`
    }
    void result.then((r) => fail(
      sshFailure(r) ?? endedWords(r),
      isFinalSshFailure(r) || r.code === 3 || r.code === 97,
      r.notStarted ? r.stderr : undefined,
    ))
  })
}
