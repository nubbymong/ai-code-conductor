/**
 * O8: Sentinel closes a Claude model finding whose cause is gone, through the
 * REAL Sentinel service.
 *
 * The owner's case: v2.1.0 and 2.1.1-beta.1 raised "Claude Code offers
 * claude-opus-5-5 (sonnet, haiku), but it is not in the model picker" from the
 * live article, because their registry lacked all three. 2.1.1-beta.2 added
 * them, but nothing ever closed a model finding, so the three notices stayed
 * open in sentinel-state.json, kept the chip amber at every launch and headed
 * the copied report. Now:
 *
 *  - the start-up check closes them, from the registry alone, before the
 *    article is read (the read can take up to 10 s);
 *  - a Re-run closes them too (before, it never ran the Claude model check);
 *  - a muted one stays muted (the user's choice holds);
 *  - an offline start never closes a notice the registry does not cover (it
 *    would come back at the next online start), and a live read closes one
 *    for a model the article has since dropped.
 *
 * Only Claude Code is on here; the other assistant's half is proven in its
 * own service suite. The accounts service, the headless Claude spawner, the
 * network reads, the settings and the account profiles are faked: no process
 * starts, no request leaves, and the only folder made is this suite's own
 * state folder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { selectBreakingFindings, formatSentinelReportText } from '../../../src/renderer/components/sentinel/sentinel-report-text'
import { deriveDotState } from '../../../src/renderer/components/sentinel/SentinelDot'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  app: { getPath: () => os.tmpdir() },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))

// Claude Code on; every other provider off, so nothing of it runs.
const ON = new Set(['claude'])
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => ON.has(id) ? null : { code: 'provider-off', providerId: id, message: 'off' },
  }),
}))
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: () => null,
  readConfigChecked: () => ({ value: null, outcome: 'absent' }),
}))
vi.mock('../../../src/main/account-profiles', () => ({
  resolveHeadlessProfileHome: () => ({ home: null, profileId: null }),
  startProfileStepsPending: () => false,
  startProfileStepsSettled: async () => {},
  profileCredentialFoldersChecked: () => true,
  checkProfileCredentialFolders: async () => {},
  listProfiles: () => [],
  sharedRoot: () => path.join(dir, 'shared-claude'),
}))
const spawnClaudeHeadless = vi.fn(async (args: string[]) => args[0] === '--version'
  ? { code: 0, stdout: '2.1.300 (Claude Code)', stderr: '' }
  : { code: 1, stdout: '', stderr: 'no analysis runs in this suite' })
vi.mock('../../../src/main/claude-headless', () => ({ spawnClaudeHeadless: (...a: unknown[]) => spawnClaudeHeadless(...(a as [string[]])) }))
// The article read: the real parser over the real page (fixture), the network faked.
const article = vi.hoisted(() => ({ ids: null as string[] | null, hold: null as null | Promise<void>, calls: 0 }))
vi.mock('../../../src/main/sentinel/sentinel-model-article', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/sentinel/sentinel-model-article')>()),
  fetchArticleModelIds: async () => {
    article.calls++
    if (article.hold) await article.hold
    return article.ids
  },
}))
// No changelog: an update found is not analysed, so no analysis runs.
vi.mock('../../../src/main/sentinel/sentinel-changelog', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/sentinel/sentinel-changelog')>()),
  fetchChangelog: async () => null,
}))

const ARTICLE = 'https://support.claude.com/en/articles/11940350-claude-code-model-configuration'
const FIVE_FIVE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']

/** A "not in the model picker" notice as a live read raised it (the owner's paste). */
const notice = (id: string, status: 'open' | 'muted' = 'open') => ({
  id: `models:missing:${id}`, kind: 'compat', severity: 'warn',
  title: `Claude Code offers ${id}, but it is not in the model picker`,
  evidence: `${id} is listed by the Claude Code model configuration (read from ${ARTICLE} just now); resources/model-registry.json has no entry covering it.`,
  affectedFeature: 'sessions', badgeText: `New model: ${id}`, status, createdAt: Date.parse('2026-10-05T09:00:00Z'),
})

const PREFIX = 'ccc-sentinel-retire-'
let dir = ''
let liveIds: string[] = []

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  const { parseArticleModelIds } = await import('../../../src/main/sentinel/sentinel-model-article')
  liveIds = parseArticleModelIds(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'model-article', 'claude-code-model-configuration.trimmed.html'), 'utf8'))
  article.ids = liveIds
  article.hold = null
  article.calls = 0
  spawnClaudeHeadless.mockClear()
})
afterEach(() => {
  // TEST CLEANUP GUARD: only this suite's own state folder, by its prefix and parent.
  if (path.basename(dir).startsWith(PREFIX) && path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true })
})

async function sentinel(findings: unknown[]) {
  fs.mkdirSync(path.join(dir, 'sentinel'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'sentinel', 'sentinel-state.json'), JSON.stringify({ lastSeenCcVersion: null, analyzing: false, lastAnalysisAt: Date.parse('2026-10-11T00:27:49Z'), lastAnalysisError: null, findings }))
  const { _initRegistryForTest } = await import('../../../src/main/model-registry-service')
  _initRegistryForTest(dir)
  const mod = await import('../../../src/main/sentinel/index')
  mod.initSentinel(dir)
  return mod
}
type Sentinel = Awaited<ReturnType<typeof sentinel>>
const snap = (s: Sentinel) => s.getSentinelState()!.snapshot()
const openIds = (s: Sentinel) => snap(s).findings.filter((f) => f.status === 'open').map((f) => f.id)
const savedIds = () => (JSON.parse(fs.readFileSync(path.join(dir, 'sentinel', 'sentinel-state.json'), 'utf-8')).findings as Array<{ id: string; status: string }>).map((f) => `${f.id}=${f.status}`)
/** Lets the check run up to the article read it is held at. */
const readStarted = () => vi.waitFor(() => expect(article.calls).toBe(1))
function holdTheRead(): () => void {
  let release!: () => void
  article.hold = new Promise<void>((r) => { release = r })
  return release
}

describe("the owner's three stale notices (O8)", () => {
  it('the start-up check closes them: nothing reaches the chip, the copied report is clean, and the file agrees', async () => {
    const s = await sentinel(FIVE_FIVE.map((id) => notice(id)))
    expect(deriveDotState(true, snap(s))).toBe('findings')
    await s.sentinelStartupCheck()
    expect(openIds(s)).toEqual([])
    expect(selectBreakingFindings(snap(s))).toEqual([])
    expect(deriveDotState(true, snap(s))).not.toBe('findings')
    expect(formatSentinelReportText(snap(s))).toContain('No breaking changes.')
    expect(savedIds()).toEqual([])
    expect(article.calls).toBe(1)
  })

  it('they close before the article read finishes (it can take 10 s), so the first start never shows them', async () => {
    const s = await sentinel(FIVE_FIVE.map((id) => notice(id)))
    const release = holdTheRead()
    const pending = s.sentinelStartupCheck()
    await readStarted()
    expect(openIds(s)).toEqual([])
    expect(deriveDotState(true, snap(s))).not.toBe('findings')
    release()
    await pending
    expect(openIds(s)).toEqual([])
  })

  it('offline (the article cannot be read), they close all the same: the registry alone answers', async () => {
    article.ids = null
    const s = await sentinel(FIVE_FIVE.map((id) => notice(id)))
    await s.sentinelStartupCheck()
    expect(openIds(s)).toEqual([])
  })

  it('a Re-run closes them too, before its article read finishes', async () => {
    const s = await sentinel(FIVE_FIVE.map((id) => notice(id)))
    const release = holdTheRead()
    const pending = s.sentinelRerun()
    await readStarted()
    expect(openIds(s)).toEqual([])
    release()
    await pending
    expect(openIds(s)).toEqual([])
    expect(selectBreakingFindings(snap(s))).toEqual([])
    expect(deriveDotState(true, snap(s))).not.toBe('findings')
    expect(savedIds()).toEqual([])
  })

  it('a muted notice stays muted (the user chose it); the open ones close', async () => {
    const s = await sentinel([notice('claude-opus-5-5'), notice('claude-sonnet-5-5'), notice('claude-haiku-5-5', 'muted')])
    await s.sentinelStartupCheck()
    expect(openIds(s)).toEqual([])
    expect(savedIds()).toEqual(['models:missing:claude-haiku-5-5=muted'])
    expect(deriveDotState(true, snap(s))).toBe('ok')
  })
})

describe('a notice whose model the registry does not cover (O8)', () => {
  it('stays open on an offline start and an offline Re-run, so it does not come and go with the network', async () => {
    article.ids = null
    const s = await sentinel([notice('claude-opus-6')])
    await s.sentinelStartupCheck()
    expect(openIds(s)).toEqual(['models:missing:claude-opus-6'])
    await s.sentinelRerun()
    expect(openIds(s)).toEqual(['models:missing:claude-opus-6'])
  })

  it('stays open while the article lists the model', async () => {
    article.ids = [...liveIds, 'claude-opus-6']
    const s = await sentinel([notice('claude-opus-6')])
    await s.sentinelStartupCheck()
    expect(openIds(s)).toEqual(['models:missing:claude-opus-6'])
  })

  // Owner findings 2026-10-11: the notice a beta.2 build kept said "read ...
  // just now" for days. Raised again by the next check, it says what that
  // check read and from where, and keeps when it was first raised.
  it("kept open, it loses the earlier build's \"just now\" at the next check, in the panel and the file", async () => {
    article.ids = [...liveIds, 'claude-opus-6']
    const s = await sentinel([notice('claude-opus-6')])
    await s.sentinelStartupCheck()
    const f = snap(s).findings.find((x) => x.id === 'models:missing:claude-opus-6')!
    expect(f.evidence).toContain(`read online from ${ARTICLE}`)
    expect(f.evidence).not.toContain('just now')
    expect(f.createdAt).toBe(Date.parse('2026-10-05T09:00:00Z'))
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sentinel', 'sentinel-state.json'), 'utf-8')).findings as Array<{ id: string; evidence: string }>
    expect(saved.find((x) => x.id === 'models:missing:claude-opus-6')!.evidence).not.toContain('just now')
  })

  it('closes once a live read finds the article no longer lists it', async () => {
    const s = await sentinel([notice('claude-opus-6')])
    await s.sentinelStartupCheck()
    expect(openIds(s)).toEqual([])
  })
})
