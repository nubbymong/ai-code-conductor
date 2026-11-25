/**
 * The session helper's place in the app: made once from the saved setting,
 * plugged into the Machines page (setMachinesSource), switched by Settings,
 * told which tabs are saved, and ended at a normal quit. index.ts calls these
 * and nothing else of the helper; update-handlers.ts calls the two for an app
 * update on Windows.
 */
import { app } from 'electron'
import { readConfig, readConfigChecked } from '../config-manager'
import { logInfo } from '../debug-logger'
import { setMachinesSource } from '../ipc/machines-handlers'
import { peekSessionState } from '../session-state'
import { getLocalSessionMcpConfigPath, getLocalSessionSettingsPath, switchMcpConfigToHelper } from '../hooks/per-session-settings'
import { switchHooksToHelper } from '../hooks/session-hooks-writer'
import { endHelperHooks, helperHookEvent, helperHooksTaken } from '../session-signals/hooks'
import { getConductorMcpPort, serveToolStream } from '../conductor-mcp-server'
import { tryGetProvider } from '../providers'
import type { ProviderId } from '../../shared/providers/ids'
import { bundledHelperPath, helperRootDir } from './install'
import { SessionHelperManager, agentRecordsIn, crashMarkIn, getSessionHelper, keptHookFoldersIn, keptSessionIdsIn, removeOldCopiesWithHelperOff, setSessionHelper, type HelperHookDeps, type HelperRouting, type HelperToolDeps, type SessionHelperServiceState } from './manager'

/** The settings (Settings, General, Terminal): each off unless saved as true. */
export const PLAIN_TERMINALS_SETTING = 'plainTerminalsThroughHelper'
/** 2.1.3-beta.7: local agent sessions (each provider's CLI in a tab) too. */
export const AGENT_SESSIONS_SETTING = 'agentSessionsThroughHelper'

const savedTrue = (settings: unknown, name: string): boolean =>
  !!settings && typeof settings === 'object' && (settings as Record<string, unknown>)[name] === true

export function plainTerminalsThroughHelperIn(settings: unknown): boolean {
  return savedTrue(settings, PLAIN_TERMINALS_SETTING)
}

export function agentSessionsThroughHelperIn(settings: unknown): boolean {
  return savedTrue(settings, AGENT_SESSIONS_SETTING)
}

/** Both settings as saved; an unreadable settings file reads as both off. */
function routing(): HelperRouting {
  try {
    const settings = readConfig<Record<string, unknown>>('settings')
    return { plain: plainTerminalsThroughHelperIn(settings), agents: agentSessionsThroughHelperIn(settings) }
  } catch {
    return { plain: false, agents: false }
  }
}

/**
 * True only when the settings file reads, or is not there, with both settings
 * off: the start-up clean-up of old copies asks this, not routing(), which
 * reads a file that is there and cannot be read (or does not parse) as both
 * off. Such a file removes nothing. The file is never moved aside here.
 */
function settingsReadAsBothOff(): boolean {
  try {
    const { value, outcome } = readConfigChecked<Record<string, unknown>>('settings', { quarantineUnparseable: false })
    if (outcome !== 'ok' && outcome !== 'absent') return false
    return !plainTerminalsThroughHelperIn(value) && !agentSessionsThroughHelperIn(value)
  } catch {
    return false
  }
}

let notify: (() => void) | null = null

const rootDir = (): string => helperRootDir({ isPackaged: app.isPackaged })
const bundledPath = (): string => bundledHelperPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })

/**
 * The start-up clean-up of old helper copies (2.1.3-beta.15, plan section B1,
 * aicc_planning#397), begun by a start with both settings off: null when
 * none began. A manager made later in the same run (a setting turned on)
 * makes its copy only once this has ended (its copyAfter), which alone keeps
 * that copy in every order; the clean-up also begins no removal once a
 * manager exists (asked before its listing and once after). Never rejects.
 */
let oldCopiesCleanUp: Promise<void> | null = null

async function cleanUpOldCopies(): Promise<void> {
  try {
    if (!settingsReadAsBothOff()) return
    await removeOldCopiesWithHelperOff({ root: rootDir(), bundled: bundledPath(), log: (message) => logInfo(message), stop: () => getSessionHelper() !== null })
  } catch { /* nothing more is removed; the next start tries again */ }
}

/**
 * A held session's hooks through its holder, for `provider`: while the hooks
 * gateway takes hook events (the signals module's live answer), its hooks are
 * switched to the helper's hook mode, and each event the holder passes on
 * goes to the session signals module under the tab's id, of the kinds its
 * package declares (SessionProvider.heldHookKinds) only. `how` is how its
 * hooks reach the holder:
 *  - 'settings' (Claude Code, 2.1.3-beta.8, plan section A4): the tab's
 *    per-session settings file (the one the PTY manager wrote just after the
 *    spawn call) is switched to the hook mode.
 *  - 'launch' (2.1.3-beta.18, ADR-030 S12: a CLI that runs one hook command
 *    for every session of this install, Codex's forwarder, whose trust Codex
 *    keys on the command's text): the declared kinds go in the launch its
 *    holder runs, with the hook mode's variables in its environment, which
 *    the forwarder runs the hook mode from; each event waits in its holder
 *    while no app takes it. keptOnGateway is true because that provider's
 *    take-over writes its hook file again (Codex: launch-bindings.ts
 *    codexTakeOver), so a session of it whose hook events stay on the hooks
 *    gateway is still kept at an app update. A provider added here with
 *    'launch' must have such a take-over, or its kept sessions lose their
 *    hook events.
 */
function hookDeps(provider: ProviderId, how: 'settings' | 'launch'): HelperHookDeps {
  const common: HelperHookDeps = {
    taking: () => helperHooksTaken(),
    kinds: () => tryGetProvider(provider)?.heldHookKinds,
    event: (appPtyId, e) => helperHookEvent(appPtyId, e),
    ended: (appPtyId) => endHelperHooks(appPtyId),
  }
  if (how === 'launch') return { ...common, byLaunch: true, keptOnGateway: true }
  return {
    ...common,
    useHelperHooks: (appPtyId, target) => switchHooksToHelper({ settingsPath: getLocalSessionSettingsPath(appPtyId), sessionId: appPtyId, target }),
  }
}

/**
 * A held session's Conductor tools through its holder (2.1.3-beta.11, plan
 * section B2): each tool stream its holder opens is served by the tool host
 * (conductor-mcp-server.ts serveToolStream) for the tab's session, while the
 * Conductor tools' server is started. A Claude Code session's per-session MCP
 * config file (the one the PTY manager wrote just after the spawn call) is
 * switched to the helper's relay; a Codex session's launch is given its relay
 * form by the Codex package (heldToolLaunch). 2.1.3-beta.17 (S16 step 6): a
 * stream given back to a take-over is served with `toolsChanged` for Claude
 * Code, which lists its tools again on being told (probe P20); Codex does not.
 */
const toolHost: Pick<HelperToolDeps, 'serve' | 'serving'> = {
  serve: (appPtyId, link, opts) => (opts ? serveToolStream(appPtyId, link, opts) : serveToolStream(appPtyId, link)),
  serving: () => getConductorMcpPort() > 0,
}
const helperToolDeps: Partial<Record<ProviderId, HelperToolDeps>> = {
  claude: { ...toolHost, listsAgain: true, useRelayConfig: (appPtyId, relay) => switchMcpConfigToHelper({ configPath: getLocalSessionMcpConfigPath(appPtyId), sessionId: appPtyId, relay }) },
  codex: { ...toolHost, relayLaunch: (appPtyId, launch, relay) => tryGetProvider('codex')?.heldToolLaunch?.(appPtyId, launch, relay) ?? { refused: 'no-tools' } },
}

function ensureManager(): SessionHelperManager {
  const existing = getSessionHelper()
  if (existing) return existing
  const m = new SessionHelperManager({
    root: rootDir(),
    bundled: bundledPath(),
    log: (message) => logInfo(message),
    // Claude Code's sessions by their settings file; Codex's by their launch
    // (2.1.3-beta.18). Another provider's session keeps its hooks as they are.
    hooks: { claude: hookDeps('claude', 'settings'), codex: hookDeps('codex', 'launch') },
    tools: helperToolDeps,
    // 2.1.3-beta.14 B2: Codex's composer rule reads a held session's screen
    // and title from its holder (providers/codex/session-screen.ts).
    screens: { codex: true },
    // 2.1.3-beta.17 (S16 step 5): a Claude Code or Codex session an update
    // kept running is taken over by its restored tab, when that tab is in the
    // saved file the start restores from (launch-bindings.ts takeOverKeptLaunch).
    takeOver: { claude: true, codex: true },
    savedTabs: savedTabIds,
    ...(oldCopiesCleanUp ? { copyAfter: oldCopiesCleanUp } : {}),
  })
  m.onChange(() => notify?.())
  setSessionHelper(m)
  setMachinesSource(m)
  return m
}

/**
 * At start-up: with either setting on, the helper comes up; a plain terminal
 * a crash left held is kept for its tab, and an agent session is ended (its
 * tab resumes the conversation). Both off: nothing is made, unless the last
 * run with the helper on did not quit normally, or left an agent session
 * held (a quit that could not wait for its end) or a record of one an
 * update kept running (S16 step 4). Then the helper comes up
 * all the same, carrying nothing new, to end those agent sessions before
 * their tabs start their CLIs again (and keep a crash's plain terminals for
 * their tabs). Both off with none of those: the old helper copies an earlier
 * run left are removed (2.1.3-beta.15, cleanUpOldCopies). With the agent
 * sessions' setting on, a session an update kept running whose tab is in
 * the saved file this start restores from is kept for that tab to take over
 * (2.1.3-beta.17, S16 step 5).
 */
export function initSessionHelper(onChange: () => void): void {
  notify = onChange
  const { plain, agents } = routing()
  if (!plain && !agents && !crashMarkIn(rootDir()) && !agentRecordsIn(rootDir())) {
    oldCopiesCleanUp = cleanUpOldCopies()
    return
  }
  void ensureManager().start({ atStartup: true, plain, agents })
}

/** After a settings save: each switch applies to the next terminal at once. */
export function applySessionHelperSettings(): void {
  const { plain, agents } = routing()
  if (plain || agents) {
    const m = ensureManager()
    if (!m.isEnabled()) void m.start({ atStartup: false, plain, agents })
    else m.setRouting({ plain, agents })
  } else {
    // Off: the page reads the helper as off; terminals already through it
    // keep running until their tabs close.
    getSessionHelper()?.stopRouting()
  }
}

/** The tabs the app saved (ids and names), for the Machines page. */
export function noteSessionHelperTabs(state: { sessions?: ReadonlyArray<{ id: string; label?: string; customName?: string }> } | null | undefined): void {
  getSessionHelper()?.noteSavedTabs(Array.isArray(state?.sessions) ? state!.sessions : [])
}

/**
 * An app update on Windows, just before every PTY is killed (update-handlers.ts):
 * the held plain and partner terminals whose tabs the next start restores are
 * let go of instead of ended, for the new version to show again, and so is a
 * held agent session whose tools go through its holder, recorded for the next
 * start (2.1.3-beta.14, S16 step 4: the manager's releaseForUpdate), whose
 * restored tab takes it over where its provider's take-over is wired
 * (2.1.3-beta.17, S16 step 5: takeOver above), else the start ends it. Those tabs
 * are read from the saved file itself, because "Close without saving" clears
 * it without a save the manager hears of; a cleared file, or one that cannot
 * be read, lets go of nothing (those tabs end as before).
 * `choice` is what the user chose at the update, passed on from the install
 * call: `discarded` only when they chose "Close sessions" on the update
 * dialog. Then the manager is told no set at all, so it lets go of nothing
 * and also ends the kept terminals no tab shows. Without it (Save, or an
 * update with no tab open, which shows no dialog) those kept terminals run
 * on. The choice is never read from the saved file: "Close sessions" with a
 * remote left running writes a file with no tab in it instead of clearing
 * it, and "Don't open" on the resume prompt clears it with no choice made at
 * the update (section B3). What the manager ends is waited for,
 * UPDATE_END_WAIT_MS at most, since the app exits next. Nothing is done when
 * the helper was never switched on this run. Answers how many were let go of.
 */
export async function releaseHeldTerminalsForUpdate(choice: UpdateChoice = {}): Promise<number> {
  const m = getSessionHelper()
  if (!m) return 0
  const n = m.releaseForUpdate(choice.discarded === true ? null : savedTabIds())
  let timer: NodeJS.Timeout | undefined
  await Promise.race([m.endsForUpdate(), new Promise<void>((r) => { timer = setTimeout(r, UPDATE_END_WAIT_MS) })]).finally(() => clearTimeout(timer))
  return n
}

/** What the user chose at an app update: `discarded` only for "Close sessions"
 *  on the update dialog. Nothing passed is Save. */
export interface UpdateChoice {
  discarded?: boolean
}

/** The tab ids in the saved file the next start restores from: none when the
 *  file is cleared, and none when it cannot be read. */
function savedTabIds(): Set<string> {
  try {
    const ids = (peekSessionState()?.sessions ?? []).map((s) => s?.id).filter((id): id is string => typeof id === 'string')
    return new Set(ids)
  } catch {
    return new Set()
  }
}

/** How long an update waits for what releaseHeldTerminalsForUpdate sent: its ends, and its holders' answers to a let-go (B1f). A quit's own bound. */
export const UPDATE_END_WAIT_MS = 1500

/** The update's installer could not be started: what was let go of is kept
 *  for its tab, and listed on the Machines page; an agent session let go of
 *  is ended, and what it left goes. */
export function reclaimReleasedTerminals(): void {
  getSessionHelper()?.reclaim()
}

/**
 * The tabs whose per-session files the start-up sweeps leave (index.ts;
 * 2.1.3-beta.14, S16 step 4, aicc_planning#359): those of the agent sessions
 * the helper keeps for the next run, by its records of sessions an update
 * kept running. Read from the helper's folder, so it answers with the helper
 * off too.
 */
export function sessionHelperKeptIds(): Set<string> {
  try {
    return keptSessionIdsIn(rootDir())
  } catch {
    return new Set()
  }
}

/** The Codex hook folders the same records name, for the sweep of left-behind
 *  hook folders to pass by (index.ts, the Codex hook preparation). */
export function sessionHelperKeptHookFolders(): string[] {
  try {
    return keptHookFoldersIn(rootDir())
  } catch {
    return []
  }
}

/** How long a quit waits for the holders to say they ended. */
export const QUIT_WAIT_MS = 1500

let quitWait: Promise<void> | null = null

/** At a normal quit, after every PTY was killed: the end messages go now. */
export function shutdownSessionHelper(): void {
  const ended = getSessionHelper()?.shutdown()
  if (!ended) return
  let timer: NodeJS.Timeout | undefined
  quitWait = Promise.race([ended, new Promise<void>((r) => { timer = setTimeout(r, QUIT_WAIT_MS) })]).finally(() => clearTimeout(timer))
}

/**
 * The app's will-quit: held once, for at most QUIT_WAIT_MS, while the holders
 * answer their ends, then the app exits. Nothing is held when the helper was
 * never switched on this run. Anything still not ended (a terminal that was
 * still starting) ends by its away clock, and the next start ends it too.
 */
export function holdQuitForSessionHelper(e: { preventDefault(): void }, exit: () => void = () => app.exit(0)): void {
  const wait = quitWait
  if (!wait) return
  quitWait = null
  e.preventDefault()
  void wait.then(exit, exit)
}

/** The Services row's reading; null when the helper was never switched on this run. */
export function sessionHelperServiceState(): SessionHelperServiceState | null {
  return getSessionHelper()?.serviceState() ?? null
}
