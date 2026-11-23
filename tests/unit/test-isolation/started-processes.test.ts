// Ending a process a test started never ends another process that has its pid
// now (tests/helpers/started-processes.ts). Pure: no process is started, read
// or ended; every process here is a stand-in object.
//
// The case it guards: installer-nsis-behaviour.test.ts ended each pid it had
// started if the pid still answered. The probes end most of those processes
// themselves, Windows gives the freed pids to new processes, and in CI one of
// them was a vitest worker running another file ("Worker exited unexpectedly",
// Windows part 2, runs 45046712982 and 45123495761).
import { describe, expect, it } from 'vitest'
import { endIfStillOurs, stillOurs, type EndDeps, type SpawnedProcess } from '../../helpers/started-processes'

/** A spawned process as a ChildProcess shows it; `kill` ends it at once. */
function spawned(running: boolean): SpawnedProcess & { kills: number } {
  const p = {
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

/** The system as these cases see it: which pid runs which program file, and every pid ended. */
function system(table: Record<number, string>) {
  const ended: number[] = []
  const deps: Partial<EndDeps> = {
    programOf: (pid) => table[pid],
    killPid: (pid) => {
      ended.push(pid)
      delete table[pid]
    },
    pidAnswers: (pid) => pid in table,
    pause: async () => {},
  }
  return { ended, deps }
}

const OURS = 'C:\\work\\ccc-nsis-unprobe-1\\helper\\0.1.0-abcdef123456\\conpty\\OpenConsole.exe'
const WORKER = 'C:\\hostedtoolcache\\windows\\node\\24.0.0\\x64\\node.exe'

describe('a process the test spawned', () => {
  it('is ended through its own handle while it runs', async () => {
    const p = spawned(true)
    const { ended, deps } = system({})
    await endIfStillOurs(p, 5000, deps)
    expect(p.kills).toBe(1)
    expect(p.signalCode).toBe('SIGTERM')
    expect(ended, 'no pid is ended by number').toEqual([])
  })

  it('once it has exited, nothing is ended, whatever has its pid now', async () => {
    const p = spawned(false)
    // Its old pid now answers for a vitest worker.
    const { ended, deps } = system({ 4242: WORKER })
    await endIfStillOurs(p, 5000, deps)
    expect(p.kills).toBe(0)
    expect(ended).toEqual([])
    expect(stillOurs(p)).toBe(false)
  })
})

describe('a process the test knows only by a pid read from a file', () => {
  it('is ended while that pid runs the program file it was started from', async () => {
    const { ended, deps } = system({ 4242: OURS })
    await endIfStillOurs({ pid: 4242, exe: OURS }, 5000, deps)
    expect(ended).toEqual([4242])
  })

  it('is ended when the two spellings of its program file differ only in case', async () => {
    const { ended, deps } = system({ 4242: OURS.toUpperCase() })
    await endIfStillOurs({ pid: 4242, exe: OURS }, 5000, deps)
    expect(ended).toEqual([4242])
  })

  it('is left alone when that pid now runs another program (a vitest worker, say)', async () => {
    const { ended, deps } = system({ 4242: WORKER })
    await endIfStillOurs({ pid: 4242, exe: OURS }, 5000, deps)
    expect(ended).toEqual([])
  })

  it('is left alone when no process has that pid', async () => {
    const { ended, deps } = system({})
    await endIfStillOurs({ pid: 4242, exe: OURS }, 5000, deps)
    expect(ended).toEqual([])
  })
})
