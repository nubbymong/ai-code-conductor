/**
 * github-config.json holds the saved GitHub accounts next to the GitHub
 * settings. A file that is there but did not read (another program held it,
 * the text was not JSON, a newer build wrote it) is never replaced: every
 * change is refused with one fixed sentence and the file is left as it is,
 * the same rule profiles.json follows for the Claude accounts.
 *
 * Driven through the real IPC handlers, the real stores and a real temporary
 * folder:
 *   - after a read that failed, every channel that writes the file answers a
 *     refusal and leaves the file byte for byte;
 *   - a save that fails part way leaves the old file whole, and is answered
 *     with a fixed sentence that carries no path;
 *   - no file at all, and a file with nothing in it, start empty;
 *   - a settings change made at the same moment as an account edit, or as the
 *     start-up migration, keeps both;
 *   - a settings change carries settings only, and one key of a sub-map
 *     changes that key only;
 *   - a device sign-in for a saved account is one write;
 *   - the settings pages, through the renderer's own store, never save
 *     defaults that stood in for settings that were not read;
 *   - the timers (the sync, the notifications, the AI-usage meter) read a
 *     file that stays unreadable once per hold and not once per lookup, and a
 *     button the user pressed does not wait for that hold.
 *
 * Only the file calls on github-config.json are intercepted, to fail a read or
 * a replace on demand. Everything that would reach the network or start a
 * program is an inert fake: a request to GitHub asks for its token, as a real
 * one does, and is answered an empty success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => {
  const state = {
    handlers: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
    /** The errno a read of github-config.json fails with; null reads for real. */
    readFault: null as string | null,
    /** How many reads of github-config.json there were since it was last set to 0. */
    reads: 0,
    /** The read (counted by `reads`) that fails with EBUSY; null fails none. */
    readFaultAt: null as number | null,
    /** true: the step that puts new bytes in place of github-config.json fails part way. */
    replaceFault: false,
    /** true: the copy staged beside github-config.json cannot be written. */
    stageFault: false,
    /** What main gave the sync, the notifications and the AI-usage meter to ask
     *  with: the lookups their timers make. */
    sync: null as null | {
      getConfig: () => Promise<{ authProfiles: Record<string, unknown> } | null>
      fetchers: { pr: (ctx: { sessionId: string; slug: string; branch: string }) => Promise<unknown> }
    },
    poller: null as null | { getConfig: () => Promise<{ authProfiles: Record<string, unknown> } | null> },
    usage: null as null | { resolve: () => Promise<{ login: string } | null> },
    /** The token each faked request to GitHub was made with. */
    tokens: [] as string[],
    /** The account each refresh of the AI-usage meter found (null: none). */
    usageTargets: [] as Array<string | null>,
  }
  const isConfig = (p: unknown): boolean => typeof p === 'string' && p.endsWith('github-config.json')
  const isStaged = (p: unknown): boolean => typeof p === 'string' && /github-config\.json\..*\.tmp$/.test(p)
  // As node words them: the code, then the call and the full path.
  const errno = (code: string, p: unknown = ''): Error =>
    Object.assign(new Error(`${code}: simulated, open '${String(p)}'`), { code })
  /** node's fs, with the faults above on github-config.json only. */
  const faultyFs = async (importOriginal: () => Promise<unknown>) => {
    const real = (await importOriginal()) as typeof import('node:fs')
    const promises = {
      ...real.promises,
      readFile: async (p: unknown, o: unknown) => {
        if (isConfig(p)) {
          state.reads++
          if (state.readFault) throw errno(state.readFault, p)
          if (state.readFaultAt === state.reads) throw errno('EBUSY', p)
        }
        return real.promises.readFile(p as string, o as BufferEncoding)
      },
      // An overwrite in place: half of the new bytes land, then it fails.
      copyFile: async (from: unknown, to: unknown) => {
        if (state.replaceFault && isConfig(to)) {
          const bytes = real.readFileSync(from as string)
          real.writeFileSync(to as string, bytes.subarray(0, Math.floor(bytes.length / 2)))
          throw errno('EIO', to)
        }
        return real.promises.copyFile(from as string, to as string)
      },
      rename: async (from: unknown, to: unknown) => {
        if (state.replaceFault && isConfig(to)) throw errno('EIO', to)
        return real.promises.rename(from as string, to as string)
      },
    }
    const patched = {
      ...real,
      promises,
      readFileSync: (p: unknown, o: unknown) => {
        if (state.readFault && isConfig(p)) throw errno(state.readFault, p)
        return real.readFileSync(p as string, o as BufferEncoding)
      },
      renameSync: (from: unknown, to: unknown) => {
        if (state.replaceFault && isConfig(to)) throw errno('EIO', to)
        return real.renameSync(from as string, to as string)
      },
      writeFileSync: (p: unknown, d: unknown, o: unknown) => {
        if (state.stageFault && isStaged(p)) throw errno('ENOSPC', p)
        return real.writeFileSync(p as string, d as string, o as BufferEncoding)
      },
    }
    return { ...patched, default: patched }
  }
  return { state, faultyFs }
})

vi.mock('fs', h.faultyFs)
vi.mock('node:fs', h.faultyFs)
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { h.state.handlers.set(ch, fn) },
    on: () => {},
  },
  BrowserWindow: { fromWebContents: () => null },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {} }))
vi.mock('../../../src/main/channel-emitters', () => ({ emitPrMerged: () => {} }))
vi.mock('../../../src/main/active-session', () => ({ setActiveSessionId: () => {} }))
vi.mock('../../../src/main/github/auth/gh-cli-delegate', () => ({
  ghAuthStatus: async () => ['octo-new'],
  ghAuthToken: async () => 'not-a-real-token-value',
  defaultGhRun: () => async () => '',
}))
vi.mock('../../../src/main/github/auth/oauth-device-flow', () => ({
  requestDeviceCode: async () => ({
    device_code: 'device-code-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
  }),
  pollForAccessToken: async () => ({ access_token: 'not-a-real-token-value' }),
}))
vi.mock('../../../src/main/github/auth/pat-verifier', () => ({
  verifyToken: async () => ({ username: 'octo-new', avatarUrl: '', scopes: ['repo'] }),
  probeRepoAccess: async () => true,
}))
vi.mock('../../../src/main/github/cache/cache-store', () => ({
  CacheStore: class { async load() { return { repos: {} } } async save() {} },
}))
// A request to GitHub: asks for its token, as a real one does, and is answered
// an empty success. Nothing leaves the process.
vi.mock('../../../src/main/github/client/github-fetch', () => ({
  githubFetch: async (_path: string, opts: { tokenFn: () => Promise<string> }) => {
    h.state.tokens.push(await opts.tokenFn())
    return { ok: true, status: 200, json: async () => ({ node_id: 'node-1' }) }
  },
}))
vi.mock('../../../src/main/github/client/rest-fallback', () => ({
  fetchPRByBranch: async (_slug: string, _branch: string, opts: { tokenFn: () => Promise<string> }) => {
    h.state.tokens.push(await opts.tokenFn())
    return null
  },
  fetchPRReviews: async () => [],
  fetchWorkflowRuns: async () => [],
}))
// The sync, the notifications and the AI-usage meter keep what main gave them
// to ask with, so a test can ask as their timers do. A sync asks its fetcher,
// and a refresh of the meter asks which account to use.
vi.mock('../../../src/main/github/session/sync-orchestrator', () => ({
  SyncOrchestrator: class {
    constructor(deps: never) { h.state.sync = deps }
    registerSession() {} unregisterSession() {} setFocus() {} resume() {} pause() {}
    async syncNow(sessionId: string) {
      await h.state.sync!.fetchers.pr({ sessionId, slug: 'octo/repo', branch: 'main' })
    }
  },
}))
vi.mock('../../../src/main/github/session/notifications-poller', () => ({
  NotificationsPoller: class {
    constructor(deps: never) { h.state.poller = deps }
    syncTo() {} resume() {} pause() {}
  },
}))
vi.mock('../../../src/main/github/copilot-usage', () => ({
  AiUsageScheduler: class {
    constructor(deps: never) { h.state.usage = deps }
    start() {} getLatest() { return null } getStatus() { return 'ok' } getLatestCycle() { return null }
    async refresh() {
      h.state.usageTargets.push((await h.state.usage!.resolve())?.login ?? null)
      return null
    }
  },
}))

const real = await vi.importActual<typeof import('node:fs')>('node:fs')
const { registerGitHubHandlers } = await import('../../../src/main/ipc/github-handlers')
const { IPC } = await import('../../../src/shared/ipc-channels')
const {
  emptyGitHubConfig,
  DEFAULT_AUTH_FEATURE_TOGGLES,
  GITHUB_CONFIG_SCHEMA_VERSION,
} = await import('../../../src/shared/github-constants')
const { useGitHubStore } = await import('../../../src/renderer/stores/githubStore')
const { FAILED_READ_HOLD_MS } = await import('../../../src/main/github/github-config-store')

/** What a refused change says when the file did not read: the file's name and
 *  what to do next, never its folder's path. */
const UNREADABLE =
  'The GitHub settings file (github-config.json) could not be read, so nothing was changed. '
  + 'Close other programs that may be using it, or move github-config.json out of the CONFIG folder '
  + 'in the AI Code Conductor resources folder and sign in to GitHub again.'
/** What a change says when the file read and the save then failed. */
const NOT_SAVED =
  'The GitHub settings file (github-config.json) could not be saved, so nothing was changed. '
  + 'Close other programs that may be using it and try again.'

/** Two saved accounts, one of them holding a token, and one setting changed from its default. */
function seedConfig() {
  return {
    ...emptyGitHubConfig(),
    authProfiles: {
      'p-a': {
        id: 'p-a', kind: 'gh-cli', label: 'octo-a', username: 'octo-a', scopes: [], capabilities: ['pulls'],
        ghCliUsername: 'octo-a', createdAt: 1, lastVerifiedAt: 1, expiryObservable: false,
        featureToggles: { ...DEFAULT_AUTH_FEATURE_TOGGLES },
      },
      'p-b': {
        id: 'p-b', kind: 'oauth', label: 'octo-b', username: 'octo-b', scopes: ['repo'], capabilities: ['pulls'],
        tokenCiphertext: Buffer.from('enc:not-a-real-token-value').toString('base64'),
        createdAt: 2, lastVerifiedAt: 2, expiryObservable: false,
        featureToggles: { ...DEFAULT_AUTH_FEATURE_TOGGLES },
      },
    } as Record<string, Record<string, unknown>>,
    defaultAuthProfileId: 'p-b' as string | undefined,
    enabledByDefault: true,
  }
}
const SEED_TEXT = JSON.stringify(seedConfig(), null, 2)

/** The seed with every sub-map and setting away from its default. */
function customSeed() {
  return {
    ...seedConfig(),
    appWideToggles: { localGit: true, sessionContext: false },
    featureDefaults: { ...DEFAULT_AUTH_FEATURE_TOGGLES, ci: false, aiCredits: true },
    syncIntervals: { activeSessionSec: 30, backgroundSec: 900, notificationsSec: 600 },
    seenOnboardingVersion: '1.0.0',
  }
}
const CUSTOM_TEXT = JSON.stringify(customSeed(), null, 2)

const mainFrame = { name: 'main' }
const webContents = { mainFrame, send: () => {} }
const win = { isDestroyed: () => false, webContents }
const APP = { sender: webContents, senderFrame: mainFrame }

let dir: string
let file: string
/** What registering the handlers gave back (the app sets the focused session through it). */
let app: ReturnType<typeof registerGitHubHandlers>

function call(channel: string, ...args: unknown[]): Promise<any> {
  const fn = h.state.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return Promise.resolve(fn(APP, ...args))
}

/** Registers the handlers on the test folder, as a start of the app does. */
function start(sessions?: { loadSessions: () => Promise<any[]>; saveSessions: (s: any[]) => Promise<void> }): void {
  h.state.handlers.clear()
  app = registerGitHubHandlers({
    resourcesDir: dir,
    getWindow: () => win as never,
    loadSessions: sessions?.loadSessions ?? (async () => []),
    saveSessions: sessions?.saveSessions ?? (async () => {}),
  })
}

/** Lets the start-up read (and a write it leads to) finish. */
async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 5))
    await call(IPC.GITHUB_CONFIG_GET)
  }
}

/** Lets what a start of the app does in the background finish, without reading the file. */
async function idle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 5))
}

const onDisk = (): string => real.readFileSync(file, 'utf8')
const saved = () => JSON.parse(onDisk())
/** Each thing console.warn was given, as one line. */
const warnLines = (): string[] =>
  (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((args) => args.map(String).join(' '))
/** Everything console.warn was given, as one text. */
const warned = (): string => warnLines().join(' | ')

/** Each way the file can fail to read; `arrange` runs with the seed on disk. */
const UNREADABLE_FILES: Array<[string, () => void]> = [
  ['another program holds it (EBUSY)', () => { h.state.readFault = 'EBUSY' }],
  ['it is locked (EPERM)', () => { h.state.readFault = 'EPERM' }],
  ['access to it is denied (EACCES)', () => { h.state.readFault = 'EACCES' }],
  ['its text is not JSON', () => { real.writeFileSync(file, SEED_TEXT.slice(0, SEED_TEXT.length - 40), 'utf8') }],
  ['a newer build wrote it (unknown schemaVersion)', () => {
    real.writeFileSync(file, JSON.stringify({ ...seedConfig(), schemaVersion: 9999 }, null, 2), 'utf8')
  }],
]

const signInWithDevice = async (): Promise<any> => {
  const flow = await call(IPC.GITHUB_OAUTH_START, 'public')
  return call(IPC.GITHUB_OAUTH_POLL, flow.flowId)
}

/** Every channel that writes the file. `rejects`: the channel has no `{ ok }` answer to refuse with. */
const WRITERS: Array<[string, () => Promise<unknown>, 'answers' | 'rejects']> = [
  ['adopting a gh account', () => call(IPC.GITHUB_PROFILE_ADOPT_GHCLI, 'octo-new'), 'answers'],
  ['adding a token', () => call(IPC.GITHUB_PROFILE_ADD_PAT, { kind: 'pat-classic', label: 'work', rawToken: 'not-a-real-token-value' }), 'answers'],
  ['signing in with the device flow', signInWithDevice, 'answers'],
  ['removing an account', () => call(IPC.GITHUB_PROFILE_REMOVE, 'p-a'), 'answers'],
  ['renaming an account', () => call(IPC.GITHUB_PROFILE_RENAME, 'p-a', 'renamed'), 'answers'],
  ['changing an account\'s features', () => call(IPC.GITHUB_PROFILE_UPDATE, 'p-a', {
    featureToggles: { ...DEFAULT_AUTH_FEATURE_TOGGLES, ci: false },
  }), 'answers'],
  ['changing a setting', () => call(IPC.GITHUB_CONFIG_UPDATE, { transcriptScanningOptIn: true }), 'rejects'],
]

function resetFaults(): void {
  h.state.readFault = null
  h.state.readFaultAt = null
  h.state.reads = 0
  h.state.replaceFault = false
  h.state.stageFault = false
  h.state.tokens = []
  h.state.usageTargets = []
}

beforeEach(() => {
  dir = real.mkdtempSync(path.join(os.tmpdir(), 'ghcfg-keep-'))
  file = path.join(dir, 'github-config.json')
  resetFaults()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  resetFaults()
  vi.restoreAllMocks()
})

describe.each(UNREADABLE_FILES)('github-config.json does not read: %s', (_why, arrange) => {
  it.each(WRITERS)('%s is refused and the file is left byte for byte', async (_what, write, how) => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    arrange()
    const before = onDisk()
    start()
    await settled()

    let answer: unknown
    let rejection: unknown
    try { answer = await write() } catch (err) { rejection = err }

    expect(onDisk()).toBe(before)
    if (how === 'answers') {
      expect(rejection).toBeUndefined()
      expect(answer).toEqual({ ok: false, error: UNREADABLE })
    } else {
      expect(answer).toBeUndefined()
      expect((rejection as Error).message).toBe(UNREADABLE)
    }
    // Nothing was staged beside the file and left there either.
    expect(real.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('reading the settings still answers, with no config, so the panel renders', async () => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    arrange()
    const before = onDisk()
    start()
    await settled()
    expect(await call(IPC.GITHUB_CONFIG_GET)).toBeNull()
    expect(onDisk()).toBe(before)
  })

  it('asked with readState, reading the settings says the file did not read', async () => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    arrange()
    const before = onDisk()
    start()
    await settled()
    expect(await call(IPC.GITHUB_CONFIG_GET, { readState: true })).toEqual({ config: null, readFailed: true })
    expect(onDisk()).toBe(before)
  })
})

describe('reading the settings, asked with readState', () => {
  it('no file: no config, and nothing failed', async () => {
    start()
    await settled()
    expect(await call(IPC.GITHUB_CONFIG_GET, { readState: true })).toEqual({ config: null, readFailed: false })
  })

  it('a file that reads: the config', async () => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start()
    await settled()
    expect(await call(IPC.GITHUB_CONFIG_GET, { readState: true })).toEqual({ config: seedConfig(), readFailed: false })
  })

  it('not asked: the config itself or null, as the channel has always answered', async () => {
    start()
    await settled()
    expect(await call(IPC.GITHUB_CONFIG_GET)).toBeNull()
    expect(await call(IPC.GITHUB_CONFIG_GET, {})).toBeNull()
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    expect(await call(IPC.GITHUB_CONFIG_GET)).toEqual(seedConfig())
    expect(await call(IPC.GITHUB_CONFIG_GET, { readState: 'yes' })).toEqual(seedConfig())
  })
})

describe('a read that failed once', () => {
  it('refuses that change, and the same change goes through once the file reads again, every earlier account kept', async () => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start()
    await settled()

    h.state.readFault = 'EBUSY'
    expect(await call(IPC.GITHUB_PROFILE_ADOPT_GHCLI, 'octo-new')).toEqual({ ok: false, error: UNREADABLE })
    await expect(call(IPC.GITHUB_CONFIG_UPDATE, { transcriptScanningOptIn: true })).rejects.toThrow(UNREADABLE)
    expect(onDisk()).toBe(SEED_TEXT)

    h.state.readFault = null
    const added = await call(IPC.GITHUB_PROFILE_ADOPT_GHCLI, 'octo-new')
    expect(added.ok).toBe(true)
    const patched = await call(IPC.GITHUB_CONFIG_UPDATE, { transcriptScanningOptIn: true })
    expect(patched.transcriptScanningOptIn).toBe(true)

    const after = saved()
    expect(Object.keys(after.authProfiles).sort()).toEqual([added.id, 'p-a', 'p-b'].sort())
    expect(after.authProfiles['p-b']).toEqual(seedConfig().authProfiles['p-b'])
    expect(after.defaultAuthProfileId).toBe('p-b')
    expect(after.enabledByDefault).toBe(true)
    expect(after.transcriptScanningOptIn).toBe(true)
  })

  it('as the app started, is not remembered as "no accounts": once the file reads, a saved account can sign in again', async () => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    h.state.readFault = 'EBUSY'
    start()
    await settled()

    h.state.readFault = null
    const answer = await call(IPC.GITHUB_REAUTH_PROFILE, 'p-b')
    expect(answer.ok).toBe(true)
    expect(answer.plan.kind).toBe('oauth')
  })
})

describe('no github-config.json yet (first run)', () => {
  it('the first account makes the file, from the defaults', async () => {
    start()
    await settled()
    expect(real.existsSync(file)).toBe(false)
    const added = await call(IPC.GITHUB_PROFILE_ADOPT_GHCLI, 'octo-new')
    expect(added.ok).toBe(true)
    const after = saved()
    expect(Object.keys(after.authProfiles)).toEqual([added.id])
    expect({ ...after, authProfiles: {} }).toEqual(emptyGitHubConfig())
  })

  it('the first settings change makes the file, from the defaults', async () => {
    start()
    await settled()
    const answer = await call(IPC.GITHUB_CONFIG_UPDATE, { transcriptScanningOptIn: true })
    expect(answer).toEqual({ ...emptyGitHubConfig(), transcriptScanningOptIn: true })
    expect(saved()).toEqual(answer)
  })
})

// A file with nothing in it holds no account: it is taken as no file, and the
// first write replaces it.
describe('a github-config.json with nothing in it', () => {
  it.each([
    ['no bytes at all', ''],
    ['only NUL characters', '\0'.repeat(256)],
    ['only white space', ' \r\n\t'],
    ['only a byte-order mark', String.fromCharCode(0xfeff)],
  ])('%s: it reads as no file, and the first account replaces it', async (_what, text) => {
    real.writeFileSync(file, text, 'utf8')
    start()
    await settled()
    expect(await call(IPC.GITHUB_CONFIG_GET, { readState: true })).toEqual({ config: null, readFailed: false })
    const added = await call(IPC.GITHUB_PROFILE_ADOPT_GHCLI, 'octo-new')
    expect(added.ok).toBe(true)
    const after = saved()
    expect(Object.keys(after.authProfiles)).toEqual([added.id])
    expect({ ...after, authProfiles: {} }).toEqual(emptyGitHubConfig())
    expect(real.readdirSync(dir)).toEqual(['github-config.json'])
  })
})

// The answer to a save that failed is one fixed sentence. What failed, and
// where, goes to the log in main; the renderer is never handed a path.
describe.each([
  ['at the step that replaces the file', () => { h.state.replaceFault = true }, 'EIO'],
  ['while the new bytes are being staged', () => { h.state.stageFault = true }, 'ENOSPC'],
] as Array<[string, () => void, string]>)('a save that fails part way, %s', (_where, fault, code) => {
  it.each(WRITERS)('%s: a fixed sentence with no path, the old file whole, nothing staged left behind', async (_what, write, how) => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start()
    await settled()

    fault()
    let answer: unknown
    let rejection: unknown
    try { answer = await write() } catch (err) { rejection = err }

    if (how === 'answers') {
      expect(rejection).toBeUndefined()
      expect(answer).toEqual({ ok: false, error: NOT_SAVED })
    } else {
      expect(answer).toBeUndefined()
      expect((rejection as Error).message).toBe(NOT_SAVED)
      expect(String(rejection)).not.toContain(path.basename(dir))
    }
    expect(onDisk()).toBe(SEED_TEXT)
    expect(real.readdirSync(dir)).toEqual(['github-config.json'])
    // What failed is in main's log.
    expect(warned()).toContain(`[github-config] write failed: Error: ${code}`)

    // The next save, once the fault is gone, starts from that whole file.
    resetFaults()
    await call(IPC.GITHUB_CONFIG_UPDATE, { transcriptScanningOptIn: true })
    const after = saved()
    expect(after.transcriptScanningOptIn).toBe(true)
    expect(after.authProfiles['p-b']).toEqual(seedConfig().authProfiles['p-b'])
  })
})

describe('a settings change at the same moment as another write', () => {
  const patch = () => call(IPC.GITHUB_CONFIG_UPDATE, { transcriptScanningOptIn: true })
  const adopt = () => call(IPC.GITHUB_PROFILE_ADOPT_GHCLI, 'octo-new')

  /** Both changes are in the file, on top of everything that was there. */
  function expectBothKept(): void {
    const after = saved()
    expect(after.transcriptScanningOptIn).toBe(true)
    const usernames = Object.values(after.authProfiles as Record<string, { username: string }>).map((p) => p.username)
    expect(usernames.sort()).toEqual(['octo-a', 'octo-b', 'octo-new'])
    expect(after.defaultAuthProfileId).toBe('p-b')
  }

  it('the setting first, the account edit right behind it: both are kept', async () => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start()
    await settled()
    await Promise.all([patch(), adopt()])
    expectBothKept()
  })

  it('the account edit first, the setting right behind it: both are kept', async () => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start()
    await settled()
    await Promise.all([adopt(), patch()])
    expectBothKept()
  })

  it('the setting sent while the account edit is reading: both are kept', async () => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start()
    await settled()
    const adding = adopt()
    await new Promise((r) => setImmediate(r))
    await Promise.all([adding, patch()])
    expectBothKept()
  })

  it('several of each at once: every one is kept', async () => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start()
    await settled()
    await Promise.all([
      adopt(),
      call(IPC.GITHUB_CONFIG_UPDATE, { transcriptScanningOptIn: true }),
      call(IPC.GITHUB_PROFILE_RENAME, 'p-a', 'renamed'),
      call(IPC.GITHUB_CONFIG_UPDATE, { enabledByDefault: false }),
      call(IPC.GITHUB_PROFILE_REMOVE, 'p-b'),
      call(IPC.GITHUB_CONFIG_UPDATE, { seenOnboardingVersion: '9.9.9' }),
    ])
    const after = saved()
    expect(after.transcriptScanningOptIn).toBe(true)
    expect(after.enabledByDefault).toBe(false)
    expect(after.seenOnboardingVersion).toBe('9.9.9')
    expect(after.authProfiles['p-a'].label).toBe('renamed')
    expect(after.authProfiles['p-b']).toBeUndefined()
    expect(after.defaultAuthProfileId).toBeUndefined()
    expect(Object.values(after.authProfiles as Record<string, { username: string }>).map((p) => p.username).sort()).toEqual(['octo-a', 'octo-new'])
  })

  it('the start-up migration and a settings change sent as the app starts: both are kept', async () => {
    // A file from before the per-account toggles: no featureDefaults, no appWideToggles.
    const { featureDefaults: _d, appWideToggles: _w, ...old } = seedConfig()
    real.writeFileSync(file, JSON.stringify(old, null, 2), 'utf8')
    start()
    await patch()
    await settled()
    const after = saved()
    expect(after.transcriptScanningOptIn).toBe(true)
    expect(after.featureDefaults).toBeDefined()
    expect(after.appWideToggles).toBeDefined()
    expect(Object.keys(after.authProfiles).sort()).toEqual(['p-a', 'p-b'])
  })
})

// GITHUB_CONFIG_UPDATE changes the settings and nothing else. The accounts,
// the default account and the schema version have their own paths; a patch
// that carries them changes none of them.
describe('a settings change carries settings only', () => {
  const update = (patch: unknown) => call(IPC.GITHUB_CONFIG_UPDATE, patch)

  it('a schemaVersion in it is left out: the file keeps its version, and the next change is not refused', async () => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start()
    await settled()
    const answer = await update({ schemaVersion: 9999, transcriptScanningOptIn: true })
    expect(answer.schemaVersion).toBe(GITHUB_CONFIG_SCHEMA_VERSION)
    expect(saved()).toEqual({ ...seedConfig(), transcriptScanningOptIn: true })
    const added = await call(IPC.GITHUB_PROFILE_ADOPT_GHCLI, 'octo-new')
    expect(added.ok).toBe(true)
  })

  it('authProfiles and defaultAuthProfileId in it are left out: every account is kept', async () => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start()
    await settled()
    await update({ authProfiles: {}, defaultAuthProfileId: 'someone-else', enabledByDefault: false })
    expect(saved()).toEqual({ ...seedConfig(), enabledByDefault: false })
  })

  it.each([
    ['only keys that are not settings', { schemaVersion: 9999, authProfiles: {}, defaultAuthProfileId: 'x', featureToggles: {}, madeUp: 1 }],
    ['nothing at all', {}],
    ['not an object', 'transcriptScanningOptIn'],
    ['a list', [{ transcriptScanningOptIn: true }]],
    ['null', null],
  ])('%s: nothing is written, and the answer is the config as it is', async (_what, patch) => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start()
    await settled()
    const answer = await update(patch)
    expect(answer).toEqual(seedConfig())
    expect(onDisk()).toBe(SEED_TEXT)
  })

  it('a value of the wrong kind is left out, and the rest of the change is made', async () => {
    real.writeFileSync(file, CUSTOM_TEXT, 'utf8')
    start()
    await settled()
    await update({
      enabledByDefault: 'yes',
      transcriptScanningOptIn: true,
      seenOnboardingVersion: 42,
      syncIntervals: { activeSessionSec: 120, backgroundSec: 'soon', notificationsSec: -5, madeUp: 9 },
      appWideToggles: { localGit: 'no', sessionContext: true, madeUp: true },
      featureDefaults: { ci: 1, reviews: false, madeUp: true },
    })
    const c = customSeed()
    expect(saved()).toEqual({
      ...c,
      transcriptScanningOptIn: true,
      syncIntervals: { ...c.syncIntervals, activeSessionSec: 120 },
      appWideToggles: { ...c.appWideToggles, sessionContext: true },
      featureDefaults: { ...c.featureDefaults, reviews: false },
    })
  })

  it.each([
    ['one sync interval', { syncIntervals: { backgroundSec: 300 } }, (c: ReturnType<typeof customSeed>) => ({ ...c, syncIntervals: { ...c.syncIntervals, backgroundSec: 300 } })],
    ['one app-wide toggle', { appWideToggles: { localGit: false } }, (c: ReturnType<typeof customSeed>) => ({ ...c, appWideToggles: { ...c.appWideToggles, localGit: false } })],
    ['one feature default', { featureDefaults: { notifications: true } }, (c: ReturnType<typeof customSeed>) => ({ ...c, featureDefaults: { ...c.featureDefaults, notifications: true } })],
  ])('%s changes that key, and the other keys of the map keep what the file had', async (_what, patch, expected) => {
    real.writeFileSync(file, CUSTOM_TEXT, 'utf8')
    start()
    await settled()
    const answer = await update(patch)
    expect(saved()).toEqual(expected(customSeed()))
    expect(answer).toEqual(saved())
  })

  it('a feature default set on a file that has none yet starts from the built-in defaults', async () => {
    const { featureDefaults: _d, ...old } = customSeed()
    real.writeFileSync(file, JSON.stringify(old, null, 2), 'utf8')
    // Hold the read so the start-up migration (which adds the defaults) cannot run first.
    h.state.readFault = 'EBUSY'
    start()
    await settled()
    h.state.readFault = null
    await update({ featureDefaults: { ci: false } })
    expect(saved().featureDefaults).toEqual({ ...DEFAULT_AUTH_FEATURE_TOGGLES, ci: false })
  })
})

// A device sign-in for an account that is already saved replaces the saved
// profile. Adding the new one and removing the old one are one read and one
// write, so a read that fails leaves the file exactly as it was.
describe('a device sign-in for an account that is already saved', () => {
  const OLD_TOGGLES = { ...DEFAULT_AUTH_FEATURE_TOGGLES, ci: false, aiCredits: true }
  function seedWithEarlierSignIn() {
    const c = seedConfig()
    c.authProfiles['p-old'] = {
      id: 'p-old', kind: 'oauth', label: 'octo-new', username: 'octo-new', scopes: ['public_repo'], capabilities: ['pulls'],
      tokenCiphertext: Buffer.from('enc:an-earlier-token-value').toString('base64'),
      createdAt: 3, lastVerifiedAt: 3, expiryObservable: false,
      featureToggles: { ...OLD_TOGGLES },
    }
    c.defaultAuthProfileId = 'p-old'
    return c
  }

  it.each([1, 2, 3])(
    'when read number %i of the file fails: the file is unchanged or fully changed, never half, and the answer says which',
    async (failAt) => {
      real.writeFileSync(file, JSON.stringify(seedWithEarlierSignIn(), null, 2), 'utf8')
      start()
      await settled()
      const flow = await call(IPC.GITHUB_OAUTH_START, 'public')
      const before = onDisk()

      h.state.reads = 0
      h.state.readFaultAt = failAt
      const answer = await call(IPC.GITHUB_OAUTH_POLL, flow.flowId)
      h.state.readFaultAt = null
      await settled()

      if (failAt === 1) {
        // The one read the sign-in makes failed: refused, nothing changed.
        expect(answer).toEqual({ ok: false, error: UNREADABLE })
      } else {
        expect(answer.ok).toBe(true)
      }
      if (answer.ok) {
        const after = saved()
        expect(Object.keys(after.authProfiles).sort()).toEqual([answer.profileId, 'p-a', 'p-b'].sort())
        expect(after.authProfiles[answer.profileId].username).toBe('octo-new')
        expect(after.authProfiles[answer.profileId].featureToggles).toEqual(OLD_TOGGLES)
        expect(after.defaultAuthProfileId).toBeUndefined()
      } else {
        expect(onDisk()).toBe(before)
      }
      // The flow is over either way: its code was used up.
      expect(await call(IPC.GITHUB_OAUTH_POLL, flow.flowId)).toEqual({ ok: false, error: 'not-found' })
    },
  )

  it('a first sign-in for the account adds it, seeded from the defaults', async () => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start()
    await settled()
    const answer = await signInWithDevice()
    expect(answer.ok).toBe(true)
    const after = saved()
    expect(Object.keys(after.authProfiles).sort()).toEqual([answer.profileId, 'p-a', 'p-b'].sort())
    expect(after.authProfiles[answer.profileId].featureToggles).toEqual(DEFAULT_AUTH_FEATURE_TOGGLES)
    expect(after.defaultAuthProfileId).toBe('p-b')
  })
})

// Removing an account also clears the sessions bound to it. A removal that
// was refused removed nothing, so no session is touched.
describe('removing an account, and the sessions bound to it', () => {
  const boundSession = () => [
    { id: 's-1', githubIntegration: { enabled: true, authProfileId: 'p-a', autoDetected: false } },
    { id: 's-2', githubIntegration: { enabled: true, authProfileId: 'p-b', autoDetected: false } },
  ]

  it.each([
    ['the file did not read', () => { h.state.readFault = 'EBUSY' }, UNREADABLE],
    ['the save failed', () => { h.state.replaceFault = true }, NOT_SAVED],
  ] as Array<[string, () => void, string]>)('refused because %s: the session bindings are not read or saved', async (_why, fault, sentence) => {
    const loadSessions = vi.fn(async () => boundSession())
    const saveSessions = vi.fn(async () => {})
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start({ loadSessions, saveSessions })
    await settled()
    loadSessions.mockClear()

    fault()
    expect(await call(IPC.GITHUB_PROFILE_REMOVE, 'p-a')).toEqual({ ok: false, error: sentence })
    expect(loadSessions).not.toHaveBeenCalled()
    expect(saveSessions).not.toHaveBeenCalled()
    expect(onDisk()).toBe(SEED_TEXT)
  })

  it('once it goes through, the bindings to that account are cleared and the others kept', async () => {
    const loadSessions = vi.fn(async () => boundSession())
    const saveSessions = vi.fn(async (_s: any[]) => {})
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start({ loadSessions, saveSessions })
    await settled()

    expect(await call(IPC.GITHUB_PROFILE_REMOVE, 'p-a')).toEqual({ ok: true })
    expect(saveSessions).toHaveBeenCalledTimes(1)
    const written = saveSessions.mock.calls[0][0]
    expect(written[0].githubIntegration.authProfileId).toBeUndefined()
    expect(written[1].githubIntegration.authProfileId).toBe('p-b')
  })
})

// The sync, the notifications and the AI-usage meter ask for the config on
// their timers: every tick of every session, every poll. A file that stays
// unreadable is not read at each of those. The failed answer stands in for a
// short hold, is never kept past it or as "no accounts", and is dropped at
// once when anything reads the file. A button the user pressed does not wait
// for the hold: it is there for the timers.
describe('a file that does not read, and the lookups the timers make', () => {
  const TOKEN = 'not-a-real-token-value'
  const READ_FAILED = '[github-config] read failed: Error EBUSY'
  const readFailedLines = (): string[] => warnLines().filter((l) => l.includes('read failed'))
  /** One session with GitHub on, bound to no account: its token is the first account's that has one. */
  const oneSession = () => ({
    loadSessions: async () => [
      { id: 's-1', githubIntegration: { enabled: true, repoSlug: 'octo/repo', autoDetected: false } },
    ],
    saveSessions: async () => {},
  })
  /** The clock, moved on by `ahead` so a hold can run out without waiting for it. */
  let ahead: number
  const passTheHold = (): void => { ahead += FAILED_READ_HOLD_MS }

  beforeEach(() => {
    ahead = 0
    const clock = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => clock() + ahead)
  })

  /** The app starts while another program holds the file; the session is the focused one. */
  async function startedOnAFileThatDoesNotRead(): Promise<void> {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    h.state.readFault = 'EBUSY'
    start(oneSession())
    app.setFocusedSessionResolver(() => 's-1')
    await idle()
    h.state.reads = 0
  }

  /** Each timer asks once: the sync and the notifications for the config, the meter for its account. */
  async function timersAsk(): Promise<[unknown, unknown, unknown]> {
    return [await h.state.sync!.getConfig(), await h.state.poller!.getConfig(), await h.state.usage!.resolve()]
  }
  const NOTHING = [null, null, null]

  it('inside the hold, however often they ask, the file is not read again and the log has its one line', async () => {
    await startedOnAFileThatDoesNotRead()
    for (let i = 0; i < 20; i++) expect(await timersAsk()).toEqual(NOTHING)
    const together = await Promise.all(Array.from({ length: 20 }, () => h.state.sync!.getConfig()))
    expect(together).toEqual(Array.from({ length: 20 }, () => null))
    expect(h.state.reads).toBe(0)
    expect(readFailedLines()).toEqual([READ_FAILED])
    expect(onDisk()).toBe(SEED_TEXT)
  })

  it('after the hold the file is read again: once for all of them, and once per hold after that', async () => {
    await startedOnAFileThatDoesNotRead()
    passTheHold()
    for (let i = 0; i < 20; i++) expect(await timersAsk()).toEqual(NOTHING)
    expect(h.state.reads).toBe(1)
    passTheHold()
    for (let i = 0; i < 20; i++) expect(await timersAsk()).toEqual(NOTHING)
    expect(h.state.reads).toBe(2)
    // The same failure, read three times over: still one line.
    expect(readFailedLines()).toEqual([READ_FAILED])
  })

  it('a failed answer is never kept past the hold: once the file reads, the accounts are back and kept', async () => {
    await startedOnAFileThatDoesNotRead()
    h.state.readFault = null
    // Still inside the hold: nothing has read the file since it failed.
    expect(await timersAsk()).toEqual(NOTHING)
    expect(h.state.reads).toBe(0)

    passTheHold()
    const [forSync, forPoller, forMeter] = await timersAsk()
    expect(Object.keys((forSync as { authProfiles: object }).authProfiles).sort()).toEqual(['p-a', 'p-b'])
    expect(forPoller).toEqual(forSync)
    expect((forMeter as { login: string }).login).toBe('octo-b')
    // Read once, and that answer is the one kept.
    const reads = h.state.reads
    for (let i = 0; i < 5; i++) expect(await h.state.sync!.getConfig()).toEqual(forSync)
    expect(h.state.reads).toBe(reads)
  })

  it.each([
    ['a settings page reads the file', () => call(IPC.GITHUB_CONFIG_GET, { readState: true })],
    ['a save reads the file', () => call(IPC.GITHUB_PROFILE_RENAME, 'p-a', 'renamed')],
  ] as Array<[string, () => Promise<unknown>]>)(
    'a read that succeeds inside the hold ends it at once (%s): the next lookup has the accounts',
    async (_what, readIt) => {
      await startedOnAFileThatDoesNotRead()
      h.state.readFault = null
      expect(await h.state.sync!.getConfig()).toBeNull()
      await readIt()
      const cfg = await h.state.sync!.getConfig()
      expect(Object.keys(cfg!.authProfiles).sort()).toEqual(['p-a', 'p-b'])
    },
  )

  // What the user asked for by pressing a button is looked up from the file
  // now. Each of these is pressed inside the hold, right after the file
  // started reading again, and finds the saved account's token.
  const PRESSED: Array<[string, () => Promise<unknown>]> = [
    ['merging a pull request', () => call(IPC.GITHUB_PR_MERGE, 'octo/repo', 7, 'squash')],
    ['re-running a workflow', () => call(IPC.GITHUB_ACTIONS_RERUN, 'octo/repo', 42)],
    ['marking a pull request ready', () => call(IPC.GITHUB_PR_READY, 'octo/repo', 7)],
    ['replying to a review', () => call(IPC.GITHUB_REVIEW_REPLY, 'octo/repo', '123', 'thanks')],
    ['Sync now on the session', () => call(IPC.GITHUB_SYNC_NOW, 's-1')],
    ['Sync now on the settings page', () => call(IPC.GITHUB_SYNC_FOCUSED_NOW)],
  ]

  it.each(PRESSED)('%s does not wait for the hold: the file is read now', async (_what, press) => {
    await startedOnAFileThatDoesNotRead()
    h.state.readFault = null
    // A timer asking at this moment still gets the held answer, and no token.
    await expect(h.state.sync!.fetchers.pr({ sessionId: 's-1', slug: 'octo/repo', branch: 'main' })).rejects.toThrow('no-token')
    expect(h.state.reads).toBe(0)

    expect(await press()).toEqual({ ok: true })
    // Every request it made carried the saved account's token.
    expect(h.state.tokens.length).toBeGreaterThan(0)
    expect([...new Set(h.state.tokens)]).toEqual([TOKEN])
    // And what it read is there for the timers too.
    expect(await h.state.sync!.getConfig()).not.toBeNull()
  })

  it('Refresh on the AI-usage meter does not wait for the hold; the meter asking by itself does', async () => {
    await startedOnAFileThatDoesNotRead()
    h.state.readFault = null
    await call(IPC.GITHUB_AI_USAGE_GET, false)
    expect(h.state.usageTargets).toEqual([null])
    expect(h.state.reads).toBe(0)
    await call(IPC.GITHUB_AI_USAGE_GET, true)
    expect(h.state.usageTargets).toEqual([null, 'octo-b'])
  })

  it('turning GitHub on for a session does not wait for the hold: its first sync finds the token', async () => {
    await startedOnAFileThatDoesNotRead()
    h.state.readFault = null
    expect(await call(IPC.GITHUB_SESSION_CONFIG_UPDATE, 's-1', { enabled: true })).toEqual({ ok: true })
    // Registering the session starts its first sync at once, which asks for the session's token.
    await h.state.sync!.fetchers.pr({ sessionId: 's-1', slug: 'octo/repo', branch: 'main' })
    expect(h.state.tokens).toEqual([TOKEN])
  })

  it.each(PRESSED)('%s while the file still does not read: one read, no token, and the file is left as it is', async (_what, press) => {
    await startedOnAFileThatDoesNotRead()
    const answer = await press().then((a) => a, (err: Error) => ({ ok: false, error: err.message }))
    expect(answer).toEqual({ ok: false, error: 'no-token' })
    expect(h.state.tokens).toEqual([])
    expect(h.state.reads).toBe(1)
    // The hold starts again from that read.
    expect(await timersAsk()).toEqual(NOTHING)
    expect(h.state.reads).toBe(1)
    expect(readFailedLines()).toEqual([READ_FAILED])
    expect(onDisk()).toBe(SEED_TEXT)
  })
})

// The settings pages hold the config in the renderer's store and build some
// changes from it. Driven here through that store, on a bridge wired to the
// handlers above as the preload wires it: a page opened while the file did
// not read shows the defaults, and no change is ever built from them.
describe('the settings pages, opened while the file did not read', () => {
  let apiBefore: unknown

  beforeEach(() => {
    const w = (globalThis as unknown as { window: { electronAPI: Record<string, unknown> } }).window
    apiBefore = w.electronAPI
    w.electronAPI = {
      ...w.electronAPI,
      github: {
        getConfig: () => call(IPC.GITHUB_CONFIG_GET, { readState: true }),
        updateConfig: (patch: unknown) => call(IPC.GITHUB_CONFIG_UPDATE, patch),
        updateProfile: (id: string, patch: unknown) => call(IPC.GITHUB_PROFILE_UPDATE, id, patch),
        removeProfile: (id: string) => call(IPC.GITHUB_PROFILE_REMOVE, id),
        renameProfile: (id: string, label: string) => call(IPC.GITHUB_PROFILE_RENAME, id, label),
      },
    }
    useGitHubStore.setState({ config: null, profiles: [], saveError: null, configUnread: false } as never)
  })
  afterEach(() => {
    ;(globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = apiBefore
  })

  /** The app starts and the page opens while another program holds the file. */
  async function openedOnAFileThatDidNotRead(): Promise<void> {
    real.writeFileSync(file, CUSTOM_TEXT, 'utf8')
    h.state.readFault = 'EBUSY'
    start()
    await settled()
    await useGitHubStore.getState().loadConfig()
  }

  it('shows the defaults and says the file did not read', async () => {
    await openedOnAFileThatDidNotRead()
    const s = useGitHubStore.getState() as unknown as Record<string, unknown>
    expect(s.configUnread).toBe(true)
    expect(s.saveError).toBe(UNREADABLE)
    expect(s.config).toEqual(emptyGitHubConfig())
    expect(s.profiles).toEqual([])
  })

  it('while the file still does not read, every change is refused and the file is left byte for byte', async () => {
    await openedOnAFileThatDidNotRead()
    const store = useGitHubStore.getState()
    await expect(store.setAppWideToggle('localGit', false)).rejects.toThrow(UNREADABLE)
    await expect(store.updateConfig({ enabledByDefault: false })).rejects.toThrow(UNREADABLE)
    await expect(store.updateConfig({ seenOnboardingVersion: '9.9.9' })).rejects.toThrow(UNREADABLE)
    await expect(store.removeProfile('p-a')).rejects.toThrow(UNREADABLE)
    await expect(store.renameProfile('p-a', 'renamed')).rejects.toThrow(UNREADABLE)
    expect(onDisk()).toBe(CUSTOM_TEXT)
    expect(useGitHubStore.getState().saveError).toBe(UNREADABLE)
  })

  type Store = ReturnType<typeof useGitHubStore.getState>
  type Custom = ReturnType<typeof customSeed>
  it.each([
    [
      'an app-wide toggle',
      (s: Store) => s.setAppWideToggle('localGit', false),
      (c: Custom) => ({ ...c, appWideToggles: { ...c.appWideToggles, localGit: false } }),
    ],
    [
      'a sync interval',
      (s: Store) => s.updateConfig({ syncIntervals: { activeSessionSec: 120 } }),
      (c: Custom) => ({ ...c, syncIntervals: { ...c.syncIntervals, activeSessionSec: 120 } }),
    ],
    [
      'the privacy switch',
      (s: Store) => s.updateConfig({ transcriptScanningOptIn: true }),
      (c: Custom) => ({ ...c, transcriptScanningOptIn: true }),
    ],
    [
      'the version stamp of the set-up page',
      (s: Store) => s.updateConfig({ seenOnboardingVersion: '9.9.9' }),
      (c: Custom) => ({ ...c, seenOnboardingVersion: '9.9.9' }),
    ],
    [
      'one feature of one account',
      (s: Store) => s.setProfileFeature('p-a', 'ci', false),
      (c: Custom) => {
        const next = structuredClone(c)
        next.authProfiles['p-a'].featureToggles = { ...DEFAULT_AUTH_FEATURE_TOGGLES, ci: false }
        return next
      },
    ],
  ] as Array<[string, (s: Store) => Promise<void>, (c: Custom) => unknown]>)(
    'once the file reads again, %s changes that one value and every other value in the file is kept',
    async (_what, change, expected) => {
      await openedOnAFileThatDidNotRead()
      h.state.readFault = null

      await change(useGitHubStore.getState())

      expect(saved()).toEqual(expected(customSeed()))
      const s = useGitHubStore.getState() as unknown as Record<string, unknown>
      expect(s.configUnread).toBe(false)
      expect(s.saveError).toBeNull()
      expect(s.config).toEqual(saved())
      expect((s.profiles as unknown[]).length).toBe(2)
    },
  )
})
