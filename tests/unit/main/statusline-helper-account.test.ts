/**
 * A tab through the session helper on another machine: its account label,
 * and its per-model weekly bars and extra usage (plan 2.1.3-beta.19, section
 * 3; aicc_planning#434), statusline-watcher.ts setHelperAccount and
 * dispatchHelperStatus:
 *
 * - the label is the account its start read on the host, through the one
 *   display gate every account label passes (no email, no label);
 * - the bars and extra usage come from this computer, never the host: for an
 *   account it holds (an account profile with that email), its own usage
 *   reading of that account, through the bucket and extra usage gates; for
 *   one it does not hold, "not available: this machine uses its own sign-in";
 *   never an empty or zero bar for a source that is missing;
 * - a host frame's usage buckets, extra usage, account label and not-shown
 *   reasons are dropped, whatever the provider's mapping gave;
 * - one reading of an account serves every tab on it for 60 s: never asked
 *   twice;
 * - both are set again at each start (launch or attach); end to end, each
 *   start's field read (remote-helper/host-reads.ts readHostForStart, over a
 *   fake ssh) reaches the strip through the tab's signals as the app wires
 *   them, and section 1.2's join runs that test again on its attach path.
 *
 * PURE: electron and the fan-out's neighbours are mocked, as in
 * statusline-helper-status.test.ts; the account list and the usage read are
 * stand-ins (_setHelperUsageDepsForTest); a real temp resources folder is made
 * for the watcher and removed after.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import type { AccountUsage, UsageBucket } from '../../../src/shared/usage-types'
import type { RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
import type { RemoteLaunchPlan } from '../../../src/main/remote-helper/session'
import { DEFAULT_PROVIDER_ID } from '../../../src/shared/providers/ids'

const h = vi.hoisted(() => ({
  dir: (() => {
    const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path')
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-helper-account-')) as string
  })(),
}))

vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.dir, registerSetupHandlers: () => {} }))
vi.mock('../../../src/main/account-color', () => ({ decorateStatuslineWithColour: (d: Record<string, unknown>) => d }))
vi.mock('../../../src/main/background-context', () => ({ isBackgroundContext: () => false }))
vi.mock('../../../src/main/sentinel/index', () => ({ sentinelObserve: () => {} }))
vi.mock('../../../src/main/providers', () => {
  const provider = { deliverStatusline: () => {}, healGlobalStatusline: () => {} }
  return { getProvider: () => provider, tryGetProvider: () => provider }
})
vi.mock('../../../src/main/debug-logger', () => ({ logWarn: () => {}, logInfo: () => {}, logError: () => {}, logDebug: () => {} }))

const {
  dispatchHelperStatus, dispatchSSHStatuslineUpdate, setHelperAccount, endHelperAccount, _setHelperUsageDepsForTest,
  setStatuslineUsageSink, startStatuslineWatcher,
} = await import('../../../src/main/statusline-watcher')
// The start's read and the tab's signals, as the app wires them
// (ipc/remote-machines-handlers.ts: account -> setHelperAccount).
const { readHostForStart } = await import('../../../src/main/remote-helper/host-reads')
const { RemoteSignals } = await import('../../../src/main/remote-helper/signals')
const { claudeRemoteLaunch } = await import('../../../src/main/providers/claude/remote-launch')
const { FakeSsh } = await import('../remote-helper/fake-ssh')

const bucket = (label: string, group: string, percent: number): UsageBucket => ({ key: `${group}:${label}`, label, group, percent, resetsAt: '2026-11-27T10:00:00.000Z', severity: 'normal' })
const BUCKETS = [bucket('5h', 'session', 12), bucket('Weekly', 'weekly', 40), bucket('Fable', 'weekly', 63)]
const usageOk = (over: Partial<AccountUsage> = {}): AccountUsage => ({
  profileId: 'profile-work', email: 'me@example.com', name: 'Work', isPrimary: false, active: true, status: 'ok', buckets: BUCKETS, fetchedAt: 1, ...over,
})

let sent: Array<Record<string, unknown>> = []
const fakeWin = { isDestroyed: () => false, webContents: { send: (_ch: string, payload: Record<string, unknown>) => { sent.push(payload) } } }
let usageSink: string[] = []
let stopWatcher: (() => void) | null = null
let profiles: Array<{ id: string; accountEmail?: string }> = []
let reads: string[] = []
let answer: (id: string) => Promise<AccountUsage> = async () => usageOk()
let now = 1_000_000

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)) }
const last = (): Record<string, unknown> => sent[sent.length - 1]

beforeEach(() => {
  sent = []; usageSink = []; reads = []
  profiles = [{ id: 'profile-work', accountEmail: 'Me@Example.com' }, { id: 'profile-home', accountEmail: 'home@example.com' }]
  answer = async () => usageOk()
  now = 1_000_000
  _setHelperUsageDepsForTest({ profiles: async () => profiles, usage: (id) => { reads.push(id); return answer(id) } }, { now: () => now })
  stopWatcher = startStatuslineWatcher(() => fakeWin as never)
  setStatuslineUsageSink((sessionId) => { usageSink.push(sessionId) })
})
afterEach(() => { stopWatcher?.(); stopWatcher = null; _setHelperUsageDepsForTest(null) })
afterAll(() => { try { require('node:fs').rmSync(h.dir, { recursive: true, force: true }) } catch { /* best effort */ } })

describe('a helper tab\'s account label', () => {
  it('the label from the read reaches the strip at once, as the tab\'s own, and rides every status frame', async () => {
    setHelperAccount('tab-remote', { account: 'me@example.com' })
    expect(sent[0]).toMatchObject({ sessionId: 'tab-remote', accountEmail: 'me@example.com' })
    expect(sent[0].remoteAccountNotShown).toBeUndefined()
    await settle()
    sent = []
    dispatchHelperStatus('tab-remote', { model: 'Opus', rateLimitCurrent: 42 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ sessionId: 'tab-remote', model: 'Opus', rateLimitCurrent: 42, accountEmail: 'me@example.com' })
  })

  it('the display gate refuses what is not plainly an email: no label, and the reason instead', () => {
    for (const bad of ['not an email', 'me@example.com\u202e', `${'a'.repeat(250)}@example.com`, '<b>me@example.com</b>', '']) {
      sent = []
      setHelperAccount('tab-remote', { account: bad })
      expect(sent[0].accountEmail, bad).toBeUndefined()
      expect(sent[0].remoteAccountNotShown, bad).toBe('no-account')
    }
  })

  it('a read that named none, or did not answer, says which', () => {
    setHelperAccount('tab-a', { notShown: 'no-account' })
    setHelperAccount('tab-b', { notShown: 'not-read' })
    expect(sent.map((s) => [s.sessionId, s.remoteAccountNotShown, s.accountEmail])).toEqual([['tab-a', 'no-account', undefined], ['tab-b', 'not-read', undefined]])
  })
})

describe('a helper tab\'s weekly bars and extra usage, from this computer', () => {
  it('bars for an account this computer holds: its own usage reading of that account, and its extra usage', async () => {
    answer = async () => usageOk({ credits: { currency: 'USD', used: 5, limit: 20, remaining: 15, enabled: true } })
    setHelperAccount('tab-remote', { account: 'me@example.com' })
    // Never a zero bar while the reading comes: no bars at all until it lands.
    expect(sent[0].usageBuckets).toBeUndefined()
    expect(sent[0].remoteUsageNotShown).toBeUndefined()
    await settle()
    expect(reads).toEqual(['profile-work'])
    expect(last()).toMatchObject({ sessionId: 'tab-remote', accountEmail: 'me@example.com', usageBuckets: BUCKETS, rateLimitExtra: { enabled: true, utilization: 25, usedUsd: 5, limitUsd: 20 } })
    expect(last().remoteUsageNotShown).toBeUndefined()
    // A host frame carries the same, from this computer's reading.
    dispatchHelperStatus('tab-remote', { model: 'Opus' })
    expect(last()).toMatchObject({ model: 'Opus', usageBuckets: BUCKETS })
    // The remote tab has no profile here: the usage sink files nothing (its sink resolves the profile and stores nothing for an SSH tab).
    expect(usageSink.every((id) => id === 'tab-remote')).toBe(true)
  })

  it('an account with no extra usage switched on shows no extra usage block', async () => {
    setHelperAccount('tab-remote', { account: 'me@example.com' })
    await settle()
    expect(last().rateLimitExtra).toEqual({ enabled: false, utilization: 0, usedUsd: 0, limitUsd: 0 })
  })

  it('"not available" for an account this computer does not hold, and nothing is read', async () => {
    setHelperAccount('tab-remote', { account: 'stranger@example.com' })
    await settle()
    expect(reads).toEqual([])
    expect(last()).toMatchObject({ sessionId: 'tab-remote', accountEmail: 'stranger@example.com', remoteUsageNotShown: 'own-sign-in', usageBuckets: [] })
    dispatchHelperStatus('tab-remote', { model: 'Opus', rateLimitCurrent: 30 })
    expect(last()).toMatchObject({ rateLimitCurrent: 30, remoteUsageNotShown: 'own-sign-in', usageBuckets: [] })
    expect(reads).toEqual([])
  })

  it('no account named: "not available" too, and nothing is read', async () => {
    setHelperAccount('tab-remote', { notShown: 'no-account' })
    await settle()
    expect(reads).toEqual([])
    expect(last()).toMatchObject({ remoteAccountNotShown: 'no-account', remoteUsageNotShown: 'own-sign-in', usageBuckets: [] })
  })

  it('never an empty or zero bar for a missing source: a held account with no reading says "not available", no reading yet sends no bars', async () => {
    let release: (u: AccountUsage) => void = () => {}
    answer = () => new Promise<AccountUsage>((r) => { release = r })
    setHelperAccount('tab-remote', { account: 'me@example.com' })
    await settle()
    dispatchHelperStatus('tab-remote', { model: 'Opus' })
    for (const s of sent) {
      expect(s.usageBuckets).toBeUndefined()
      expect(s.rateLimitExtra).toBeUndefined()
    }
    release(usageOk({ status: 'waiting', buckets: [] }))
    await settle()
    expect(last()).toMatchObject({ remoteUsageNotShown: 'no-reading', usageBuckets: [] })
    // A reading whose buckets cannot be drawn is no reading either.
    now += 61_000
    answer = async () => usageOk({ buckets: [{ ...BUCKETS[0], percent: Number.NaN }, { ...BUCKETS[1], label: '' }] })
    dispatchHelperStatus('tab-remote', { model: 'Opus' })
    await settle()
    expect(last()).toMatchObject({ remoteUsageNotShown: 'no-reading', usageBuckets: [] })
    for (const s of sent) for (const b of (s.usageBuckets as UsageBucket[] | undefined) ?? []) expect(b.percent).toBeGreaterThan(0)
  })

  it('the bucket gate bounds this computer\'s reading too: at most 32 bars, and an over-long label is dropped', async () => {
    const many = Array.from({ length: 40 }, (_, i) => bucket(`Model ${i}`, 'weekly', 10))
    many[0] = { ...many[0], severity: 'x'.repeat(300) }
    answer = async () => usageOk({ buckets: many })
    setHelperAccount('tab-remote', { account: 'me@example.com' })
    await settle()
    const shown = last().usageBuckets as Array<Record<string, unknown>>
    expect(shown).toHaveLength(32)
    expect(shown[0].severity).toBeUndefined()
  })

  it('one reading serves every tab on the account for 60 s: never asked twice', async () => {
    setHelperAccount('tab-a', { account: 'me@example.com' })
    setHelperAccount('tab-b', { account: 'ME@example.com' })
    await settle()
    for (let i = 0; i < 5; i++) { dispatchHelperStatus('tab-a', { model: 'Opus' }); dispatchHelperStatus('tab-b', { model: 'Opus' }) }
    await settle()
    expect(reads).toEqual(['profile-work'])
    now += 59_000
    dispatchHelperStatus('tab-a', { model: 'Opus' })
    await settle()
    expect(reads).toEqual(['profile-work'])
    now += 2_000
    dispatchHelperStatus('tab-a', { model: 'Opus' })
    dispatchHelperStatus('tab-b', { model: 'Opus' })
    await settle()
    expect(reads).toEqual(['profile-work', 'profile-work'])
  })
})

describe('a host frame gives none of them', () => {
  it('a host frame\'s usage buckets, extra usage, account label and not-shown reasons are dropped', async () => {
    dispatchHelperStatus('tab-plain', {
      model: 'Opus',
      usageBuckets: [bucket('Fable', 'weekly', 99)],
      rateLimitExtra: { enabled: true, utilization: 90, usedUsd: 90, limitUsd: 100 },
      accountEmail: 'host-said@example.com',
      remoteAccountNotShown: 'not-read',
      remoteUsageNotShown: 'no-reading',
    })
    expect(sent).toEqual([{ sessionId: 'tab-plain', model: 'Opus' }])
    expect(usageSink).toEqual([])
    // With the tab's own account read, the frame's still go nowhere: the tab's own win.
    setHelperAccount('tab-plain', { account: 'stranger@example.com' })
    await settle()
    dispatchHelperStatus('tab-plain', { model: 'Opus', usageBuckets: [bucket('Fable', 'weekly', 99)], accountEmail: 'host-said@example.com' })
    expect(last()).toMatchObject({ accountEmail: 'stranger@example.com', usageBuckets: [], remoteUsageNotShown: 'own-sign-in' })
  })

  it('the not-shown reasons are main\'s alone: a status from any other path that names them has them dropped', () => {
    dispatchSSHStatuslineUpdate(JSON.stringify({ sessionId: 'ssh-tab', model: 'Opus', remoteAccountNotShown: 'not-read', remoteUsageNotShown: 'own-sign-in' }))
    expect(sent).toEqual([{ sessionId: 'ssh-tab', model: 'Opus' }])
  })
})

describe('set again at each start (launch or attach)', () => {
  it('a re-attach to another account: the new label, and the earlier account\'s bars and extra usage cleared', async () => {
    answer = async () => usageOk({ credits: { currency: 'USD', used: 5, limit: 20, remaining: 15, enabled: true } })
    setHelperAccount('tab-remote', { account: 'me@example.com' })
    await settle()
    expect(last().usageBuckets).toEqual(BUCKETS)
    setHelperAccount('tab-remote', { account: 'stranger@example.com' })
    await settle()
    expect(last()).toMatchObject({ accountEmail: 'stranger@example.com', usageBuckets: [], rateLimitExtra: { enabled: false }, remoteUsageNotShown: 'own-sign-in' })
  })

  it('a late reading from an earlier start is not taken', async () => {
    let release: (u: AccountUsage) => void = () => {}
    answer = () => new Promise<AccountUsage>((r) => { release = r })
    setHelperAccount('tab-remote', { account: 'me@example.com' })
    await settle()
    setHelperAccount('tab-remote', { notShown: 'no-account' })
    await settle()
    const count = sent.length
    release(usageOk())
    await settle()
    expect(sent.length).toBe(count)
    expect(last()).toMatchObject({ remoteAccountNotShown: 'no-account', remoteUsageNotShown: 'own-sign-in' })
  })

  it('the tab\'s end: its account and usage source go', async () => {
    setHelperAccount('tab-remote', { account: 'me@example.com' })
    await settle()
    endHelperAccount('tab-remote')
    sent = []
    dispatchHelperStatus('tab-remote', { model: 'Opus' })
    expect(sent).toEqual([{ sessionId: 'tab-remote', model: 'Opus' }])
  })

  // Section 3's re-attach test, run again at section 1.2's join with the
  // second start made by 1.2's attach path (the contract: "the label and the
  // bars' source are set again at each attach").
  it('with a fake attach, a re-attached tab shows the label: each start\'s field read reaches the strip through the tab\'s signals, and sets the label and the bars\' source again', async () => {
    const SHA = 'a'.repeat(64)
    const machine: RemoteMachineRecord = {
      did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
      os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
      path: '/usr/bin:/bin', lang: null, helper: { version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
    }
    // What the host's Claude Code is signed in as at each start: the fake
    // field mode prints it after the launcher's hash line, or nothing.
    let hostAccount: string | null = 'me@example.com'
    const asked: string[][] = []
    const ssh = new FakeSsh({
      answer: (c) => {
        if (c.script !== 'field') return { code: 1 }
        asked.push(c.values.slice(5))
        return { stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n${hostAccount ? `${hostAccount}\n` : ''}`, code: 0 }
      },
    })
    const tab = new RemoteSignals({
      appPtyId: 'tab-remote', provider: DEFAULT_PROVIDER_ID, via: claudeRemoteLaunch, launch: { statusKeep: [], hookKeep: [] }, tools: false, log: () => {},
      deps: { toolsServed: () => false, status: () => {}, event: () => {}, serve: () => false, ended: () => {}, account: (id, read) => setHelperAccount(id, read) },
    })
    // No host files named: the start reads the account's field alone.
    const plan = { via: claudeRemoteLaunch, options: { reconnect: false, cwd: '/home/nick', settings: null, tools: false }, reads: [] } as unknown as RemoteLaunchPlan
    const start = () => readHostForStart({ runner: ssh, machine, installId: 'f'.repeat(32), log: () => {}, signals: tab }, plan, 'rs-tab-remote')

    // The launch.
    await start()
    await settle()
    expect(asked).toEqual([['.claude.json', 'oauthAccount.emailAddress']])
    expect(last()).toMatchObject({ sessionId: 'tab-remote', accountEmail: 'me@example.com', usageBuckets: BUCKETS })
    expect(reads).toEqual(['profile-work'])

    // An attach after the app was away: the host's Claude Code is now signed
    // in as another account this computer holds.
    hostAccount = 'home@example.com'
    sent = []
    await start()
    await settle()
    expect(asked).toHaveLength(2)
    expect(sent[0]).toMatchObject({ sessionId: 'tab-remote', accountEmail: 'home@example.com' })
    expect(last()).toMatchObject({ sessionId: 'tab-remote', accountEmail: 'home@example.com', usageBuckets: BUCKETS })
    expect(reads).toEqual(['profile-work', 'profile-home'])
    dispatchHelperStatus('tab-remote', { model: 'Opus' })
    expect(last()).toMatchObject({ model: 'Opus', accountEmail: 'home@example.com' })

    // Another attach, the host's Claude Code signed out: no label, and the
    // earlier account's bars and extra usage cleared.
    hostAccount = null
    await start()
    await settle()
    expect(asked).toHaveLength(3)
    expect(last().accountEmail).toBeUndefined()
    expect(last()).toMatchObject({ remoteAccountNotShown: 'no-account', remoteUsageNotShown: 'own-sign-in', usageBuckets: [] })
    expect(reads).toEqual(['profile-work', 'profile-home'])
  })
})
