// 2.1.3-beta.13 B2 (aicc_planning#370): Codex's window-title spinner is a busy
// sign of the one Codex reader (src/shared/codex-screen.ts). Probe P19's
// second run (helper/fixtures/screens/; tests/unit/shared/screen-corpus.test.ts
// case 5) found it on every Windows and Linux screen of a reply streaming and
// of the queue hint: an OSC 0 title that starts with a braille spinner
// (U+2800 to U+28FF) and a space. While a reply streams it is the only busy
// sign (no "esc to interrupt" row).
//
// Not checked here:
//  - where the title comes from (each pane keeps its own: the renderer's
//    terminal, main's Codex pane, the Watchdog's pane; their own tests);
//  - an OSC 2 title (xterm.js reports OSC 0 and OSC 2 alike);
//  - Codex's start-up spin as a caller sees it (tests/unit/renderer/codex-title-busy.test.ts).
import { describe, it, expect } from 'vitest'
import {
  codexTitleBusy, readCodexScreen, codexCommandTyped, codexTextTyped, codexPastedContentShown,
  type ScreenLine,
} from '../../../src/shared/codex-screen'

const P = String.fromCharCode(0x203a)
const DOT = String.fromCharCode(0xb7)
const plain = (text: string): ScreenLine => ({ text, typed: text })
const FOOTER = plain(`  gpt-5.5 medium ${DOT} C:\\dev\\demo`)
const HEAD = [plain('  Tip: New Build faster with Codex.'), plain('')]
const composer = (text: string): ScreenLine => (text === '' ? { text: `${P} Ask Codex to do anything`, typed: P } : plain(`${P} ${text}`))
const screenOf = (text: string, under: ScreenLine[] = []): ScreenLine[] => [...HEAD, composer(text), plain(''), FOOTER, ...under]
/** A braille spinner frame Codex draws, then its title. */
const spin = (code = 0x280b, rest = ' work'): string => `${String.fromCharCode(code)}${rest}`

describe('codexTitleBusy: a braille spinner and a space at the start of the title', () => {
  it('reads busy across the whole braille block, U+2800 to U+28FF', () => {
    for (const code of [0x2800, 0x280b, 0x2839, 0x28ff]) expect(codexTitleBusy(spin(code)), code.toString(16)).toBe(true)
  })

  it('not just outside it, nor with no space after it, nor anywhere but first', () => {
    for (const title of [spin(0x27ff), spin(0x2900), spin(0x280b, 'work'), spin(0x280b, ''), `work ${spin()}`, 'work', 'p19 short: print the reply | work', ' ']) {
      expect(codexTitleBusy(title), JSON.stringify(title)).toBe(false)
    }
  })

  it('no title is no busy sign', () => {
    expect(codexTitleBusy(null)).toBe(false)
    expect(codexTitleBusy(undefined)).toBe(false)
    expect(codexTitleBusy('')).toBe(false)
  })
})

describe('readCodexScreen with the title', () => {
  it('the ready composer reads busy under a spinner title, and ready under any other title or none', () => {
    const ready = screenOf('')
    expect(readCodexScreen(ready, null, { title: spin() })).toEqual({ screen: 'busy', text: '' })
    expect(readCodexScreen(ready, null, { title: 'work' })).toEqual({ screen: 'ready', text: '' })
    expect(readCodexScreen(ready, null, { title: null })).toEqual({ screen: 'ready', text: '' })
    expect(readCodexScreen(ready)).toEqual({ screen: 'ready', text: '' })
  })

  it('a footer with a row under it (the warning count) reads busy under a spinner title, else unrecognised', () => {
    const counted = screenOf('', [plain('  1 warning')])
    expect(readCodexScreen(counted, null, { title: spin() }).screen).toBe('busy')
    expect(readCodexScreen(counted, null, { title: 'work' }).screen).toBe('unrecognised')
  })

  it('a draft at the composer keeps its text, busy under a spinner title', () => {
    expect(readCodexScreen(screenOf('half a note'), null, { title: spin() })).toEqual({ screen: 'busy', text: 'half a note' })
  })

  it('a prompt up, no composer, or Codex starting read as they did: the title never outranks them', () => {
    const prompt = [...HEAD, plain('  Do you trust the contents of this directory?'), plain(`${P} 1. Yes, continue`), plain('  Press enter to continue')]
    const starting = [...HEAD, plain(`\u2022 Booting MCP server: conductor (0s ${DOT} esc to interrupt)`), composer(''), plain(''), FOOTER]
    const transcript = [...HEAD, plain('  the reply streams here')]
    expect(readCodexScreen(prompt, null, { title: spin() }).screen).toBe('blocked')
    expect(readCodexScreen(starting, null, { title: spin() }).screen).toBe('starting')
    expect(readCodexScreen(transcript, null, { title: spin() }).screen).toBe('no-prompt')
  })
})

describe('the typed-text readers refuse while the title spins', () => {
  it('a command typed, a text typed and a paste placeholder are confirmed under any other title, never under a spinner', () => {
    const command = [...HEAD, composer('/compact'), plain(''), plain('  /compact  summarize the conversation')]
    const text = screenOf('a canvas note')
    const pasted = screenOf('[Pasted Content 1500 chars]')
    for (const title of [undefined, null, 'work']) {
      expect(codexCommandTyped(command, '/compact', null, title), String(title)).toBe(true)
      expect(codexTextTyped(text, 'a canvas note', null, title), String(title)).toBe(true)
      expect(codexPastedContentShown(pasted, 1500, null, title), String(title)).toBe(true)
    }
    expect(codexCommandTyped(command, '/compact', null, spin())).toBe(false)
    expect(codexTextTyped(text, 'a canvas note', null, spin())).toBe(false)
    expect(codexPastedContentShown(pasted, 1500, null, spin())).toBe(false)
  })
})
