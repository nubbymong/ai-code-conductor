// 2.1.3-beta.17 C6 (aicc_planning#415): the Codex image rule
// (src/main/providers/codex/session-screen.ts, pasteImageIntoCodexComposer),
// against a simulated Codex composer that behaves as probe P11 measured Codex
// 0.157.1 (ADR-030, the P11 result): a bracketed paste of an image's path is
// drawn a moment later as "[Image #1]" with the picture attached; text typed
// after it follows it on the composer row; Enter sends the text and the
// picture; Ctrl+U clears the composer, the placeholder and its picture with
// it. Time is a fake clock: every wait the rule makes advances it.
//
//  - Ready: the paste in one write, then a space and the sentence in one
//    write once the placeholder shows, then Enter once, as its own write; the
//    turn carries the picture and the sentence.
//  - Busy for the whole wait: nothing typed (the caller types today's line).
//    Busy for part of it: it waits, then pastes.
//  - No placeholder: taken back with Ctrl+U, the composer seen empty, no
//    sentence and no Enter. Taken back only while the composer holds nothing
//    but the paste: text typed beside it stays, and the answer says so.
//  - A prompt up after the paste: nothing more typed or taken back.
//  - A path or sentence it refuses: nothing typed. Never Ctrl+C.
//  - The sentence not confirmed: no Enter; taken back with the placeholder.
//  - 2.1.3-beta.17 C9 (aicc_planning#420): Codex's warning count showing, as
//    Codex draws it (C7's recordings: at the right of its hint row while the
//    composer is empty, alone under the footer once it holds something): the
//    paste, the sentence and Enter once, as without it. A reply running with
//    the count: it waits, as a prompt button does, and types nothing while
//    the reply runs. The count alone under an empty composer (not recorded)
//    or a prompt up with the count: nothing typed.
//
// Red on beta: no such rule (session-screen.ts exports no
// pasteImageIntoCodexComposer). Mutants this must catch: the placeholder
// check dropped (the sentence typed with no placeholder); the take-back's
// own-text check dropped; C9: a running reply read as ready; the window
// title's spinner not read; the count alone kept in the screen read past the
// placeholder.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { pasteImageIntoCodexComposer, IMAGE_PLACEHOLDER_WAIT_MS } = await import('../../../src/main/providers/codex/session-screen')
const { TAKE_BACK_KEY } = await import('../../../src/main/providers/codex/composer-submit')
type Deps = Parameters<typeof pasteImageIntoCodexComposer>[2]
type Line = { text: string; typed: string; width?: number; end?: number }

const P = String.fromCharCode(0x203a)
const DOT = String.fromCharCode(0xb7)
const WARN = `${String.fromCharCode(0x26a0)} 1 warning ${DOT} f2 to view`
/** Codex's warning row as C7 recorded it on a 120-cell row: `hint` at the
 *  footer's indent (none: the count alone), the count ending one cell from
 *  the right edge. */
const warningRow = (hint: string): Line => {
  const text = `${hint}${' '.repeat(119 - hint.length - WARN.length)}${WARN}`
  return { text, typed: text, width: 120, end: 119 }
}
const ENTER = '\r'
const CTRL_C = String.fromCharCode(3)
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
const PATH = 'C:\\Users\\me\\AppData\\Local\\AI Code Conductor\\resources\\screenshots\\screenshot-2026-11-24-061500.jpg'
const SENTENCE = 'I just snapped a region of my screen - please view it.'
const plain = (text: string): Line => ({ text, typed: text })

interface SimOptions {
  /** What Codex draws for the paste: its placeholder (the default), the path as text, or nothing. */
  pasteShows?: 'placeholder' | 'text' | 'nothing'
  /** How long a write takes to draw. */
  drawMs?: number
  /** Codex runs a turn until this time. */
  busyUntil?: number
  /** Codex shows its warning count from this time, as it draws it (C7's
   *  recordings): at the right of its hint row while the composer is empty,
   *  alone under the footer once the composer holds something. */
  warningFrom?: number
  /** C9: the count alone under an empty composer too (not recorded). */
  countAloneAtRest?: boolean
  /** A trust prompt comes up this long after the paste. */
  promptAfterPasteMs?: number
  /** C9: a trust prompt is up from this time. */
  promptAt?: number
  /** The user types this beside the paste as it is drawn. */
  userTypes?: string
  /** Codex draws the sentence without its last character. */
  dropsLast?: boolean
  /** The user deletes the placeholder this long after it shows. */
  userDeletesAfterMs?: number
}

/** A simulated Codex composer, with the rule's deps over it. */
function sim(opts: SimOptions = {}) {
  let t = 0
  let alive = true
  let pending: { data: string; at: number } | null = null
  let image: string | null = null
  let shownAt: number | null = null
  let text = ''
  let promptFrom = opts.promptAt ?? Number.POSITIVE_INFINITY
  const writes: Array<{ at: number; data: string }> = []
  const turns: Array<{ text: string; images: string[] }> = []
  const logs: string[] = []
  const draw = (): void => {
    if (pending && t >= pending.at) {
      const d = pending.data
      pending = null
      if (d.startsWith(PASTE_START)) {
        const path = d.slice(PASTE_START.length, d.length - PASTE_END.length)
        if ((opts.pasteShows ?? 'placeholder') === 'placeholder') { image = path; shownAt = t }
        else if (opts.pasteShows === 'text') text += path
        if (opts.userTypes) text += ` ${opts.userTypes}`
      } else text += opts.dropsLast ? d.slice(0, -1) : d
    }
    if (image && shownAt !== null && opts.userDeletesAfterMs !== undefined && t >= shownAt + opts.userDeletesAfterMs) image = null
  }
  const row = (): Line => {
    if (!image && text === '') return { text: `${P} Ask Codex to do anything`, typed: P }
    return plain(`${P} ${image ? '[Image #1] ' : ''}${text}`.replace(/\s+$/, ''))
  }
  const readScreen = (): Line[] => {
    draw()
    const head = [plain('  Tip: New Build faster with Codex.')]
    const warn = opts.warningFrom !== undefined && t >= opts.warningFrom
    if (t >= promptFrom) return [...head, plain('  Do you trust the contents of this directory?'), plain(`${P} 1. Yes, continue`), plain('  Press enter to continue'), ...(warn ? [warningRow('')] : [])]
    const busy = (opts.busyUntil ?? 0) > t
    const empty = !image && text === ''
    return [
      ...head,
      ...(busy ? [plain('\u2022 Working (2s \u2022 esc to interrupt)')] : []),
      row(),
      plain(`  gpt-5.5 medium ${DOT} C:\\dev\\demo`),
      ...(warn ? [warningRow(empty && !opts.countAloneAtRest ? '  ? for shortcuts' : '')] : []),
    ]
  }
  const deps: Deps = {
    readScreen,
    size: () => ({ cols: 120, rows: 40 }),
    write: (data) => {
      writes.push({ at: t, data })
      draw()
      if (data === ENTER) {
        if (pending) return
        turns.push({ text: `${image ? '[Image #1] ' : ''}${text}`, images: image ? [image] : [] })
        image = null
        text = ''
        return
      }
      if (data === TAKE_BACK_KEY) { pending = null; image = null; text = ''; return }
      if (data.startsWith(PASTE_START) && opts.promptAfterPasteMs !== undefined) promptFrom = t + opts.promptAfterPasteMs
      pending = { data, at: t + (opts.drawMs ?? 200) }
    },
    live: () => alive,
    now: () => t,
    sleep: async (ms) => { t += Math.max(0, ms) },
    log: (msg) => { logs.push(msg) },
  }
  return { deps, writes, turns, logs, end: () => { alive = false }, get now() { return t } }
}

const datas = (w: Array<{ data: string }>): string[] => w.map((x) => x.data)
const PASTE = `${PASTE_START}${PATH}${PASTE_END}`

describe('a ready Codex session', () => {
  it('gets the paste, then the sentence once the placeholder shows, then Enter once', async () => {
    const s = sim()
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: true })
    expect(datas(s.writes)).toEqual([PASTE, ` ${SENTENCE}`, ENTER])
    expect(s.turns).toEqual([{ text: `[Image #1]  ${SENTENCE}`, images: [PATH] }])
    // The sentence only after the placeholder was drawn (200 ms).
    expect(s.writes[1].at - s.writes[0].at).toBeGreaterThanOrEqual(200)
  })
})

describe('Codex not ready', () => {
  it('busy for the whole wait: nothing typed, and the caller types today\'s line', async () => {
    const s = sim({ busyUntil: 60_000 })
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: false, reason: 'busy-timeout', left: false })
    expect(s.writes).toEqual([])
    expect(s.now).toBeGreaterThanOrEqual(5_000)
  })

  it('busy for part of the wait: it waits, then pastes and sends', async () => {
    const s = sim({ busyUntil: 2_000 })
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: true })
    expect(s.writes[0].at).toBeGreaterThanOrEqual(2_000)
    expect(s.turns).toEqual([{ text: `[Image #1]  ${SENTENCE}`, images: [PATH] }])
  })

})

describe('C9: Codex\'s warning count showing (aicc_planning#420)', () => {
  it('at rest: the paste, the sentence once the placeholder shows, then Enter once, as without it', async () => {
    const s = sim({ warningFrom: 0 })
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: true })
    expect(datas(s.writes)).toEqual([PASTE, ` ${SENTENCE}`, ENTER])
    expect(s.turns).toEqual([{ text: `[Image #1]  ${SENTENCE}`, images: [PATH] }])
    expect(s.writes[1].at - s.writes[0].at).toBeGreaterThanOrEqual(200)
  })

  it('shown from just after the paste: read as Codex draws it, and sent once', async () => {
    const s = sim({ warningFrom: 400, drawMs: 600 })
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: true })
    expect(datas(s.writes)).toEqual([PASTE, ` ${SENTENCE}`, ENTER])
    expect(s.turns).toEqual([{ text: `[Image #1]  ${SENTENCE}`, images: [PATH] }])
  })

  it('a reply running for the whole wait: nothing typed, after the whole wait', async () => {
    const s = sim({ warningFrom: 0, busyUntil: 60_000 })
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: false, reason: 'busy-timeout', left: false })
    expect(s.writes).toEqual([])
    expect(s.now).toBeGreaterThanOrEqual(5_000)
  })

  it('a reply that ends within the wait: it waits, then pastes and sends once', async () => {
    const s = sim({ warningFrom: 0, busyUntil: 2_000 })
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: true })
    expect(s.writes[0].at).toBeGreaterThanOrEqual(2_000)
    expect(datas(s.writes)).toEqual([PASTE, ` ${SENTENCE}`, ENTER])
  })

  it('not at its prompt: the count alone under an empty composer (not recorded), or a prompt up: nothing typed', async () => {
    const alone = sim({ warningFrom: 0, countAloneAtRest: true })
    expect(await pasteImageIntoCodexComposer(PATH, SENTENCE, alone.deps, { readyWaitMs: 5_000 })).toEqual({ pasted: false, reason: 'busy-timeout', left: false })
    expect(alone.writes).toEqual([])
    const prompt = sim({ warningFrom: 0, promptAt: 0 })
    expect(await pasteImageIntoCodexComposer(PATH, SENTENCE, prompt.deps, { readyWaitMs: 5_000 })).toEqual({ pasted: false, reason: 'prompt-on-screen', left: false })
    expect(prompt.writes).toEqual([])
  })
})

describe('no placeholder after the paste', () => {
  it.each([['nothing drawn', 'nothing'], ['the path drawn as text', 'text']] as const)('%s: taken back with Ctrl+U, the composer seen empty; no sentence, no Enter', async (_name, shows) => {
    const s = sim({ pasteShows: shows })
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: false, reason: 'no-placeholder', left: false })
    expect(datas(s.writes)).toEqual(shows === 'nothing' ? [PASTE] : [PASTE, TAKE_BACK_KEY])
    expect(s.turns).toEqual([])
    expect(s.now).toBeGreaterThanOrEqual(IMAGE_PLACEHOLDER_WAIT_MS)
  })

  // Snap e2e run 46023467484: one no-placeholder whose log could not say
  // whether Codex took the paste as text or drew its placeholder late. The
  // take-back says what the composer held, by kind and length only.
  it.each([['nothing drawn', 'nothing', /held nothing$/], ['the path drawn as text', 'text', /held \d+ characters of the path, as text$/]] as const)('%s: the log says what the composer held when the paste was taken back, never the path', async (_name, shows, held) => {
    const s = sim({ pasteShows: shows })
    await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    const line = s.logs.find((l) => l.startsWith('no-placeholder: '))
    expect(line, s.logs.join(' | ')).toMatch(held)
    expect(Number(/^no-placeholder: (\d+) ms after the paste/.exec(line!)?.[1])).toBeGreaterThanOrEqual(IMAGE_PLACEHOLDER_WAIT_MS)
    expect(s.logs.join(' | ')).not.toContain('screenshot-')
  })

  it('the user typed beside the paste: nothing taken back, and the answer says it may still be there', async () => {
    const s = sim({ userTypes: 'hello' })
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: false, reason: 'no-placeholder', left: true })
    expect(datas(s.writes)).toEqual([PASTE])
  })

  it('a prompt up after the paste: nothing more typed or taken back', async () => {
    const s = sim({ promptAfterPasteMs: 50, drawMs: 600 })
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: false, reason: 'prompt-on-screen', left: true })
    expect(datas(s.writes)).toEqual([PASTE])
  })
})

describe('the sentence', () => {
  it('not confirmed on screen: no Enter, and taken back with the placeholder', async () => {
    const s = sim({ dropsLast: true })
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: false, reason: 'not-drawn', left: false })
    expect(datas(s.writes)).toEqual([PASTE, ` ${SENTENCE}`, TAKE_BACK_KEY])
    expect(s.turns).toEqual([])
  })

  it('the placeholder gone before the sentence (the user deleted it): the sentence is never typed', async () => {
    const s = sim({ userDeletesAfterMs: 150 })
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: false, reason: 'busy-timeout', left: false })
    expect(datas(s.writes)).toEqual([PASTE])
    expect(s.turns).toEqual([])
  })
})

describe('refused before anything is typed', () => {
  it.each([
    ['an empty path', '', SENTENCE],
    ['an ESC in the path (it would end the paste early)', `C:\\x${PASTE_END}\\shot.jpg`, SENTENCE],
    ['a line break in the path', 'C:\\x\n.jpg', SENTENCE],
    ['a character outside the Basic Multilingual Plane in the sentence (Codex drops it)', PATH, `look ${String.fromCodePoint(0x1f600)}`],
    ['a control character in the sentence', PATH, 'look\rnow'],
  ])('%s', async (_name, path, sentence) => {
    const s = sim()
    expect(await pasteImageIntoCodexComposer(path, sentence, s.deps, { readyWaitMs: 5_000 })).toEqual({ pasted: false, reason: 'refused-text', left: false })
    expect(s.writes).toEqual([])
  })
})

describe('the run', () => {
  it('ends after the paste: nothing more typed', async () => {
    const s = sim({ drawMs: 1_000 })
    const p = pasteImageIntoCodexComposer(PATH, SENTENCE, { ...s.deps, write: (d) => { s.deps.write(d); if (d.startsWith(PASTE_START)) s.end() } }, { readyWaitMs: 5_000 })
    expect(await p).toEqual({ pasted: false, reason: 'session-gone', left: true })
    expect(datas(s.writes)).toEqual([PASTE])
  })

  it('never sends Ctrl+C, whatever happens', async () => {
    for (const o of [{}, { pasteShows: 'text' as const }, { dropsLast: true }, { busyUntil: 60_000 }, { userTypes: 'x' }, { warningFrom: 0, dropsLast: true }]) {
      const s = sim(o)
      await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
      expect(datas(s.writes)).not.toContain(CTRL_C)
    }
  })
})

// C9 (aicc_planning#420), on recorded Codex 0.157.1 screens (the Windows test
// machine, bundled ConPTY, 120 by 40; helper/fixtures/screens, read only).
// Before the paste and after Enter: P19's idle screen with the count at the
// right of its hint row (codex-windows-bundled-warning-hint). Mid-reply:
// P19's screen of a reply streaming with the count, its window title
// spinning (codex-windows-bundled-mid-reply). After the paste and after the
// sentence: C7's recorded draft screen with the count alone under the footer
// (codex-windows-bundled-warning-draft), its composer row as C6's reading
// recorded it after the paste ("[Image #1]") and after the sentence
// ("[Image #1]  <sentence>"). Not recorded: "[Image #1]" over the count
// itself; Codex hides its hint and keeps the count alone under a composer that
// holds anything (C7's hold: a draft, a wrapped draft, its paste placeholder,
// a draft after a reply). The placeholder shows 300 ms after the paste (C6's
// reading: 251 to 314 ms). Before C9 the rule refused each of these screens
// (`warning-count`) and typed nothing, so the renderer typed the path.
type Shot = { lines: Line[]; title: string | null }
const FIX = resolve(__dirname, '..', '..', '..', 'helper', 'fixtures', 'screens')
const recordedShot = (name: string): Shot => {
  const r = JSON.parse(readFileSync(resolve(FIX, `${name}.rows.json`), 'utf8')) as { title: string | null; screens: Array<{ lines: Line[] }> }
  return { lines: r.screens[r.screens.length - 1].lines, title: r.title }
}
const IDLE_COUNT = recordedShot('codex-windows-bundled-warning-hint')
const MID_REPLY_COUNT = recordedShot('codex-windows-bundled-mid-reply')
const DRAFT_COUNT = recordedShot('codex-windows-bundled-warning-draft')
const withComposerRow = (shot: Shot, text: string): Shot => ({ ...shot, lines: shot.lines.map((l) => (l.text.startsWith(P) ? { ...l, text, typed: text, end: text.length } : l)) })
const PLACEHOLDER_COUNT = withComposerRow(DRAFT_COUNT, `${P} [Image #1]`)
const SENT_COUNT = withComposerRow(DRAFT_COUNT, `${P} [Image #1]  ${SENTENCE}`)

/** Codex over the recorded screens: mid-reply until `busyUntil`, then idle. */
function recordedCodex(busyUntil = 0) {
  let t = 0
  let phase: 'idle' | 'pasted' | 'sent' = 'idle'
  let pastedAt = 0
  const writes: Array<{ at: number; data: string }> = []
  const turns: string[] = []
  const shot = (): Shot => {
    if (phase === 'sent') return SENT_COUNT
    if (phase === 'pasted' && t >= pastedAt + 300) return PLACEHOLDER_COUNT
    return t < busyUntil ? MID_REPLY_COUNT : IDLE_COUNT
  }
  const deps: Deps = {
    readScreen: () => shot().lines,
    readTitle: () => shot().title,
    size: () => ({ cols: 120, rows: 40 }),
    write: (data) => {
      writes.push({ at: t, data })
      if (data.startsWith(PASTE_START)) { phase = 'pasted'; pastedAt = t } else if (data === ` ${SENTENCE}` && phase === 'pasted') phase = 'sent'
      else if (data === ENTER && phase === 'sent') { turns.push(`[Image #1]  ${SENTENCE}`); phase = 'idle' } else if (data === TAKE_BACK_KEY) phase = 'idle'
    },
    live: () => true,
    now: () => t,
    sleep: async (ms) => { t += Math.max(0, ms) },
  }
  return { deps, writes, turns }
}

describe('C9: on recorded Codex 0.157.1 screens with the warning count', () => {
  it('the screens hold what this assumes: the count at the right of the hint row, and alone under the draft', () => {
    const last = (s: Shot): Line => s.lines.filter((l) => l.text.trim() !== '').pop() as Line
    expect(last(IDLE_COUNT).text).toMatch(new RegExp(`^  \\? for shortcuts +${WARN}$`))
    expect(last(MID_REPLY_COUNT).text).toMatch(new RegExp(`^  \\? for shortcuts +${WARN}$`))
    expect(MID_REPLY_COUNT.title?.charCodeAt(0)).toBeGreaterThanOrEqual(0x2800)
    expect(last(PLACEHOLDER_COUNT).text.trim()).toBe(WARN)
    expect(PLACEHOLDER_COUNT.lines.filter((l) => l.text.startsWith(P)).map((l) => l.text)).toEqual([`${P} [Image #1]`])
  })

  it('at rest: the paste, the sentence once the placeholder shows, then Enter once', async () => {
    const s = recordedCodex()
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: true })
    expect(datas(s.writes)).toEqual([PASTE, ` ${SENTENCE}`, ENTER])
    expect(s.writes[1].at - s.writes[0].at).toBeGreaterThanOrEqual(300)
    expect(s.turns).toEqual([`[Image #1]  ${SENTENCE}`])
  })

  it('mid-reply (the title spinning): held, then pasted and sent once the reply ends', async () => {
    const s = recordedCodex(4_000)
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: true })
    expect(s.writes[0].at).toBeGreaterThanOrEqual(4_000)
    expect(datas(s.writes)).toEqual([PASTE, ` ${SENTENCE}`, ENTER])
  })

  it('a reply that outlasts the wait: nothing typed', async () => {
    const s = recordedCodex(Number.POSITIVE_INFINITY)
    const r = await pasteImageIntoCodexComposer(PATH, SENTENCE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ pasted: false, reason: 'busy-timeout', left: false })
    expect(s.writes).toEqual([])
  })
})
