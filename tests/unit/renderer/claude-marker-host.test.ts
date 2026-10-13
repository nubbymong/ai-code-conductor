// @vitest-environment jsdom
// [host] The renderer half of a canvas marker into a Claude
// Code session (answerClaudeMarkerAsk, src/renderer/lib/claudePrompt.ts). Main
// asks it to read the session's prompt (a probe: nothing typed) or to type the
// marker line; it answers from the session's own screen, read by
// src/shared/claude-screen.ts, the same gate the status strip's Compact,
// model and effort controls type through. Only the ready, empty prompt reads
// ready; the line and its Enter are typed in one write, once: a marker already
// typed reads as typed again and is never typed twice.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as S from '../shared/claude-screens'
import { CANVAS_MARKER_MAX_LINE, CLAUDE_MARKER_REFUSED } from '../../../src/shared/canvas-marker-line'

const { answerClaudeMarkerAsk, setupClaudeMarkerHost, CLAUDE_SETTLE_MS } = await import('../../../src/renderer/lib/claudePrompt')

const LINE = 'Approved v2 on the canvas · canvas_version_verdict recorded'
let screen: S.Row[] | null
let writes: Array<[string, string]>
let settling: Set<string>
let timers: Array<() => void>
let typedMarkers: Set<string>
const deps = () => ({
  readScreen: () => screen,
  write: (sessionId: string, data: string) => { writes.push([sessionId, data]) },
  setTimeout: (fn: () => void) => { timers.push(fn) },
  settling,
  typedMarkers,
})
const ask = (mode: string, over: Record<string, unknown> = {}) => answerClaudeMarkerAsk({ requestId: 'r1', sessionId: 's1', markerId: 'm1', mode, line: LINE, ...over }, deps())

beforeEach(() => {
  screen = S.READY
  writes = []
  settling = new Set()
  timers = []
  typedMarkers = new Set()
})

const NOT_READY: Array<[string, S.Row[] | null]> = [
  ['a question before a command runs', S.TOOL_QUESTION],
  ['a narrow question with its words wrapped', S.TOOL_QUESTION_NARROW],
  ['a question before a file is written', S.FILE_QUESTION],
  ['a question before an edit', S.EDIT_QUESTION],
  ['the folder-trust screen', S.TRUST],
  ['a picker', S.MODEL_PICKER],
  ['a question under an earlier prompt box', S.QUESTION_UNDER_OLD_PROMPT],
  ['a running turn', S.BUSY],
  ['text at the prompt', S.TYPED],
  ['a view of the history', S.SCROLLED_BACK],
  ['the shell', S.SHELL],
  ['no terminal', null],
]

describe('a probe reads the prompt and types nothing', () => {
  it('reads the ready, empty prompt as ready', () => {
    expect(ask('probe')).toEqual({ requestId: 'r1', ok: true })
    expect(writes).toEqual([])
  })

  for (const [name, shown] of NOT_READY) {
    it(`reads ${name} as not ready, with why`, () => {
      screen = shown
      const answer = ask('probe')
      expect(answer?.ok).toBe(false)
      expect(answer?.reason).toMatch(/nothing was (sent|added)/)
      expect(writes).toEqual([])
    })
  }
})

describe('a type types the line and its Enter at the ready, empty prompt, once', () => {
  it('types it in one write at the ready prompt', () => {
    expect(ask('type')).toEqual({ requestId: 'r1', ok: true })
    expect(writes).toEqual([['s1', `${LINE}\r`]])
  })

  for (const [name, shown] of NOT_READY) {
    it(`types nothing on ${name}`, () => {
      screen = shown
      expect(ask('type')?.ok).toBe(false)
      expect(writes).toEqual([])
    })
  }

  it('types nothing into a session a line was just typed into, until the settle time passes', () => {
    expect(ask('type')?.ok).toBe(true)
    // Another marker for the same session.
    expect(ask('probe', { markerId: 'm2' })?.ok).toBe(false)
    expect(ask('type', { markerId: 'm2' })?.ok).toBe(false)
    expect(writes).toHaveLength(1)
    expect(timers).toHaveLength(1)
    timers[0]()
    expect(ask('type', { markerId: 'm2' })?.ok).toBe(true)
    expect(writes).toHaveLength(2)
    expect(CLAUDE_SETTLE_MS).toBeGreaterThan(0)
  })
})

describe('a marker already typed is never typed twice', () => {
  // Its answer can reach main after main stopped waiting for it; main then
  // asks again for the same marker.
  it('reads as typed for a probe and a type, whatever the screen shows, and types nothing more', () => {
    expect(ask('type')).toEqual({ requestId: 'r1', ok: true })
    screen = S.READY
    timers.forEach((fn) => fn())
    expect(ask('probe')).toEqual({ requestId: 'r1', ok: true })
    expect(ask('type')).toEqual({ requestId: 'r1', ok: true })
    screen = S.BUSY
    expect(ask('probe')).toEqual({ requestId: 'r1', ok: true })
    expect(ask('type')).toEqual({ requestId: 'r1', ok: true })
    expect(writes).toEqual([['s1', `${LINE}\r`]])
  })

  it('is per marker and per session: another marker, or the same id for another session, is still gated', () => {
    expect(ask('type')?.ok).toBe(true)
    screen = S.BUSY
    timers.forEach((fn) => fn())
    expect(ask('probe', { markerId: 'm2' })?.ok).toBe(false)
    expect(ask('type', { sessionId: 's2' })?.ok).toBe(false)
    screen = S.READY
    expect(ask('type', { sessionId: 's2' })?.ok).toBe(true)
    expect(writes).toEqual([['s1', `${LINE}\r`], ['s2', `${LINE}\r`]])
  })

  it('remembers the last 256 markers typed', () => {
    for (let i = 0; i <= 256; i++) {
      expect(ask('type', { markerId: `m${i}` })?.ok).toBe(true)
      timers.splice(0).forEach((fn) => fn())
    }
    expect(writes).toHaveLength(257)
    screen = S.BUSY
    expect(ask('probe', { markerId: 'm0' })?.ok).toBe(false)
    expect(ask('probe', { markerId: 'm1' })?.ok).toBe(true)
    expect(ask('probe', { markerId: 'm256' })?.ok).toBe(true)
  })
})

describe('a request that is not well formed types nothing', () => {
  it('answers nothing without a request id', () => {
    expect(answerClaudeMarkerAsk(null, deps())).toBeNull()
    expect(answerClaudeMarkerAsk('probe', deps())).toBeNull()
    expect(answerClaudeMarkerAsk({ sessionId: 's1', mode: 'type', line: LINE }, deps())).toBeNull()
    expect(answerClaudeMarkerAsk({ requestId: 'x'.repeat(201), sessionId: 's1', mode: 'type', line: LINE }, deps())).toBeNull()
    expect(writes).toEqual([])
  })

  for (const [name, over] of [
    ['an unknown mode', { mode: 'submit' }],
    ['no session', { sessionId: '' }],
    ['no marker id', { markerId: '' }],
    ['a marker id that is not text', { markerId: 7 }],
    ['a line with a control character', { line: 'Approved v2\r1' }],
    ['a line with an escape sequence', { line: 'Approved \u001b[2J' }],
    ['a line with a C1 control', { line: 'Approved \u009b2J' }],
    ['a blank line', { line: '   ' }],
    ['a line past the bound', { line: 'x'.repeat(CANVAS_MARKER_MAX_LINE + 1) }],
    ['a line that is not text', { line: 42 }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`refuses ${name}`, () => {
      expect(ask('type', over)).toEqual({ requestId: 'r1', ok: false, reason: CLAUDE_MARKER_REFUSED })
      expect(ask('probe', over)).toEqual({ requestId: 'r1', ok: false, reason: CLAUDE_MARKER_REFUSED })
      expect(writes).toEqual([])
    })
  }
})

describe('setupClaudeMarkerHost', () => {
  it('answers each of main\'s requests over the bridge, once armed', () => {
    let handler: ((raw: unknown) => void) | null = null
    const answers: unknown[] = []
    const ptyWrite = vi.fn()
    ;(globalThis as any).window.electronAPI = {
      pty: { write: ptyWrite },
      canvas: {
        onClaudeMarkerAsk: (cb: (raw: unknown) => void) => { handler = cb; return () => {} },
        answerClaudeMarker: (a: unknown) => { answers.push(a) },
      },
    }
    setupClaudeMarkerHost()
    setupClaudeMarkerHost()
    expect(handler).toBeTruthy()
    // No terminal is registered for the session: not ready, nothing typed.
    handler!({ requestId: 'q1', sessionId: 'none', markerId: 'k1', mode: 'type', line: LINE })
    handler!({ nonsense: true })
    expect(answers).toEqual([{ requestId: 'q1', ok: false, reason: expect.stringMatching(/not at its prompt/) }])
    expect(ptyWrite).not.toHaveBeenCalled()
  })
})

describe('the app arms the host at boot', () => {
  it('App.tsx imports setupClaudeMarkerHost and calls it in the boot effect, beside the canvas snapshot host', () => {
    // Without the call every Claude canvas marker is held until its run ends.
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'App.tsx'), 'utf8')
    expect(src).toMatch(/import \{ setupClaudeMarkerHost \} from '\.\/lib\/claudePrompt'/)
    expect(src).toMatch(/setupCanvasSnapshotHost\(\)[\s\S]{0,400}?\n\s*setupClaudeMarkerHost\(\)/)
  })
})
