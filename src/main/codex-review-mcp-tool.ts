// The provider-review MCP tools (plan: provider review through MCP): each
// session is offered only the OTHER provider's reviewer -- `codex_review` to
// a Claude session (WP2 commit 5a), `claude_review` to a Codex session (commit
// 5b). Both share every session check, the one-review-per-session registry
// and cancel on session end; what differs is the reviewing provider and what
// it is sent. Neither reviewer has a shell, so the main process produces the
// change with a hardened git and sends it in the prompt (owner decision 2):
// the Claude reviewer can also read files in the project, and the Codex
// reviewer can run no command and read no file, so for mode `paths` it is
// sent the named files' content as well.
import { existsSync } from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { isHomeOrAncestor } from './path-utils'
import { tryGetProviderPackage } from './providers/core'
import type { AccountsService, ProviderReviewOperations, ReviewUsage, ReviewRunResult } from './providers/core'
import { getAccountsService } from './provider-accounts'
import { providerLaunchRefusal } from './provider-launch-gate'
import type { ProviderId, ProviderLaunchRefusal } from '../shared/providers'
import { recordReview } from './codex-review-usage'
import { logInfo } from './debug-logger'
import { emitCodexReviewComplete } from './channel-emitters'
import { produceReviewDiff, produceReviewFiles } from './review-diff'
import type { ReviewDiffResult, ReviewFilesResult } from './review-diff'
import { withInstalledCodexModels } from '../shared/model-registry'
import type { ModelRegistry } from '../shared/model-registry'
import { getRegistry } from './model-registry-service'
import { machineName, type RemoteMachineRecord } from './remote-helper/machines'
import type { RemoteReviewTarget } from './remote-helper/review-sessions'
import {
  REVIEW_TIMEOUT_MS, TIMEOUT_SECONDS_MIN, TIMEOUT_SECONDS_MAX, formatTimeoutForMessage, reviewArgsSchema, buildClaudePrompt, buildCodexPrompt, chooseCodexReview, chooseClaudeReview, claudeReviewEnvironment, codexRanOn, claudeRanOn, codexReviewChoiceText, claudeReviewChoiceText, MAX_REVIEWS_PER_SESSION, reviewsInFlight, type ReviewArgs, type ReviewToolResult, type ReviewMaterial, type ReviewPick, type ReviewPickResult,
} from './review-request'
import { REMOTE_REVIEW_NOT_ENABLED, remoteReviewOffered, runRemoteCodexReview, type RemoteReviewDeps, type RemoteReviewHost } from './codex-review-remote'

/** `ranOn` null: the reviewer never started, so the footer names no model. */
function formatFooter(usage: ReviewUsage | undefined, name: string, ranOn: string | null): string {
  const head = ranOn === null ? `\n\n---\n${name} review` : `\n\n---\n${name} review on ${ranOn}`
  if (!usage) return `${head} -- 1 message used. Usage data unavailable.`
  return `${head} -- 1 message used -- ${usage.inputTokens} input tokens (${usage.cachedInputTokens} cached), ${usage.outputTokens} output tokens.`
}

/** A refused Codex review launch, said so the user can act on it. */
function refusalText(code: string, message: string): string {
  switch (code) {
    case 'acknowledgement-required':
      return 'Codex review needs a Codex account this app has verified. The only Codex sign-in available is one that each use must confirm (for example your existing ~/.codex sign-in). Add a Codex account in Accounts, or make one the Codex reviewer default, then try again.'
    case 'not-found':
      return 'Codex review needs a Codex account: add one in Accounts, then try again.'
    case 'provider-disabled':
      return 'Codex review is unavailable: Codex is turned off in Settings.'
    case 'provider-not-set-up':
      // Main's sentence: the user has not said they use Codex, and where to set it up.
      return `Codex review is unavailable: ${message}`
    default:
      return `Codex review unavailable: ${message}`
  }
}

/** A refused Claude review launch, said so the user can act on it. */
function claudeRefusalText(code: string, message: string): string {
  switch (code) {
    case 'acknowledgement-required':
      return 'Claude review needs a Claude account this app can use without a per-launch confirmation. Make a signed-in Claude account the Claude reviewer default in Accounts, then try again.'
    case 'not-found':
      return 'Claude review needs a Claude account: add one in Accounts, then try again.'
    case 'provider-disabled':
      return 'Claude review is unavailable: Claude is turned off in Settings.'
    default:
      return `Claude review unavailable: ${message}`
  }
}

/** What a review launch goes through: the accounts service (the binding and
 *  the review lease), the reviewing provider's adapter and, for a reviewer
 *  that cannot run git itself, the diff (and, for one that cannot read files
 *  either, the named files). Injected for the tests; production reads the
 *  running app's. */
export interface ReviewToolDeps {
  accounts: () => Pick<AccountsService, 'prepareLaunch'> | null
  reviewer: () => ProviderReviewOperations | undefined
  diff?: (input: { cwd: string; mode: 'working' | 'range'; range?: string; signal?: AbortSignal }) => Promise<ReviewDiffResult>
  files?: (input: { cwd: string; paths: readonly string[]; signal?: AbortSignal }) => Promise<ReviewFilesResult>
  /** Main's one launch rule (provider-launch-gate.ts), asked when a review
   *  RUNS: the tool may have been offered while the reviewing provider was
   *  on. Absent, the real rule is asked. */
  launchRefusal?: (providerId: ProviderId) => ProviderLaunchRefusal | null
  /** nubbymong/aicc_planning#446: the model registry the allow-lists are
   *  read from, when the review runs and when the tool is registered.
   *  Absent: the running app's (getRegistry). */
  registry?: () => ModelRegistry
  /** The platform the reviewer's environment is read for. Absent: this
   *  process's. */
  platform?: NodeJS.Platform
}

/** The running app's deps for each reviewer (exported for the test that pins
 *  what each one is given: a Codex review needs the diff and the files). */
export const defaultReviewDeps: ReviewToolDeps = {
  accounts: () => getAccountsService(),
  reviewer: () => tryGetProviderPackage('codex')?.review,
  diff: (input) => produceReviewDiff(input),
  files: (input) => produceReviewFiles(input),
}

export const defaultClaudeReviewDeps: ReviewToolDeps = {
  accounts: () => getAccountsService(),
  reviewer: () => tryGetProviderPackage('claude')?.review,
  diff: (input) => produceReviewDiff(input),
}

/** One review tool: the reviewing provider, the words it uses, and what it
 *  needs beyond the shared checks. */
interface ReviewSpec {
  providerId: 'codex' | 'claude'
  /** "Codex" / "Claude": the start of every message and the log tag. */
  name: string
  /** The session kind the tool is offered to, and what enables it. */
  notEnabled: (sessionId: string) => string
  unbound: string
  /** Produced by main and sent in the prompt (the reviewer has no git). */
  needsDiff: boolean
  /** Mode `paths`: the named files read by main and sent in the prompt (the
   *  reviewer has no tool that reads a file). */
  needsFiles: boolean
  prompt: (args: ReviewArgs, material: ReviewMaterial | null) => string
  refusal: (code: string, message: string) => string
  /** nubbymong/aicc_planning#446: the model and effort, from this
   *  reviewer's allow-lists, before anything is read, leased or run. */
  choose: (args: ReviewArgs, registry: ModelRegistry) => ReviewPickResult
  /** What the reviewer's prepared environment sets besides; checked once the
   *  launch is prepared, before the reviewer runs. Absent: nothing. */
  environment?: (pick: ReviewPick, env: Readonly<Record<string, string>>, platform: NodeJS.Platform, registry: ModelRegistry) => ReviewPickResult
  /** What the review ran on, for its footer and the log line (`reported`:
   *  the models the CLI's result names; null before the run). */
  ranOn: (pick: ReviewPick, reported: readonly string[] | undefined | null) => string
  /** After the run, whatever the outcome (a failed turn still used quota). */
  onUsage?: (sessionId: string, usage: ReviewUsage) => void
  /** A finished review, for channel routing. Best-effort. */
  onReview?: (sessionId: string, review: string) => void
}

const CODEX_SPEC: ReviewSpec = {
  providerId: 'codex',
  name: 'Codex',
  notEnabled: (sid) => `Codex review is not enabled for session ${sid}. It is available to local Claude Code sessions when Codex is enabled in Settings, and only when the session has a real project directory.`,
  unbound: 'Codex review unavailable: no Conductor session id bound to this MCP connection. Spawn the Claude session from inside AI Code Conductor.',
  needsDiff: true,
  needsFiles: true,
  prompt: (args, material) => buildCodexPrompt(args, material, randomBytes(8).toString('hex')),
  refusal: refusalText,
  choose: (args, registry) => chooseCodexReview(args, registry),
  ranOn: (pick) => codexRanOn(pick),
  onUsage: (sid, usage) => recordReview(sid, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, rateLimit: null }),
  onReview: (sid, review) => {
    // Emit internal event so channel rules (Codex Routing) can forward the
    // review to the PR author session. Best-effort: never breaks the review result.
    // Count numbered list items or "issue:" lines as a rough finding count.
    const findingCount = (review.match(/^\s*\d+\./gm) ?? []).length || 1
    emitCodexReviewComplete({
      prNumber: undefined,
      authorSessionId: sid,
      findingCount,
      findings: review.slice(0, 500),
    })
  },
}

const CLAUDE_SPEC: ReviewSpec = {
  providerId: 'claude',
  name: 'Claude',
  notEnabled: (sid) => `Claude review is not enabled for session ${sid}. It is available to local Codex sessions while Claude is on and a Claude account can review, and only when the session has a real project directory.`,
  unbound: 'Claude review unavailable: no Conductor session id bound to this MCP connection. Restart the Codex session from inside AI Code Conductor.',
  needsDiff: true,
  needsFiles: false,
  prompt: (args, material) => buildClaudePrompt(args, material?.kind === 'diff' ? material.diff : null, randomBytes(8).toString('hex')),
  refusal: claudeRefusalText,
  choose: (args, registry) => chooseClaudeReview(args, registry),
  environment: (pick, env, platform, registry) => claudeReviewEnvironment(pick, env, platform, registry),
  ranOn: (pick, reported) => claudeRanOn(pick, reported),
}

/** Owner ids of review leases: one per invocation. */
let reviewSeq = 0

export function runCodexReview(
  rawArgs: unknown,
  optedInSessions: Set<string>,
  resolvedCwd: string,
  deps: ReviewToolDeps = defaultReviewDeps,
  signal?: AbortSignal,
): Promise<ReviewToolResult> {
  return runReview(CODEX_SPEC, rawArgs, optedInSessions, resolvedCwd, deps, signal)
}

/** claude_review for a Codex session (WP2 commit 5b). */
export function runClaudeReview(
  rawArgs: unknown,
  optedInSessions: Set<string>,
  resolvedCwd: string,
  deps: ReviewToolDeps = defaultClaudeReviewDeps,
  signal?: AbortSignal,
): Promise<ReviewToolResult> {
  return runReview(CLAUDE_SPEC, rawArgs, optedInSessions, resolvedCwd, deps, signal)
}

async function runReview(
  spec: ReviewSpec,
  rawArgs: unknown,
  optedInSessions: Set<string>,
  resolvedCwd: string,
  deps: ReviewToolDeps,
  signal?: AbortSignal,
): Promise<ReviewToolResult> {
  const name = spec.name
  // 1. zod validation
  const parsed = reviewArgsSchema.safeParse(rawArgs)
  if (!parsed.success) {
    return { isError: true, text: `Invalid arguments: ${parsed.error.message}` }
  }
  const args = parsed.data

  // 1.5. P7.7.10: cccSessionId is now optional in the schema (resolved
  // server-side from the MCP transport URL). At this layer it MUST be
  // present -- the MCP tool wrapper is responsible for merging in the
  // bound sid before calling runCodexReview. A direct call without sid
  // is a wiring bug worth surfacing.
  if (!args.cccSessionId) {
    return { isError: true, text: spec.unbound }
  }
  const cccSessionId: string = args.cccSessionId

  // 2. ACL
  if (!optedInSessions.has(cccSessionId)) {
    return { isError: true, text: spec.notEnabled(cccSessionId) }
  }

  // 2.5. SECURITY (adversarial review, #188): defence-in-depth against the
  // home-directory review root. Registration already refuses when the launch cwd
  // is home or an ancestor of it (pty-manager), so such a session should never be
  // in optedInSessions -- but re-check here so mode:'paths' can never reach
  // ~/.ssh, ~/.claude, ~/.aws even if a future caller re-introduces one.
  // isHomeOrAncestor canonicalises with realpath so a case-variant / \\?\ /
  // junction form of home is caught, not just the exact string.
  if (isHomeOrAncestor(resolvedCwd)) {
    return {
      isError: true,
      text: `${name} review refused: the session has no project directory (its working directory resolves to your home folder). Set a real project directory in the session config.`,
    }
  }

  // 3. Path traversal containment for mode 'paths'
  //    (the reviewer's own confinement is defence-in-depth; this is the primary gate.)
  if (args.mode === 'paths' && args.paths) {
    for (const p of args.paths) {
      const abs = path.resolve(resolvedCwd, p)
      const rel = path.relative(resolvedCwd, abs)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return {
          isError: true,
          text: `Paths must be inside the session cwd. Rejected: ${p}`,
        }
      }
    }
  }

  // 3.5. Git-repo guard for modes that require diff history.
  //      Fast-fail with a clear redirect to mode='paths' before any latency or
  //      quota is spent. mode='paths' is intentionally exempt since it
  //      operates on explicit file paths and works outside a repo.
  if (args.mode === 'working' || args.mode === 'range') {
    if (!existsSync(path.join(resolvedCwd, '.git'))) {
      return {
        isError: true,
        text: `Mode '${args.mode}' requires a git repository, but ${resolvedCwd} is not one. Use mode='paths' with explicit file paths instead.`,
      }
    }
  }

  // 3.6. nubbymong/aicc_planning#446: the model and effort, from this
  //      reviewer's allow-lists as the registry stands now. A value off them
  //      is refused with them here, before anything is read, leased or run.
  const registry = (deps.registry ?? getRegistry)()
  const chosen = spec.choose(args, registry)
  if ('refused' in chosen) return { isError: true, text: chosen.refused }
  let pick: ReviewPick = chosen

  // 4. The reviewer's account (WP2 commit 5a): the reviewer default, else the
  // provider default, bound and leased as a `review` consumer by the accounts
  // service, which prepares its realm's launch (the executable setup proved,
  // the realm's environment with ambient credentials removed). Local only:
  // the session this review serves runs on this computer. An unverified
  // sign-in is refused: an agent cannot give the per-launch acknowledgement
  // a person must give.
  //
  // First, main's one launch rule (provider-launch-gate.ts): the tool was
  // offered while the reviewing provider was on, but a call that arrives
  // after it was switched off starts nothing -- no diff, no lease, no CLI.
  const launchRefused = (deps.launchRefusal ?? providerLaunchRefusal)(spec.providerId)
  if (launchRefused) return { isError: true, text: `${name} review is unavailable. ${launchRefused.message}` }
  const accounts = deps.accounts()
  const reviewer = deps.reviewer()
  if (!accounts || !reviewer || (spec.needsDiff && !deps.diff) || (spec.needsFiles && !deps.files)) {
    return { isError: true, text: `${name} review unavailable: accounts are not ready yet. Try again in a moment.` }
  }
  if (signal?.aborted) return { isError: true, text: `${name} review was cancelled.` }
  // Counted and registered before the first await, so concurrent calls see it.
  const running = reviewsInFlight.get(cccSessionId) ?? new Set<AbortController>()
  if (running.size >= MAX_REVIEWS_PER_SESSION) {
    return { isError: true, text: `${name} review: a review is already running for this session. Wait for it to finish, then try again.` }
  }
  const stop = new AbortController()
  const onCancel = () => stop.abort()
  signal?.addEventListener('abort', onCancel, { once: true })
  running.add(stop)
  reviewsInFlight.set(cccSessionId, running)
  try {
    // 4.5. The change, when the reviewer cannot read it itself (commit 5b):
    // produced here, before an account is leased, with a hardened git; and
    // for a reviewer that cannot read files either, mode `paths`' files, read
    // here (inside the project only; review-diff.ts).
    let material: ReviewMaterial | null = null
    if (spec.needsDiff && deps.diff && (args.mode === 'working' || args.mode === 'range')) {
      const d = await deps.diff({ cwd: resolvedCwd, mode: args.mode, ...(args.range !== undefined ? { range: args.range } : {}), signal: stop.signal })
      if (stop.signal.aborted) return { isError: true, text: `${name} review was cancelled.` }
      if (!d.ok) return { isError: true, text: `${name} review could not read the change: ${d.message}.` }
      if (!d.diff.trim()) {
        return { isError: false, text: args.mode === 'working' ? `${name} review: nothing to review -- there are no uncommitted changes to tracked files.` : `${name} review: nothing to review -- the range ${args.range} has no changes.` }
      }
      material = { kind: 'diff', diff: d.diff }
    } else if (spec.needsFiles && deps.files && args.mode === 'paths') {
      const f = await deps.files({ cwd: resolvedCwd, paths: args.paths ?? [], signal: stop.signal })
      if (stop.signal.aborted) return { isError: true, text: `${name} review was cancelled.` }
      if (!f.ok) return { isError: true, text: `${name} review could not read the files: ${f.message}.` }
      material = { kind: 'files', files: f.files }
    }
    const prepared = await accounts.prepareLaunch({ kind: 'review', providerId: spec.providerId, ownerId: `review:${cccSessionId}:${++reviewSeq}`, sessionId: cccSessionId, remote: false })
    if (!prepared.ok) return { isError: true, text: spec.refusal(prepared.code, prepared.message) }
    if (stop.signal.aborted) { prepared.lease.release(); return { isError: true, text: `${name} review was cancelled.` } }
    // A run whose processes were still being ended when it settled (a stop's
    // kill reading a slow process table, or what a run that had exited left):
    // the lease is held until that has finished, whatever the outcome.
    let kill: Promise<void> | undefined
    try {
      // 5. One isolated reviewer invocation, in the project, prompt on stdin.
      // P7.7.15: honour caller-supplied timeoutSeconds when provided; zod
      // already clamped it to [TIMEOUT_SECONDS_MIN, TIMEOUT_SECONDS_MAX].
      const timeoutMs = args.timeoutSeconds != null ? args.timeoutSeconds * 1000 : REVIEW_TIMEOUT_MS
      // 4.6. What the prepared environment sets besides (Claude Code reads
      // its model and effort from two variables): reported, and a chosen
      // value it would override is refused, before the reviewer runs.
      if (spec.environment) {
        const withEnv = spec.environment(pick, prepared.env, deps.platform ?? process.platform, registry)
        if ('refused' in withEnv) return { isError: true, text: withEnv.refused }
        pick = withEnv
      }
      logInfo(`[${spec.providerId}-review] session ${cccSessionId}: mode ${args.mode}, reviewer account ${prepared.binding.providerAccountId} (${prepared.reviewer ?? 'explicit'}), on ${spec.ranOn(pick, null)}`)
      const out: ReviewRunResult = await reviewer.run({
        executable: prepared.executable, env: prepared.env, cwd: resolvedCwd, prompt: spec.prompt(args, material), timeoutMs, signal: stop.signal,
        realm: { authRealmId: prepared.binding.authRealmId },
        ...pick.argv,
      })
      if (out && out.killSettled instanceof Promise) kill = out.killSettled
      // A reviewer that never started ran on no model: its footer names none.
      const started = !(out && !out.ok && out.code === 'not-started')
      const ranOn = started ? spec.ranOn(pick, out?.reportedModels) : null
      // After the run, with what the CLI reported (the line above could not have it).
      logInfo(`[${spec.providerId}-review] session ${cccSessionId}: ${out?.ok ? 'reviewed' : `ended (${out?.code ?? 'no result'})`}${ranOn !== null ? `, on ${ranOn}` : ', nothing started'}`)

      // 6. Usage, whatever the outcome (a failed turn still used quota).
      if (out.usage && spec.onUsage) spec.onUsage(cccSessionId, out.usage)

      // 7. Error mapping
      if (!out.ok) {
        if (out.code === 'cancelled') return { isError: true, text: `${name} review was cancelled.` }
        if (out.code === 'timed-out') {
          return { isError: true, text: `${name} review timed out after ${formatTimeoutForMessage(timeoutMs)}${ranOn !== null ? ` (on ${ranOn})` : ''}. Try a smaller scope (e.g. mode: "paths") or raise timeoutSeconds (max ${TIMEOUT_SECONDS_MAX}).` }
        }
        return { isError: true, text: `${name} review failed: ${out.message}${formatFooter(out.usage, name, ranOn)}` }
      }
      const review = out.text
      try { spec.onReview?.(cccSessionId, review) } catch { /* channels emit is best-effort */ }
      return { isError: false, text: review + formatFooter(out.usage, name, ranOn) }
    } finally {
      // The run has settled: it exited, or a stop killed its chain, or the
      // bound (CODEX_KILL_SETTLE_MS) passed with its processes still being
      // ended (a stop's kill, or what a run that had exited left) -- then the
      // lease goes once that has finished (within the runner's worst case),
      // not before, whatever the outcome: the reviewer, or what it left, may
      // live until then.
      const letGo = () => { try { prepared.lease.release() } catch { /* a release never replaces the result */ } }
      if (kill) void kill.then(letGo, letGo)
      else letGo()
    }
  } finally {
    signal?.removeEventListener('abort', onCancel)
    running.delete(stop)
    if (running.size === 0 && reviewsInFlight.get(cccSessionId) === running) reviewsInFlight.delete(cccSessionId)
  }
}

/** The review requests in flight, per session and MCP request id. A
 *  stateless connection (Codex's /mcp) delivers a request's cancel on a NEW
 *  connection, whose server never saw the request; the server routes it here
 *  by the session THAT connection authenticated, so a session can cancel only
 *  its own requests. */
const requestsBySession = new Map<string, Map<string | number, AbortController>>()

/** Cancel the review serving this session's MCP request, if one is. */
export function cancelReviewRequest(sessionId: string, requestId: string | number): boolean {
  const c = requestsBySession.get(sessionId)?.get(requestId)
  if (!c) return false
  c.abort()
  return true
}

/** The MCP arguments both review tools take. */
/** The range argument's wording: both reviewers need a real range, since
 *  main produces the diff for each (review-diff.ts, parseReviewRange). */
const RANGE_TEXT = 'Git range: two revisions joined by ".." or "..." (e.g. "HEAD~1..HEAD") -- required when mode === "range"'

function reviewToolShape(zMod: any, rangeText: string, choice: { model: string; effort: string }) {
  return {
    cccSessionId: zMod.string().optional().describe('Ignored — the session id is resolved from the MCP connection and cannot be set here. Leave unset.'),
    mode: zMod.enum(['working', 'range', 'paths']).describe('Scope: working diff, git range, or explicit paths'),
    range: zMod.string().optional().describe(rangeText),
    paths: zMod.array(zMod.string()).optional().describe('File paths -- required when mode === "paths"'),
    focus: zMod.string().max(500).optional().describe('Optional focus directive (e.g. "race conditions")'),
    timeoutSeconds: zMod.number().int().min(30).max(900).optional().describe('Optional override of the default 5-minute timeout. Allowed range 30-900 seconds. Raise for large diffs that overshoot the default; lower for fast-fail experiments.'),
    // nubbymong/aicc_planning#446: each lists the values it takes, as the
    // registry stood when the tool was offered; the review checks them
    // again when it runs.
    model: zMod.string().optional().describe(choice.model),
    effort: zMod.string().optional().describe(choice.effort),
  }
}

/** The shared MCP handler: the session id comes SOLELY from the connection
 *  (see registerCodexReviewTool). */
function reviewHandler(
  run: (args: Record<string, unknown>, optedIn: Set<string>, cwd: string, signal?: AbortSignal) => Promise<ReviewToolResult>,
  getOptedIn: () => Set<string>,
  getCwdForSession: (sessionId: string) => string | null,
  getBoundSessionId: () => string | null,
  unboundText: string,
  notEnabledText: string,
) {
  return async (rawArgs: any, extra?: { signal?: AbortSignal; requestId?: string | number }) => {
    const sid = getBoundSessionId()
    if (!sid) return { content: [{ type: 'text' as const, text: unboundText }], isError: true }
    const cwd = getCwdForSession(sid)
    if (!cwd) return { content: [{ type: 'text' as const, text: notEnabledText }], isError: true }
    const mergedArgs: Record<string, unknown> = { ...rawArgs, cccSessionId: sid }
    // The MCP request's own cancel stops the reviewer too: through its signal
    // (the connection closed, or a cancel on the same connection), or routed
    // here by id when it arrives on another connection (cancelReviewRequest).
    const stop = new AbortController()
    const onAbort = () => stop.abort()
    if (extra?.signal?.aborted) stop.abort()
    else extra?.signal?.addEventListener('abort', onAbort, { once: true })
    const id = extra?.requestId
    const mine = id !== undefined ? (requestsBySession.get(sid) ?? new Map<string | number, AbortController>()) : null
    if (mine && id !== undefined) { mine.set(id, stop); requestsBySession.set(sid, mine) }
    try {
      const result = await run(mergedArgs, getOptedIn(), cwd, stop.signal)
      return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError }
    } finally {
      extra?.signal?.removeEventListener('abort', onAbort)
      if (mine && id !== undefined && mine.get(id) === stop) {
        mine.delete(id)
        if (mine.size === 0 && requestsBySession.get(sid) === mine) requestsBySession.delete(sid)
      }
    }
  }
}

/** Register the codex_review tool on a conductor-mcp-server McpServer instance.
 *
 * The session id comes SOLELY from `getBoundSessionId()` — the CCC session id
 * parsed from the transport URL (`?cccSessionId=<sid>`, baked in per-session by
 * writeLocalSessionMcpConfig). The `cccSessionId` tool ARG is ignored entirely
 * (adversarial review, #188): once every local session is opted-in, trusting an
 * LLM-supplied id would let a session name another session's id and review its
 * tree. An unbound connection (legacy/in-flight, pre-P7.7.10 URL bake) is refused
 * and self-heals on the session's next respawn.
 *
 * NOTE — this binds the id to the transport URL, not to an unforgeable secret.
 * The endpoint is still gated only by the loopback token, which is written into
 * each session's readable ~/.claude/mcp-<sid>.json (a documented local-trust
 * posture, SECURITY.md). A local process already running as the user could read
 * that token and POST a chosen ?cccSessionId — but such a process can read the
 * target files directly and needs no codex_review, so this is not an escalation
 * over the existing local-trust boundary. Minting a per-session capability token
 * (so the sid can't be restated in the URL) is tracked as a follow-up; it is a
 * pre-existing hardening, not introduced by this change.
 */
export function registerCodexReviewTool(
  server: any,  // McpServer (lazy-typed in conductor-mcp-server.ts)
  zMod: any,    // zod module (lazy-loaded)
  getOptedIn: () => Set<string>,
  getCwdForSession: (sessionId: string) => string | null,
  getBoundSessionId: () => string | null = () => null,
  deps: ReviewToolDeps = defaultReviewDeps,
): void {
  server.tool(
    'codex_review',
    'Get a Codex code review on a change. Use when the user asks for a "Codex review" or "second opinion". The mode arg picks scope: "working" for uncommitted changes to tracked files (no extra arg), "range" for a git revision range (provide range, e.g. "HEAD~1..HEAD"), "paths" for specific files (provide paths). Optional focus directs Codex\'s attention. Runs on the Codex reviewer account (Accounts), and cannot run commands or read or change files: it reviews what the request carries (the diff, or for "paths" the named files\' content; 512 KB at most), with the project\'s AGENTS.md if there is one, which Codex loads itself. Optional model and effort choose the Codex model and the reasoning effort it runs on: each lists the values it takes, and any other value is refused with that list; unset, it runs on the reviewer account\'s default model at medium effort. Returns the review markdown plus a footer naming the model and the effort it ran on and where each came from (caller or default), and its token usage, so you can self-govern usage. The Conductor session id is resolved automatically from the MCP connection -- no need to pass it.',
    reviewToolShape(zMod, RANGE_TEXT, codexReviewChoiceText((deps.registry ?? getRegistry)())),
    // SECURITY (adversarial review, #188): trust ONLY the transport-bound
    // session id; a prompt-injected session could otherwise pass ANOTHER
    // session's id and have it reviewed. Legacy in-flight sessions that
    // pre-date the URL bake self-heal on their next respawn.
    reviewHandler(
      (args, optedIn, cwd, signal) => runCodexReview(args, optedIn, cwd, deps, signal),
      getOptedIn, getCwdForSession, getBoundSessionId,
      'Codex review unavailable: this MCP connection has no bound Conductor session. Restart the Claude session from inside AI Code Conductor.',
      'Codex review is not enabled for this session. It is available to local Claude Code sessions with a real project directory while Codex is on (Settings, Accounts) and Codex review is on (Settings, General, Built-in Tools).',
    ),
  )
}

/** Register the claude_review tool (WP2 commit 5b) for a Codex session's
 *  connection. The same binding rule as codex_review: the session id comes
 *  from the authenticated connection only. */
export function registerClaudeReviewTool(
  server: any,  // McpServer (lazy-typed in conductor-mcp-server.ts)
  zMod: any,    // zod module (lazy-loaded)
  getOptedIn: () => Set<string>,
  getCwdForSession: (sessionId: string) => string | null,
  getBoundSessionId: () => string | null = () => null,
  deps: ReviewToolDeps = defaultClaudeReviewDeps,
): void {
  server.tool(
    'claude_review',
    'Get a Claude Code review of a change. Use when the user asks for a "Claude review" or "second opinion". The mode arg picks scope: "working" for uncommitted changes to tracked files (no extra arg), "range" for a git revision range (provide range, e.g. "HEAD~1..HEAD"), "paths" for specific files (provide paths). Optional focus directs Claude\'s attention. Runs on the Claude reviewer account (Accounts), read-only (it can read files in the project, nothing else). Optional model and effort choose the Claude model and the effort level it runs on: each lists the values it takes, and any other value is refused with that list; unset, it runs on Claude Code\'s defaults for the reviewer account, or on ANTHROPIC_MODEL and CLAUDE_CODE_EFFORT_LEVEL when this app\'s environment sets them. Returns the review markdown plus a footer naming the model and the effort it ran on and where each came from (caller, default or environment; the model as Claude Code reports it, or marked not confirmed), and its token usage, so you can self-govern usage. The Conductor session id is resolved automatically from the MCP connection -- no need to pass it.',
    reviewToolShape(zMod, RANGE_TEXT, claudeReviewChoiceText((deps.registry ?? getRegistry)())),
    reviewHandler(
      (args, optedIn, cwd, signal) => runClaudeReview(args, optedIn, cwd, deps, signal),
      getOptedIn, getCwdForSession, getBoundSessionId,
      'Claude review unavailable: this MCP connection has no bound Conductor session. Restart the Codex session from inside AI Code Conductor.',
      'Claude review is not enabled for this session. It is available to local Codex sessions with a real project directory while Claude is on and a Claude account can review.',
    ),
  )
}

// The request and the shared rules (review-request.ts) and the review on a
// remote session's machine (codex-review-remote.ts) are this module's too.
export * from './review-request'
export * from './codex-review-remote'

// ── codex_review for a remote session (2.1.3-beta.21, nubbymong/aicc_planning#446) ──
//
// A Claude Code tab through the session helper is offered codex_review while
// its machine's record names Codex, and the review runs there
// (codex-review-remote.ts runRemoteCodexReview), on the machine's own Codex
// sign-in: never on this computer, and never on an account of it.

let remoteReviewHost: RemoteReviewHost | null = null

/** The running app's machine side of a review there (the remote machines'
 *  wiring, ipc/remote-machines-handlers.ts); null until it starts, and on a
 *  platform without it. */
export function setRemoteReviewDeps(host: RemoteReviewHost | null): void {
  remoteReviewHost = host
}

export function currentRemoteReviewDeps(): RemoteReviewHost | null {
  return remoteReviewHost
}

/** The running app's deps for a review on a machine: the machine side, the
 *  registry, main's launch rule, the usage record and the channels. */
function runningAppRemoteDeps(host: RemoteReviewHost | null): RemoteReviewDeps | null {
  if (!host) return null
  return {
    ...host,
    registry: () => getRegistry(),
    launchRefusal: (providerId) => providerLaunchRefusal(providerId),
    onUsage: (sid, usage) => CODEX_SPEC.onUsage?.(sid, usage),
    onReview: (sid, review) => CODEX_SPEC.onReview?.(sid, review),
  }
}

/** Whether a registered remote tab's connection is offered codex_review: its
 *  machine's record names Codex (its last Check found it there). */
export function remoteCodexReviewOffered(target: RemoteReviewTarget | null, host: Pick<RemoteReviewHost, 'machine'> | null = remoteReviewHost): boolean {
  return remoteReviewOffered(target, host)
}

/**
 * Register codex_review for a registered remote tab's connection: the same
 * tool, run on the tab's machine (runRemoteCodexReview). The session id comes
 * from the connection only (the tool stream's, given by the session helper's
 * manager), as registerCodexReviewTool's rule is. Its model parameter lists
 * the machine's own Codex models, as its last Check read them.
 */
export function registerRemoteCodexReviewTool(
  server: any,  // McpServer (lazy-typed in conductor-mcp-server.ts)
  zMod: any,    // zod module (lazy-loaded)
  getBoundSessionId: () => string | null,
  getTarget: (sessionId: string) => RemoteReviewTarget | null,
  deps: RemoteReviewDeps | null = runningAppRemoteDeps(remoteReviewHost),
): void {
  const registry: ModelRegistry = deps ? deps.registry() : getRegistry()
  const bound = getBoundSessionId()
  const target = bound ? getTarget(bound) : null
  let machine: RemoteMachineRecord | null = null
  try { machine = target && deps ? deps.machine(target.did) : null } catch { machine = null }
  const hostModels = machine?.codex?.models ?? null
  const choice = hostModels
    ? codexReviewChoiceText(withInstalledCodexModels(registry, hostModels))
    : { model: 'Optional: not taken on this machine until its last Check has read the models its Codex lists: leave unset for the default model of the machine\'s own Codex sign-in.', effort: codexReviewChoiceText(registry).effort }
  const where = machine ? machineName(machine) : 'the machine this session runs on'
  server.tool(
    'codex_review',
    `Get a Codex code review on a change. Use when the user asks for a "Codex review" or "second opinion". This session runs on ${where}, and the review runs there too, with that machine's own Codex sign-in: the change is read there and Codex runs there, never on the user's computer. The mode arg picks scope: "working" for uncommitted changes to tracked files (no extra arg), "range" for a git revision range (provide range, e.g. "HEAD~1..HEAD"), "paths" for specific files (provide paths). Optional focus directs Codex's attention. Codex cannot run commands or read or change files: it reviews what the request carries (the diff, or for "paths" the named files' content; 512 KB at most). Optional model and effort choose the Codex model and the reasoning effort it runs on: each lists the values it takes, and any other value is refused with that list; unset, it runs on the default model of the machine's own Codex sign-in at medium effort. Returns the review markdown plus a footer naming the machine, the model and the effort it ran on and where each came from (caller or default), and its token usage. The Conductor session id is resolved automatically from the MCP connection -- no need to pass it.`,
    reviewToolShape(zMod, RANGE_TEXT, choice),
    reviewHandler(
      (args, _optedIn, _cwd, signal) => runRemoteCodexReview(args, getTarget(String(args.cccSessionId)), deps, signal),
      () => new Set<string>(),
      (sessionId: string) => getTarget(sessionId)?.cwd ?? null,
      getBoundSessionId,
      'Codex review unavailable: this MCP connection has no bound Conductor session. Restart the tab from inside AI Code Conductor.',
      REMOTE_REVIEW_NOT_ENABLED,
    ),
  )
}
