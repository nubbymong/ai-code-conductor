/**
 * github-config.json holds the saved GitHub accounts next to the GitHub
 * settings. A read of it that failed (another program held the file, the text
 * was not JSON, a newer build wrote it) used to be answered "no config", and
 * the next change then saved defaults plus that one change over every saved
 * account.
 *
 * Driven through the real IPC handlers, the real stores and a real temporary
 * folder:
 *   - after a read that failed, every channel that writes the file answers a
 *     refusal and leaves the file byte for byte;
 *   - a save that fails part way leaves the old file whole;
 *   - no file at all still starts empty;
 *   - a settings change made at the same moment as an account edit, or as the
 *     start-up migration, keeps both.
 *
 * Only the file calls on github-config.json are intercepted, to fail a read or
 * a replace on demand. Everything that would reach the network or start a
 * program is an inert fake.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => {
  const state = {
    handlers: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
    /** The errno a read of github-config.json fails with; null reads for real. */
    readFault: null as string | null,
    /** true: the step that puts new bytes in place of github-config.json fails part way. */
    replaceFault: false,
  }
  const isConfig = (p: unknown): boolean => typeof p === 'string' && p.endsWith('github-config.json')
  const errno = (code: string): Error => Object.assign(new Error(`${code}: simulated`), { code })
  /** node's fs, with the two faults above on github-config.json only. */
  const faultyFs = async (importOriginal: () => Promise<unknown>) => {
    const real = (await importOriginal()) as typeof import('node:fs')
    const promises = {
      ...real.promises,
      readFile: async (p: unknown, o: unknown) => {
        if (state.readFault && isConfig(p)) throw errno(state.readFault)
        return real.promises.readFile(p as string, o as BufferEncoding)
      },
      // An overwrite in place: half of the new bytes land, then it fails.
      copyFile: async (from: unknown, to: unknown) => {
        if (state.replaceFault && isConfig(to)) {
          const bytes = real.readFileSync(from as string)
          real.writeFileSync(to as string, bytes.subarray(0, Math.floor(bytes.length / 2)))
          throw errno('EIO')
        }
        return real.promises.copyFile(from as string, to as string)
      },
      rename: async (from: unknown, to: unknown) => {
        if (state.replaceFault && isConfig(to)) throw errno('EIO')
        return real.promises.rename(from as string, to as string)
      },
    }
    const patched = {
      ...real,
      promises,
      readFileSync: (p: unknown, o: unknown) => {
        if (state.readFault && isConfig(p)) throw errno(state.readFault)
        return real.readFileSync(p as string, o as BufferEncoding)
      },
      renameSync: (from: unknown, to: unknown) => {
        if (state.replaceFault && isConfig(to)) throw errno('EIO')
        return real.renameSync(from as string, to as string)
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
vi.mock('../../../src/main/github/session/sync-orchestrator', () => ({
  SyncOrchestrator: class { registerSession() {} unregisterSession() {} setFocus() {} resume() {} pause() {} },
}))
vi.mock('../../../src/main/github/session/notifications-poller', () => ({
  NotificationsPoller: class { syncTo() {} resume() {} pause() {} },
}))
vi.mock('../../../src/main/github/copilot-usage', () => ({
  AiUsageScheduler: class { start() {} getLatest() { return null } async refresh() { return null } },
}))

const real = await vi.importActual<typeof import('node:fs')>('node:fs')
const { registerGitHubHandlers } = await import('../../../src/main/ipc/github-handlers')
const { IPC } = await import('../../../src/shared/ipc-channels')
const { emptyGitHubConfig, DEFAULT_AUTH_FEATURE_TOGGLES } = await import('../../../src/shared/github-constants')

/** What a refused change says: the file's name, never its folder. */
const UNREADABLE = 'The GitHub settings file (github-config.json) could not be read, so nothing was changed.'

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
    },
    defaultAuthProfileId: 'p-b',
    enabledByDefault: true,
  }
}
const SEED_TEXT = JSON.stringify(seedConfig(), null, 2)

const mainFrame = { name: 'main' }
const webContents = { mainFrame, send: () => {} }
const win = { isDestroyed: () => false, webContents }
const APP = { sender: webContents, senderFrame: mainFrame }

let dir: string
let file: string

function call(channel: string, ...args: unknown[]): Promise<any> {
  const fn = h.state.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return Promise.resolve(fn(APP, ...args))
}

/** Registers the handlers on the test folder, as a start of the app does. */
function start(): void {
  h.state.handlers.clear()
  registerGitHubHandlers({
    resourcesDir: dir,
    getWindow: () => win as never,
    loadSessions: async () => [],
    saveSessions: async () => {},
  })
}

/** Lets the start-up read (and a write it leads to) finish. */
async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 5))
    await call(IPC.GITHUB_CONFIG_GET)
  }
}

const onDisk = (): string => real.readFileSync(file, 'utf8')
const saved = () => JSON.parse(onDisk())

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

/** Every channel that writes the file. `rejects`: the channel has no `{ ok }` answer to refuse with. */
const WRITERS: Array<[string, () => Promise<unknown>, 'answers' | 'rejects']> = [
  ['adopting a gh account', () => call(IPC.GITHUB_PROFILE_ADOPT_GHCLI, 'octo-new'), 'answers'],
  ['adding a token', () => call(IPC.GITHUB_PROFILE_ADD_PAT, { kind: 'pat-classic', label: 'work', rawToken: 'not-a-real-token-value' }), 'answers'],
  ['signing in with the device flow', async () => {
    const flow = await call(IPC.GITHUB_OAUTH_START, 'public')
    return call(IPC.GITHUB_OAUTH_POLL, flow.flowId)
  }, 'answers'],
  ['removing an account', () => call(IPC.GITHUB_PROFILE_REMOVE, 'p-a'), 'answers'],
  ['renaming an account', () => call(IPC.GITHUB_PROFILE_RENAME, 'p-a', 'renamed'), 'answers'],
  ['changing an account\'s features', () => call(IPC.GITHUB_PROFILE_UPDATE, 'p-a', {
    featureToggles: { ...DEFAULT_AUTH_FEATURE_TOGGLES, ci: false },
  }), 'answers'],
  ['changing a setting', () => call(IPC.GITHUB_CONFIG_UPDATE, { transcriptScanningOptIn: true }), 'rejects'],
]

beforeEach(() => {
  dir = real.mkdtempSync(path.join(os.tmpdir(), 'ghcfg-keep-'))
  file = path.join(dir, 'github-config.json')
  h.state.readFault = null
  h.state.replaceFault = false
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  h.state.readFault = null
  h.state.replaceFault = false
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

describe('a save that fails part way', () => {
  it.each([
    ['a settings change', () => call(IPC.GITHUB_CONFIG_UPDATE, { transcriptScanningOptIn: true })],
    ['a new account', () => call(IPC.GITHUB_PROFILE_ADOPT_GHCLI, 'octo-new')],
    ['a removed account', () => call(IPC.GITHUB_PROFILE_REMOVE, 'p-a')],
  ])('%s: the old file stays whole and nothing staged is left behind', async (_what, write) => {
    real.writeFileSync(file, SEED_TEXT, 'utf8')
    start()
    await settled()

    h.state.replaceFault = true
    await expect(write()).rejects.toThrow(/EIO/)
    expect(onDisk()).toBe(SEED_TEXT)
    expect(real.readdirSync(dir)).toEqual(['github-config.json'])

    // The next save, once the fault is gone, starts from that whole file.
    h.state.replaceFault = false
    await call(IPC.GITHUB_CONFIG_UPDATE, { transcriptScanningOptIn: true })
    expect(saved()).toEqual({ ...seedConfig(), transcriptScanningOptIn: true })
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
