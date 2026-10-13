// Sentinel model-registry check (#385).
//
// The owner's rule: the model options we offer follow Anthropic's Claude Code
// model configuration support article, and the list must be GUARDED so a model
// Anthropic retired never stays selectable and a new one is not missed.
//
// This is the runtime half. The release-gate half (scripts/release-gate.mjs)
// refuses to cut a build whose registry disagrees with the shipped snapshot;
// this one watches an INSTALLED build, where the article can move underneath a
// registry that is frozen in the package.
//
// Two modes, because the snapshot alone cannot answer the owner's question
// (review S1). The snapshot and the registry ship together and the gate
// guarantees the registry covers it at cut time, so "Anthropic added a model"
// is empty by construction from the snapshot. That arm therefore reads the LIVE
// article when the network allows:
//
//   live      article fetched and parsed -> "Anthropic lists X, we don't offer it"
//   snapshot  offline/unreadable         -> compare against the frozen snapshot
//             and let the staleness note carry the uncertainty
//
// Every finding says which mode produced it, so a user is never shown a claim
// about "currently" that came from a file baked in months ago.
//
// The RETIRED arm always uses the snapshot: it is human-verified, whereas a
// thin HTML parse that silently stops matching would otherwise accuse every
// model we ship of having been retired.
import { evaluateModelCoverage, evaluateCodexModelCoverage, isOverlaySourced, type ModelRegistry, type ExpectedModelSet } from '../../shared/model-registry'
import type { SentinelFinding } from '../../shared/sentinel-types'
import { compareVersions, finalRelease } from '../../shared/version-order'
import expectedJson from '../../../resources/claude-code-model-configuration.json'
import codexExpectedJson from '../../../resources/codex-model-catalogue.json'

export const EXPECTED_MODEL_SET = expectedJson as unknown as ExpectedModelSet

/** The models the supported Codex CLI lists in its own model picker, shipped
 *  with this build (P3.8, row 39): the Codex half's reference, as the article
 *  snapshot is the Claude half's. `cliVersions` names the CLIs it was read from;
 *  a model's own `cliVersions`, when it has one, names the ones that list it. */
export type CodexExpectedModelSet = ExpectedModelSet & { cliVersions?: string[] }
export const CODEX_EXPECTED_MODEL_SET = codexExpectedJson as unknown as CodexExpectedModelSet

/** How old the article snapshot may get before we say so. */
export const FIXTURE_STALE_DAYS = 90

/** The fewest model ids a read of the article may yield and still count as
 *  read (sentinel-model-article.ts re-exports it for its parse). Fewer means
 *  the page was restyled past the parse, not that Anthropic dropped models,
 *  so such a read is never live and closes nothing (O8). */
export const MIN_PLAUSIBLE_IDS = 3

/** The ids of the findings raised when a model check throws (each half's). */
export const MODEL_CHECK_FAILED_ID = 'models:check-failed'
export const CODEX_MODEL_CHECK_FAILED_ID = 'models:codex-check-failed'

const DAY_MS = 24 * 60 * 60 * 1000

export type CoverageMode = 'live' | 'snapshot'

export function fixtureAgeDays(fetchedAt: string | undefined, now: number): number | null {
  if (!fetchedAt) return null
  const t = Date.parse(fetchedAt)
  if (!Number.isFinite(t)) return null
  return Math.floor((now - t) / DAY_MS)
}

/**
 * Compare the live (baseline + overlay) registry against what the article
 * offers.
 *
 * Pure — mirrors minVersionFindings(): the caller fetches and upserts. Finding
 * ids are stable and prefixed `models:` so a dismissed finding stays dismissed
 * and a repeat run never duplicates.
 *
 * @param liveIds ids read from the article just now, or null when it could not
 *                be read (offline). Null selects snapshot mode.
 *
 * Severities are deliberately not `high`: neither arm breaks a running session,
 * and `high` would light the alarm dot on every launch for a model the owner
 * knowingly carries. `warn` still surfaces in the panel.
 */
export function modelCoverageFindings(
  registry: ModelRegistry,
  expected: ExpectedModelSet | null | undefined,
  now: number = Date.now(),
  liveIds: string[] | null = null,
): SentinelFinding[] {
  const out: SentinelFinding[] = []
  const source = expected?.source ?? 'the Claude Code model configuration article'
  const snapshotResult = evaluateModelCoverage(registry, expected)

  // A torn/empty snapshot fails closed in evaluateModelCoverage. Report that
  // rather than a wall of "missing" findings for models we cannot verify.
  if (!snapshotResult.ok && snapshotResult.missing.length === 0) {
    out.push({
      id: 'models:fixture-unreadable',
      kind: 'compat',
      severity: 'warn',
      title: 'The Claude Code model list could not be verified',
      evidence: snapshotResult.reason ?? 'the expected-models snapshot is empty or missing',
      badgeText: 'Model list unverified',
      status: 'open',
      createdAt: now,
    })
    return out
  }

  // ── "Anthropic offers it, we don't" — live when we could read the article.
  const mode: CoverageMode = liveIds && liveIds.length ? 'live' : 'snapshot'
  const addedResult = mode === 'live'
    ? evaluateModelCoverage(registry, { ...expected, models: liveIds!.map((id) => ({ id })) })
    : snapshotResult
  const provenance = mode === 'live'
    ? `read online from ${source}`
    : `from the model list shipped with this build (${expected?.fetchedAt ?? 'undated'}) — the article could not be read`

  for (const m of addedResult.missing) {
    out.push({
      id: `models:missing:${m.id}`,
      kind: 'compat',
      severity: 'warn',
      title: `Claude Code offers ${m.label ?? m.id}, but it is not in the model picker`,
      evidence: `${m.id} is listed by the Claude Code model configuration (${provenance}); resources/model-registry.json has no entry covering it.`,
      affectedFeature: 'sessions',
      badgeText: `New model: ${m.label ?? m.id}`,
      status: 'open',
      createdAt: now,
    })
  }

  // ── "We offer it, the article doesn't" — always the human-verified snapshot.
  for (const m of snapshotResult.extra) {
    out.push({
      id: `models:retired:${m.id}`,
      kind: 'compat',
      severity: 'warn',
      title: `${m.label ?? m.id} is still selectable but Anthropic no longer lists it`,
      evidence: `resources/model-registry.json carries ${m.id}; the model list shipped with this build (${expected?.fetchedAt ?? 'undated'}) does not — retired or renamed?`,
      affectedFeature: 'sessions',
      badgeText: `Possibly retired: ${m.label ?? m.id}`,
      status: 'open',
      createdAt: now,
    })
  }

  // ── The snapshot itself going stale. Only meaningful when we had to rely on
  //    it: a successful live read has just answered the question first-hand.
  const age = fixtureAgeDays(expected?.fetchedAt, now)
  if (mode === 'snapshot' && age !== null && age > FIXTURE_STALE_DAYS) {
    out.push({
      id: `models:fixture-stale:${expected?.fetchedAt}`,
      kind: 'info',
      severity: 'info',
      title: 'The published model list has not been re-checked in a while',
      evidence: `resources/claude-code-model-configuration.json was fetched ${age} days ago (${expected?.fetchedAt}), and the live article could not be read to confirm it. Re-read ${source} and refresh it.`,
      status: 'open',
      createdAt: now,
    })
  }

  return out
}

/**
 * The Codex half (P3.8, row 39): the registry's Codex models against the list
 * the supported Codex CLI offers, shipped with this build. Pure, as
 * modelCoverageFindings; finding ids are stable and prefixed `models:codex-`.
 *
 * Two modes, as the Claude half (P3.9, row 39):
 *
 *   live      the installed CLI's own list, read from it just now
 *             (`codex debug models --bundled`, see the Codex package's
 *             model-catalogue.ts): both arms compare against it, since it is
 *             the CLI's own strict JSON rather than a page parse, so a model
 *             the installed version dropped (gpt-5.2 on 0.155.1) or added is
 *             said, for that version; a model the shipped list names only
 *             from a later version (gpt-6-sol on 0.155.1) is not said to be
 *             retired, since that version has not listed it yet;
 *   snapshot  no live list (Codex not proven, a version this app cannot use,
 *             or a read that failed): the list shipped with this build, whose
 *             every finding names it and its date, and which says when it is
 *             older than FIXTURE_STALE_DAYS.
 *
 * In snapshot mode both inputs ship with the build, so at runtime it reports
 * only what an overlay changes and a stale list; a registry that disagrees
 * with the shipped list is refused earlier, by the release gate
 * (scripts/release-gate.mjs, check 3).
 */
export interface CodexLiveModelList {
  /** The version that printed the list. */
  version: string
  models: ReadonlyArray<{ id: string; label: string }>
}

/** A live list the check may use: a version and at least one model. */
function usableCodexLiveList(live: CodexLiveModelList | null | undefined): CodexLiveModelList | null {
  return live && typeof live.version === 'string' && Array.isArray(live.models) && live.models.length > 0 ? live : null
}

/**
 * True when the shipped list names `id` only for Codex versions newer than
 * `version`: the model's own `cliVersions` are all later than it. That Codex
 * has not listed the model yet, so its absence from that version's own list
 * says nothing about the model being retired (S18 review, 2026-10-12:
 * GPT-6-Sol and GPT-6-Luna, listed from 0.156.1, on 0.155.1). A model an equal
 * or older version listed (gpt-5.2, listed by 0.153.4, on 0.155.1) is not this
 * case, and neither is a model with no versions of its own or a version that
 * does not parse: the notice is said, as before.
 */
function listedOnlyAfter(expected: ExpectedModelSet | null | undefined, id: string, version: string): boolean {
  if (finalRelease(version) === null) return false
  const entry = (Array.isArray(expected?.models) ? expected!.models : []).find((m) => m?.id === id) as { cliVersions?: unknown } | undefined
  const listedBy: unknown[] = Array.isArray(entry?.cliVersions) ? entry!.cliVersions : []
  return listedBy.length > 0
    && listedBy.every((v) => typeof v === 'string' && finalRelease(v) !== null && compareVersions(v, version) > 0)
}

export function codexModelCoverageFindings(
  registry: ModelRegistry,
  expected: CodexExpectedModelSet | null | undefined,
  now: number = Date.now(),
  live: CodexLiveModelList | null = null,
): SentinelFinding[] {
  const out: SentinelFinding[] = []
  // An empty live list is no list: the snapshot answers instead (fail closed).
  const liveList = usableCodexLiveList(live)
  const reference: ExpectedModelSet | null | undefined = liveList
    ? { source: `the installed Codex ${liveList.version}`, models: liveList.models.map((m) => ({ id: m.id, label: m.label })) }
    : expected
  const result = evaluateCodexModelCoverage(registry, reference)
  const duplicated = new Set(result.duplicates ?? [])
  if (!result.ok && result.missing.length === 0 && duplicated.size === 0) {
    out.push({
      id: 'models:codex-list-unreadable',
      kind: 'compat',
      severity: 'warn',
      title: 'The Codex model list could not be verified',
      evidence: result.reason ?? 'the Codex model list is empty or missing',
      badgeText: 'Codex model list unverified',
      provider: 'codex',
      status: 'open',
      createdAt: now,
    })
    return out
  }
  const versions = Array.isArray(expected?.cliVersions) && expected!.cliVersions.length ? `Codex ${expected!.cliVersions.join(' and ')}, ` : ''
  const shipped = liveList
    ? `the model list read from the installed Codex ${liveList.version} itself`
    : `the Codex model list shipped with this build (${versions}${expected?.fetchedAt ?? 'undated'})`
  // P3.8 round 2 (GS): an id the registry lists more than once covers
  // nothing (the pickers would disagree about it); said as such.
  for (const id of duplicated) {
    out.push({
      id: `models:codex-duplicate:${id}`,
      kind: 'compat',
      severity: 'warn',
      title: `${id} is in the model registry more than once`,
      evidence: `resources/model-registry.json (with any overlay) lists ${id} more than once, so which picker offers it is ambiguous; keep one entry, in the codex family.`,
      affectedFeature: 'sessions',
      badgeText: `Model listed twice: ${id}`,
      provider: 'codex',
      status: 'open',
      createdAt: now,
    })
  }
  for (const m of result.missing) {
    if (duplicated.has(m.id)) continue
    const name = m.label ?? m.id
    out.push({
      id: `models:codex-missing:${m.id}`,
      kind: 'compat',
      severity: 'warn',
      title: `Codex offers ${name}, but it is not in the model picker`,
      evidence: `${m.id} is in ${shipped}; resources/model-registry.json has no Codex entry for it.`,
      affectedFeature: 'sessions',
      badgeText: `New Codex model: ${name}`,
      provider: 'codex',
      status: 'open',
      createdAt: now,
    })
  }
  for (const m of result.extra) {
    // Not listed YET by the installed Codex (the shipped list has it only from
    // a later version): new, not retired, so nothing is said.
    if (liveList && listedOnlyAfter(expected, m.id, liveList.version)) continue
    const name = m.label ?? m.id
    out.push({
      id: `models:codex-retired:${m.id}`,
      kind: 'compat',
      severity: 'warn',
      title: liveList ? `${name} is still selectable but Codex ${liveList.version} no longer lists it` : `${name} is still selectable but Codex no longer lists it`,
      evidence: `resources/model-registry.json carries ${m.id} as a Codex model; ${shipped} does not. Retired or renamed?`,
      affectedFeature: 'sessions',
      badgeText: `Possibly retired: ${name}`,
      provider: 'codex',
      status: 'open',
      createdAt: now,
    })
  }
  // The shipped list going stale matters only when it was relied on: a live
  // read has just answered the question first-hand.
  const age = fixtureAgeDays(expected?.fetchedAt, now)
  if (!liveList && age !== null && age > FIXTURE_STALE_DAYS) {
    out.push({
      id: `models:codex-list-stale:${expected?.fetchedAt}`,
      kind: 'info',
      severity: 'info',
      title: 'The Codex model list has not been re-checked in a while',
      evidence: `resources/codex-model-catalogue.json was read ${age} days ago (${expected?.fetchedAt}). Read the model catalogue of the supported Codex CLI again and refresh it.`,
      provider: 'codex',
      status: 'open',
      createdAt: now,
    })
  }
  return out
}

/** The finding raised when the check itself throws, so it cannot fail silently. */
export function modelCheckFailedFinding(message: string, now: number = Date.now()): SentinelFinding {
  return {
    id: MODEL_CHECK_FAILED_ID,
    kind: 'compat',
    severity: 'warn',
    title: 'The Claude Code model list could not be verified',
    evidence: `The model-registry check did not complete: ${message}`,
    badgeText: 'Model list unverified',
    status: 'open',
    createdAt: now,
  }
}

// -- Closing model findings the check no longer stands behind (O8) ----------
//
// A model finding is raised once and kept by its id (SentinelState.upsertFinding
// never replaces one; it only refreshes an open one's evidence), so nothing
// used to close it when its cause went away:
// the "not in the model picker" notices an earlier build raised for Opus,
// Sonnet and Haiku 5.5 stayed open after an update added all three, keeping
// the chip amber at every launch. These pure helpers name the OPEN model
// findings to close; the caller hands them to SentinelState.retireOpen, which
// keeps a muted or dismissed one (the user's choice holds). Nothing here closes
// a finding the run in hand has just raised.
//
// A notice a live read can raise ("not in the model picker", a Codex model
// "no longer listed") closes only on evidence that its claim is now false (the
// registry covers it, or a live read says otherwise), never because an offline
// run did not repeat it, so it does not come and go with the network. A
// finding that comes from the list shipped with this build alone (unreadable,
// stale, and the Claude half's retired arm) closes once a completed check no
// longer raises it: that list is fixed for a build, so it cannot flap.

const MISSING = 'models:missing:'
const RETIRED = 'models:retired:'
const FIXTURE_UNREADABLE = 'models:fixture-unreadable'
const FIXTURE_STALE = 'models:fixture-stale:'
const CODEX_MISSING = 'models:codex-missing:'
const CODEX_DUPLICATE = 'models:codex-duplicate:'
const CODEX_RETIRED = 'models:codex-retired:'
const CODEX_LIST_UNREADABLE = 'models:codex-list-unreadable'
const CODEX_LIST_STALE = 'models:codex-list-stale:'

type FindingLike = Pick<SentinelFinding, 'id' | 'status'>

/** The ids after `prefix` of the open findings that carry it. */
function openModelIds(findings: readonly FindingLike[], prefix: string): string[] {
  return findings.filter((f) => f.status === 'open' && f.id.startsWith(prefix)).map((f) => f.id.slice(prefix.length))
}

/**
 * The open `models:missing:<id>` findings that an entry of `registry` now
 * covers (registryIdCovers, the check's own rule): the model is in the picker,
 * so "it is not in the model picker" is false. Needs the registry only, not the
 * article, so the caller runs it BEFORE the article read (up to 10 s): the
 * first start of a build that added a model, and a Re-run, close its notice at
 * once.
 */
export function registryCoveredModelFindingIds(findings: readonly FindingLike[], registry: ModelRegistry): string[] {
  const ids = openModelIds(findings, MISSING)
  if (ids.length === 0) return []
  const covered = new Set(evaluateModelCoverage(registry, { models: ids.map((id) => ({ id })) }).covered.map((c) => c.id))
  return ids.filter((id) => covered.has(id)).map((id) => `${MISSING}${id}`)
}

/**
 * After a COMPLETED check of the Claude half: the open model findings it no
 * longer stands behind. `current` is what the run raised; `liveIds` the
 * article ids it read (null: snapshot mode).
 *
 *  - models:missing:<id>  the registry covers <id> now; or, in live mode only,
 *                         the article no longer lists <id> and neither does
 *                         the snapshot shipped with this build (an id the
 *                         article dropped before the app ever added it).
 *  - models:retired:<id>  not raised again, by a run that compared (a run that
 *                         found the snapshot unreadable never reached that arm).
 *  - models:fixture-unreadable, models:check-failed  not raised again.
 *  - models:fixture-stale:<date>  the snapshot shipped now has another date.
 */
export function staleModelFindingIds(
  findings: readonly FindingLike[],
  registry: ModelRegistry,
  current: readonly FindingLike[],
  expected: ExpectedModelSet | null | undefined,
  liveIds: readonly string[] | null,
): string[] {
  const raised = new Set(current.map((f) => f.id))
  const compared = !raised.has(FIXTURE_UNREADABLE)
  const live = compared && Array.isArray(liveIds) && liveIds.length >= MIN_PLAUSIBLE_IDS ? new Set(liveIds) : null
  const shipped = new Set((Array.isArray(expected?.models) ? expected!.models : []).map((m) => m?.id))
  const covered = new Set(registryCoveredModelFindingIds(findings, registry))
  const stale = (id: string): boolean => {
    if (id.startsWith(MISSING)) {
      const model = id.slice(MISSING.length)
      return covered.has(id) || (live !== null && !live.has(model) && !shipped.has(model))
    }
    if (id.startsWith(RETIRED)) return compared
    if (id === FIXTURE_UNREADABLE || id === MODEL_CHECK_FAILED_ID) return true
    if (id.startsWith(FIXTURE_STALE)) return id.slice(FIXTURE_STALE.length) !== String(expected?.fetchedAt)
    return false
  }
  return findings.filter((f) => f.status === 'open' && !raised.has(f.id) && stale(f.id)).map((f) => f.id)
}

/**
 * The Codex half, by the same rule, after a COMPLETED check. `live` is the
 * installed CLI's own list read this run (null: the shipped list answered).
 *
 *  - models:codex-missing:<id>    the registry now has exactly one pickable
 *                                 Codex entry with <id>; or a live list was
 *                                 read and neither it nor the shipped list
 *                                 names <id>.
 *  - models:codex-duplicate:<id>  the registry no longer lists <id> twice.
 *  - models:codex-retired:<id>    the registry no longer carries <id> as a
 *                                 Codex model of its own; or a live list was
 *                                 read and names <id> (that version offers it),
 *                                 or comes from a version older than every one
 *                                 the shipped list names <id> for (it has not
 *                                 listed <id> yet, so <id> is new, not retired).
 *  - models:codex-list-unreadable, models:codex-check-failed  not raised again.
 *  - models:codex-list-stale:<date>  the shipped list now has another date.
 */
export function staleCodexModelFindingIds(
  findings: readonly FindingLike[],
  registry: ModelRegistry,
  current: readonly FindingLike[],
  expected: ExpectedModelSet | null | undefined,
  live: CodexLiveModelList | null,
): string[] {
  const raised = new Set(current.map((f) => f.id))
  const compared = !raised.has(CODEX_LIST_UNREADABLE)
  const liveList = compared ? usableCodexLiveList(live) : null
  const liveIds = liveList ? new Set(liveList.models.map((m) => m?.id)) : null
  const shipped = new Set((Array.isArray(expected?.models) ? expected!.models : []).map((m) => m?.id))
  // The registry's own answer for every model these findings name, by the
  // check's rule (evaluateCodexModelCoverage): covered by one pickable Codex
  // entry, or listed more than once.
  const named = [...new Set([CODEX_MISSING, CODEX_DUPLICATE, CODEX_RETIRED].flatMap((p) => openModelIds(findings, p)))]
  const answer = named.length ? evaluateCodexModelCoverage(registry, { models: named.map((id) => ({ id })) }) : null
  const covered = new Set(answer?.covered.map((c) => c.id) ?? [])
  const duplicated = new Set(answer?.duplicates ?? [])
  const overlay = new Set((Array.isArray(registry?.models) ? registry.models : []).filter((m) => !!m && isOverlaySourced(m)).map((m) => m.id))
  const stale = (id: string): boolean => {
    if (id.startsWith(CODEX_MISSING)) {
      const model = id.slice(CODEX_MISSING.length)
      return covered.has(model) || (liveIds !== null && !liveIds.has(model) && !shipped.has(model))
    }
    if (id.startsWith(CODEX_DUPLICATE)) return !duplicated.has(id.slice(CODEX_DUPLICATE.length))
    if (id.startsWith(CODEX_RETIRED)) {
      const model = id.slice(CODEX_RETIRED.length)
      return !covered.has(model) || overlay.has(model)
        || (liveList !== null && (liveIds!.has(model) || listedOnlyAfter(expected, model, liveList.version)))
    }
    if (id === CODEX_LIST_UNREADABLE || id === CODEX_MODEL_CHECK_FAILED_ID) return true
    if (id.startsWith(CODEX_LIST_STALE)) return id.slice(CODEX_LIST_STALE.length) !== String(expected?.fetchedAt)
    return false
  }
  return findings.filter((f) => f.status === 'open' && !raised.has(f.id) && stale(f.id)).map((f) => f.id)
}
