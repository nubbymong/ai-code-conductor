// [host] Failure text from an Insights run hides credentials inside a url
// and a session value, and a sign-in failure is still named as one. Nothing
// starts: the terminal, the headless runs, the warm-up, the profile roots and
// the logger are faked, and the only folders made are this suite's own temp
// folder and what the runner makes inside it.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
vi.mock('../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SECRET = 'hunter2Secret'
const PROXY = `http://alice:${SECRET}@proxy.corp.example:8080`

const h = vi.hoisted(() => ({
  resourcesDir: '',
  installPath: '',
  profileDir: {} as Record<string, string>,
  profiles: [] as Array<{ id: string; name?: string; accountEmail: string; isPrimary?: boolean }>,
  /** What the terminal prints, as one chunk or as several in turn. */
  ptyOutput: '' as string | string[],
  /** null: the terminal never exits (its time limit ends it). */
  ptyExit: 0 as number | null,
  kpi: { code: 0, stdout: '', stderr: '' },
  synthesis: { code: 0, stdout: '', stderr: '' },
  logs: [] as string[],
  sent: [] as string[],
  spawned: 0,
}))

vi.mock('../../src/main/debug-logger', async (orig) => {
  const log = (...a: unknown[]) => { h.logs.push(a.map((x) => String(x)).join(' ')) }
  return { ...(await orig<typeof import('../../src/main/debug-logger')>()), logInfo: log, logWarn: log, logError: log, logDebug: log }
})
vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {},
}))
vi.mock('../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-profiles')>()),
  getProfileConfigDir: (id: string) => h.profileDir[id] ?? '',
  getPrimaryProfileId: () => h.profiles.find((p) => p.isPrimary)?.id ?? h.profiles[0]?.id ?? null,
  setupProfileLinks: () => {},
  listProfiles: () => h.profiles,
  startProfileStepsPending: () => false,
  startProfileStepsSettled: async () => {},
  profileCredentialFoldersChecked: () => true,
  checkProfileCredentialFolders: async () => {},
}))
vi.mock('../../src/main/account-auth-info', () => ({ readProfileAuthInfo: () => ({ refreshTokenExpiresAt: null }) }))
vi.mock('../../src/main/update-watcher', () => ({ getInstallPath: () => h.installPath, getProjectRootPath: () => '' }))
vi.mock('../../src/main/pty-manager', async () => ({
  resolveClaudeForPty: () => ({ cmd: 'claude', args: [] }),
  withProfileHome: (await vi.importActual<typeof import('../../src/main/account-profiles')>('../../src/main/account-profiles')).withProfileHome,
}))
vi.mock('../../src/main/first-start-warmup', () => ({ warmFirstStart: async () => ({ outcome: 'skipped' }) }))
// A terminal that prints h.ptyOutput and exits with h.ptyExit at once (or
// never, when it is null).
vi.mock('node-pty', () => ({
  spawn: () => (h.spawned++, {
    onData: (cb: (d: string) => void) => { for (const chunk of [h.ptyOutput].flat()) if (chunk) cb(chunk) },
    onExit: (cb: (e: { exitCode: number }) => void) => { if (h.ptyExit !== null) cb({ exitCode: h.ptyExit }) },
    write: () => {},
    kill: () => {},
  }),
}))
// The KPI extraction passes --allowedTools Read; the roll-up's synthesis does not.
vi.mock('../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async (args: string[]) => (args.includes('--allowedTools') ? h.kpi : h.synthesis),
}))

import { runInsights, runCrossAccountInsights, getCatalogue } from '../../src/main/insights-runner'
import { composeProviders } from '../../src/main/providers/compose'
import { _resetProfileConsumersForTest } from '../../src/main/profile-consumers'
import { _resetProjectScanStateForTest } from '../../src/main/managed-launch-diagnostics'

const win = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, payload: unknown) => { if (channel === 'insights:statusChanged') h.sent.push(JSON.stringify(payload)) } },
}
const getWin = () => win as never

const KPIS = {
  period: { start: '2026-07-01', end: '2026-07-31', days: 31 },
  kpis: { Volume: { sessions: { value: 10, label: 'Sessions', format: 'number', goodDirection: 'up' } } },
}

let tmpRoot = ''
function seedProfile(id: string, email: string, isPrimary = false): void {
  const dir = join(tmpRoot, 'profiles', id)
  mkdirSync(join(dir, '.claude', 'usage-data'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'usage-data', 'report.html'), '<html><body>report</body></html>')
  h.profileDir[id] = dir
  h.profiles.push({ id, name: `Acct ${id.toUpperCase()}`, accountEmail: email, isPrimary })
}
const runOf = (id: string) => getCatalogue().runs.find((r) => r.id === id)!
const catalogueText = () => readFileSync(join(h.resourcesDir, 'insights', 'catalogue.json'), 'utf-8')

/** Nothing the user or a log can read holds the password or the user name. */
function expectNoCredential(): void {
  for (const text of [catalogueText(), ...h.sent, ...h.logs]) {
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('alice:')
  }
}

beforeAll(() => { composeProviders() })
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'insights-redaction-'))
  h.resourcesDir = join(tmpRoot, 'resources')
  mkdirSync(h.resourcesDir, { recursive: true })
  h.installPath = join(tmpRoot, 'install')
  mkdirSync(h.installPath, { recursive: true })
  h.profileDir = {}
  h.profiles = []
  h.ptyOutput = ''
  h.ptyExit = 0
  h.kpi = { code: 0, stdout: JSON.stringify(KPIS), stderr: '' }
  h.synthesis = { code: 0, stdout: '', stderr: '' }
  h.logs = []
  h.sent = []
  h.spawned = 0
  _resetProfileConsumersForTest()
  _resetProjectScanStateForTest()
})
afterEach(() => {
  _resetProjectScanStateForTest()
  // Only this suite's own temp folder.
  if (tmpRoot.startsWith(join(tmpdir(), 'insights-redaction-'))) rmSync(tmpRoot, { recursive: true, force: true })
})

describe('failure text hides credentials inside a url', () => {
  it('the rest of the text is kept', async () => {
    seedProfile('a', 'a@example.com', true)
    h.kpi = {
      code: 1,
      stdout: JSON.stringify({ is_error: true, subtype: 'error_during_execution', result: `API Error: 407 Proxy Authentication Required from ${PROXY}`, duration_api_ms: 120 }),
      stderr: `proxy refused the tunnel at ${PROXY}\n`,
    }
    const id = await runInsights(getWin, { profileId: 'a' }) as string
    const run = runOf(id)
    expect(run.status).toBe('complete')
    expect(run.kpisUnavailable).toBe(true)
    expect(run.error).toContain('API Error: 407 Proxy Authentication Required from http://')
    expect(run.error).toContain('proxy.corp.example:8080')
    expect(run.authFailed).toBeUndefined()
    expectNoCredential()
    expect(h.logs.some((l) => l.includes('KPI extraction failed') && l.includes('407 Proxy Authentication Required'))).toBe(true)
    const record = readFileSync(join(h.resourcesDir, 'insights', id, 'kpi-extraction-failure.json'), 'utf-8')
    expect(record).not.toContain(SECRET)
    expect(record).not.toContain('alice:')
    expect(JSON.parse(record).reason).toContain('407 Proxy Authentication Required')
    expect(JSON.parse(record).stderr).toContain('proxy refused the tunnel')
  })

  it('however long the text is', async () => {
    seedProfile('a', 'a@example.com', true)
    // The URL starts at character 381, so a cut at 400 would split it.
    const lead = `${'Upstream proxy failure '.repeat(17)}`.slice(0, 380)
    h.kpi = { code: 1, stdout: JSON.stringify({ is_error: true, result: `${lead} ${PROXY} and more`, duration_api_ms: 10 }), stderr: '' }
    const id = await runInsights(getWin, { profileId: 'a' }) as string
    const run = runOf(id)
    expect(run.error).toContain('Upstream proxy failure')
    // The cut never leaves part of the password.
    expect(run.error).not.toContain('alice:hunter')
    expectNoCredential()
  })

  it('when the run gives no reason of its own', async () => {
    seedProfile('a', 'a@example.com', true)
    h.kpi = { code: 1, stdout: 'not an envelope', stderr: `connect ECONNREFUSED through ${PROXY}` }
    const id = await runInsights(getWin, { profileId: 'a' }) as string
    expect(runOf(id).error).toBe('claude exited 1')
    expectNoCredential()
    expect(h.logs.some((l) => l.includes('KPI extraction failed') && l.includes('connect ECONNREFUSED through'))).toBe(true)
  })

  it('a sign-in failure is still named as one', async () => {
    seedProfile('a', 'a@example.com', true)
    h.kpi = {
      code: 1,
      stdout: JSON.stringify({
        is_error: true,
        result: `Failed to authenticate: OAuth session expired and could not be refreshed (via ${PROXY})`,
        duration_api_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
      stderr: '',
    }
    const id = await runInsights(getWin, { profileId: 'a' }) as string
    const run = runOf(id)
    expect(run.authFailed).toBe(true)
    expect(run.error).toMatch(/OAuth session expired/)
    expectNoCredential()
  })

  it('when a run ends with an error', async () => {
    seedProfile('a', 'a@example.com', true)
    h.ptyOutput = `API Error: Connection error via ${PROXY}\r\n`
    h.ptyExit = 1
    const id = await runInsights(getWin, { profileId: 'a' }) as string
    const run = runOf(id)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/^claude \/insights failed: /)
    expect(run.error).toContain('API Error: Connection error via http://')
    expectNoCredential()
  })

  // The terminal's chunks go to the log, and a chunk can end inside a line;
  // the log is redacted on whole lines, so a credential split across two
  // chunks is hidden too. Mutation to prove this can fail: log
  // shownClaudeFailure of each chunk on its own.
  it('when a credential arrives split across two terminal chunks', async () => {
    seedProfile('a', 'a@example.com', true)
    const text = `API Error: Connection error via ${PROXY}\r\n`
    const at = text.indexOf(SECRET) + 4
    h.ptyOutput = [text.slice(0, at), text.slice(at)]
    h.ptyExit = 1
    const id = await runInsights(getWin, { profileId: 'a' }) as string
    expect(runOf(id).status).toBe('failed')
    expect(h.logs.some((l) => l.includes('PTY chunk #2') && l.includes('API Error: Connection error via http://[REDACTED]@proxy.corp.example'))).toBe(true)
    expectNoCredential()
    for (const l of h.logs) {
      expect(l).not.toContain(SECRET.slice(0, 4))
      expect(l).not.toContain(SECRET.slice(4))
    }
  })

  it('when a run reaches its time limit', async () => {
    seedProfile('a', 'a@example.com', true)
    h.ptyOutput = `API Error: Connection error via ${PROXY}\r\n`
    h.ptyExit = null
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      const pending = runInsights(getWin, { profileId: 'a' })
      // The steps before the terminal starts run on real I/O: let them, then
      // move the clock past the terminal's time limit.
      for (let i = 0; i < 500 && h.spawned === 0; i++) {
        await vi.advanceTimersByTimeAsync(10)
        await new Promise((r) => setImmediate(r))
      }
      expect(h.spawned).toBe(1)
      await vi.advanceTimersByTimeAsync(600_000 + 1_000)
      const id = await pending as string
      expect(runOf(id).status).toBe('failed')
      expect(h.logs.some((l) => l.includes('Last output') && l.includes('API Error: Connection error via'))).toBe(true)
      expectNoCredential()
    } finally {
      vi.useRealTimers()
    }
  })

  it('in a combined report', async () => {
    seedProfile('a', 'a@example.com', true)
    seedProfile('b', 'b@example.com')
    h.synthesis = { code: 1, stdout: JSON.stringify({ is_error: true, result: `Upstream overloaded behind ${PROXY}`, duration_api_ms: 50 }), stderr: '' }
    const id = await runCrossAccountInsights(getWin) as string
    const agg = runOf(id)
    expect(agg.status).toBe('complete')
    expect(agg.error).toMatch(/^No written analysis: /)
    expect(agg.error).toContain('Upstream overloaded behind http://')
    expect(agg.authFailed).toBeUndefined()
    expectNoCredential()
    expect(h.logs.some((l) => l.includes('Cross-account synthesis unusable') && l.includes('Upstream overloaded behind'))).toBe(true)
    expect(h.logs.some((l) => l.includes('Raw synthesis output') && l.includes('Upstream overloaded behind'))).toBe(true)
    expect(existsSync(join(h.resourcesDir, 'insights', id, 'kpis.json'))).toBe(true)
  })

  it('in a combined report, a sign-in failure is still named as one', async () => {
    seedProfile('a', 'a@example.com', true)
    seedProfile('b', 'b@example.com')
    h.synthesis = {
      code: 1,
      stdout: JSON.stringify({ is_error: true, result: `Failed to authenticate: OAuth session expired and could not be refreshed (via ${PROXY})`, duration_api_ms: 0 }),
      stderr: '',
    }
    const id = await runCrossAccountInsights(getWin) as string
    const agg = runOf(id)
    expect(agg.authFailed).toBe(true)
    expect(agg.error).toMatch(/needs to sign in again/)
    expectNoCredential()
  })
})

describe('failure text hides a session value', () => {
  it('the rest of the text is kept', async () => {
    const SESSION = 'sEss10nValue42abc'
    seedProfile('a', 'a@example.com', true)
    h.kpi = {
      code: 1,
      stdout: JSON.stringify({ is_error: true, result: `API Error: 500 upstream rejected session=${SESSION} for this request`, duration_api_ms: 80 }),
      stderr: '',
    }
    const id = await runInsights(getWin, { profileId: 'a' }) as string
    const run = runOf(id)
    expect(run.error).toContain('API Error: 500 upstream rejected session=')
    expect(run.error).toContain('for this request')
    const record = readFileSync(join(h.resourcesDir, 'insights', id, 'kpi-extraction-failure.json'), 'utf-8')
    for (const text of [run.error!, catalogueText(), record, ...h.sent, ...h.logs]) {
      expect(text).not.toContain(SESSION)
    }
  })
})
