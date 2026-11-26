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
  type RemoteSessionsState,
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
import { setRemoteHelperDeps, remoteTabsOn, listRemoteSessions, endRemoteSession, endRemoteTab, type RemoteSignalDeps } from '../remote-helper'
import { remoteHelperWatchdog } from '../watchdog/remote-helper-tab'
import { peekSessionState, readDetachedRemotesRegistry } from '../session-state'
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
/** A helper session id, as End takes it. */
const HELPER_SID_RE = /^rm[0-9a-f]{30}$/
/** An app session id, as a tab's End takes it. */
const APP_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** How long after start-up the first list of kept sessions waits (2.1.3-beta.19
 *  section 1.2): past the start's own work, never on its way. */
export const STARTUP_SESSIONS_DELAY_MS = 5_000

/**
 * The machines whose kept sessions are listed while the switch is off
 * (2.1.3-beta.19 section 1.2): those a left-running 'helper' entry or a saved
 * tab's mark names. With none, nothing of the feature is read.
 */
export function keptMachineDids(): string[] {
  const dids = new Set<string>()
  for (const e of readDetachedRemotesRegistry()) if (e.mux === 'helper' && typeof e.did === 'string' && REMOTE_DID_RE.test(e.did)) dids.add(e.did)
  let saved: ReturnType<typeof peekSessionState> = null
  try { saved = peekSessionState() } catch { saved = null }
  for (const s of saved?.sessions ?? []) if (s.remoteVia === 'helper' && typeof s.remoteDid === 'string' && REMOTE_DID_RE.test(s.remoteDid)) dids.add(s.remoteDid)
  return [...dids]
}

/** The machines listed now: every added one while the switch is on, else keptMachineDids'. */
function listedDids(): string[] | undefined {
  return savedSettings()?.[REMOTE_SESSIONS_SETTING] === true ? undefined : keptMachineDids()
}

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
      // 2.1.3-beta.19 fix round: its Session Watchdog, armed once its CLI runs in the holder.
      watchdog: remoteHelperWatchdog,
      registry: readDetachedRemotesRegistry,
    })
    // At start-up, once: list mode on each machine listed (no daemon, no polling).
    const first = setTimeout(() => {
      const dids = listedDids()
      if (dids && dids.length === 0) return
      void listRemoteSessions(dids).then((all) => {
        for (const a of all) logInfo(a.ok ? `[remote-helper] start-up: ${a.sessions.length} session(s) on ${a.did.slice(0, 8)}` : `[remote-helper] start-up: the sessions on ${a.did.slice(0, 8)} were not listed (${a.why})`)
      }).catch((err: Error) => logWarn(`[remote-helper] start-up: the sessions were not listed (${err.message})`))
    }, STARTUP_SESSIONS_DELAY_MS)
    first.unref?.()
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

  // 2.1.3-beta.19 section 1.2: the sessions the helper keeps, one list exec per
  // machine listed (every added one while the switch is on; with it off, only
  // those a left-running entry or a saved tab names).
  ipcMain.handle(IPC.MACHINES_REMOTE_SESSIONS, async (event): Promise<RemoteSessionsState> => {
    if (!trusted(event)) { logWarn('[machines] remote sessions refused: not the app window'); return { machines: [] } }
    if (!machines) return { machines: [] }
    return answer('remote sessions', REMOTE_STATE_TIMEOUT_MS * 3, async (): Promise<RemoteSessionsState> => {
      const dids = listedDids()
      return { machines: dids && dids.length === 0 ? [] : await listRemoteSessions(dids) }
    }, (): RemoteSessionsState => ({ machines: [] }))
  })

  // End on a machine's card: one kept session no open tab shows.
  ipcMain.handle(IPC.MACHINES_REMOTE_END_SESSION, async (event, did: unknown, sid: unknown): Promise<RemoteActionResult> => {
    if (!trusted(event)) { logWarn('[machines] remote end refused: not the app window'); return refuse(MACHINES_NOT_APP) }
    if (!machines) return refuse(REMOTE_NOT_AVAILABLE)
    if (typeof did !== 'string' || !REMOTE_DID_RE.test(did)) return refuse(NOT_LISTED)
    if (typeof sid !== 'string' || !HELPER_SID_RE.test(sid)) return refuse('That is not a session the helper keeps.')
    return answer('remote end', REMOTE_STATE_TIMEOUT_MS * 6, () => endRemoteSession(did, sid), () => refuse(MACHINES_NO_ANSWER))
  })

  // End of a tab's own kept session (the close question's End, or Remove of a
  // session left running): the open tab's, else the one machine `did` keeps.
  ipcMain.handle(IPC.MACHINES_REMOTE_END_TAB, async (event, sessionId: unknown, did: unknown): Promise<RemoteActionResult> => {
    if (!trusted(event)) { logWarn('[machines] remote end refused: not the app window'); return refuse(MACHINES_NOT_APP) }
    if (!machines) return refuse(REMOTE_NOT_AVAILABLE)
    if (typeof sessionId !== 'string' || !APP_SESSION_ID_RE.test(sessionId)) return refuse('That is not a tab of this app.')
    if (did !== undefined && (typeof did !== 'string' || !REMOTE_DID_RE.test(did))) return refuse(NOT_LISTED)
    return answer('remote end', REMOTE_STATE_TIMEOUT_MS * 6, () => endRemoteTab(sessionId, did as string | undefined), () => refuse(MACHINES_NO_ANSWER))
  })

  ipcMain.handle(IPC.MACHINES_REMOTE_REMOVE, async (event, did: unknown): Promise<RemoteActionResult> => {
    if (!trusted(event)) { logWarn('[machines] remote remove refused: not the app window'); return refuse(MACHINES_NOT_APP) }
    const m = machines
    if (!m) return refuse(REMOTE_NOT_AVAILABLE)
    if (typeof did !== 'string' || !REMOTE_DID_RE.test(did)) return refuse(NOT_LISTED)
    return answer('remote remove', REMOTE_ACTION_TIMEOUT_MS, () => m.remove(did), () => refuse(MACHINES_NO_ANSWER))
  })
}
