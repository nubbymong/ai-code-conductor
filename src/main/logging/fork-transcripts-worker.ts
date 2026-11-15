import { utilityProcess } from 'electron'
import { join } from 'node:path'
import type { TranscriptsWorkerTransport, ToTranscriptsWorker, FromTranscriptsWorker } from './log-worker-transport'

/** A forked transcripts worker handle the supervisor drives.
 *  Speaks the v2 TranscriptsWorkerTransport (post/onMessage/kill) message shapes. */
export interface ForkedTranscriptsWorker {
  transport: TranscriptsWorkerTransport
  kill: () => void
  onExit: (cb: () => void) => void
  /** The OS pid of the forked utility process as it is now, for the Session
   *  logging card. A utility process has no pid until it has spawned, which is
   *  after fork() returns, so this is asked each time (the way the Tokenomics
   *  worker's pid is) and answers null before spawn, after exit and when the
   *  fork failed. */
  pid: () => number | null
  /** Called once when the process has spawned, so the supervisor can show the
   *  pid the moment it exists. Optional: a handle without it is read on the
   *  next health beat instead. */
  onSpawn?: (cb: () => void) => void
}

/** Fork the transcripts worker (out/main/transcripts-worker.js) as an Electron
 *  utilityProcess and adapt it to the transport the supervisor expects.
 *
 *  IMPORTANT: this forks by FILE PATH and must NEVER statically import
 *  `./transcripts-worker` — that module pulls in better-sqlite3, which must stay
 *  out of the main-process bundle (it lives only in the forked worker). */
export function forkTranscriptsWorker(): ForkedTranscriptsWorker {
  const entry = join(__dirname, 'transcripts-worker.js')
  const proc = utilityProcess.fork(entry, [], { serviceName: 'ccc-transcripts' })
  const transport: TranscriptsWorkerTransport = {
    post: (msg: ToTranscriptsWorker) => proc.postMessage(msg),
    onMessage: (handler: (m: FromTranscriptsWorker) => void) =>
      proc.on('message', (m) => handler(m as FromTranscriptsWorker)),
    kill: () => { try { proc.kill() } catch { /* already dead */ } },
  }
  return {
    transport,
    kill: transport.kill,
    onExit: (cb) => proc.once('exit', cb),
    // Read each time it is asked: utilityProcess exposes .pid only once the
    // child has spawned, which is after fork() returns.
    pid: () => (typeof proc.pid === 'number' ? proc.pid : null),
    onSpawn: (cb) => proc.once('spawn', cb),
  }
}
