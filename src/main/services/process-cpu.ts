/**
 * process-cpu.ts: one child process's CPU share, for the measured cost on its
 * Services row (2.1.3-beta.4).
 *
 * The figures come from Electron's app.getAppMetrics(), handed in as
 * `metrics` so nothing here imports Electron and a test can give its own.
 * They are asked for at most once in `minIntervalMs` (5 s unless told),
 * however often the Services view is read: a read inside that time gets the
 * last answer as it was (a sample with the time it was taken, or none). A
 * sampler is for one child: its owner makes a new one for each child it
 * forks.
 *
 * The share is worked out from the process's own CPU seconds
 * (`cumulativeCPUUsage`) between two samples of the same process: CPU
 * seconds used over wall seconds passed, as a percent of one core. A
 * process's first sample has no sample before it, so it is the average
 * since the process started (its `creationTime`).
 *
 * So a share is the average over the time since the sample before it,
 * however long that was: nothing samples in the background, and a sample
 * is taken only when its owner asks. In the app the Tokenomics row is asked
 * on every Services push, and the hooks service's heartbeat (each second)
 * and the logging worker's (each 10 s) push while they run, so the time is
 * about 5 to 10 s. With neither running, the row is asked only when the
 * Services view is opened, and a share asked long after the one before is
 * the average over all of that time. `sampledAt` is when that time ended.
 *
 * Electron's own
 * `percentCPUUsage` is over the time since ANY caller last asked for the
 * metrics, so it is used only where the CPU seconds are not given, and only
 * from the second sample of a process on (its first answer is always 0).
 *
 * No default export (project convention).
 */

/** What a CPU sample needs of one entry of app.getAppMetrics(). */
export interface ProcessCpuMetric {
  pid: number
  /** When the process was made (ms since the epoch). */
  creationTime?: number
  cpu: { percentCPUUsage: number; cumulativeCPUUsage?: number }
}

export interface ProcessCpuSample {
  /** Share of one core, in percent, on average since the sample before (or
   *  since the process started, for its first). Absent when it cannot be
   *  worked out. */
  cpuPercent?: number
  /** When the sample was taken (ms since the epoch). */
  sampledAt: number
}

export interface ProcessCpuSampler {
  /** The process's CPU share now, or the last answer when it was given
   *  inside the interval. Null when the app does not list the process
   *  (gone, or not spawned yet), or the metrics cannot be read. */
  sample: (pid: number) => ProcessCpuSample | null
}

/** The least time between two samples. */
export const PROCESS_CPU_MIN_INTERVAL_MS = 5_000

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

interface Taken {
  pid: number
  /** A pid can be reused, so the process is its pid and its creation time. */
  creationTime: number | undefined
  cpuSeconds: number | undefined
  answer: ProcessCpuSample
}

export function createProcessCpuSampler(opts: {
  metrics: () => readonly ProcessCpuMetric[]
  now?: () => number
  minIntervalMs?: number
}): ProcessCpuSampler {
  const now = opts.now ?? (() => Date.now())
  const minIntervalMs = opts.minIntervalMs ?? PROCESS_CPU_MIN_INTERVAL_MS
  /** The last sample of a process the app listed: what the next one of the
   *  same process is measured against. */
  let last: Taken | null = null
  /** The last time the figures were asked for, for which process, and what
   *  that answered. */
  let asked: { pid: number; at: number; answer: ProcessCpuSample | null } | null = null

  const take = (pid: number, at: number): ProcessCpuSample | null => {
    let list: readonly ProcessCpuMetric[]
    try { list = opts.metrics() } catch { return null }
    const m = Array.isArray(list) ? list.find((x) => x && x.pid === pid) : undefined
    if (!m || !m.cpu) return null
    const creationTime = finite(m.creationTime) ? m.creationTime : undefined
    const cpuSeconds = finite(m.cpu.cumulativeCPUUsage) && m.cpu.cumulativeCPUUsage >= 0 ? m.cpu.cumulativeCPUUsage : undefined
    const before = last && last.pid === pid && last.creationTime === creationTime ? last : null
    let cpuPercent: number | undefined
    if (cpuSeconds !== undefined && before && before.cpuSeconds !== undefined) {
      const wallSeconds = (at - before.answer.sampledAt) / 1000
      if (wallSeconds > 0) cpuPercent = ((cpuSeconds - before.cpuSeconds) / wallSeconds) * 100
    } else if (cpuSeconds !== undefined && !before && creationTime !== undefined && at > creationTime) {
      cpuPercent = (cpuSeconds / ((at - creationTime) / 1000)) * 100
    } else if (cpuSeconds === undefined && before && finite(m.cpu.percentCPUUsage)) {
      cpuPercent = m.cpu.percentCPUUsage
    }
    // CPU seconds never go back for one process: a figure below zero is
    // not a share, and none is given.
    if (cpuPercent !== undefined && !(Number.isFinite(cpuPercent) && cpuPercent >= 0)) cpuPercent = undefined
    const answer: ProcessCpuSample = { ...(cpuPercent !== undefined ? { cpuPercent } : {}), sampledAt: at }
    last = { pid, creationTime, cpuSeconds, answer }
    return answer
  }

  return {
    sample: (pid) => {
      const at = now()
      if (!asked || asked.pid !== pid || at - asked.at >= minIntervalMs) asked = { pid, at, answer: take(pid, at) }
      return asked.answer ? { ...asked.answer } : null
    },
  }
}
