import { describe, it, expect } from 'vitest'
import { judgeReport } from '../../../scripts/ci/playwright-no-retry.mjs'
import { readGroups, readBmpHeader, readCaptureLine, verdict, decodeText, cmdFileText, RUNAS_FORMS, BMP_HEADER_BYTES } from '../../../scripts/ci/snap-basic-user.mjs'

/**
 * The two scripts of ci.yml's snap-e2e job (plan 2.1.3-beta.16, section A1;
 * aicc_planning#401): the check that fails a Playwright run that was retried
 * or reported flaky (rule 27), and the reader of the basic-user capture.
 *
 * Not checked here: runas itself and the runner's token (the dispatch reads
 * them), and the spec (the dispatch runs it).
 */

type R = { retry: number; status: string }
const report = (tests: Array<{ title: string; status: string; results: R[] }>, stats: Record<string, number>, errors: unknown[] = []) => ({
  stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0, ...stats },
  errors,
  suites: [{ title: 'snap-windows.spec.ts', specs: [], suites: [{ title: 'Snap', specs: tests.map((t) => ({ title: t.title, tests: [{ status: t.status, results: t.results }] })) }] }],
})

describe('playwright-no-retry: a run passes only when every test ran once and passed', () => {
  it('passes a run whose every test ran once and passed', () => {
    const r = judgeReport(report([{ title: 'a', status: 'expected', results: [{ retry: 0, status: 'passed' }] }], { expected: 1 }))
    expect(r).toEqual({ ok: true, lines: [] })
  })

  it('fails a test Playwright retried, even when the second try passed and the stats were not counted as flaky', () => {
    const r = judgeReport(report([{ title: 'drag', status: 'expected', results: [{ retry: 0, status: 'failed' }, { retry: 1, status: 'passed' }] }], { expected: 1 }))
    expect(r.ok).toBe(false)
    expect(r.lines).toContain('retried: "drag" ran 2 times')
  })

  it('fails a test reported flaky, nested in a describe', () => {
    const r = judgeReport(report([{ title: 'escape', status: 'flaky', results: [{ retry: 1, status: 'passed' }] }], { expected: 0, flaky: 1 }))
    expect(r.ok).toBe(false)
    expect(r.lines).toEqual(expect.arrayContaining(['flaky: "escape"', 'the report counts 1 flaky']))
  })

  it('fails a failed test, a run that ran nothing, and a run with an error of its own', () => {
    expect(judgeReport(report([{ title: 'x', status: 'unexpected', results: [{ retry: 0, status: 'failed' }] }], { unexpected: 1 })).ok).toBe(false)
    expect(judgeReport(report([], { skipped: 3 })).lines).toContain('no test passed: the run ran nothing, or skipped everything')
    expect(judgeReport(report([{ title: 'a', status: 'expected', results: [{ retry: 0, status: 'passed' }] }], { expected: 1 }, [{ message: 'Error: no tests found\nmore' }])).lines)
      .toContain('the run itself reported 1 error(s): Error: no tests found')
  })

  it('fails a report that is not a whole Playwright report', () => {
    for (const bad of [null, {}, { suites: [] }, 'text']) expect(judgeReport(bad).ok, JSON.stringify(bad)).toBe(false)
  })
})

describe('snap-basic-user: the reader of one capture from a basic-user token', () => {
  it('tries the plain form first, then the amd64 one', () => {
    expect(RUNAS_FORMS).toEqual([['/trustlevel:0x20000'], ['/machine:amd64', '/trustlevel:0x20000']])
  })

  it('reads the token from whoami /groups: Administrators for deny only and the medium level, or enabled and high', () => {
    const basic = [
      'BUILTIN\\Administrators                   Alias            S-1-5-32-544 Group used for deny only',
      'BUILTIN\\Users                            Alias            S-1-5-32-545 Mandatory group, Enabled by default, Enabled group',
      'Mandatory Label\\Medium Mandatory Level    Label            S-1-16-8192',
    ].join('\r\n')
    expect(readGroups(basic)).toEqual({ administrators: 'deny-only', level: 'Medium' })
    const elevated = [
      'BUILTIN\\Administrators Alias S-1-5-32-544 Mandatory group, Enabled by default, Enabled group, Group owner',
      'Mandatory Label\\High Mandatory Level Label S-1-16-12288',
    ].join('\n')
    expect(readGroups(elevated)).toEqual({ administrators: 'enabled', level: 'High' })
    expect(readGroups('')).toEqual({ administrators: 'absent', level: null })
  })

  it('writes the exit status with the echo in brackets: `echo 0> file` would redirect handle 0 and write nothing', () => {
    const text = cmdFileText('C:\\w', 'C:\\h\\aicc-helper.exe', 'C:\\w\\cap')
    const lines = text.split('\r\n')
    const status = lines.find((l) => l.includes('ERRORLEVEL'))
    expect(status).toBe('(echo %ERRORLEVEL%)> "C:\\w\\exit.tmp"')
    // No line puts an expansion (which can be a digit) straight before a redirect.
    for (const l of lines) expect(l, l).not.toMatch(/%\s*>/)
    // The status is written last and moved into place.
    expect(lines.indexOf(status!)).toBeGreaterThan(lines.findIndex((l) => l.includes(' capture --out ')))
    expect(lines[lines.indexOf(status!) + 1]).toBe('move /y "C:\\w\\exit.tmp" "C:\\w\\exit.txt" > nul')
  })

  it('reads what a console program wrote, in UTF-8 or in UTF-16 with or without its mark', () => {
    expect(decodeText(Buffer.from('0 \r\n', 'latin1'))).toBe('0 \r\n')
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('BUILTIN', 'utf16le')]))).toBe('BUILTIN')
    expect(decodeText(Buffer.from('S-1-16-8192', 'utf16le'))).toBe('S-1-16-8192')
    expect(decodeText(Buffer.alloc(0))).toBe('')
  })

  it('reads a BMP header (width, height, bits) and refuses what is not a BMP', () => {
    const buf = Buffer.alloc(BMP_HEADER_BYTES)
    buf.write('BM', 0, 'latin1')
    buf.writeInt32LE(1024, 18)
    buf.writeInt32LE(768, 22)
    buf.writeUInt16LE(32, 28)
    expect(readBmpHeader(buf)).toEqual({ width: 1024, height: 768, bits: 32 })
    expect(readBmpHeader(Buffer.alloc(10))).toBeNull()
    expect(readBmpHeader(Buffer.alloc(BMP_HEADER_BYTES))).toBeNull()
  })

  it('reads the capture line, and nothing from a line that is not one', () => {
    expect(readCaptureLine('{"displays":[{"file":"display-1.bmp","left":0,"top":0,"width":1024,"height":768,"dpi":96,"scale":100,"primary":true}]}\r\n'))
      .toEqual([{ file: 'display-1.bmp', left: 0, top: 0, width: 1024, height: 768, dpi: 96, scale: 100, primary: true }])
    for (const bad of ['', 'not json', '{"x":1}', '{"displays":[]}\n{"displays":[]}']) expect(readCaptureLine(bad), bad).toBeNull()
  })

  it('says CAPTURES only for exit 0 with every picture matching, and names what was not measured', () => {
    const good = { exit: 0, displays: [{}], pictures: [{ ok: true }], token: { administrators: 'deny-only', level: 'Medium' } }
    expect(verdict(good)).toBe('CAPTURES')
    // A capture whose token was not read as a basic user's is not called a basic-user capture.
    expect(verdict({ ...good, token: { administrators: 'absent', level: null } })).toBe("CAPTURES, but the token was not read as a basic user's (Administrators absent, no mandatory level)")
    expect(verdict({ ...good, pictures: [{ ok: false }] })).toBe('FAILS (exit 0)')
    expect(verdict({ ...good, exit: 3, stderr: 'no desktop', displays: null, pictures: [] })).toBe('FAILS (exit 3: no desktop)')
    expect(verdict({ refused: 'RUNAS ERROR: x', pictures: [] })).toMatch(/^not measured: the runner refused both forms/)
    expect(verdict({ noStatus: true, pictures: [] })).toMatch(/^not measured: the restricted run wrote no status/)
    expect(verdict({ ...good, token: { administrators: 'enabled', level: 'High' } })).toMatch(/^not measured: the token runas gave still has the Administrators group enabled/)
  })
})
