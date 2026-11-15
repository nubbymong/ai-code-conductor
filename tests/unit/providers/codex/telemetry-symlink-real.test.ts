// HOST QUARANTINE: plants a symbolic link in a temp folder. [CI] [VM] only -- never run on the owner's machine.
// The same rule as telemetry-symlinked-folder.test.ts, with a real link: a
// session started in a symlinked folder is found by a rollout that records
// the real folder, and the other way round. POSIX only: making a link on
// Windows needs a privilege or a junction, which this file does not plant.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { watchAndClaimRollout } from '../../../../src/main/providers/codex/telemetry'
import { sameFolderByRealPath } from '../../../../src/main/providers/codex/rollout-lookup'

const ID = '019dd000-0001-7000-8000-0000000000f2'
const temps: string[] = []
afterEach(() => {
  vi.useRealTimers()
  // Only a folder this file made (its own prefix, directly in the temp folder) is removed; the link first, never through it.
  for (const t of temps.splice(0)) {
    if (dirname(t) !== tmpdir() || !/^ccc-test-codex-symreal-/.test(basename(t))) continue
    try { unlinkSync(join(t, 'link')) } catch { /* not made */ }
    rmSync(t, { recursive: true, force: true })
  }
})

const pad = (n: number) => String(n).padStart(2, '0')
const tokenLine = (iso: string, input: number) =>
  JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 } }, rate_limits: null } })

function project(): { real: string; link: string; sessions: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-test-codex-symreal-')))
  temps.push(base)
  const real = join(base, 'project')
  const link = join(base, 'link')
  mkdirSync(real)
  symlinkSync(real, link, 'dir')
  return { real, link, sessions: join(base, 'sessions') }
}

async function claimWith(sessionCwd: string, recordedCwd: string, sessions: string): Promise<string[]> {
  vi.useFakeTimers()
  const now = new Date()
  const dir = join(sessions, String(now.getUTCFullYear()), pad(now.getUTCMonth() + 1), pad(now.getUTCDate()))
  mkdirSync(dir, { recursive: true })
  const claims: string[] = []
  const src = watchAndClaimRollout('sess-symreal', sessionCwd, Date.now(), () => {}, sessions, undefined, { onClaim: (c) => claims.push(c.id) })
  await vi.advanceTimersByTimeAsync(2_000)
  const iso = new Date().toISOString()
  const meta = JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id: ID, timestamp: iso, cwd: recordedCwd, cli_version: '0.155.1' } })
  writeFileSync(join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${ID}.jsonl`), [meta, tokenLine(iso, 7)].join('\n') + '\n')
  await vi.advanceTimersByTimeAsync(3_000)
  src.stop()
  return claims
}

describe.skipIf(process.platform === 'win32')('a real symlinked project folder', () => {
  it('is the same folder as its target, by real path', () => {
    const { real, link } = project()
    expect(sameFolderByRealPath(link, real)).toBe(true)
    expect(sameFolderByRealPath(real, link)).toBe(true)
    expect(sameFolderByRealPath(link, join(real, 'missing'))).toBe(false)
  })

  it('is claimed by a rollout that records the real folder', async () => {
    const { real, link, sessions } = project()
    expect(await claimWith(link, real, sessions)).toEqual([ID])
  })

  it('is claimed by a rollout that records the link', async () => {
    const { real, link, sessions } = project()
    expect(await claimWith(real, link, sessions)).toEqual([ID])
  })
})
