// A session started in a symlinked folder gets its status line and usage.
// Codex may record the real folder in the rollout while the session was
// started with the link's name (a program that asks the system where it runs
// is told the real path), and the claim compared the two as plain strings, so
// the rollout was never taken. The claim now also accepts a rollout whose
// folder resolves to the session's, and still tries the exact spelling first.
// The system's real-path answer is a table here, so this runs on any OS with
// no link made (the real link is tested in telemetry-symlink-real.test.ts).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'

const realOf = new Map<string, string>()
/** Every folder the system was asked the real path of. */
const lookups: string[] = []
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const native = ((p: unknown, o?: unknown) => {
    lookups.push(String(p))
    const mapped = realOf.get(String(p))
    return mapped !== undefined ? mapped : (actual.realpathSync.native as (a: unknown, b?: unknown) => string)(p, o)
  }) as typeof actual.realpathSync.native
  const realpathSync = Object.assign(((p: unknown, o?: unknown) => native(p, o)) as unknown as typeof actual.realpathSync, { native })
  return { ...actual, default: { ...actual, realpathSync }, realpathSync }
})

const { watchAndClaimRollout } = await import('../../../../src/main/providers/codex/telemetry')

const ID = '019dd000-0001-7000-8000-0000000000f1'
const LINK = '/links/demo'
const REAL = '/real/demo'
const temps: string[] = []
afterEach(() => {
  vi.useRealTimers()
  realOf.clear()
  lookups.length = 0
  // Only a folder this file made (its own prefix, directly in the temp folder) is removed.
  for (const t of temps.splice(0)) if (dirname(t) === tmpdir() && /^ccc-test-codex-symfolder-/.test(basename(t))) rmSync(t, { recursive: true, force: true })
})

const pad = (n: number) => String(n).padStart(2, '0')
const tokenLine = (iso: string, input: number) =>
  JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 } }, rate_limits: null } })

/** A realm with one new rollout recording `recordedCwd`, written after the watch starts. */
async function run(sessionCwd: string, recordedCwd: string, alsoRecorded: string[] = []): Promise<{ claims: string[]; inputTokens: number | undefined }> {
  vi.useFakeTimers()
  const base = mkdtempSync(join(tmpdir(), 'ccc-test-codex-symfolder-'))
  temps.push(base)
  const sessions = join(base, 'sessions')
  const now = new Date()
  const dir = join(sessions, String(now.getUTCFullYear()), pad(now.getUTCMonth() + 1), pad(now.getUTCDate()))
  mkdirSync(dir, { recursive: true })
  const updates: Array<{ inputTokens?: number }> = []
  const claims: string[] = []
  const src = watchAndClaimRollout('sess-symfolder', sessionCwd, Date.now(), (d) => updates.push(d), sessions, undefined, { onClaim: (c) => claims.push(c.id) })
  await vi.advanceTimersByTimeAsync(2_000)
  const iso = new Date().toISOString()
  const meta = JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id: ID, timestamp: iso, cwd: recordedCwd, cli_version: '0.155.1' } })
  writeFileSync(join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${ID}.jsonl`), [meta, tokenLine(iso, 42)].join('\n') + '\n')
  // Further rollouts of other conversations in the same day folder, recording other folders.
  alsoRecorded.forEach((cwd, i) => {
    const other = JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id: ID.replace(/1$/, String(2 + i)), timestamp: iso, cwd, cli_version: '0.155.1' } })
    writeFileSync(join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${ID.replace(/1$/, String(2 + i))}.jsonl`), other + '\n')
  })
  await vi.advanceTimersByTimeAsync(3_000)
  src.stop()
  return { claims, inputTokens: updates.at(-1)?.inputTokens }
}

describe('a session in a symlinked folder is found by the real folder its rollout records', () => {
  it('takes a rollout that records the real folder when the session was started in the link', async () => {
    realOf.set(LINK, REAL)
    realOf.set(REAL, REAL)
    const r = await run(LINK, REAL)
    expect(r.claims).toEqual([ID])
    expect(r.inputTokens).toBe(42)
  })

  it('takes a rollout that records the link when the session was started in the real folder', async () => {
    realOf.set(LINK, REAL)
    realOf.set(REAL, REAL)
    const r = await run(REAL, LINK)
    expect(r.claims).toEqual([ID])
    expect(r.inputTokens).toBe(42)
  })

  it('still takes the exact spelling without asking the system for a real path', async () => {
    const r = await run('/p/exact', '/p/exact')
    expect(r.claims).toEqual([ID])
  })

  it('does not take a rollout recorded in a different folder', async () => {
    realOf.set(LINK, REAL)
    realOf.set(REAL, REAL)
    realOf.set('/real/other', '/real/other')
    const r = await run(LINK, '/real/other')
    expect(r.claims).toEqual([])
    expect(r.inputTokens).toBeUndefined()
  })

  it('does not take a rollout whose folder cannot be resolved', async () => {
    realOf.set(LINK, REAL)
    const r = await run(LINK, '/gone/elsewhere')
    expect(r.claims).toEqual([])
  })

  it('asks the system about a folder once per watch, however many rollouts record it or the session', async () => {
    realOf.set(LINK, REAL)
    realOf.set(REAL, REAL)
    realOf.set('/real/other', '/real/other')
    const r = await run(LINK, '/real/other', ['/real/other', '/real/other'])
    expect(r.claims).toEqual([])
    expect(lookups.filter((p) => p === LINK)).toHaveLength(1)
    expect(lookups.filter((p) => p === '/real/other')).toHaveLength(1)
  })

  it('does not ask the system about a relative folder or one on a network share (a slow share would hold the main thread)', async () => {
    realOf.set(LINK, REAL)
    for (const recorded of ['relative/demo', '\\\\server\\share\\demo', '//server/share/demo']) {
      const r = await run(LINK, recorded)
      expect(r.claims, recorded).toEqual([])
    }
    // The session's own folder is a link, but nothing recorded was a folder worth resolving.
    expect(lookups).toEqual([])
    const unc = await run('\\\\server\\share\\demo', REAL)
    expect(unc.claims).toEqual([])
    expect(lookups).toEqual([])
  })
})
