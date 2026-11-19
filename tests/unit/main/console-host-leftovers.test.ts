import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

import {
  endLeftoverConsoleHosts,
  parseConsoleHostsAnswer,
  parseRunRecord,
  RUN_RECORD_MAX_BYTES,
  type HelperRun,
  type LeftoverPorts,
} from '../../../src/main/console-host-leftovers'

/**
 * aicc_planning #330: at start-up the app runs the session helper's
 * console-hosts mode with the record of the run before, and records this run
 * from the helper's answer. The helper's own rules (which hosts it ends) are
 * tested in helper/tests/console_hosts.rs and helper/src/consoles.rs; this is
 * the app's side: the record, read strictly, the call, and the answer.
 * Everything runs on in-memory ports: no file, no process.
 */

const RECORD = 'C:\\Users\\me\\AppData\\Roaming\\claude-conductor\\app-run.json'
const HELPER = 'C:\\Program Files\\AI Code Conductor\\resources\\helper\\aicc-helper.exe'
const OWN_PID = 4242

function fakePorts(opts: { files?: Record<string, string>; helper?: string | null; run?: HelperRun; platform?: NodeJS.Platform } = {}) {
  const files = new Map(Object.entries(opts.files ?? {}))
  const runs: string[][] = []
  const quits: (() => void)[] = []
  const logs: string[] = []
  const ports: LeftoverPorts = {
    platform: opts.platform ?? 'win32',
    ownPid: OWN_PID,
    recordFile: RECORD,
    helperPath: () => (opts.helper === undefined ? HELPER : opts.helper),
    readFile: (file, max) => {
      const t = files.get(file)
      if (t === undefined) return null
      return Buffer.byteLength(t) > max ? 'large' : t
    },
    writeFile: (file, text) => { files.set(file, text) },
    removeFile: (file) => { files.delete(file) },
    runHelper: async (helper, args) => {
      expect(helper).toBe(HELPER)
      runs.push(args)
      return opts.run ?? { ok: true, stdout: `{"pid":${OWN_PID},"created":"134000000000000010","ended":0}\n`, stderr: '' }
    },
    onQuit: (fn) => { quits.push(fn) },
    log: (line) => { logs.push(line) },
    logError: (line) => { logs.push(`ERROR ${line}`) },
  }
  return { ports, files, runs, quits, logs }
}

describe('console hosts a run left (#330): the record and the answer are read strictly', () => {
  it('a record is exactly a pid and a creation time of digits', () => {
    expect(parseRunRecord('{"pid":12,"created":"133000000000000010"}')).toEqual({ pid: 12, created: '133000000000000010' })
    expect(parseRunRecord('  {"pid":12,"created":"1"}\n')).toEqual({ pid: 12, created: '1' })
    for (const bad of [
      '',
      'not json',
      '[]',
      'null',
      '{"pid":12}',
      '{"created":"1"}',
      '{"created":"1","pid":12}',
      '{"pid":12,"created":"1","extra":true}',
      '{"pid":0,"created":"1"}',
      '{"pid":-3,"created":"1"}',
      '{"pid":1.5,"created":"1"}',
      '{"pid":4294967296,"created":"1"}',
      '{"pid":"12","created":"1"}',
      '{"pid":12,"created":1}',
      '{"pid":12,"created":""}',
      '{"pid":12,"created":"12a"}',
      '{"pid":12,"created":"123456789012345678901"}',
      '{"pid":12,"created":"1"}\n{"pid":13,"created":"2"}',
    ]) {
      expect(parseRunRecord(bad), bad).toBeNull()
    }
  })

  it('the helper\'s answer is exactly a pid, a creation time and how many it ended', () => {
    expect(parseConsoleHostsAnswer('{"pid":12,"created":"5","ended":2}\n')).toEqual({ pid: 12, created: '5', ended: 2 })
    for (const bad of ['', '{"pid":12,"created":"5"}', '{"pid":12,"created":"5","ended":-1}', '{"pid":12,"created":"5","ended":"2"}', '{"pid":12,"created":"5","ended":1,"x":0}', 'ended']) {
      expect(parseConsoleHostsAnswer(bad), bad).toBeNull()
    }
  })
})

describe('console hosts a run left (#330): once at start-up', () => {
  it('elsewhere than Windows, nothing is read and the helper is never run', async () => {
    const f = fakePorts({ platform: 'linux', files: { [RECORD]: '{"pid":12,"created":"1"}' } })
    await endLeftoverConsoleHosts(f.ports)
    expect(f.runs).toEqual([])
    expect(f.files.get(RECORD)).toBe('{"pid":12,"created":"1"}')
  })

  it('with the run before recorded, the helper is given its pid and creation time, and this run is recorded from the answer', async () => {
    const f = fakePorts({
      files: { [RECORD]: '{"pid":12,"created":"133000000000000010"}' },
      run: { ok: true, stdout: `{"pid":${OWN_PID},"created":"134000000000000020","ended":1}\n`, stderr: '' },
    })
    await endLeftoverConsoleHosts(f.ports)
    expect(f.runs).toEqual([['console-hosts', '--pid', '12', '--created', '133000000000000010']])
    expect(f.files.get(RECORD)).toBe(`{"pid":${OWN_PID},"created":"134000000000000020"}`)
    expect(f.logs.some((l) => /Ended 1 console host/.test(l)), f.logs.join('\n')).toBe(true)
  })

  it('with no record, the helper only names this run, which is recorded', async () => {
    const f = fakePorts()
    await endLeftoverConsoleHosts(f.ports)
    expect(f.runs).toEqual([['console-hosts']])
    expect(f.files.get(RECORD)).toBe(`{"pid":${OWN_PID},"created":"134000000000000010"}`)
  })

  it('a record that cannot be read is removed and ignored: the helper ends nothing for it', async () => {
    for (const bad of ['{"pid":12,"created":"1; whoami"}', '{"pid":12,"created":"1","then":"x"}', 'x'.repeat(RUN_RECORD_MAX_BYTES + 1)]) {
      const f = fakePorts({ files: { [RECORD]: bad } })
      await endLeftoverConsoleHosts(f.ports)
      expect(f.runs, bad.slice(0, 40)).toEqual([['console-hosts']])
      expect(f.files.get(RECORD)).toBe(`{"pid":${OWN_PID},"created":"134000000000000010"}`)
    }
  })

  it('with no helper in this install, nothing is run and the record stays for a later start', async () => {
    const f = fakePorts({ helper: null, files: { [RECORD]: '{"pid":12,"created":"1"}' } })
    await endLeftoverConsoleHosts(f.ports)
    expect(f.runs).toEqual([])
    expect(f.files.get(RECORD)).toBe('{"pid":12,"created":"1"}')
  })

  it('a helper that fails, or answers for another process, records nothing new', async () => {
    for (const run of [
      { ok: false, stdout: '', stderr: 'aicc-helper: console-hosts: the process list: Access is denied.', why: 'Command failed' },
      { ok: true, stdout: 'garbage', stderr: '' },
      { ok: true, stdout: '{"pid":7,"created":"134000000000000010","ended":0}', stderr: '' },
    ]) {
      const f = fakePorts({ files: { [RECORD]: '{"pid":12,"created":"1"}' }, run })
      await endLeftoverConsoleHosts(f.ports)
      expect(f.runs).toHaveLength(1)
      expect(f.files.get(RECORD), run.stdout || run.stderr).toBe('{"pid":12,"created":"1"}')
      expect(f.quits).toEqual([])
    }
  })

  it('a clean quit removes this run\'s record, and only this run\'s', async () => {
    const f = fakePorts()
    await endLeftoverConsoleHosts(f.ports)
    expect(f.quits).toHaveLength(1)
    f.quits[0]()
    expect(f.files.has(RECORD)).toBe(false)

    const g = fakePorts()
    await endLeftoverConsoleHosts(g.ports)
    // A later start wrote its own record meanwhile: it stays.
    g.files.set(RECORD, '{"pid":99,"created":"135000000000000000"}')
    g.quits[0]()
    expect(g.files.get(RECORD)).toBe('{"pid":99,"created":"135000000000000000"}')
  })

  it('never throws: a write that fails is logged', async () => {
    const f = fakePorts()
    f.ports.writeFile = () => { throw new Error('disk full') }
    await expect(endLeftoverConsoleHosts(f.ports)).resolves.toBeUndefined()
    expect(f.logs.some((l) => l.startsWith('ERROR') && l.includes('disk full'))).toBe(true)
  })
})
