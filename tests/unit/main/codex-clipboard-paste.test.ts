// Codex's own clipboard image paste (ADR-032; plan 2.1.3-beta.21 phase 2,
// 2.1.3): src/main/providers/codex/session-screen.ts,
// pasteClipboardIntoCodexComposer, against a simulated Codex composer. The
// simulation takes Codex's paste key (ESC v, or Ctrl+V) as ONE write and,
// when its clipboard holds a picture, draws "[Image #N]" a moment later; any
// other write is typed text (a bracketed write included), and a lone ESC is
// Escape. Enter sends the composer; Ctrl+U clears it. Time is a fake clock.
//  - A press from outside the terminal (a sentence): the ready, empty
//    composer first, then the key alone, then the sentence after the
//    placeholder, then Enter once; the turn carries the picture.
//  - Busy through the wait: nothing written.
//  - No picture on Codex's clipboard read: the key only; no sentence, no
//    Enter, no Ctrl+U (nothing taken back).
//  - A press in the terminal (no sentence): the key at once, whatever the
//    composer holds; then a placeholder more than before; nothing more.
//  - Never Ctrl+C, never a path, never a bracketed paste.
//  - Review round 2 (R2-1): the sentence typed but not drawn within the
//    primitive's confirm bound: `sentence-not-sent`, no Ctrl+U, and the
//    picture still in the composer (ADR-032 decision 6: no take-back); a
//    prompt up after the sentence: `prompt-on-screen`, whose hint does not
//    ask for Enter. Both red on 713c585f (Ctrl+U cleared the picture; the
//    prompt answered `sentence-not-sent`).
// Red on 0c54a1c6: no such rule. Mutants this must catch: the key split over
// two writes; the key sent inside a bracketed paste; a take-back after no
// placeholder; the sentence handed to the primitive without `takeBack: false`.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { pasteClipboardIntoCodexComposer } = await import('../../../src/main/providers/codex/session-screen')
const { TAKE_BACK_KEY } = await import('../../../src/main/providers/codex/composer-submit')
type Deps = Parameters<typeof pasteClipboardIntoCodexComposer>[2]
type Line = { text: string; typed: string }

const P = String.fromCharCode(0x203a)
const DOT = String.fromCharCode(0xb7)
const ENTER = '\r'
const CTRL_C = String.fromCharCode(3)
const ESC_V = '\u001bv'
const CTRL_V = '\u0016'
const SENTENCE = 'I just snapped a region of my screen, please view it.'
const PICTURE = 'picture-1'
const plain = (text: string): Line => ({ text, typed: text })

interface SimOptions {
  /** What Codex's clipboard read finds: a picture (the default) or nothing. */
  clipboard?: string | null
  drawMs?: number
  busyUntil?: number
  /** Text in the composer before the press (the user is writing). */
  typed?: string
  /** A trust prompt comes up this long after the key. */
  promptAfterKeyMs?: number
  /** How long typed text (not the key) takes to draw; default drawMs. */
  textDrawMs?: number
  /** A trust prompt comes up this long after typed text (not the key). */
  promptAfterTextMs?: number
}

function sim(opts: SimOptions = {}) {
  let t = 0
  let alive = true
  let pending: { data: string; at: number } | null = null
  const images: string[] = []
  let text = opts.typed ?? ''
  let promptFrom = Number.POSITIVE_INFINITY
  const writes: Array<{ at: number; data: string }> = []
  const turns: Array<{ text: string; images: string[] }> = []
  const clip = opts.clipboard === undefined ? PICTURE : opts.clipboard
  const draw = (): void => {
    if (!pending || t < pending.at) return
    const d = pending.data
    pending = null
    if (d === ESC_V || d === CTRL_V) {
      if (clip) { images.push(clip); text += `${text && !text.endsWith(' ') ? ' ' : ''}[Image #${images.length}] ` }
      return
    }
    if (d === '\u001b') return // Escape: nothing drawn
    text += d
  }
  const readScreen = (): Line[] => {
    draw()
    const head = [plain('  Tip: New Build faster with Codex.')]
    if (t >= promptFrom) return [...head, plain('  Do you trust the contents of this directory?'), plain(`${P} 1. Yes, continue`), plain('  Press enter to continue')]
    const busy = (opts.busyUntil ?? 0) > t
    const shown = text.replace(/\s+$/, '')
    const row = shown === '' ? { text: `${P} Ask Codex to do anything`, typed: P } : plain(`${P} ${shown}`)
    return [...head, ...(busy ? [plain('\u2022 Working (2s \u2022 esc to interrupt)')] : []), row, plain(`  gpt-5.5 medium ${DOT} C:\\dev\\demo`)]
  }
  const deps: Deps = {
    readScreen,
    size: () => ({ cols: 120, rows: 40 }),
    write: (data) => {
      writes.push({ at: t, data })
      draw()
      if (data === ENTER) {
        if (pending) return
        turns.push({ text: text.replace(/\s+$/, ''), images: [...images] })
        images.length = 0
        text = ''
        return
      }
      if (data === TAKE_BACK_KEY) { pending = null; images.length = 0; text = ''; return }
      const isKey = data === ESC_V || data === CTRL_V
      if (isKey && opts.promptAfterKeyMs !== undefined) promptFrom = t + opts.promptAfterKeyMs
      if (!isKey && opts.promptAfterTextMs !== undefined) promptFrom = t + opts.promptAfterTextMs
      pending = { data, at: t + (isKey ? (opts.drawMs ?? 200) : (opts.textDrawMs ?? opts.drawMs ?? 200)) }
    },
    live: () => alive,
    now: () => t,
    sleep: async (ms) => { t += Math.max(0, ms) },
    log: () => {},
  }
  return {
    deps, writes, turns, end: () => { alive = false }, get now() { return t },
    /** The pictures the simulated composer holds now. */
    get images() { return [...images] },
  }
}

const datas = (w: Array<{ data: string }>): string[] => w.map((x) => x.data)
const OPTS = { readyWaitMs: 5_000, placeholderWaitMs: 5_000 }

describe('a press from outside the terminal, and Snap', () => {
  it('the key alone, then the sentence once the placeholder shows, then Enter once; the turn carries the picture', async () => {
    const s = sim()
    expect(await pasteClipboardIntoCodexComposer(ESC_V, SENTENCE, s.deps, OPTS)).toEqual({ outcome: 'sent' })
    expect(datas(s.writes)).toEqual([ESC_V, ` ${SENTENCE}`, ENTER])
    expect(s.turns).toEqual([{ text: `[Image #1]  ${SENTENCE}`, images: [PICTURE] }])
    expect(s.writes[1].at - s.writes[0].at).toBeGreaterThanOrEqual(200)
  })

  it('Ctrl+V as the key (macOS and Linux) the same', async () => {
    const s = sim()
    expect(await pasteClipboardIntoCodexComposer(CTRL_V, SENTENCE, s.deps, OPTS)).toEqual({ outcome: 'sent' })
    expect(datas(s.writes)[0]).toBe(CTRL_V)
  })

  it('busy through the wait: nothing written; busy for part of it: it waits, then pastes', async () => {
    const busy = sim({ busyUntil: 60_000 })
    expect(await pasteClipboardIntoCodexComposer(ESC_V, SENTENCE, busy.deps, OPTS)).toEqual({ outcome: 'busy' })
    expect(busy.writes).toEqual([])
    const part = sim({ busyUntil: 2_000 })
    expect(await pasteClipboardIntoCodexComposer(ESC_V, SENTENCE, part.deps, OPTS)).toEqual({ outcome: 'sent' })
    expect(part.writes[0].at).toBeGreaterThanOrEqual(2_000)
  })

  it('no picture where Codex reads: the key only, then nothing; no sentence, no Enter, nothing taken back', async () => {
    const s = sim({ clipboard: null })
    expect(await pasteClipboardIntoCodexComposer(ESC_V, SENTENCE, s.deps, OPTS)).toEqual({ outcome: 'no-placeholder' })
    expect(datas(s.writes)).toEqual([ESC_V])
    expect(s.now).toBeGreaterThanOrEqual(5_000)
    expect(s.turns).toEqual([])
  })

  it('a prompt after the key: nothing more typed', async () => {
    const s = sim({ promptAfterKeyMs: 50 })
    expect(await pasteClipboardIntoCodexComposer(ESC_V, SENTENCE, s.deps, OPTS)).toEqual({ outcome: 'no-placeholder' })
    expect(datas(s.writes)).toEqual([ESC_V])
  })

  it('the sentence typed but not drawn within the confirm bound: sentence-not-sent, no Ctrl+U, the picture still in the composer', async () => {
    const s = sim({ textDrawMs: 8_000 })
    expect(await pasteClipboardIntoCodexComposer(ESC_V, SENTENCE, s.deps, OPTS)).toEqual({ outcome: 'sentence-not-sent' })
    expect(datas(s.writes)).toEqual([ESC_V, ` ${SENTENCE}`])
    expect(s.images).toEqual([PICTURE])
    expect(s.turns).toEqual([])
  })

  it('a prompt after the sentence is typed: prompt-on-screen (its hint asks for no Enter), nothing more written', async () => {
    const s = sim({ promptAfterTextMs: 50 })
    expect(await pasteClipboardIntoCodexComposer(ESC_V, SENTENCE, s.deps, OPTS)).toEqual({ outcome: 'prompt-on-screen' })
    expect(datas(s.writes)).toEqual([ESC_V, ` ${SENTENCE}`])
    expect(s.images).toEqual([PICTURE])
    expect(s.turns).toEqual([])
  })

  it('the run ends after the key: session-gone, nothing more', async () => {
    const s = sim({ drawMs: 1_000 })
    const p = pasteClipboardIntoCodexComposer(ESC_V, SENTENCE, s.deps, OPTS)
    s.end()
    expect(await p).toEqual({ outcome: 'session-gone' })
    expect(datas(s.writes)).toEqual([])
  })
})

describe('a press in the terminal (the user is writing)', () => {
  it('the key at once whatever the composer holds, then a placeholder more than before; nothing more', async () => {
    const s = sim({ typed: 'look at this ' })
    expect(await pasteClipboardIntoCodexComposer(ESC_V, null, s.deps, OPTS)).toEqual({ outcome: 'placeholder' })
    expect(datas(s.writes)).toEqual([ESC_V])
    expect(s.writes[0].at).toBe(0)
  })

  it('a second picture in a composer that already shows one: counted from the one before', async () => {
    const s = sim({ typed: '[Image #1] and ' })
    expect(await pasteClipboardIntoCodexComposer(ESC_V, null, s.deps, OPTS)).toEqual({ outcome: 'placeholder' })
    expect(datas(s.writes)).toEqual([ESC_V])
  })

  it('no picture: the key only, and the answer says so', async () => {
    const s = sim({ clipboard: null, typed: 'look ' })
    expect(await pasteClipboardIntoCodexComposer(ESC_V, null, s.deps, OPTS)).toEqual({ outcome: 'no-placeholder' })
    expect(datas(s.writes)).toEqual([ESC_V])
  })
})

describe('what the rule never writes', () => {
  it('no Ctrl+C, no take-back, no bracketed paste, no path, in any case above', async () => {
    for (const o of [{}, { clipboard: null }, { busyUntil: 60_000 }, { promptAfterKeyMs: 10 }, { typed: 'x ' }, { textDrawMs: 8_000 }, { promptAfterTextMs: 50 }] as SimOptions[]) {
      for (const sentence of [SENTENCE, null]) {
        const s = sim(o)
        await pasteClipboardIntoCodexComposer(ESC_V, sentence, s.deps, OPTS)
        for (const d of datas(s.writes)) {
          expect(d).not.toBe(CTRL_C)
          expect(d).not.toBe(TAKE_BACK_KEY)
          expect(d).not.toContain('\u001b[200~')
          expect(d).not.toMatch(/[\\/]/)
        }
      }
    }
  })
})
