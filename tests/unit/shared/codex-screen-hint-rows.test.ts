// 2.1.3-beta.12 section C3 (aicc_planning #357): the rows Codex draws under
// its footer, as probe P19's second run recorded them (Codex 0.157.1 and
// 0.170.0; helper/fixtures/screens/, ADR-030 "P19, second run"). #740
// (aicc_planning #349) taught the reader one such row, "? for shortcuts".
// Every other row P19 recorded there read unrecognised, so the app typed
// nothing into a Codex tab while one showed. The reader now takes each of
// these rows as recorded, as the one row under the footer, at the footer
// row's own indent:
//  - Codex 0.170.0's ready row, "<left arrow> for agents . ? for shortcuts"
//    (bottom_pane/chat_composer/passive_hints.rs, at the rust-v0.170.0 tag);
//  - the shortcuts key rebound to F6: "f6 for shortcuts" (0.157.1) and
//    "<left arrow> for agents . f6 for shortcuts" (0.170.0);
//  - the queue hint, "tab to queue message", which Codex draws while a turn
//    runs and a draft is in the composer: it reads busy, never ready.
// The draft and height readers also read a draft that Codex wraps onto more
// rows over the queue hint, so composer-submit can take back a text it typed
// while a reply streamed (codexComposerDraft, codexComposerRows).
// Still refused, on purpose: a warning count at the right of the row,
// "<warning sign> 1 warning . f2 to view" (both versions; P19 drew it with a
// config whose MCP server program does not exist). Once a text is typed at an
// idle composer, Codex keeps the count alone under the footer (its own
// snapshot test warning_notice_styles, chat_composer/warning_notice_tests.rs
// at both tags; P19's bytes, codex-macos-queue-hint event 83). No recording
// holds that row at an idle composer and no reader that confirms a typed text
// takes it, so with the count accepted the app would type and never press
// Enter. Also refused: any row not recorded (another key, another count), two
// rows under the footer, a row at another indent or above the footer, and
// every row under a wrapped footer. Codex 0.170.0 adds the thread's title to
// its footer once a prompt is sent, and the footer wraps when the folder and
// the title do not fit: those recordings still read unrecognised (the corpus
// test lists them, with the warning ones).
//
// The screens are the bottom six rows of the last screen of each recording
// (<name>.rows.json), copied as recorded, with the prompt glyph, the middle
// dot, the left arrow and the warning sign written as code points.
//
// Not checked here:
//  - a reply that streams: Codex shows no busy row then (P19 saw its working
//    row once, right after Enter), and every recorded mid-reply screen ends
//    in the warning count, so none shows a streaming reply over a row taken
//    here; the corpus test lists what the reader reads on them
//    (KNOWN_MISREADS);
//  - text typed at a composer with no turn running: the recordings hold it
//    with no warning (codex170-macos-queue-hint events 38 to 40: the hint row
//    goes and the footer takes the last row, which codexTextTyped confirms),
//    and none holds it with a warning count;
//  - a draft wrapped onto more rows over the queue hint is built here, not
//    recorded (every recorded draft is one row).
import { describe, it, expect } from 'vitest'
import {
  readCodexScreen, codexComposerState, codexComposerDraft, codexComposerRows, codexTextTyped, type ScreenLine,
} from '../../../src/shared/codex-screen'

const P = String.fromCharCode(0x203a)
const DOT = String.fromCharCode(0xb7)
const ARROW = String.fromCharCode(0x2190)
const WARN = String.fromCharCode(0x26a0)
const W = 120
const row = (text: string, typed: string, end: number): ScreenLine => ({ text, typed, inverse: '', width: W, end })
const blank = (): ScreenLine => row('', '', 0)
const plain = (text: string): ScreenLine => row(text, text, text.length)
/** The empty composer: the prompt glyph, then Codex's dim placeholder. */
const EMPTY = row(`${P} Ask Codex to do anything`, P, 26)

/** The recorded screens each accepted row turns from unrecognised to their
 *  state: ready, the composer empty. */
const READY: Record<string, ScreenLine[]> = {
  'codex170-windows-bundled-ready': [blank(), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-9qw1BB\\codex-bundled-turn-1\\work`), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts`)],
  'codex170-windows-system-ready': [blank(), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-9qw1BB\\codex-system-turn-1\\work`), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts`)],
  'codex170-macos-ready': [blank(), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} /private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/p19-yqcGCX/codex-pty-turn-1/work`), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts`)],
  'codex170-linux-ready': [blank(), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} /tmp/p19-CPwZE2/codex-pty-turn-1/work`), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts`)],
  'codex170-windows-bundled-agents-hint': [blank(), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-9qw1BB\\codex-bundled-agents-1\\work`), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts`)],
  'codex170-macos-agents-hint': [blank(), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} /private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/p19-yqcGCX/codex-pty-agents-1/work`), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts`)],
  'codex170-windows-bundled-rebound-hint': [blank(), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-9qw1BB\\codex-bundled-rebind-1\\work`), plain(`  ${ARROW} for agents ${DOT} f6 for shortcuts`)],
  'codex170-macos-rebound-hint': [blank(), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} /private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/p19-yqcGCX/codex-pty-rebind-1/work`), plain(`  ${ARROW} for agents ${DOT} f6 for shortcuts`)],
  'codex-windows-bundled-rebound-hint': [plain(`${' '.repeat(68)}Tip: Use /hooks to view and manage lifecycle hooks.`), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-4NXHlt\\codex-bundled-rebind-1\\work`), plain('  f6 for shortcuts')],
  'codex-macos-rebound-hint': [plain(`${' '.repeat(52)}Tip: Press ctrl+g to edit your current draft in an external editor.`), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} /private/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/p19-VXEoM0/codex-pty-rebind-1/work`), plain('  f6 for shortcuts')],
}

/** The queue hint under a footer of its own row (Codex 0.157.1). */
const QUEUE: Record<string, ScreenLine[]> = {
  'codex-windows-bundled-queue-hint': [blank(), blank(), plain(`${P} p19 queued draft`), blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-4NXHlt\\codex-bundled-queue-1\\work`), plain('  tab to queue message')],
  'codex-macos-queue-hint': [blank(), blank(), plain(`${P} p19 queued draft`), blank(), plain(`  p19-probe default ${DOT} /private/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/p19-VXEoM0/codex-pty-queue-1/work`), plain('  tab to queue message')],
}

/** The recorded screens that end in a warning count at the right of the
 *  hint row, under a footer of one row: still unrecognised. */
const WARNING_SCREENS: Record<string, ScreenLine[]> = {
  'codex170-windows-bundled-warning-hint': [blank(), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-9qw1BB\\codex-bundled-warning-1\\work`), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts${' '.repeat(63)}${WARN} 1 warning ${DOT} f2 to view`)],
  'codex170-macos-warning-hint': [blank(), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} /private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/p19-yqcGCX/codex-pty-warning-1/work`), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts${' '.repeat(63)}${WARN} 1 warning ${DOT} f2 to view`)],
  'codex170-linux-after-reply': [blank(), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} /tmp/p19-CPwZE2/codex-pty-short-1/work ${DOT} p19 short: print the probe's short reply`), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts${' '.repeat(63)}${WARN} 1 warning ${DOT} f2 to view`)],
  'codex-windows-bundled-warning-hint': [plain(`${' '.repeat(56)}Tip: Coming back to a conversation? Use /recap to summarize it.`), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-4NXHlt\\codex-bundled-warning-1\\work`), plain(`  ? for shortcuts${' '.repeat(78)}${WARN} 1 warning ${DOT} f2 to view`)],
  'codex-macos-warning-hint': [plain(`${' '.repeat(70)}Tip: Use /keymap to configure keyboard shortcuts.`), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} /private/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/p19-VXEoM0/codex-pty-warning-1/work`), plain(`  ? for shortcuts${' '.repeat(78)}${WARN} 1 warning ${DOT} f2 to view`)],
  'codex-windows-bundled-after-reply': [plain(`${' '.repeat(67)}Tip: Use /vim to toggle Vim editing in the composer.`), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-4NXHlt\\codex-bundled-short-1\\work`), plain(`  ? for shortcuts${' '.repeat(78)}${WARN} 1 warning ${DOT} f2 to view`)],
  'codex-windows-system-after-reply': [plain(`${' '.repeat(47)}Tip: Use /statusline to configure which items appear in the status line.`), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-4NXHlt\\codex-system-short-1\\work`), plain(`  ? for shortcuts${' '.repeat(78)}${WARN} 1 warning ${DOT} f2 to view`)],
  'codex-macos-after-reply': [plain(`${' '.repeat(56)}Tip: Coming back to a conversation? Use /recap to summarize it.`), blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} /private/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/p19-VXEoM0/codex-pty-short-1/work`), plain(`  ? for shortcuts${' '.repeat(78)}${WARN} 1 warning ${DOT} f2 to view`)],
}

/** Codex 0.170.0's screens after a prompt where the footer wraps onto a
 *  second row: still unrecognised, whatever row is under them. */
const WRAPPED: Record<string, ScreenLine[]> = {
  'codex170-windows-bundled-queue-hint': [blank(), plain(`${P} p19 queued draft`), blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-9qw1BB\\codex-bundled-queue-1\\work ${DOT} p19 short: print the probe's short`), plain('  reply'), plain('  tab to queue message')],
  'codex170-macos-queue-hint': [blank(), plain(`${P} p19 queued draft`), blank(), plain(`  p19-probe default ${DOT} /private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/p19-yqcGCX/codex-pty-queue-1/work ${DOT} p19`), plain("  short: print the probe's short reply"), plain('  tab to queue message')],
  'codex170-windows-bundled-after-reply': [blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-9qw1BB\\codex-bundled-short-1\\work ${DOT} p19 short: print the probe's short`), plain('  reply'), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts${' '.repeat(63)}${WARN} 1 warning ${DOT} f2 to view`)],
  'codex170-windows-system-after-reply': [blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-9qw1BB\\codex-system-short-1\\work ${DOT} p19 short: print the probe's short`), plain('  reply'), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts${' '.repeat(63)}${WARN} 1 warning ${DOT} f2 to view`)],
  'codex170-macos-after-reply': [blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} /private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/p19-yqcGCX/codex-pty-short-1/work ${DOT} p19`), plain("  short: print the probe's short reply"), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts${' '.repeat(63)}${WARN} 1 warning ${DOT} f2 to view`)],
  'codex170-windows-bundled-mid-reply': [blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-9qw1BB\\codex-bundled-short-1\\work ${DOT} p19 short: print the probe's short`), plain('  reply'), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts${' '.repeat(63)}${WARN} 1 warning ${DOT} f2 to view`)],
  'codex170-windows-system-mid-reply': [blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-9qw1BB\\codex-system-short-1\\work ${DOT} p19 short: print the probe's short`), plain('  reply'), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts${' '.repeat(63)}${WARN} 1 warning ${DOT} f2 to view`)],
  'codex170-macos-mid-reply': [blank(), EMPTY, blank(), plain(`  p19-probe default ${DOT} /private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/p19-yqcGCX/codex-pty-short-1/work ${DOT} p19`), plain("  short: print the probe's short reply"), plain(`  ${ARROW} for agents ${DOT} ? for shortcuts${' '.repeat(63)}${WARN} 1 warning ${DOT} f2 to view`)],
}

const AGENTS = `${ARROW} for agents ${DOT} ? for shortcuts`
const WARNING = `${WARN} 1 warning ${DOT} f2 to view`
/** A hint row: `text` at `indent`. */
const hint = (indent: number, text: string): ScreenLine => plain(' '.repeat(indent) + text)
/** Each row the reader now takes, by a recording that ends in it (the
 *  recorded footer above it, at two spaces). */
const ACCEPTED: Record<string, { screen: ScreenLine[]; text: string; reads: 'ready' | 'busy' }> = {
  agents: { screen: READY['codex170-linux-ready'], text: AGENTS, reads: 'ready' },
  'agents, rebound': { screen: READY['codex170-macos-rebound-hint'], text: `${ARROW} for agents ${DOT} f6 for shortcuts`, reads: 'ready' },
  rebound: { screen: READY['codex-macos-rebound-hint'], text: 'f6 for shortcuts', reads: 'ready' },
  queue: { screen: QUEUE['codex-macos-queue-hint'], text: 'tab to queue message', reads: 'busy' },
}
const lastRow = (screen: ScreenLine[]): ScreenLine => screen[screen.length - 1]
const footerRow = (screen: ScreenLine[]): ScreenLine => screen[screen.length - 2]
/** The screen down to the composer (and the blank row under it). */
const composerPart = (screen: ScreenLine[]): ScreenLine[] => screen.slice(0, -2)
/** A row moved to another indent, its end moved with it. */
const indented = (r: ScreenLine, spaces: number): ScreenLine => {
  const text = ' '.repeat(spaces) + r.text.trimStart()
  return { ...r, text, typed: text, end: text.length }
}

/** A note Codex wraps onto a second composer row at 120 columns (built, not
 *  recorded: every recorded draft is one row), over the recorded queue hint. */
const FIRST = 'Please check the second panel: the Save button label is cut off at narrow widths, and its icon sits too far left of'
const REST = 'it. Thanks'
const NOTE = `${FIRST} ${REST}`
const QUEUED = QUEUE['codex-macos-queue-hint']
const twoRowDraft = (under: ScreenLine[]): ScreenLine[] => [blank(), plain(`${P} ${FIRST}`), plain(`  ${REST}`), blank(), ...under]

describe("Codex's hint rows under the footer, as P19's second run recorded them (C3, #357)", () => {
  it('each recorded screen with one of the rows reads ready, the composer empty', () => {
    for (const [name, screen] of Object.entries(READY)) {
      expect(readCodexScreen(screen), name).toEqual({ screen: 'ready', text: '' })
      expect(readCodexScreen(screen, ['p19-probe']), name).toEqual({ screen: 'ready', text: '' })
      expect(codexComposerState(screen), name).toBe('ready')
    }
  })

  it('the queue hint reads busy, with the draft, and never ready', () => {
    for (const [name, screen] of Object.entries(QUEUE)) {
      expect(readCodexScreen(screen), name).toEqual({ screen: 'busy', text: 'p19 queued draft' })
      expect(readCodexScreen(screen, ['p19-probe']), name).toEqual({ screen: 'busy', text: 'p19 queued draft' })
      expect(codexComposerState(screen), name).toBe('busy')
    }
  })

  it('a turn running with one of the rows under the footer reads busy', () => {
    for (const [name, { screen }] of Object.entries(ACCEPTED)) {
      const busy = [...screen.slice(0, 1), plain('  Working (3s, esc to interrupt)'), ...screen.slice(1)]
      expect(readCodexScreen(busy).screen, name).toBe('busy')
    }
  })

  it('what the composer holds is read over the rows: nothing at the ready ones, the draft at the queue hint', () => {
    for (const [name, screen] of Object.entries(READY)) expect(codexComposerDraft(screen), name).toBe('')
    for (const [name, screen] of Object.entries(QUEUE)) expect(codexComposerDraft(screen), name).toBe('p19queueddraft')
  })

  it("the composer's height is read over the rows: one row", () => {
    for (const [name, screen] of Object.entries({ ...READY, ...QUEUE })) expect(codexComposerRows(screen), name).toBe(1)
  })

  it('a draft over the queue hint is never confirmed as typed (a turn runs)', () => {
    for (const [name, screen] of Object.entries(QUEUE)) expect(codexTextTyped(screen, 'p19 queued draft'), name).toBe(false)
  })

  it('a draft Codex wraps onto a second row is read over the queue hint, all of it, two rows; the screen still reads unrecognised', () => {
    const screen = twoRowDraft([footerRow(QUEUED), lastRow(QUEUED)])
    expect(codexComposerDraft(screen)).toBe(NOTE.replace(/\s+/g, ''))
    expect(codexComposerRows(screen)).toBe(2)
    expect(readCodexScreen(screen).screen).toBe('unrecognised')
    expect(codexTextTyped(screen, NOTE)).toBe(false)
    // Three rows too.
    const three = [blank(), plain(`${P} ${FIRST}`), plain(`  ${FIRST}`), plain(`  ${REST}`), blank(), footerRow(QUEUED), lastRow(QUEUED)]
    expect(codexComposerDraft(three)).toBe(`${FIRST}${FIRST}${REST}`.replace(/\s+/g, ''))
    expect(codexComposerRows(three)).toBe(3)
    expect(readCodexScreen(three).screen).toBe('unrecognised')
  })

  it('a two-row draft is not read over a wrapped footer, a row that was not recorded, the hint at another indent or two rows', () => {
    const wrappedFooter = WRAPPED['codex170-macos-queue-hint'].slice(3)
    for (const [what, under] of Object.entries({
      'a wrapped footer': wrappedFooter,
      'a row not recorded': [footerRow(QUEUED), plain('  tab to queue')],
      'the warning count': [footerRow(QUEUED), plain(`${' '.repeat(95)}${WARNING}`)],
      'the hint at 4': [footerRow(QUEUED), hint(4, 'tab to queue message')],
      'the hint at 0': [footerRow(QUEUED), hint(0, 'tab to queue message')],
      'the hint twice': [footerRow(QUEUED), lastRow(QUEUED), lastRow(QUEUED)],
    })) {
      const screen = twoRowDraft(under)
      expect(codexComposerDraft(screen), what).toBeNull()
      expect(codexComposerRows(screen), what).toBeNull()
      expect(readCodexScreen(screen).screen, what).toBe('unrecognised')
    }
  })

  it("the recorded screens whose footer wraps still read unrecognised, and what their composer holds is not read", () => {
    for (const [name, screen] of Object.entries(WRAPPED)) {
      expect(readCodexScreen(screen).screen, name).toBe('unrecognised')
      expect(codexComposerDraft(screen), name).toBeNull()
    }
  })

  it('the recorded screens with a warning count at the right of the row still read unrecognised, so nothing is typed there', () => {
    for (const [name, screen] of Object.entries(WARNING_SCREENS)) {
      expect(readCodexScreen(screen).screen, name).toBe('unrecognised')
      expect(readCodexScreen(screen, ['p19-probe']).screen, name).toBe('unrecognised')
      expect(codexComposerState(screen), name).toBe('not-ready')
    }
    // Why: once a text is typed at the idle composer, Codex keeps the count
    // alone under the footer (warning_notice_styles), which no confirm reader
    // takes, so the text would be typed and Enter never pressed.
    const typed = [blank(), blank(), plain(`${P} keep this draft`), blank(), footerRow(WARNING_SCREENS['codex-macos-warning-hint']), plain(`${' '.repeat(W - 1 - WARNING.length)}${WARNING}`)]
    expect(codexTextTyped(typed, 'keep this draft')).toBe(false)
    expect(readCodexScreen(typed).screen).toBe('unrecognised')
  })

  it('each row twice under the footer reads unrecognised', () => {
    for (const [name, { screen }] of Object.entries(ACCEPTED)) {
      expect(readCodexScreen([...screen, lastRow(screen)]).screen, name).toBe('unrecognised')
      expect(readCodexScreen([...screen, blank(), lastRow(screen)]).screen, name).toBe('unrecognised')
    }
  })

  it('each row is the recorded one', () => {
    for (const [name, { screen, text }] of Object.entries(ACCEPTED)) expect(lastRow(screen), name).toEqual(hint(2, text))
  })

  // The footer is read at any indent from 0 to 8 (footerRe), so each row is
  // matched at the footer row's own indent, not at a fixed two spaces.
  it("each row at another indent than the footer row's reads unrecognised; at the footer's own indent it is read", () => {
    for (const [name, { screen, text, reads }] of Object.entries(ACCEPTED)) {
      for (const spaces of [0, 1, 3, 4]) {
        expect(readCodexScreen([...composerPart(screen), footerRow(screen), hint(spaces, text)]).screen, `${name} at ${spaces}`).toBe('unrecognised')
      }
      expect(readCodexScreen([...composerPart(screen), indented(footerRow(screen), 4), hint(4, text)]).screen, `${name} at the footer's 4`).toBe(reads)
      expect(readCodexScreen([...composerPart(screen), indented(footerRow(screen), 4), hint(2, text)]).screen, `${name} at 2 under the footer's 4`).toBe('unrecognised')
    }
  })

  it('each row above the footer reads unrecognised, and alone it is no prompt', () => {
    for (const [name, { screen }] of Object.entries(ACCEPTED)) {
      expect(readCodexScreen([...composerPart(screen), lastRow(screen), footerRow(screen)]).screen, name).toBe('unrecognised')
      expect(readCodexScreen([...composerPart(screen), lastRow(screen)]).screen, name).toBe('no-prompt')
    }
  })

  it('each row under a wrapped footer reads unrecognised', () => {
    const wrapped = WRAPPED['codex170-windows-bundled-after-reply']
    const twoRows = wrapped.slice(3, 5)
    for (const [name, { screen }] of Object.entries(ACCEPTED)) {
      expect(readCodexScreen([...composerPart(screen), ...twoRows, lastRow(screen)]).screen, name).toBe('unrecognised')
    }
  })

  it('a row that was not recorded still reads unrecognised', () => {
    const base = composerPart(READY['codex170-linux-ready'])
    const footer = footerRow(READY['codex170-linux-ready'])
    for (const text of [
      '  f7 for shortcuts',
      '  ctrl+k for shortcuts',
      `  ${ARROW} for agents`,
      `  ${ARROW} for agents ${DOT} ? for shortcuts.`,
      `  ${ARROW} for agents ${DOT} f7 for shortcuts`,
      `  ${ARROW} for agents ? for shortcuts`,
      '  tab to queue message.',
      '  tab to queue',
      '  ? for shortcuts                                                                                   100% context left',
      `  f6 for shortcuts${' '.repeat(77)}${WARN} 1 warning ${DOT} f2 to view`,
      `  ${ARROW} for agents ${DOT} f6 for shortcuts${' '.repeat(62)}${WARN} 1 warning ${DOT} f2 to view`,
      `  tab to queue message${' '.repeat(73)}${WARN} 1 warning ${DOT} f2 to view`,
      `  ? for shortcuts${' '.repeat(36)}junk${' '.repeat(38)}${WARN} 1 warning ${DOT} f2 to view`,
      `  ? for shortcuts${' '.repeat(77)}${WARN} 2 warnings ${DOT} f2 to view`,
      `  ? for shortcuts${' '.repeat(78)}${WARN} 1 warning`,
      `${' '.repeat(95)}${WARN} 1 warning ${DOT} f2 to view`,
      '  Tip: Use /init to create an AGENTS.md with project-specific guidance.',
    ]) {
      expect(readCodexScreen([...base, footer, plain(text)]).screen, text).toBe('unrecognised')
    }
  })
})
