import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { runHelperCapture, parseCaptureLine, HELPER_CAPTURE_BOUND_MS, HELPER_CAPTURE_MAX_OUTPUT, type CaptureChild, type HelperCaptureDeps } from '../../../../src/main/snap/helper-capture'

/**
 * One run of the helper's capture mode (plan 2.1.3-beta.16 A1,
 * aicc_planning#401): its line read strictly, and the run bounded, a helper
 * that does not answer ended through its own handle. The child, the timer and
 * the clock are fakes: no process starts and no real time passes.
 * Not checked here: the real helper (snap-e2e runs it on the runner).
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kills = 0
  kill(): boolean { this.kills++; return true }
}

/** A fake timer the test fires by hand, and a clock it moves. */
function harness(child: FakeChild | (() => never), boundMs = 2000) {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  let clock = 1000
  const spawned: Array<{ file: string; args: string[] }> = []
  const deps: HelperCaptureDeps = {
    spawn: (file, args) => {
      spawned.push({ file, args })
      if (typeof child === 'function') return child()
      return child as unknown as CaptureChild
    },
    startTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false }
      timers.push(t)
      return () => { t.cancelled = true }
    },
    now: () => clock,
    boundMs,
  }
  return { deps, timers, spawned, advance: (ms: number) => { clock += ms } }
}

const LINE = '{"displays":[{"file":"display-1.bmp","left":0,"top":0,"width":1920,"height":1080,"dpi":144,"scale":150,"primary":true},{"file":"display-2.bmp","left":-1280,"top":0,"width":1280,"height":1024,"dpi":96,"scale":100,"primary":false}]}'

describe('runHelperCapture: one bounded run', () => {
  it('runs `capture --out <folder>` and answers its exit, its line and its time', async () => {
    const child = new FakeChild()
    const h = harness(child)
    const run = runHelperCapture('C:\\app\\aicc-helper.exe', 'C:\\data\\snap-capture\\press-1', h.deps)
    expect(h.spawned).toEqual([{ file: 'C:\\app\\aicc-helper.exe', args: ['capture', '--out', 'C:\\data\\snap-capture\\press-1'] }])
    expect(h.timers.map((t) => t.ms)).toEqual([2000])
    child.stdout.emit('data', Buffer.from(LINE.slice(0, 20)))
    child.stdout.emit('data', Buffer.from(`${LINE.slice(20)}\r\n`))
    h.advance(58)
    child.emit('close', 0)
    expect(await run).toEqual({ kind: 'exit', code: 0, stdout: `${LINE}\r\n`, stderr: '', ms: 58 })
    expect(h.timers[0].cancelled).toBe(true)
    expect(child.kills).toBe(0)
  })

  it('the app\'s bound is P21\'s 2 s', () => {
    expect(HELPER_CAPTURE_BOUND_MS).toBe(2000)
  })

  it('a helper that never answers is ended through its own handle when the bound passes, and the run says so', async () => {
    const child = new FakeChild()
    const h = harness(child, 1234)
    const run = runHelperCapture('helper.exe', 'f', h.deps)
    expect(h.timers.map((t) => t.ms)).toEqual([1234])
    h.advance(1234)
    h.timers[0].fn()
    expect(await run).toEqual({ kind: 'no-answer', ms: 1234 })
    expect(child.kills).toBe(1)
    // Its close after the kill changes nothing.
    child.emit('close', 1)
    expect(await run).toEqual({ kind: 'no-answer', ms: 1234 })
  })

  it('a start that fails answers start-failed, whether spawn throws or the child reports it', async () => {
    const throwing = harness(() => { throw new Error('spawn EACCES') })
    expect(await runHelperCapture('helper.exe', 'f', throwing.deps)).toMatchObject({ kind: 'start-failed', why: 'spawn EACCES' })
    expect(throwing.timers).toHaveLength(0)
    const child = new FakeChild()
    const reporting = harness(child)
    const run = runHelperCapture('helper.exe', 'f', reporting.deps)
    // A spawn error's message holds the helper's path: the run keeps its code.
    child.emit('error', Object.assign(new Error('spawn C:\\app\\helper.exe ENOENT'), { code: 'ENOENT' }))
    child.emit('close', -4058)
    expect(await run).toMatchObject({ kind: 'start-failed', why: 'ENOENT' })
    expect(reporting.timers[0].cancelled).toBe(true)
  })

  it('a helper that writes more than its one line is ended', async () => {
    const child = new FakeChild()
    const h = harness(child)
    const run = runHelperCapture('helper.exe', 'f', h.deps)
    child.stdout.emit('data', 'x'.repeat(HELPER_CAPTURE_MAX_OUTPUT + 1))
    expect(await run).toMatchObject({ kind: 'too-much-output' })
    expect(child.kills).toBe(1)
  })

  it('keeps the helper\'s message on a failed exit', async () => {
    const child = new FakeChild()
    const h = harness(child)
    const run = runHelperCapture('helper.exe', 'f', h.deps)
    child.stderr.emit('data', 'aicc-helper capture: no desktop to capture\n')
    child.emit('close', 3)
    expect(await run).toMatchObject({ kind: 'exit', code: 3, stdout: '', stderr: 'aicc-helper capture: no desktop to capture\n' })
  })
})

describe('parseCaptureLine: the helper\'s one line, read strictly', () => {
  it('reads each display in order, with its bounds in physical pixels and its scale', () => {
    expect(parseCaptureLine(`${LINE}\r\n`)).toEqual([
      { file: 'display-1.bmp', left: 0, top: 0, width: 1920, height: 1080, dpi: 144, scale: 150, primary: true },
      { file: 'display-2.bmp', left: -1280, top: 0, width: 1280, height: 1024, dpi: 96, scale: 100, primary: false },
    ])
  })

  it('reads nothing from anything else: two lines, no displays, a file that is a path or out of order, a size out of range, another key', () => {
    const one = (d: Record<string, unknown>) => JSON.stringify({ displays: [{ file: 'display-1.bmp', left: 0, top: 0, width: 10, height: 10, dpi: 96, scale: 100, primary: true, ...d }] })
    const bad = [
      '', 'not json', '[]', '{"displays":[]}', `${LINE}\n${LINE}`,
      JSON.stringify({ displays: [], extra: 1 }),
      one({ file: '..\\display-1.bmp' }), one({ file: 'C:\\x\\display-1.bmp' }), one({ file: 'display-2.bmp' }),
      one({ width: 0 }), one({ height: 16385 }), one({ left: 1.5 }), one({ top: '0' }), one({ dpi: 0 }), one({ scale: -1 }), one({ primary: 'yes' }),
      JSON.stringify({ displays: Array.from({ length: 17 }, (_, i) => ({ file: `display-${i + 1}.bmp`, left: 0, top: 0, width: 1, height: 1, dpi: 96, scale: 100, primary: i === 0 })) }),
    ]
    for (const text of bad) expect(parseCaptureLine(text), text).toBeNull()
    expect(parseCaptureLine(one({}))).toHaveLength(1)
  })
})

// The fake's kill is the ChildProcess method: a run never looks a pid up.
it('the run never reads the child\'s pid', async () => {
  const child = new FakeChild()
  Object.defineProperty(child, 'pid', { get: vi.fn(() => { throw new Error('the pid was read') }) })
  const h = harness(child)
  const run = runHelperCapture('helper.exe', 'f', h.deps)
  h.timers[0].fn()
  expect(await run).toMatchObject({ kind: 'no-answer' })
  expect(child.kills).toBe(1)
})
