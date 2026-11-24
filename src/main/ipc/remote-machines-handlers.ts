import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { readFileSync } from 'fs'
import * as path from 'path'
import { IPC } from '../../shared/ipc-channels'
import { MACHINES_NO_ANSWER } from '../../shared/machines'
import {
  REMOTE_DID_RE,
  REMOTE_SESSIONS_SETTING,
  REMOTE_TOKEN_RE,
  type RemoteActionResult,
  type RemoteConsent,
  type RemoteMachinesState,
} from '../../shared/remote-machines'
import { readConfig } from '../config-manager'
import { logInfo, logWarn } from '../debug-logger'
import { sshProgram } from '../ssh-program'
import { instanceRecordPath } from '../session-helper/install'
import { setRemoteHelperDeps, remoteTabsOn } from '../remote-helper'
import { RemoteMachines, fileStore } from '../remote-helper/machines'
import { MANIFEST_NAME, bundledHelperDir, manifestEntry, readBundledLinuxHelper } from '../remote-helper/manifest'
import { nodeSshRunner } from '../remote-helper/ssh-exec'
import { MACHINES_NOT_APP, answer } from './machines-handlers'
import { appWindowSender } from './trusted-sender'

/**
 * The Machines page's doors for remote machines (2.1.3-beta.17, plan section
 * A2; ADR-030 S24 and S25): the list and Add's candidates (state), the
 * question asked before anything is sent (prepare), Add on the answer's token,
 * Check and Remove. Each door answers only the app's own window and checks
 * what it is given; a door that throws or stays silent answers in a plain
 * sentence, as the This computer doors do (machines-handlers.ts `answer`).
 *
 * registerRemoteMachinesHandlers also plugs remote step 1 into the PTY
 * manager (setRemoteHelperDeps): the machine records, the ssh runner and the
 * installer's Linux helper. Windows only: elsewhere the state says so, every
 * action is refused, and every SSH tab takes the usual path.
 */

/** How long main waits on each door: an Add uploads a file of a few MB and
 *  runs five more execs; a Check may upload too. */
export const REMOTE_STATE_TIMEOUT_MS = 10_000
export const REMOTE_ACTION_TIMEOUT_MS = 300_000
export const REMOTE_NOT_AVAILABLE = 'Remote sessions through the session helper run from Windows only in this preview.'
const NOT_LISTED = 'That machine is not on this computer\'s list.'

/** The saved settings; null when they do not read. */
function savedSettings(): Record<string, unknown> | null {
  try {
    return readConfig<Record<string, unknown>>('settings')
  } catch {
    return null
  }
}

export function registerRemoteMachinesHandlers(getWindow: () => BrowserWindow | null, platform: NodeJS.Platform = process.platform): void {
  const trusted = appWindowSender(getWindow)
  const dir = bundledHelperDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })
  const recordsFile = instanceRecordPath('remote-machines.json', { isPackaged: app.isPackaged, userData: () => app.getPath('userData') })
  let machines: RemoteMachines | null = null
  if (platform === 'win32' && recordsFile) {
    const runner = nodeSshRunner(() => sshProgram())
    machines = new RemoteMachines({ runner, store: fileStore(recordsFile), bundled: () => readBundledLinuxHelper(dir), inUse: remoteTabsOn, log: logInfo })
    // The manifest's hash, read once: the routing compares each machine's helper with it.
    let manifestSha: string | null | undefined
    const bundledSha256 = (): string | null => {
      if (manifestSha === undefined) {
        try {
          manifestSha = manifestEntry(JSON.parse(readFileSync(path.join(dir, MANIFEST_NAME), 'utf8')))?.sha256 ?? null
        } catch {
          manifestSha = null
        }
      }
      return manifestSha
    }
    setRemoteHelperDeps({ platform, settings: savedSettings, machines, runner, bundledSha256, log: logInfo })
  }
  const refuse = (message: string): RemoteActionResult => ({ ok: false, message })

  ipcMain.handle(IPC.MACHINES_REMOTE_STATE, async (event): Promise<RemoteMachinesState> => {
    const switchOn = savedSettings()?.[REMOTE_SESSIONS_SETTING] === true
    const none: RemoteMachinesState = { available: false, switchOn, bundled: { ok: false, why: REMOTE_NOT_AVAILABLE }, machines: [], candidates: [] }
    if (!trusted(event)) { logWarn('[machines] remote state refused: not the app window'); return none }
    const m = machines
    if (!m) return none
    return answer('remote state', REMOTE_STATE_TIMEOUT_MS, async (): Promise<RemoteMachinesState> => {
      const b = await readBundledLinuxHelper(dir)
      return {
        available: true,
        switchOn,
        bundled: b.ok ? { ok: true, version: b.helper.version, size: b.helper.size, sha12: b.helper.sha256.slice(0, 12) } : { ok: false, why: b.why },
        machines: m.views(),
        candidates: m.candidates(readConfig('configs')),
      }
    }, () => none)
  })

  ipcMain.handle(IPC.MACHINES_REMOTE_PREPARE, async (event, configId: unknown): Promise<RemoteConsent> => {
    if (!trusted(event)) { logWarn('[machines] remote add refused: not the app window'); return { ok: false, message: MACHINES_NOT_APP } }
    const m = machines
    if (!m) return { ok: false, message: REMOTE_NOT_AVAILABLE }
    if (typeof configId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(configId)) return { ok: false, message: 'That is not a saved config this computer has.' }
    return answer('remote prepare', REMOTE_STATE_TIMEOUT_MS, () => m.prepare(readConfig('configs'), configId), (): RemoteConsent => ({ ok: false, message: MACHINES_NO_ANSWER }))
  })

  ipcMain.handle(IPC.MACHINES_REMOTE_ADD, async (event, token: unknown): Promise<RemoteActionResult> => {
    if (!trusted(event)) { logWarn('[machines] remote add refused: not the app window'); return refuse(MACHINES_NOT_APP) }
    const m = machines
    if (!m) return refuse(REMOTE_NOT_AVAILABLE)
    if (typeof token !== 'string' || !REMOTE_TOKEN_RE.test(token)) return refuse('Nothing was sent: the question was not answered.')
    return answer('remote add', REMOTE_ACTION_TIMEOUT_MS, () => m.add(token), () => refuse(MACHINES_NO_ANSWER))
  })

  ipcMain.handle(IPC.MACHINES_REMOTE_CHECK, async (event, did: unknown): Promise<RemoteActionResult> => {
    if (!trusted(event)) { logWarn('[machines] remote check refused: not the app window'); return refuse(MACHINES_NOT_APP) }
    const m = machines
    if (!m) return refuse(REMOTE_NOT_AVAILABLE)
    if (typeof did !== 'string' || !REMOTE_DID_RE.test(did)) return refuse(NOT_LISTED)
    return answer('remote check', REMOTE_ACTION_TIMEOUT_MS, () => m.check(did), () => refuse(MACHINES_NO_ANSWER))
  })

  ipcMain.handle(IPC.MACHINES_REMOTE_REMOVE, async (event, did: unknown): Promise<RemoteActionResult> => {
    if (!trusted(event)) { logWarn('[machines] remote remove refused: not the app window'); return refuse(MACHINES_NOT_APP) }
    const m = machines
    if (!m) return refuse(REMOTE_NOT_AVAILABLE)
    if (typeof did !== 'string' || !REMOTE_DID_RE.test(did)) return refuse(NOT_LISTED)
    return answer('remote remove', REMOTE_ACTION_TIMEOUT_MS, () => m.remove(did), () => refuse(MACHINES_NO_ANSWER))
  })
}
