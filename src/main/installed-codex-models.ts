// The Codex model picker's own list (aicc_planning#362): the models the
// installed Codex lists in its own picker, read from it (`codex debug models
// --bundled`, the Codex package's model-catalogue.ts, through the accounts
// service's readModelCatalogue, which applies main's launch rule and runs
// only the executable discovery proved, in no account's folder), handed to
// the model registry as its last layer (model-registry-service.ts,
// setInstalledCodexModels). Every reader of the registry then sees those
// models with their own reasoning levels: the Codex pickers in the renderer,
// the Codex launch's effort check in main (pty-handlers.ts) and Sentinel. So
// a model a Codex release adds is offered with no app release. No list
// (Codex off or not found, a version the app cannot use, a read that failed):
// the registry alone, as before.
//
// When it is read: each time what the accounts service found of Codex
// changes (its look at start, Check again, Codex switched on, another version
// found; followInstalledCodexModels), and when Sentinel's Codex check asks
// (Sentinel reads through here, so a start runs one read, not two). A read
// counts as Codex in use from the step that starts it to its end
// (provider-in-use.ts), so a switch-off either sees it or refuses it.
import type { AccountsService } from './providers/core'
import type { InstalledCodexModels } from '../shared/model-registry'
import type { ProviderId } from '../shared/providers'
import { setInstalledCodexModels } from './model-registry-service'
import { logInfo } from './debug-logger'

/** The provider whose list this is, as the accounts service names it. */
const CODEX_PROVIDER: ProviderId = 'codex'

/** What a read answers: the accounts service's own result. */
export type CodexModelListAnswer = Awaited<ReturnType<AccountsService['readModelCatalogue']>>

type Reader = Pick<AccountsService, 'readModelCatalogue'>
type Followed = Reader & Pick<AccountsService, 'snapshot' | 'subscribe'>

/** Said in place of a read that threw (readModelCatalogue never throws). */
const READ_FAILED: CodexModelListAnswer = { ok: true, catalogue: { ok: false, code: 'failed', detail: 'the model list could not be read' } }

/** Per accounts service: the read in flight, the last answer, and which
 *  follower decision a read belongs to (a later decision drops its answer). */
interface ReadState { inFlight: Promise<CodexModelListAnswer> | null; last: CodexModelListAnswer | null; decision: number }
const states = new WeakMap<object, ReadState>()
let reading = 0

function stateOf(svc: object): ReadState {
  let st = states.get(svc)
  if (!st) { st = { inFlight: null, last: null, decision: 0 }; states.set(svc, st) }
  return st
}

/** Reads of the installed Codex's model list in flight: Codex in use for the
 *  switch-off rule (provider-in-use.ts). */
export function installedCodexModelReadsInFlight(): number {
  return reading
}

/** The list an answer gives the picker, or null when it gives none. */
export function installedCodexModelsOf(answer: CodexModelListAnswer | null | undefined): InstalledCodexModels | null {
  if (!answer || !answer.ok || !answer.catalogue || !answer.catalogue.ok) return null
  return { version: answer.catalogue.version, models: answer.catalogue.models }
}

/** Why an answer gives no list, as one short word for the log. */
function noListReason(answer: CodexModelListAnswer | null): string {
  if (!answer) return 'Codex is off or was not found'
  return answer.ok ? (answer.catalogue.ok ? 'ok' : answer.catalogue.code) : answer.code
}

/** Hand a list (or none) to the registry, and say so once when it changes. */
function publish(list: InstalledCodexModels | null, why: string): void {
  if (!setInstalledCodexModels(list)) return
  logInfo(list
    ? `[registry] the Codex model picker offers the ${list.models.length} models Codex ${list.version} lists`
    : `[registry] the Codex model picker offers the model registry's Codex models (no list from the installed Codex: ${why})`)
}

/**
 * Read the installed Codex's model list and hand it to the registry; the
 * answer is returned as the accounts service gave it (Sentinel's check
 * reads it). A read already in flight is joined. `fresh: false` (Sentinel's
 * start-up check) takes the last answer when there is one: the follower read
 * it when Codex was found. Never rejects.
 */
export function readInstalledCodexModels(svc: Reader, opts: { fresh: boolean }): Promise<CodexModelListAnswer> {
  const st = stateOf(svc)
  if (st.inFlight) return st.inFlight
  if (!opts.fresh && st.last) return Promise.resolve(st.last)
  const decision = st.decision
  // Counted before the call, whose first step is the launch rule: a
  // switch-off made before this line is refused there, one made after it
  // sees the read in use.
  reading++
  let call: Promise<CodexModelListAnswer>
  try { call = Promise.resolve(svc.readModelCatalogue(CODEX_PROVIDER)) } catch { call = Promise.resolve(READ_FAILED) }
  const done: Promise<CodexModelListAnswer> = call
    .then((answer) => answer ?? READ_FAILED, () => READ_FAILED)
    .then((answer) => {
      // A later decision (Codex switched off, or another version found)
      // has overtaken this read: its answer is not this Codex's now.
      if (st.decision === decision) {
        st.last = answer
        publish(installedCodexModelsOf(answer), noListReason(answer))
      }
      return answer
    })
    .finally(() => {
      reading--
      if (st.inFlight === done) st.inFlight = null
    })
  st.inFlight = done
  return done
}

/**
 * Keep the registry's Codex list in step with what the accounts service
 * finds of Codex: read it when Codex is on and found (again when its version,
 * or its standing, changes), and drop it when Codex is switched off or no
 * longer found. Changes are taken once per turn, as the window's own copy of
 * the snapshot is. Returns the unsubscribe.
 */
export function followInstalledCodexModels(svc: Followed | null): () => void {
  if (!svc) return () => {}
  const st = stateOf(svc)
  let seen: string | null = null
  let queued = false
  const check = (): void => {
    queued = false
    let codex: ReturnType<Followed['snapshot']>['providers'][number] | null
    try {
      codex = new Map(svc.snapshot().providers.map((p) => [p.providerId, p])).get(CODEX_PROVIDER) ?? null
    } catch {
      return
    }
    const key = codex ? `${codex.enabled}|${codex.discoveryState}|${codex.version ?? ''}|${codex.compatibility}` : 'none'
    if (key === seen) return
    seen = key
    // Not looked for yet: its look will come, and the list with it.
    if (codex && codex.enabled && codex.discoveryState === 'unchecked') return
    st.decision++
    st.last = null
    if (codex && codex.enabled && codex.discoveryState === 'found') {
      const pending = st.inFlight
      if (!pending) { void readInstalledCodexModels(svc, { fresh: true }); return }
      // A read in flight began before this decision (Sentinel's start-up
      // check can ask before the look for Codex ends; its read then waits
      // for that look). An answer for the version now found is this Codex's
      // list and is taken as this decision's read, so a start runs one read;
      // any other answer is read again.
      const mine = st.decision
      const version = codex.version
      void pending.then((answer) => {
        if (st.decision !== mine) return
        const list = installedCodexModelsOf(answer)
        if (list && list.version === version) { st.last = answer; publish(list, 'ok') }
        else void readInstalledCodexModels(svc, { fresh: true })
      })
      return
    }
    publish(null, codex && !codex.enabled ? 'Codex is off' : 'Codex was not found')
  }
  const changed = (): void => {
    if (queued) return
    queued = true
    setImmediate(check)
  }
  let unsubscribe: () => void = () => {}
  try { unsubscribe = svc.subscribe(changed) } catch { /* nothing to follow */ }
  changed()
  return unsubscribe
}
