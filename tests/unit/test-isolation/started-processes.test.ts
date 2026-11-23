// Ending a process a test started never ends another process that has its pid
// by then (tests/helpers/started-processes.ts), and no test in the vitest suite
// ends a process by a bare pid. Pure: no process is started or ended; every
// process here is a stand-in object, and the stop script runs in a sandbox.
//
// The case it guards: installer-nsis-behaviour.test.ts ended each pid it had
// started if the pid still answered. The probes end most of those processes
// themselves, Windows gives the freed pids to new processes within seconds
// (diag run 45140445533: 3 to 21 s, to node.exe, conhost.exe, powershell.exe),
// and an ended vitest worker is "Worker exited unexpectedly" (Windows part 2,
// runs 45046712982 and 45123495761).
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  askToStop, endIfImage, endSpawned, parseTasklistImage, runs, runsImage, stopWhen,
  type EndDeps, type SpawnedProcess,
} from '../../helpers/started-processes'

/** A spawned process as a ChildProcess shows it; `kill` ends it at once. */
function spawned(running: boolean, pid = 4242): SpawnedProcess & { kills: number } {
  const p = {
    pid,
    exitCode: running ? null : 0,
    signalCode: null as NodeJS.Signals | null,
    kills: 0,
    kill() {
      p.kills++
      if (p.exitCode !== null || p.signalCode !== null) return false
      p.signalCode = 'SIGTERM'
      return true
    },
  }
  return p
}

/** The system as these cases see it: which pid runs which image, every pid ended by number, every stop file made. */
function system(table: Record<number, string>) {
  const ended: number[] = []
  const touched: string[] = []
  const deps: Partial<EndDeps> = {
    pidAnswers: (pid) => pid in table,
    imageOf: (pid) => table[pid],
    killPid: (pid) => {
      ended.push(pid)
      delete table[pid]
    },
    touch: (file) => touched.push(file),
    pause: async () => {},
  }
  return { ended, touched, deps, table }
}

describe('a process the test spawned', () => {
  it('is ended through its own handle while it runs', async () => {
    const p = spawned(true)
    const { ended, deps } = system({ 4242: 'ccc-probe-helper.exe' })
    expect(await endSpawned(p, 5000, deps)).toBe(true)
    expect(p.kills).toBe(1)
    expect(p.signalCode).toBe('SIGTERM')
    expect(ended, 'no pid is ended by number').toEqual([])
  })

  it('once Node has seen it exit, nothing is sent, and it does not run, whatever has its pid now', async () => {
    const p = spawned(false)
    // Its old pid answers for a vitest worker now.
    const { ended, deps } = system({ 4242: 'node.exe' })
    expect(await endSpawned(p, 5000, deps)).toBe(true)
    expect(p.kills).toBe(0)
    expect(ended).toEqual([])
    expect(runs(p, deps)).toBe(false)
  })

  it('runs while Node has not seen it exit and its pid answers (Node holds its handle, so the pid is its own)', () => {
    const { deps } = system({ 4242: 'ccc-probe-helper.exe' })
    expect(runs(spawned(true), deps)).toBe(true)
  })

  it('does not run once its pid stops answering, before Node has seen the exit', () => {
    const { deps } = system({})
    expect(runs(spawned(true), deps)).toBe(false)
  })

  it('with no pid never started, so it does not run', () => {
    const p = { exitCode: null, signalCode: null, kill: () => false }
    expect(runs(p, system({ 4242: 'node.exe' }).deps)).toBe(false)
  })

  it('a kill that throws (it had just exited) is not an error', async () => {
    const p = { pid: 4242, exitCode: null as number | null, signalCode: null, kill: () => { p.exitCode = 1; throw new Error('ESRCH') } }
    expect(await endSpawned(p, 5000, system({}).deps)).toBe(true)
  })
})

describe('a process the test wrote and knows only by a pid read from a file', () => {
  const child = { pid: 4242, stopFile: 'C:\\work\\child-3.stop', image: 'OpenConsole.exe' }

  it('is asked to stop through its stop file, and nothing is ended by number', async () => {
    const s = system({ 4242: 'OpenConsole.exe' })
    // It ends itself once the file is there.
    const deps = { ...s.deps, touch: (f: string) => { s.touched.push(f); delete s.table[4242] } }
    expect(await askToStop(child, 5000, deps)).toBe(true)
    expect(s.touched).toEqual(['C:\\work\\child-3.stop'])
    expect(s.ended).toEqual([])
  })

  it('has gone once its pid runs another program, and that program is left alone', async () => {
    const s = system({ 4242: 'node.exe' })
    expect(await askToStop(child, 5000, s.deps)).toBe(true)
    expect(s.ended).toEqual([])
    expect(s.table[4242]).toBe('node.exe')
  })

  it('says so when it is still running when the wait ends', async () => {
    const s = system({ 4242: 'openconsole.exe' })
    expect(await askToStop(child, 30, { ...s.deps, pause: (ms) => new Promise((r) => setTimeout(r, ms / 10)) })).toBe(false)
    expect(s.ended).toEqual([])
  })

  it('a stop file that cannot be made (its folder is gone) is not an error, and nothing is ended by number', async () => {
    const s = system({ 4242: 'node.exe' })
    const deps = { ...s.deps, touch: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } }
    expect(await askToStop(child, 5000, deps)).toBe(true)
    expect(s.ended).toEqual([])
  })

  it('runs only while its pid runs its program, in any case', () => {
    expect(runsImage(4242, 'OpenConsole.exe', system({ 4242: 'OPENCONSOLE.EXE' }).deps)).toBe(true)
    expect(runsImage(4242, 'OpenConsole.exe', system({ 4242: 'node.exe' }).deps)).toBe(false)
    expect(runsImage(4242, 'OpenConsole.exe', system({}).deps)).toBe(false)
  })
})

describe('the stop script a program the test writes runs', () => {
  /** Runs stopWhen(i)'s line with `argv` and the files that exist, through one tick of its timer. */
  function tick(i: number, argv: string[], files: string[]) {
    let exitCode: number | undefined
    let timer: (() => void) | undefined
    runInNewContext(stopWhen(i), {
      process: { argv, exit: (c: number) => { exitCode = c } },
      require: (m: string) => {
        if (m !== 'fs') throw new Error(`no ${m}`)
        return { existsSync: (f: string) => files.includes(f) }
      },
      setInterval: (fn: () => void) => { timer = fn },
    })
    timer?.()
    return exitCode
  }

  it('exits once the file its argument names exists, and not before', () => {
    expect(tick(1, ['node', 'C:\\work\\a.stop'], [])).toBeUndefined()
    expect(tick(1, ['node', 'C:\\work\\a.stop'], ['C:\\work\\a.stop'])).toBe(0)
    expect(tick(3, ['node', 'x', 'y', 'C:\\work\\b.stop'], ['C:\\work\\b.stop'])).toBe(0)
    expect(tick(3, ['node', 'C:\\work\\b.stop', 'y', 'z'], ['C:\\work\\b.stop'])).toBeUndefined()
  })

  it('refuses an argument that is not one', () => {
    expect(() => stopWhen(0)).toThrow()
    expect(() => stopWhen(1.5)).toThrow()
  })
})

describe('a process the test did not write and knows only by number', () => {
  it('is ended while its pid runs that program', async () => {
    const s = system({ 4242: 'PING.EXE' })
    expect(await endIfImage(4242, 'ping.exe', 5000, s.deps)).toBe(true)
    expect(s.ended).toEqual([4242])
  })

  it('is left alone once its pid runs another program (a vitest worker, say), or none', async () => {
    const s = system({ 4242: 'node.exe' })
    expect(await endIfImage(4242, 'PING.EXE', 5000, s.deps)).toBe(false)
    expect(await endIfImage(4343, 'PING.EXE', 5000, s.deps)).toBe(false)
    expect(s.ended).toEqual([])
  })

  it('is never node.exe: a vitest worker is one too', async () => {
    const s = system({ 4242: 'node.exe' })
    await expect(endIfImage(4242, 'node.exe', 5000, s.deps)).rejects.toThrow(/stop file/)
    await expect(endIfImage(4242, 'NODE', 5000, s.deps)).rejects.toThrow(/stop file/)
    expect(s.ended).toEqual([])
  })
})

describe('reading the image name tasklist gives', () => {
  it('takes the image of the line for that pid', () => {
    expect(parseTasklistImage('"PING.EXE","4242","Console","1","4,512 K"\r\n', 4242)).toBe('PING.EXE')
  })

  it('has none when tasklist found no such process, or printed another pid', () => {
    expect(parseTasklistImage('INFO: No tasks are running which match the specified criteria.\r\n', 4242)).toBeUndefined()
    expect(parseTasklistImage('"PING.EXE","42420","Console","1","4,512 K"\r\n', 4242)).toBeUndefined()
    expect(parseTasklistImage('', 4242)).toBeUndefined()
  })
})

// Every process a test ends goes through the helper: a bare process.kill(pid)
// (any signal but 0, which only asks whether the pid answers) can end whatever
// has that pid by then.
describe('no test in the vitest suite ends a process by a bare pid', () => {
  const ROOT = join(__dirname, '..', '..', '..')
  const FOLDERS = ['tests/unit', 'tests/wp1', 'tests/integration', 'tests/helpers']
  const ALLOWED = new Set(['tests/helpers/started-processes.ts'])
  const SELF = relative(ROOT, __filename).split(sep).join('/')

  /** The text of each argument of the call whose '(' is at `open`, split at its own top-level commas. */
  function argsAt(text: string, open: number): string[] {
    const args: string[] = []
    let depth = 0
    let start = open + 1
    for (let i = open; i < text.length; i++) {
      const c = text[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        depth--
        if (depth === 0) {
          args.push(text.slice(start, i))
          return args.map((a) => a.trim()).filter((a) => a !== '')
        }
      } else if (c === ',' && depth === 1) {
        args.push(text.slice(start, i))
        start = i + 1
      }
    }
    return args
  }

  /** Every `process.kill(` call in `text` that is not `process.kill(x, 0)`, outside comment lines. */
  function bareKills(text: string): string[] {
    const found: string[] = []
    const lines = text.split('\n')
    for (const m of text.matchAll(/process\.kill\(/g)) {
      const line = text.slice(0, m.index).split('\n').length
      const src = lines[line - 1].trim()
      if (src.startsWith('//') || src.startsWith('*')) continue
      const args = argsAt(text, m.index + 'process.kill'.length)
      if (args.length >= 2 && args[1] === '0') continue
      found.push(`${line}: ${src}`)
    }
    return found
  }

  it('finds the bare kills it is looking for', () => {
    expect(bareKills('process.kill(pid)\nprocess.kill(pid, "SIGKILL")\nprocess.kill(Number(x), 0)\n// process.kill(pid)\nprocess.kill(a(b, c), 0)\nprocess.kill(a(b, 0))')).toEqual([
      '1: process.kill(pid)',
      '2: process.kill(pid, "SIGKILL")',
      '6: process.kill(a(b, 0))',
    ])
  })

  it('none outside the helper', () => {
    const offenders: string[] = []
    for (const folder of FOLDERS) {
      for (const entry of readdirSync(join(ROOT, folder), { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.(c|m)?[jt]sx?$/.test(entry.name)) continue
        const path = relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join('/')
        if (ALLOWED.has(path) || path === SELF) continue
        for (const k of bareKills(readFileSync(join(ROOT, path), 'utf-8'))) offenders.push(`${path}:${k}`)
      }
    }
    expect(offenders, 'end it through tests/helpers/started-processes.ts').toEqual([])
  })
})
