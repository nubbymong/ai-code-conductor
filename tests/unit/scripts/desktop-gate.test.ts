import { describe, it, expect } from 'vitest'
// Plain ESM with main() behind an argv[1] check, like reuse-green-ci.mjs:
// importing it runs nothing. GitHub is injected as `get`.
import { GATE_LABELS, STABLE_BASE, READ_ATTEMPTS, decideGate, readPull, main } from '../../../scripts/ci/desktop-gate.mjs'

/**
 * The Desktop test gate (ADR-028, rule 9): desktop testing is at release level
 * on beta and pre-release on stable. The check decides from the pull request
 * AS IT IS NOW, read from GitHub, never from the event the run was started
 * with: a re-run replays its first event, and a PR can have been retargeted or
 * lost its label since.
 */

const REPO = 'o/r'
type Over = Record<string, unknown>
const pull = (base: unknown, labels: string[] = [], over: Over = {}) => ({ number: 12, state: 'open', base: { ref: base }, labels: labels.map((name) => ({ name })), ...over })

const OPEN = "This PR targets 'beta', not main. Desktop testing happens on the released beta build, not per PR, and no label is needed. Gate open."
const NEEDS = "::error::Desktop test gate: a PR into main (the stable promotion) must carry 'desktop-tested' (a human launched and exercised the packaged app), 'runtime-validated' (automated VM e2e and/or the live SSH statusline matrix passed), or 'skip-desktop-test' (docs/deps/CI/changelog-only) before it can merge. See CONTRIBUTING.md > Desktop-test gate."

describe('desktop-gate: the decision', () => {
  it('a PR into beta, a release line or any base but main passes with no label, and says where desktop testing happens', () => {
    expect(STABLE_BASE).toBe('main')
    expect(decideGate(pull('beta'), 12)).toEqual({ pass: true, message: OPEN })
    for (const base of ['beta', 'release/v2.1.3', 'release/v2.2.0', 'maintenance', 'main-old', 'not-main', 'mainline', 'x/main']) {
      for (const labels of [[], ['ci-run'], ['desktop-tested'], ['skip-desktop-test', 'ci-run']]) {
        expect(decideGate(pull(base, labels), 12), `${base} [${labels}]`).toEqual({ pass: true, message: `This PR targets '${base}', not main. Desktop testing happens on the released beta build, not per PR, and no label is needed. Gate open.` })
      }
    }
  })

  it('a PR into main, the stable promotion, needs one of the three labels', () => {
    expect(GATE_LABELS).toEqual(['desktop-tested', 'runtime-validated', 'skip-desktop-test'])
    expect(decideGate(pull('main'), 12)).toEqual({ pass: false, message: NEEDS })
    expect(decideGate(pull('main', ['ci-run', 'in-beta', 'desktop-test', 'desktop-tested-not', 'not-desktop-tested']), 12)).toEqual({ pass: false, message: NEEDS })
    expect(decideGate(pull('main', ['ci-run', 'desktop-tested']), 12)).toEqual({ pass: true, message: "PR into main carries 'desktop-tested' - a human exercised the packaged app on a real desktop. Gate open." })
    expect(decideGate(pull('main', ['runtime-validated']), 12)).toEqual({ pass: true, message: "PR into main carries 'runtime-validated' - automated runtime validation passed (VM Playwright e2e and/or the live SSH statusline matrix). Gate open." })
    expect(decideGate(pull('main', ['skip-desktop-test', 'x']), 12)).toEqual({ pass: true, message: "PR into main carries 'skip-desktop-test' - no runtime test required (docs/deps/CI/changelog-only). Gate open." })
    // The first of the three that is present is the one named.
    expect(decideGate(pull('main', ['skip-desktop-test', 'runtime-validated', 'desktop-tested']), 12).message).toMatch(/^PR into main carries 'desktop-tested' /)
    // A label name has no case on GitHub; a base that differs from main only in case needs the label too (fail closed).
    expect(decideGate(pull('main', ['Desktop-Tested']), 12).pass).toBe(true)
    for (const base of ['MAIN', 'Main']) {
      expect(decideGate(pull(base), 12), base).toEqual({ pass: false, message: NEEDS })
      expect(decideGate(pull(base, ['runtime-validated']), 12).pass, base).toBe(true)
    }
  })

  it('a pull request that cannot be read decides nothing: the check fails, whatever labels it shows', () => {
    const unread = (p: unknown, n: unknown = 12) => {
      const d = decideGate(p as never, n as never)
      expect(d.pass, JSON.stringify(p)).toBe(false)
      expect(d.message, JSON.stringify(p)).toMatch(/^::error::Desktop test gate: could not read pull request #\S+ as it is now \(.+\)\. Nothing was decided; re-run this job\.$/)
      return d.message
    }
    // Not an object at all, or a list: no pull request, said so.
    for (const p of [null, undefined, 'x', 7, true, [], [pull('beta')]]) expect(unread(p), JSON.stringify(p)).toMatch(/GitHub returned no pull request\)/)
    expect(unread({})).toMatch(/GitHub answered with another pull request/)
    // Another pull request than the one asked for.
    expect(unread(pull('beta', [], { number: 13 }))).toMatch(/GitHub answered with another pull request/)
    expect(unread(pull('beta', [], { number: '12' }))).toMatch(/GitHub answered with another pull request/)
    // No base to read: not treated as beta, and not as main with a label either.
    for (const base of ['', '  ', null, undefined, 7, { ref: 'beta' }]) {
      expect(unread(pull(base)), JSON.stringify(base)).toMatch(/no base branch in the answer/)
      expect(unread(pull(base, ['desktop-tested'])), JSON.stringify(base)).toMatch(/no base branch in the answer/)
    }
    expect(unread({ number: 12, labels: [] })).toMatch(/no base branch in the answer/)
    // No label list, or a label with no name: on a PR into main nothing can be decided.
    for (const labels of [undefined, null, 'desktop-tested', {}, [null], ['desktop-tested'], [{ name: 7 }], [{ name: 'desktop-tested' }, {}]]) {
      expect(unread({ number: 12, base: { ref: 'main' }, labels }), JSON.stringify(labels)).toMatch(/no label list in the answer/)
      expect(unread({ number: 12, base: { ref: 'beta' }, labels }), JSON.stringify(labels)).toMatch(/no label list in the answer/)
    }
    expect(unread(pull('beta'), 0)).toMatch(/pull request #0 /)
  })
})

describe('desktop-gate: the read', () => {
  it('asks GitHub for this pull request, and tries again when the read fails', async () => {
    const asked: string[] = []
    expect(READ_ATTEMPTS).toBe(3)
    expect(await readPull({ repo: REPO, number: 12, get: async (p: string) => { asked.push(p); return pull('beta') }, sleep: async () => {} })).toEqual(pull('beta'))
    expect(asked).toEqual(['/repos/o/r/pulls/12'])
    // Two failures, then an answer: three reads, two waits.
    let calls = 0
    const waits: number[] = []
    const flaky = async () => { calls += 1; if (calls < READ_ATTEMPTS) throw new Error('GitHub API 502 for /x'); return pull('main') }
    expect(await readPull({ repo: REPO, number: 12, get: flaky, sleep: async (ms: number) => { waits.push(ms) } })).toEqual(pull('main'))
    expect(calls).toBe(READ_ATTEMPTS)
    expect(waits).toEqual([2000, 2000])
    // Every attempt fails: the last error is thrown, after READ_ATTEMPTS reads and no wait after the last.
    calls = 0
    waits.length = 0
    await expect(readPull({ repo: REPO, number: 12, get: async () => { calls += 1; throw new Error(`down ${calls}`) }, sleep: async (ms: number) => { waits.push(ms) } })).rejects.toThrow(`down ${READ_ATTEMPTS}`)
    expect(calls).toBe(READ_ATTEMPTS)
    expect(waits).toHaveLength(READ_ATTEMPTS - 1)
  })
})

describe('desktop-gate: the job step', () => {
  const env = { GITHUB_REPOSITORY: REPO, PR_NUMBER: '12' }
  const io = (live: unknown, over: Over = {}) => {
    const lines: string[] = []
    const asked: string[] = []
    return { lines, asked, io: { log: (s: string) => { lines.push(s) }, sleep: async () => {}, get: async (p: string) => { asked.push(p); if (live instanceof Error) throw live; return live }, ...over } }
  }

  it('exits 0 on an open gate and 1 on a closed one, and prints one line', async () => {
    const beta = io(pull('beta'))
    expect(await main([], env, beta.io)).toBe(0)
    expect(beta.lines).toEqual([OPEN])
    expect(beta.asked).toEqual(['/repos/o/r/pulls/12'])
    const promo = io(pull('main'))
    expect(await main([], env, promo.io)).toBe(1)
    expect(promo.lines).toEqual([NEEDS])
    expect(await main([], env, io(pull('main', ['desktop-tested'])).io)).toBe(0)
    expect(await main([], env, io(pull('main', ['runtime-validated'])).io)).toBe(0)
    expect(await main([], env, io(pull('main', ['skip-desktop-test'])).io)).toBe(0)
  })

  it('decides from the PR as it is now: a re-run of a run that began on a beta base does not bring its green back', async () => {
    // The step is given the PR number and nothing else of the event, so the
    // three states below are one and the same run, started again each time.
    // 1. The PR is into beta: open.
    expect(await main([], env, io(pull('beta')).io)).toBe(0)
    // 2. It is retargeted to main; the run of step 1 is started again: closed.
    expect(await main([], env, io(pull('main')).io)).toBe(1)
    // 3. The same for a label: a run that began while desktop-tested was on
    //    the PR is started again after the label was removed.
    expect(await main([], env, io(pull('main', ['desktop-tested'])).io)).toBe(0)
    expect(await main([], env, io(pull('main', ['ci-run'])).io)).toBe(1)
    // Nothing in the environment can stand in for the read.
    const stale = { ...env, BASE_REF: 'beta', GITHUB_BASE_REF: 'beta', HAS_TESTED: 'true', HAS_RUNTIME: 'true', HAS_SKIP: 'true' }
    expect(await main([], stale, io(pull('main')).io)).toBe(1)
  })

  it('a read that fails, or an input that is not exact, closes the gate and says nothing was decided', async () => {
    const down = io(new Error('GitHub API 503 for /repos/o/r/pulls/12'))
    expect(await main([], env, down.io)).toBe(1)
    expect(down.asked).toHaveLength(READ_ATTEMPTS)
    expect(down.lines).toEqual(['::error::Desktop test gate: could not read pull request #12 as it is now (GitHub API 503 for /repos/o/r/pulls/12). Nothing was decided; re-run this job.'])
    for (const bad of [{ PR_NUMBER: '' }, { PR_NUMBER: '0' }, { PR_NUMBER: '12a' }, { PR_NUMBER: '-1' }, { PR_NUMBER: '1.5' }, { PR_NUMBER: ' 12' }, { PR_NUMBER: '12/../13' }, { GITHUB_REPOSITORY: '' }, { GITHUB_REPOSITORY: 'o' }, { GITHUB_REPOSITORY: 'o/r/x' }, { GITHUB_REPOSITORY: 'o/r?x=1' }, { GITHUB_REPOSITORY: '../r' }]) {
      const g = io(pull('beta'))
      expect(await main([], { ...env, ...bad }, g.io), JSON.stringify(bad)).toBe(1)
      expect(g.asked, JSON.stringify(bad)).toEqual([])
      expect(g.lines[0], JSON.stringify(bad)).toMatch(/^::error::Desktop test gate: could not read pull request .*Nothing was decided; re-run this job\.$/)
    }
    // Unset is the same as empty.
    expect(await main([], {}, io(pull('beta')).io)).toBe(1)
    // A log that throws does not open the gate.
    expect(await main([], env, { ...io(pull('beta')).io, log: () => { throw new Error('closed pipe') } })).toBe(1)
  })

  it('the arguments win over the environment, and the token goes to GitHub as a bearer header only', async () => {
    const g = io(pull('beta', [], { number: 44 }))
    expect(await main(['--repo', 'a/b', '--pr', '44'], env, g.io)).toBe(0)
    expect(g.asked).toEqual(['/repos/a/b/pulls/44'])
    const seen: { url: string; auth: unknown }[] = []
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => { seen.push({ url, auth: init.headers.Authorization }); return { ok: true, status: 200, json: async () => pull('main') } }
    const lines: string[] = []
    expect(await main([], { ...env, GH_TOKEN: 'placeholder' }, { log: (s: string) => { lines.push(s) }, sleep: async () => {}, fetchImpl })).toBe(1)
    expect(seen).toEqual([{ url: 'https://api.github.com/repos/o/r/pulls/12', auth: 'Bearer placeholder' }])
    expect(lines.join('\n')).not.toContain('placeholder')
    // GITHUB_TOKEN is read when GH_TOKEN is not set; with neither, the read is anonymous.
    seen.length = 0
    expect(await main([], { ...env, GITHUB_TOKEN: 'other' }, { log: () => {}, sleep: async () => {}, fetchImpl })).toBe(1)
    expect(await main([], env, { log: () => {}, sleep: async () => {}, fetchImpl })).toBe(1)
    expect(seen.map((s) => s.auth)).toEqual(['Bearer other', undefined])
  })
})
