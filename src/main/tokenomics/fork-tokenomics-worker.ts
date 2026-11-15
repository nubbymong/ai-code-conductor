import { app, utilityProcess } from 'electron'
import { join } from 'node:path'
import type { TkWorkerTransport, ToTkWorker, FromTkWorker } from './tk-worker-transport'
import type { ProcessCpuMetric } from '../services/process-cpu'

export interface ForkedTkWorker {
  transport: TkWorkerTransport
  kill: () => void
  onExit: (cb: () => void) => void
  /** The worker's OS process id as it is now (2.1.3-beta.4): none until the
   *  utility process has spawned, and none again once it has exited. */
  pid?: () => number | null
}

export function forkTokenomicsWorker(): ForkedTkWorker {
  const entry = join(__dirname, 'tokenomics-worker.js')
  const proc = utilityProcess.fork(entry, [], { serviceName: 'ccc-tokenomics' })
  const transport: TkWorkerTransport = {
    post: (msg: ToTkWorker) => proc.postMessage(msg),
    onMessage: (handler) => proc.on('message', (m) => handler(m as FromTkWorker)),
    kill: () => { try { proc.kill() } catch { /* already dead */ } },
  }
  return {
    transport,
    kill: transport.kill,
    onExit: (cb) => proc.once('exit', cb),
    // Read each time it is asked: a utility process has its id only once it
    // has spawned, which is after fork() returns.
    pid: () => (typeof proc.pid === 'number' ? proc.pid : null),
  }
}

/** The app's process figures, for the worker's CPU share on its Services
 *  row (2.1.3-beta.4). The supervisor asks at most once in 5 s, and only
 *  while the Services view is read. */
export function appProcessMetrics(): ProcessCpuMetric[] {
  return app.getAppMetrics()
}
