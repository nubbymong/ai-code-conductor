import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

/**
 * The parts of probe P19's recorder (helper/probes/p19-record.cjs; ADR-030,
 * plan 2.1.3-beta.11 section A1, and its second run, plan 2.1.3-beta.12
 * section A2) that decide something without a real program: which processes
 * its clean-up may stop, the verdict lines (rows, modes, console hosts, the
 * Codex background server row), the modes comparison, a record-only state,
 * the console host counts, and the digests that name the code behind a
 * reading. The probe itself is a measurement, run on the test machine and by
 * the dispatch-only probe-p19 job, not here.
 *
 * Not checked here: the process listing itself (Win32_Process through
 * PowerShell, `ps -A`), stopChecked's second look at a pid before it stops
 * one, two processes that start in the same millisecond, the real clock
 * behind the console host counts, and which sequences a real CLI writes.
 */

const PROBES = resolve(__dirname, '../../../helper/probes')
const req = createRequire(join(PROBES, 'p19-record.cjs'))
// The pinned @xterm/headless of the checkout, as the probe loads it.
const { Terminal } = createRequire(resolve(__dirname, '../../../package.json'))('@xterm/headless') as {
  Terminal: new (o: Record<string, unknown>) => { write: (d: string, cb?: () => void) => void; dispose: () => void }
}
type Proc = { pid: number; ppid: number; start: string; startMs: number | null; name: string }
type Known = Proc & { endMs?: number | null }
type Modes = Record<string, string | boolean>
type Step = { equal: boolean; buffers: [string, string]; modes?: { pane1: Modes; pane2: Modes; differ: string[] } }
type State = { state: string; launch?: string; recordOnly?: boolean; reached: boolean; why?: string; screen?: string; steps: Step[] }
type Reading = { id?: string; states: State[]; requests?: Array<{ reply: string; done: boolean; closed: boolean }>; exit?: { code: number } | null }
type HostCount = { s: number; n: number }
const P = req('./p19-record.cjs') as {
  ownedProcesses: (list: { self: number; procs: Proc[] }, known: Map<number, Known>, skip: Set<number>, window?: { from: number; to: number }) => Proc[]
  verdictFor: (prog: { verdict: boolean }, readings: Reading[], runs: number) => { verdict: string; summary: string; recorded: Array<{ state: string; verdict: string }> }
  codeDigests: (scenarioFile: string) => { record: string; standIn: string; scenarios: string }
  recordingHeader: (ctx: unknown, prog: unknown, mode: unknown, launch: unknown, k: number) => Record<string, unknown>
  compareModes: (a: Modes, b: Modes) => string[]
  modesOf: (term: unknown) => Modes
  measure: (ctx: unknown, run: unknown, step: { state: string; recordOnly?: boolean }) => Promise<Record<string, unknown> & { steps: Array<{ step: string; modes: { differ: string[] } }> }>
  consoleHostCounts: (exitAt: number, list: (at: number) => Promise<Proc[]>, waitUntil: (at: number) => Promise<void>) => Promise<HostCount[]>
  consoleHostVerdict: (readings: Array<{ consoleHosts: { counted: boolean; at: HostCount[] } | null }>) => { verdict: string; line: string }
  CONSOLE_HOST_TIMES: number[]
  modeVerdicts: (prog: { verdict: boolean }, readings: Reading[], runs: number) => Array<{ mode: string; verdict: string; alreadyEqualBeforeAnyResize: string[] }> | null
  turnVerdict: (readings: Reading[]) => string
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

  it('gives a row that runs another CLI (`cli`) that CLI\'s version', () => {
    const ctx = { scenario: { size: { cols: 120, rows: 40 } }, versions: { codex: '0.170.0' }, system: { label: 'a test' }, files: {} }
    expect(P.recordingHeader(ctx, { id: 'codex-daemon', cli: 'codex', name: 'B' }, { id: 'pty' }, { id: 'short' }, 1).version).toBe('0.170.0')
  })
})

/** Two headless panes, each fed its own text, read once they have parsed it. */
async function panes(a: string, b: string) {
  const make = (text: string) => new Promise<InstanceType<typeof Terminal>>((done) => {
    const t = new Terminal({ cols: 20, rows: 5, allowProposedApi: true })
    t.write(text, () => done(t))
  })
  return Promise.all([make(a), make(b)])
}

describe('P19 recorder, second run: the modes of the two panes', () => {
  it('names each mode two panes differ in, the screen in use among them', async () => {
    // Pane 1 saw the program set the alternate screen and bracketed paste;
    // pane 2, fed from a cut after them, saw only the text.
    const [p1, p2] = await panes('\x1b[?1049h\x1b[?2004hhello', 'hello')
    try {
      expect(P.modesOf(p1)).toMatchObject({ screen: 'alternate', bracketedPasteMode: true, mouseTrackingMode: 'none' })
      expect(P.modesOf(p2)).toMatchObject({ screen: 'normal', bracketedPasteMode: false })
      expect(P.compareModes(P.modesOf(p1), P.modesOf(p2))).toEqual(['screen', 'bracketedPasteMode'])
    } finally { p1.dispose(); p2.dispose() }
  })

  it('names mouse reporting, application cursor keys, the keypad and focus reporting when only one pane has them', async () => {
    const [p1, p2] = await panes('\x1b[?1000h\x1b[?1h\x1b=\x1b[?1004h', '')
    try {
      expect(P.compareModes(P.modesOf(p1), P.modesOf(p2)).sort()).toEqual(['applicationCursorKeysMode', 'applicationKeypadMode', 'mouseTrackingMode', 'sendFocusMode'])
    } finally { p1.dispose(); p2.dispose() }
  })

  it('is silent when the panes agree, even on modes that are set', async () => {
    const [p1, p2] = await panes('\x1b[?1049h\x1b[?2004h\x1b[?1002h', '\x1b[?1049h\x1b[?2004h\x1b[?1002h')
    try {
      expect(P.compareModes(P.modesOf(p1), P.modesOf(p2))).toEqual([])
    } finally { p1.dispose(); p2.dispose() }
  })

  it('reads every field xterm.js lists in `modes`, beside the screen', async () => {
    const [p1] = await panes('', '')
    try {
      const keys = Object.keys(P.modesOf(p1))
      expect(keys[0]).toBe('screen')
      expect(keys.slice(1)).toEqual(Object.keys((p1 as unknown as { modes: object }).modes).sort())
    } finally { p1.dispose() }
  })
})

describe('P19 recorder, second run: a record-only state', () => {
  const scenario = { size: { cols: 20, rows: 5 }, recordOnlyMs: 300, cutBytes: 64, settleMs: 40, sampleMs: 10, nudgeMs: 10, tailLines: 5 }
  const setup = () => {
    const resizes: Array<[number, number]> = []
    const ctx = { scenario, newPane: () => new Terminal({ cols: 20, rows: 5, scrollback: 10, allowProposedApi: true }) }
    // fd -1: the recorder's writes fail and are dropped, as it allows.
    const run = { t0: Date.now(), total: 0, chunks: [], pane1: ctx.newPane(), pane2: null, launch: 'short', fd: -1, events: [] as Array<{ ev: string }>, notes: [], pty: { resize: (c: number, r: number) => { resizes.push([c, r]) } } }
    return { ctx, run, resizes }
  }

  it('takes no resize step and no second pane, and closes its recording 300 ms after its mark', async () => {
    const { ctx, run, resizes } = setup()
    try {
      const t = Date.now()
      const s = await P.measure(ctx, run, { state: 'mid-reply', recordOnly: true })
      expect(Date.now() - t).toBeGreaterThanOrEqual(290)
      expect(resizes).toEqual([])
      expect(s).toMatchObject({ state: 'mid-reply', launch: 'short', recordOnly: true, reached: true, steps: [] })
      expect(run.pane2).toBeNull()
      expect(run.events.map((e) => e.ev)).toEqual(['mark', 'mark-end'])
    } finally { run.pane1.dispose() }
  })

  it('while a measured state takes the same-size resize and the nudge, and records the modes at each step', async () => {
    const { ctx, run, resizes } = setup()
    try {
      const s = await P.measure(ctx, run, { state: 'ready' })
      expect(resizes).toEqual([[20, 5], [20, 4], [20, 5]])
      expect(s.steps.map((x) => x.step)).toEqual(['nothing', 'same size', 'nudge'])
      for (const x of s.steps) expect(x.modes.differ).toEqual([])
      expect(s.modesAtMark).toBeDefined()
      expect(run.events.map((e) => e.ev)).toEqual(['mark', 'resize', 'resize', 'resize', 'mark-end'])
    } finally { run.pane1.dispose() }
  })
})

describe('P19 recorder, second run: the console hosts after a program\'s end', () => {
  const EXIT = Date.parse('2026-11-20T12:00:00.000Z')
  const p = (pid: number, name: string): Proc => ({ pid, ppid: 1, start: '', startMs: 0, name })

  it('counts them 1, 2, 5, 10, 30 and 60 s after the exit, from the list each time gives', async () => {
    expect(P.CONSOLE_HOST_TIMES).toEqual([1, 2, 5, 10, 30, 60])
    const byTime: Record<number, Proc[]> = {
      1: [p(11, 'conhost.exe'), p(13, 'OpenConsole.exe'), p(15, 'claude.exe')],
      2: [p(11, 'conhost.exe'), p(17, 'conhost-helper.exe')],
      5: [p(11, 'CONHOST.EXE')],
      10: [],
      30: [p(19, 'node.exe')],
      60: [],
    }
    const waited: number[] = []
    const asked: number[] = []
    const counts = await P.consoleHostCounts(EXIT, async (at) => { asked.push(at); return byTime[(at - EXIT) / 1000] }, async (at) => { waited.push(at) })
    const times = [1, 2, 5, 10, 30, 60].map((s) => EXIT + s * 1000)
    expect(waited).toEqual(times)
    expect(asked.sort((a, b) => a - b)).toEqual(times)
    expect(counts.map((c) => [c.s, c.n])).toEqual([[1, 2], [2, 1], [5, 1], [10, 0], [30, 0], [60, 0]])
  })

  const run = (...n: number[]) => ({ consoleHosts: { counted: true, at: [1, 2, 5, 10, 30, 60].map((s, i) => ({ s, n: n[i] })) } })
  it('reads ENDS BY ITSELF when none is left 10 s after the exit in every run', () => {
    expect(P.consoleHostVerdict([run(1, 1, 0, 0, 0, 0), run(0, 0, 0, 0, 0, 0)]).verdict).toBe('ENDS BY ITSELF')
  })
  it('reads STAYS when one is left at 60 s in any run', () => {
    expect(P.consoleHostVerdict([run(1, 1, 1, 0, 0, 0), run(1, 1, 1, 1, 1, 1)]).verdict).toBe('STAYS')
  })
  it('reads IN BETWEEN when one is left at 10 s but none at 60 s, with its times', () => {
    const v = P.consoleHostVerdict([run(1, 1, 1, 1, 0, 0), run(0, 0, 0, 0, 0, 0)])
    expect(v.verdict).toBe('IN BETWEEN')
    expect(v.line).toBe('IN BETWEEN (runs with one left, of 2: 1 s: 1, 2 s: 1, 5 s: 1, 10 s: 1, 30 s: 0, 60 s: 0)')
  })
  it('counts no run whose six readings were not all taken', () => {
    expect(P.consoleHostVerdict([{ consoleHosts: { counted: false, at: [] } }, { consoleHosts: null }]).verdict).toBe('NOT COUNTED')
  })
})

describe('P19 recorder, second run: the verdicts', () => {
  const modes = (screen: string, paste: boolean): Modes => ({ screen, bracketedPasteMode: paste })
  const step = (p1: Modes, p2: Modes): Step => ({ equal: true, buffers: ['alternate', 'alternate'], modes: { pane1: p1, pane2: p2, differ: Object.keys(p1).filter((k) => p1[k] !== p2[k]) } })
  const ALT = modes('alternate', true)
  // A state where pane 2 lost the screen and bracketed paste before any
  // resize and, after the nudge, got the screen back but not the paste mode.
  const lostPaste = (state: string): State => ({ state, reached: true, steps: [step(ALT, modes('normal', false)), step(ALT, modes('normal', false)), step(ALT, modes('alternate', false))] })
  const kept = (state: string): State => ({ state, reached: true, steps: [step(ALT, ALT), step(ALT, ALT), step(ALT, ALT)] })
  const three = (...states: State[]) => [1, 2, 3].map(() => ({ states }))

  it('reads a mode LOST where the panes differ after the nudge in 2 of 3 or more, and KEPT where they agree in 3 of 3 at every state', () => {
    const v = P.modeVerdicts({ verdict: true }, three(kept('first-screen'), lostPaste('ready')), 3)!
    expect(v.map((m) => [m.mode, m.verdict])).toEqual([
      ['screen', 'KEPT'],
      ['bracketedPasteMode', 'LOST - ready differs after the nudge in 3 of 3'],
    ])
    // Beside it: where it was already equal before any resize.
    expect(v.map((m) => m.alreadyEqualBeforeAnyResize)).toEqual([['first-screen'], ['first-screen']])
  })

  it('reads NO VERDICT when they differ in 1 of 3, and CHECK RUN for another number of runs', () => {
    const mixed = [{ states: [lostPaste('ready')] }, { states: [kept('ready')] }, { states: [kept('ready')] }]
    expect(P.modeVerdicts({ verdict: true }, mixed, 3)!.find((m) => m.mode === 'bracketedPasteMode')!.verdict).toBe('NO VERDICT - ready: equal after the nudge in 2 of 3 reached')
    expect(P.modeVerdicts({ verdict: true }, [{ states: [kept('ready')] }], 1)!.find((m) => m.mode === 'screen')!.verdict).toBe('CHECK RUN (1 runs; would read KEPT)')
    expect(P.modeVerdicts({ verdict: false }, mixed, 3)).toBeNull()
  })

  it('leaves record-only states out of the rows verdict and lists each as RECORDED or NOT REACHED', () => {
    const at = (state: string): State => ({ state, launch: 'turn', reached: true, steps: [{ equal: false, buffers: ['alternate', 'alternate'] }, { equal: false, buffers: ['alternate', 'alternate'] }, { equal: true, buffers: ['alternate', 'alternate'] }] })
    const readings = [1, 2, 3].map(() => ({ states: [at('ready'), { state: 'mid-reply', launch: 'short', recordOnly: true, reached: true, steps: [] }] }))
    readings.push({ states: [{ state: 'agents-hint', launch: 'agents', recordOnly: true, reached: false, why: 'the agents form was not shown within 60000 ms', screen: '> Ask Codex', steps: [] }] })
    const v = P.verdictFor({ verdict: true }, readings, 3)
    expect(v.verdict).toBe('REPAINTS; a same-size resize was enough at no state; recorded only: mid-reply RECORDED in 3 of 3, agents-hint NOT REACHED - the agents form was not shown within 60000 ms')
  })

  it('names a state by its launch as well when two launches measure a state of that name', () => {
    const st = (launch: string): State => ({ ...kept('after-reply'), launch })
    const v = P.verdictFor({ verdict: true }, [1, 2, 3].map(() => ({ states: [st('turn'), st('short')] })), 3)
    expect(v.summary).toBe('after-reply (turn): nudge 3/3, same size 3/3, nothing 3/3; after-reply (short): nudge 3/3, same size 3/3, nothing 3/3')
  })

  it('reads the background server row RUNS A TURN only when every run finished its turn, else FAILS with the screen', () => {
    const ok = { id: 'a', requests: [{ reply: 'turn', done: true, closed: false }], states: [{ state: 'after-reply', reached: true, steps: [] }], exit: { code: 0 } }
    expect(P.turnVerdict([ok])).toBe('RUNS A TURN (1 of 1 runs)')
    const failed = { id: 'b', requests: [], states: [{ state: 'ready', reached: false, why: 'the ready composer was not shown within 60000 ms', screen: 'Error: the background server\n\nis refused', steps: [] }], exit: { code: 1 } }
    expect(P.turnVerdict([ok, failed])).toBe('FAILS - the ready composer was not shown within 60000 ms; the screen: Error: the background server | is refused; exit code 1')
  })
})
