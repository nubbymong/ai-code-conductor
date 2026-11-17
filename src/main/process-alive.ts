/**
 * Whether a process is still there, asked the one way the main process asks
 * it: the PTY manager's help-folder runs (a run whose exit was not reported)
 * and the session helper's agent clear (a holder that does not answer while
 * the helper cannot list) both use this.
 */

/** Whether no process has this id any more (its exit may simply not have
 *  been reported). Signal 0 only asks; an id that exists, or one that cannot
 *  be asked about, is not gone. */
export function processGone(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ESRCH'
  }
}
