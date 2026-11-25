// 2.1.3-beta.18 section 4 (aicc_planning#432; ADR-030 component rows 3 and
// 14): one input seam. Each door of the session input module types a session
// through the run screen of the provider that runs it, and a provider with
// no rule for a door gets nothing typed there: never another provider's
// typing. Proven here with a stand-in third provider, over fake ports, beside
// a registered Claude Code package (the app always has one).
//
//  - No rule: at the four doors that fell through to Claude Code's typing on
//    the base (the Watchdog's retry, a prompt button in both modes, an image,
//    a canvas marker) nothing is written and nothing is held, each answer says
//    so, and one log line names the door. The Ask door types nothing either
//    (on the base it typed nothing for a session that was not Codex).
//  - A rule: each of the five doors calls the third provider's own member,
//    once, with the door's waits, and what the member types goes through the
//    write port into the run the door was asked for.
//  - The module names no provider: no 'claude' or 'codex' string in it.
//  - The PTY manager's close and resize reach every registered provider's run
//    screen, and skip one the registry does not have.
//
// Red on d0be048e (the ports this file fakes also carry the old shape, so the
// old module reads them): the four doors typed Claude Code's way (the line
// and Enter, the text and Enter, the bracketed paste, the marker queue); no
// door asked a third provider's member; the module fetched Codex's run screen
// by name; closeRunScreens and resizeRunScreens did not exist. Mutant this
// must catch: the fall-through to Claude Code's rule put back at one door.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from '@babel/parser'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  infos: [] as string[],
  /** Lines the Claude Code marker queue was handed. */
  queued: [] as Array<{ sessionId: string; line: string }>,
  /** The stand-in third provider's run screen. */
  third: null as Record<string, unknown> | null,
  /** The Codex package's run screen as the registry hands it (close and resize only here). */
  codex: null as Record<string, unknown> | null,
}))

vi.mock('../../../src/main/providers', async () => {
  const { CLAUDE_RUN_SCREEN } = await import('../../../src/main/providers/claude/run-screen')
  return {
    getProvider: (id: string) => {
      if (id === 'claude') return { runScreen: CLAUDE_RUN_SCREEN }
      if (id === 'third') return { runScreen: h.third }
      if (id === 'codex' && h.codex) return { runScreen: h.codex }
      throw new Error(`no provider ${id}`)
    },
  }
})
vi.mock('../../../src/main/canvas/claude-marker-typing', () => ({
  queueClaudeMarkerLine: (sessionId: string, line: string) => { h.queued.push({ sessionId, line }) },
}))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (msg: string) => { h.infos.push(msg) },
  logWarn: (msg: string) => { h.infos.push(msg) },
  logError: () => {},
}))

const input = await import('../../../src/main/session-input')
const { MARKER_FALLBACK_FLUSH_MS } = await import('../../../src/main/canvas/canvas-marker-queue')
const { IPC } = await import('../../../src/shared/ipc-channels')

class FakeRun {
  readonly writes: string[] = []
  write(data: string): void { this.writes.push(data) }
}
const runs = new Map<string, FakeRun>()
const ports = {
  write: (sessionId: string, data: string): void => { runs.get(sessionId)?.write(data) },
  run: (sessionId: string) => runs.get(sessionId) as never,
  tmuxWrapped: () => false,
  // The stand-in third provider runs every session here, launched as Ask.
  providerOf: () => 'third' as never,
  isAskSession: () => true,
  // The ports' shape before section 4, so the base's module reads the same
  // sessions: not Codex, and launched as Ask.
  isCodexSession: () => false,
  isCodexAskSession: () => true,
}

const notices: unknown[] = []
const win = { isDestroyed: () => false, webContents: { send: (channel: string, notice: unknown) => { if (channel === IPC.ASK_CONDUCTOR_NOTICE) notices.push(notice) } } } as never

let n = 0
const fresh = (): string => `third${++n}`
const startRun = (sessionId: string): FakeRun => { const r = new FakeRun(); runs.set(sessionId, r); return r }
const PATH = 'C:\\Users\\me\\AppData\\Local\\AI Code Conductor\\resources\\screenshots\\screenshot-2026-11-25-080000.jpg'
const lineFor = (id: string): string[] => h.infos.filter((l) => l.includes(` ${id}:`))

/** A run screen with only the pane calls: no rule for any door. */
const noRules = (): Record<string, unknown> => ({ open: () => {}, feed: () => {}, resize: () => {}, close: () => {}, has: () => false })

beforeAll(() => { input.setSessionInputPorts(ports as never) })
beforeEach(() => {
  h.infos = []
  h.queued = []
  h.third = noRules()
  h.codex = null
  notices.length = 0
})
afterEach(async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(60_000)
  vi.useRealTimers()
})

describe('a provider with no rule for a door gets nothing typed there, never Claude Code\'s typing', () => {
  it('the Watchdog\'s retry: nothing written, not delivered, one log line', async () => {
    const id = fresh()
    const run = startRun(id)
    const answer = input.submitRetry(id, 'continue')
    expect(answer).toBeInstanceOf(Promise)
    expect(await answer).toEqual({ delivered: false, reason: 'session-gone' })
    expect(run.writes).toEqual([])
    expect(lineFor(id)).toHaveLength(1)
    expect(lineFor(id)[0]).toContain('a Watchdog retry was not taken')
  })

  it.each(['send', 'type'] as const)('a prompt button (%s): nothing written, not sent', async (mode) => {
    vi.useFakeTimers()
    const id = fresh()
    const run = startRun(id)
    const answer = input.submitPrompt(id, 'run the tests', mode)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await answer).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
    expect(run.writes).toEqual([])
    expect(lineFor(id).filter((l) => l.startsWith('[session-input]'))).toHaveLength(1)
  })

  it('an image: nothing written, not taken, and the one log line says why', async () => {
    vi.useFakeTimers()
    const id = fresh()
    const run = startRun(id)
    const answer = input.submitImage(id, PATH, 'Please view this image.')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await answer).toEqual({ outcome: 'not-taken' })
    expect(run.writes).toEqual([])
    expect(lineFor(id)).toHaveLength(1)
    expect(lineFor(id)[0]).toContain('no image rule')
  })

  it('a canvas marker: nothing written or held, not delivered (its canvas is told), one log line', async () => {
    const id = fresh()
    const run = startRun(id)
    const answer = input.submitMarker(id, 'Approved v2 on the canvas', 'c1c2c3c4c5c6c7c8c9c0d1d2')
    expect(answer).toBeInstanceOf(Promise)
    expect(await answer).toEqual({ delivered: false, reason: 'session-gone' })
    expect(h.queued).toEqual([])
    expect(run.writes).toEqual([])
    expect(lineFor(id)).toHaveLength(1)
  })

  it('the Ask door: nothing written, the session gone, and the dock told only by the launch\'s own door', async () => {
    const id = fresh()
    const run = startRun(id)
    expect(await input.handOffAskQuestion(win, id, 'how do I add an account?')).toEqual({ delivered: false, reason: 'session-gone' })
    expect(notices).toEqual([])
    expect(await input.askQuestion(win, id, 'how do I add an account?')).toEqual({ delivered: false, reason: 'session-gone' })
    expect(notices).toEqual([{ sessionId: id, kind: 'not-delivered', reason: 'session-gone' }])
    expect(run.writes).toEqual([])
  })
})

describe('a provider with a rule for a door gets its own, at each of the five doors', () => {
  const calls: Array<{ door: string; args: unknown[] }> = []
  beforeEach(() => {
    calls.length = 0
    h.third = {
      ...noRules(),
      retry: (...args: unknown[]) => { calls.push({ door: 'retry', args }); return Promise.resolve({ delivered: true }) },
      prompt: async (sessionId: string, text: string, opts: unknown, typing: { write(d: string): void; live(): boolean }) => {
        calls.push({ door: 'prompt', args: [sessionId, text, opts] })
        expect(typing.live()).toBe(true)
        typing.write(`<third>${text}</third>`)
        return { outcome: 'sent' }
      },
      marker: (...args: unknown[]) => { calls.push({ door: 'marker', args: args.slice(0, 3) }); return Promise.resolve({ delivered: true }) },
      image: async (...args: unknown[]) => { calls.push({ door: 'image', args: args.slice(0, 4) }); return { pasted: true } },
      ask: async (sessionId: string, question: string, opts: { readyWaitMs: number; removed: (n: number) => void }) => {
        calls.push({ door: 'ask', args: [sessionId, question, opts.readyWaitMs] })
        opts.removed(2)
        return { delivered: true }
      },
    }
  })

  it('the Watchdog\'s retry: its retry member, with the door\'s wait, readyBy and incident check', async () => {
    const id = fresh()
    startRun(id)
    const stillWanted = (): boolean => true
    const from = Date.now()
    expect(await input.submitRetry(id, 'continue', stillWanted)).toEqual({ delivered: true })
    expect(calls.map((c) => c.door)).toEqual(['retry'])
    const [sid, text, opts] = calls[0].args as [string, string, { readyWaitMs: number; readyBy: number; stillWanted: unknown }]
    expect([sid, text, opts.readyWaitMs, opts.stillWanted]).toEqual([id, 'continue', input.RETRY_CODEX_READY_WAIT_MS, stillWanted])
    expect(opts.readyBy).toBeGreaterThanOrEqual(from + input.RETRY_CODEX_READY_WAIT_MS)
  })

  it('a prompt button\'s Send: its prompt member, with the door\'s waits, typing through the write port into the pressed run', async () => {
    const id = fresh()
    const run = startRun(id)
    expect(await input.submitPrompt(id, 'run the tests', 'send')).toEqual({ outcome: 'sent' })
    expect(calls).toEqual([{ door: 'prompt', args: [id, 'run the tests', { readyWaitMs: input.PROMPT_CODEX_READY_WAIT_MS, maxCodePoints: input.PROMPT_CODEX_MAX_CODE_POINTS, enterDelayMs: input.PROMPT_ENTER_DELAY_MS }] }])
    expect(run.writes).toEqual(['<third>run the tests</third>'])
  })

  it('an image: its image member, with the door\'s waits', async () => {
    const id = fresh()
    startRun(id)
    expect(await input.submitImage(id, PATH, 'Please view this image.')).toEqual({ outcome: 'sent' })
    expect(calls).toEqual([{ door: 'image', args: [id, PATH, 'Please view this image.', { readyWaitMs: input.IMAGE_CODEX_READY_WAIT_MS, settleMs: input.IMAGE_PASTE_SETTLE_MS, enterDelayMs: input.IMAGE_ENTER_DELAY_MS }] }])
  })

  it('a canvas marker: its marker member, with the marker queue\'s bound and the canvas', async () => {
    const id = fresh()
    startRun(id)
    expect(await input.submitMarker(id, 'Approved v2 on the canvas', 'c1c2c3c4c5c6c7c8c9c0d1d2')).toEqual({ delivered: true })
    expect(calls).toEqual([{ door: 'marker', args: [id, 'Approved v2 on the canvas', { readyWaitMs: MARKER_FALLBACK_FLUSH_MS, canvasId: 'c1c2c3c4c5c6c7c8c9c0d1d2' }] }])
    expect(h.queued).toEqual([])
  })

  it('the Ask door: its ask member, with the door\'s wait, and its "removed" count told to the dock', async () => {
    const id = fresh()
    startRun(id)
    expect(await input.handOffAskQuestion(win, id, 'how do I add an account?')).toEqual({ delivered: true })
    expect(calls).toEqual([{ door: 'ask', args: [id, 'how do I add an account?', input.ASK_READY_WAIT_MS] }])
    expect(notices).toEqual([{ sessionId: id, kind: 'removed', count: 2 }])
  })
})

describe('the module names no provider', () => {
  it('no \'claude\' or \'codex\' string anywhere in the session input module', () => {
    const file = resolve(__dirname, '../../../src/main/session-input/index.ts')
    const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript'] }) as unknown as { program: unknown }
    const found: string[] = []
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const c of node) visit(c); return }
      const o = node as Record<string, unknown>
      if (o.type === 'StringLiteral' && /^(claude|codex)$/i.test(String(o.value))) found.push(String(o.value))
      if (o.type === 'TemplateElement') { const raw = (o.value as { raw?: string })?.raw ?? ''; if (/^(claude|codex)$/i.test(raw.trim())) found.push(raw) }
      for (const [k, v] of Object.entries(o)) if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments' && k !== 'innerComments') visit(v)
    }
    visit(ast.program)
    expect(found).toEqual([])
  })
})

describe('the PTY manager\'s close and resize of a run\'s reading', () => {
  it('reach every registered provider\'s run screen, and skip one the registry does not have', () => {
    const seen: string[] = []
    h.codex = { ...noRules(), close: (id: string) => { seen.push(`close ${id}`) }, resize: (id: string, c: number, r: number) => { seen.push(`resize ${id} ${c}x${r}`) } }
    input.closeRunScreens('s1')
    input.resizeRunScreens('s1', 80, 24)
    expect(seen).toEqual(['close s1', 'resize s1 80x24'])
    h.codex = null
    expect(() => input.closeRunScreens('s1')).not.toThrow()
    expect(() => input.resizeRunScreens('s1', 80, 24)).not.toThrow()
  })
})
