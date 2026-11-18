/**
 * The session helper's place in the app: made once from the saved setting,
 * plugged into the Machines page (setMachinesSource), switched by Settings,
 * told which tabs are saved, and ended at a normal quit. index.ts calls these
 * and nothing else of the helper; update-handlers.ts calls the two for an app
 * update on Windows.
 */
import { app } from 'electron'
import { readConfig } from '../config-manager'
import { logInfo } from '../debug-logger'
import { setMachinesSource } from '../ipc/machines-handlers'
import { peekSessionState } from '../session-state'
import { bundledHelperPath, helperRootDir } from './install'
import { SessionHelperManager, agentRecordsIn, crashMarkIn, getSessionHelper, setSessionHelper, type HelperRouting, type SessionHelperServiceState } from './manager'

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

let notify: (() => void) | null = null

const rootDir = (): string => helperRootDir({ isPackaged: app.isPackaged })

function ensureManager(): SessionHelperManager {
  const existing = getSessionHelper()
  if (existing) return existing
  const m = new SessionHelperManager({
    root: rootDir(),
    bundled: bundledHelperPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    log: (message) => logInfo(message),
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
 * held (a quit that could not wait for its end). Then the helper comes up
 * all the same, carrying nothing new, to end those agent sessions before
 * their tabs start their CLIs again (and keep a crash's plain terminals for
 * their tabs).
 */
export function initSessionHelper(onChange: () => void): void {
  notify = onChange
  const { plain, agents } = routing()
  if (!plain && !agents && !crashMarkIn(rootDir()) && !agentRecordsIn(rootDir())) return
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
 * let go of instead of ended, for the new version to show again. Those tabs
 * are read from the saved file itself, because "Close without saving" clears
 * it without a save the manager hears of. A file that cannot be read lets go
 * of nothing, and every terminal ends as before. What the manager ends instead
 * (kept after an earlier update that did not start, for a tab no longer
 * saved) is waited for, UPDATE_END_WAIT_MS at most, since the app exits next.
 * Nothing is done when the helper was never switched on this run. Answers how
 * many were let go of.
 */
export async function releaseHeldTerminalsForUpdate(): Promise<number> {
  const m = getSessionHelper()
  if (!m) return 0
  let restorable = new Set<string>()
  try {
    const sessions = peekSessionState()?.sessions ?? []
    restorable = new Set(sessions.map((s) => s?.id).filter((id): id is string => typeof id === 'string'))
  } catch {
    /* unreadable: nothing is let go of */
  }
  const n = m.releaseForUpdate(restorable)
  let timer: NodeJS.Timeout | undefined
  await Promise.race([m.endsForUpdate(), new Promise<void>((r) => { timer = setTimeout(r, UPDATE_END_WAIT_MS) })]).finally(() => clearTimeout(timer))
  return n
}

/** How long an update waits for the ends releaseHeldTerminalsForUpdate sent (a quit's own bound). */
export const UPDATE_END_WAIT_MS = 1500

/** The update's installer could not be started: what was let go of is kept
 *  for its tab, and listed on the Machines page. */
export function reclaimReleasedTerminals(): void {
  getSessionHelper()?.reclaim()
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
