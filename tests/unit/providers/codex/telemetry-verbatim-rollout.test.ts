// 2.1.3-beta.19 fix round, item CODEX172 (pre-existing, on published beta.18
// too). With Codex 0.172.0, every RESUMED conversation's hook named its
// transcript in a form the app refused: "[pty] Codex session <id>: a hook named
// a transcript that is not a rollout of its account folder (length 202);
// ignored". Never at a first start, never with Codex 0.157.1; the rollout's
// own path was 198 characters.
//
// Measured in Codex's own source: a hook's transcript_path is the live
// thread's rollout path (codex-rs/core/src/session/mod.rs hook_transcript_path,
// via live_thread.local_rollout_path). From 0.172.0 a resumed thread's live
// path is `std::fs::canonicalize` of the rollout (thread-store/src/local/
// helpers.rs scoped_rollout_path; its test in local/mod.rs asserts
// `Some(std::fs::canonicalize(rollout_path))`, where 0.157.0's asserts
// `Some(rollout_path)`). On Windows, Rust's canonicalize answers the verbatim
// form, `\\?\C:\...`: four characters more, 198 to 202.
//
// So the same rollout file named in that form is the session's own; the
// containment check is unchanged and runs on the path without the prefix:
// a verbatim path outside the account's folder is still refused. Real files in
// a temp folder (no links: this file runs on any host).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { watchAndClaimRollout, withoutVerbatimPrefix } from '../../../../src/main/providers/codex/telemetry'

const ID_A = '019dd000-0001-7000-8000-00000000000a'
const ID_B = '019dd000-0001-7000-8000-00000000000b'
const pad = (n: number) => String(n).padStart(2, '0')
const temps: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const t of temps.splice(0)) if (dirname(t) === tmpdir() && /^ccc-test-codex-verbatim-/.test(basename(t))) rmSync(t, { recursive: true, force: true })
})
function realm(): string {
  const base = mkdtempSync(join(tmpdir(), 'ccc-test-codex-verbatim-'))
  temps.push(base)
  return join(base, 'sessions')
}
function today(sessions: string): string {
  const d = new Date()
  const dir = join(sessions, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()))
  mkdirSync(dir, { recursive: true })
  return dir
}
function rollout(dir: string, id: string, cwd: string, iso: string): string {
  const file = join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`)
  writeFileSync(file, JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd, cli_version: '0.172.0' } }) + '\n', 'utf-8')
  return file
}
function watch(sessions: string, cwd: string) {
  const claims: Array<{ id: string; exact?: boolean; fromHook?: boolean }> = []
  const src = watchAndClaimRollout('sess', cwd, Date.now(), () => {}, sessions, undefined, { onClaim: (c) => claims.push({ ...c }) })
  return { claims, src }
}

describe('a resumed conversation\'s hook, as Codex 0.172.0 names it on Windows (std::fs::canonicalize\'s verbatim form)', () => {
  it.runIf(process.platform === 'win32')('the same rollout named as \\\\?\\C:\\... is the session\'s own: claimed exactly, from the hook', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const w = watch(sessions, 'C:\\p\\demo')
    const file = rollout(today(sessions), ID_A, 'C:\\p\\demo', new Date(Date.now() + 50).toISOString())
    const named = `\\\\?\\${file}`
    // The shape measured: the rollout's own path, four characters more.
    expect(named.length).toBe(file.length + 4)
    expect(w.src.noteExactRollout!(named)).toEqual({ id: ID_A, cwd: 'C:\\p\\demo' })
    expect(w.claims.at(-1)).toMatchObject({ id: ID_A, exact: true, fromHook: true })
    w.src.stop()
  })

  it.runIf(process.platform === 'win32')('a verbatim path outside the account\'s folder is still refused; so is a verbatim form of another kind', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const w = watch(sessions, 'C:\\p\\demo')
    rollout(today(sessions), ID_A, 'C:\\p\\demo', new Date(Date.now() + 50).toISOString())
    const otherRealm = realm()
    const foreign = rollout(today(otherRealm), ID_B, 'C:\\p\\demo', new Date().toISOString())
    for (const bad of [`\\\\?\\${foreign}`, `\\\\?\\${join(sessions, '..', '..', basename(foreign))}`, `\\\\?\\Volume{0000}\\${basename(foreign)}`, `\\\\.\\${foreign}`]) {
      expect(w.src.noteExactRollout!(bad), bad).toBeNull()
    }
    expect(w.claims.filter((c) => c.exact)).toEqual([])
    w.src.stop()
  })
})

describe('withoutVerbatimPrefix', () => {
  it('drops the verbatim prefix of a drive path and of a share on Windows; anything else, and every path elsewhere, as it is', () => {
    expect(withoutVerbatimPrefix('\\\\?\\C:\\Users\\u\\.codex\\sessions\\x.jsonl', 'win32')).toBe('C:\\Users\\u\\.codex\\sessions\\x.jsonl')
    expect(withoutVerbatimPrefix('\\\\?\\UNC\\server\\share\\x.jsonl', 'win32')).toBe('\\\\server\\share\\x.jsonl')
    expect(withoutVerbatimPrefix('C:\\Users\\u\\x.jsonl', 'win32')).toBe('C:\\Users\\u\\x.jsonl')
    expect(withoutVerbatimPrefix('\\\\?\\Volume{0000}\\x.jsonl', 'win32')).toBe('\\\\?\\Volume{0000}\\x.jsonl')
    expect(withoutVerbatimPrefix('\\\\.\\C:\\x.jsonl', 'win32')).toBe('\\\\.\\C:\\x.jsonl')
    expect(withoutVerbatimPrefix('\\\\?\\C:\\x.jsonl', 'linux')).toBe('\\\\?\\C:\\x.jsonl')
  })
})
