// 2.1.3-beta.4: one child process's CPU share, for the measured cost on its
// Services row. The app's process figures are handed in (Electron's
// app.getAppMetrics() in the app); here they are made up, and nothing of
// Electron is called. A sample is taken at most once in five seconds. The
// share is the process's own CPU seconds between two samples over the wall
// time between them; its first sample is the average since it started.
import { describe, it, expect, vi } from 'vitest'
import { createProcessCpuSampler, PROCESS_CPU_MIN_INTERVAL_MS } from '../../../src/main/services/process-cpu'
import type { ProcessCpuMetric } from '../../../src/main/services/process-cpu'

const START = 1_800_000_000_000

function world() {
  const w = {
    t: START + 10_000,
    list: [] as ProcessCpuMetric[],
    calls: 0,
  }
  const metrics = vi.fn(() => { w.calls++; return w.list })
  const sampler = createProcessCpuSampler({ metrics, now: () => w.t })
  const proc = (pid: number, cpuSeconds: number | undefined, percent = 0, creationTime = START): ProcessCpuMetric =>
    ({ pid, creationTime, cpu: { percentCPUUsage: percent, ...(cpuSeconds !== undefined ? { cumulativeCPUUsage: cpuSeconds } : {}) } })
  return { w, metrics, sampler, proc }
}

describe('a child process\'s CPU share (2.1.3-beta.4)', () => {
  it('the first sample is the average since the process started', () => {
    const { w, sampler, proc } = world()
    // 1.5 s of CPU in the 10 s since it was made: 15% of one core.
    w.list = [proc(99, 0.2), proc(4321, 1.5)]
    expect(sampler.sample(4321)).toEqual({ cpuPercent: 15, sampledAt: START + 10_000 })
  })

  it('a later sample is the share between it and the one before', () => {
    const { w, sampler, proc } = world()
    w.list = [proc(4321, 1.5)]
    sampler.sample(4321)
    // 0.5 s more CPU over the next 10 s: 5%.
    w.t += 10_000
    w.list = [proc(4321, 2)]
    expect(sampler.sample(4321)).toEqual({ cpuPercent: 5, sampledAt: START + 20_000 })
    // Two cores' worth: over 100.
    w.t += 5_000
    w.list = [proc(4321, 12)]
    expect(sampler.sample(4321)?.cpuPercent).toBe(200)
  })

  it('a sample asked long after the one before is the average over all of that time, not the share of the last few seconds', () => {
    const { w, sampler, proc } = world()
    w.list = [proc(4321, 1.5)]
    sampler.sample(4321)
    // An hour on: 36 s more CPU over the hour is 1%, even when the last of
    // it was spent in the last few seconds.
    w.t += 3_600_000
    w.list = [proc(4321, 37.5)]
    expect(sampler.sample(4321)).toEqual({ cpuPercent: 1, sampledAt: START + 10_000 + 3_600_000 })
    // From there the next sample is over its own time again: 1 s in 10 s.
    w.t += 10_000
    w.list = [proc(4321, 38.5)]
    expect(sampler.sample(4321)?.cpuPercent).toBeCloseTo(10, 9)
  })

  it('samples at most once in five seconds, however often it is asked, and answers the last sample meanwhile', () => {
    const { w, metrics, sampler, proc } = world()
    w.list = [proc(4321, 1.5)]
    const first = sampler.sample(4321)
    w.list = [proc(4321, 9)]
    for (let i = 0; i < 20; i++) {
      w.t += Math.floor((PROCESS_CPU_MIN_INTERVAL_MS - 1) / 20)
      expect(sampler.sample(4321)).toEqual(first)
    }
    expect(metrics).toHaveBeenCalledTimes(1)
    w.t = (first?.sampledAt ?? 0) + PROCESS_CPU_MIN_INTERVAL_MS
    expect(sampler.sample(4321)?.sampledAt).toBe(w.t)
    expect(metrics).toHaveBeenCalledTimes(2)
  })

  it('a process the app does not list, figures that cannot be read, or none at all: no sample', () => {
    const { w, metrics, sampler, proc } = world()
    w.list = [proc(99, 1)]
    expect(sampler.sample(4321)).toBeNull()
    // No answer is an answer too: the app is not asked again inside the interval.
    w.list = [proc(4321, 1.5)]
    w.t += PROCESS_CPU_MIN_INTERVAL_MS - 1
    expect(sampler.sample(4321)).toBeNull()
    expect(metrics).toHaveBeenCalledTimes(1)
    w.t += 1
    expect(sampler.sample(4321)?.sampledAt).toBe(w.t)
    expect(metrics).toHaveBeenCalledTimes(2)
    const throwing = createProcessCpuSampler({ metrics: () => { throw new Error('no metrics') }, now: () => w.t })
    expect(throwing.sample(4321)).toBeNull()
    const nothing = createProcessCpuSampler({ metrics: () => undefined as unknown as ProcessCpuMetric[], now: () => w.t })
    expect(nothing.sample(4321)).toBeNull()
  })

  it('another process under the same id is sampled from its own start, not against the one before', () => {
    const { w, sampler, proc } = world()
    w.list = [proc(4321, 8)]
    sampler.sample(4321)
    w.t += 10_000
    // A new process with the old id, made 2 s ago, with 0.1 s of CPU: 5%.
    w.list = [proc(4321, 0.1, 0, w.t - 2_000)]
    expect(sampler.sample(4321)?.cpuPercent).toBeCloseTo(5, 9)
  })

  it('without CPU seconds, Electron\'s own share from the second sample on; its first answer is always 0, so none is given', () => {
    const { w, sampler, proc } = world()
    w.list = [proc(4321, undefined, 0)]
    expect(sampler.sample(4321)).toEqual({ sampledAt: START + 10_000 })
    w.t += 10_000
    w.list = [proc(4321, undefined, 7.5)]
    expect(sampler.sample(4321)).toEqual({ cpuPercent: 7.5, sampledAt: START + 20_000 })
  })

  it('a figure that cannot be a share is not given: CPU seconds that went back, or no start time to measure from', () => {
    const { w, sampler, proc } = world()
    w.list = [proc(4321, 5)]
    sampler.sample(4321)
    w.t += 10_000
    w.list = [proc(4321, 4)]
    expect(sampler.sample(4321)).toEqual({ sampledAt: START + 20_000 })
    const fresh = world()
    fresh.w.list = [{ pid: 4321, cpu: { percentCPUUsage: 0, cumulativeCPUUsage: 1 } }]
    expect(fresh.sampler.sample(4321)).toEqual({ sampledAt: START + 10_000 })
  })
})
