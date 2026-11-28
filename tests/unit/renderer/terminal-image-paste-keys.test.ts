// @vitest-environment jsdom
/**
 * Which keys the app takes for the clipboard image paste (ADR-032 decision
 * 4; plan 2.1.3-beta.21 phase 2, 2.1.4 and Q2, Q3, Q9), driving the REAL
 * capture-phase installer (terminalKeybindings.ts) with a listener on the
 * textarea standing in for xterm, and the take rule (utils/imagePaste.ts).
 *  - Alt+V with the terminal focused in a session whose CLI takes the paste:
 *    claimed before xterm sees it (no ESC v typed by xterm) and reported to
 *    main as one press, focused. Not taken (xterm's, as today): a plain
 *    terminal, a partner pane, a tab on the old SSH path (Q9), focus outside
 *    this terminal (the global listener's), a modal open.
 *  - Ctrl+V with no text on the clipboard, in such a session: reported as
 *    the text chord; "nothing to paste" only when main finds no picture.
 *    With text: pasted as text, main never asked (ADR-008 unchanged).
 *  - The take rule: a Claude Code or Codex session on this computer, or a
 *    tab main says runs through the session helper; never a plain terminal,
 *    a partner pane or a tab on the old SSH path.
 *  - The Claude Code prompt's 'read' (main's placeholder read): a count of
 *    "[Image #N]" placeholders only, never the prompt's text, nothing typed.
 * Red on 0c54a1c6: the installer had no image paste (Alt+V always went to
 * xterm, Ctrl+V with no text always said nothing to paste), and the prompt
 * reader had no 'read'.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { installTerminalKeybindings, type ImagePasteBinding } from '../../../src/renderer/components/terminal/terminalKeybindings'
import { terminalTakesImagePaste } from '../../../src/renderer/utils/imagePaste'
import { answerClaudeMarkerAsk, claudeImagePlaceholders } from '../../../src/renderer/lib/claudePrompt'

const chord = (init: Partial<KeyboardEventInit> & { key: string }) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
const isAltV = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'v'
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

function harness(opts: { takes?: boolean; focused?: boolean; text?: string; nothing?: boolean; modal?: boolean; noImage?: boolean } = {}) {
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  document.body.appendChild(textarea)
  const xtermSaw: string[] = []
  textarea.addEventListener('keydown', (e) => { xtermSaw.push((e as KeyboardEvent).key) })
  const term = { getSelection: vi.fn(() => ''), paste: vi.fn(), clearSelection: vi.fn() }
  const onNothingToPaste = vi.fn()
  const presses: Array<[string, boolean]> = []
  const image: ImagePasteBinding = {
    isImageChord: isAltV,
    takes: () => opts.takes ?? true,
    terminalFocused: () => opts.focused ?? true,
    press: async (c, f) => { presses.push([c, f]); return opts.nothing ?? false },
  }
  const dispose = installTerminalKeybindings({
    term,
    isActive: () => true,
    readText: vi.fn(async () => opts.text ?? ''),
    writeText: vi.fn(async () => {}),
    onNothingToPaste,
    hasModalOpen: () => opts.modal ?? false,
    getActiveElement: () => textarea,
    ...(opts.noImage ? {} : { imagePaste: image }),
  })
  return { textarea, xtermSaw, term, onNothingToPaste, presses, dispose }
}

beforeEach(() => { document.body.innerHTML = '' })

describe('Alt+V with the terminal focused', () => {
  it('a session whose CLI takes the paste: claimed before xterm, reported as one focused press', async () => {
    const h = harness()
    h.textarea.dispatchEvent(chord({ key: 'v', altKey: true }))
    await tick()
    expect(h.xtermSaw).toEqual([])
    expect(h.presses).toEqual([['image', true]])
    h.dispose()
  })

  it('a held key repeats nothing: one press', async () => {
    const h = harness()
    h.textarea.dispatchEvent(chord({ key: 'v', altKey: true }))
    h.textarea.dispatchEvent(chord({ key: 'v', altKey: true, repeat: true }))
    await tick()
    expect(h.presses).toEqual([['image', true]])
    h.dispose()
  })

  it('not taken, xterm\'s as today: no image binding (a plain terminal, a partner pane, a tab on the old SSH path), the rule saying no, focus outside this terminal, a modal open', async () => {
    for (const o of [{ noImage: true }, { takes: false }, { focused: false }, { modal: true }]) {
      document.body.innerHTML = ''
      const h = harness(o)
      h.textarea.dispatchEvent(chord({ key: 'v', altKey: true }))
      await tick()
      expect(h.xtermSaw, JSON.stringify(o)).toEqual(['v'])
      expect(h.presses, JSON.stringify(o)).toEqual([])
      h.dispose()
    }
  })
})

describe('Ctrl+V (Q2): a picture only when the clipboard holds no text', () => {
  it('no text, and a CLI that takes the paste: the text chord reported; nothing to paste only when main finds no picture', async () => {
    const found = harness({ nothing: false })
    found.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await tick()
    expect(found.presses).toEqual([['text', true]])
    expect(found.onNothingToPaste).not.toHaveBeenCalled()
    expect(found.xtermSaw).toEqual([])
    found.dispose()
    document.body.innerHTML = ''
    const none = harness({ nothing: true })
    none.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await tick()
    expect(none.presses).toEqual([['text', true]])
    expect(none.onNothingToPaste).toHaveBeenCalledTimes(1)
    none.dispose()
  })

  it('text on the clipboard: pasted as text and main never asked (ADR-008 unchanged)', async () => {
    const h = harness({ text: 'hello' })
    h.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await tick()
    expect(h.term.paste).toHaveBeenCalledWith('hello')
    expect(h.presses).toEqual([])
    h.dispose()
  })

  it('no text where the CLI does not take the paste (a plain terminal, the old SSH path): nothing to paste, as before', async () => {
    for (const o of [{ takes: false }, { noImage: true }]) {
      document.body.innerHTML = ''
      const h = harness(o)
      h.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
      await tick()
      expect(h.presses).toEqual([])
      expect(h.onNothingToPaste).toHaveBeenCalledTimes(1)
      h.dispose()
    }
  })
})

describe('the take rule', () => {
  const local = { id: 's1', sessionType: 'local' as const }
  it('a Claude Code or Codex session on this computer takes it; a helper tab when main says so', () => {
    expect(terminalTakesImagePaste(local, { partnerPane: false, throughHelper: false })).toBe(true)
    expect(terminalTakesImagePaste({ id: 's2', sessionType: 'ssh' }, { partnerPane: false, throughHelper: true })).toBe(true)
  })
  it('never a plain terminal, a partner pane, a tab on the old SSH path, or no session', () => {
    expect(terminalTakesImagePaste({ ...local, shellOnly: true }, { partnerPane: false, throughHelper: false })).toBe(false)
    expect(terminalTakesImagePaste(local, { partnerPane: true, throughHelper: false })).toBe(false)
    expect(terminalTakesImagePaste({ id: 's2', sessionType: 'ssh' }, { partnerPane: false, throughHelper: false })).toBe(false)
    expect(terminalTakesImagePaste(undefined, { partnerPane: false, throughHelper: true })).toBe(false)
  })
})

describe('the Claude Code prompt\'s read, for main\'s placeholder read', () => {
  const P = String.fromCharCode(0x276f)
  const H = String.fromCharCode(0x2500).repeat(40)
  const row = (text: string) => ({ text, typed: text })
  const screen = (prompt: string) => [row('  Claude Code'), row(H), row(`${P} ${prompt}`), row(H), row('  ? for shortcuts')]

  it('counts the "[Image #N]" placeholders the prompt shows, and types nothing', () => {
    const write = vi.fn()
    const deps = { readScreen: () => screen('[Image #1] [Image #2] look'), write, setTimeout: vi.fn(), settling: new Set<string>(), typedMarkers: new Set<string>() }
    expect(answerClaudeMarkerAsk({ requestId: 'r1', sessionId: 's1', markerId: 'paste-1', mode: 'read', line: '' }, deps)).toEqual({ requestId: 'r1', ok: true, images: 2 })
    expect(write).not.toHaveBeenCalled()
  })

  it('an empty prompt is no placeholder; a screen with no prompt is no reading', () => {
    const deps = (lines: Array<{ text: string; typed: string }>) => ({ readScreen: () => lines, write: vi.fn(), setTimeout: vi.fn(), settling: new Set<string>(), typedMarkers: new Set<string>() })
    expect(answerClaudeMarkerAsk({ requestId: 'r2', sessionId: 's1', markerId: 'paste-1', mode: 'read', line: '' }, deps(screen('')))).toMatchObject({ ok: true, images: 0 })
    expect(answerClaudeMarkerAsk({ requestId: 'r3', sessionId: 's1', markerId: 'paste-1', mode: 'read', line: '' }, deps([row('C:\\> ')]))).toMatchObject({ ok: false })
  })

  it('the count only: the answer carries no prompt text', () => {
    expect(claudeImagePlaceholders('[Image #1] secret words [Image #12]')).toBe(2)
    const deps = { readScreen: () => screen('[Image #1] secret words'), write: vi.fn(), setTimeout: vi.fn(), settling: new Set<string>(), typedMarkers: new Set<string>() }
    expect(JSON.stringify(answerClaudeMarkerAsk({ requestId: 'r4', sessionId: 's1', markerId: 'paste-1', mode: 'read', line: '' }, deps))).not.toContain('secret')
  })
})
