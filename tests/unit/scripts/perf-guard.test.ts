/**
 * [host] Where the performance harness may run and what it may touch
 * (scripts/perf/lib/guard.cjs, and the README staging helpers it relies on):
 * only the Windows test VM, with the opt-in set, never a desktop that sets
 * it; only the app launch.js started, holding both debug ports; a results
 * folder inside the staging root; a port check that failed read as busy,
 * never as free; and launch.js's stop treating "part of the tree had already
 * ended" as the success it is, while an app still running stays a failure.
 *
 * Every command is a stand-in: nothing is started, read or written.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { join, resolve } from 'path'

const PERF = resolve(__dirname, '..', '..', '..', 'scripts', 'perf')
const STAGE_DIR = resolve(PERF, '..', 'readme-shots', 'stage')
type FakeExec = (cmd: string, args: string[]) => string
const G = createRequire(join(PERF, 'lib', 'guard.cjs'))('./guard.cjs') as {
  testVmRefusal: (o: { platform: string; env: Record<string, string | undefined>; model?: string; manufacturer?: string }) => string | null
  machineModel: (exec: (cmd: string, args: string[]) => string) => { model?: string; manufacturer?: string }
  checkStagedApp: (S: unknown, rec: Record<string, unknown>, ports: number[], deps?: { platform: string; exec: FakeExec }) => unknown
  resultsDir: (S: unknown, stage: { ROOT: string }, given: string | null, stamp: string) => string
}
const stageReq = createRequire(join(STAGE_DIR, 'stage-root.js'))
const S = stageReq('./stage-root.js') as { portOwnerPid: (port: number, platform: string, exec: FakeExec) => number | null | undefined }
const L = stageReq('./launch.js') as { endTreeWin: (rec: { pid: number }, deps: Record<string, unknown>) => number }

describe('only on the Windows test VM, and only when asked to there', () => {
  const VM = { model: 'Virtual Machine', manufacturer: 'Microsoft Corporation' }
  it('runs on a Hyper-V guest with CCC_PERF_TEST_VM=1', () => {
    expect(G.testVmRefusal({ platform: 'win32', env: { CCC_PERF_TEST_VM: '1' }, ...VM })).toBeNull()
  })
  it.each([
    ['another platform', { platform: 'linux', env: { CCC_PERF_TEST_VM: '1' }, ...VM }, /only on the Windows test VM/],
    ['no opt-in', { platform: 'win32', env: {}, ...VM }, /CCC_PERF_TEST_VM=1 is not set/],
    ['an opt-in that is not 1', { platform: 'win32', env: { CCC_PERF_TEST_VM: 'yes' }, ...VM }, /CCC_PERF_TEST_VM=1 is not set/],
    ['a desktop that set the opt-in', { platform: 'win32', env: { CCC_PERF_TEST_VM: '1' }, model: 'Precision 7960 Tower', manufacturer: 'Dell Inc.' }, /not a Hyper-V virtual machine/],
    ['another hypervisor', { platform: 'win32', env: { CCC_PERF_TEST_VM: '1' }, model: 'Virtual Machine', manufacturer: 'innotek GmbH' }, /not a Hyper-V virtual machine/],
    ['a model that could not be read', { platform: 'win32', env: { CCC_PERF_TEST_VM: '1' } }, /not a Hyper-V virtual machine/],
  ])('refuses %s', (_name, o, message) => {
    expect(G.testVmRefusal(o as Parameters<typeof G.testVmRefusal>[0])).toMatch(message as RegExp)
  })
  it("reads the machine's model, and nothing when it cannot", () => {
    expect(G.machineModel(() => 'Virtual Machine|Microsoft Corporation\r\n')).toEqual({ model: 'Virtual Machine', manufacturer: 'Microsoft Corporation' })
    expect(G.machineModel(() => { throw new Error('no powershell') })).toEqual({})
  })
})

describe('only the app launch.js started, holding both ports', () => {
  const Sfull = stageReq('./stage-root.js')
  const rec = { pid: 4242, port: 9333, exe: 'C:\\Apps\\AI Code Conductor\\AI Code Conductor.exe', startedAt: '2026-11-17T01:00:00.000Z', dataDir: 'C:\\x' }
  const live = `${rec.exe}|2026-11-17T01:00:00.500Z`
  const exec = (owners: Record<number, string | Error>, row = live): FakeExec => (_cmd, args) => {
    const script = args.join(' ')
    const port = /-LocalPort (\d+)/.exec(script)
    if (port) { const o = owners[Number(port[1])]; if (o instanceof Error) throw o; return o ?? '' }
    if (/Win32_Process/.test(script)) return row
    throw new Error('unexpected ' + script)
  }
  it('passes when the recorded app holds the debug port and the inspector port', () => {
    expect(G.checkStagedApp(Sfull, rec, [9333, 9229], { platform: 'win32', exec: exec({ 9333: '4242', 9229: '4242' }) })).toBe(rec)
  })
  it('refuses another process on the inspector port, or a port check that failed', () => {
    expect(() => G.checkStagedApp(Sfull, rec, [9333, 9229], { platform: 'win32', exec: exec({ 9333: '4242', 9229: '5555' }) })).toThrow(/port 9229 is not held by the app launch.js started \(pid 4242; held by pid 5555\)/)
    expect(() => G.checkStagedApp(Sfull, rec, [9229], { platform: 'win32', exec: exec({ 9333: '4242', 9229: new Error('timed out') }) })).toThrow(/held by an unknown process/)
    expect(() => G.checkStagedApp(Sfull, rec, [9229], { platform: 'win32', exec: exec({ 9333: '4242', 9229: '' }) })).toThrow(/held by nothing/)
  })
  it('refuses when the recorded app is gone or another process holds its debug port', () => {
    expect(() => G.checkStagedApp(Sfull, rec, [9229], { platform: 'win32', exec: exec({ 9333: '4242', 9229: '4242' }, '') })).toThrow(/not running any more/)
    expect(() => G.checkStagedApp(Sfull, rec, [9229], { platform: 'win32', exec: exec({ 9333: '7', 9229: '4242' }) })).toThrow(/port 9333 is not held by the recorded app/)
  })
})

describe('a results folder inside the staging root', () => {
  const Sfull = stageReq('./stage-root.js')
  const stage = { ROOT: 'C:\\Users\\User\\b7p-run' }
  it('defaults to perf-out under the root, and takes a folder inside it', () => {
    expect(G.resultsDir(Sfull, stage, null, '20261117-010000')).toBe(join(stage.ROOT, 'perf-out', '20261117-010000'))
    if (process.platform === 'win32') expect(G.resultsDir(Sfull, stage, 'C:\\Users\\User\\b7p-run\\out-1', 'x')).toBe('C:\\Users\\User\\b7p-run\\out-1')
  })
  it('refuses a folder outside the root, or one given relative', () => {
    expect(() => G.resultsDir(Sfull, stage, 'out-1', 'x')).toThrow(/absolute/)
    if (process.platform === 'win32') {
      expect(() => G.resultsDir(Sfull, stage, 'C:\\Users\\User\\Downloads\\out', 'x')).toThrow(/not inside the staging root/)
      expect(() => G.resultsDir(Sfull, stage, 'C:\\Users\\User\\b7p-run', 'x')).toThrow(/not inside the staging root/)
    }
  })
})

describe('a port check that failed is not a free port', () => {
  it('reads the owner, nothing listening, and a failed check apart on Windows', () => {
    expect(S.portOwnerPid(9333, 'win32', () => '4242\r\n')).toBe(4242)
    expect(S.portOwnerPid(9333, 'win32', () => '')).toBeNull()
    expect(S.portOwnerPid(9333, 'win32', () => { throw new Error('timed out') })).toBeUndefined()
  })
  it('lets only "no listener" read as free on Windows: any other error of the query exits non-zero, which reads as unknown', () => {
    let script = ''
    expect(S.portOwnerPid(9333, 'win32', (_cmd, args) => { script = args.join(' '); return '' })).toBeNull()
    // A silenced error (a CIM or WMI failure) would print nothing and exit 0, which reads as free.
    expect(script).not.toMatch(/SilentlyContinue|-EA\b|ErrorActionPreference/i)
    expect(script).toMatch(/try \{ \(Get-NetTCPConnection -State Listen -LocalPort 9333 -ErrorAction Stop \| Select-Object -First 1\)\.OwningProcess \} catch \{/)
    expect(script).toMatch(/\$_\.CategoryInfo\.Category -ne 'ObjectNotFound'/)
    expect(script).toMatch(/\{ exit 1 \}/)
    // `powershell -Command` exits 1 after a caught "no match" unless told otherwise (seen on Windows
    // 11 with port 1): without this every free port would read as unknown.
    expect(script).toMatch(/\}; exit 0$/)
    // The non-zero exit, whatever it printed.
    expect(S.portOwnerPid(9333, 'win32', () => { throw Object.assign(new Error('Command failed'), { status: 1, stdout: '4242\r\n' }) })).toBeUndefined()
  })
  it("reads lsof's no-match exit as free, and any other failure as unknown, on macOS and Linux", () => {
    expect(S.portOwnerPid(9333, 'darwin', () => { throw Object.assign(new Error('exit 1'), { status: 1, stdout: '' }) })).toBeNull()
    expect(S.portOwnerPid(9333, 'linux', () => { throw Object.assign(new Error('no lsof'), { status: 127, stdout: '' }) })).toBeUndefined()
  })
})

describe("launch.js stop: taskkill's exit and the app's own end", () => {
  const rec = { pid: 4242 }
  const said: string[] = []
  const log = (l: string) => { said.push(l) }
  it('is done when taskkill ends the tree', () => {
    expect(L.endTreeWin(rec, { exec: () => '', stillRunning: () => true, wait: () => undefined, log })).toBe(0)
  })
  it('is done when taskkill exits non-zero because part of the tree had already ended, once the app itself is gone', () => {
    let checks = 0
    const code = L.endTreeWin(rec, { exec: () => { throw Object.assign(new Error('exit 128'), { status: 128 }) }, stillRunning: () => ++checks < 3, wait: () => undefined, log })
    expect(code).toBe(128)
    expect(said.at(-1)).toMatch(/taskkill exited 128: part of the tree had already ended; the app itself has ended/)
  })
  it('fails when the app is still running after taskkill and five seconds', () => {
    let waits = 0
    expect(() => L.endTreeWin(rec, { exec: () => { throw Object.assign(new Error('exit 1'), { status: 1 }) }, stillRunning: () => true, wait: () => { waits++ }, log })).toThrow(/taskkill exited 1 and the app \(pid 4242\) is still running/)
    expect(waits).toBe(10)
  })
})
