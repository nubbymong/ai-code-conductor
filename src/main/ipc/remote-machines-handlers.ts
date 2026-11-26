import { app, ipcMain, nativeTheme } from 'electron'
import type { BrowserWindow } from 'electron'
import { readFileSync } from 'fs'
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
import { getPtyIntegrityMonitor } from '../services/pty-integrity-monitor'
import { sshProgram } from '../ssh-program'
import { instanceRecordPath } from '../session-helper/install'
import { getConductorMcpPort, recordHeldToolSession, serveToolStream } from '../conductor-mcp-server'
import { conductorToolsMasterOn } from '../conductor-tools-switch'
import { endHelperHooks, helperHookEvent } from '../session-signals/hooks'
import { dispatchHelperStatus, endHelperAccount, setHelperAccount } from '../statusline-watcher'
import { setRemoteHelperDeps, remoteTabsOn, type RemoteSignalDeps } from '../remote-helper'
import { RemoteMachines, fileStore } from '../remote-helper/machines'
import { bundledHelperPaths, manifestSha256For, readBundledLinuxHelpers } from '../remote-helper/manifest'
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
 * installer's Linux helpers (one per machine architecture from 2.1.3-beta.19,
 * each machine compared with its own), and (2.1.3-beta.18, plan section 3.2) where a
 * tab's status line, hook events and tool streams go: the status strip's
 * ingest, the session signals module, and the tool host, which serves a
 * tab's tool streams as its session with no credential. Windows only:
 * elsewhere the state says so, every action is refused, and every SSH tab
 * takes the usual path.
 */

/** A tab through the helper: its status line, hook events and tool streams. */
const remoteSignals: RemoteSignalDeps = {
  toolsServed: () => conductorToolsMasterOn() && getConductorMcpPort() > 0,
  status: (appPtyId, line) => dispatchHelperStatus(appPtyId, line),
  event: (appPtyId, e) => helperHookEvent(appPtyId, e, { remote: true }),
  serve: (appPtyId, provider, link) => {
    // The record a credential would make, with none made or handed out: the
    // stream comes through the tab's holder, and serveToolStream checks no credential.
    recordHeldToolSession(appPtyId, provider)
    return serveToolStream(appPtyId, link)
  },
  // 2.1.3-beta.19 section 3 (aicc_planning#434): the account each start read
  // on the host: the tab's label, and its weekly bars and extra usage from
  // this computer's own reading of that account, through the provider
  // package's usage source (none: nothing is looked up).
  account: (appPtyId, read, usage) => setHelperAccount(appPtyId, read, usage),
  // The tab's run is over: its hook state goes, as a held session's does
  // (session-helper/app-wiring.ts), so a Restart's feed starts empty; and its
  // account and usage source.
  ended: (appPtyId) => { endHelperHooks(appPtyId); endHelperAccount(appPtyId) },
}

/** How long main waits on each door: an Add uploads a file of a few MB and
 *  runs five more execs; a Check may upload too. */
export const REMOTE_STATE_TIMEOUT_MS = 10_000
export const REMOTE_ACTION_TIMEOUT_MS = 300_000
export const REMOTE_NOT_AVAILABLE = 'Remote sessions through the session helper run from Windows only in this preview.'
/** The state's answer on Windows when the list did not load (its records file
 *  does not read, or no answer in time): the section stays, lists nothing and
 *  offers no Add, and says so. */
export const REMOTE_STATE_UNREAD = 'The Linux machines list did not load. Nothing on it was changed; the app\'s log says why.'
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
  const where = { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }
  const recordsFile = instanceRecordPath('remote-machines.json', { isPackaged: app.isPackaged, userData: () => app.getPath('userData') })
  let machines: RemoteMachines | null = null
  if (platform === 'win32' && recordsFile) {
    const runner = nodeSshRunner(() => sshProgram())
    machines = new RemoteMachines({ runner, store: fileStore(recordsFile), bundled: () => readBundledLinuxHelpers(where), inUse: remoteTabsOn, log: logInfo })
    // The manifest, read once: the routing compares each machine's helper with
    // the entry of that machine's own architecture (2.1.3-beta.19).
    let manifest: { json: unknown } | undefined
    const bundledSha256 = (arch: string): string | null => {
      if (manifest === undefined) {
        try {
          manifest = { json: JSON.parse(readFileSync(bundledHelperPaths(where).manifest, 'utf8')) }
        } catch {
          manifest = { json: null }
        }
      }
      return manifestSha256For(manifest.json, arch)
    }
    setRemoteHelperDeps({
      platform, settings: savedSettings, machines, runner, bundledSha256,
      systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
      onOutput: (id, n) => { getPtyIntegrityMonitor()?.recordPtyData(id, n) },
      log: logInfo,
      signals: remoteSignals,
    })
  }
  const refuse = (message: string): RemoteActionResult => ({ ok: false, message })

  ipcMain.handle(IPC.MACHINES_REMOTE_STATE, async (event): Promise<RemoteMachinesState> => {
    const switchOn = savedSettings()?.[REMOTE_SESSIONS_SETTING] === true
    const none: RemoteMachinesState = { available: false, switchOn, bundled: { ok: false, why: REMOTE_NOT_AVAILABLE }, machines: [], candidates: [] }
    if (!trusted(event)) { logWarn('[machines] remote state refused: not the app window'); return none }
    const m = machines
    if (!m) return none
    return answer('remote state', REMOTE_STATE_TIMEOUT_MS, async (): Promise<RemoteMachinesState> => {
      const b = await readBundledLinuxHelpers(where)
      const shaFor = (arch: string): string | null => (b.ok ? (b.helpers.find((h) => h.arch === arch)?.sha256 ?? null) : null)
      return {
        available: true,
        switchOn,
        bundled: b.ok
          ? { ok: true, version: b.helpers[0].version, files: b.helpers.map((h) => ({ arch: h.arch, size: h.size, sha12: h.sha256.slice(0, 12) })) }
          : { ok: false, why: b.why },
        machines: m.views(shaFor),
        candidates: m.candidates(readConfig('configs')),
      }
    }, (): RemoteMachinesState => ({ available: true, switchOn, bundled: { ok: false, why: REMOTE_STATE_UNREAD }, machines: [], candidates: [] }))
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
