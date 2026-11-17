/**
 * [host] The performance harness's plan and set-up (scripts/perf):
 * run-matrix.cjs's options (every one checked before anything starts), the
 * grid it plans (the ablations bracketed by two all-on runs) and its length;
 * gen-sessions.cjs's sessions (copies with their own ids, conversations and
 * transcripts), its atomic writes, and the start state it keeps and puts back
 * before every run; load-sidecar.cjs's options and transcript lines.
 *
 * Pure functions, except one case that sets a staging layout up in its own
 * temp folder (removed after): nothing is started and nothing outside that
 * folder is written.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { createRequire } from 'module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync, rmSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const PERF = resolve(__dirname, '..', '..', '..', 'scripts', 'perf')
const req = createRequire(join(PERF, 'run-matrix.cjs'))
type Phase = { tag: string; mode: string; settle: number; window: number; profile: number; ab: number }
type Run = { id: string; kind: string; n: number; off: string; phases: Phase[] }
type Opts = Record<string, unknown> & { ns: number[]; ablate: string[]; ablateN: number; modeSettle: number; ablateSettle: number; settle: number; interval: number }
const M = req('./run-matrix.cjs') as {
  parseOptions: (argv: string[]) => Opts
  planMatrix: (o: Opts) => Run[]
  planSeconds: (runs: Run[], o: Opts) => number
  writerSeconds: (run: Run, from: number, o: Opts) => number
}
type Session = { id: string; label?: string; customName?: string; resumeUuid: string; resumeCwd?: string; workingDirectory?: string; claudeOptions?: Record<string, unknown>; shellOnly?: boolean }
const Gs = req('./gen-sessions.cjs') as {
  planSessions: (templates: Session[], n: number) => Array<{ session: Session; from: string | null }>
  claudeTemplates: (sessions: unknown[]) => Session[]
  sessionIdFor: (i: number) => string
  uuidFor: (i: number) => string
  writeJsonAtomic: (file: string, value: unknown, fsx?: unknown) => void
  generate: (argv: string[], stage: Record<string, string>) => string[]
}
const L = req('./load-sidecar.cjs') as {
  parseSidecarOptions: (argv: string[]) => { everyMs: number; seconds: number; exitOnStdinClose: boolean }
  assistantLine: (s: { cwd: string; resumeUuid: string }, parentUuid: string | null, n: number) => Record<string, any>
}
const S = createRequire(join(PERF, '..', 'readme-shots', 'stage', 'stage-root.js'))('./stage-root.js') as { MARKER: string; MARKER_TEXT: string }

describe("the runner's options", () => {
  it('has the plan\'s defaults: 5 min settles, 3 min windows, the three ablations at N=25', () => {
    const o = M.parseOptions([])
    expect(o.ns).toEqual([1, 10, 25])
    expect([o.settle, o.window, o.modeSettle, o.ablateSettle, o.interval]).toEqual([300, 180, 300, 300, 5])
    expect(o.ablate).toEqual(['tokenomics', 'logging', 'hooks'])
    expect(o.ablateN).toBe(25)
  })

  it.each([
    [['--n', '0'], /--n: 0 is not a whole number from 1 to 60/],
    [['--n', '2.5'], /--n: 2.5/],
    [['--n', '61'], /--n: 61/],
    [['--interval', '0'], /--interval must be a whole number of at least 1/],
    [['--interval', '1.5'], /--interval must be a whole number/],
    [['--ablate', 'tokenomic'], /--ablate: tokenomic is not one of none, tokenomics, logging, hooks/],
    [['--window', '5'], /must hold at least two --interval/],
    [['--setle', '30'], /unknown option --setle/],
    [['--n'], /--n needs a value/],
    [['--n', '--dry-run'], /--n needs a value/],
    [['--sidecar-ms', '100'], /--sidecar-ms must be a number of at least 200/],
    [['--settle', 'soon'], /--settle must be a number/],
    [['--ablate-n', '99'], /--ablate-n: 99/],
  ])('refuses %j before anything starts', (argv, message) => {
    expect(() => M.parseOptions(argv as string[])).toThrow(message as RegExp)
  })
})

describe('the planned grid', () => {
  const o = M.parseOptions([])

  it('runs idle then busy for each N, with profiles and the A/B/A at N=25 only', () => {
    const runs = M.planMatrix(o).filter((r) => r.kind === 'grid')
    expect(runs.map((r) => r.id)).toEqual(['n1', 'n10', 'n25'])
    expect(runs[0].phases.map((p) => [p.tag, p.mode, p.settle, p.window, p.profile, p.ab])).toEqual([['n1-idle', 'idle', 300, 180, 0, 0], ['n1-busy', 'busy', 300, 180, 0, 0]])
    expect(runs[2].phases.map((p) => [p.profile, p.ab])).toEqual([[60, 60], [60, 60]])
  })

  it('brackets the ablations with two all-on runs, so their spread is the noise', () => {
    const abl = M.planMatrix(o).filter((r) => r.kind === 'ablation')
    expect(abl.map((r) => [r.id, r.off, r.n])).toEqual([
      ['n25-off-none', 'none', 25], ['n25-off-tokenomics', 'tokenomics', 25], ['n25-off-logging', 'logging', 25], ['n25-off-hooks', 'hooks', 25], ['n25-off-none-again', 'none', 25],
    ])
    expect(abl.map((r) => r.phases[0].tag)).toEqual(['n25-busy-off-none', 'n25-busy-off-tokenomics', 'n25-busy-off-logging', 'n25-busy-off-hooks', 'n25-busy-off-none-again'])
    expect(new Set(M.planMatrix(o).flatMap((r) => r.phases.map((p) => p.tag))).size).toBe(11)
  })

  it('skips the ablations with --ablate none, and tells its length', () => {
    const none = M.parseOptions(['--ablate', 'none'])
    expect(M.planMatrix(none).some((r) => r.kind === 'ablation')).toBe(false)
    const full = M.planSeconds(M.planMatrix(o), o)
    expect(M.planSeconds(M.planMatrix(none), none)).toBeLessThan(full)
    expect(Math.round(full / 60)).toBeGreaterThan(90)
    expect(Math.round(full / 60)).toBeLessThan(130)
  })

  it("keeps the transcript writer running for the rest of a run's phases", () => {
    const [n1] = M.planMatrix(o)
    expect(M.writerSeconds(n1, 1, o)).toBe(300 + 180)
    const n25 = M.planMatrix(o).find((r) => r.id === 'n25')!
    expect(M.writerSeconds(n25, 1, o)).toBe(300 + 180 + 60 + 10 + 15 + 3 * 60 + 10)
  })
})

describe('the sessions gen-sessions writes', () => {
  const T = (i: number): Session => ({ id: `seed${i}`, label: `seed ${i}`, resumeUuid: `0000000${i}-aaaa-4bbb-8ccc-dddddddddddd`, resumeCwd: `C:\\dev\\p${i}`, claudeOptions: { model: 'fable' } })

  it('keeps only Claude sessions with a conversation as templates', () => {
    const list = [T(1), { ...T(2), shellOnly: true }, { ...T(3), claudeOptions: undefined }, { ...T(4), resumeUuid: '' }, null, T(5)]
    expect(Gs.claudeTemplates(list).map((s) => s.id)).toEqual(['seed1', 'seed5'])
  })

  it('writes N sessions: the templates, then copies with their own ids and conversations, each pointing at its template', () => {
    const plan = Gs.planSessions([T(1), T(2), T(3), T(4)], 25)
    expect(plan).toHaveLength(25)
    expect(plan.slice(0, 4).map((p) => [p.session.id, p.from])).toEqual([['seed1', null], ['seed2', null], ['seed3', null], ['seed4', null]])
    const copies = plan.slice(4)
    expect(copies.every((p, i) => p.from === T(((i + 4) % 4) + 1).resumeUuid)).toBe(true)
    expect(new Set(plan.map((p) => p.session.id)).size).toBe(25)
    expect(new Set(plan.map((p) => p.session.resumeUuid)).size).toBe(25)
    expect(copies[0].session.customName).toBe('seed 1 5')
    for (const p of copies) {
      expect(p.session.resumeUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(p.session.id).toMatch(/^[0-9a-f]{24}$/)
    }
    expect([Gs.uuidFor(7), Gs.sessionIdFor(7)]).toEqual([Gs.uuidFor(7), Gs.sessionIdFor(7)])
    expect(() => Gs.planSessions([], 3)).toThrow(/no Claude session/)
  })

  it('writes JSON through a temporary file and a rename, trying again while the file is held', () => {
    const calls: string[] = []
    let held = 2
    const fsx = {
      writeFileSync: (p: string) => { calls.push('write ' + p) },
      renameSync: (a: string, b: string) => { calls.push(`rename ${a} -> ${b}`); if (held-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' }) },
    }
    Gs.writeJsonAtomic('C:\\x\\fake-stage.json', { mode: 'idle' }, fsx)
    const tmp = `C:\\x\\fake-stage.json.${process.pid}.tmp`
    expect(calls).toEqual([`write ${tmp}`, `rename ${tmp} -> C:\\x\\fake-stage.json`, `rename ${tmp} -> C:\\x\\fake-stage.json`, `rename ${tmp} -> C:\\x\\fake-stage.json`])
    const fails = { writeFileSync: () => undefined, renameSync: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) } }
    expect(() => Gs.writeJsonAtomic('C:\\x\\y.json', {}, fails)).toThrow(/gone/)
  })
})

describe('the start state every run is put back to', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-perf-gen-'))
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })
  const stage = { ROOT: root, DATA: join(root, 'data'), RES: join(root, 'data', 'resources'), HOME: join(root, 'data', 'home'), NPM_BIN: join(root, 'data', 'fake-bin'), RUNNER: join(root, 'runner') }
  const U1 = '6d3f2a41-8c9e-4b17-9f52-0a1b2c3d4e5f'
  const projects = join(stage.HOME, '.claude', 'projects', 'C--dev-web')
  const transcript = (uuid: string) => join(projects, `${uuid}.jsonl`)
  const write = (p: string, text: string) => { mkdirSync(resolve(p, '..'), { recursive: true }); writeFileSync(p, text) }
  write(join(root, S.MARKER), S.MARKER_TEXT)
  write(join(stage.RES, 'CONFIG', 'session-state.json'), JSON.stringify({ sessions: [{ id: 's1', label: 'web', resumeUuid: U1, resumeCwd: 'C:\\dev\\web', claudeOptions: { model: 'fable' } }, { id: 't1', label: 'shell', shellOnly: true }] }))
  write(join(stage.RES, 'CONFIG', 'settings.json'), '{}')
  write(join(stage.NPM_BIN, 'fake-stage.json'), JSON.stringify({ statusDir: 'S', home: 'H' }))
  write(transcript(U1), `{"sessionId":"${U1}","n":1}\n`)
  write(join(stage.DATA, 'transcripts.db'), 'as seeded')

  it('keeps it on the first run and puts the transcripts and databases back on every later one', () => {
    Gs.generate(['--n', '3', '--mode', 'idle', '--off', 'none'], stage)
    const copy1 = transcript(Gs.uuidFor(1))
    expect(readFileSync(copy1, 'utf8')).toBe(`{"sessionId":"${Gs.uuidFor(1)}","n":1}\n`)
    expect(existsSync(transcript(Gs.uuidFor(2)))).toBe(true)
    // The run's writer grows the transcripts; the app fills its databases.
    appendFileSync(transcript(U1), '{"grown":1}\n')
    appendFileSync(copy1, '{"grown":1}\n')
    writeFileSync(join(stage.DATA, 'transcripts.db'), 'grown')
    writeFileSync(join(stage.DATA, 'tokenomics.db'), 'grown')
    writeFileSync(join(stage.DATA, 'tokenomics.db-wal'), 'grown')

    Gs.generate(['--n', '2', '--off', 'tokenomics'], stage)
    expect(readFileSync(transcript(U1), 'utf8')).toBe(`{"sessionId":"${U1}","n":1}\n`)
    expect(readFileSync(copy1, 'utf8')).toBe(`{"sessionId":"${Gs.uuidFor(1)}","n":1}\n`)
    // N=2 has one copy: the other run's second copy is gone with its transcript.
    expect(existsSync(transcript(Gs.uuidFor(2)))).toBe(false)
    expect(readFileSync(join(stage.DATA, 'transcripts.db'), 'utf8')).toBe('as seeded')
    expect(existsSync(join(stage.DATA, 'tokenomics.db'))).toBe(false)
    expect(existsSync(join(stage.DATA, 'tokenomics.db-wal'))).toBe(false)
    const fake = JSON.parse(readFileSync(join(stage.NPM_BIN, 'fake-stage.json'), 'utf8'))
    expect(fake).toEqual({ statusDir: 'S', home: 'H', mode: 'idle', copies: { [Gs.uuidFor(1)]: U1 } })
    expect(JSON.parse(readFileSync(join(stage.RES, 'CONFIG', 'settings.json'), 'utf8'))).toEqual({ tokenomicsEnabled: false, loggingEnabled: true, hooksEnabled: true })
    expect(JSON.parse(readFileSync(join(stage.RES, 'CONFIG', 'session-state.json'), 'utf8')).sessions.map((s: Session) => s.id)).toEqual(['s1', Gs.sessionIdFor(1)])
    // Every write went through a rename: no temporary file is left.
    expect(readdirSync(stage.NPM_BIN).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('refuses a root an older harness set up (no kept start state)', () => {
    unlinkSync(join(stage.RUNNER, 'perf-pristine', '.done'))
    expect(() => Gs.generate(['--n', '2'], stage)).toThrow(/older harness/)
  })

  it('refuses a mode, a service or a count it does not know, writing nothing', () => {
    expect(() => Gs.generate(['--mode', 'asleep'], stage)).toThrow(/--mode is idle or busy/)
    expect(() => Gs.generate(['--off', 'watchdog'], stage)).toThrow(/--off is none, tokenomics, logging, hooks/)
    expect(() => Gs.generate(['--n', '0'], stage)).toThrow(/--n is a whole number from 1 to 60/)
  })
})

describe("the transcript writer's options and lines", () => {
  it('refuses a value that is not a number or is below its floor, instead of hammering the files', () => {
    expect(L.parseSidecarOptions([])).toEqual({ everyMs: 5000, seconds: 0, exitOnStdinClose: false })
    expect(L.parseSidecarOptions(['--every-ms', '250', '--seconds', '900', '--exit-on-stdin-close'])).toEqual({ everyMs: 250, seconds: 900, exitOnStdinClose: true })
    expect(() => L.parseSidecarOptions(['--every-ms', 'fast'])).toThrow(/--every-ms must be a number of at least 200, not fast/)
    expect(() => L.parseSidecarOptions(['--every-ms', '100'])).toThrow(/at least 200/)
    expect(() => L.parseSidecarOptions(['--seconds', '-1'])).toThrow(/--seconds must be a number of at least 0/)
    expect(() => L.parseSidecarOptions(['--seconds'])).toThrow(/--seconds/)
  })

  it("writes an assistant line in Claude Code's shape, chained to the one before", () => {
    const s = { cwd: 'C:\\dev\\web', resumeUuid: '6d3f2a41-8c9e-4b17-9f52-0a1b2c3d4e5f' }
    const a = L.assistantLine(s, null, 1)
    const b = L.assistantLine(s, a.uuid, 2)
    expect([a.type, a.sessionId, a.cwd, a.parentUuid, b.parentUuid]).toEqual(['assistant', s.resumeUuid, s.cwd, null, a.uuid])
    expect(a.uuid).not.toBe(b.uuid)
    for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) expect(Number.isInteger(a.message.usage[k])).toBe(true)
    expect(a.message.content[0].text).toContain('step 1')
  })
})
