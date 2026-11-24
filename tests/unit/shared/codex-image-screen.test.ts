// 2.1.3-beta.17 C6 (aicc_planning#415): Codex's image placeholder read from
// its screen (src/shared/codex-image-screen.ts), on screens recorded from
// Codex 0.157.1: P19's Windows ready screen and warning-count screen
// (helper/fixtures/screens, read only), with the composer row as probe P11
// recorded it after the paste ("[Image #1]") and after the sentence
// ("[Image #1]  <sentence>").
//
//  - The placeholder alone in a ready composer reads as the placeholder; with
//    words after it, an empty composer, a turn running (the title's spinner)
//    or a prompt up, it does not. A placeholder in the transcript above an
//    empty composer is not the composer's.
//  - The warning count reads only under the composer.
//  - The screen past the placeholder: the composer row without it, so the
//    composer readers read it empty, and read the sentence after it as the
//    whole text; no reading while the placeholder is gone (before the
//    sentence) or the warning count shows; an empty composer once the
//    sentence was typed (the take-back) reads as it is; a prompt reads as it
//    is.
//
// Red on beta: no src/shared/codex-image-screen.ts. Mutants this must catch:
// the placeholder read anywhere on the screen (the transcript's); the screen
// past the placeholder read as empty with the placeholder gone.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  codexImagePlaceholderShown, codexDraftIsImagePlaceholder, codexWarningCountShown, codexScreenPastPlaceholder, codexComposerHoldsImage,
} from '../../../src/shared/codex-image-screen'
import { readCodexScreen, codexTextTyped, codexComposerDraft, type ScreenLine } from '../../../src/shared/codex-screen'

const FIX = resolve(__dirname, '..', '..', '..', 'helper', 'fixtures', 'screens')
const lastScreen = (name: string): ScreenLine[] => {
  const rec = JSON.parse(readFileSync(resolve(FIX, `${name}.rows.json`), 'utf8')) as { screens: Array<{ lines: ScreenLine[] }> }
  return rec.screens[rec.screens.length - 1].lines
}
const P = String.fromCharCode(0x203a)
const READY = lastScreen('codex-windows-bundled-ready')
const WARNING = lastScreen('codex-macos-warning-hint')
const SENTENCE = 'I just snapped a region of my screen - please view it.'
const row = (text: string, dimFrom = text.length): ScreenLine => ({ text, typed: text.slice(0, dimFrom), inverse: '', width: 120, end: text.length })
/** READY with its composer row replaced (and its hint row, which Codex draws only under an empty composer, blanked). */
const withComposer = (text: string): ScreenLine[] => READY.map((l) => (l.text.startsWith(P) ? row(text) : l.text === '  ? for shortcuts' ? row('') : l))
const PLACEHOLDER = withComposer(`${P} [Image #1]`)
const WITH_SENTENCE = withComposer(`${P} [Image #1]  ${SENTENCE}`)
const SPINNER = `${String.fromCharCode(0x280b)} work`

describe('the recorded screens hold what these tests assume', () => {
  it('READY reads ready and empty; WARNING shows the count under the footer', () => {
    expect(readCodexScreen(READY)).toEqual({ screen: 'ready', text: '' })
    expect(WARNING.some((l) => l.text.includes(`${String.fromCharCode(0x26a0)} 1 warning`))).toBe(true)
  })
})

describe('codexImagePlaceholderShown', () => {
  it('the placeholder alone in a ready composer', () => {
    expect(codexImagePlaceholderShown(PLACEHOLDER)).toBe('[Image #1]')
    expect(codexImagePlaceholderShown(withComposer(`${P} [Image #12]`))).toBe('[Image #12]')
  })

  it('not with words after it, an empty composer, a turn running, a prompt up, or nothing to read', () => {
    expect(codexImagePlaceholderShown(WITH_SENTENCE)).toBeNull()
    expect(codexImagePlaceholderShown(READY)).toBeNull()
    expect(codexImagePlaceholderShown(PLACEHOLDER, null, SPINNER)).toBeNull()
    expect(codexImagePlaceholderShown([row('  Do you trust the contents of this directory?'), ...PLACEHOLDER])).toBeNull()
    expect(codexImagePlaceholderShown(null)).toBeNull()
  })

  it('a placeholder in the transcript above an empty composer is not the composer\'s', () => {
    const i = READY.findIndex((l) => l.text.startsWith(P))
    const transcript = [...READY.slice(0, i), row(`${P} [Image #1]  an earlier turn`), row('• ok'), ...READY.slice(i)]
    expect(codexImagePlaceholderShown(transcript)).toBeNull()
  })
})

describe('codexWarningCountShown', () => {
  it('the recorded count under the footer', () => {
    expect(codexWarningCountShown(WARNING)).toBe(true)
    expect(codexWarningCountShown(READY)).toBe(false)
    expect(codexWarningCountShown(null)).toBe(false)
  })

  it('words about a warning in the transcript, above the composer, are not the count', () => {
    const i = READY.findIndex((l) => l.text.startsWith(P))
    const above = [...READY.slice(0, i), row(`  ${String.fromCharCode(0x26a0)} 2 warnings in the build log`), ...READY.slice(i)]
    expect(codexWarningCountShown(above)).toBe(false)
  })
})

describe('codexScreenPastPlaceholder', () => {
  it('the composer holding only the placeholder reads ready and empty', () => {
    const past = codexScreenPastPlaceholder(PLACEHOLDER, '[Image #1]', false)
    expect(readCodexScreen(past)).toEqual({ screen: 'ready', text: '' })
    expect(codexComposerDraft(past)).toBe('')
  })

  it('the sentence after the placeholder reads as the whole text, as the submit primitive confirms it', () => {
    const past = codexScreenPastPlaceholder(WITH_SENTENCE, '[Image #1]', true)
    expect(codexTextTyped(past, ` ${SENTENCE}`)).toBe(true)
    expect(codexTextTyped(past, `${SENTENCE} and more`)).toBe(false)
    // The unread screen: the placeholder is part of the text.
    expect(codexTextTyped(WITH_SENTENCE, SENTENCE)).toBe(false)
  })

  it('cuts the placeholder from the row\'s typed reading at the same cells (a dim placeholder too)', () => {
    const dim = withComposer(`${P} [Image #1]`).map((l) => (l.text.startsWith(P) ? row(l.text, 1) : l))
    const past = codexScreenPastPlaceholder(dim, '[Image #1]', false)!
    expect(past.find((l) => l.text.startsWith(P))!.text.trim()).toBe(P)
    expect(readCodexScreen(past)).toEqual({ screen: 'ready', text: '' })
  })

  it('no reading while the placeholder is gone before the sentence, or the composer holds something before it', () => {
    expect(codexScreenPastPlaceholder(READY, '[Image #1]', false)).toBeNull()
    expect(codexScreenPastPlaceholder(withComposer(`${P} hello [Image #1]`), '[Image #1]', false)).toBeNull()
    expect(codexScreenPastPlaceholder(withComposer(`${P} ${SENTENCE}`), '[Image #1]', true)).toBeNull()
  })

  it('once the sentence was typed, an empty composer (taken back) reads as it is', () => {
    expect(codexScreenPastPlaceholder(READY, '[Image #1]', true)).toBe(READY)
  })

  it('no reading while the warning count shows; a prompt reads as it is', () => {
    const warned = WARNING.map((l) => (l.text.startsWith(P) ? row(`${P} [Image #1]`) : l))
    expect(codexScreenPastPlaceholder(warned, '[Image #1]', false)).toBeNull()
    const prompt = [row('  Do you trust the contents of this directory?'), ...PLACEHOLDER]
    expect(codexScreenPastPlaceholder(prompt, '[Image #1]', false)).toBe(prompt)
    expect(codexScreenPastPlaceholder(null, '[Image #1]', false)).toBeNull()
  })
})

describe('the draft and the composer', () => {
  it('codexDraftIsImagePlaceholder: the placeholder alone, as the draft reader reads it (spaces dropped)', () => {
    expect(codexDraftIsImagePlaceholder(codexComposerDraft(PLACEHOLDER))).toBe(true)
    expect(codexDraftIsImagePlaceholder(codexComposerDraft(WITH_SENTENCE))).toBe(false)
    expect(codexDraftIsImagePlaceholder('')).toBe(false)
    expect(codexDraftIsImagePlaceholder(null)).toBe(false)
  })

  it('codexComposerHoldsImage: a composer starting with the placeholder, with or without words after it', () => {
    expect(codexComposerHoldsImage(PLACEHOLDER)).toBe(true)
    expect(codexComposerHoldsImage(WITH_SENTENCE)).toBe(true)
    expect(codexComposerHoldsImage(READY)).toBe(false)
    expect(codexComposerHoldsImage(withComposer(`${P} see [Image #1]`))).toBe(false)
  })
})
