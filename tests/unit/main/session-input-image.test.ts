// A saved image into a Claude Code session on this computer, typed by main as
// the CLI's own paste (2.1.3-beta.16 section X1.2, aicc_planning #405):
// session-input submitImage, against fake ports and a fake clock. The fake
// write port stands in for writePty: one write up to 256 units, and above that
// the REAL 256-unit, 12 ms chunked writer (pty-chunked-write.ts).
//
//  - A Claude Code session on this computer, or held by the session helper:
//    the path as a bracketed paste (ESC [200~ path ESC [201~) in one write;
//    1,500 ms after it went, a space and the sentence; 700 ms after that,
//    exactly one Enter as its own write (probe P11's measured sequence). A
//    long path's sentence waits for its last slice.
//  - Not this door's: an SSH Persistent session answers not-taken, and
//    nothing is written. A Codex session goes to the Codex package's image
//    rule (2.1.3-beta.17 C6, session-input-codex-image.test.ts); with no
//    Codex package registered, as here, main reads no screen for it, so it
//    answers not-taken and nothing is written.
//  - A path or sentence with a control character (an ESC that would end the
//    paste early, a line break, DEL, a C1), an empty path or one over the cap,
//    or a sentence over its cap: refused, nothing written.
//  - Only into the terminal process the session had when it was asked: one
//    replaced during a wait gets nothing more, and neither does the new one.
//    No terminal process: session-gone, nothing written.
//  - One at a time with the prompt buttons: an image asked while a press is
//    in hand waits for that press's Enter, and a press asked after an image
//    waits for the image's Enter.
//  - The log names an image by its path's length only.
//  - Before the PTY manager registers its ports the door throws.
//
// Red on beta (no such door). Mutants this must catch: the paste markers
// dropped; the sentence typed before the paste settles; the Enter in the
// sentence's write; the Codex or tmux check dropped; the control-character
// check dropped; an Enter into a replaced terminal process; the image not
// chained with the prompt presses.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ infos: [] as string[] }))

// Since 2.1.3-beta.18 section 4 the door types a Claude Code session through
// the Claude Code package's own run screen; no Codex package is registered.
vi.mock('../../../src/main/providers', async () => {
  const { CLAUDE_RUN_SCREEN } = await import('../../../src/main/providers/claude/run-screen')
  return {
    getProvider: (id: string) => {
      if (id === 'claude') return { runScreen: CLAUDE_RUN_SCREEN }
      throw new Error('no such provider in this test')
    },
  }
})
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (msg: string) => { h.infos.push(msg) },
  logWarn: () => {},
  logError: () => {},
}))

const input = await import('../../../src/main/session-input')
const { runChunkedWrite, WRITE_CHUNK_SIZE } = await import('../../../src/main/pty-chunked-write')

class FakeRun {
  readonly writes: Array<{ at: number; data: string }> = []
  write(data: string): void { this.writes.push({ at: Date.now(), data }) }
}

const runs = new Map<string, FakeRun>()
const tmux = new Set<string>()
const codex = new Set<string>()

const ports = {
  write: (sessionId: string, data: string): void => {
    const run = runs.get(sessionId)
    if (!run) return
    if (data.length > WRITE_CHUNK_SIZE) runChunkedWrite(data, { write: (slice) => run.write(slice), isAlive: () => runs.get(sessionId) === run })
    else run.write(data)
  },
  run: (sessionId: string) => runs.get(sessionId) as never,
  tmuxWrapped: (sessionId: string) => tmux.has(sessionId),
  providerOf: (sessionId: string) => (codex.has(sessionId) ? 'codex' as const : 'claude' as const),
  isAskSession: () => false,
}

let n = 0
const fresh = (prefix: string): string => `${prefix}${++n}`
const startRun = (sessionId: string): FakeRun => {
  const run = new FakeRun()
  runs.set(sessionId, run)
  return run
}
const datas = (run: FakeRun): string[] => run.writes.map((w) => w.data)
const PATH = 'C:\\Users\\me\\AppData\\Local\\AI Code Conductor\\resources\\screenshots\\screenshot-2026-11-23-221500.jpg'
const SENTENCE = 'I just snapped a region of my screen \u2014 please view it.'

describe('before the PTY manager registers its ports', () => {
  it('the door throws, rather than drop the image silently', () => {
    expect(() => input.submitImage('early1', PATH, SENTENCE)).toThrow(/has not registered its ports/)
  })
})

describe('submitImage: a saved image as Claude Code\'s own paste', () => {
  beforeAll(() => { input.setSessionInputPorts(ports) })
  beforeEach(() => {
    vi.useFakeTimers()
    h.infos = []
  })
  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
    vi.useRealTimers()
  })

  it('the path as a bracketed paste, then 1.5 s later a space and the sentence, then 0.7 s later one Enter, each its own write', async () => {
    const id = fresh('cc')
    const run = startRun(id)
    const t0 = Date.now()
    const answer = input.submitImage(id, PATH, SENTENCE)
    await vi.advanceTimersByTimeAsync(0)
    expect(datas(run)).toEqual([`\u001b[200~${PATH}\u001b[201~`])
    await vi.advanceTimersByTimeAsync(1_499)
    expect(datas(run)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(datas(run)).toEqual([`\u001b[200~${PATH}\u001b[201~`, ` ${SENTENCE}`])
    await vi.advanceTimersByTimeAsync(699)
    expect(datas(run)).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(datas(run)).toEqual([`\u001b[200~${PATH}\u001b[201~`, ` ${SENTENCE}`, '\r'])
    expect(run.writes.map((w) => w.at - t0)).toEqual([0, 1_500, 2_200])
    expect(await answer).toEqual({ outcome: 'sent' })
    expect(input.IMAGE_PASTE_SETTLE_MS).toBe(1_500)
    expect(input.IMAGE_ENTER_DELAY_MS).toBe(700)
  })

  it('a long path goes in slices; the sentence waits 1.5 s after the last one', async () => {
    const id = fresh('cc')
    const run = startRun(id)
    const long = `C:\\${'d'.repeat(300)}\\shot.jpg`
    const answer = input.submitImage(id, long, SENTENCE)
    await vi.advanceTimersByTimeAsync(5_000)
    const at = run.writes.map((w) => w.at)
    const sentenceAt = run.writes.findIndex((w) => w.data === ` ${SENTENCE}`)
    expect(sentenceAt).toBeGreaterThan(1)
    expect(run.writes.slice(0, sentenceAt).map((w) => w.data).join('')).toBe(`\u001b[200~${long}\u001b[201~`)
    expect(at[sentenceAt] - at[sentenceAt - 1]).toBeGreaterThanOrEqual(1_500)
    expect(datas(run).at(-1)).toBe('\r')
    expect(datas(run).filter((d) => d === '\r')).toHaveLength(1)
    expect(await answer).toEqual({ outcome: 'sent' })
  })

  it.each([['a Codex session main reads no screen for', codex], ['an SSH Persistent session', tmux]] as const)('%s: not-taken, nothing written', async (_name, kindSet) => {
    const id = fresh('other')
    const run = startRun(id)
    kindSet.add(id)
    expect(await input.submitImage(id, PATH, SENTENCE)).toEqual({ outcome: 'not-taken' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.writes).toEqual([])
  })

  it.each([
    ['an ESC in the path (it would end the paste)', `C:\\x\u001b[201~\\shot.jpg`, SENTENCE],
    ['a line break in the path', 'C:\\x\n\\shot.jpg', SENTENCE],
    ['a DEL in the path', 'C:\\x\u007f.jpg', SENTENCE],
    ['a C1 character in the path', 'C:\\x\u009b.jpg', SENTENCE],
    ['a carriage return in the sentence', PATH, 'look\rrm -rf'],
    ['an ESC in the sentence', PATH, 'look \u001b[201~'],
    ['an empty path', '', SENTENCE],
    ['a path over the cap', `C:\\${'p'.repeat(4_096)}.jpg`, SENTENCE],
    ['a sentence over the cap', PATH, 's'.repeat(1_001)],
  ])('refuses %s: nothing written', async (_name, path, sentence) => {
    const id = fresh('bad')
    const run = startRun(id)
    expect(await input.submitImage(id, path, sentence)).toEqual({ outcome: 'not-sent', reason: 'refused-text' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.writes).toEqual([])
  })

  it('takes a path exactly at the cap', async () => {
    const id = fresh('cap')
    startRun(id)
    const answer = input.submitImage(id, 'p'.repeat(input.IMAGE_PATH_MAX_CHARS), SENTENCE)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await answer).toEqual({ outcome: 'sent' })
  })

  it('no terminal process: session-gone, nothing written', async () => {
    expect(await input.submitImage(fresh('none'), PATH, SENTENCE)).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
  })

  it.each([['after the paste', 1_000], ['after the sentence', 1_800]])('a process replaced %s gets nothing more, and the new one nothing', async (_name, at) => {
    const id = fresh('restart')
    const first = startRun(id)
    const answer = input.submitImage(id, PATH, SENTENCE)
    await vi.advanceTimersByTimeAsync(at)
    const second = startRun(id)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(datas(first)).not.toContain('\r')
    expect(second.writes).toEqual([])
    expect(await answer).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
  })

  it('one at a time with the prompt buttons: an image waits for a press\'s Enter, and a press for the image\'s', async () => {
    const id = fresh('order')
    const run = startRun(id)
    const press = input.submitPrompt(id, 'explain this file', 'send')
    const image = input.submitImage(id, PATH, SENTENCE)
    const after = input.submitPrompt(id, 'and this one', 'send')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(datas(run)).toEqual(['explain this file', '\r', `\u001b[200~${PATH}\u001b[201~`, ` ${SENTENCE}`, '\r', 'and this one', '\r'])
    expect(await press).toEqual({ outcome: 'sent' })
    expect(await image).toEqual({ outcome: 'sent' })
    expect(await after).toEqual({ outcome: 'sent' })
  })

  it('the log names the image by its path\'s length only', async () => {
    const id = fresh('log')
    startRun(id)
    const answer = input.submitImage(id, PATH, SENTENCE)
    await vi.advanceTimersByTimeAsync(5_000)
    await answer
    const line = h.infos.find((l) => l.startsWith('[image-paste]'))!
    expect(line).toBe(`[image-paste] ${id}: an image path of ${[...PATH].length} characters sent as a paste`)
    expect(h.infos.join('\n')).not.toContain('screenshot-')
    expect(h.infos.join('\n')).not.toContain('please view')
  })
})
