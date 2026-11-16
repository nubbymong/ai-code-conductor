import { ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  HELD_SESSION_ID,
  MACHINES_NO_ANSWER,
  type MachineActionResult,
  type MachineStatus,
  type MachinesSource,
  type SelfTestResult,
} from '../../shared/machines'
import { logWarn } from '../debug-logger'
import { appWindowSender } from './trusted-sender'

/**
 * The Machines page's IPC (2.1.3-beta.6, plan section C).
 *
 * Four doors, all answered by ONE MachinesSource that main plugs in. This file
 * is the seam: the default source below says the session helper is off and
 * holds nothing, and the helper work swaps in the real one with
 * setMachinesSource. The page never sees a rejected call: a source that throws
 * or does not answer in time reads as a helper that did not answer, in a plain
 * sentence, so a broken helper shows on the page instead of hanging it.
 *
 * Every door answers only the app's own window (trusted-sender.ts); End and
 * Re-attach also need an id of the session-id shape (HELD_SESSION_ID).
 */

/** The sentences the default source gives when the helper setting is off. The page's own
 *  Off sentence already says where to switch it on, so the status carries no detail. */
export const MACHINES_OFF_SELF_TEST = 'The session helper is off, so there is nothing to test.'
export const MACHINES_OFF_END = 'The session helper is off, so it holds no terminal to end.'
export const MACHINES_OFF_REATTACH = 'The session helper is off, so it holds no terminal to re-attach.'

/** Sentences for what goes wrong between the page and the source. The no-answer one is
 *  shared with the page (src/shared/machines.ts). */
export const MACHINES_BAD_ID = 'That is not a terminal the session helper holds.'
export const MACHINES_NOT_APP = 'Only the app window can ask the session helper.'

/** How long main waits for the source on each door before it reads the helper as silent. */
export const MACHINES_STATUS_TIMEOUT_MS = 8_000
export const MACHINES_ACTION_TIMEOUT_MS = 15_000
export const MACHINES_SELF_TEST_TIMEOUT_MS = 30_000

/** The source used until the helper work plugs a real one in: helper off, nothing held. */
export function defaultMachinesSource(): MachinesSource {
  return {
    status: async () => ({
      id: 'this-computer',
      name: 'This computer',
      helper: { state: 'off' },
      sessions: [],
    }),
    runSelfTest: async () => ({ ok: false, at: Date.now(), detail: MACHINES_OFF_SELF_TEST }),
    endSession: async () => ({ ok: false, message: MACHINES_OFF_END }),
    reattach: async () => ({ ok: false, message: MACHINES_OFF_REATTACH }),
  }
}

let current: MachinesSource = defaultMachinesSource()

/** Plug in the source the page reads from (the helper work calls this once the helper is up). */
export function setMachinesSource(source: MachinesSource): void {
  current = source
}

/** The source in use now. Read per call, so a later setMachinesSource takes effect at once. */
export function getMachinesSource(): MachinesSource {
  return current
}

function failedStatus(detail: string): MachineStatus {
  return { id: 'this-computer', name: 'This computer', helper: { state: 'failed', detail }, sessions: [] }
}

/** Run one call to the source; a throw or a silence past `ms` gives `onFail()`. */
async function answer<T>(label: string, ms: number, call: () => Promise<T>, onFail: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const silent = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('no answer in time')), ms)
    })
    return await Promise.race([call(), silent])
  } catch (err) {
    logWarn(`[machines] ${label} failed: ${err instanceof Error ? err.message : String(err)}`)
    return onFail()
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isHeldSessionId(id: unknown): id is string {
  return typeof id === 'string' && HELD_SESSION_ID.test(id)
}

/**
 * Register the four Machines doors. `getSource` is read on every call.
 * `getWindow` is required: every door answers only the app's own window, its
 * main frame, as every other handler that acts for the app does.
 */
export function registerMachinesHandlers(
  getSource: () => MachinesSource,
  getWindow: () => BrowserWindow | null,
): void {
  const trusted = appWindowSender(getWindow)
  const fromApp = (event: IpcMainInvokeEvent): boolean => trusted(event)

  ipcMain.handle(IPC.MACHINES_STATUS, async (event): Promise<MachineStatus> => {
    if (!fromApp(event)) {
      logWarn('[machines] status refused: not the app window')
      return failedStatus(MACHINES_NOT_APP)
    }
    return answer('status', MACHINES_STATUS_TIMEOUT_MS, () => getSource().status(), () => failedStatus(MACHINES_NO_ANSWER))
  })

  ipcMain.handle(IPC.MACHINES_SELF_TEST, async (event): Promise<SelfTestResult> => {
    if (!fromApp(event)) {
      logWarn('[machines] self-test refused: not the app window')
      return { ok: false, at: Date.now(), detail: MACHINES_NOT_APP }
    }
    return answer('self-test', MACHINES_SELF_TEST_TIMEOUT_MS, () => getSource().runSelfTest(), () => ({ ok: false, at: Date.now(), detail: MACHINES_NO_ANSWER }))
  })

  ipcMain.handle(IPC.MACHINES_END_SESSION, async (event, id: unknown): Promise<MachineActionResult> => {
    if (!fromApp(event)) {
      logWarn('[machines] end refused: not the app window')
      return { ok: false, message: MACHINES_NOT_APP }
    }
    if (!isHeldSessionId(id)) {
      logWarn('[machines] end refused: id not of the expected shape')
      return { ok: false, message: MACHINES_BAD_ID }
    }
    return answer('end', MACHINES_ACTION_TIMEOUT_MS, () => getSource().endSession(id), () => ({ ok: false, message: MACHINES_NO_ANSWER }))
  })

  ipcMain.handle(IPC.MACHINES_REATTACH, async (event, id: unknown): Promise<MachineActionResult> => {
    if (!fromApp(event)) {
      logWarn('[machines] re-attach refused: not the app window')
      return { ok: false, message: MACHINES_NOT_APP }
    }
    if (!isHeldSessionId(id)) {
      logWarn('[machines] re-attach refused: id not of the expected shape')
      return { ok: false, message: MACHINES_BAD_ID }
    }
    return answer('re-attach', MACHINES_ACTION_TIMEOUT_MS, () => getSource().reattach(id), () => ({ ok: false, message: MACHINES_NO_ANSWER }))
  })
}
