/**
 * What one start of a tab through the session helper reads on its host
 * (2.1.3-beta.19 section 3, aicc_planning#434), launch or attach: the host
 * files its provider names (its hostReads, as 2.1.3-beta.18 section 3.2 read
 * them, by the `reads` script) and the one field that names the account its
 * CLI is signed in as (its accountField, by the helper's field mode: the
 * `field` script). One function runs both, readHostForStart; section 1.2's
 * attach path calls it too. The contract (plan 2.1.3-beta.19, section 1.1
 * What (4)): "The provider's host reads and the field read run at every start
 * of a helper tab, launch or attach. Section 3 exposes one function for them;
 * 1.2's attach path calls it; the label and the bars' source are set again at
 * each attach."
 *
 * The two execs run side by side. A host read that fails fails the start, as
 * before. The account read never does: the account is display text only, and
 * a read that did not answer says so on the tab instead. Its answer is the
 * host's and untrusted: one line of at most 1 KiB with no control character,
 * or nothing; the app's display gate (statusline-watcher.ts
 * sanitiseRemoteAccountEmail) decides what of it is shown.
 *
 * This file imports nothing of Electron.
 */
import type { RemoteHostField, RemoteHostFile } from '../providers/types'
import type { RemoteAccountNotShown } from '../../shared/types'
import { FIELD_FILE_RE, FIELD_KEY_RE, FIELD_VALUE_MAX, HOST_READ_MAX } from './scripts'
import { EXEC_STDOUT_MAX, afterHashLine, exitText, newNonce, notStartedLogLine, readHashLine, readScriptResult, runScript, sshFailure, type SshRunner, type SshTarget } from './ssh-exec'
import { hostReadsInput, hostReadsOf } from './session-files'
import { refusalText, type RemoteMachineRecord } from './machines'
import type { RemoteLaunchPlan } from './session'

/** The account field as one start read it: the host's one string, or why
 *  there is none (its CLI names none on the host, `no-account`; the read did
 *  not answer, `not-read`). */
export type HostAccountRead = { account: string } | { notShown: RemoteAccountNotShown }

/** What one start read on the host. `account`: absent when the tab's
 *  provider names no account field. */
export interface HostStartReads {
  files: RemoteHostFile[]
  account?: HostAccountRead
}

/** Where a start's reads are made, and where the account read goes. */
export interface HostReadsContext {
  runner: SshRunner
  machine: RemoteMachineRecord
  installId: string
  log: (message: string) => void
  /** The tab's status line and header (signals.ts RemoteSignals.account):
   *  told the account read at every start that read one. */
  signals?: { account(read: HostAccountRead): void }
}

/** The most standard output a host read's exec keeps: every file at its
 *  bound as hex, and room for its lines. */
const hostReadsStdoutMax = (reads: number): number => Math.max(EXEC_STDOUT_MAX, reads * HOST_READ_MAX * 2 + 64 * 1024)

/** A control character anywhere, a line end included. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/** Why a field cannot be asked for, or null when it can. */
export function hostFieldProblem(f: RemoteHostField | null | undefined): string | null {
  if (!f || typeof f.file !== 'string' || !FIELD_FILE_RE.test(f.file)) return 'its file is not plain names under the home folder joined by /'
  if (typeof f.key !== 'string' || !FIELD_KEY_RE.test(f.key)) return 'its key is not plain names joined by .'
  return null
}

/**
 * What the field exec's helper printed after the launcher's hash line: the
 * one string (`value`), nothing (`none`), or an answer that does not read
 * (`bad`: more than one line, a control character, or over FIELD_VALUE_MAX
 * bytes). One line end after the string is the helper's own.
 */
export function fieldAnswerOf(stdout: string, nonce: string): { value: string } | { none: true } | { bad: true } {
  const text = afterHashLine(stdout, nonce).replace(/\r?\n$/, '')
  if (text === '') return { none: true }
  if (CONTROL_RE.test(text) || Buffer.byteLength(text, 'utf8') > FIELD_VALUE_MAX) return { bad: true }
  return { value: text }
}

/** The host files the launch names, read as data by the `reads` exec (2.1.3-beta.18 section 3.2). Throws, saying why, as a start that fails. */
async function readHostFiles(ctx: HostReadsContext, target: SshTarget, plan: RemoteLaunchPlan, sid: string): Promise<RemoteHostFile[]> {
  const host = ctx.machine.host
  if (plan.reads.length === 0) return []
  let stdin: Buffer
  try {
    stdin = hostReadsInput(plan.options.cwd, plan.reads)
  } catch (err) {
    throw new Error(`the session's settings files on ${host} cannot be read: ${(err as Error).message}`)
  }
  const nonce = newNonce()
  const r = await runScript(ctx.runner, target, 'reads', [nonce, ctx.machine.did, ctx.installId], { stdin, stdoutMax: hostReadsStdoutMax(plan.reads.length) })
  if (r.notStarted) ctx.log(notStartedLogLine(host, r.stderr))
  const failed = sshFailure(r)
  if (failed) throw new Error(`${host} could not be reached: ${failed}`)
  const result = readScriptResult(r.stdout, nonce)
  if (!result) throw new Error(`${host} did not answer the session helper's read of the session's settings files`)
  if (!result.ok) throw new Error(`the session's settings files on ${host} were not read: ${refusalText(result.refused)}; press Check on the Machines page`)
  const answer = hostReadsOf(result, plan.reads)
  for (const s of answer.skipped) ctx.log(`[remote-helper] ${sid}: ${s.read.from} ${s.read.path} on ${host} was not read (${s.why}), so nothing it sets is in the session's settings`)
  return answer.files
}

/** The account field, through the helper's field mode (the `field` exec). Never throws: a read that did not answer is `not-read`, with one log line. */
async function readAccountField(ctx: HostReadsContext, target: SshTarget, field: RemoteHostField, sid: string): Promise<HostAccountRead> {
  const m = ctx.machine
  const notRead = (why: string): HostAccountRead => {
    ctx.log(`[remote-helper] ${sid}: the account on ${m.host} was not read (${why}), so the tab names none`)
    return { notShown: 'not-read' }
  }
  const problem = hostFieldProblem(field)
  if (problem) return notRead(`its provider's account field cannot be asked for: ${problem}`)
  try {
    const nonce = newNonce()
    const r = await runScript(ctx.runner, target, 'field', [nonce, m.did, ctx.installId, m.helper.folder, m.helper.sha256, field.file, field.key])
    if (r.notStarted) ctx.log(notStartedLogLine(m.host, r.stderr))
    const failed = sshFailure(r)
    if (failed) return notRead(`${m.host} could not be reached: ${failed}`)
    const hash = readHashLine(r.stdout, nonce)
    if (!hash) return notRead('the session helper did not answer')
    if (hash.state !== 'ok') return notRead(`the session helper file did not pass its hash check (${hash.state})`)
    // The field mode exits 0 with its answer; any other exit (2: a helper with no field mode) is no answer.
    if (r.code !== 0) return notRead(`the session helper's field read exited ${exitText(r)}`)
    const answer = fieldAnswerOf(r.stdout, nonce)
    if ('bad' in answer) return notRead('its answer does not read')
    if ('none' in answer) return { notShown: 'no-account' }
    return { account: answer.value }
  } catch (err) {
    return notRead((err as Error).message)
  }
}

/**
 * One start's reads on the host, launch or attach: the provider's host files
 * (plan.reads) and its account field, side by side. Throws, saying why, when
 * the host files could not be read (the start fails, as before). The account
 * read goes to `ctx.signals` once both are in, so the tab's label and the
 * source of its weekly bars are set again at every start.
 */
export async function readHostForStart(ctx: HostReadsContext, plan: RemoteLaunchPlan, sid: string): Promise<HostStartReads> {
  const target: SshTarget = { host: ctx.machine.host, port: ctx.machine.port, user: ctx.machine.user }
  let field: RemoteHostField | null = null
  try {
    field = plan.via.accountField?.(plan.options, ctx.machine) ?? null
  } catch (err) {
    ctx.log(`[remote-helper] ${sid}: its provider's account field could not be asked for (${(err as Error).message})`)
    field = null
  }
  const files = readHostFiles(ctx, target, plan, sid)
  const account = field ? readAccountField(ctx, target, field, sid) : Promise.resolve(undefined)
  // Both settle before either is used, so a failed host read leaves no exec running behind the start.
  const [filesDone, accountRead] = await Promise.all([files.then((f) => ({ ok: true as const, f }), (err: unknown) => ({ ok: false as const, err })), account])
  if (!filesDone.ok) throw filesDone.err
  if (accountRead) {
    try { ctx.signals?.account(accountRead) } catch { /* the app's own */ }
  }
  return accountRead ? { files: filesDone.f, account: accountRead } : { files: filesDone.f }
}
