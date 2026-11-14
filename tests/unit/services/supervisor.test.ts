// The one supervisor (src/main/services/supervisor.ts), on its own: the
// lifecycle the hooks, logging and usage-index services share. Each service's
// own behaviour on top of it is pinned in that service's tests.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Supervisor, SUPERVISOR_BACKOFFS_MS, SUPERVISOR_STABLE_RESET_MS } from '../../../src/main/services/supervisor'
import type { SupervisorOptions, SupervisedChild } from '../../../src/main/services/supervisor'

interface Kid extends SupervisedChild { exit: () => void; kills: number; n: number }

function harness(opts: Partial<SupervisorOptions<Kid>> & { killExits?: boolean } = {}) {
  const { killExits = false, ...supOpts } = opts
  const kids: Kid[] = []
  const events: string[] = []
  const fork = vi.fn((): Kid => {
    const kid: Kid = {
      n: kids.length, kills: 0, exit: () => {},
      kill: () => { kid.kills++; if (killExits) kid.exit() },
      onExit: (cb) => { kid.exit = cb },
    }
    kids.push(kid)
    return kid
  })
  const sup: Supervisor<Kid> = new Supervisor<Kid>({
    forkChild: fork,
    onSpawn: (c) => events.push(`spawn ${c.n} restarts=${sup.getRestarts()}`),
    onExit: () => events.push(`exit wanted=${sup.isWanted()}`),
    onExhausted: () => events.push(`exhausted latched=${sup.isExhausted()}`),
    onRestartCount: (n) => events.push(`count ${n}`),
    onBudgetRestored: () => events.push('restored'),
    ...supOpts,
  })
  const last = () => kids[kids.length - 1]
  return { sup, fork, kids, events, last }
}

describe('Supervisor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the shared numbers are the ones the three copies had', () => {
    expect(SUPERVISOR_BACKOFFS_MS).toEqual([250, 1000, 4000, 4000, 4000])
    expect(SUPERVISOR_STABLE_RESET_MS).toBe(300_000)
  })

  it('start forks one child and tells the service, wanted on', () => {
    const h = harness()
    h.sup.start()
    expect(h.fork).toHaveBeenCalledTimes(1)
    expect(h.events).toEqual(['spawn 0 restarts=0'])
    expect(h.sup.isWanted()).toBe(true)
  })

  it('a crash is reported, then restarted after the backoff with the count told first', () => {
    const h = harness()
    h.sup.start()
    h.kids[0].exit()
    expect(h.events.slice(1)).toEqual(['exit wanted=true'])
    vi.advanceTimersByTime(249)
    expect(h.fork).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(h.events.slice(2)).toEqual(['count 1', 'spawn 1 restarts=1'])
  })

  it('the backoff walks 250, 1000, 4000, 4000, 4000 and then the budget is spent', () => {
    const h = harness()
    h.sup.start()
    const waits: number[] = []
    for (let i = 0; i < 5; i++) {
      h.last().exit()
      let waited = 0
      while (h.fork.mock.calls.length === i + 1) { vi.advanceTimersByTime(50); waited += 50 }
      waits.push(waited)
    }
    expect(waits).toEqual([250, 1000, 4000, 4000, 4000])
    h.last().exit()                    // the sixth exit: five restarts are spent
    expect(h.events.at(-1)).toBe('exhausted latched=true')
    vi.advanceTimersByTime(60_000)
    expect(h.fork).toHaveBeenCalledTimes(6)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('maxRestarts 0 means the first exit is the end', () => {
    const h = harness({ maxRestarts: 0 })
    h.sup.start()
    h.kids[0].exit()
    expect(h.events).toEqual(['spawn 0 restarts=0', 'exit wanted=true', 'exhausted latched=true'])
    expect(h.sup.isExhausted()).toBe(true)
  })

  it('once the budget is spent, a later exit (even one fired by a kill while falling back) is ignored', () => {
    const fallBack: { run: () => void } = { run: () => {} }
    const h = harness({ maxRestarts: 0, killExits: true, onExhausted: () => fallBack.run() })
    fallBack.run = () => { h.last().kill() }
    h.sup.start()
    h.kids[0].exit()
    expect(h.kids[0].kills).toBe(1)
    expect(h.events.filter((e) => e.startsWith('exit'))).toHaveLength(1)
    h.kids[0].exit()
    expect(h.events.filter((e) => e.startsWith('exit'))).toHaveLength(1)
    expect(h.fork).toHaveBeenCalledTimes(1)
  })

  it('an exit from a child that has been replaced is not the current child\'s', () => {
    const h = harness()
    h.sup.start()
    h.kids[0].exit()
    vi.advanceTimersByTime(250)
    const before = h.events.length
    h.kids[0].exit()                   // the old child, again
    vi.advanceTimersByTime(60_000)
    expect(h.events.slice(before)).toEqual([])
    expect(h.fork).toHaveBeenCalledTimes(2)
  })

  describe('desired state', () => {
    it('off: a crash is reported and nothing is forked; on again forks one, uncounted', () => {
      const h = harness()
      h.sup.start()
      expect(h.sup.setWanted(false)).toBe(false)
      h.kids[0].exit()
      vi.advanceTimersByTime(60_000)
      expect(h.events.slice(1)).toEqual(['exit wanted=false'])
      expect(h.fork).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      expect(h.sup.setWanted(true)).toBe(true)
      expect(h.events.at(-1)).toBe('spawn 1 restarts=0')
    })

    it('off leaves a running child alone, and on again forks nothing', () => {
      const h = harness()
      h.sup.start()
      h.sup.setWanted(false)
      expect(h.kids[0].kills).toBe(0)
      expect(h.sup.setWanted(true)).toBe(false)
      expect(h.fork).toHaveBeenCalledTimes(1)
    })

    it('off drops a pending restart', () => {
      const h = harness()
      h.sup.start()
      h.kids[0].exit()
      h.sup.setWanted(false)
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(60_000)
      expect(h.fork).toHaveBeenCalledTimes(1)
    })

    it('on while a restart is on its way forks nothing itself', () => {
      const h = harness()
      h.sup.start()
      h.kids[0].exit()
      expect(h.sup.setWanted(true)).toBe(false)
      expect(h.fork).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(250)
      expect(h.fork).toHaveBeenCalledTimes(2)
    })

    it('on forks nothing before start, after shutdown, or with the budget spent', () => {
      const a = harness()
      expect(a.sup.setWanted(true)).toBe(false)
      expect(a.fork).not.toHaveBeenCalled()

      const b = harness()
      b.sup.start(); b.sup.setWanted(false); b.kids[0].exit(); b.sup.shutdown()
      expect(b.sup.setWanted(true)).toBe(false)
      expect(b.fork).toHaveBeenCalledTimes(1)

      const c = harness({ maxRestarts: 0 })
      c.sup.start(); c.kids[0].exit()
      c.sup.setWanted(false)
      expect(c.sup.setWanted(true)).toBe(false)
      expect(c.fork).toHaveBeenCalledTimes(1)
    })

    it('a manual restart is declined while off, and does nothing', () => {
      const h = harness()
      h.sup.start()
      h.sup.setWanted(false)
      expect(h.sup.restartRefusal()).toBe('disabled')
      expect(h.sup.restart()).toBe(false)
      expect(h.kids[0].kills).toBe(0)
      expect(h.fork).toHaveBeenCalledTimes(1)
      h.sup.setWanted(true)
      expect(h.sup.restartRefusal()).toBeNull()
    })
  })

  describe('manual restart', () => {
    it('is a clean slate: count told as 0, old child killed, new one forked, pending restart dropped', () => {
      const h = harness()
      h.sup.start()
      h.kids[0].exit(); vi.advanceTimersByTime(250)
      h.kids[1].exit()                 // a second restart is 1000ms away
      const before = h.events.length
      expect(h.sup.restart()).toBe(true)
      expect(h.events.slice(before)).toEqual(['count 0', 'spawn 2 restarts=0'])
      expect(h.kids[1].kills).toBe(1)
      vi.advanceTimersByTime(60_000)
      expect(h.fork).toHaveBeenCalledTimes(3)
      h.kids[2].exit()
      vi.advanceTimersByTime(250)      // the backoff started over too
      expect(h.fork).toHaveBeenCalledTimes(4)
    })

    it('drops the old child\'s stable period with it', () => {
      const h = harness()
      h.sup.start()
      h.sup.markUp()
      expect(vi.getTimerCount()).toBe(1)
      h.sup.restart()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('forgives a spent budget', () => {
      const h = harness({ maxRestarts: 0 })
      h.sup.start()
      h.kids[0].exit()
      expect(h.sup.isExhausted()).toBe(true)
      expect(h.sup.restart()).toBe(true)
      expect(h.sup.isExhausted()).toBe(false)
      expect(h.fork).toHaveBeenCalledTimes(2)
    })

    it('a kill that fires the old child\'s exit at once does not count as a crash of the new one', () => {
      const h = harness({ killExits: true })
      h.sup.start()
      const before = h.events.length
      expect(h.sup.restart()).toBe(true)
      expect(h.events.slice(before)).toEqual(['count 0', 'spawn 1 restarts=0'])
      vi.advanceTimersByTime(60_000)
      expect(h.fork).toHaveBeenCalledTimes(2)
    })

    it('is declined once shutting down', () => {
      const h = harness()
      h.sup.start()
      h.sup.shutdown()
      expect(h.sup.restartRefusal()).toBe('shutting-down')
      expect(h.sup.restart()).toBe(false)
      expect(h.fork).toHaveBeenCalledTimes(1)
    })
  })

  describe('the budget recovers after a stable period', () => {
    it('up for the period: count and backoff go back to zero, and the service is told', () => {
      const h = harness()
      h.sup.start()
      h.kids[0].exit(); vi.advanceTimersByTime(250)
      h.sup.markUp()
      vi.advanceTimersByTime(SUPERVISOR_STABLE_RESET_MS - 1)
      expect(h.sup.getRestarts()).toBe(1)
      const before = h.events.length
      vi.advanceTimersByTime(1)
      expect(h.sup.getRestarts()).toBe(0)
      expect(h.events.slice(before)).toEqual(['count 0', 'restored'])
      h.kids[1].exit()
      vi.advanceTimersByTime(250)      // first backoff step again
      expect(h.fork).toHaveBeenCalledTimes(3)
    })

    it('nothing used, nothing said', () => {
      const h = harness()
      h.sup.start()
      h.sup.markUp()
      vi.advanceTimersByTime(SUPERVISOR_STABLE_RESET_MS)
      expect(h.events).toEqual(['spawn 0 restarts=0'])
    })

    it('never up: nothing is given back', () => {
      const h = harness()
      h.sup.start()
      h.kids[0].exit(); vi.advanceTimersByTime(250)
      vi.advanceTimersByTime(10 * SUPERVISOR_STABLE_RESET_MS)
      expect(h.sup.getRestarts()).toBe(1)
    })

    it('an exit inside the period stops it; the next child starts its own', () => {
      const h = harness()
      h.sup.start()
      h.kids[0].exit(); vi.advanceTimersByTime(250)
      h.sup.markUp()
      vi.advanceTimersByTime(SUPERVISOR_STABLE_RESET_MS - 1000)
      h.kids[1].exit(); vi.advanceTimersByTime(1000)
      expect(h.fork).toHaveBeenCalledTimes(3)
      vi.advanceTimersByTime(SUPERVISOR_STABLE_RESET_MS)
      expect(h.sup.getRestarts()).toBe(2)   // the new child never said it was up
      h.sup.markUp()
      vi.advanceTimersByTime(SUPERVISOR_STABLE_RESET_MS)
      expect(h.sup.getRestarts()).toBe(0)
    })

    it('a second report from the same child does not start the period over', () => {
      const h = harness({ stableResetMs: 1000 })
      h.sup.start()
      h.kids[0].exit(); vi.advanceTimersByTime(250)
      h.sup.markUp()
      vi.advanceTimersByTime(900)
      h.sup.markUp()
      expect(vi.getTimerCount()).toBe(1)   // and leaves no second timer behind
      vi.advanceTimersByTime(100)
      expect(h.sup.getRestarts()).toBe(0)
    })

    it('resetBackoffOnUp: an up report starts the backoff over at once, the count waits for the period', () => {
      const h = harness({ resetBackoffOnUp: true })
      h.sup.start()
      h.kids[0].exit(); vi.advanceTimersByTime(250)
      h.sup.markUp()
      h.kids[1].exit(); vi.advanceTimersByTime(250)
      expect(h.fork).toHaveBeenCalledTimes(3)
      expect(h.sup.getRestarts()).toBe(2)
    })

    it('without resetBackoffOnUp an up report leaves the backoff where it was', () => {
      const h = harness()
      h.sup.start()
      h.kids[0].exit(); vi.advanceTimersByTime(250)
      h.sup.markUp()
      h.kids[1].exit(); vi.advanceTimersByTime(999)
      expect(h.fork).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(1)
      expect(h.fork).toHaveBeenCalledTimes(3)
    })

    it('an up report from a child that has exited, after shutdown, or with the budget spent arms nothing', () => {
      const a = harness()
      a.sup.start(); a.kids[0].exit(); a.sup.setWanted(false)
      a.sup.markUp()
      expect(vi.getTimerCount()).toBe(0)

      const b = harness()
      b.sup.start(); b.sup.shutdown()
      b.sup.markUp()
      expect(vi.getTimerCount()).toBe(0)

      const c = harness({ maxRestarts: 0 })
      c.sup.start(); c.kids[0].exit()
      c.sup.markUp()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('shutdown', () => {
    it('is final: no timer is left, a pending restart never fires, a late exit is ignored', () => {
      const h = harness()
      h.sup.start()
      h.sup.markUp()
      h.kids[0].exit()                 // a restart is pending
      h.sup.shutdown()
      expect(h.sup.isShuttingDown()).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(60_000)
      expect(h.fork).toHaveBeenCalledTimes(1)
    })

    it('leaves the kill to the service, and reports no exit after it', () => {
      const h = harness()
      h.sup.start()
      h.sup.markUp()
      h.sup.shutdown()
      expect(vi.getTimerCount()).toBe(0)
      expect(h.kids[0].kills).toBe(0)
      h.kids[0].exit()
      expect(h.events).toEqual(['spawn 0 restarts=0'])
    })
  })
})
