// 2.1.1-beta.3 (F26): every check the user asks
// for brings this process's PATH up to date first (windows-path-refresh.ts
// refreshWindowsPath), and each such call is counted
// (windows-programs.ts noteWindowsPathRefresh). That count is the only signal
// that makes the PowerShell profile's kept answer (claude-cli-probe.ts) be
// asked again, so Check again after a profile edit finds the change without
// a restart, while the 30 s CLI check never runs the profile by itself.
//
// Host-safe: the registry read, the PATH walk and the PowerShell question are
// stand-ins answered by this test; nothing is started and no file is read.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  holdRegistry: false,
  registryReads: 0,
  registryRelease: [] as Array<() => void>,
  profileCalls: 0,
  profileAnswer: null as string | null,
}))
vi.mock('../../../src/main/windows-registry-path', async (importOriginal) => {
  type Values = import('../../../src/main/windows-registry-path').RegistryPaths
  return {
    ...(await importOriginal<typeof import('../../../src/main/windows-registry-path')>()),
    readRegistryPaths: (): Promise<Values> => {
      h.registryReads += 1
      const none: Values = { machine: null, user: null }
      if (!h.holdRegistry) return Promise.resolve(none)
      return new Promise<Values>((resolve) => { h.registryRelease.push(() => resolve(none)) })
    },
  }
})
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  type Lookup = import('../../../src/main/windows-programs').PowerShellProfileLookup
  return {
    ...(await importOriginal<typeof import('../../../src/main/windows-programs')>()),
    findOnWindowsPathAsync: async () => null,
    findWithPowerShellProfile: async (): Promise<Lookup> => {
      h.profileCalls += 1
      return h.profileAnswer ? { outcome: 'found', path: h.profileAnswer } : { outcome: 'none' }
    },
  }
})
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'win32' }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }))

const { refreshWindowsPath, afterPathRefresh } = await import('../../../src/main/windows-path-refresh')
const { windowsPathRefreshCount } = await import('../../../src/main/windows-programs')
const { probeClaudeCli, findClaudeOnWindowsAsync, setClaudeProfileLookupAllowed, _resetClaudeCliProbeForTest, _resetClaudeWindowsLookupForTest } =
  await import('../../../src/main/claude-cli-probe')

const FNM = 'C:\\Users\\me\\AppData\\Local\\fnm_multishells\\1234_1700000000\\claude.cmd'
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedPath = process.env.PATH

beforeEach(() => {
  h.holdRegistry = false
  h.registryReads = 0
  h.registryRelease = []
  h.profileCalls = 0
  h.profileAnswer = null
  _resetClaudeCliProbeForTest()
  _resetClaudeWindowsLookupForTest()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
})

describe('a check the user asks for is counted, and only that makes the PowerShell profile be asked again', () => {
  // Mutation to prove this can fail: drop the noteWindowsPathRefresh() call
  // from refreshWindowsPath.
  it('each refreshWindowsPath call counts once: one that joins a refresh already running too, and off Windows too', async () => {
    const before = windowsPathRefreshCount()
    h.holdRegistry = true
    const first = refreshWindowsPath()
    expect(windowsPathRefreshCount()).toBe(before + 1)
    const joined = refreshWindowsPath()
    expect(windowsPathRefreshCount()).toBe(before + 2)
    expect(h.registryReads, 'the second call shares the read already running').toBe(1)
    for (const r of h.registryRelease.splice(0)) r()
    expect(await first).toEqual([])
    expect(await joined).toEqual([])
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(await refreshWindowsPath()).toEqual([])
    expect(windowsPathRefreshCount()).toBe(before + 3)
    expect(h.registryReads, 'nothing is read off Windows').toBe(1)
  })

  // Mutation to prove this can fail: the same (the count never moves, so the
  // kept miss is never asked again).
  it('Check again (a probe after the PATH refresh) asks the profile again after a kept miss; the CLI check on its own never does', async () => {
    setClaudeProfileLookupAllowed(() => true)
    expect(await probeClaudeCli()).toMatchObject({ installed: false })
    expect(h.profileCalls).toBe(1)
    // The 30 s CLI check and another probe with no refresh: the miss is kept.
    expect(await findClaudeOnWindowsAsync(process.env)).toBeNull()
    expect(await probeClaudeCli()).toMatchObject({ installed: false })
    expect(h.profileCalls).toBe(1)
    // The user fixes the profile and presses Check again (setup:probeCli).
    h.profileAnswer = FNM
    expect(await afterPathRefresh(probeClaudeCli)).toMatchObject({ installed: true, path: FNM })
    expect(h.profileCalls).toBe(2)
  })
})
