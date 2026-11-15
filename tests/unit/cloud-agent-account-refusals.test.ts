// A cloud agent on an account that cannot run it is answered with a sentence,
// never started and never silent: the Cloud Agents page shows `rejected` as its
// banner (a thrown error only reached the page's console, so Run did nothing).
// Three ways in: an account switched off (also on a retry, which reads the
// agent's saved account), a Mac's non-primary account (refused in
// withProfileHome), and the project-settings gate (the same throw).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/claude-cli-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/claude-cli-probe')>()),
  recentClaudeOnWindows: () => 'C:\Tools\claude.exe',
}))
vi.mock('../../src/main/windows-programs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/windows-programs')>()),
  findOnWindowsPath: (names: readonly string[]) => `C:\Tools\${names[0]}`,
  findOnWindowsPathAsync: async (names: readonly string[]) => `C:\Tools\${names[0]}`,
}))
vi.mock('../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))

const mockSpawn = vi.fn()
vi.mock('child_process', () => ({ spawn: (...a: any[]) => mockSpawn(...a), execSync: vi.fn(), spawnSync: vi.fn() }))
vi.mock('../../src/main/config-manager', () => ({
  readConfig: () => null,
  readConfigChecked: () => ({ value: null, outcome: 'absent' }),
  writeConfig: vi.fn(() => true),
  getConfigDir: () => '/mock/CONFIG',
  ensureConfigDir: vi.fn(),
}))
vi.mock('../../src/main/legacy-version-manager', () => ({
  resolveVersionBinary: vi.fn(() => null),
  isVersionInstalled: vi.fn(() => false),
  installVersion: vi.fn(async () => ({ ok: false, error: 'mock' })),
  legacyCliPin: vi.fn(() => undefined),
}))

const st = vi.hoisted(() => ({
  homes: {} as Record<string, string>,
  macRefusal: null as string | null,
}))
vi.mock('../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-profiles')>()),
  getPrimaryProfileId: () => null,
  getProfileConfigDir: (id: string) => st.homes[id] ?? `/nonexistent/profiles/${id}`,
  setupProfileLinks: vi.fn(),
}))
// The Mac rule itself is tested in account-launch-refusals.test.ts; here the
// launch environment only throws what it throws on a Mac.
vi.mock('../../src/main/pty-manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/pty-manager')>()
  const prof = await import('../../src/main/account-profiles')
  return {
    ...real,
    withProfileHome: (...a: Parameters<typeof real.withProfileHome>) => {
      if (st.macRefusal) throw new Error(`${prof.MANAGED_LAUNCH_REFUSAL}: ${st.macRefusal}`)
      return real.withProfileHome(...a)
    },
  }
})

import { composeProviders } from '../../src/main/providers/compose'
import { initCloudAgentManager, dispatchAgent, retryAgent, listAgents, _resetCloudAgentLatchForTest } from '../../src/main/cloud-agent-manager'
import { MAC_NON_PRIMARY_REFUSAL, MANAGED_LAUNCH_REFUSAL, _setRootsForTest, upsertProfile } from '../../src/main/account-profiles'

const PROFILE = 'profile-agent-02'
const tmpDirs: string[] = []
/** The account's row in profiles.json under a temp root (the real list is read). */
const saveAccount = (active: boolean): void => {
  upsertProfile({ id: PROFILE, name: 'Side project', accountEmail: 'side@example.com', createdAt: 0, ...(active ? {} : { active: false }) })
}
beforeAll(() => { composeProviders() })
beforeEach(() => {
  vi.clearAllMocks()
  _resetCloudAgentLatchForTest()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-agent-refusal-'))
  tmpDirs.push(home)
  st.homes = { [PROFILE]: home }
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-agent-refusal-res-'))
  tmpDirs.push(resources)
  _setRootsForTest({ resourcesDir: resources, sharedRoot: path.join(resources, 'shared') })
  saveAccount(true)
  st.macRefusal = null
  initCloudAgentManager(() => ({ isDestroyed: () => false, webContents: { send: vi.fn() } }) as any)
})
afterEach(() => {
  _setRootsForTest(null)
  for (const d of tmpDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

const dispatch = () => dispatchAgent({ name: 'A', description: 'do the thing', projectPath: os.tmpdir(), profileId: PROFILE })

describe('a cloud agent that cannot run on its account says so', () => {
  it('answers a switched-off account with the sentence, makes no record and starts nothing', async () => {
    saveAccount(false)
    const answer = await dispatch()
    expect(answer).toEqual({ rejected: expect.stringContaining('"Side project" is switched off') })
    expect((answer as { rejected: string }).rejected).not.toContain(MANAGED_LAUNCH_REFUSAL)
    expect(listAgents()).toHaveLength(0)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('answers a Mac non-primary account with the Mac sentence, without the log marker', async () => {
    st.macRefusal = MAC_NON_PRIMARY_REFUSAL
    const answer = await dispatch()
    expect(answer).toEqual({ rejected: MAC_NON_PRIMARY_REFUSAL })
    expect(listAgents()).toHaveLength(0)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('refuses a retry on an account switched off since, from the agent saved account', async () => {
    const child = { pid: 1, stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, on: vi.fn(), kill: vi.fn() }
    mockSpawn.mockImplementation(() => child)
    const first = await dispatch()
    expect(first).toHaveProperty('id')
    const id = (first as { id: string }).id
    const before = listAgents().length
    saveAccount(false)
    const answer = await retryAgent(id)
    expect(answer).toEqual({ rejected: expect.stringContaining('is switched off') })
    expect(listAgents()).toHaveLength(before)
  })
})
