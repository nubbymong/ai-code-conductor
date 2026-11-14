// tests/unit/pty-chunked-write.test.ts
//
// R-010 regression: the chunked large-paste loop must (1) re-check liveness
// before EVERY chunk and stop when the session is gone / its PTY was replaced,
// and (2) never let a write to a dead PTY throw out of the timer callback (which
// the global uncaughtException handler re-throws → main crash).
import { describe, it, expect } from 'vitest'
import { runChunkedWrite } from '../../src/main/pty-chunked-write'

/** A synchronous scheduler so the whole loop runs in one tick (no fake timers). */
function syncSchedule(fn: () => void): void {
  fn()
}

describe('runChunkedWrite (R-010)', () => {
  it('writes every chunk in order while the session stays alive', () => {
    const data = 'x'.repeat(1000) // > one chunk
    const written: string[] = []
    runChunkedWrite(data, {
      write: (s) => written.push(s),
      isAlive: () => true,
      schedule: syncSchedule,
      chunkSize: 256,
    })
    expect(written.join('')).toBe(data)
    // 1000 / 256 = ceil → 4 chunks.
    expect(written).toHaveLength(4)
    expect(written.slice(0, 3).every((c) => c.length === 256)).toBe(true)
    expect(written[3].length).toBe(1000 - 256 * 3)
  })

  it('stops mid-paste (drops the rest) when the session dies — no further writes', () => {
    const data = 'y'.repeat(1000)
    const written: string[] = []
    let alive = true
    runChunkedWrite(data, {
      // Kill the session after the first chunk lands.
      write: (s) => { written.push(s); if (written.length === 1) alive = false },
      isAlive: () => alive,
      schedule: syncSchedule,
      chunkSize: 256,
    })
    // First chunk written; liveness check before chunk 2 bails → only 1 chunk.
    expect(written).toHaveLength(1)
    expect(written[0].length).toBe(256)
  })

  it('never re-enters write() after the PTY is replaced (isAlive false from the start)', () => {
    const written: string[] = []
    runChunkedWrite('z'.repeat(1000), {
      write: (s) => written.push(s),
      isAlive: () => false, // PTY already replaced before the first chunk
      schedule: syncSchedule,
    })
    expect(written).toHaveLength(0)
  })

  it('a throwing write (dead/destroyed PTY) is swallowed and stops the loop — does not propagate', () => {
    const data = 'w'.repeat(1000)
    const written: string[] = []
    expect(() =>
      runChunkedWrite(data, {
        write: (s) => {
          written.push(s)
          if (written.length === 2) throw new Error('ERR_STREAM_DESTROYED')
        },
        isAlive: () => true,
        schedule: syncSchedule,
        chunkSize: 256,
      }),
    ).not.toThrow()
    // Wrote chunk 1, then chunk 2 threw → loop stopped; no chunk 3/4.
    expect(written).toHaveLength(2)
  })

  it('a short write (single chunk) completes without scheduling', () => {
    const written: string[] = []
    let scheduled = 0
    runChunkedWrite('short', {
      write: (s) => written.push(s),
      isAlive: () => true,
      schedule: () => { scheduled++ },
      chunkSize: 256,
    })
    expect(written).toEqual(['short'])
    expect(scheduled).toBe(0) // nothing left to schedule
  })

  // onDone (Unit 5 P1.5): fires exactly once at every terminal outcome so the
  // envelope writer's Promise can resolve and the PasteQueue won't stall.
  it('calls onDone once when all bytes are written', () => {
    let dones = 0
    runChunkedWrite('x'.repeat(600), {
      write: () => {}, isAlive: () => true, schedule: syncSchedule, chunkSize: 256,
      onDone: () => { dones++ },
    })
    expect(dones).toBe(1)
  })
  it('calls onDone when the session bails mid-paste', () => {
    let dones = 0; let alive = true
    runChunkedWrite('y'.repeat(600), {
      write: () => { alive = false }, isAlive: () => alive, schedule: syncSchedule, chunkSize: 256,
      onDone: () => { dones++ },
    })
    expect(dones).toBe(1)
  })
  it('calls onDone when a write throws', () => {
    let dones = 0
    runChunkedWrite('w'.repeat(600), {
      write: () => { throw new Error('dead') }, isAlive: () => true, schedule: syncSchedule, chunkSize: 256,
      onDone: () => { dones++ },
    })
    expect(dones).toBe(1)
  })

  // #242 tier 4: onProgress is how pty-manager surfaces the ~1.27 MB
  // tmux-push transfer's progress via emitSshFlowState('running-setup',
  // 'staging tmux NN%') with zero new IPC channels. Mutation to prove this
  // can fail: comment out the `hooks.onProgress?.(offset, total)` call in
  // runChunkedWrite — progressCalls.length stays 0 and this test fails,
  // without touching any of the liveness/crash-safety cases above.
  it('calls onProgress with monotonically non-decreasing byte counts ending at data.length', () => {
    const data = 'p'.repeat(1000)
    const progressCalls: Array<[number, number]> = []
    runChunkedWrite(data, {
      write: () => {},
      isAlive: () => true,
      schedule: syncSchedule,
      chunkSize: 256,
      onProgress: (sent, total) => progressCalls.push([sent, total]),
    })
    // 1000 / 256 = ceil → 4 chunks → 4 progress calls, one per chunk.
    expect(progressCalls).toHaveLength(4)
    expect(progressCalls.every(([, total]) => total === data.length)).toBe(true)
    const sentCounts = progressCalls.map(([sent]) => sent)
    for (let i = 1; i < sentCounts.length; i++) {
      expect(sentCounts[i]).toBeGreaterThanOrEqual(sentCounts[i - 1])
    }
    expect(sentCounts[sentCounts.length - 1]).toBe(data.length)
  })

  // onProgress must reflect only bytes that ACTUALLY landed — a caller
  // computing a percentage from it must never see a total that outruns
  // reality when the session dies mid-transfer.
  it('stops calling onProgress once the session dies mid-write (never reports past the last real chunk)', () => {
    const data = 'q'.repeat(1000)
    const progressCalls: number[] = []
    let alive = true
    runChunkedWrite(data, {
      write: () => {},
      isAlive: () => alive,
      schedule: syncSchedule,
      chunkSize: 256,
      // Kill the session right after chunk 1's progress is reported —
      // chunk 2's liveness check (which runs BEFORE its write/onProgress)
      // then bails, so exactly one progress call total.
      onProgress: (sent) => { progressCalls.push(sent); alive = false },
    })
    expect(progressCalls).toEqual([256])
  })

  // #242 round-3 MINOR fix: onProgress is a NEW un-absorbed call on this
  // setTimeout-driven path (module doc comment: nothing may throw out of the
  // timer callback, because the global uncaughtException handler re-throws
  // and kills main). Mutation to prove this can fail: remove the try/catch
  // around `hooks.onProgress?.(offset, total)` in runChunkedWrite -- the
  // throw then propagates out of writeNext() and this test's `.not.toThrow()`
  // fails, without touching any of the liveness/crash-safety cases above.
  it('a throwing onProgress hook is swallowed and does not abort the write', () => {
    const written: string[] = []
    expect(() =>
      runChunkedWrite('r'.repeat(600), {
        write: (s) => written.push(s),
        isAlive: () => true,
        schedule: syncSchedule,
        chunkSize: 256,
        onProgress: () => { throw new Error('progress hook boom') },
      }),
    ).not.toThrow()
    // All 3 chunks (600 / 256 → ceil = 3) still landed -- the throwing hook
    // degraded progress reporting only, not the write itself.
    expect(written.join('')).toBe('r'.repeat(600))
    expect(written).toHaveLength(3)
  })
})

// A character outside the first 65,536 (an emoji, for one) is TWO units of the
// string, a high one and then a low one. Each chunk is turned into bytes on
// its own, so a chunk that ends between the two sends two broken marks in
// place of the character. The chunk grows by the one unit instead.
describe('runChunkedWrite keeps a character of two units in one chunk', () => {
  const EMOJI = String.fromCodePoint(0x1f600)
  const HIGH = EMOJI[0]
  const LOW = EMOJI[1]
  /** The bytes the PTY receives: each chunk encoded on its own, as a write does. */
  const bytesOf = (chunks: string[]): Buffer => Buffer.concat(chunks.map((c) => Buffer.from(c, 'utf8')))
  /** A unit that is half of a character with its other half not beside it. */
  const BROKEN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  const chunked = (data: string, chunkSize: number) => {
    const written: string[] = []
    const progress: Array<[number, number]> = []
    let dones = 0
    runChunkedWrite(data, {
      write: (s) => written.push(s),
      isAlive: () => true,
      schedule: syncSchedule,
      chunkSize,
      onProgress: (sent, total) => progress.push([sent, total]),
      onDone: () => { dones++ },
    })
    return { written, progress, dones }
  }

  it('the two units fall on a chunk boundary: the character is delivered whole', () => {
    expect(EMOJI).toHaveLength(2)
    const data = 'a'.repeat(255) + EMOJI + 'b'.repeat(300)
    const { written, dones } = chunked(data, 256)
    expect(written[0]).toBe('a'.repeat(255) + EMOJI)
    expect(written.some((c) => BROKEN.test(c))).toBe(false)
    expect(bytesOf(written).equals(Buffer.from(data, 'utf8'))).toBe(true)
    expect(written.join('')).toBe(data)
    expect(dones).toBe(1)
  })

  it('the chunk after it starts where the grown one ended, and nothing is sent twice or left out', () => {
    const data = 'a'.repeat(255) + EMOJI + 'b'.repeat(300)
    const { written, progress } = chunked(data, 256)
    expect(written.map((c) => c.length)).toEqual([257, 256, 44])
    expect(progress).toEqual([[257, 557], [513, 557], [557, 557]])
  })

  it('every boundary of a long paste of such characters: none is split', () => {
    // One letter in front puts a boundary in the middle of a character.
    const data = 'x' + EMOJI.repeat(700)
    const { written, progress } = chunked(data, 256)
    expect(written.some((c) => BROKEN.test(c))).toBe(false)
    expect(bytesOf(written).equals(Buffer.from(data, 'utf8'))).toBe(true)
    expect(written.join('')).toBe(data)
    expect(progress[progress.length - 1]).toEqual([data.length, data.length])
  })

  it('the character is the last thing in the data: one chunk, no read past the end', () => {
    const data = 'a'.repeat(255) + EMOJI
    const { written, progress, dones } = chunked(data, 256)
    expect(written).toEqual([data])
    expect(progress).toEqual([[257, 257]])
    expect(dones).toBe(1)
  })

  it('a chunk size of one cannot stall: the chunk only ever grows', () => {
    const data = 'a' + EMOJI + 'b' + EMOJI + EMOJI
    const { written, dones } = chunked(data, 1)
    expect(written).toEqual(['a', EMOJI, 'b', EMOJI, EMOJI])
    expect(dones).toBe(1)
  })

  it('a boundary between two whole characters is left where it is', () => {
    const data = EMOJI.repeat(300)
    const { written } = chunked(data, 256)
    expect(written.map((c) => c.length)).toEqual([256, 256, 88])
    expect(written.some((c) => BROKEN.test(c))).toBe(false)
  })

  it('plain text is chunked exactly as before, and its progress counts are the same', () => {
    const data = 'p'.repeat(1000)
    const { written, progress } = chunked(data, 256)
    expect(written.map((c) => c.length)).toEqual([256, 256, 256, 232])
    expect(progress).toEqual([[256, 1000], [512, 1000], [768, 1000], [1000, 1000]])
    // Characters of one unit that take several bytes are not grown for either.
    const accented = String.fromCodePoint(0xe9).repeat(600)
    expect(chunked(accented, 256).written.map((c) => c.length)).toEqual([256, 256, 88])
  })

  it('half a character with no other half beside it is passed on as it came: nothing grows', () => {
    // A high unit at the boundary followed by a letter, and a low unit after it.
    const data = 'a'.repeat(255) + HIGH + 'b'.repeat(255) + LOW + 'c'.repeat(10)
    const { written } = chunked(data, 256)
    expect(written.map((c) => c.length)).toEqual([256, 256, 10])
    expect(written.join('')).toBe(data)
  })

  // The chunk grows only for a pair: a high unit last in the chunk AND its low
  // unit next. A low unit that happens to come first after the boundary, with
  // no high unit before it, is not the second half of anything. Mutation to
  // prove this can fail: grow whenever the unit after the boundary is a low
  // one (the first chunk is then 257 units, and the lengths are 257, 256, 44).
  it('a lone low unit right after a boundary grows nothing: the chunk before it ends in a letter', () => {
    const data = 'a'.repeat(256) + LOW + 'b'.repeat(300)
    const { written, progress } = chunked(data, 256)
    expect(written.map((c) => c.length)).toEqual([256, 256, 45])
    expect(written.join('')).toBe(data)
    expect(progress).toEqual([[256, 557], [512, 557], [557, 557]])
  })

  // The other half of the same test: a high unit last in the chunk, with a
  // letter next. Mutation to prove this can fail: grow whenever the last unit
  // of the chunk is a high one (the lengths are then 257, 256, 44).
  it('a lone high unit right before a boundary grows nothing: the unit after it is a letter', () => {
    const data = 'a'.repeat(255) + HIGH + 'b'.repeat(301)
    const { written } = chunked(data, 256)
    expect(written.map((c) => c.length)).toEqual([256, 256, 45])
    expect(written.join('')).toBe(data)
  })

  it('a session that ends right after the grown chunk gets nothing more', () => {
    const data = 'a'.repeat(255) + EMOJI + 'b'.repeat(300)
    const written: string[] = []
    let alive = true
    runChunkedWrite(data, {
      write: (s) => { written.push(s); alive = false },
      isAlive: () => alive,
      schedule: syncSchedule,
      chunkSize: 256,
    })
    expect(written).toEqual(['a'.repeat(255) + EMOJI])
  })
})

// A chunk size below 1 took nothing from the data on each turn: the write
// never advanced, and a turn was scheduled every 12 ms for as long as the
// session lived. No caller passes one; the size is now at least 1, and a
// whole number of units.
describe('runChunkedWrite always advances, whatever chunk size it is given', () => {
  /** Runs the write with a scheduler that gives up after `limit` turns, so a
   *  write that never advances fails the test in place of hanging it. */
  const run = (data: string, chunkSize: number, limit = 50) => {
    const written: string[] = []
    const progress: number[] = []
    let dones = 0
    let turns = 0
    runChunkedWrite(data, {
      write: (s) => written.push(s),
      isAlive: () => true,
      schedule: (fn) => { if (++turns <= limit) fn() },
      chunkSize,
      onProgress: (sent) => progress.push(sent),
      onDone: () => { dones++ },
    })
    return { written, progress, dones, turns }
  }

  // Mutation to prove this can fail: use the size as given (the write then
  // sends '' on every turn: nothing is delivered and onDone never runs).
  it.each([0, -1, -256, 0.5, Number.NaN, Number.NEGATIVE_INFINITY])('a chunk size of %s is taken as 1: every unit is sent once, in order, and the write ends', (size) => {
    const { written, progress, dones, turns } = run('abcde', size)
    expect(written).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(progress).toEqual([1, 2, 3, 4, 5])
    expect(dones).toBe(1)
    expect(turns).toBe(4)
  })

  it('a chunk size with a fraction is taken as the whole number below it: the progress counts stay whole', () => {
    const { written, progress, dones } = run('abcdefg', 2.9)
    expect(written).toEqual(['ab', 'cd', 'ef', 'g'])
    expect(progress).toEqual([2, 4, 6, 7])
    expect(dones).toBe(1)
  })

  it('a chunk size larger than the data, or with no limit, is one chunk', () => {
    expect(run('abcde', 1000).written).toEqual(['abcde'])
    expect(run('abcde', Number.POSITIVE_INFINITY).written).toEqual(['abcde'])
  })

  it('a pair is still kept whole at a size taken as 1', () => {
    const emoji = String.fromCodePoint(0x1f600)
    const { written, dones } = run('a' + emoji + 'b', 0)
    expect(written).toEqual(['a', emoji, 'b'])
    expect(dones).toBe(1)
  })
})
