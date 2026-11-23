import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { join, resolve } from 'path'

/**
 * The parts of probe P21 (helper/probes/p21-capture.cjs; ADR-030, plan
 * 2.1.3-beta.14 section C6) that decide something without a real screen: how
 * a picture the capture mode wrote is read, each run's outcome against what
 * Windows lists, and the verdicts over the runs (the decision lines in the
 * probe's header). The probe itself is a measurement, run on the Windows test
 * machine, not here.
 *
 * Not checked here: the helper's capture mode (helper/src/capture.rs and
 * helper/tests/capture.rs, in the Helper job), the PowerShell side
 * (p21-windows.ps1), the scheduled task and the scale change.
 */

const PROBES = resolve(__dirname, '../../../helper/probes')
const req = createRequire(join(PROBES, 'p21-capture.cjs'))
type Picture = { error?: string; width?: number; height?: number; bpp?: number; length?: number; allBlack?: boolean | null }
type Shown = { file: string; left: number; top: number; width: number; height: number; dpi: number; scale?: number; primary?: boolean; picture?: Picture }
type Run = { code: number | null; ms: number; hung?: boolean; stdout?: string; stderr?: string; displays?: Shown[]; files?: string[]; lineError?: string }
type Facts = { logonUi?: boolean; modes: Array<{ left: number; top: number; width: number; height: number; primary?: boolean }>; dpis: Array<{ left: number; top: number; dpi: number; primary?: boolean }> }
type V = { verdict: string; why: string; failures: string[] }
const P = req('./p21-capture.cjs') as {
  parseBmpHeader: (b: Buffer) => { error?: string; width?: number; height?: number; bpp?: number; bottomUp?: boolean; offset?: number }
  allBlack: (b: Buffer, offset: number) => boolean
  readPicture: (b: Buffer, w: number, h: number) => Picture
  judgeConsoleRun: (r: Run, f: Facts, boundMs?: number) => { ok: boolean; screenNotShown: boolean; failures: string[] }
  verdictConsole: (r: Run[], f: Facts) => V
  judgeSshRun: (r: Run) => { ok: boolean; failures: string[] }
  verdictSsh: (r: Run[]) => V
  mixedLine: (readings: Array<{ label: string; facts: Facts }>) => string
  verdictLines: (c: Array<{ label: string; facts: Facts; runs: Run[] }>, s: { label: string; facts: Facts; runs: Run[] } | null, why?: string, consoleWhy?: string, sshNotRunWhy?: string) => string[]
  factsLine: (r: { label: string; facts: Facts & { sessionId?: number; elevated?: boolean } }) => string
  checkLabel: (l: unknown) => string
  BOUND_MS: number
}

/** A BMP as the capture mode writes it: a 54-byte header, then 4 bytes a pixel, rows from the bottom. */
function bmp(width: number, height: number, fill: (i: number) => number[] = () => [10, 20, 30, 255]): Buffer {
  const b = Buffer.alloc(54 + width * height * 4)
  b.write('BM', 0, 'latin1')
  b.writeUInt32LE(b.length, 2)
  b.writeUInt32LE(54, 10)
  b.writeUInt32LE(40, 14)
  b.writeInt32LE(width, 18)
  b.writeInt32LE(height, 22)
  b.writeUInt16LE(1, 26)
  b.writeUInt16LE(32, 28)
  b.writeUInt32LE(width * height * 4, 34)
  for (let i = 0; i < width * height; i++) Buffer.from(fill(i)).copy(b, 54 + i * 4)
  return b
}

const FACTS: Facts = { logonUi: false, modes: [{ left: 0, top: 0, width: 8, height: 6, primary: true }], dpis: [{ left: 0, top: 0, dpi: 96, primary: true }] }
const picture = (w = 8, h = 6, fill?: (i: number) => number[]) => P.readPicture(bmp(w, h, fill), w, h)
const goodRun = (ms = 180): Run => ({
  code: 0,
  ms,
  stdout: '{"displays":[...]}\n',
  stderr: '',
  displays: [{ file: 'display-1.bmp', left: 0, top: 0, width: 8, height: 6, dpi: 96, scale: 100, primary: true, picture: picture() }],
  files: ['display-1.bmp'],
})
const cleanSsh = (): Run => ({ code: 3, ms: 40, stdout: '', stderr: 'aicc-helper: capture: no desktop to capture: this process runs on a window station no display shows\n', files: [] })

describe('P21: reading a picture', () => {
  it('reads the header the capture mode writes', () => {
    const h = P.parseBmpHeader(bmp(8, 6))
    expect(h).toMatchObject({ width: 8, height: 6, bpp: 32, bottomUp: true, offset: 54 })
    expect(P.parseBmpHeader(Buffer.alloc(10)).error).toMatch(/shorter/)
    expect(P.parseBmpHeader(Buffer.alloc(60)).error).toMatch(/not a BMP/)
  })

  it('counts a picture all black only when every colour byte is 0, whatever the fourth byte', () => {
    expect(P.allBlack(bmp(4, 4, () => [0, 0, 0, 255]), 54)).toBe(true)
    expect(P.allBlack(bmp(4, 4, (i) => (i === 15 ? [0, 0, 1, 255] : [0, 0, 0, 255])), 54)).toBe(false)
    expect(picture(8, 6, () => [0, 0, 0, 255]).allBlack).toBe(true)
    expect(picture().allBlack).toBe(false)
    expect(picture().length).toBe(54 + 8 * 6 * 4)
  })
})

describe('P21: one console run against what Windows lists', () => {
  it('passes a run that wrote every display at its size and DPI, in time, with real pixels', () => {
    expect(P.judgeConsoleRun(goodRun(), FACTS)).toEqual({ ok: true, screenNotShown: false, failures: [] })
  })

  it('fails a run over the 2 s bound, and only over it', () => {
    expect(P.BOUND_MS).toBe(2000)
    expect(P.judgeConsoleRun(goodRun(2000), FACTS).ok).toBe(true)
    const slow = P.judgeConsoleRun(goodRun(2001), FACTS)
    expect(slow.ok).toBe(false)
    expect(slow.failures.join(' ')).toMatch(/took 2001 ms, over 2000 ms/)
  })

  it('fails a run whose exit, size, DPI, pixels or files are wrong, naming each', () => {
    const cases: Array<[string, (r: Run) => void, RegExp]> = [
      ['exit 1', (r) => { r.code = 1; r.stderr = 'aicc-helper: capture failed: BitBlt: denied\n' }, /exit 1: aicc-helper: capture failed: BitBlt/],
      ['hung', (r) => { r.hung = true; r.code = null }, /hung/],
      ['a smaller line', (r) => { r.displays![0].width = 6 }, /the line says 6 by 6, Windows 8 by 6/],
      ['another DPI', (r) => { r.displays![0].dpi = 120 }, /the line says 120 DPI, Windows 96/],
      ['a black picture', (r) => { r.displays![0].picture = picture(8, 6, () => [0, 0, 0, 255]) }, /every pixel is black/],
      ['a picture of another size', (r) => { r.displays![0].picture = picture(6, 6) }, /the picture is 6 by 6/],
      ['a file that is not a BMP', (r) => { r.displays![0].picture = { error: 'not a BMP file (no BM)' } }, /not a BMP/],
      ['an extra file', (r) => { r.files = ['display-1.bmp', 'display-2.bmp'] }, /the folder holds display-1.bmp, display-2.bmp/],
      ['no line', (r) => { r.displays = undefined; r.lineError = 'Unexpected end of JSON input' }, /no line it could read/],
      ['a display missing', (r) => { r.displays = [] ; r.files = [] }, /the line names 0 displays, Windows lists 1/],
    ]
    for (const [name, change, failure] of cases) {
      const run = goodRun()
      change(run)
      const j = P.judgeConsoleRun(run, FACTS)
      expect(j.ok, name).toBe(false)
      expect(j.failures.join(' | '), name).toMatch(failure)
    }
  })

  it('a locked screen is not a failure of the mode: the run cannot be measured', () => {
    const j = P.judgeConsoleRun({ ...goodRun(), code: 3, displays: undefined, files: [] }, { ...FACTS, logonUi: true })
    expect(j).toMatchObject({ ok: false, screenNotShown: true })
  })
})

describe('P21: the console verdict over the runs', () => {
  it('reads CAPTURES only for 3 of 3 good runs, with the time range', () => {
    const v = P.verdictConsole([goodRun(120), goodRun(300), goodRun(150)], FACTS)
    expect(v.verdict).toBe('CAPTURES')
    expect(v.why).toBe('3 of 3 runs, 120 to 300 ms')
  })

  it('reads DOES NOT CAPTURE when one run fails, and names it', () => {
    const bad = goodRun()
    bad.displays![0].picture = picture(8, 6, () => [0, 0, 0, 255])
    const v = P.verdictConsole([goodRun(), bad, goodRun()], FACTS)
    expect(v.verdict).toBe('DOES NOT CAPTURE')
    expect(v.failures).toEqual(['run 2: display-1.bmp: every pixel is black'])
  })

  it('reads CANNOT MEASURE for fewer than 3 runs or a locked screen', () => {
    expect(P.verdictConsole([goodRun(), goodRun()], FACTS).verdict).toBe('CANNOT MEASURE')
    expect(P.verdictConsole([goodRun(), goodRun(), goodRun()], { ...FACTS, logonUi: true }).verdict).toBe('CANNOT MEASURE')
  })
})

describe('P21: the SSH verdict', () => {
  it('reads FAILS CLEANLY for 3 of 3 no-desktop exits with a message and no file', () => {
    const v = P.verdictSsh([cleanSsh(), cleanSsh(), cleanSsh()])
    expect(v.verdict).toBe('FAILS CLEANLY')
    expect(v.why).toMatch(/^3 of 3 runs exited 3 with "aicc-helper: capture: no desktop to capture/)
  })

  it('reads DOES NOT FAIL CLEANLY for a capture, a hang, a silent exit, a line or a file left', () => {
    const cases: Array<[string, Partial<Run>, RegExp]> = [
      ['a capture', { code: 0, stderr: '', stdout: '{"displays":[]}' }, /exit 0, not 3/],
      ['a hang', { hung: true, code: null, ms: 10050 }, /hung/],
      ['no message', { stderr: '' }, /no message on stderr/],
      ['a line', { stdout: '{"displays":[]}' }, /printed/],
      ['a file left', { files: ['display-1.bmp'] }, /left display-1.bmp/],
    ]
    for (const [name, change, failure] of cases) {
      const v = P.verdictSsh([cleanSsh(), { ...cleanSsh(), ...change }, cleanSsh()])
      expect(v.verdict, name).toBe('DOES NOT FAIL CLEANLY')
      expect(v.failures.join(' | '), name).toMatch(failure)
    }
    expect(P.verdictSsh([cleanSsh()]).verdict).toBe('CANNOT MEASURE')
  })
})

describe('P21: the lines it prints', () => {
  const at = (dpi: number): Facts => ({ ...FACTS, dpis: [{ left: 0, top: 0, dpi, primary: true }] })
  const runsAt = (dpi: number) => [goodRun(), goodRun(), goodRun()].map((r) => ({ ...r, displays: r.displays!.map((d) => ({ ...d, dpi })) }))

  it('reads CAPTURES at two scales and FAILS CLEANLY into one RESULT line, mixed scaling not measured on one display', () => {
    const lines = P.verdictLines(
      [
        { label: 'console-100', facts: at(96), runs: runsAt(96) },
        { label: 'console-125', facts: at(120), runs: runsAt(120) },
      ],
      { label: 'ssh', facts: { modes: [], dpis: [] }, runs: [cleanSsh(), cleanSsh(), cleanSsh()] },
    )
    expect(lines).toContain('P21 SCALES: 100% and 125%; two scales measured')
    expect(lines).toContain('P21 MIXED SCALING: mixed scaling: not measured (one display)')
    expect(lines[lines.length - 1]).toBe(
      'P21 RESULT: CAPTURES at 100% and 125% from the console session; FAILS CLEANLY from the SSH session; two scales measured; mixed scaling: not measured (one display)',
    )
  })

  it('says why a second scale was not measured, and that one failing scale fails the result', () => {
    const one = P.verdictLines([{ label: 'console-100', facts: at(96), runs: runsAt(96) }], null, 'the display allows 100% only')
    expect(one).toContain('P21 SCALES: 100%; second scale: not measured (the display allows 100% only)')
    expect(one[one.length - 1]).toMatch(/^P21 RESULT: CAPTURES at 100% from the console session; CANNOT MEASURE from the SSH session/)
    const bad = runsAt(120)
    bad[0].code = 1
    const two = P.verdictLines(
      [
        { label: 'console-100', facts: at(96), runs: runsAt(96) },
        { label: 'console-125', facts: at(120), runs: bad },
      ],
      null,
    )
    expect(two[two.length - 1]).toMatch(/^P21 RESULT: DOES NOT CAPTURE at 100% and 125%/)
  })

  it('with no console reading, says why and reads CANNOT MEASURE for the console session, the SSH half still judged', () => {
    const lines = P.verdictLines(
      [],
      { label: 'ssh', facts: { modes: [], dpis: [] }, runs: [cleanSsh(), cleanSsh(), cleanSsh()] },
      'no console session to set it in',
      'nobody is signed in on the console',
    )
    expect(lines[0]).toBe('P21 CONSOLE: CANNOT MEASURE - nobody is signed in on the console')
    expect(lines[lines.length - 1]).toBe(
      'P21 RESULT: CANNOT MEASURE from the console session; FAILS CLEANLY from the SSH session; second scale: not measured (no console session to set it in); mixed scaling: not measured (no display listed)',
    )
  })

  // The CI runner takes the console reading and has no SSH session (ci.yml, the Probe P21 job, B5).
  const NOT_RUN = 'the runner has no SSH session; WINDOWS_1\'s reading stands (FAILS CLEANLY, ADR-030)'

  it('says the SSH half was not run, with the reason, and never reads it as a verdict or a missing reading', () => {
    const lines = P.verdictLines([{ label: 'ci-console', facts: at(96), runs: runsAt(96) }], null, 'the job does not change the runner\'s display scale', undefined, NOT_RUN)
    expect(lines).toContain(`P21 SSH: NOT RUN - ${NOT_RUN}`)
    expect(lines).toContain('P21 CONSOLE ci-console (100%): CAPTURES - 3 of 3 runs, 180 to 180 ms')
    expect(lines[lines.length - 1]).toBe(
      `P21 RESULT: CAPTURES at 100% from the console session; SSH session: not run (${NOT_RUN}); second scale: not measured (the job does not change the runner's display scale); mixed scaling: not measured (one display)`,
    )
    // Not a verdict about SSH, and not the "0 of 3 runs read" of a missing reading.
    expect(lines.join('\n')).not.toMatch(/FAILS CLEANLY from the SSH|CANNOT MEASURE - 0 of 3|DOES NOT FAIL CLEANLY/)
  })

  it('does not hide a console failure behind the SSH half being not run', () => {
    const bad = runsAt(96)
    bad[1].displays![0].picture = picture(8, 6, () => [0, 0, 0, 255])
    const lines = P.verdictLines([{ label: 'ci-console', facts: at(96), runs: bad }], null, undefined, undefined, NOT_RUN)
    expect(lines[lines.length - 1]).toMatch(/^P21 RESULT: DOES NOT CAPTURE at 100% from the console session; SSH session: not run \(/)
    expect(lines.join('\n')).toContain('run 2: display-1.bmp: every pixel is black')
  })

  it('reads a missing SSH reading as CANNOT MEASURE as before when no reason is given, and refuses a reading and a reason together', () => {
    const none = P.verdictLines([{ label: 'ci-console', facts: at(96), runs: runsAt(96) }], null)
    expect(none).toContain('P21 SSH: CANNOT MEASURE - 0 of 3 runs read')
    const ssh = { label: 'ssh', facts: { modes: [], dpis: [] }, runs: [cleanSsh(), cleanSsh(), cleanSsh()] }
    expect(() => P.verdictLines([], ssh, undefined, undefined, NOT_RUN)).toThrow(/same half: give one/)
    // A reading still gives its verdict when no reason is given.
    expect(P.verdictLines([], ssh)).toContain(`P21 SSH: FAILS CLEANLY - 3 of 3 runs exited 3 with "aicc-helper: capture: no desktop to capture: this process runs on a window station no display shows", 40 to 40 ms`)
  })

  it('prints one line of what Windows said about the session: its id, elevation, LogonUI, each display\'s size and the scale', () => {
    const facts = { ...at(120), sessionId: 1, elevated: true, modes: [{ left: 0, top: 0, width: 1024, height: 768, primary: true }] }
    expect(P.factsLine({ label: 'ci-console', facts })).toBe('P21 ci-console: session 1, elevated, LogonUI false, 1 display (1024x768), scale 125%')
    expect(P.factsLine({ label: 'console-a', facts: { ...facts, elevated: false, logonUi: true } })).toBe('P21 console-a: session 1, not elevated, LogonUI true, 1 display (1024x768), scale 125%')
    // An older reading with no elevation field, and a session with no display listed.
    expect(P.factsLine({ label: 'old', facts: { logonUi: false, modes: [], dpis: [], sessionId: 0 } })).toBe('P21 old: session 0, elevation not read, LogonUI false, 0 displays, scale not read')
  })

  it('counts mixed scaling only with two displays at different scales', () => {
    const two: Facts = {
      modes: [{ left: 0, top: 0, width: 8, height: 6 }, { left: 8, top: 0, width: 8, height: 6 }],
      dpis: [{ left: 0, top: 0, dpi: 96 }, { left: 8, top: 0, dpi: 144 }],
    }
    expect(P.mixedLine([{ label: 'console-a', facts: two }])).toBe('mixed scaling: measured in console-a')
    expect(P.mixedLine([{ label: 'console-a', facts: { ...two, dpis: [{ left: 0, top: 0, dpi: 96 }, { left: 8, top: 0, dpi: 96 }] } }])).toBe('mixed scaling: not measured (2 displays, all at one scale)')
  })

  it('takes only a label that names files safely', () => {
    expect(P.checkLabel('console-125')).toBe('console-125')
    for (const bad of ['', '../x', 'a b', 'x'.repeat(41), 7]) expect(() => P.checkLabel(bad)).toThrow()
  })
})
