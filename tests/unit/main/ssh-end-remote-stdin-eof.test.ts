// F-QP-1: End's key exec ends its input as soon as it starts.
//
// End (and a close's file removal, the same exec with filesOnly) reaches a
// key/agent host over a separate `ssh ... <command>` run by execFile, which
// leaves the child's stdin an open pipe. On a Windows host the command is
// `powershell -NoProfile -NonInteractive -Command "...|node"`, and on the QP
// VM (Windows 11, Windows OpenSSH, key auth) the exec did not finish while its
// input stayed open (the remote PowerShell, or the ssh/sshd pair carrying it,
// waited for the input to end; which one is not settled): it ran to
// END_REMOTE_TIMEOUT_MS, End said 'failed', and the session's three files
// could stay in the remote ~/.claude. The same command run by hand exited 0
// in 0.4 s once its input was closed.
//
// The fake child here behaves like that host: it exits 0 only once its stdin
// is ended, and is otherwise killed at execFile's own timeout. The real
// endSshRemoteDetailed; child_process and node-pty faked, nothing is dialled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { SshRuntime } from '../../../src/shared/types'

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))

type FakeStdin = EventEmitter & { end: () => void; ended: boolean }
const h = vi.hoisted(() => ({
  execs: [] as Array<{ args: string[]; stdin: FakeStdin }>,
  /** true: the remote waits for end-of-input (the F-QP-1 host); false: it exits at once. */
  waitsForEof: true,
  /** The input stream's end() throws synchronously. */
  endThrows: false,
  ptySpawns: 0,
  logs: [] as string[],
}))

vi.mock('node-pty', () => ({
  spawn: () => {
    h.ptySpawns++
    throw new Error('__pty_not_expected__')
  },
}))
vi.mock('child_process', async (importOriginal) => {
  const { EventEmitter: Emitter } = await import('events')
  return {
    ...(await importOriginal<typeof import('child_process')>()),
    execFile: (_bin: string, args: string[], opts: { timeout?: number }, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      let finished = false
      const finish = (err: Error | null): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        queueMicrotask(() => cb?.(err, '', ''))
      }
      // execFile's own timeout: the child is killed and the callback gets the error.
      const timer = setTimeout(
        () => finish(Object.assign(new Error('Command failed: ssh (killed at the timeout)'), { killed: true, signal: 'SIGTERM', code: null })),
        opts?.timeout ?? 0,
      )
      const stdin = new Emitter() as FakeStdin
      stdin.ended = false
      stdin.end = () => {
        if (h.endThrows) throw new Error('write after end (sync)')
        stdin.ended = true
        finish(null)
      }
      h.execs.push({ args, stdin })
      if (!h.waitsForEof) finish(null)
      return { stdin, unref: () => {} }
    },
  }
})
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({ getWatchdogManager: () => null }))
vi.mock('../../../src/main/debug-logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/debug-logger')>()
  const capture = (...args: unknown[]) => { h.logs.push(args.map(String).join(' ')) }
  return { ...real, logDebug: capture, logTrace: capture, logInfo: capture, logWarn: capture, logError: capture }
})

const { endSshRemoteDetailed, _setSshTargetForTest } = await import('../../../src/main/pty-manager')
const { registerProvider } = await import('../../../src/main/providers')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')
const { buildWindowsRemoteSessionCleanupCommand } = await import('../../../src/main/providers/claude/ssh-shim')
registerProvider(new ClaudeProvider())

const SID = 'f0e1d2c3b4a5f0e1d2c3b4a5'
const KEY = { username: 'me', host: 'winbox.example.com', port: 22 }
/** END_REMOTE_TIMEOUT_MS in pty-manager.ts. */
const END_TIMEOUT_MS = 12000

beforeEach(() => {
  h.execs = []
  h.waitsForEof = true
  h.endThrows = false
  h.ptySpawns = 0
  h.logs = []
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const cases: Array<[string, { remoteOs?: 'unix' | 'windows'; runtime?: SshRuntime }, { filesOnly?: boolean } | undefined]> = [
  ['End on a Windows host', { remoteOs: 'windows' }, undefined],
  ['a close removing the files on a Windows host', { remoteOs: 'windows' }, { filesOnly: true }],
  ['End on a POSIX host (the same exec)', { remoteOs: 'unix' }, undefined],
  // The key branch's container shapes: a rootless container, and a rootful
  // one with no saved sudo password (`sudo -n` with the sudo probe). Both run
  // through the same execFile, so both get end-of-input too.
  ['End on a POSIX host with a rootless container', { remoteOs: 'unix', runtime: { type: 'container', container: 'dev' } }, undefined],
  ['End on a POSIX host with a rootful container and no saved sudo password', { remoteOs: 'unix', runtime: { type: 'container', container: 'dev', sudo: true } }, undefined],
]

describe('End\'s key exec gives the remote end-of-input (F-QP-1)', () => {
  for (const [name, target, opts] of cases) {
    // Mutation to prove this can fail: drop the input.end() after execFile
    // (the beta.2 shape) -- the input stays open, the fake remote waits, and
    // End is killed at its timeout and says 'failed'.
    it(`${name}: the input is ended as soon as the exec starts, and End completes`, async () => {
      _setSshTargetForTest(SID, { ...KEY, ...target })
      const result = endSshRemoteDetailed(SID, undefined, opts)
      // Read synchronously: before any output, exit, or timer.
      expect(h.execs).toHaveLength(1)
      const endedAtStart = h.execs[0].stdin.ended
      await vi.advanceTimersByTimeAsync(END_TIMEOUT_MS + 1)
      expect({ endedAtStart, result: await result }).toEqual({ endedAtStart: true, result: { outcome: 'completed' } })
      expect(h.ptySpawns).toBe(0)
      // A container case really took its container step over this exec.
      if (target.runtime) expect(h.logs.some((l) => l.includes('end-remote includes an in-container kill'))).toBe(true)
    })
  }

  it('the Windows command itself is unchanged', async () => {
    _setSshTargetForTest(SID, { ...KEY, remoteOs: 'windows' })
    const result = endSshRemoteDetailed(SID)
    expect(h.execs[0].args[h.execs[0].args.length - 1]).toBe(buildWindowsRemoteSessionCleanupCommand(SID))
    await vi.advanceTimersByTimeAsync(END_TIMEOUT_MS + 1)
    await result
  })
})

describe('an error on that input never escapes', () => {
  // Mutation to prove this can fail: drop the 'error' listener -- the emit
  // below then throws (an unhandled stream error would quit the app).
  it('an error the input reports later (the child already gone) is logged, not thrown', async () => {
    h.waitsForEof = false
    _setSshTargetForTest(SID, { ...KEY, remoteOs: 'windows' })
    const result = endSshRemoteDetailed(SID)
    const stdin = h.execs[0].stdin
    expect(() => stdin.emit('error', new Error('write EPIPE'))).not.toThrow()
    await expect(result).resolves.toEqual({ outcome: 'completed' })
    expect(h.logs.some((l) => l.includes('end-remote exec input closed with an error: write EPIPE'))).toBe(true)
  })

  // Mutation to prove this can fail: drop the try/catch around ending the
  // input -- the throw reaches the dispatch catch, which says 'failed' at once
  // although the exec went on to complete.
  it('a throw from ending the input does not fail an exec that completes', async () => {
    h.waitsForEof = false
    h.endThrows = true
    _setSshTargetForTest(SID, { ...KEY, remoteOs: 'windows' })
    let result: Promise<unknown> | undefined
    expect(() => { result = endSshRemoteDetailed(SID) }).not.toThrow()
    await expect(result).resolves.toEqual({ outcome: 'completed' })
    expect(h.logs.some((l) => l.includes('end-remote exec input could not be closed: write after end (sync)'))).toBe(true)
  })
})
