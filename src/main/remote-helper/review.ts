/**
 * A review on the machine a remote session runs on (2.1.3-beta.21,
 * nubbymong/aicc_planning#446): what of it is the remote side's, with no CLI
 * named here. The review tool (conductor-mcp-server.ts registers it) decides what runs
 * and what it is sent; this file reads the change there and runs one program
 * there.
 *
 * - The change is read on the host, by review-diff.ts's rules, in the tab's
 *   working folder there (the `reviewread` fixed script: its hardened git for
 *   modes `working` and `range`, the named files inside the folder for mode
 *   `paths`, under the same bound). It comes back as data (hex on marked
 *   lines), is bounded, and is never written to disk here nor opened as a
 *   path. A folder that is the host's home folder or above it is refused
 *   there too, as registration refuses it here (./review-sessions.ts).
 * - The program runs through the helper's one-shot run mode (ADR-030
 *   protocol change 6; docs/remote/helper-protocol.md section 4;
 *   helper/src/run.rs): one `ssh -T` exec of the `run` script, the request
 *   line (its argv, its folder and its environment) and its input on
 *   standard input, its output back, then the run mode's result line, last.
 *   No shell starts it, and a stop here ends ssh, which closes the exec there,
 *   and the run mode ends the program's session.
 * - Limits (docs/remote/helper-protocol.md section 10): the host read is a
 *   one-shot exec (EXEC_TIMEOUT_MS, 60 s); the run mode's own limit is the
 *   review's timeout, and its exec gets REMOTE_RUN_EXTRA_MS (30 s) more; an
 *   MCP tool call carrying a review is allowed its timeout plus
 *   REMOTE_RELAY_EXTRA_MS (90 s), at most REMOTE_RELAY_MAX_MS (990 s), so the
 *   relay's limit stays above the run's.
 *
 * Nothing here falls back to this computer: a review the host cannot run is
 * refused, and says why.
 *
 * This file imports nothing of Electron.
 */
import * as path from 'path'
import { REVIEW_DIFF_MAX_BYTES, REVIEW_FILE_LINE_BYTES, parseReviewRange, type ReviewFile } from '../review-diff'
import { REVIEW_READ_MAX, RUN_TIMEOUT_RE } from './scripts'
import { EXEC_TIMEOUT_MS, PREAMBLE_MAX, afterHashLine, markedLines, newNonce, notStartedLogLine, readHashLine, runScript, sshFailure, type SshRunner, type SshTarget } from './ssh-exec'
import { machineName, refusalText, type RemoteMachineRecord } from './machines'

/** The run mode's exec past the review's own timeout. */
export const REMOTE_RUN_EXTRA_MS = 30_000
/** An MCP tool call carrying a review, past the review's timeout: the
 *  host read's 60 s and the run's 30 s. */
export const REMOTE_RELAY_EXTRA_MS = EXEC_TIMEOUT_MS + REMOTE_RUN_EXTRA_MS
/** The longest a review's tool call is allowed: 900 s and 90 s. */
export const REMOTE_RELAY_MAX_MS = 990_000

/** A review's limits on a host, for its own timeout: the host read, the run's exec, and the tool call. */
export function remoteReviewLimits(timeoutMs: number): { readMs: number; runMs: number; relayMs: number } {
  return { readMs: EXEC_TIMEOUT_MS, runMs: timeoutMs + REMOTE_RUN_EXTRA_MS, relayMs: Math.min(timeoutMs + REMOTE_RELAY_EXTRA_MS, REMOTE_RELAY_MAX_MS) }
}

/** The run mode's request line, at most, its line end included (run.rs MAX_REQUEST_BYTES). */
export const RUN_REQUEST_MAX = 64 * 1024
/** The program's input (a review's prompt), at most (run.rs MAX_INPUT_BYTES):
 *  past it the run mode refuses, never cuts, so the app refuses first. */
export const RUN_INPUT_MAX = 2 * 1024 * 1024
/** What the run mode copies of the program's output, at most (run.rs MAX_OUTPUT_BYTES). */
export const RUN_OUTPUT_MAX = 4 * 1024 * 1024
/** What the run's exec keeps, at most: above the run mode's own cap, the
 *  line end it may add, what rc files print before the hash line
 *  (PREAMBLE_MAX), the hash line and the result line (section 4), not
 *  EXEC_STDOUT_MAX's 2 MiB. */
export const RUN_STDOUT_MAX = RUN_OUTPUT_MAX + 1 + PREAMBLE_MAX + 4 * 1024
/** The host read's output kept: the material as hex, and room for its lines. */
export const READ_STDOUT_MAX = 2 * REVIEW_READ_MAX + 256 * 1024

/** Where a host review's execs run. */
export interface HostReviewCtx {
  runner: SshRunner
  installId: string
  log: (message: string) => void
}

const targetOf = (m: RemoteMachineRecord): SshTarget => ({ host: m.host, port: m.port, user: m.user })

/** What a review is sent from the host: the change as a git diff, the named
 *  files, or why it could not be read. */
export type HostMaterial = { ok: true; kind: 'diff'; diff: string } | { ok: true; kind: 'files'; files: ReviewFile[] } | { ok: false; message: string }

/** The request for the host read. Paths are relative to the folder, plain
 *  names joined by `/`, as hostReviewPaths makes them. */
export interface HostReadInput {
  cwd: string
  mode: 'working' | 'range' | 'paths'
  range?: string
  paths?: readonly string[]
  signal?: AbortSignal
}

/** A name as a review request names it: no line end, no NUL. */
const PLAIN_LINE = /^[^\0\r\n]+$/

/**
 * Mode `paths`' names as the host read takes them: each one inside the folder
 * (resolved against it as a path on the host), relative, `/` separated, with
 * no `.` or `..`. A name outside it, or one that holds a line end, is refused
 * with its own words (the review tool's step 3).
 */
export function hostReviewPaths(cwd: string, paths: readonly string[]): { ok: true; paths: string[] } | { ok: false; message: string } {
  const out: string[] = []
  for (const p of paths) {
    if (!PLAIN_LINE.test(p)) return { ok: false, message: `Paths must be inside the session cwd. Rejected: ${JSON.stringify(p)}` }
    const abs = path.posix.resolve(cwd, p)
    const rel = path.posix.relative(cwd, abs)
    if (!rel || rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) return { ok: false, message: `Paths must be inside the session cwd. Rejected: ${p}` }
    out.push(rel)
  }
  return { ok: true, paths: out }
}

const hexText = (hex: string | undefined): string | null => (hex !== undefined && hex.length % 2 === 0 && /^[0-9a-f]*$/.test(hex) ? Buffer.from(hex, 'hex').toString('utf8') : null)

/** The host read's refusal, as review-diff.ts says the same on this computer. */
function readRefusal(word: string | null, m: RemoteMachineRecord, fileHex: string | undefined, why: string | null): string {
  const label = JSON.stringify(hexText(fileHex) ?? 'a file')
  switch (word) {
    case 'too-large': return `the change is larger than ${REVIEW_DIFF_MAX_BYTES / 1024} KB; review a narrower range, or name files with mode "paths"`
    case 'files-too-large': return `the files are larger than ${REVIEW_DIFF_MAX_BYTES / 1024} KB together; name fewer or smaller files`
    case 'file-link': return `${label} is a link (a symbolic link or a junction), so it is not sent`
    case 'file-through-link': return `${label} is reached through a link or a junction, so it is not sent`
    case 'file-folder': return `${label} is a folder; name files`
    case 'file-not-a-file': return `${label} is not a file; name files`
    case 'file-hard-link': return `${label} has more than one name (a hard link), so it is not sent`
    case 'file-not-found': return `${label} was not found`
    case 'file-changed': return `${label} changed while it was being read`
    case 'file-outside': return `${label} is outside the project`
    case 'bad-range': return 'the range must be two revisions joined by ".." or "..." (for example HEAD~1..HEAD): no spaces, no leading "-", no ":"'
    case 'bad-object-format': return 'the repository\'s object format is not one this app reads'
    case 'bad-head': return 'HEAD could not be read'
    case 'head-not-a-commit': return 'HEAD is not a commit'
    case 'bad-filter': return 'your git configuration there names a filter driver this app does not pass to git'
    case 'cannot-prepare': return 'the change could not be prepared'
    case 'no-git': return `git was not found on ${machineName(m)}`
    case 'git-failed': return why ? (why.length > 200 ? `${why.slice(0, 200)} [...]` : why) : 'git failed'
    case 'no-project-folder': return `the session's folder is not there on ${machineName(m)}`
    case 'project-is-home': return `the session's folder on ${machineName(m)} is its home folder or a folder above it; set a real project folder in the session config`
    default: return refusalText(word)
  }
}

/**
 * Read a review's material on the host (the `reviewread` script). Never
 * throws: a host that cannot be reached, or a read it refuses, answers why.
 * The bound is the same as on this computer: for mode `paths` each name as
 * the request gave it, each file's line and each file's text together
 * (review-diff.ts produceReviewFiles), checked again here on what came back.
 */
export async function readHostReviewMaterial(ctx: HostReviewCtx, m: RemoteMachineRecord, input: HostReadInput): Promise<HostMaterial> {
  const lines = [input.cwd, input.mode]
  if (input.mode === 'range') {
    // The range as this computer reads it (review-diff.ts parseReviewRange),
    // so the host's git is given only what a review here would give its own.
    const range = parseReviewRange(input.range ?? '')
    if (!range) return { ok: false, message: readRefusal('bad-range', m, undefined, null) }
    lines.push(`${range.from}${range.op}${range.to}`)
  }
  if (input.mode === 'paths') lines.push(...(input.paths ?? []))
  if (!lines.every((l) => PLAIN_LINE.test(l))) return { ok: false, message: 'the request holds a line end or a NUL, so it was not sent' }
  const scope = (input.paths ?? []).reduce((n, p) => n + Buffer.byteLength(p) + 2, 0)
  if (input.mode === 'paths' && scope > REVIEW_DIFF_MAX_BYTES) return { ok: false, message: readRefusal('files-too-large', m, undefined, null) }
  if (input.signal?.aborted) return { ok: false, message: 'the review was cancelled' }
  const nonce = newNonce()
  const r = await runScript(ctx.runner, targetOf(m), 'reviewread', [nonce, m.did, ctx.installId], {
    stdin: Buffer.from(`${lines.join('\n')}\n`, 'utf8'), stdoutMax: READ_STDOUT_MAX, ...(input.signal ? { signal: input.signal } : {}),
  })
  if (input.signal?.aborted) return { ok: false, message: 'the review was cancelled' }
  if (r.notStarted) ctx.log(notStartedLogLine(m.host, r.stderr))
  const failed = sshFailure(r)
  if (failed) return { ok: false, message: `${m.host} could not be reached: ${failed}` }
  const values = new Map<string, string>()
  const files: ReviewFile[] = []
  let end: string | null = null
  for (const line of markedLines(r.stdout, 'AICC-RESULT', nonce)) {
    const [key, a, b] = line.split(' ')
    if (key === 'end') { end = line.slice(4); break }
    if (key === 'file' || key === 'binary') {
      const name = hexText(a)
      const text = key === 'file' ? hexText(b ?? '') : ''
      if (name === null || text === null) return { ok: false, message: `${m.host} sent the files in a form this app does not read` }
      files.push(key === 'file' ? { path: name, text } : { path: name, binary: true })
      continue
    }
    if (!values.has(key)) values.set(key, a ?? '')
  }
  if (end === null) return { ok: false, message: `${machineName(m)} did not answer the read of the change` }
  if (end !== 'ok') {
    const word = /^refused ([a-z-]{1,40})$/.exec(end)?.[1] ?? null
    return { ok: false, message: readRefusal(word, m, values.get('path'), hexText(values.get('why'))) }
  }
  if (input.mode !== 'paths') {
    const diff = hexText(values.get('diff') ?? '')
    if (diff === null) return { ok: false, message: `${m.host} sent the change in a form this app does not read` }
    if (Buffer.byteLength(diff) > REVIEW_DIFF_MAX_BYTES) return { ok: false, message: readRefusal('too-large', m, undefined, null) }
    return { ok: true, kind: 'diff', diff }
  }
  // The bound, as review-diff.ts counts it, over what came back.
  let total = scope
  for (const f of files) {
    total += Buffer.byteLength(JSON.stringify(f.path)) + REVIEW_FILE_LINE_BYTES
    if ('text' in f) total += Buffer.byteLength(f.text)
  }
  if (total > REVIEW_DIFF_MAX_BYTES) return { ok: false, message: readRefusal('files-too-large', m, undefined, null) }
  return { ok: true, kind: 'files', files }
}

/** What the run mode starts: its argv (argv[0] an absolute path on the host),
 *  its folder there and its whole environment. */
export interface HostRunSpec {
  argv: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
}

/** How the program's run ended, as the run mode's result line says it
 *  (docs/remote/helper-protocol.md section 4). */
export interface RunOutcome {
  /** Its exit code; null when a signal ended it, or it was not reaped. */
  code: number | null
  /** The signal that ended it; null when it exited by itself. */
  signal: number | null
  /** The review's own timeout passed there (`--timeout`), and its session was ended. */
  timeout: boolean
  /** It printed more than RUN_OUTPUT_MAX, and its session was ended. */
  cut: boolean
}

/** How one run on the host ended. */
export interface HostRunResult {
  /** The run mode's result line: the program ran there, and this is how it
   *  ended. Null when no result line came (`failure`, `timedOut`, `cancelled`). */
  outcome: RunOutcome | null
  /** What the program printed on its standard output: everything between
   *  the launcher's hash line and the result line, as data. */
  stdout: string
  /** What the program and the run mode wrote on standard error (64 KiB at most). */
  stderr: string
  /** The exec itself ran past the review's own timeout and 30 s, and ssh was stopped. */
  timedOut: boolean
  cancelled: boolean
  /** Why no result line came: ssh failed, the helper did not pass its hash
   *  check, or the run mode started nothing (its own words). */
  failure?: string
}

const RESULT_KEYS = ['code', 'signal', 'timeout', 'cut']
const intOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v))

/**
 * The run mode's result line, read from what followed the launcher's hash
 * line: the LAST line, ended by a line end, `AICC-RESULT <nonce> <object>`
 * with this exec's nonce and exactly the object's four fields, each of its
 * type. Everything before it is the program's output. Null for anything
 * else: such an exec is failed (section 4), never read as a result.
 */
export function parseRunResult(afterHash: string, nonce: string): { outcome: RunOutcome; output: string } | null {
  if (!afterHash.endsWith('\n')) return null
  const body = afterHash.slice(0, -1)
  const at = body.lastIndexOf('\n') + 1
  const prefix = `AICC-RESULT ${nonce} `
  const last = body.slice(at)
  if (!last.startsWith(prefix)) return null
  let v: unknown
  try { v = JSON.parse(last.slice(prefix.length)) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length !== RESULT_KEYS.length || !RESULT_KEYS.every((k) => keys.includes(k))) return null
  if (!intOrNull(o.code) || !intOrNull(o.signal) || typeof o.timeout !== 'boolean' || typeof o.cut !== 'boolean') return null
  return { outcome: { code: o.code, signal: o.signal, timeout: o.timeout, cut: o.cut }, output: afterHash.slice(0, at) }
}

/** What the run mode writes first on standard error when it starts nothing (run.rs `said`). */
const RUN_SAYS = 'aicc-helper: run: '

/**
 * Run one program on the host through the helper's run mode (the `run`
 * script). `timeoutMs` is the review's own timeout, the run mode's
 * `--timeout` (whole seconds, 30 to 900); the exec gets REMOTE_RUN_EXTRA_MS
 * more (section 10). The request line and the input are checked against the
 * run mode's bounds here first, so nothing is sent that it would refuse. A
 * stop (`signal`) ends ssh, which closes the exec, and the run mode ends the
 * program's session there. Never throws.
 */
export async function runOnHost(ctx: HostReviewCtx, m: RemoteMachineRecord, spec: HostRunSpec, input: string, timeoutMs: number, signal?: AbortSignal): Promise<HostRunResult> {
  const none = (failure: string, stderr = ''): HostRunResult => ({ outcome: null, stdout: '', stderr, timedOut: false, cancelled: false, failure })
  const secs = String(Math.ceil(timeoutMs / 1000))
  if (!RUN_TIMEOUT_RE.test(secs)) return none('its timeout is not 30 to 900 seconds')
  const head = Buffer.from(`${JSON.stringify({ argv: [...spec.argv], cwd: spec.cwd, env: { ...spec.env } })}\n`, 'utf8')
  if (head.length > RUN_REQUEST_MAX) return none(`its request line is over ${RUN_REQUEST_MAX / 1024} KiB, so it was not sent`)
  const body = Buffer.from(input, 'utf8')
  if (body.length > RUN_INPUT_MAX) return none(`its input is over ${RUN_INPUT_MAX / (1024 * 1024)} MiB, so it was not sent`)
  if (signal?.aborted) return { ...none('cancelled'), cancelled: true }
  const nonce = newNonce()
  const r = await runScript(ctx.runner, targetOf(m), 'run', [nonce, m.did, ctx.installId, m.helper.folder, m.helper.sha256, secs], {
    stdin: Buffer.concat([head, body]),
    timeoutMs: timeoutMs + REMOTE_RUN_EXTRA_MS,
    stdoutMax: RUN_STDOUT_MAX,
    ...(signal ? { signal } : {}),
  })
  if (signal?.aborted) return { outcome: null, stdout: '', stderr: r.stderr, timedOut: false, cancelled: true }
  if (r.notStarted) ctx.log(notStartedLogLine(m.host, r.stderr))
  if (r.timedOut) return { outcome: null, stdout: '', stderr: r.stderr, timedOut: true, cancelled: false }
  const failed = sshFailure(r)
  if (failed) return none(`${m.host} could not be reached: ${failed}`, r.stderr)
  const hash = readHashLine(r.stdout, nonce)
  if (!hash) return none(`${machineName(m)} did not answer the session helper (is it still added? press Check on the Machines page)`, r.stderr)
  if (hash.state !== 'ok') return none(`the session helper file on ${m.host} did not pass its hash check (${hash.state}); press Check on the Machines page`, r.stderr)
  const parsed = r.code === 0 ? parseRunResult(afterHashLine(r.stdout, nonce), nonce) : null
  if (parsed) return { outcome: parsed.outcome, stdout: parsed.output, stderr: r.stderr, timedOut: false, cancelled: false }
  // No result line: the run mode started nothing (exit 1, its words on
  // standard error), or the exec ended some other way. Either way nothing is
  // read as the program's.
  const said = r.code === 1 ? r.stderr.split(/\r?\n/).find((l) => l.startsWith(RUN_SAYS)) : undefined
  if (said) return none(`the session helper started nothing there: ${said.slice(RUN_SAYS.length).slice(0, 300)}`, r.stderr)
  return none(`the session helper's run mode gave no result line (exit ${r.code ?? 'none'}), so nothing it printed is read`, r.stderr)
}
