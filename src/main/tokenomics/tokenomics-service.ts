import { join } from 'node:path'
import { homedir } from 'node:os'
import { TokenomicsSupervisor } from './tk-supervisor'
import { forkTokenomicsWorker, appProcessMetrics } from './fork-tokenomics-worker'
import { getAllPricing, fetchModelPricing } from './tk-pricing'
import { readConfig, readConfigChecked } from '../config-manager'
import { onRegistryReload } from '../model-registry-service'
import { getDataDirectory, getResourcesDirectory } from '../data-paths'
import type { TkConfigDim, TkSessionsRoot, TkAccountKey } from './tk-types'
import { TK_CODEX_EXTERNAL, TK_SESSION_ACCOUNTS_KEPT, tkAccountKey, tkExcludedAccounts, tkSessionUuidOk, tkClaudeAccountKeyOk } from './tk-types'
import { getAccountsService } from '../provider-accounts'
import { logError, logWarn } from '../debug-logger'

/**
 * Reserved attribution id for the Ask Conductor help session (#465). Its spend
 * is real but it is not project work, so it must not pollute the "External /
 * no config" bucket the cost views use for unrecognised spend. The help
 * session's cwd is the staged `<resources>/help` workspace, so a synthetic
 * config dim pointing there lets the ordinary cwd->config matcher file it
 * under its own labeled row. Saved-config ids are crypto-random hex
 * (shared/id.ts), so this literal can never collide with one.
 */
export const TK_HELP_CONFIG_ID = '__ask-help__'

let _sup: TokenomicsSupervisor | null = null
let _unsubReload: (() => void) | null = null
let _unsubAccounts: (() => void) | null = null

// Tokenomics is an optional service (2.1.3-beta.4). Settings holds its
// switch (`tokenomicsEnabled`, on unless it is exactly false) and the
// accounts its figures leave out (`tokenomicsExcludedAccounts`). Off, no
// supervisor exists: no worker is forked and nothing beside it runs (no
// pricing refresh for it, no registry reload listener, no account folder
// following), and getTokenomicsSupervisor() answers null. What was recorded
// stays in the database, and the worker keeps each file's progress there, so
// switching it on, at start-up or later, reads only what was written since.

/** How the app started the service (index.ts), kept so the switch can start
 *  it later. Null before that and after quit. */
let _emit: ((channel: string, payload: unknown) => void) | null = null
/** The switch as last read from the saved settings. */
let _enabled = true
/** The accounts the figures leave out, as last read. */
let _excluded: TkAccountKey[] = []
/** A read of the saved settings has given an answer since the app came up. */
let _settingsRead = false
/** The log has said the saved settings cannot be read: once, until they can. */
let _unreadableLogged = false
/** Told of every supervisor as it starts: the IPC layer forwards its pushes. */
const _startSubs = new Set<(sup: TokenomicsSupervisor) => void>()
/** Session attributions for the next supervisor: the ones a stopped one
 *  still held, and the ones made while none ran (Tokenomics switched off,
 *  or not started yet). The latest per session, the oldest dropped past the
 *  supervisor's own bound. */
const _keptSessionAccounts = new Map<string, TkAccountKey>()

/** The Tokenomics switch in a saved settings object: on unless it is exactly
 *  false, so settings saved before the switch existed read as on. Settings
 *  that cannot be read are not an object to ask (readSavedSettings). */
export function tokenomicsEnabledIn(settings: unknown): boolean {
  return !(settings && typeof settings === 'object' && (settings as { tokenomicsEnabled?: unknown }).tokenomicsEnabled === false)
}

/** The saved settings, or null when they cannot be read (never "none"): the
 *  rule the provider switches follow (provider-accounts.ts readSettings). No
 *  settings file yet is a fresh install and reads as empty; a file that is
 *  there but cannot be read or parsed, or holds no object, is no answer. The
 *  file is never moved aside from here. */
function readSavedSettings(): Record<string, unknown> | null {
  try {
    const r = readConfigChecked<Record<string, unknown>>('settings', { quarantineUnparseable: false })
    if (r.outcome === 'absent') return {}
    if (r.outcome !== 'ok' || !r.value || typeof r.value !== 'object') return null
    return r.value
  } catch {
    // A reader that throws has read nothing.
    return null
  }
}

/** Whose sessions a Codex folder holds (usage track MP9): this computer's own
 *  home is `codex:external`, an account's realm `codex:<accountId>`, and a
 *  realm no account owns yet is not recorded. */
export function codexSessionsRoot(r: { dir: string; accountId: string | null; external: boolean }): TkSessionsRoot {
  return { dir: r.dir, accountKey: r.external ? TK_CODEX_EXTERNAL : tkAccountKey('codex', r.accountId) }
}

/** WP2 (plan A13): each Codex account runs in its own realm and writes its
 *  transcripts there, so the index follows those folders as accounts are
 *  added, removed or signed out, beside the user's own ~/.codex. Each folder
 *  goes with its account's key (MP9). */
function followCodexRealmDirs(): void {
  const svc = getAccountsService()
  // MP9 round 1 (Q-4): the index settles its one-off attribution only once
  // it has been told the account folders, so it is told "none" when there
  // is no accounts service to ask.
  if (!svc) { _sup?.setCodexRealmSessionsDirs([]); return }
  let lastKey = ''
  let running = false
  let again = false
  const refresh = async (): Promise<void> => {
    if (running) { again = true; return }
    running = true
    try {
      do {
        again = false
        const roots = await svc.sessionsRoots('codex')
        // The registry not read yet: nothing is named until it is (lens B).
        if (roots === null) continue
        const dirs = roots.map(codexSessionsRoot)
        const key = JSON.stringify(dirs)
        if (key !== lastKey) { lastKey = key; _sup?.setCodexRealmSessionsDirs(dirs) }
      } while (again)
    } catch (err) {
      logError(`[tokenomics] Codex account folders not refreshed: ${(err as Error)?.message ?? err}`)
      // Never named yet: none for now (Q-4), so the index is not held back;
      // a later refresh names them.
      if (lastKey === '') { lastKey = '[]'; _sup?.setCodexRealmSessionsDirs([]) }
    } finally {
      running = false
    }
  }
  _unsubAccounts = svc.subscribe(() => { void refresh() })
  void refresh()
}

// Minimal shape of a saved config we attribute usage to. Defined locally rather
// than importing the renderer-store `TerminalConfig` (main must not import from
// the renderer; only these three fields are needed here).
interface SavedConfigRecord { id: string; label: string; workingDirectory?: string }

function loadConfigDims(): TkConfigDim[] {
  const configs = readConfig<SavedConfigRecord[]>('configs') ?? []
  const dims = configs
    .filter((c): c is SavedConfigRecord & { workingDirectory: string } => !!c.workingDirectory)
    .map((c) => ({ configId: c.id, label: c.label, workingDirectory: c.workingDirectory }))
  // Ask Conductor 'help' bucket (#465). The matcher is longest-prefix, so this
  // synthetic dim only ever claims spend from inside `<resources>/help` itself;
  // it cannot shadow a real config (and getResourcesDirectory never throws —
  // it falls back under the data directory before the user picks one). Known
  // edge, shared with every saved config: the worker's isJunkCwd runs first,
  // so a resources dir under a junk-flagged segment (temp/, windows/) sends
  // this spend to "External / no config" instead. Fails safe, never wrong.
  dims.push({ configId: TK_HELP_CONFIG_ID, label: 'Ask Conductor', workingDirectory: join(getResourcesDirectory(), 'help') })
  return dims
}

/** Start the service as the app comes up. With the switch off nothing
 *  starts; the call is remembered, so the switch can start it later. */
export function initTokenomics(opts: { emit: (channel: string, payload: unknown) => void }): void {
  _emit = opts.emit
  applyTokenomicsSettings()
}

/** Read the saved settings and make the service match them: called as the
 *  app comes up and each time the settings are saved. Off stops the worker
 *  and what runs beside it; on starts them when they are not running. The
 *  accounts left out apply to the next query. Does nothing to a service the
 *  app has not started yet, or has shut down. */
export function applyTokenomicsSettings(): void {
  const settings = readSavedSettings()
  if (settings !== null) {
    _settingsRead = true
    _unreadableLogged = false
    _enabled = tokenomicsEnabledIn(settings)
    _excluded = tkExcludedAccounts(settings.tokenomicsExcludedAccounts)
  } else {
    // No answer. The last values read stand, as a provider's saved switch
    // does (accounts-service savedPreference): a running worker is not
    // stopped, a stopped one is not started, and the accounts left out stay
    // left out. With nothing read yet, no answer is never a yes: it does
    // not start until a later read gives one.
    if (!_settingsRead) { _enabled = false; _excluded = [] }
    if (!_unreadableLogged) {
      _unreadableLogged = true
      logWarn(`[tokenomics] the saved settings could not be read: ${_settingsRead ? 'it stays as it was last set' : 'it is not started'} until they can be`)
    }
  }
  if (!_enabled) { stopTokenomics(); return }
  if (_emit) startTokenomics(_emit)
}

function startTokenomics(emit: (channel: string, payload: unknown) => void): void {
  if (_sup) return
  // Best-effort pricing refresh (LiteLLM 24h cache); never block startup.
  void fetchModelPricing().catch(() => {})
  const sup = new TokenomicsSupervisor({
    forkChild: forkTokenomicsWorker,
    dbPath: join(getDataDirectory(), 'tokenomics.db'),
    pricing: getAllPricing(),
    configs: loadConfigDims(),
    claudeProjectsDir: join(homedir(), '.claude', 'projects'),
    codexSessionsDir: join(homedir(), '.codex', 'sessions'),
    sessionAccounts: _keptSessionAccounts,
    emit,
    // 2.1.3-beta.4: the worker's CPU share on its Services row. Asked only
    // when the row is read, and at most once in 5 s.
    processMetrics: () => appProcessMetrics(),
  })
  // Before the fork, so a push from the very first message is forwarded.
  for (const cb of _startSubs) { try { cb(sup) } catch (err) { logError(`[tokenomics] a start listener failed: ${(err as Error)?.message ?? err}`) } }
  // Set before the fork, so the Services row pushed as the worker comes up
  // is read through the registry.
  _sup = sup
  sup.start()
  // The supervisor keeps them as its own from here.
  _keptSessionAccounts.clear()
  // Once the LiteLLM fetch settles, push refreshed pricing into the worker.
  void fetchModelPricing().then(() => { _sup?.setPricing(getAllPricing()) }).catch(() => {})
  // Registry hot-reload must reach the worker's pricing CTE (spec §4 consumer 2).
  _unsubReload = onRegistryReload(() => { _sup?.setPricing(getAllPricing()) })
  followCodexRealmDirs()
}

/** Stop the worker and everything started beside it. The database and each
 *  file's progress in it stay as they are. */
function stopTokenomics(): void {
  if (_sup) {
    _keptSessionAccounts.clear()
    for (const [sessionId, accountKey] of _sup.keptSessionAccounts()) _keptSessionAccounts.set(sessionId, accountKey)
  }
  _sup?.shutdown(); _sup = null
  _unsubReload?.(); _unsubReload = null
  _unsubAccounts?.(); _unsubAccounts = null
}

/** The running supervisor, or null: Tokenomics is switched off, has not
 *  been started yet, or has been shut down. Every caller copes with null. */
export function getTokenomicsSupervisor(): TokenomicsSupervisor | null { return _sup }

/** True when Tokenomics is off: the saved setting switches it off, or the
 *  saved settings have not been readable since the app came up. */
export function isTokenomicsOff(): boolean { return !_enabled }

/** A Claude session and the account it runs under now (usage track MP10),
 *  from the transcript attribution in index.ts. With a supervisor it goes to
 *  the usage index. With none (Tokenomics switched off, or not started yet)
 *  it is kept for the next one, so a session that runs and ends while
 *  Tokenomics is off is still recorded to its account when the catch-up
 *  reads it. Kept in memory for this run of the app: the latest per
 *  session, the oldest dropped past the bound; nothing is read or written
 *  for it. False only when the pair is not well formed. */
export function noteTokenomicsSessionAccount(sessionId: string, accountKey: TkAccountKey): boolean {
  if (_sup) { _sup.setSessionAccount(sessionId, accountKey); return true }
  if (!tkSessionUuidOk(sessionId) || !tkClaudeAccountKeyOk(accountKey)) return false
  _keptSessionAccounts.delete(sessionId)
  _keptSessionAccounts.set(sessionId, accountKey)
  if (_keptSessionAccounts.size > TK_SESSION_ACCOUNTS_KEPT) {
    const oldest = _keptSessionAccounts.keys().next()
    if (!oldest.done) _keptSessionAccounts.delete(oldest.value)
  }
  return true
}

/** The accounts whose usage the figures leave out (Settings). */
export function tokenomicsExcludedAccounts(): TkAccountKey[] { return [..._excluded] }

/** Be told of every supervisor as it starts: the one running now, at once,
 *  and each one started later (Tokenomics switched on while the app runs).
 *  A stopped supervisor's listeners go with it. Returns an unsubscribe. */
export function onTokenomicsStart(cb: (sup: TokenomicsSupervisor) => void): () => void {
  _startSubs.add(cb)
  if (_sup) cb(_sup)
  return () => { _startSubs.delete(cb) }
}

/** Push the current saved-config dimension to the worker (call after config edits). */
export function refreshTokenomicsConfigs(): void { _sup?.setConfigs(loadConfigDims()) }

/** The app is quitting: stop, and let no saved setting start it again. */
export function shutdownTokenomics(): void {
  stopTokenomics()
  _emit = null
  _keptSessionAccounts.clear()
  _settingsRead = false
  _unreadableLogged = false
}
