// 2.1.3-beta.17 C6 (aicc_planning#415): a saved image into a Codex session on
// this computer through main's image door (session-input submitImage), which
// hands it to the Codex package's image rule through the registry
// (SessionRunScreen.submitImage), against fake ports and a fake run screen.
//
//  - A Codex session: the run screen's image rule is asked once, with the
//    path, the sentence and a prompt button's ready wait; nothing is written
//    through the write port. Pasted: sent.
//  - Not pasted (Codex busy, no placeholder, the sentence not confirmed, a
//    prompt up): not-taken, so the renderer types today's line by its own
//    Codex rule; one log line says why. A paste the rule left
//    at the prompt (a prompt came up after it): not-taken with left, so the
//    renderer types nothing and says the image is at the prompt; the others
//    carry no left.
//  - The session gone, or a path the rule refuses: not sent, as for Claude.
//  - Main reads no screen for the session: not-taken.
//  - A path with a control character: refused before the rule is asked.
//  - One at a time with the prompt buttons: an image waits for a press's
//    answer, and a press for the image's.
//  - A terminal process replaced while the image waited: the rule is not asked.
//  - The log names the image by its path's length only.
//
// Red on beta: a Codex session answered not-taken and the rule was never
// asked. Mutants this must catch: the Codex branch dropped (not-taken for
// every Codex session); the image not chained with the prompt presses;
// `left` dropped from main's answer.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  infos: [] as string[],
  screen: {
    has: (_id: string) => true,
    submit: vi.fn(),
    submitImage: vi.fn(),
  },
}))

// Since 2.1.3-beta.18 section 4 the door reaches the image rule through the
// Codex package's door members, built here over the fake run screen.
vi.mock('../../../src/main/providers', async () => {
  const { codexDoorMembers } = await import('../../../src/main/providers/codex/run-screen-doors')
  return {
    getProvider: (id: string) => {
      if (id !== 'codex') throw new Error('no such provider in this test')
      return { runScreen: { ...h.screen, ...codexDoorMembers(h.screen as never) } }
    },
  }
})
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (msg: string) => { h.infos.push(msg) },
  logWarn: () => {},
  logError: () => {},
}))

const input = await import('../../../src/main/session-input')

class FakeRun {
  readonly writes: string[] = []
  write(data: string): void { this.writes.push(data) }
}
const runs = new Map<string, FakeRun>()
const ports = {
  write: (sessionId: string, data: string): void => { runs.get(sessionId)?.write(data) },
  run: (sessionId: string) => runs.get(sessionId) as never,
  tmuxWrapped: () => false,
  providerOf: () => 'codex' as const,
  isAskSession: () => false,
}

let n = 0
const fresh = (): string => `cx${++n}`
const startRun = (sessionId: string): FakeRun => { const r = new FakeRun(); runs.set(sessionId, r); return r }
const PATH = 'C:\\Users\\me\\AppData\\Local\\AI Code Conductor\\resources\\screenshots\\screenshot-2026-11-24-061500.jpg'
const SENTENCE = 'I just snapped a region of my screen - please view it.'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('submitImage: a Codex session', () => {
  beforeAll(() => { input.setSessionInputPorts(ports) })
  beforeEach(() => {
    h.infos = []
    h.screen.has = () => true
    h.screen.submit.mockReset()
    h.screen.submitImage.mockReset()
  })
  afterEach(() => { vi.useRealTimers() })

  it('the Codex image rule is asked once, with a prompt button\'s ready wait; pasted is sent, and nothing goes through the write port', async () => {
    const id = fresh()
    const run = startRun(id)
    h.screen.submitImage.mockResolvedValue({ pasted: true })
    expect(await input.submitImage(id, PATH, SENTENCE)).toEqual({ outcome: 'sent' })
    expect(h.screen.submitImage).toHaveBeenCalledTimes(1)
    expect(h.screen.submitImage).toHaveBeenCalledWith(id, PATH, SENTENCE, { readyWaitMs: 5_000 })
    expect(input.IMAGE_CODEX_READY_WAIT_MS).toBe(input.PROMPT_CODEX_READY_WAIT_MS)
    expect(run.writes).toEqual([])
  })

  it.each([
    ['Codex busy for the whole wait', 'busy-timeout', false],
    ['no placeholder after the paste (taken back)', 'no-placeholder', false],
    ['the sentence not confirmed', 'not-drawn', false],
    ['a prompt up after the paste', 'prompt-on-screen', true],
  ] as const)('%s: not-taken (with left when the paste may still be at the prompt); one log line says why', async (_name, reason, left) => {
    const id = fresh()
    startRun(id)
    h.screen.submitImage.mockResolvedValue({ pasted: false, reason, left })
    expect(await input.submitImage(id, PATH, SENTENCE)).toStrictEqual(left ? { outcome: 'not-taken', left: true } : { outcome: 'not-taken' })
    const lines = h.infos.filter((l) => l.startsWith(`[image-paste] ${id}:`))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(reason)
    if (left) expect(lines[0]).toContain('may still be at the prompt')
    expect(lines[0].includes('its own way')).toBe(!left)
  })

  it.each([['session-gone'], ['refused-text']] as const)('the rule answers %s: not sent', async (reason) => {
    const id = fresh()
    startRun(id)
    h.screen.submitImage.mockResolvedValue({ pasted: false, reason, left: false })
    expect(await input.submitImage(id, PATH, SENTENCE)).toEqual({ outcome: 'not-sent', reason })
  })

  it('main reads no screen for the session: not-taken, and the rule is not asked', async () => {
    const id = fresh()
    startRun(id)
    h.screen.has = () => false
    expect(await input.submitImage(id, PATH, SENTENCE)).toEqual({ outcome: 'not-taken' })
    expect(h.screen.submitImage).not.toHaveBeenCalled()
  })

  it('a path with a control character: refused before the rule is asked', async () => {
    const id = fresh()
    startRun(id)
    expect(await input.submitImage(id, `C:\\x\u001b[201~.jpg`, SENTENCE)).toEqual({ outcome: 'not-sent', reason: 'refused-text' })
    expect(h.screen.submitImage).not.toHaveBeenCalled()
  })

  it('one at a time with the prompt buttons: an image waits for a press\'s answer, and a press for the image\'s', async () => {
    const id = fresh()
    startRun(id)
    const press = deferred<{ delivered: boolean }>()
    const image = deferred<{ pasted: boolean }>()
    const order: string[] = []
    h.screen.submit.mockImplementation((_s: string, text: string) => { order.push(`press ${text}`); return text === 'first' ? press.promise : Promise.resolve({ delivered: true }) })
    h.screen.submitImage.mockImplementation(() => { order.push('image'); return image.promise })
    const a = input.submitPrompt(id, 'first', 'send')
    const b = input.submitImage(id, PATH, SENTENCE)
    const c = input.submitPrompt(id, 'after', 'send')
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['press first'])
    press.resolve({ delivered: true })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['press first', 'image'])
    image.resolve({ pasted: true })
    expect(await a).toEqual({ outcome: 'sent' })
    expect(await b).toEqual({ outcome: 'sent' })
    expect(await c).toEqual({ outcome: 'sent' })
    expect(order).toEqual(['press first', 'image', 'press after'])
  })

  it('a terminal process replaced while the image waited: the rule is not asked, session gone', async () => {
    const id = fresh()
    startRun(id)
    const press = deferred<{ delivered: boolean }>()
    h.screen.submit.mockImplementation(() => press.promise)
    const a = input.submitPrompt(id, 'first', 'send')
    const b = input.submitImage(id, PATH, SENTENCE)
    startRun(id)
    press.resolve({ delivered: true })
    await a
    expect(await b).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
    expect(h.screen.submitImage).not.toHaveBeenCalled()
  })

  it('the log names the image by its path\'s length only', async () => {
    const id = fresh()
    startRun(id)
    h.screen.submitImage.mockResolvedValue({ pasted: true })
    await input.submitImage(id, PATH, SENTENCE)
    expect(h.infos.join('\n')).toContain(`[image-paste] ${id}: an image path of ${[...PATH].length} characters sent as a paste`)
    expect(h.infos.join('\n')).not.toContain('screenshot-')
    expect(h.infos.join('\n')).not.toContain('please view')
  })
})
