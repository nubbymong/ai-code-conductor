// 2.1.3-beta.14, plan section A1 (S16 step 4, aicc_planning#387 with #359): a
// session an app update keeps running keeps what its launch put on disk
// through its kill. unbindLaunchFiles leaves its three per-session files and
// unbindLaunchTelemetry its hook folder, while what they drop from this run's
// memory still goes; describeLaunch says what the release records of it; and
// removeKeptLaunchFiles removes what it left once it is no longer kept. The
// launch bindings hand both over to the seam (kept-launches.ts) when they load.
//
// Not checked here: which sessions are kept (the session helper decides:
// tests/unit/main/session-helper-update-keep.test.ts); the collaborators
// themselves, each mocked here and tested on its own.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const calls: string[] = []
  const rec = (name: string) => (...args: unknown[]): void => { calls.push([name, ...args.map((a) => String(a))].join(' ')) }
  return { calls, rec, profiles: {} as Record<string, string>, folderRemover: true }
})

vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: false } }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  removeLocalSessionSettings: (sid: string) => h.rec('removeLocalSessionSettings')(sid),
  removeLocalSessionMcpConfig: (sid: string) => h.rec('removeLocalSessionMcpConfig')(sid),
  removeLocalSessionStatusUrl: (sid: string) => h.rec('removeLocalSessionStatusUrl')(sid),
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => ({}) }))
vi.mock('../../../src/main/path-utils', () => ({ isHomeOrAncestor: () => false }))
vi.mock('../../../src/main/account-color', () => ({ decorateStatuslineWithColour: (d: unknown) => d }))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({ clampAnsiChunk: (d: string) => d }))
vi.mock('../../../src/main/logging/should-register-run', () => ({ shouldRegisterRun: () => false }))
vi.mock('../../../src/main/logging/indexing-gaps', () => ({ openNotIndexedWindow: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null }))
vi.mock('../../../src/main/logging/codex-log-binder', () => ({ getCodexLogBinder: () => ({ endRun: (sid: string) => h.rec('binder.endRun')(sid) }) }))
vi.mock('../../../src/main/spawn-claude-command', () => ({ buildResumeTranscriptPath: () => null }))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {},
  pushAccountIdentity: () => {},
  startWatchingAccountIdentity: () => {},
  getAccountIdentity: () => null,
  getClaudeProfileId: (sid: string) => h.profiles[sid],
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  registerCodexReviewSession: () => {},
  registerClaudeReviewSession: () => {},
  unregisterCodexReviewSession: (sid: string) => h.rec('unregisterCodexReviewSession')(sid),
  releaseMcpSessionProvider: (sid: string) => h.rec('releaseMcpSessionProvider')(sid),
}))
vi.mock('../../../src/main/canvas/canvas-store', () => ({
  registerCanvasUatRoot: () => true,
  revokeCanvasUatRoots: (sid: string) => h.rec('revokeCanvasUatRoots')(sid),
  designateCanvasWorktreeRoot: () => true,
  canvasRootRefusalReason: () => null,
  describeCanvasRootRefusal: () => '',
  setCanvasRootRefusal: () => {},
}))
vi.mock('../../../src/main/canvas/canvas-marker-delivery', () => ({ forgetCanvasMarkers: (sid: string) => h.rec('forgetCanvasMarkers')(sid) }))
vi.mock('../../../src/main/canvas/codex-canvas-roots', () => ({ registerCodexCanvasRoots: () => {} }))
vi.mock('../../../src/main/canvas/codex-guidance', () => ({ noteCodexSessionGuidance: () => {}, forgetCodexSessionGuidance: (sid: string) => h.rec('forgetCodexSessionGuidance')(sid) }))
// The provider registry: one provider that removes a kept hook folder.
vi.mock('../../../src/main/providers', async () => (await import('../../helpers/provider-package-parts')).withProviderPackageParts(await (() => ({
  tryGetProvider: (id: string) => (h.folderRemover ? { removeSessionHookFolder: (dir: string) => h.rec('removeSessionHookFolder')(id, dir) } : {}),
}))()))
await (await import('../../helpers/provider-package-parts')).loadProviderPackageParts()

const lb = await import('../../../src/main/sessions/launch-bindings')
const seam = await import('../../../src/main/sessions/kept-launches')
type Ports = Parameters<typeof lb.setLaunchBindingPorts>[0]

const KEPT = 'cx0000000000000000000001'
const ENDED = 'cx0000000000000000000002'
const CL = 'cl0000000000000000000001'
const ID = '019dd000-0001-7000-8000-00000000000a'
const ID2 = '019dd000-0002-7000-8000-00000000000b'
const FOLDER = '/data/codex-hooks/ccc-codex-hook-AbC123'

/** pty-manager.ts's forgetCodexHooks, as it removes a hook file: the file the map holds goes. */
function makePorts() {
  const codexHookFiles = new Map<string, { hookFile: string; dispose(): void }>()
  const codexTelemetrySources = new Map<string, { stop(): void }>()
  const ports = {
    ptySessions: new Map(),
    codexHookFiles,
    codexHookedLaunches: new Set<string>(),
    codexLaunchLeases: new Map<string, { accountId: string; release(): void }>(),
    takenCodexLeases: new WeakSet<object>(),
    codexAskSessions: new Set<string>(),
    codexTelemetrySources,
    indexedRuns: new Map(),
    notIndexedSessions: new Map(),
    codexContextRollouts: new Map(),
    keptCodexConversations: new Map<string, { uuid: string }>(),
    lastCodexHookRollout: new Map(),
    claudeTranscripts: new Map<string, string>(),
    claudeFolders: new Map(),
    codexFolders: new Map(),
    noteGatewayToken: () => {},
    dropGatewayToken: (sid: string) => h.rec('dropGatewayToken')(sid),
    forgetCodexHooks: (sid: string) => {
      const file = codexHookFiles.get(sid)
      codexHookFiles.delete(sid)
      file?.dispose()
      h.rec('forgetCodexHooks')(sid)
    },
    keepCodexConversation: () => {},
    markCodexConversationUncertain: () => {},
    clearCodexDoubtFromHook: () => {},
    noteCodexContextRollout: () => {},
    endSessionNotIndexed: (sid: string) => h.rec('endSessionNotIndexed')(sid),
    noteCodexFolder: () => {},
    savedConfigLoggingOff: () => undefined,
    noteClaudeFolder: () => {},
    noteClaudeTranscript: () => {},
    markSessionNotIndexed: () => {},
    closeCodexRunScreen: (sid: string) => h.rec('closeCodexRunScreen')(sid),
  }
  return ports
}
let ports = makePorts()

beforeEach(() => {
  h.calls.length = 0
  h.profiles = {}
  h.folderRemover = true
  ports = makePorts()
  lb.setLaunchBindingPorts(ports as unknown as Ports)
  // The session helper's answer: only KEPT is kept by an update now.
  seam.setKeptLaunchCheck((sid) => sid === KEPT)
})
afterEach(() => {
  seam.setKeptLaunchCheck(null)
})

/** A Codex launch's hook file and telemetry, as its bindings hold them. */
function launched(sid: string): void {
  ports.codexHookFiles.set(sid, { hookFile: `${FOLDER}-${sid}/hook.json`, dispose: () => h.rec('hookFile.dispose')(sid) })
  ports.codexTelemetrySources.set(sid, { stop: () => h.rec('source.stop')(sid) })
}

/** The session's end as pty-manager.ts runs it: its exit's file unbind, then the teardown's three. */
function end(sid: string): void {
  lb.unbindLaunchFiles(sid)
  lb.unbindLaunchProvider(sid)
  lb.unbindLaunchTelemetry(sid)
  lb.unbindLaunchRegistrations(sid)
}

describe('a session an update keeps running keeps what its launch put on disk through its kill', () => {
  it('its three per-session files and its hook folder stay; its gateway token, telemetry and registrations go as before; a session not kept loses all of it', () => {
    launched(KEPT)
    launched(ENDED)
    end(KEPT)
    const kept = h.calls.splice(0)
    expect(kept).toEqual([
      `dropGatewayToken ${KEPT}`,
      `endSessionNotIndexed ${KEPT}`,
      `source.stop ${KEPT}`,
      `binder.endRun ${KEPT}`,
      `forgetCodexHooks ${KEPT}`,
      `unregisterCodexReviewSession ${KEPT}`,
      `releaseMcpSessionProvider ${KEPT}`,
      `revokeCanvasUatRoots ${KEPT}`,
      `forgetCanvasMarkers ${KEPT}`,
      `closeCodexRunScreen ${KEPT}`,
      `forgetCodexSessionGuidance ${KEPT}`,
    ])
    expect(ports.codexHookFiles.has(KEPT)).toBe(false)
    expect(ports.codexTelemetrySources.has(KEPT)).toBe(false)
    end(ENDED)
    expect(h.calls).toEqual([
      `dropGatewayToken ${ENDED}`,
      `removeLocalSessionSettings ${ENDED}`,
      `removeLocalSessionMcpConfig ${ENDED}`,
      `removeLocalSessionStatusUrl ${ENDED}`,
      `endSessionNotIndexed ${ENDED}`,
      `source.stop ${ENDED}`,
      `binder.endRun ${ENDED}`,
      `hookFile.dispose ${ENDED}`,
      `forgetCodexHooks ${ENDED}`,
      `unregisterCodexReviewSession ${ENDED}`,
      `releaseMcpSessionProvider ${ENDED}`,
      `revokeCanvasUatRoots ${ENDED}`,
      `forgetCanvasMarkers ${ENDED}`,
      `closeCodexRunScreen ${ENDED}`,
      `forgetCodexSessionGuidance ${ENDED}`,
    ])
  })

  it('once the session helper no longer keeps it, its next end removes everything again', () => {
    seam.setKeptLaunchCheck(() => false)
    launched(KEPT)
    lb.unbindLaunchFiles(KEPT)
    lb.unbindLaunchTelemetry(KEPT)
    expect(h.calls).toContain(`removeLocalSessionSettings ${KEPT}`)
    expect(h.calls).toContain(`hookFile.dispose ${KEPT}`)
  })
})

describe('what the release records of a kept session (describeLaunch)', () => {
  it('a Codex session: its claim, its lease\'s account and its hook folder', () => {
    launched(KEPT)
    ports.keptCodexConversations.set(KEPT, { uuid: ID })
    ports.codexLaunchLeases.set(KEPT, { accountId: 'acct-7', release: () => {} })
    expect(lb.describeLaunch(KEPT)).toEqual({ conversation: ID, account: 'acct-7', hookFolder: `${FOLDER}-${KEPT}` })
  })

  it('a Claude Code session: the conversation its transcript\'s name gives, and the profile it started under; none for the default account', () => {
    ports.claudeTranscripts.set(CL, `/home/u/.claude/projects/p/${ID2}.jsonl`)
    h.profiles[CL] = 'profile-mt4okz66-147e4a'
    expect(lb.describeLaunch(CL)).toEqual({ conversation: ID2, account: 'profile-mt4okz66-147e4a', hookFolder: null })
    delete h.profiles[CL]
    expect(lb.describeLaunch(CL).account).toBeNull()
  })

  it('a session that has not started a conversation yet, or names a file that is not one: none', () => {
    expect(lb.describeLaunch(CL)).toEqual({ conversation: null, account: null, hookFolder: null })
    ports.claudeTranscripts.set(CL, '/home/u/.claude/projects/p/notes.jsonl')
    expect(lb.describeLaunch(CL).conversation).toBeNull()
  })

  it('the seam answers with the launch bindings\' own, handed over when they load', () => {
    ports.keptCodexConversations.set(KEPT, { uuid: ID })
    expect(seam.describeKeptLaunch(KEPT)).toEqual({ conversation: ID, account: null, hookFolder: null })
  })
})

describe('what a kept session left, removed once it is not kept (removeKeptLaunchFiles)', () => {
  it('its three per-session files, and its hook folder by its provider', () => {
    seam.removeKeptLaunch({ sessionId: KEPT, provider: 'codex', hookFolder: FOLDER })
    expect(h.calls).toEqual([
      `removeLocalSessionSettings ${KEPT}`,
      `removeLocalSessionMcpConfig ${KEPT}`,
      `removeLocalSessionStatusUrl ${KEPT}`,
      `removeSessionHookFolder codex ${FOLDER}`,
    ])
  })

  it('no hook folder: the provider is not asked; a provider that removes none: the files still go', () => {
    lb.removeKeptLaunchFiles({ sessionId: CL, provider: 'claude', hookFolder: null })
    expect(h.calls.filter((c) => c.startsWith('removeSessionHookFolder'))).toEqual([])
    h.calls.length = 0
    h.folderRemover = false
    lb.removeKeptLaunchFiles({ sessionId: KEPT, provider: 'codex', hookFolder: FOLDER })
    expect(h.calls).toEqual([`removeLocalSessionSettings ${KEPT}`, `removeLocalSessionMcpConfig ${KEPT}`, `removeLocalSessionStatusUrl ${KEPT}`])
  })
})
