// A codex_review on the machine a remote session runs on (2.1.3-beta.21,
// nubbymong/aicc_planning#446).
//
// A Claude Code tab through the session helper on a Linux machine asks for a
// Codex review there: the change is read on that machine, by review-diff.ts's
// rules (remote-helper/review.ts readHostReviewMaterial), and Codex runs there,
// through the helper's one-shot run mode (runOnHost), on the machine's own
// Codex sign-in (owner default Q10, until Codex accounts on machines come in
// 2.1.3-beta.22). Its argv is ADR-031's, the same constant plus the same two
// allow-listed values as on this computer (the Codex package's remote review,
// core's ProviderRemoteReview), with the machine's Codex as argv[0]; the
// allow-lists are the machine's own Codex list
// (read at its Check), applied here: the helper decides nothing (ADR-030 row
// 4). Nothing of it ever runs on this computer: a review the machine cannot
// run is refused, and says why. Until this build records a PASS of the
// probes PV1 and PV2 on a host of the machine's architecture
// (REMOTE_REVIEW_PROVEN; helper/probes/README.md), a review there is refused
// before anything is read or run.
//
// Pure of the app's settings and accounts: what it needs of them (the model
// registry, main's launch rule, the reviewing package's remote review, the
// usage record) comes in its deps, so the
// remote-helper-e2e job runs it under plain Node
// (tests/live/remote-helper-device.live.ts). codex-review-mcp-tool.ts
// registers it as the tool and hands it the running app's.
import { randomBytes } from 'crypto'
import type { ProviderRemoteReview, ReviewUsage } from './providers/core'
import type { ProviderId, ProviderLaunchRefusal } from '../shared/providers'
import { withInstalledCodexModels, type InstalledCodexModels, type ModelRegistry } from '../shared/model-registry'
import { logInfo } from './debug-logger'
import { clip, finishReview, redactFailure, redactHead, MAX_MESSAGE } from './providers/review-support'
import { machineName, type RemoteMachineRecord } from './remote-helper/machines'
import { linuxHelperRow } from './remote-helper/manifest'
import { RUN_OUTPUT_MAX, hostReviewPaths, type HostMaterial, type HostReadInput, type HostRunResult, type HostRunSpec } from './remote-helper/review'
import type { RemoteReviewTarget } from './remote-helper/review-sessions'
import {
  MAX_REVIEWS_PER_SESSION, REVIEW_TIMEOUT_MS, TIMEOUT_SECONDS_MAX, buildCodexPrompt, chooseCodexReview, codexRanOn, formatTimeoutForMessage, reviewArgsSchema, reviewsInFlight,
  type ReviewMaterial, type ReviewPick, type ReviewPickResult, type ReviewToolResult,
} from './review-request'

/** The machine side of a review there: its record, the read of the change
 *  there, one run there, and the environment a program there starts with.
 *  The remote machines' wiring hands the running app's
 *  (ipc/remote-machines-handlers.ts); tests hand fakes. */
export interface RemoteReviewHost {
  /** The machine's record now; null when it is no longer on the list. */
  machine: (did: string) => RemoteMachineRecord | null
  /** The change, read on the machine (remote-helper/review.ts readHostReviewMaterial). */
  read: (m: RemoteMachineRecord, input: HostReadInput) => Promise<HostMaterial>
  /** One program run on the machine (remote-helper/review.ts runOnHost). */
  run: (m: RemoteMachineRecord, spec: HostRunSpec, input: string, timeoutMs: number, signal?: AbortSignal) => Promise<HostRunResult>
  /** The environment a program on the machine starts with (remote-helper/session.ts hostRunEnv). */
  env: (m: RemoteMachineRecord) => Record<string, string>
}

/** What a review on a machine goes through: the machine side, and what of the
 *  app it needs (codex-review-mcp-tool.ts gives the running app's). */
export interface RemoteReviewDeps extends RemoteReviewHost {
  /** The model registry the allow-lists start from. */
  registry: () => ModelRegistry
  /** Main's one launch rule (provider-launch-gate.ts). */
  launchRefusal: (providerId: ProviderId) => ProviderLaunchRefusal | null
  /** The reviewing package's review on another machine (its argv, how its
   *  output and version read); undefined: it has none. */
  reviewer: () => ProviderRemoteReview | undefined
  /** After the run, whatever the outcome (a failed turn still used quota). */
  onUsage?: (sessionId: string, usage: ReviewUsage) => void
  /** A finished review, for channel routing. Best-effort. */
  onReview?: (sessionId: string, review: string) => void
  /** The probes' record by architecture; unset: this build's own
   *  (REMOTE_REVIEW_PROVEN), as the running app always has it. Tests give one. */
  proven?: RemoteReviewProof
}

/** A PASS of the probes PV1 and PV2 on one host: the Codex and git versions
 *  they passed with (a record of that run; a review matches neither). */
export type RemoteReviewProofEntry = Readonly<{ codex: string; git: string }>
/** The probes' PASS by machine architecture (`uname -m`, the manifest row's
 *  arch); null: none recorded yet. */
export type RemoteReviewProof = Readonly<Record<string, RemoteReviewProofEntry | null>>

/**
 * Whether reviews run on machines of each architecture: a property of this
 * build, never of a file on the machine. The probes PV1 and PV2
 * (tests/live/remote-review.live.ts, helper/probes/README.md) prove a host
 * kind: Rocky for x86_64, the Pi for aarch64. While an entry is null, a
 * review on a machine of that architecture is refused with the reason, and
 * nothing runs there or on this computer. The commit that records a PASS in
 * that README sets the entry, to the versions the live file prints; from then
 * on any Codex there not older than the oldest this app runs, and any git
 * that read at its Check, run a review there.
 */
export const REMOTE_REVIEW_PROVEN: RemoteReviewProof = Object.freeze({
  x86_64: null,
  aarch64: null,
})

/** The entry for an architecture, by own keys only: a record's arch is a
 *  host's answer, never a property of Object's prototype. */
function provenFor(proof: RemoteReviewProof, arch: string): RemoteReviewProofEntry | null {
  if (!Object.prototype.hasOwnProperty.call(proof, arch)) return null
  const e = proof[arch]
  return e && typeof e === 'object' && typeof e.codex === 'string' && typeof e.git === 'string' ? e : null
}

/** Whether a registered remote tab's connection is offered codex_review: its
 *  machine's record names Codex (its last Check found it there). */
export function remoteReviewOffered(target: RemoteReviewTarget | null, host: Pick<RemoteReviewHost, 'machine'> | null): boolean {
  if (!target || !host) return false
  try { return !!host.machine(target.did)?.codex } catch { return false }
}

export const REMOTE_REVIEW_NOT_ENABLED = 'Codex review is not enabled for this session. On another machine it is available to a Claude Code tab through the session helper, with a real project folder there, while Codex is on (Settings, Accounts) and Codex review is on (Settings, General, Built-in Tools), once that machine\'s last Check found Codex there.'

const UNBOUND = 'Codex review unavailable: no Conductor session id bound to this MCP connection. Spawn the Claude session from inside AI Code Conductor.'

/** Said at the end of every refusal on a machine: nothing ran anywhere. */
const NOTHING_RAN = 'Nothing ran there or on this computer.'

/**
 * codex_review's model and effort for a review on a machine: ADR-031's
 * allow-lists against the machine's own Codex list (read at its Check), never
 * this computer's. With no list read there, a model may not be named (the
 * machine's own default runs), and the effort is one of Codex's levels.
 */
export function chooseRemoteCodexReview(args: { model?: string; effort?: string }, registry: ModelRegistry, hostModels: InstalledCodexModels | null | undefined, machine: string): ReviewPickResult {
  if (!hostModels) {
    if (args.model !== undefined) {
      return { refused: `Codex review refused: the models Codex lists on ${machine} were not read at its last Check, so a review there takes no model by name. Leave model unset for the default model of that machine's own Codex sign-in, or press Check on the Machines page.` }
    }
    return chooseCodexReview(args.effort !== undefined ? { effort: args.effort } : {}, withInstalledCodexModels(registry, null))
  }
  return chooseCodexReview(args, withInstalledCodexModels(registry, hostModels))
}

/** The footer of a review on a machine: the machine and its own sign-in, then
 *  what it ran on, as a review here says it. */
function formatRemoteFooter(usage: ReviewUsage | undefined, machine: string, ranOn: string | null): string {
  const head = `\n\n---\nCodex review on ${machine}, with ${machine}'s own Codex sign-in${ranOn === null ? '' : `, on ${ranOn}`}`
  if (!usage) return `${head} -- 1 message used. Usage data unavailable.`
  return `${head} -- 1 message used -- ${usage.inputTokens} input tokens (${usage.cachedInputTokens} cached), ${usage.outputTokens} output tokens.`
}

/** What Codex says when the machine's own sign-in is missing, expired or refused. */
const SIGNED_OUT = /\b401\b|unauthori[sz]ed|not (logged|signed) in|codex login/i

/** The last lines of what the run wrote on standard error, redacted and bounded. */
function hostErrorTail(stderr: string): string {
  const lines = redactFailure(stderr).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines.slice(-3).join(' ').slice(-MAX_MESSAGE)
}

/** codex_review for a registered remote tab: run on its machine, never here. */
export async function runRemoteCodexReview(
  rawArgs: unknown,
  target: RemoteReviewTarget | null,
  deps: RemoteReviewDeps | null,
  signal?: AbortSignal,
): Promise<ReviewToolResult> {
  const parsed = reviewArgsSchema.safeParse(rawArgs)
  if (!parsed.success) return { isError: true, text: `Invalid arguments: ${parsed.error.message}` }
  const args = parsed.data
  if (!args.cccSessionId) return { isError: true, text: UNBOUND }
  const sid: string = args.cccSessionId
  if (!target) return { isError: true, text: REMOTE_REVIEW_NOT_ENABLED }
  if (!deps) return { isError: true, text: 'Codex review unavailable: the remote machines are not ready yet. Try again in a moment.' }
  // Mode paths: every name inside the folder, as a path on the machine.
  let paths: string[] = []
  if (args.mode === 'paths') {
    const p = hostReviewPaths(target.cwd, args.paths ?? [])
    if (!p.ok) return { isError: true, text: p.message }
    paths = p.paths
  }
  // Main's one launch rule, as for a review here: a call that arrives after
  // Codex was switched off starts nothing anywhere.
  const launchRefused = deps.launchRefusal('codex')
  if (launchRefused) return { isError: true, text: `Codex review is unavailable. ${launchRefused.message}` }
  let m: RemoteMachineRecord | null
  try { m = deps.machine(target.did) } catch { m = null }
  if (!m) return { isError: true, text: `Codex review refused: the machine this session runs on is no longer on this computer's list. ${NOTHING_RAN}` }
  const name = machineName(m)
  const refused = (why: string): ReviewToolResult => ({ isError: true, text: `Codex review refused: ${why} ${NOTHING_RAN}` })
  if (!m.codex) return refused(`Codex was not found on ${name} at its last Check (not on the PATH of its login shell). Install Codex there and sign it in there, then press Check on the Machines page.`)
  let reviewer: ProviderRemoteReview | undefined
  try { reviewer = deps.reviewer() } catch { reviewer = undefined }
  if (!reviewer) return refused('the Codex package of this app cannot review on another machine.')
  const version = m.codex.version
  if (version === null) return refused(`the version of Codex on ${name} did not read at its last Check. Press Check on the Machines page.`)
  if (reviewer.tooOld(version)) return refused(`${name} has Codex ${version}, older than ${reviewer.minVersion}, the oldest version this app runs. Update Codex there, then press Check on the Machines page.`)
  // The probes PV1 and PV2 (helper/probes/README.md): a review runs on a
  // machine only once this build records their PASS on a host of its
  // architecture. Never a review on this computer in its place: that would
  // review another copy of the change.
  if (!provenFor(deps.proven ?? REMOTE_REVIEW_PROVEN, m.arch)) {
    return refused(`reviews on Linux ${linuxHelperRow(m.arch)?.name ?? m.arch} machines have not been proven yet (probes PV1 and PV2, helper/probes/README.md).`)
  }
  // A git change is read by the git there; named files need none.
  if (args.mode !== 'paths' && !m.git) {
    return refused(`git was not found on ${name} at its last Check (git --version did not read there), so the change cannot be read there. Install git there and press Check on the Machines page, or name files with mode "paths".`)
  }
  const chosen = chooseRemoteCodexReview(args, deps.registry(), m.codex.models, name)
  if ('refused' in chosen) return { isError: true, text: chosen.refused }
  const pick: ReviewPick = chosen
  // ADR-031's argv, as a review here has it: the constant and the two values.
  const argv = reviewer.args(pick.argv)
  if (!Array.isArray(argv)) return refused(`Codex could not be started with that choice (${(argv as { refused: string }).refused}).`)
  if (signal?.aborted) return { isError: true, text: 'Codex review was cancelled.' }
  const running = reviewsInFlight.get(sid) ?? new Set<AbortController>()
  if (running.size >= MAX_REVIEWS_PER_SESSION) {
    return { isError: true, text: 'Codex review: a review is already running for this session. Wait for it to finish, then try again.' }
  }
  const stop = new AbortController()
  const onCancel = () => stop.abort()
  signal?.addEventListener('abort', onCancel, { once: true })
  running.add(stop)
  reviewsInFlight.set(sid, running)
  try {
    const read = await deps.read(m, {
      cwd: target.cwd, mode: args.mode,
      ...(args.mode === 'range' && args.range !== undefined ? { range: args.range } : {}),
      ...(args.mode === 'paths' ? { paths } : {}),
      signal: stop.signal,
    })
    if (stop.signal.aborted) return { isError: true, text: 'Codex review was cancelled.' }
    if (!read.ok) return { isError: true, text: `Codex review could not read the change on ${name}: ${read.message}. ${NOTHING_RAN}` }
    let material: ReviewMaterial
    if (read.kind === 'diff') {
      if (!read.diff.trim()) {
        return { isError: false, text: args.mode === 'working' ? 'Codex review: nothing to review -- there are no uncommitted changes to tracked files.' : `Codex review: nothing to review -- the range ${args.range} has no changes.` }
      }
      material = { kind: 'diff', diff: read.diff }
    } else {
      material = { kind: 'files', files: read.files }
    }
    const timeoutMs = args.timeoutSeconds != null ? args.timeoutSeconds * 1000 : REVIEW_TIMEOUT_MS
    logInfo(`[codex-review] session ${sid}: mode ${args.mode}, on ${m.host}'s own Codex sign-in (${m.did.slice(0, 8)}), on ${codexRanOn(pick)}`)
    const prompt = buildCodexPrompt(args, material, randomBytes(8).toString('hex'))
    const r = await deps.run(m, { argv: [m.codex.path, ...argv], cwd: target.cwd, env: deps.env(m) }, prompt, timeoutMs, stop.signal)
    const out = reviewer.readOutput(r.stdout)
    // The run mode's result line says how Codex's run ended there; with none,
    // Codex is not known to have run, so the footer names no model.
    const ended = r.outcome
    const ranOn = ended ? codexRanOn(pick) : null
    logInfo(`[codex-review] session ${sid}: on ${m.host}, ${ended && ended.code === 0 && !ended.timeout && !ended.cut ? 'reviewed' : `ended (${r.cancelled ? 'cancelled' : r.timedOut || ended?.timeout ? 'timed out' : ended?.cut ? 'cut' : ended ? `code ${ended.code ?? 'none'}, signal ${ended.signal ?? 'none'}` : 'not run'})`}`)
    if (out.usage) { try { deps.onUsage?.(sid, out.usage) } catch { /* the usage record never replaces the result */ } }
    if (r.cancelled || stop.signal.aborted) return { isError: true, text: 'Codex review was cancelled.' }
    if (r.timedOut || ended?.timeout) {
      return { isError: true, text: `Codex review timed out on ${name} after ${formatTimeoutForMessage(timeoutMs)}${ranOn !== null ? ` (on ${ranOn})` : ''}. Try a smaller scope (e.g. mode: "paths") or raise timeoutSeconds (max ${TIMEOUT_SECONDS_MAX}).` }
    }
    if (!ended) return { isError: true, text: `Codex review did not run on ${name}: ${r.failure ?? 'the session helper gave no result'}.${formatRemoteFooter(undefined, name, null)}` }
    if (ended.cut) return { isError: true, text: `Codex review failed on ${name}: Codex printed more than ${RUN_OUTPUT_MAX / (1024 * 1024)} MiB, more than this app reads, so it was ended.${formatRemoteFooter(out.usage, name, ranOn)}` }
    if (ended.code !== 0) {
      const how = ended.code !== null ? `exited with code ${ended.code}` : `was ended by signal ${ended.signal ?? 'unknown'}`
      const detail = out.error !== undefined ? clip(redactHead(out.error, redactFailure)) : clip(hostErrorTail(r.stderr))
      // The machine's own sign-in (Q10): one that is missing or signed out is said so.
      const signIn = SIGNED_OUT.test(detail) ? ` Codex there may be signed out: sign it in on ${name} (codex login, in a terminal there), then try again.` : ''
      return { isError: true, text: `Codex review failed on ${name}: Codex ${how}${detail ? `: ${detail}` : ''}.${signIn}${formatRemoteFooter(out.usage, name, ranOn)}` }
    }
    if (out.text === null || !out.text.trim()) {
      const why = out.error !== undefined ? clip(redactHead(out.error, redactFailure)) : out.dropped ? 'Codex printed an event larger than this app reads, and no review after it.' : 'Codex returned no review.'
      return { isError: true, text: `Codex review failed on ${name}: ${why}${formatRemoteFooter(out.usage, name, ranOn)}` }
    }
    const review = finishReview(out.text)
    try { deps.onReview?.(sid, review) } catch { /* channels emit is best-effort */ }
    return { isError: false, text: review + formatRemoteFooter(out.usage, name, ranOn) }
  } finally {
    signal?.removeEventListener('abort', onCancel)
    running.delete(stop)
    if (running.size === 0 && reviewsInFlight.get(sid) === running) reviewsInFlight.delete(sid)
  }
}
