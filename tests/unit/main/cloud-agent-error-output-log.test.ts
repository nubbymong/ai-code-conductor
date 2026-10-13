// A Claude cloud agent's error output (stderr) goes to the app's log by its
// start only, and with credentials hidden as in every other failure text the
// app records (providers/review-support.ts redactFailure), hidden before it is
// cut, so a cut never splits one. child_process and the PATH walk are faked,
// and the platform is forced: nothing is started.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  present: new Set<string>(),
  logs: [] as string[],
  stderr: null as null | ((data: Buffer) => void),
}))

vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
vi.mock('../../../src/main/managed-launch-diagnostics', () => ({ gateManagedLaunch: async () => ({ status: 'clean' }), peekGateVerdict: () => undefined }))
vi.mock('../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/debug-logger')>()),
  logInfo: (m: string) => { h.logs.push(m) },
}))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: () => ({
    pid: 777,
    stdin: { on: vi.fn(), end: vi.fn(), write: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: (ev: string, fn: (data: Buffer) => void) => { if (ev === 'data') h.stderr = fn } },
    on: vi.fn(),
    kill: vi.fn(),
  }),
  spawnSync: () => ({ status: 0 }),
  execSync: () => '',
}))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  return {
    ...real,
    findOnWindowsPath: (names: string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
      real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order),
    findOnWindowsPathAsync: async (names: string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
      real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order),
  }
})
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: () => null,
  readConfigChecked: () => ({ value: null, outcome: 'absent' }),
  writeConfig: () => true,
  getConfigDir: () => '/mock/CONFIG',
  ensureConfigDir: vi.fn(),
}))
vi.mock('../../../src/main/legacy-version-manager', () => ({
  resolveVersionBinary: () => null,
  isVersionInstalled: () => false,
  installVersion: async () => ({ ok: false, error: 'not in this test' }),
  legacyCliPin: () => undefined,
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  getPrimaryProfileId: () => null,
  getProfileConfigDir: (id: string) => `/nonexistent/profiles/${id}`,
  setupProfileLinks: vi.fn(),
  listProfiles: () => [],
}))

const { composeProviders } = await import('../../../src/main/providers/compose')
const { initCloudAgentManager, dispatchAgent, killAllAgents, _resetCloudAgentLatchForTest } = await import('../../../src/main/cloud-agent-manager')
const { _resetClaudeWindowsLookupForTest } = await import('../../../src/main/claude-cli-probe')

const EXE = 'C:\\Tools\\claude.exe'
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const saved = { path: process.env.PATH, root: process.env.SystemRoot }

beforeAll(() => { composeProviders() })
beforeEach(() => {
  h.logs.length = 0
  h.stderr = null
  h.present = new Set([EXE.toLowerCase()])
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.PATH = 'C:\\Tools'
  process.env.SystemRoot = 'C:\\Windows'
  _resetClaudeWindowsLookupForTest()
  _resetCloudAgentLatchForTest()
  initCloudAgentManager(() => null)
})
afterEach(() => {
  killAllAgents()
  Object.defineProperty(process, 'platform', hostPlatform)
  if (saved.path === undefined) delete process.env.PATH
  else process.env.PATH = saved.path
  if (saved.root === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = saved.root
})

/** The log line written for one chunk of the agent's error output. */
async function logLineFor(chunk: string): Promise<string> {
  await dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project' })
  expect(h.stderr).toBeTypeOf('function')
  h.stderr!(Buffer.from(chunk))
  const lines = h.logs.filter((l) => l.includes(' stderr: '))
  expect(lines).toHaveLength(1)
  return lines[0]
}

describe('a Claude cloud agent\'s error output in the log', () => {
  it('hides a credential written inside a url, as other failure text does', async () => {
    const line = await logLineFor('fatal: could not read from https://agent:pa55word-fixture-0001@example.invalid/repo.git\n')
    expect(line).toContain('https://[REDACTED]@example.invalid/repo.git')
    expect(line).not.toContain('pa55word-fixture-0001')
  })

  it('hides a credential whole where the cut at 200 characters falls inside it', async () => {
    // The password starts before the cut; the @ that ends it comes after it, so the part
    // before the cut alone would not read as a credential.
    const chunk = `${'x'.repeat(170)} https://agent:pa55word-fixture-0002@example.invalid/repo.git\n`
    expect(chunk.indexOf('pa55word')).toBeLessThan(200)
    expect(chunk.indexOf('@')).toBeGreaterThan(200)
    const line = await logLineFor(chunk)
    expect(line).toContain('https://[REDACTED]@')
    expect(line).not.toContain('pa55word')
  })

  it('keeps no more than the first 200 characters of what is left', async () => {
    const line = await logLineFor(`${'y'.repeat(300)}\n`)
    expect(line).toContain(`${'y'.repeat(200)}`)
    expect(line).not.toContain(`${'y'.repeat(201)}`)
  })

  // One pipe read can end inside a line; the log is redacted on whole lines,
  // so a credential split across two reads is hidden too. Mutation to prove
  // this can fail: log redactHead(chunk, redactFailure) per read.
  it('hides a credential split across two reads, at either half', async () => {
    const PASSWORD = 'pa55word-fixture-0005'
    const line = `fatal: could not read from https://agent:${PASSWORD}@example.invalid/repo.git\n`
    const BEARER = 'QQQQQQQQQQabcdef0123456789xyz'
    const bearer = `request failed: Authorization: Bearer ${BEARER}\n`
    for (const [text, secret] of [[line, PASSWORD], [bearer, BEARER]] as const) {
      const at = text.indexOf(secret) + 4
      h.logs.length = 0
      h.stderr = null
      await dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project' })
      h.stderr!(Buffer.from(text.slice(0, at)))
      h.stderr!(Buffer.from(text.slice(at)))
      const lines = h.logs.filter((l) => l.includes(' stderr'))
      expect(lines).toHaveLength(2)
      for (const l of lines) {
        expect(l).not.toContain(secret.slice(0, 4))
        expect(l).not.toContain(secret.slice(4, 12))
      }
      // The whole line, redacted, arrives with the read that finishes it.
      expect(lines[1]).toContain(text === line ? 'https://[REDACTED]@example.invalid/repo.git' : 'Authorization: Bearer ')
      killAllAgents()
    }
  })
})
