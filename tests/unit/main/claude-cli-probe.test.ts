/**
 * Phase 7 item B — the main-side "is the Claude CLI installed?" probe.
 *
 * The gate first-run setup hard-stops on. Three things must hold or the stop is
 * either useless, a brick, or a denial of service:
 *  - it must probe the way the setup PTY LAUNCHES (a POSIX login shell, so a
 *    Homebrew/nvm install is seen), otherwise it reports "missing" for a CLI
 *    that works fine;
 *  - it must fail CLOSED, so a probe that throws blocks rather than waves
 *    through;
 *  - it must NOT BLOCK THE MAIN PROCESS (adversarial review, 2026-09-01 — DoS).
 *    The original used `execFileSync`: up to three sequential 8s probes, each
 *    freezing every IPC handler, every PTY pump and the window itself. The
 *    channel that reaches it (`setup:probeCli`) is ungated, so any renderer
 *    could hang the app on demand, and a slow login shell hung it by accident.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** One recorded spawn, with its completion under the test's control. */
interface Call { bin: string; args: string[]; done: (err: unknown, stdout: string) => void }

const exec = vi.hoisted(() => ({ calls: [] as Array<{ bin: string; args: string[]; done: (err: unknown, stdout: string) => void }> }))
const platform = vi.hoisted(() => ({ value: 'win32' as NodeJS.Platform }))

// ASYNC execFile only. If the module reaches for a *Sync spawn this mock does
// not provide one and the import fails loudly — which is the point.
vi.mock('child_process', () => ({
  execFile: (bin: string, args: string[], _opts: unknown, cb: (err: unknown, stdout: string) => void) => {
    exec.calls.push({ bin, args, done: cb })
    return { unref() {} }
  },
}))
vi.mock('os', () => ({ platform: () => platform.value }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {} }))
// Windows: the in-process PATH walk (windows-programs.ts), answered by the test.
const walk = vi.hoisted(() => ({ calls: [] as unknown[][], answer: null as string | null }))
// Windows: the question put to Windows PowerShell with the user's profile
// (windows-programs.ts findWithPowerShellProfile, its own suite), answered by
// the test: `answer` (a path, or null for "named none"), or `fail` for no
// answer to go by; `hold` keeps it running until the test settles it (with
// the answer set at that moment).
const profile = vi.hoisted(() => ({
  calls: [] as unknown[][],
  answer: null as string | null,
  fail: false,
  hold: false,
  release: [] as Array<() => void>,
}))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  type Lookup = import('../../../src/main/windows-programs').PowerShellProfileLookup
  const outcome = (): Lookup => (profile.fail ? { outcome: 'failed' } : profile.answer ? { outcome: 'found', path: profile.answer } : { outcome: 'none' })
  return {
    ...(await importOriginal<typeof import('../../../src/main/windows-programs')>()),
    findOnWindowsPathAsync: async (...a: unknown[]) => { walk.calls.push(a); return walk.answer },
    findWithPowerShellProfile: (...a: unknown[]) => {
      profile.calls.push(a)
      if (!profile.hold) return Promise.resolve(outcome())
      return new Promise<Lookup>((resolve) => { profile.release.push(() => resolve(outcome())) })
    },
  }
})

const {
  probeClaudeCli, _resetClaudeCliProbeForTest, findClaudeOnWindowsAsync, recentClaudeOnWindows, _resetClaudeWindowsLookupForTest, CLAUDE_LOOKUP_REUSE_MS,
  CLAUDE_WINDOWS_NAMES, CLAUDE_PROFILE_PROBE, setClaudeProfileLookupAllowed, keptClaudeFromPowerShellProfile, startClaudeProfileLookup, claudeFromPowerShellProfile,
  claudeFromPowerShellProfileForLaunch, PROFILE_RETRY_AFTER_FAILURE_MS,
} = await import('../../../src/main/claude-cli-probe')
const { noteWindowsPathRefresh } = await import('../../../src/main/windows-programs')

const calls = (): Call[] => exec.calls as Call[]

/** Settle the Nth outstanding spawn the way a real one would. */
function answer(index: number, stdout: string | null): void {
  const call = calls()[index]
  expect(call, `no spawn #${index} was made`).toBeDefined()
  if (stdout === null) call.done(Object.assign(new Error('exit 1'), { code: 1 }), '')
  else call.done(null, stdout)
}

/** Let the awaited microtasks between two sequential probes run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// SHELL is set per case below and put back after, so nothing leaks into the next file's process state.
const savedShell = process.env.SHELL
beforeEach(() => {
  exec.calls.length = 0
  walk.calls.length = 0
  walk.answer = null
  profile.calls.length = 0
  profile.answer = null
  profile.fail = false
  profile.hold = false
  profile.release.length = 0
  _resetClaudeCliProbeForTest()
  _resetClaudeWindowsLookupForTest()
})
afterEach(() => {
  if (savedShell === undefined) delete process.env.SHELL
  else process.env.SHELL = savedShell
})

describe('probeClaudeCli on Windows: the probe finds Claude Code only in PATH\'s folders', () => {
  beforeEach(() => { platform.value = 'win32' })

  it('reports the full path the in-process PATH walk finds, starting no process', async () => {
    walk.answer = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'
    const p = probeClaudeCli()
    await settle()
    expect(calls(), 'no process (no `where`) is started').toHaveLength(0)
    const result = await p
    expect(result.installed).toBe(true)
    expect(result.path).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
    // claude.exe in any folder first, then claude.cmd, then claude.bat
    expect(walk.calls).toHaveLength(1)
    expect(walk.calls[0][0]).toEqual(['claude.exe', 'claude.cmd', 'claude.bat'])
    expect(walk.calls[0][3]).toBe('name')
  })

  it('nothing in PATH\'s folders -> NOT installed, never a bare name, and no process', async () => {
    const p = probeClaudeCli()
    await settle()
    expect(calls()).toHaveLength(0)
    const result = await p
    expect(result.installed).toBe(false)
    expect(result.path).toBeUndefined()
  })
})

describe('a found Claude Code is reused for the same PATH, briefly', () => {
  const env = { PATH: 'C:\\Tools;C:\\Npm' }

  it('the same PATH within the reuse window: the answer, read with no walk', async () => {
    walk.answer = 'C:\\Tools\\claude.exe'
    expect(await findClaudeOnWindowsAsync(env, undefined, () => 1_000)).toBe('C:\\Tools\\claude.exe')
    walk.calls.length = 0
    expect(recentClaudeOnWindows({ Path: 'C:\\Tools;C:\\Npm' }, () => 1_000 + CLAUDE_LOOKUP_REUSE_MS - 1)).toBe('C:\\Tools\\claude.exe')
    expect(walk.calls).toEqual([])
  })

  it('another PATH, the window passed, or a clock gone backwards: no answer', async () => {
    walk.answer = 'C:\\Tools\\claude.exe'
    await findClaudeOnWindowsAsync(env, undefined, () => 1_000)
    expect(recentClaudeOnWindows({ PATH: 'C:\\Npm;C:\\Tools' }, () => 1_000)).toBeNull()
    expect(recentClaudeOnWindows(env, () => 1_000 + CLAUDE_LOOKUP_REUSE_MS)).toBeNull()
    expect(recentClaudeOnWindows(env, () => 999)).toBeNull()
  })

  it('answers are kept per PATH value: a profile run\'s PATH, which adds its own folder, keeps its own', async () => {
    const profile = { PATH: 'C:\\Tools;C:\\Npm;C:\\profiles\\p1\\.local\\bin' }
    walk.answer = 'C:\\Tools\\claude.exe'
    await findClaudeOnWindowsAsync(env, undefined, () => 1_000)
    walk.answer = 'C:\\profiles\\p1\\.local\\bin\\claude.exe'
    await findClaudeOnWindowsAsync(profile, undefined, () => 1_000)
    expect(recentClaudeOnWindows(env, () => 2_000)).toBe('C:\\Tools\\claude.exe')
    expect(recentClaudeOnWindows(profile, () => 2_000)).toBe('C:\\profiles\\p1\\.local\\bin\\claude.exe')
  })

  it('not found is never reused, and a later miss forgets an earlier find', async () => {
    walk.answer = null
    expect(await findClaudeOnWindowsAsync(env, undefined, () => 1_000)).toBeNull()
    expect(recentClaudeOnWindows(env, () => 1_000)).toBeNull()
    walk.answer = 'C:\\Tools\\claude.exe'
    await findClaudeOnWindowsAsync(env, undefined, () => 2_000)
    walk.answer = null
    await findClaudeOnWindowsAsync(env, undefined, () => 3_000)
    expect(recentClaudeOnWindows(env, () => 3_000)).toBeNull()
  })
})

// 2.1.1-beta.3 (F26): Claude Code on PATH only through the user's PowerShell
// profile (fnm plus an npm-installed claude.cmd). beta.2 walked only the
// app's own PATH, so every check said "not found" and every start refused.
describe('Windows: Claude Code that only the PowerShell profile puts on PATH', () => {
  const FNM = 'C:\\Users\\me\\AppData\\Local\\fnm_multishells\\1234_1700000000\\claude.cmd'
  const FNM2 = 'C:\\Users\\me\\AppData\\Local\\fnm_multishells\\5678_1700000999\\claude.cmd'
  const env = { PATH: 'C:\\Windows\\System32;C:\\Tools' }
  const exists = (present: boolean) => async (): Promise<boolean> => present
  /** Settle the oldest question still held, with the answer set now. */
  const releaseOne = (): void => { const r = profile.release.shift(); expect(r, 'no question is held').toBeDefined(); r!() }
  beforeEach(() => {
    platform.value = 'win32'
    setClaudeProfileLookupAllowed(() => true)
  })
  afterEach(() => { vi.useRealTimers() })

  // Mutation to prove this can fail: drop the profile fallback from
  // findClaudeOnWindowsWithSource (beta.2's behaviour).
  it('the walk finds none and the profile finds it: the setup probe reports it installed, by its full path', async () => {
    profile.answer = FNM
    const result = await probeClaudeCli()
    expect(result).toEqual({ installed: true, path: FNM, probe: CLAUDE_PROFILE_PROBE })
    expect(walk.calls).toHaveLength(1)
    expect(profile.calls).toHaveLength(1)
    expect(profile.calls[0][0]).toEqual(CLAUDE_WINDOWS_NAMES)
    expect(calls(), 'no process of this module (the question is windows-programs.ts\'s)').toHaveLength(0)
  })

  it('the walk finds it: the profile is never asked', async () => {
    walk.answer = 'C:\\Tools\\claude.exe'
    expect(await probeClaudeCli()).toMatchObject({ installed: true, path: 'C:\\Tools\\claude.exe' })
    expect(await findClaudeOnWindowsAsync(env)).toBe('C:\\Tools\\claude.exe')
    expect(profile.calls).toEqual([])
  })

  // Mutation to prove this can fail: forget a miss (keep only found answers).
  it('a miss in the profile too is kept for the run: the CLI check, a start and a background run do not ask again', async () => {
    expect(await findClaudeOnWindowsAsync(env)).toBeNull()
    expect(profile.calls).toHaveLength(1)
    expect(keptClaudeFromPowerShellProfile()).toBeNull()
    for (let i = 0; i < 5; i++) expect(await findClaudeOnWindowsAsync(env)).toBeNull()
    startClaudeProfileLookup()
    expect(claudeFromPowerShellProfileForLaunch()).toBeNull()
    expect(await claudeFromPowerShellProfile()).toBeNull()
    expect(profile.calls).toHaveLength(1)
  })

  // Mutation to prove this can fail: ignore windowsPathRefreshCount.
  it('it is asked again only after a check the user asked for, which brings PATH up to date first', async () => {
    expect(await findClaudeOnWindowsAsync(env)).toBeNull()
    expect(profile.calls).toHaveLength(1)
    noteWindowsPathRefresh()
    expect(keptClaudeFromPowerShellProfile()).toBeUndefined()
    profile.answer = FNM
    expect(await probeClaudeCli()).toMatchObject({ installed: true, path: FNM })
    expect(profile.calls).toHaveLength(2)
    // and that answer is kept in turn
    expect(await findClaudeOnWindowsAsync(env, exists(true))).toBe(FNM)
    expect(profile.calls).toHaveLength(2)
  })

  // Mutation to prove this can fail: drop the in-flight join.
  it('one question at a time: overlapping checks and starts share it', async () => {
    profile.hold = true
    profile.answer = FNM
    const checks = Array.from({ length: 5 }, () => findClaudeOnWindowsAsync(env))
    for (let i = 0; i < 3; i++) startClaudeProfileLookup()
    await settle()
    expect(profile.calls).toHaveLength(1)
    for (const r of profile.release) r()
    expect(await Promise.all(checks)).toEqual(Array(5).fill(FNM))
    expect(profile.calls).toHaveLength(1)
  })

  // Second trigger. Mutation to prove this can fail: join the question
  // running whatever the count of checks.
  it('a check the user asks for while a question started before it is still running waits for it, then asks once more, and keeps that answer', async () => {
    profile.hold = true
    profile.answer = null
    const boot = findClaudeOnWindowsAsync(env)
    await settle()
    expect(profile.calls).toHaveLength(1)
    // The user edits the profile, then presses Check again: PATH is brought up to date first.
    noteWindowsPathRefresh()
    const check = findClaudeOnWindowsAsync(env)
    const overlapping = findClaudeOnWindowsAsync(env)
    startClaudeProfileLookup()
    await settle()
    expect(profile.calls, 'still one question at a time').toHaveLength(1)
    releaseOne()
    expect(await boot).toBeNull()
    await settle()
    expect(profile.calls, 'asked once more, for the check').toHaveLength(2)
    profile.answer = FNM
    releaseOne()
    expect(await check).toBe(FNM)
    expect(await overlapping).toBe(FNM)
    expect(keptClaudeFromPowerShellProfile()).toBe(FNM)
    expect(profile.calls).toHaveLength(2)
  })

  // First trigger. Mutation to prove this can fail: read only the current
  // answer on the start path.
  it('a check about another provider makes the kept answer stale, not wrong: a start still names it, and one new question runs in the background', async () => {
    profile.answer = FNM
    expect(await findClaudeOnWindowsAsync(env, undefined, () => 1_000)).toBe(FNM)
    expect(profile.calls).toHaveLength(1)
    // Another provider's Check again (or its setup page) brings PATH up to date: the count moves.
    noteWindowsPathRefresh()
    profile.hold = true
    expect(recentClaudeOnWindows(env, () => 1_000)).toBe(FNM)
    expect(claudeFromPowerShellProfileForLaunch()).toBe(FNM)
    expect(profile.calls).toHaveLength(2)
    expect(recentClaudeOnWindows(env, () => 1_000)).toBe(FNM)
    expect(profile.calls).toHaveLength(2)
    profile.answer = FNM2
    releaseOne()
    await settle()
    expect(recentClaudeOnWindows(env, () => 1_000)).toBe(FNM2)
    expect(keptClaudeFromPowerShellProfile()).toBe(FNM2)
    expect(profile.calls).toHaveLength(2)
  })

  it('a kept path is used while it is still a file, and asked again once it is gone', async () => {
    profile.answer = FNM
    expect(await findClaudeOnWindowsAsync(env)).toBe(FNM)
    expect(await findClaudeOnWindowsAsync(env, exists(true))).toBe(FNM)
    expect(profile.calls).toHaveLength(1)
    profile.answer = null
    expect(await findClaudeOnWindowsAsync(env, exists(false))).toBeNull()
    expect(profile.calls).toHaveLength(2)
    expect(keptClaudeFromPowerShellProfile()).toBeNull()
  })

  it('a recent answer is the profile\'s only after a recent walk of the same PATH found none: another PATH is walked first', async () => {
    profile.answer = FNM
    await findClaudeOnWindowsAsync(env, undefined, () => 1_000)
    expect(recentClaudeOnWindows(env, () => 1_000)).toBe(FNM)
    expect(recentClaudeOnWindows({ PATH: 'C:\\profiles\\p1\\.local\\bin;C:\\Tools' }, () => 1_000)).toBeNull()
    expect(recentClaudeOnWindows(env, () => 1_000 + CLAUDE_LOOKUP_REUSE_MS)).toBeNull()
  })

  // Mutation to prove this can fail: keep a question with no answer for the
  // run, like a miss.
  it('a question with no answer to go by (timed out at sign-in, say) is not kept like a miss: asked once more after a few minutes, never on every 30 s check', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    profile.fail = true
    expect(await findClaudeOnWindowsAsync(env)).toBeNull()
    expect(profile.calls).toHaveLength(1)
    expect(keptClaudeFromPowerShellProfile()).toBeNull()
    vi.setSystemTime(1_000_000 + PROFILE_RETRY_AFTER_FAILURE_MS - 1)
    for (let i = 0; i < 3; i++) expect(await findClaudeOnWindowsAsync(env)).toBeNull()
    startClaudeProfileLookup()
    expect(claudeFromPowerShellProfileForLaunch()).toBeNull()
    expect(profile.calls, 'not within the floor').toHaveLength(1)
    vi.setSystemTime(1_000_000 + PROFILE_RETRY_AFTER_FAILURE_MS)
    profile.fail = false
    profile.answer = FNM
    expect(await findClaudeOnWindowsAsync(env)).toBe(FNM)
    expect(profile.calls).toHaveLength(2)
    expect(PROFILE_RETRY_AFTER_FAILURE_MS).toBeGreaterThanOrEqual(2 * 60_000)
  })

  it('a second question with no answer for the same count is kept like a miss, until a check the user asks for', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    profile.fail = true
    await findClaudeOnWindowsAsync(env)
    vi.setSystemTime(1_000_000 + PROFILE_RETRY_AFTER_FAILURE_MS)
    expect(await findClaudeOnWindowsAsync(env)).toBeNull()
    expect(profile.calls).toHaveLength(2)
    vi.setSystemTime(1_000_000 + 20 * PROFILE_RETRY_AFTER_FAILURE_MS)
    expect(await findClaudeOnWindowsAsync(env)).toBeNull()
    startClaudeProfileLookup()
    expect(profile.calls).toHaveLength(2)
    noteWindowsPathRefresh()
    profile.fail = false
    profile.answer = FNM
    expect(await findClaudeOnWindowsAsync(env)).toBe(FNM)
    expect(profile.calls).toHaveLength(3)
  })

  it('a question with no answer after one that named a path keeps that path: a start is not refused for it', async () => {
    profile.answer = FNM
    expect(await findClaudeOnWindowsAsync(env, exists(true))).toBe(FNM)
    noteWindowsPathRefresh()
    profile.fail = true
    expect(await findClaudeOnWindowsAsync(env, exists(true))).toBe(FNM)
    expect(profile.calls).toHaveLength(2)
    expect(keptClaudeFromPowerShellProfile()).toBe(FNM)
    expect(claudeFromPowerShellProfileForLaunch()).toBe(FNM)
  })

  // Mutation to prove this can fail: drop profileLookupMayRun from
  // claudeFromPowerShellProfile.
  it('never while Claude Code is switched off, nor before main has set its rule; nothing is kept then', async () => {
    _resetClaudeWindowsLookupForTest()
    profile.answer = FNM
    expect(await findClaudeOnWindowsAsync(env)).toBeNull()
    startClaudeProfileLookup()
    expect(claudeFromPowerShellProfileForLaunch()).toBeNull()
    setClaudeProfileLookupAllowed(() => false)
    expect(await probeClaudeCli()).toMatchObject({ installed: false })
    startClaudeProfileLookup()
    expect(claudeFromPowerShellProfileForLaunch()).toBeNull()
    setClaudeProfileLookupAllowed(() => { throw new Error('cannot read') })
    expect(await findClaudeOnWindowsAsync(env)).toBeNull()
    expect(profile.calls).toEqual([])
    expect(keptClaudeFromPowerShellProfile()).toBeUndefined()
    setClaudeProfileLookupAllowed(() => true)
    expect(await findClaudeOnWindowsAsync(env)).toBe(FNM)
    expect(profile.calls).toHaveLength(1)
    // and a path kept while it was on is not named for a start once it is off
    setClaudeProfileLookupAllowed(() => false)
    expect(claudeFromPowerShellProfileForLaunch()).toBeNull()
  })
})

describe('probeClaudeCli on POSIX', () => {
  beforeEach(() => { platform.value = 'darwin'; process.env.SHELL = '/bin/zsh' })

  it('asks the LOGIN shell first, so a Homebrew/nvm install is seen', async () => {
    const p = probeClaudeCli()
    answer(0, '/opt/homebrew/bin/claude\n')
    const result = await p
    expect(result.installed).toBe(true)
    expect(result.path).toBe('/opt/homebrew/bin/claude')
    expect(calls()[0].bin).toBe('/bin/zsh')
    expect(calls()[0].args).toEqual(['-lc', 'command -v claude'])
  })

  it('falls back to `which` when the login shell probe cannot run', async () => {
    const p = probeClaudeCli()
    answer(0, null)
    await settle()
    answer(1, '/usr/local/bin/claude\n')
    const result = await p
    expect(result.installed).toBe(true)
    expect(calls()[1].bin).toBe('which')
  })

  it('both misses -> NOT installed', async () => {
    const p = probeClaudeCli()
    answer(0, null)
    await settle()
    answer(1, null)
    expect((await p).installed).toBe(false)
  })
})

// ── The DoS fixes (adversarial review, 2026-09-01) ──────────────────────────

describe('probeClaudeCli does not block the main process', () => {
  // Mutation to prove this can fail: restore `execFileSync` in
  // claude-cli-probe.ts — the module then spawns synchronously and this grep
  // finds the call.
  it('the module uses NO synchronous spawn — a *Sync probe freezes every IPC handler for up to 24s', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../src/main/claude-cli-probe.ts'),
      'utf8',
    )
    // Comments are allowed to NAME the old API (they explain the fix); code is
    // not. Strip comments, then look.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/execFileSync|spawnSync|execSync/)
    expect(code).toMatch(/\bexecFile\b/)
  })

  // The spawn-counting checks run on the POSIX branch, which still starts a
  // probe process; the Windows branch starts none (its walk is in-process).
  it('the probe is genuinely deferred — nothing has resolved while the spawn is outstanding', async () => {
    platform.value = 'darwin'
    process.env.SHELL = '/bin/zsh'
    let settled = false
    void probeClaudeCli().then(() => { settled = true })
    // A sync probe would already have produced a result by here.
    expect(calls()).toHaveLength(1)
    await settle()
    expect(settled).toBe(false)
    answer(0, '/usr/local/bin/claude')
    await settle()
    expect(settled).toBe(true)
  })
})

describe('overlapping probes coalesce onto ONE probe', () => {
  beforeEach(() => { platform.value = 'darwin'; process.env.SHELL = '/bin/zsh' })
  // Mutation to prove this can fail: drop the `inFlight` guard and call
  // runProbe() directly — the spawn count becomes 20 (or 40 on the miss path).
  it('twenty concurrent callers spawn one process and share one answer', async () => {
    const promises = Array.from({ length: 20 }, () => probeClaudeCli())
    expect(calls()).toHaveLength(1)
    answer(0, '/usr/local/bin/claude')
    const results = await Promise.all(promises)
    expect(calls()).toHaveLength(1)
    for (const r of results) expect(r).toEqual(results[0])
  })

  it('the guard COALESCES rather than caches — the next call after it settles re-probes', async () => {
    const first = probeClaudeCli()
    answer(0, '/usr/local/bin/claude')
    expect((await first).installed).toBe(true)

    const second = probeClaudeCli()
    expect(calls()).toHaveLength(2)
    answer(1, '/opt/elsewhere/claude')
    expect((await second).path).toBe('/opt/elsewhere/claude')
  })

  it('on Windows, twenty concurrent callers share one PATH walk', async () => {
    platform.value = 'win32'
    walk.answer = 'C:\\Tools\\claude.exe'
    const results = await Promise.all(Array.from({ length: 20 }, () => probeClaudeCli()))
    expect(walk.calls).toHaveLength(1)
    for (const r of results) expect(r).toEqual(results[0])
  })
})
