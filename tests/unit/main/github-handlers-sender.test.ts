/**
 * Every GitHub sidebar channel answers only the app's own window, its main
 * frame (ipc/trusted-sender.ts), as `github:session:context:get` already did.
 *
 * Any other sender or frame, a destroyed window and a call made while there is
 * no window get the channel's own empty or refused answer (listed per channel
 * below), before anything else runs: no store, profile, token, sync, git or
 * network call is reached. A refusal writes one warning line, which carries no
 * part of the request. The app window's main frame is served as before.
 *
 * The table is checked against the channels the file registers, so a channel
 * added later without a row fails this suite.
 *
 * Every collaborator is an inert recording fake: nothing reads disk, spawns a
 * process or opens a connection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { notAppMainFrameEvents } from '../../helpers/app-window-events'

const h = vi.hoisted(() => {
  const calls: string[] = []
  /** A fake collaborator that records that it was reached, then answers `impl`. */
  const rec =
    (name: string, impl: (...a: any[]) => unknown = () => undefined) =>
    (...a: unknown[]) => {
      calls.push(name)
      return impl(...a)
    }
  return {
    handlers: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
    listeners: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
    logs: [] as string[],
    calls,
    rec,
    config: { authProfiles: {} } as Record<string, unknown>,
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { h.handlers.set(ch, fn) },
    on: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { h.listeners.set(ch, fn) },
  },
  BrowserWindow: { fromWebContents: () => null },
}))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { h.logs.push(['INFO', ...a].map(String).join(' ')) },
  logWarn: (...a: unknown[]) => { h.logs.push(['WARN', ...a].map(String).join(' ')) },
  logError: (...a: unknown[]) => { h.logs.push(['ERROR', ...a].map(String).join(' ')) },
  logDebug: () => {}, logTrace: () => {}, setVerboseMode: () => {}, isVerboseMode: () => false, setVerboseBaseline: () => {},
  setTraceMode: () => {}, isTraceMode: () => false, installGlobalErrorHandlers: () => {}, closeDebugLogger: () => {},
}))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: h.rec('readConfig', () => null) }))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: h.rec('updateSessionMeta') }))
vi.mock('../../../src/main/channel-emitters', () => ({ emitPrMerged: h.rec('emitPrMerged') }))
vi.mock('../../../src/main/active-session', () => ({ setActiveSessionId: h.rec('setActiveSessionId') }))
vi.mock('../../../src/main/github/github-config-store', () => ({
  GitHubConfigStore: class {
    read = h.rec('config.read', async () => h.config)
    write = h.rec('config.write', async () => {})
  },
}))
vi.mock('../../../src/main/github/github-config-migrate', () => ({
  migrateGitHubConfig: h.rec('migrateGitHubConfig', (config: unknown) => ({ config, changed: false })),
}))
vi.mock('../../../src/main/github/auth/auth-profile-store', () => ({
  AuthProfileStore: class {
    addProfile = h.rec('profiles.add', async () => 'profile-new')
    removeProfile = h.rec('profiles.remove', async () => {})
    updateProfile = h.rec('profiles.update', async () => {})
    getToken = h.rec('profiles.getToken', async () => 'fake-token-value')
    replaceSameAccountOAuth = h.rec('profiles.replaceSameAccountOAuth', async () => {})
  },
  pickRendererProfilePatch: h.rec('pickRendererProfilePatch', () => ({})),
}))
vi.mock('../../../src/main/github/auth/gh-cli-delegate', () => ({
  ghAuthStatus: h.rec('ghAuthStatus', async () => ['octo-user']),
  ghAuthToken: h.rec('ghAuthToken', async () => 'fake-token-value'),
  defaultGhRun: h.rec('defaultGhRun', () => async () => ''),
}))
vi.mock('../../../src/main/github/auth/oauth-device-flow', () => ({
  requestDeviceCode: h.rec('requestDeviceCode', async () => ({
    device_code: 'device-code-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
  })),
  pollForAccessToken: h.rec('pollForAccessToken', async () => ({ error: 'authorization_pending' })),
}))
vi.mock('../../../src/main/github/auth/pat-verifier', () => ({
  verifyToken: h.rec('verifyToken', async () => ({ username: 'octo-user', avatarUrl: '', scopes: ['repo'] })),
  probeRepoAccess: h.rec('probeRepoAccess', async () => true),
}))
vi.mock('../../../src/main/github/auth/capability-mapper', () => ({
  scopesToCapabilities: h.rec('scopesToCapabilities', () => []),
}))
vi.mock('../../../src/main/github/session/repo-detector', () => ({
  detectRepoFromCwd: h.rec('detectRepoFromCwd', async () => 'octo/repo'),
  defaultGitRun: h.rec('defaultGitRun', () => async () => 'main'),
}))
vi.mock('../../../src/main/github/session/local-git-reader', () => ({
  readLocalGitState: h.rec('readLocalGitState', async () => ({ branch: 'main' })),
}))
vi.mock('../../../src/main/github/security/slug-validator', () => ({
  validateSlug: h.rec('validateSlug', () => true),
}))
vi.mock('../../../src/main/github/cache/cache-store', () => ({
  CacheStore: class {
    load = h.rec('cache.load', async () => ({ repos: {} }))
    save = h.rec('cache.save', async () => {})
  },
}))
vi.mock('../../../src/main/github/client/etag-cache', () => ({ EtagCache: class {} }))
vi.mock('../../../src/main/github/client/rate-limit-shield', () => ({ RateLimitShield: class {} }))
vi.mock('../../../src/main/github/client/github-fetch', () => ({
  githubFetch: h.rec('githubFetch', async () => ({ ok: true, status: 200, json: async () => ({}) })),
}))
vi.mock('../../../src/main/github/client/rest-fallback', () => ({
  fetchPRByBranch: h.rec('fetchPRByBranch'),
  fetchPRReviews: h.rec('fetchPRReviews'),
  fetchWorkflowRuns: h.rec('fetchWorkflowRuns'),
}))
vi.mock('../../../src/main/github/session/sync-orchestrator', () => ({
  SyncOrchestrator: class {
    registerSession = h.rec('sync.registerSession')
    unregisterSession = h.rec('sync.unregisterSession')
    setFocus = h.rec('sync.setFocus')
    syncNow = h.rec('sync.syncNow', async () => {})
    pause = h.rec('sync.pause')
    resume = h.rec('sync.resume')
  },
}))
vi.mock('../../../src/main/github/session/notifications-poller', () => ({
  NotificationsPoller: class {
    syncTo = h.rec('notifications.syncTo')
    pause = h.rec('notifications.pause')
    resume = h.rec('notifications.resume')
  },
}))
vi.mock('../../../src/main/github/session/session-context-service', () => ({
  buildSessionContext: h.rec('buildSessionContext', async () => ({})),
}))
vi.mock('../../../src/main/github/session/tool-call-inspector', () => ({
  extractFileSignals: h.rec('extractFileSignals', () => []),
}))
vi.mock('../../../src/main/github/session/transcript-scanner', () => ({
  scanTranscriptMessages: h.rec('scanTranscriptMessages', () => []),
}))
vi.mock('../../../src/main/github/copilot-usage', () => ({
  AiUsageScheduler: class {
    start = h.rec('aiUsage.start')
    refresh = h.rec('aiUsage.refresh', async () => null)
    getLatest = h.rec('aiUsage.getLatest', () => null)
    getStatus = h.rec('aiUsage.getStatus', () => 'ok')
    getLatestCycle = h.rec('aiUsage.getLatestCycle', () => null)
  },
}))

const { registerGitHubHandlers } = await import('../../../src/main/ipc/github-handlers')
const { IPC } = await import('../../../src/shared/ipc-channels')

/** The `{ ok }` channels' refusal, in this file's error vocabulary. */
const NOT_APP = { ok: false, error: 'not-app-window' }

interface Row {
  /** The request's arguments after the event: a well-formed request, so a
   *  missing check would reach a collaborator rather than fail validation. */
  args: unknown[]
  /** What a refused request is answered (undefined for a fire-and-forget send). */
  refused: unknown
}

/** One row per channel the file registers, request and send alike. */
const ROWS: Record<string, Row> = {
  [IPC.GITHUB_AI_USAGE_GET]: { args: [false], refused: { report: null, status: 'error', cycle: null } },
  [IPC.GITHUB_CONFIG_GET]: { args: [], refused: null },
  [IPC.GITHUB_CONFIG_UPDATE]: { args: [{ transcriptScanningOptIn: true }], refused: null },
  [IPC.GITHUB_PROFILE_ADD_PAT]: {
    args: [{ kind: 'pat-classic', label: 'work-label', rawToken: 'not-a-real-token-value' }],
    refused: NOT_APP,
  },
  [IPC.GITHUB_PROFILE_ADOPT_GHCLI]: { args: ['octo-user'], refused: NOT_APP },
  [IPC.GITHUB_PROFILE_REMOVE]: { args: ['profile-one'], refused: NOT_APP },
  [IPC.GITHUB_PROFILE_RENAME]: { args: ['profile-one', 'renamed-label'], refused: NOT_APP },
  [IPC.GITHUB_PROFILE_UPDATE]: { args: ['profile-one', { label: 'patched-label' }], refused: NOT_APP },
  [IPC.GITHUB_PROFILE_TEST]: { args: ['profile-one'], refused: NOT_APP },
  [IPC.GITHUB_OAUTH_START]: { args: ['public'], refused: null },
  [IPC.GITHUB_OAUTH_POLL]: { args: ['flow-one'], refused: NOT_APP },
  [IPC.GITHUB_OAUTH_CANCEL]: { args: ['flow-one'], refused: NOT_APP },
  [IPC.GITHUB_REAUTH_PROFILE]: { args: ['profile-one'], refused: NOT_APP },
  [IPC.GITHUB_GHCLI_DETECT]: { args: [], refused: { ok: false, users: [] } },
  [IPC.GITHUB_REPO_DETECT]: { args: ['C:/fake/repo-folder'], refused: { ok: false, slug: null } },
  [IPC.GITHUB_SESSION_CONFIG_UPDATE]: { args: ['session-one', { enabled: false }], refused: NOT_APP },
  [IPC.GITHUB_LOCALGIT_GET]: { args: ['C:/fake/repo-folder'], refused: { ok: false, state: null } },
  [IPC.GITHUB_DATA_GET]: { args: ['octo/repo'], refused: { ok: false, data: null } },
  [IPC.GITHUB_SYNC_NOW]: { args: ['session-one'], refused: NOT_APP },
  [IPC.GITHUB_SYNC_FOCUSED_NOW]: { args: [], refused: NOT_APP },
  [IPC.GITHUB_FOCUS_CHANGED]: { args: ['session-one'], refused: undefined },
  [IPC.GITHUB_SYNC_PAUSE]: { args: [], refused: NOT_APP },
  [IPC.GITHUB_SYNC_RESUME]: { args: [], refused: NOT_APP },
  [IPC.GITHUB_SESSION_CONTEXT_GET]: { args: ['session-one'], refused: { ok: false, data: null } },
  [IPC.GITHUB_ACTIONS_RERUN]: { args: ['octo/repo', 42], refused: NOT_APP },
  [IPC.GITHUB_PR_MERGE]: { args: ['octo/repo', 7, 'squash'], refused: NOT_APP },
  [IPC.GITHUB_PR_READY]: { args: ['octo/repo', 7], refused: NOT_APP },
  [IPC.GITHUB_REVIEW_REPLY]: { args: ['octo/repo', '123', 'thanks-for-the-review'], refused: NOT_APP },
  [IPC.GITHUB_NOTIF_MARK_READ]: { args: ['profile-one', '99'], refused: NOT_APP },
}
const CHANNELS = Object.keys(ROWS)

const mainFrame = { name: 'main' }
const webContents = { mainFrame, send: vi.fn() }
let destroyed = false
const win = { isDestroyed: () => destroyed, webContents }
/** Read by main's getter at call time: null is "no window" (none yet, or a closed one not re-created). */
let current: typeof win | null = win
const loadSessions = h.rec('loadSessions', async () => [])
const saveSessions = h.rec('saveSessions', async () => {})

const APP = { sender: webContents, senderFrame: mainFrame }
/** Every frame shape that is not the app window's main frame. */
const FOREIGN = notAppMainFrameEvents(webContents)

function call(channel: string, event: unknown): unknown {
  const fn = h.handlers.get(channel) ?? h.listeners.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return fn(event, ...ROWS[channel].args)
}

/** Every string the request carries, for the "no part of the request is logged" check. */
function requestStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.length >= 3 ? [value] : []
  if (Array.isArray(value)) return value.flatMap(requestStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(requestStrings)
  return []
}

const refusalLines = () => h.logs.filter((l) => l.includes('not the app window'))

beforeEach(async () => {
  h.handlers.clear()
  h.listeners.clear()
  destroyed = false
  current = win
  registerGitHubHandlers({
    resourcesDir: 'C:/fake/resources',
    getWindow: () => current as never,
    loadSessions,
    saveSessions,
  })
  // Registration reads the config and the sessions in the background; let it
  // settle, so only what a request itself reaches is counted below.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  h.calls.length = 0
  h.logs.length = 0
})

describe('every github channel answers only the app window', () => {
  it('the table covers every channel the file registers', () => {
    const registered = [...h.handlers.keys(), ...h.listeners.keys()].sort()
    expect(registered).toEqual([...CHANNELS].sort())
  })

  it.each(CHANNELS)('%s: the app window main frame is served', async (channel) => {
    const answer = await call(channel, APP)
    expect(refusalLines()).toEqual([])
    // Served: the request reached a collaborator, or was answered something
    // other than the refusal (a check of its own, such as an unknown flow).
    const reached = h.calls.length > 0
    expect(reached || JSON.stringify(answer) !== JSON.stringify(ROWS[channel].refused), channel).toBe(true)
  })

  it.each(CHANNELS)('%s: any other sender or frame is refused, and nothing is reached', async (channel) => {
    for (const [shape, event] of FOREIGN) {
      expect(await call(channel, event), shape).toEqual(ROWS[channel].refused)
    }
    expect(h.calls).toEqual([])
    expect(refusalLines().length).toBe(FOREIGN.length)
  })

  it.each(CHANNELS)('%s: a destroyed window, or no window at all, is refused', async (channel) => {
    destroyed = true
    expect(await call(channel, APP)).toEqual(ROWS[channel].refused)
    destroyed = false
    current = null
    expect(await call(channel, APP)).toEqual(ROWS[channel].refused)
    expect(h.calls).toEqual([])
    current = win
    h.logs.length = 0
    await call(channel, APP)
    expect(refusalLines()).toEqual([])
  })

  it.each(CHANNELS)('%s: a refusal writes one warning line, which carries no part of the request', async (channel) => {
    await call(channel, FOREIGN[0][1])
    expect(h.logs.length).toBe(1)
    expect(h.logs[0]).toMatch(/^WARN \[github\] .*refused: not the app window$/)
    for (const part of requestStrings(ROWS[channel].args)) expect(h.logs[0]).not.toContain(part)
  })
})
