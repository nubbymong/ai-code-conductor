/**
 * The session helper's place in the app: made once from the saved setting,
 * plugged into the Machines page (setMachinesSource), switched by Settings,
 * told which tabs are saved, and ended at a normal quit. index.ts calls these
 * and nothing else of the helper.
 */
import { app } from 'electron'
import { readConfig } from '../config-manager'
import { logInfo } from '../debug-logger'
import { setMachinesSource } from '../ipc/machines-handlers'
import { bundledHelperPath, helperRootDir } from './install'
import { SessionHelperManager, getSessionHelper, setSessionHelper, type SessionHelperServiceState } from './manager'

/** The setting (Settings, General): off unless saved as true. */
export const PLAIN_TERMINALS_SETTING = 'plainTerminalsThroughHelper'

export function plainTerminalsThroughHelperIn(settings: unknown): boolean {
  return !!settings && typeof settings === 'object' && (settings as Record<string, unknown>)[PLAIN_TERMINALS_SETTING] === true
}

function settingOn(): boolean {
  try {
    return plainTerminalsThroughHelperIn(readConfig<Record<string, unknown>>('settings'))
  } catch {
    return false
  }
}

let notify: (() => void) | null = null

function ensureManager(): SessionHelperManager {
  const existing = getSessionHelper()
  if (existing) return existing
  const m = new SessionHelperManager({
    root: helperRootDir({ isPackaged: app.isPackaged }),
    bundled: bundledHelperPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    log: (message) => logInfo(message),
  })
  m.onChange(() => notify?.())
  setSessionHelper(m)
  setMachinesSource(m)
  return m
}

/** At start-up: with the setting on, the helper comes up and any terminal a
 *  crash left held is kept for its tab. Off: nothing is made. */
export function initSessionHelper(onChange: () => void): void {
  notify = onChange
  if (!settingOn()) return
  void ensureManager().start({ atStartup: true })
}

/** After a settings save: the switch applies to the next terminal at once. */
export function applySessionHelperSettings(): void {
  if (settingOn()) {
    const m = ensureManager()
    if (!m.isEnabled()) void m.start({ atStartup: false })
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

/** At a normal quit, after every PTY was killed. */
export function shutdownSessionHelper(): void {
  getSessionHelper()?.shutdown()
}

/** The Services row's reading; null when the helper was never switched on this run. */
export function sessionHelperServiceState(): SessionHelperServiceState | null {
  return getSessionHelper()?.serviceState() ?? null
}
