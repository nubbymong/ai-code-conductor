// Windows: the callers of the Claude Code resolution that are not a session's
// launch. The path the Find Claude step shows (ipc/cli-handlers.ts,
// IPC.CLI_PATH) and the first-run setup terminal (ipc/setup-handlers.ts,
// setup:spawnCliSetup) resolve Claude Code the way a launch does
// (providers/claude/spawn.ts): a walk of PATH under a minute old is the
// answer, found or not, and PATH is not walked again in place.
//
// So both wait first for the walk a session's launch waits for
// (claude-launch-walk.ts): off the event loop, each folder bounded. Without
// that wait a Claude Code installed in the last minute, into a folder PATH
// already names, was seen by neither for up to a minute, while the check
// beside the path (IPC.CLI_CHECK, which walks every time) said it was
// installed; and with no answer kept at all, both walked PATH in place.
//
// The REAL handlers, the real launch walk, the real kept answers and the real
// resolution. Host-safe: every file test, node-pty, the first-start warm-up
// and the PowerShell profile question are stand-ins answered here. Nothing is
// started, no file of this computer is read, and PATH is put back after each
// case. A file test a case left held is answered after it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as nodeOs from 'node:os'

const h = vi.hoisted(() => ({
  platform: 'win32' as NodeJS.Platform,
  /** The files the PATH walk finds, lower-cased. */
  present: new Set<string>(),
  /** Folders whose file tests do not answer (a share that is down), lower-cased. */
  hung: new Set<string>(),
  /** The file tests held there; `release()` answers them all. */
  held: [] as Array<() => void>,
  /** The walks made off the event loop, by the names each was for. */
  walks: [] as string[],
  /** The walks made in place, on the caller's own turn, by the names each was for. */
  walksInPlace: [] as string[],
  /** What the setup terminal warmed up and started, in order. */
  order: [] as string[],
  /** Claude Code switched off: what the launch rule answers. */
  refused: null as null | { code: string; providerId: string; message: string },
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
}))
const release = (): void => { for (const answer of h.held.splice(0)) answer() }

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => h.platform }))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: () => nodeOs.tmpdir(), getVersion: () => '0.0.0' },
}))
vi.mock('node-pty', () => ({
  spawn: (file: string) => {
    h.order.push(`pty ${file}`)
    return { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() }
  },
}))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  const hangs = (p: string): boolean => h.hung.has(p.slice(0, p.lastIndexOf('\\')).toLowerCase())
  /** The stand-in file test: held for a folder that does not answer. */
  const stat = (p: string): Promise<boolean> => {
    if (!hangs(p)) return Promise.resolve(h.present.has(p.toLowerCase()))
    return new Promise<boolean>((resolve) => { h.held.push(() => resolve(h.present.has(p.toLowerCase()))) })
  }
  return {
    ...real,
    // The real bound, over the stand-in file test.
    fileTestWithin: (waitMs?: number) => real.fileTestWithin(waitMs, stat),
    findOnWindowsPath: (names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') => {
      h.walksInPlace.push(names.join(','))
      // A walk in place cannot be given up: a folder that does not answer
      // would hold the main process, which is what must not happen.
      return real.findOnWindowsPath(names, env, (p) => {
        if (hangs(p)) throw new Error('this file test would hold the main process')
        return h.present.has(p.toLowerCase())
      }, order)
    },
    findOnWindowsPathAsync: (names: readonly string[], env: NodeJS.ProcessEnv, test?: (p: string) => Promise<boolean>, order?: 'folder' | 'name') => {
      h.walks.push(names.join(','))
      return real.findOnWindowsPathAsync(names, env, test ?? stat, order)
    },
    findWithPowerShellProfile: () => Promise.resolve({ outcome: 'none' as const }),
  }
})
// The look for node.exe the check makes beside its own walk is not this
// file's subject: it looks at nothing here.
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()),
  warmPickerNodeOnWindows: () => Promise.resolve(),
}))
// The resolution every caller here asks for: the registered Claude provider's,
// which is resolveClaudeBinary (pty-manager.ts resolveClaudeForPty). The real
// one, without the PTY manager around it.
vi.mock('../../../src/main/pty-manager', async () => {
  const { resolveClaudeBinary } = await import('../../../src/main/providers/claude/spawn')
  return { resolveClaudeForPty: () => resolveClaudeBinary() }
})
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => h.refused, providerProbeRefusal: () => null }))
vi.mock('../../../src/main/first-start-warmup', () => ({
  warmFirstStart: async (program: string) => {
    h.order.push(`warm ${program}`)
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
}))
vi.mock('../../../src/main/claude-headless', () => ({ spawnClaudeHeadless: vi.fn() }))
vi.mock('../../../src/main/help-workspace', () => ({ ensureHelpWorkspace: () => null }))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))
vi.mock('../../../src/main/data-paths', () => ({
  getDataDirectory: () => nodeOs.tmpdir(), getResourcesDirectory: () => nodeOs.tmpdir(),
  setDataDirectory: vi.fn(), setResourcesDirectory: vi.fn(), isDataDirFromRegistry: () => true,
}))

const { armClaudeLaunchWalk, _resetClaudeLaunchWalkForTest } = await import('../../../src/main/claude-launch-walk')
const { WINDOWS_PATH_FILE_TEST_WAIT_MS, _resetFileTestWithinForTest } = await import('../../../src/main/windows-programs')
const { claudeOnWindowsPathAsync, recordClaudeOnWindows, CLAUDE_NOT_ON_PATH, _resetClaudeWindowsLookupForTest } = await import('../../../src/main/claude-cli-probe')
const { registerCliHandlers } = await import('../../../src/main/ipc/cli-handlers')
const { IPC } = await import('../../../src/shared/ipc-channels')
// The shared test setup replaces setup-handlers with a stub; this suite drives the real one.
const setup = await vi.importActual<typeof import('../../../src/main/ipc/setup-handlers')>('../../../src/main/ipc/setup-handlers')

const GONE = 'S:\\gone'
const TOOLS = 'C:\\Tools'
const CLAUDE = `${TOOLS}\\claude.exe`
const CLAUDE_NAMES = 'claude.exe,claude.cmd,claude.bat'
const WAIT = WINDOWS_PATH_FILE_TEST_WAIT_MS
const OFF = { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' }
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedPath = process.env.PATH

/** The handlers, registered as main registers them (Windows, by then). */
const handler = (channel: string) => (...args: unknown[]): Promise<unknown> => Promise.resolve(h.handlers.get(channel)!({ sender: {} }, ...args))
const cliCheck = handler(IPC.CLI_CHECK)
const cliPath = handler(IPC.CLI_PATH)
const spawnCliSetup = (): Promise<unknown> => handler('setup:spawnCliSetup')(100, 20)
const killCliSetup = handler('setup:killCliSetup')
/** Claude Code is put into a folder PATH already names. */
const install = (): void => { h.present = new Set([CLAUDE.toLowerCase()]) }

beforeEach(() => {
  h.platform = 'win32'
  h.present = new Set()
  h.hung = new Set()
  h.held = []
  h.walks = []
  h.walksInPlace = []
  h.order = []
  h.refused = null
  _resetClaudeLaunchWalkForTest()
  _resetClaudeWindowsLookupForTest()
  _resetFileTestWithinForTest()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  h.handlers.clear()
  registerCliHandlers()
  setup.registerSetupHandlers()
})
afterEach(async () => {
  release()
  // A setup terminal a case started is ended, so the next starts with none.
  await killCliSetup()
  vi.useRealTimers()
  _resetClaudeLaunchWalkForTest()
  _resetClaudeWindowsLookupForTest()
  _resetFileTestWithinForTest()
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
})

describe('the path the Find Claude step shows (IPC.CLI_PATH)', () => {
  // Mutation to prove this can fail: resolve without waiting for the walk.
  it('shows a Claude Code installed since a walk under a minute old found none, as the check beside it does', async () => {
    process.env.PATH = TOOLS
    armClaudeLaunchWalk()
    expect(await cliCheck(), 'a walk just now: none').toBe(false)
    expect(await cliPath()).toBeNull()
    install()
    // The step asks both at the same time.
    expect(await Promise.all([cliCheck(), cliPath()])).toEqual([true, CLAUDE])
    expect(h.walksInPlace, 'nothing was walked in place').toEqual([])
  })

  // Mutation to prove this can fail: walk in place when no answer is kept.
  it('with no answer kept and a PATH folder that does not answer: it waits for the walk off the event loop, the folder given its bounded time, and walks nothing in place', async () => {
    vi.useFakeTimers()
    process.env.PATH = `${GONE};${TOOLS}`
    h.hung = new Set([GONE.toLowerCase()])
    install()
    armClaudeLaunchWalk()
    let shown: unknown = 'not answered yet'
    void cliPath().then((p) => { shown = p })
    await vi.advanceTimersByTimeAsync(WAIT - 1)
    expect(shown, 'not before the folder\'s bound').toBe('not answered yet')
    expect(h.walksInPlace).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(shown).toBe(CLAUDE)
    expect(h.walks).toEqual([CLAUDE_NAMES])
    expect(h.walksInPlace).toEqual([])
  })

  it('with a recent answer kept (the usual case, the check\'s): it reads that, and nothing is walked', async () => {
    process.env.PATH = TOOLS
    armClaudeLaunchWalk()
    recordClaudeOnWindows(TOOLS, CLAUDE, Date.now())
    expect(await cliPath()).toBe(CLAUDE)
    expect(h.walks).toEqual([])
    expect(h.walksInPlace).toEqual([])
  })

  it('off Windows nothing is walked: the name the session\'s login shell resolves, as before', async () => {
    h.platform = 'linux'
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env.PATH = TOOLS
    armClaudeLaunchWalk()
    expect(await cliPath()).toBe('claude')
    expect(h.walks).toEqual([])
    expect(h.walksInPlace).toEqual([])
  })
})

describe('the first-run setup terminal (setup:spawnCliSetup)', () => {
  // Mutation to prove this can fail: resolve without waiting for the walk.
  it('starts a Claude Code installed since a walk under a minute old found none', async () => {
    process.env.PATH = TOOLS
    armClaudeLaunchWalk()
    expect(await claudeOnWindowsPathAsync(process.env), 'a walk just now: none').toBeNull()
    install()
    expect(await spawnCliSetup()).toBe('__cli_setup__')
    expect(h.order).toEqual([`warm ${CLAUDE}`, `pty ${CLAUDE}`])
    expect(h.walksInPlace, 'nothing was walked in place').toEqual([])
  })

  it('with Claude Code in no folder PATH names it is refused as before, with the same message: never a bare name', async () => {
    process.env.PATH = TOOLS
    armClaudeLaunchWalk()
    await expect(spawnCliSetup()).rejects.toThrow(CLAUDE_NOT_ON_PATH)
    expect(h.order).toEqual([])
    expect(h.walksInPlace).toEqual([])
  })

  it('with a recent answer kept nothing is waited for: no walk, and the terminal starts what the answer names', async () => {
    process.env.PATH = TOOLS
    armClaudeLaunchWalk()
    recordClaudeOnWindows(TOOLS, CLAUDE, Date.now())
    expect(await spawnCliSetup()).toBe('__cli_setup__')
    expect(h.order).toEqual([`warm ${CLAUDE}`, `pty ${CLAUDE}`])
    expect(h.walks).toEqual([])
    expect(h.walksInPlace).toEqual([])
  })

  // The walk can take seconds. Mutation to prove these can fail: go on to
  // the warm-up after the walk without asking again.
  it('closed while PATH is walked: no terminal, nothing warmed up, and nothing counts as Claude Code in use', async () => {
    process.env.PATH = `${GONE};${TOOLS}`
    h.hung = new Set([GONE.toLowerCase()])
    install()
    armClaudeLaunchWalk()
    const started = spawnCliSetup()
    await vi.waitFor(() => expect(h.held).toHaveLength(1))
    expect(h.order).toEqual([])
    expect(await killCliSetup()).toBe(true)
    release()
    expect(await started).toBeNull()
    expect(h.order).toEqual([])
    expect(h.walksInPlace).toEqual([])
    expect(setup.countCliSetupInUse()).toBe(0)
  })

  it('Claude Code switched off while PATH is walked: refused, and nothing of it is warmed up or started', async () => {
    process.env.PATH = `${GONE};${TOOLS}`
    h.hung = new Set([GONE.toLowerCase()])
    install()
    armClaudeLaunchWalk()
    const started = spawnCliSetup()
    await vi.waitFor(() => expect(h.held).toHaveLength(1))
    h.refused = OFF
    release()
    expect(await started).toEqual({ refused: OFF })
    expect(h.order).toEqual([])
  })

  it('a second start while the first waits for the walk: both wait for one walk, and only the newer one starts a terminal', async () => {
    process.env.PATH = `${GONE};${TOOLS}`
    h.hung = new Set([GONE.toLowerCase()])
    install()
    armClaudeLaunchWalk()
    const first = spawnCliSetup()
    await vi.waitFor(() => expect(h.held).toHaveLength(1))
    const second = spawnCliSetup()
    // The second has reached its own wait (it asks no folder again).
    await new Promise((r) => setTimeout(r, 20))
    release()
    expect(await first).toBeNull()
    expect(await second).toBe('__cli_setup__')
    expect(h.walks).toEqual([CLAUDE_NAMES])
    expect(h.order).toEqual([`warm ${CLAUDE}`, `pty ${CLAUDE}`])
    expect(setup.countCliSetupInUse()).toBe(1)
  })
})
