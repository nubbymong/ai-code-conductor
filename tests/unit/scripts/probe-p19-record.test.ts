import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

/**
 * The parts of probe P19's recorder (helper/probes/p19-record.cjs; ADR-030,
 * plan 2.1.3-beta.11 section A1) that decide something without a terminal:
 * which processes its clean-up may stop, the verdict line, and the digests
 * that name the code behind a reading. The probe itself is a measurement, run
 * on the test machine and by the dispatch-only probe-p19 job, not here.
 *
 * Not checked here: the process listing itself (Win32_Process through
 * PowerShell, `ps -A`), stopChecked's second look at a pid before it stops
 * one, and two processes that start in the same millisecond.
 */

const PROBES = resolve(__dirname, '../../../helper/probes')
const req = createRequire(join(PROBES, 'p19-record.cjs'))
type Proc = { pid: number; ppid: number; start: string; startMs: number | null; name: string }
type Known = Proc & { endMs?: number | null }
type Step = { equal: boolean; buffers: [string, string] }
type State = { state: string; reached: boolean; steps: Step[] }
const P = req('./p19-record.cjs') as {
  ownedProcesses: (list: { self: number; procs: Proc[] }, known: Map<number, Known>, skip: Set<number>) => Proc[]
  verdictFor: (prog: { verdict: boolean }, readings: Array<{ states: State[] }>, runs: number) => { verdict: string }
  codeDigests: (scenarioFile: string) => { record: string; standIn: string; scenarios: string }
  recordingHeader: (ctx: unknown, prog: unknown, mode: unknown, launch: unknown, k: number) => Record<string, unknown>
}

describe('P19 recorder: the clean-up stops only processes the probe started', () => {
  // Odd ids above 4,194,304: no Windows pid (a multiple of 4) and above Linux's
  // default pid_max, so none is this test's own process.
  const T = Date.parse('2026-11-19T12:00:00.000Z')
  const SELF = process.pid
  const LISTER = 7_000_001
  const [A, B, C, D, E, F, G, H, I, K, S] = [7_000_003, 7_000_005, 7_000_007, 7_000_009, 7_000_011, 7_000_013, 7_000_015, 7_000_017, 7_000_019, 7_000_021, 7_000_023]
  const proc = (pid: number, ppid: number, at: number | null, name = 'x.exe'): Proc => ({
    pid, ppid, name, start: at === null ? '' : new Date(T + at).toISOString(), startMs: at === null ? null : T + at,
  })
  const owned = (procs: Proc[], known = new Map<number, Known>(), skip = new Set<number>()) =>
    P.ownedProcesses({ self: LISTER, procs: [proc(SELF, 1, 0, 'node.exe'), proc(LISTER, SELF, 50, 'powershell.exe'), ...procs] }, known, skip)
      .map((p) => p.pid)
      .sort((x, y) => x - y)
  const ended = (pid: number, at: number, endAt: number | null): Map<number, Known> =>
    new Map([[pid, { ...proc(pid, SELF, at, 'cli.exe'), endMs: endAt === null ? null : T + endAt }]])

  it('takes a child of the probe that started after it, and that child\'s own children', () => {
    expect(owned([proc(A, SELF, 100), proc(B, A, 200)])).toEqual([A, B])
  })

  it('leaves out a process whose parent id is the probe\'s but which started before the probe, and what it started', () => {
    // Windows keeps a parent id after the parent ends, and the id is reused.
    expect(owned([proc(C, SELF, -100), proc(D, C, 300)])).toEqual([])
  })

  it('leaves out a child whose start time is not known', () => {
    expect(owned([proc(E, SELF, null)])).toEqual([])
  })

  it('leaves out a grandchild that started before the child it names as its parent', () => {
    expect(owned([proc(A, SELF, 100), proc(F, A, 50)])).toEqual([A])
  })

  it('takes an ended program\'s orphan only when it started while that program ran', () => {
    // G started while K ran; H before K started; I after K ended (K's id reused
    // by a process that has ended too).
    expect(owned([proc(G, K, 500), proc(H, K, 50), proc(I, K, 1500)], ended(K, 100, 1000))).toEqual([G])
  })

  it('follows no child of an ended program whose end was not seen', () => {
    expect(owned([proc(G, K, 500)], ended(K, 100, null))).toEqual([])
  })

  it('follows a program still running only while its id names the same process', () => {
    const known = ended(K, 100, null)
    expect(owned([proc(K, 1, 100, 'cli.exe'), proc(G, K, 500)], known)).toEqual([G])
    expect(owned([proc(K, 1, 2000, 'other.exe'), proc(G, K, 2500)], known)).toEqual([])
  })

  it('leaves out the process lister and a skipped process', () => {
    expect(owned([proc(S, SELF, 100)], new Map(), new Set([S]))).toEqual([])
  })
})

describe('P19 recorder: the verdict line', () => {
  const step = (equal: boolean): Step => ({ equal, buffers: ['alternate', 'alternate'] })
  const at = (state: string, nothing: boolean, sameSize: boolean, nudge: boolean): State => ({ state, reached: true, steps: [step(nothing), step(sameSize), step(nudge)] })
  const three = (...states: State[]) => [1, 2, 3].map(() => ({ states }))

  it('names each state where the rows already matched before any resize in every run', () => {
    const v = P.verdictFor({ verdict: true }, three(at('ready', false, false, true), at('after-reply', true, true, true)), 3)
    expect(v.verdict).toBe('REPAINTS; a same-size resize was enough at after-reply; already equal before any resize at after-reply')
  })

  it('names none when every state needed a resize, or matched before one in only some runs', () => {
    expect(P.verdictFor({ verdict: true }, three(at('ready', false, false, true), at('mid-reply', false, true, true)), 3).verdict)
      .toBe('REPAINTS; a same-size resize was enough at mid-reply')
    const mixed = [{ states: [at('ready', true, true, true)] }, { states: [at('ready', true, true, true)] }, { states: [at('ready', false, false, true)] }]
    expect(P.verdictFor({ verdict: true }, mixed, 3).verdict).toBe('REPAINTS; a same-size resize was enough at no state')
  })
})

describe('P19 recorder: a reading names the code that made it', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const lf = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')

  it('gives the sha256 of the recorder, the stand-in and the scenario file', () => {
    const scenarios = join(PROBES, 'p19-scenarios.json')
    expect(P.codeDigests(scenarios)).toEqual({
      record: sha(lf(join(PROBES, 'p19-record.cjs'))),
      standIn: sha(lf(join(PROBES, 'p19-model-stand-in.cjs'))),
      scenarios: sha(lf(scenarios)),
    })
  })

  it('reads each file with LF line ends, so a Windows checkout gives the same digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p19-digest-'))
    try {
      const file = join(dir, 'scenarios.json')
      writeFileSync(file, '{\r\n  "runs": 3\r\n}\r\n')
      expect(P.codeDigests(file).scenarios).toBe(sha('{\n  "runs": 3\n}\n'))
    } finally {
      if (dir.startsWith(join(tmpdir(), 'p19-digest-'))) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('puts the digests in each recording\'s header line', () => {
    const files = { record: 'r', standIn: 's', scenarios: 'n' }
    const ctx = { scenario: { size: { cols: 120, rows: 40 } }, versions: { cli: '1.0.0' }, system: { label: 'a test' }, files }
    const header = P.recordingHeader(ctx, { id: 'cli', name: 'A CLI' }, { id: 'pty' }, { id: 'turn' }, 2)
    expect(header).toMatchObject({ probe: 'P19', program: 'A CLI', version: '1.0.0', cols: 120, rows: 40, conpty: 'pty', launch: 'turn', run: 2, files })
  })
})
