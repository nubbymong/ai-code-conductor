// 2.1.3-beta.17 section C7 (aicc_planning #371): Codex's warning count,
// "<warning sign> N warning(s) . f2 to view", at the right of the row under
// its footer. Codex shows it for a tool server that cannot start,
// --strict-config, or on Windows with 0.161.0+ the app run as administrator;
// until C7 the reader took no screen with it, so the app typed nothing into a
// Codex session while it showed. Once a text is typed at an idle composer,
// Codex hides its hint and keeps the count ALONE under the footer (its
// snapshot test warning_notice_styles, chat_composer/warning_notice_tests.rs at
// rust-v0.157.1 and rust-v0.170.0). C7's recording hold recorded that screen
// on the Windows test machine (P19's recorder, Codex 0.157.1 on its stand-in,
// a tool server whose program does not exist; both ConPTYs, 3 runs each, the
// same row in every run): a draft, a draft Codex wraps onto two rows, its
// paste placeholder and a draft typed after a reply, each over the count
// alone, ending one cell from the right edge. The reader now takes:
//  - the warning row at an empty composer (the hint, then the count): ready,
//    or busy while a turn runs, as the hint row alone reads;
//  - the count alone under a draft: the draft is read, and the readers that
//    confirm a typed text (codexTextTyped, codexCommandTyped,
//    codexPastedContentShown) confirm it, so composer-submit presses Enter,
//    or takes its text back when it is not confirmed.
//
// The screens: the corpus's own (helper/fixtures/screens/<name>.rows.json, the
// last screen, which tests/unit/shared/screen-corpus.test.ts holds to the
// recordings), and, for the wrapped draft, the paste placeholder and the
// draft after a reply, which the corpus does not hold (its 3 MiB cap), the
// bottom rows of the hold's recordings copied as recorded
// (codex-{bundled,system}-wwrap-1, -wpaste-1 and -wseq-1, run 1 of the
// bundled ConPTY; the system ConPTY's rows are the same).
//
// Not checked here:
//  - Codex 0.170.0 with a draft typed over the count: not recorded (its
//    snapshot test says the same row);
//  - a slash command's popup with the count: not recorded, so the count under
//    a popup is still refused;
//  - macOS and Linux: the hold ran on Windows only;
//  - a signed-in Codex (whether a real model's session shows the count, and
//    how often): no account on the test machine (#371 step 1's signed-in
//    count, named owed in #371).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  readCodexScreen, codexComposerState, codexComposerDraft, codexComposerRows, codexTextTyped, codexCommandTyped,
  codexPastedContentShown, type ScreenLine,
} from '../../../src/shared/codex-screen'
import { submitToCodexComposer, TAKE_BACK_KEY, type ComposerSubmitDeps } from '../../../src/main/providers/codex/composer-submit'
import { typeIntoCodexComposer, StartupDoneRuns, CODEX_SUBMIT_DELAY_MS, type CodexComposerDeps } from '../../../src/renderer/lib/codexComposer'

const DIR = resolve(__dirname, '../../../helper/fixtures/screens')
/** The last screen of a corpus recording, and the title its output last set. */
function recorded(name: string): { lines: ScreenLine[]; title: string | null } {
  const r = JSON.parse(readFileSync(resolve(DIR, `${name}.rows.json`), 'utf-8')) as { title: string | null; screens: Array<{ lines: ScreenLine[] }> }
  return { lines: r.screens[r.screens.length - 1].lines, title: r.title }
}

const P = String.fromCharCode(0x203a)
const DOT = String.fromCharCode(0xb7)
const ARROW = String.fromCharCode(0x2190)
const WARN = String.fromCharCode(0x26a0)
const W = 120
const row = (text: string, typed: string, end: number): ScreenLine => ({ text, typed, inverse: '', width: W, end })
const blank = (): ScreenLine => row('', '', 0)
const plain = (text: string): ScreenLine => row(text, text, text.length)
const EMPTY = row(`${P} Ask Codex to do anything`, P, 26)
/** The count as Codex draws it, ending one cell from the right edge. */
const count = (n: number, at: number = W - 1): string => {
  const c = `${WARN} ${n} warning${n === 1 ? '' : 's'} ${DOT} f2 to view`
  return `${' '.repeat(at - c.length)}${c}`
}
const FOOTER = plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-W0xjQq\\codex-bundled-wseq-1\\work`)

/** The corpus's idle screens with the count at the right of the hint row: an
 *  empty composer, at rest. */
const IDLE = [
  'codex-windows-bundled-warning-hint', 'codex-macos-warning-hint',
  'codex170-windows-bundled-warning-hint', 'codex170-macos-warning-hint', 'codex170-linux-after-reply',
  'codex-windows-bundled-after-reply', 'codex-windows-system-after-reply', 'codex-macos-after-reply',
]
/** The corpus's draft screens (C7's hold): the count alone under the draft. */
const DRAFTS = ['codex-windows-bundled-warning-draft', 'codex-windows-system-warning-draft']
const DRAFT = "p19 short: print the probe's short reply"

/** The hold's screens the corpus does not hold, bottom rows as recorded. */
const FOX = 'the quick brown fox jumps over the lazy dog'
const WRAPPED_TEXT = `p19 wrapped draft: ${FOX} ${FOX} ${FOX} end`
const WRAPPED: ScreenLine[] = [
  blank(),
  plain(`${P} p19 wrapped draft: ${FOX} ${FOX} the quick`),
  plain('  brown fox jumps over the lazy dog end'),
  blank(),
  plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-W0xjQq\\codex-bundled-wwrap-1\\work`),
  plain(count(1)),
]
const PASTED: ScreenLine[] = [
  blank(), plain(`${P} [Pasted Content 1200 chars]`), blank(),
  plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-W0xjQq\\codex-bundled-wpaste-1\\work`),
  plain(count(1)),
]
const AFTER_REPLY_DRAFT: ScreenLine[] = [plain('  11:30 PM'), blank(), plain(`${P} p19 draft after the reply`), blank(), FOOTER, plain(count(2))]

describe("Codex's warning count, read (C7, #371)", () => {
  it('the recorded rows are as written here: the count ends one cell from the right edge', () => {
    for (const name of [...IDLE, ...DRAFTS]) {
      const last = recorded(name).lines.filter((l) => l.text.trim() !== '').pop() as ScreenLine
      expect({ name, end: last.end, width: last.width, count: last.text.endsWith(`${WARN} 1 warning ${DOT} f2 to view`) }).toEqual({ name, end: W - 1, width: W, count: true })
    }
    const draft = recorded(DRAFTS[0]).lines.filter((l) => l.text.trim() !== '').pop() as ScreenLine
    expect(draft.text).toBe(count(1))
  })

  it('an idle screen with the count at the right of the hint row reads ready, the composer empty', () => {
    for (const name of IDLE) {
      const { lines, title } = recorded(name)
      expect(readCodexScreen(lines, null, { title }), name).toEqual({ screen: 'ready', text: '' })
      expect(readCodexScreen(lines, ['p19-probe'], { title }), name).toEqual({ screen: 'ready', text: '' })
      expect(codexComposerState(lines), name).toBe('ready')
      expect(codexComposerDraft(lines), name).toBe('')
      expect(codexComposerRows(lines), name).toBe(1)
    }
  })

  it('a reply streaming with the count reads busy by its title spinner (Windows), and nothing is confirmed then', () => {
    const { lines, title } = recorded('codex-windows-bundled-mid-reply')
    expect(lines.filter((l) => l.text.trim() !== '').pop()?.text.endsWith(`${WARN} 1 warning ${DOT} f2 to view`)).toBe(true)
    expect(readCodexScreen(lines, null, { title }).screen).toBe('busy')
    expect(readCodexScreen([...lines.slice(0, 1), plain('  Working (3s, esc to interrupt)'), ...lines.slice(1)]).screen).toBe('busy')
  })

  it('a draft typed at the idle composer, over the count alone: read, and confirmed as typed', () => {
    for (const name of DRAFTS) {
      const { lines, title } = recorded(name)
      expect(readCodexScreen(lines, null, { title }), name).toEqual({ screen: 'ready', text: DRAFT })
      expect(codexComposerDraft(lines), name).toBe(DRAFT.replace(/\s+/g, ''))
      expect(codexComposerRows(lines), name).toBe(1)
      expect(codexTextTyped(lines, DRAFT, null, title), name).toBe(true)
      expect(codexTextTyped(lines, DRAFT, ['p19-probe'], title), name).toBe(true)
      expect(codexCommandTyped(lines, DRAFT, null, title), name).toBe(true)
      expect(codexTextTyped(lines, `${DRAFT}x`, null, title), name).toBe(false)
      // A spinner title (a turn running): never confirmed.
      expect(codexTextTyped(lines, DRAFT, null, `${String.fromCharCode(0x280b)} work`), name).toBe(false)
    }
  })

  it('a draft Codex wraps onto two rows over the count alone: read whole, two rows, confirmed', () => {
    expect(codexComposerDraft(WRAPPED)).toBe(WRAPPED_TEXT.replace(/\s+/g, ''))
    expect(codexComposerRows(WRAPPED)).toBe(2)
    expect(codexTextTyped(WRAPPED, WRAPPED_TEXT)).toBe(true)
    expect(codexTextTyped(WRAPPED, `${WRAPPED_TEXT} more`)).toBe(false)
    // As without the count: a composer of two rows is no ready screen.
    expect(readCodexScreen(WRAPPED).screen).toBe('unrecognised')
  })

  it("Codex's paste placeholder over the count alone: confirmed for exactly its count", () => {
    expect(codexPastedContentShown(PASTED, 1200)).toBe(true)
    expect(codexPastedContentShown(PASTED, 1199)).toBe(false)
    expect(codexComposerDraft(PASTED)).toBe('[PastedContent1200chars]')
  })

  it('a draft after a reply, over a count of 2: confirmed', () => {
    expect(codexTextTyped(AFTER_REPLY_DRAFT, 'p19 draft after the reply')).toBe(true)
    expect(readCodexScreen(AFTER_REPLY_DRAFT)).toEqual({ screen: 'ready', text: 'p19 draft after the reply' })
  })
})

describe('what the count check still refuses (C7)', () => {
  const idle = (last: ScreenLine): ScreenLine[] => [blank(), EMPTY, blank(), FOOTER, last]
  const draft = (last: ScreenLine): ScreenLine[] => [blank(), plain(`${P} ${DRAFT}`), blank(), FOOTER, last]
  const at = (text: string, end: number): ScreenLine => row(text, text, end)
  const hintAndCount = (hint: string, c: string): string => `  ${hint}${c.slice(2 + hint.length)}`

  it('the hint with the count reads ready; a count that is not Codex\'s, or not at the right edge, reads unrecognised', () => {
    expect(readCodexScreen(idle(plain(hintAndCount('? for shortcuts', count(1))))).screen).toBe('ready')
    expect(readCodexScreen(idle(plain(hintAndCount(`${ARROW} for agents ${DOT} ? for shortcuts`, count(3))))).screen).toBe('ready')
    for (const [what, text] of Object.entries({
      'another key': hintAndCount('? for shortcuts', count(1).replace('f2 to view', 'f3 to view')),
      'no key': `  ? for shortcuts${' '.repeat(78)}${WARN} 1 warning`,
      '1 warnings': hintAndCount('? for shortcuts', count(1).replace('warning ', 'warnings ').slice(1)),
      '2 warning': hintAndCount('? for shortcuts', ` ${count(2).replace('warnings', 'warning')}`),
      'a count of 0': hintAndCount('? for shortcuts', count(1).replace(' 1 ', ' 0 ')),
      'no warning sign': hintAndCount('? for shortcuts', count(1).replace(WARN, '!')),
      'junk between': `  ? for shortcuts${' '.repeat(36)}junk${' '.repeat(38)}${WARN} 1 warning ${DOT} f2 to view`,
      'the queue hint and the count': hintAndCount('tab to queue message', count(1)),
      'a hint not recorded': hintAndCount('f7 for shortcuts', count(1)),
    })) {
      expect(readCodexScreen(idle(plain(text))).screen, what).toBe('unrecognised')
    }
    // No space between the hint and the count (at the right edge all the same).
    expect(readCodexScreen(idle(at(`  ? for shortcuts${WARN} 1 warning ${DOT} f2 to view`, W - 1))).screen).toBe('unrecognised')
    // Not at the right edge, where the reader knows the row's width.
    const c = `${WARN} 1 warning ${DOT} f2 to view`
    expect(readCodexScreen(idle(at(`  ? for shortcuts${' '.repeat(60)}${c}`, 101))).screen).toBe('unrecognised')
    expect(readCodexScreen(idle(at(`  ? for shortcuts${' '.repeat(79)}${c}`, 120))).screen).toBe('unrecognised')
    // Where it does not know the width, the text alone is read.
    expect(readCodexScreen(idle({ text: `  ? for shortcuts${' '.repeat(60)}${c}`, typed: `  ? for shortcuts${' '.repeat(60)}${c}` })).screen).toBe('ready')
  })

  it('the count alone under an empty composer is not recorded: unrecognised, and no draft read', () => {
    expect(readCodexScreen(idle(plain(count(1)))).screen).toBe('unrecognised')
    expect(codexComposerDraft(idle(plain(count(1))))).toBeNull()
  })

  it('the count alone under a draft: refused when it is not Codex\'s, not at the right edge, twice, or above the footer', () => {
    expect(codexTextTyped(draft(plain(count(1))), DRAFT)).toBe(true)
    for (const [what, screen] of Object.entries({
      'another key': draft(plain(count(1).replace('f2 to view', 'f3 to view'))),
      'not at the edge': draft(at(count(1, 100), 100)),
      'at the edge itself': draft(at(` ${count(1)}`, 120)),
      'twice': [...draft(plain(count(1))), plain(count(1))],
      'above the footer': [blank(), plain(`${P} ${DRAFT}`), blank(), plain(count(1)), FOOTER],
      'with the hint at its left': draft(plain(hintAndCount('? for shortcuts', count(1)))),
    })) {
      expect(codexTextTyped(screen, DRAFT), what).toBe(false)
      expect(codexCommandTyped(screen, DRAFT), what).toBe(false)
    }
    const folded = (last: ScreenLine): ScreenLine[] => [blank(), plain(`${P} [Pasted Content 1200 chars]`), blank(), FOOTER, last]
    expect(codexPastedContentShown(folded(plain(count(1))), 1200)).toBe(true)
    expect(codexPastedContentShown(folded(plain(count(1).replace('f2', 'f3'))), 1200)).toBe(false)
    expect(codexPastedContentShown([...folded(plain(count(1))), plain(count(1))], 1200)).toBe(false)
  })

  it('a command\'s popup with the count under it is not recorded: not confirmed', () => {
    const popup = [blank(), plain(`${P} /compact`), blank(), plain('  /compact  summarize the conversation'), plain(count(1))]
    expect(codexCommandTyped(popup, '/compact')).toBe(false)
    expect(codexCommandTyped(popup.slice(0, -1), '/compact')).toBe(true)
  })
})

/** composer-submit over recorded screens: `before` until the text is written,
 *  then `after` (each a recording's last screen, with its title). */
function recordedSession(phases: Array<{ until: number; shot: { lines: ScreenLine[]; title: string | null } }>, afterWrite: (text: string) => { lines: ScreenLine[]; title: string | null } | null) {
  let t = 0
  const writes: Array<{ at: number; data: string }> = []
  let typed: { lines: ScreenLine[]; title: string | null } | null = null
  let cleared = false
  const shot = (): { lines: ScreenLine[]; title: string | null } => {
    if (typed && !cleared) return typed
    return (phases.find((p) => t < p.until) ?? phases[phases.length - 1]).shot
  }
  const deps: ComposerSubmitDeps = {
    readScreen: () => shot().lines,
    readTitle: () => shot().title,
    size: () => ({ cols: W, rows: 40 }),
    write: (data) => {
      writes.push({ at: t, data })
      if (data === TAKE_BACK_KEY) { cleared = true; return }
      if (data !== '\r') typed = afterWrite(data)
    },
    live: () => true,
    now: () => t,
    sleep: async (ms) => { t += Math.max(0, ms) },
  }
  return { deps, writes }
}

describe('a press with the count: composer-submit over the recorded screens (C7)', () => {
  const idle = recorded('codex-windows-bundled-after-reply')
  const draftShot = recorded('codex-windows-bundled-warning-draft')

  it('at rest: the text typed, confirmed over the count alone, and Enter sent once', async () => {
    const s = recordedSession([{ until: Number.POSITIVE_INFINITY, shot: idle }], (text) => (text === DRAFT ? draftShot : null))
    const r = await submitToCodexComposer(DRAFT, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: true })
    expect(s.writes.map((w) => w.data)).toEqual([DRAFT, '\r'])
  })

  it('mid-reply: held while the title spins, then typed and sent once the reply ends', async () => {
    const mid = recorded('codex-windows-bundled-mid-reply')
    const s = recordedSession([{ until: 4_000, shot: mid }, { until: Number.POSITIVE_INFINITY, shot: idle }], (text) => (text === DRAFT ? draftShot : null))
    const r = await submitToCodexComposer(DRAFT, s.deps, { readyWaitMs: 30_000 })
    expect(r).toEqual({ delivered: true })
    expect(s.writes.map((w) => w.data)).toEqual([DRAFT, '\r'])
    expect(s.writes[0].at).toBeGreaterThanOrEqual(4_000)
  })

  it('a reply that outlasts the wait: nothing typed', async () => {
    const mid = recorded('codex-windows-bundled-mid-reply')
    const s = recordedSession([{ until: Number.POSITIVE_INFINITY, shot: mid }], () => draftShot)
    const r = await submitToCodexComposer(DRAFT, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ delivered: false, reason: 'busy-timeout' })
    expect(s.writes).toEqual([])
  })

  it('a text not drawn whole: read over the count alone and taken back with Ctrl+U, no Enter', async () => {
    const part = DRAFT.slice(0, 20)
    const partial = { ...draftShot, lines: draftShot.lines.map((l) => (l.text === `${P} ${DRAFT}` ? { ...l, text: `${P} ${part}`, typed: `${P} ${part}`, end: 2 + part.length } : l)) }
    const s = recordedSession([{ until: Number.POSITIVE_INFINITY, shot: idle }], () => partial)
    const r = await submitToCodexComposer(DRAFT, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: false, reason: 'not-drawn' })
    expect(s.writes.map((w) => w.data)).toEqual([DRAFT, TAKE_BACK_KEY])
  })
})

describe("the renderer's typing with the count (C7)", () => {
  it('types into the idle composer, then Enter once the text shows over the count alone', () => {
    const idle = recorded('codex-windows-bundled-after-reply').lines
    const typedScreen = recorded('codex-windows-bundled-warning-draft').lines
    let screen = idle
    const writes: string[] = []
    const timers: Array<() => void> = []
    const deps: CodexComposerDeps = {
      readScreen: () => screen,
      currentRun: () => ({ createdAt: 1000, spawnToken: 7 }),
      write: (_id, d) => { writes.push(d); if (d === DRAFT) screen = typedScreen },
      setTimeout: (fn) => { timers.push(fn); return timers.length },
      clearTimeout: () => {},
      pending: new Set<string>(),
      startupDone: new StartupDoneRuns(),
    }
    const r = typeIntoCodexComposer('s1', DRAFT, deps)
    expect(r.typed).toBe(true)
    expect(CODEX_SUBMIT_DELAY_MS).toBeGreaterThan(0)
    timers.shift()?.()
    expect(writes).toEqual([DRAFT, '\r'])
  })
})
