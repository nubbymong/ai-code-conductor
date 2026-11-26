/**
 * Reading Codex's TUI from its screen (P3.8 rounds 1 to 4; moved here in P3.10
 * so the main process can read it too). Pure: the rows of a terminal's live
 * screen in, what they show out. The renderer's composer typing
 * (src/renderer/lib/codexComposer.ts) and the Watchdog's send gate for a Codex
 * session (src/main/watchdog/codex-patterns.ts) both read the screen with
 * these, so the two never disagree about when Codex's composer is ready.
 *
 * Evidence (the P3.8 VM probe of the real 0.153.4 and 0.155.1 TUIs, and the
 * strings of their binaries), in short:
 *  - ready: the screen's last line is the footer "<model> <effort> . <folder>"
 *    and the line above it (blank lines aside) is the composer;
 *  - the composer's placeholder is one of two dim texts; anything else in it,
 *    dim or not, is content;
 *  - once a command is typed its popup replaces the footer.
 * P3.10: Codex's "Hooks need review" screens (its startup review of the
 * app's hooks, and the /hooks view it opens) are blocking screens too.
 * WP2 PR 4, P4.1: so are its MCP approval form and its sandbox set-up menu
 * (by title as well as footer); and main's submit primitive
 * (src/main/providers/codex/composer-submit.ts) reads a long paste's
 * placeholder and the composer's height from here.
 */

/** One row of a terminal's live screen. */
export interface ScreenLine {
  /** The row's text, trailing spaces trimmed. */
  text: string
  /** The same row with every dim cell (a placeholder) as a space, trimmed. */
  typed: string
  /** The same row with every cell that is NOT drawn inverse as a space,
   *  trimmed (a cursor block a TUI paints itself is inverse). Absent when the
   *  reader does not know which cells are. */
  inverse?: string
  /** The row's width in cells, and the cell just past its last non-blank one
   *  (P3.8 round 4: where a right-aligned segment ends). Absent when the
   *  reader does not know them. */
  width?: number
  end?: number
}

/** The subset of xterm's API a reader needs (typed loosely: the buffer's
 *  line and cell shapes, not the whole Terminal). The renderer's xterm and
 *  the main process's headless one both have it. */
export interface XtermLike {
  rows: number
  cols: number
  buffer: { active: {
    baseY: number
    getLine(y: number): { getCell(x: number): { getChars(): string; getWidth(): number; isDim(): number | boolean; isInverse?(): number | boolean } | undefined } | undefined
  } }
}

/** The live screen of an xterm terminal: the `rows` rows from the top of the
 *  active screen (below any scrollback), whichever buffer is active. */
export function readXtermScreen(term: XtermLike): ScreenLine[] {
  const buf = term.buffer.active
  const out: ScreenLine[] = []
  for (let y = buf.baseY; y < buf.baseY + term.rows; y++) {
    const line = buf.getLine(y)
    if (!line) { out.push({ text: '', typed: '', width: term.cols, end: 0 }); continue }
    let text = ''
    let typed = ''
    let inverse = ''
    let knowsInverse = false
    let end = 0
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x)
      if (!cell) break
      if (cell.getWidth() === 0) continue // the second half of a wide character
      const ch = cell.getChars() || ' '
      text += ch
      typed += cell.isDim() ? ' '.repeat(ch.length) : ch
      if (typeof cell.isInverse === 'function') {
        knowsInverse = true
        inverse += cell.isInverse() ? ch : ' '.repeat(ch.length)
      } else {
        inverse += ' '.repeat(ch.length)
      }
      if (ch.trim() !== '') end = x + Math.max(1, cell.getWidth())
    }
    out.push({
      text: text.replace(/\s+$/, ''),
      typed: typed.replace(/\s+$/, ''),
      ...(knowsInverse ? { inverse: inverse.replace(/\s+$/, '') } : {}),
      width: term.cols,
      end,
    })
  }
  return out
}

export type CodexComposerState = 'ready' | 'busy' | 'not-ready'
/** What the live screen shows, in more detail than the state (round 2, WW):
 *  'unrecognised' is a composer with a footer under it that is not the last
 *  row (a narrow window wraps it in a way not recorded, or a row is drawn
 *  under it), Codex's one row under the footer aside (HINT_ROWS, and C7's
 *  warning row), and the footer's second row where Codex wraps it as
 *  recorded (footerWrapped, aicc_planning#436). */
export type CodexScreenKind = 'ready' | 'busy' | 'blocked' | 'no-prompt' | 'unrecognised' | 'starting'

/** Codex's prompt glyphs: the composer's, and the one it draws at ultra. */
const GLYPHS = String.fromCharCode(0x203a) + String.fromCharCode(0xbb)
const MIDDLE_DOT = String.fromCharCode(0xb7)
/** The composer row: a prompt glyph, then a space or nothing. */
const COMPOSER_RE = new RegExp(`^[${GLYPHS}](?: |$)`)
const GLYPH_PREFIX_RE = new RegExp(`^[${GLYPHS}] ?`)
/** The efforts the footer names: Codex's levels, and "default" when the
 *  model's own applies (VM: gpt-5.2 and gpt-5.3-codex launched with none). */
const FOOTER_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'default']
/** A model as the footer can show it, when the session's are not known: an
 *  id, or a display name of two words ("GPT-6.1 Terra", Codex 0.172.0). */
const MODEL_WORD = '[A-Za-z0-9][A-Za-z0-9._:/-]*'
const ANY_MODEL = `${MODEL_WORD}(?: ${MODEL_WORD})?`
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
/** An escaped model id whose letters match in either case. */
const anyCase = (s: string): string => s.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)
/** A listed model id as the footer can show it: its letters in either case,
 *  and each hyphen a hyphen or a space. */
const listedModel = (m: string): string => anyCase(escapeRe(m).replace(/\\-/g, '[- ]'))
/** The footer (round 2, FT): "<model> <effort> . <folder>", the model one of
 *  `models` when they are given, its letters in either case (2.1.3-beta.17
 *  C8, aicc_planning#416): Codex 0.157.1 names a model its own catalogue
 *  knows by the catalogue's display name, so a session on gpt-5.5 shows
 *  "GPT-5.5 medium" (the test machine, on a stand-in model server that
 *  serves no model list), and one on a model it does not know shows the id
 *  as given ("p19-probe default", probe P19's recordings). A display name can
 *  also hold a space where the id has a hyphen: Codex 0.172.0 shows a session
 *  on gpt-6.1-terra as "GPT-6.1 Terra low" (the beta.17 release smoke), so a
 *  listed id's hyphen matches a hyphen or a space, and with no list the model
 *  may be two words. Codex's own hint lines ("enter select . esc back", "MCP
 *  servers . 2 enabled", "Git . main") name no level after a model, so they
 *  never match. */
function footerRe(models?: readonly string[] | null): RegExp {
  const model = models && models.length > 0 ? `(?:${models.map(listedModel).join('|')})` : ANY_MODEL
  return new RegExp(`^ {0,8}${model} (?:${FOOTER_EFFORTS.join('|')}) ${MIDDLE_DOT} \\S`)
}
/** The footer of any model: what the footer's second row is never
 *  (footerWrapped, aicc_planning#436). */
const ANY_FOOTER_RE = footerRe(null)
/** On screen means the composer is not the one taking keys: the trust
 *  prompt, Codex's pickers and notices, and (round 2, defence in depth; not
 *  reachable on the VM without a working model) its approval requests, as the
 *  binaries of 0.153.4 and 0.155.1 word them. */
const BLOCKING_RE = [
  /Do you trust the contents of this directory/i,
  /Press enter to continue/i,
  /Press enter to confirm or esc to go back/i,
  /Would you like to run the following command/i,
  /Would you like to send input to (?:the existing )?terminal/i,
  /Do you want to approve network access/i,
  /Would you like to grant these permissions/i,
  /Would you like to make the following edits/i,
  /needs your approval/i,
  // P3.10 (the VM probe of both versions): Codex's review of new or changed
  // hooks at start-up ("Hooks need review ... Trust all and continue"), and
  // the /hooks view its first option opens ("Press t to trust all; enter to
  // review hooks; esc to close"). Nothing is typed into either.
  /Hooks need review/i,
  /\bhooks? needs? review before\b/i,
  /Press t to trust/i,
  // WP2 PR 4, P4.1 (the PR 4 VM probes PB2 and PB4, both versions): Codex's
  // MCP approval form ('Allow the <server> MCP server to run tool "<name>"?'),
  // which takes a digit as its answer at once, and the title of its sandbox
  // set-up menu (its footer above is matched already; the title is defence in
  // depth for a pane that wraps or clips the footer).
  /\bAllow the .{1,80}? MCP server to run tool\b/i,
  /Set up the Codex agent sandbox/i,
]
/** A turn running (its status row). */
const BUSY_RE = /esc to interrupt/i
/** 2.1.3-beta.13 B2 (aicc_planning#370): a turn running, by the window title.
 *  Probe P19's second run (helper/fixtures/screens/, Codex 0.157.1 and
 *  0.170.0): on Windows (both ConPTYs) and Linux, each screen of a reply
 *  streaming, and of the queue hint under a draft typed then, ends with an
 *  OSC 0 title that starts with a braille spinner (U+2800 to U+28FF) and a
 *  space; each screen after the reply, and each ready one, ends without it.
 *  While a reply streams it is the only busy sign: Codex draws its "esc to
 *  interrupt" row once, after Enter, and not while the reply streams. On
 *  macOS no mid-reply or queue-hint recording ends with it (0.157.1 spun it
 *  for under 100 ms after Enter, 0.170.0 not at all), so there a reply still
 *  reads as before. Codex also spins it for a moment as it starts (1 to 27
 *  ms in the corpus, mostly before its footer is drawn): a caller that waits
 *  for the first ready screen waits through it
 *  (src/renderer/lib/codexComposer.ts). 0.170.0's title at rest is the
 *  thread's title, taken from the first prompt: a prompt that itself starts
 *  with a braille character and a space reads busy at rest, so the app types
 *  nothing into that session while that title stands (the safe side). */
export function codexTitleBusy(title: string | null | undefined): boolean {
  if (typeof title !== 'string' || title.length < 2) return false
  const first = title.charCodeAt(0)
  return first >= 0x2800 && first <= 0x28ff && title.charCodeAt(1) === 0x20
}
/** The screen shows a turn running: its status row, or the title (above). */
const turnShown = (lines: ScreenLine[], title?: string | null): boolean => codexTitleBusy(title) || lines.some((l) => BUSY_RE.test(l.text))
/** Codex still starting (round 3, V1): 0.153.4 boots its MCP servers after
 *  drawing its prompt, under a status row that reads like a turn ("Booting
 *  MCP server: conductor (0s . esc to interrupt)"); the binaries also say
 *  "Starting MCP servers". Not busy, and not the user's doing. */
const STARTING_RE = /\b(?:Booting MCP server|Starting MCP servers?)\b/i
/** The composer's placeholders (the binaries' strings), drawn dim. */
const PLACEHOLDERS = ['Ask Codex to do anything', 'Ask a follow-up question']
/** A row of the slash-command popup under a typed command. */
const POPUP_ROW_RE = /^ {1,8}\/[a-z][\w-]*(?: |$)/
/** 2.1.3-beta.10 C5 (aicc_planning #349): the hint Codex draws on the row
 *  under its footer while the composer is empty, at the footer's indent
 *  (Codex's TUI at rust-v0.157.1, bottom_pane/footer.rs, left_side_line). It
 *  is there when the footer has a row of its own, as 0.157.1's fullscreen
 *  transcript gives it by default (tui.fullscreen_transcript; off by default
 *  in 0.156.1). Only this exact row counts. */
const SHORTCUTS_HINT = '? for shortcuts'
/** 2.1.3-beta.12 C3 (aicc_planning #357): the other rows probe P19's second
 *  run recorded there, each as recorded (helper/fixtures/screens/, Codex
 *  0.157.1 and 0.170.0): 0.170.0's own ready row (laid out by
 *  chat_composer/passive_hints.rs at the rust-v0.170.0 tag; agents_navigation.rs
 *  says when the agents label shows), the shortcuts key rebound to F6 in both
 *  versions, and the queue hint. The warning count at the right of the row
 *  is read since 2.1.3-beta.17 C7 (WARNING_COUNT_RE, below). */
const AGENTS = `${String.fromCharCode(0x2190)} for agents ${MIDDLE_DOT} `
/** One row Codex draws under the footer, at the footer's indent. `busy`:
 *  Codex draws it only while a turn runs (its queue hint, under a draft typed
 *  then). */
interface HintRow { text: string; busy?: true }
const HINT_ROWS: readonly HintRow[] = [
  { text: SHORTCUTS_HINT },
  { text: 'f6 for shortcuts' },
  { text: `${AGENTS}${SHORTCUTS_HINT}` },
  { text: `${AGENTS}f6 for shortcuts` },
  { text: 'tab to queue message', busy: true },
]
/** 2.1.3-beta.17 C7 (aicc_planning #371): the warning count Codex draws at
 *  the right of the row under its footer, "<warning sign> N warning(s) .
 *  f2 to view", ending one cell from the row's right edge (both versions; a
 *  tool server that cannot start, --strict-config, or on Windows with
 *  0.161.0+ the app run as administrator; Codex's snapshot test
 *  warning_notice_styles, chat_composer/warning_notice_tests.rs at
 *  rust-v0.157.1 and rust-v0.170.0). Probe P19 recorded it twice:
 *  - at an empty composer, at the right of the hint row ("? for shortcuts"
 *    on 0.157.1, the agents form on 0.170.0), at rest and while a reply
 *    streams (P19's second run, helper/fixtures/screens/);
 *  - ALONE under the footer once a text is typed at an idle composer: a
 *    draft, a draft Codex wraps onto two rows, its paste placeholder, a
 *    draft typed after a reply (C7's recording hold, Codex 0.157.1 on both
 *    Windows ConPTYs, 3 runs each: codex-windows-*-warning-draft.json).
 *  A count of 1 says "warning", more say "warnings" (2 recorded after the
 *  first reply). Taken without a recording of the pair, each part being
 *  recorded: the count beside "f6 for shortcuts" (both forms), a count
 *  above 2, and Codex 0.170.0's count alone under a draft (its snapshot test
 *  says the same row). Not recorded, so still read as no row of Codex's: the
 *  count with any other key than f2, beside the queue hint (P19 drew the
 *  queue hint with no count), or alone under an empty composer. */
const WARNING_COUNT_RE = new RegExp(`^${String.fromCharCode(0x26a0)} ([1-9]\\d{0,3}) (warnings?) ${MIDDLE_DOT} f2 to view$`)
/** What one row under the footer is: one of HINT_ROWS (`busy` its own), or
 *  C7's warning row; `countAlone`: the warning count with nothing at its
 *  left. */
interface UnderFooterRow { busy: boolean; countAlone: boolean }
/** C7: whether `body` (the row less the footer's indent) is the warning row:
 *  the count at the right, ending one cell from the edge where the reader
 *  knows the row's width, with at its left nothing or one of the hint rows
 *  Codex draws at rest and at least one space. */
function warningRowOf(row: ScreenLine, body: string): UnderFooterRow | null {
  const at = body.lastIndexOf(String.fromCharCode(0x26a0))
  if (at < 0) return null
  const count = WARNING_COUNT_RE.exec(body.slice(at))
  if (!count || (count[1] === '1') !== (count[2] === 'warning')) return null
  if (row.width !== undefined && row.end !== undefined && row.end !== row.width - 1) return null
  const left = body.slice(0, at)
  if (left.trim() === '') return { busy: false, countAlone: true }
  const gap = / +$/.exec(left)
  if (!gap) return null
  const hint = left.slice(0, left.length - gap[0].length)
  return HINT_ROWS.some((h) => !h.busy && h.text === hint) ? { busy: false, countAlone: false } : null
}
/** Which row Codex draws under the footer `row` is, at the indent of the
 *  footer row above it: one of HINT_ROWS, or (C7) the warning row. */
function underFooterRowOf(row: ScreenLine, footerRow: ScreenLine): UnderFooterRow | null {
  const indent = /^ */.exec(footerRow.text)?.[0] ?? ''
  if (!row.text.startsWith(indent)) return null
  const body = row.text.slice(indent.length)
  const hint = HINT_ROWS.find((h) => body === h.text)
  if (hint) return { busy: hint.busy === true, countAlone: false }
  return warningRowOf(row, body)
}
/** #436: the footer's title after its folder, a second " . " and a word. */
const TITLE_AFTER_FOLDER_RE = new RegExp(` ${MIDDLE_DOT} \\S`)
/** 2.1.3-beta.19 section 4 (aicc_planning#436): Codex 0.170.0 and 0.172.0
 *  add the thread's title to the footer once a prompt is sent ("<model>
 *  <effort> . <folder> . <title>"), and where that does not fit across the
 *  pane Codex wraps it at a word onto more rows, each at the footer's indent
 *  (Codex's TUI at the rust-v0.170.0 and rust-v0.172.0 tags:
 *  bottom_pane/status_line.rs, wrap_rows, wraps the footer to the width of its
 *  area less the two cells footer.rs's inset_footer_hint_area takes at the
 *  left). Probe P19 recorded it after its short prompt, on two rows: Codex
 *  0.170.0 on macOS and both Windows ConPTYs (codex170-*-after-reply,
 *  -mid-reply and -queue-hint) and Codex 0.172.0 on both ConPTYs
 *  (codex172-*-wrapped-after-reply), in helper/fixtures/screens/. Only that
 *  shape is read, matched whole as the hint rows are: `first` is the footer
 *  with the title begun after its folder (a second " . " and a word), cut at
 *  the pane's edge (row two's first word, with the space the wrap took, would
 *  have passed the row's last cell: Codex's own rule, which every recording
 *  meets; the word is counted in code points, not cells, so a first word of
 *  wide characters counts short and that wrap can stay refused), and
 *  `second` is the rest of the title at the footer's own indent,
 *  and none of Codex's other rows (a footer of any model, a hint row, the
 *  warning row, a popup row). Neither row holds two spaces in a row past the
 *  indent (a row laid out in parts, not a title wrapped at a word). Not
 *  recorded, so still refused: a footer wrapped onto three rows or more, a
 *  wrap inside the folder or between the folder and the title, a row that
 *  holds two spaces in a row, and a row whose width the reader does not
 *  know. */
function footerWrapped(first: ScreenLine, second: ScreenLine, footer: RegExp): boolean {
  const start = footer.exec(first.text)
  if (!start || !TITLE_AFTER_FOLDER_RE.test(first.text.slice(start[0].length))) return false
  if (first.width === undefined || first.end === undefined) return false
  const indent = /^ */.exec(first.text)?.[0] ?? ''
  if (!second.text.startsWith(indent)) return false
  const rowOne = first.text.slice(indent.length)
  const rowTwo = second.text.slice(indent.length)
  if (rowTwo === '' || rowTwo.startsWith(' ') || rowOne.includes('  ') || rowTwo.includes('  ')) return false
  if (ANY_FOOTER_RE.test(second.text) || POPUP_ROW_RE.test(second.text) || underFooterRowOf(second, first) !== null) return false
  const word = rowTwo.split(' ')[0]
  return first.end + 1 + [...word].length > first.width
}
/** `rows` less the second row of Codex's footer wrapped onto two rows at its
 *  end (footerWrapped), so a reader takes the footer's first row as the
 *  footer; and whether it was. */
function lessWrap(rows: ScreenLine[], footer: RegExp): { rows: ScreenLine[]; wrapped: boolean } {
  const n = rows.length
  return n >= 2 && footerWrapped(rows[n - 2], rows[n - 1], footer) ? { rows: rows.slice(0, -1), wrapped: true } : { rows, wrapped: false }
}
/** The rows under the composer row `i` of `shown`, less one row Codex draws
 *  under its footer when it is the last row, at the indent of the row above
 *  it (that row's own reader checks it is the footer), whatever the
 *  composer's height; and which row it was. The draft and height readers so
 *  read a draft Codex wraps onto more rows over the queue hint, or (C7) over
 *  the warning count alone, too, and composer-submit can take it back. The
 *  count alone is taken only under a composer that holds something, as
 *  recorded. Given `footer` (#436), less the footer's second row too where
 *  Codex wraps it as recorded (lessWrap), and `wrapped` says so. The screen's
 *  state (layout()) reads ready or busy only when one row is left, the
 *  footer: the row under the footer of a one-row composer. */
function rowsUnder(shown: ScreenLine[], i: number, footer?: RegExp): { under: ScreenLine[]; hint: UnderFooterRow | null; wrapped: boolean } {
  const below = shown.slice(i + 1)
  let hint = below.length >= 2 ? underFooterRowOf(below[below.length - 1], below[below.length - 2]) : null
  if (hint?.countAlone && composerContent(shown[i]) === '') hint = null
  const rest = hint ? below.slice(0, -1) : below
  const { rows: under, wrapped } = footer ? lessWrap(rest, footer) : { rows: rest, wrapped: false }
  return { under, hint, wrapped }
}
/** C7: `below` (the rows under the composer row) less Codex's warning count
 *  alone as the last row, directly under a footer row (#436: or under the
 *  second row of a footer Codex wraps as recorded): the one row the readers
 *  that confirm a typed text take under the footer (Codex hides its hint rows
 *  once a text is typed, and keeps the count). */
function lessCountAlone(below: ScreenLine[], footer: RegExp): ScreenLine[] {
  if (below.length < 2) return below
  const above = below.slice(0, -1)
  if (!footer.test(above[above.length - 1].text) && !lessWrap(above, footer).wrapped) return below
  return underFooterRowOf(below[below.length - 1], above[above.length - 1])?.countAlone ? above : below
}
/** #436: the rows under the composer row `i` of `shown` as the readers that
 *  confirm a typed text take them: less Codex's warning count alone
 *  (lessCountAlone), then less the second row of a footer Codex wraps as
 *  recorded (lessWrap), so the footer is one row, the last. */
function rowsToConfirm(shown: ScreenLine[], i: number, footer: RegExp): ScreenLine[] {
  return lessWrap(lessCountAlone(shown.slice(i + 1), footer), footer).rows
}

/** 2.1.3-beta.17 C9 (aicc_planning#420): `lines` with Codex's warning count
 *  alone under its footer as a blank row, where the readers take it
 *  (rowsUnder: the last row, the count alone at the footer's indent, one cell
 *  from the right edge, under a composer that holds something); `lines`
 *  itself otherwise. Main's Codex image rule reads the composer past its
 *  image placeholder (./codex-image-screen.ts, codexScreenPastPlaceholder):
 *  with the placeholder cut the composer reads empty, and the count alone
 *  under an empty composer is not recorded, so the readers would refuse the
 *  screen Codex really shows (the placeholder, the count alone under it). */
export function codexScreenLessCountAlone(lines: ScreenLine[]): ScreenLine[] {
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  if (i < 0 || !rowsUnder(shown, i).hint?.countAlone) return lines
  const at = lines.lastIndexOf(shown[shown.length - 1])
  const row = lines[at]
  const out = lines.slice()
  out[at] = {
    text: '',
    typed: '',
    ...(typeof row.inverse === 'string' ? { inverse: '' } : {}),
    ...(row.width !== undefined ? { width: row.width } : {}),
    ...(row.end !== undefined ? { end: 0 } : {}),
  }
  return out
}

const nonBlank = (l: ScreenLine): boolean => l.text.trim() !== ''
const blocked = (lines: ScreenLine[]): boolean => lines.some((l) => BLOCKING_RE.some((re) => re.test(l.text)))

/** The index of the composer row: the last row with the prompt glyph. */
function composerIndex(lines: ScreenLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (COMPOSER_RE.test(lines[i].text)) return i
  return -1
}

/** A composer row's content: '' only for nothing or one of Codex's dim
 *  placeholders; anything else there, dim or not, is content (round 2, FT). */
function composerContent(row: ScreenLine): string {
  const all = row.text.replace(GLYPH_PREFIX_RE, '').trim()
  if (all === '') return ''
  const typed = row.typed.replace(GLYPH_PREFIX_RE, '').trim()
  if (typed === '' && PLACEHOLDERS.includes(all)) return ''
  return all
}

/** The screen's structure: what it shows, the composer's content, and the
 *  footer row under the composer when that is the last row (or has only one
 *  of Codex's rows under it, HINT_ROWS or C7's warning row; its queue hint
 *  reads busy). #436: a footer Codex wraps onto two rows as recorded
 *  (footerWrapped) reads as the footer too, and no footer row is handed out
 *  for it (null), so its Plan mode is not read from a row cut at the edge.
 *  `startup`
 *  (round 4, E3): whether the run is still starting, so that Codex's
 *  start-up row counts; it counts only in its own place, the status row
 *  directly above the composer. `title` (B2): the terminal's window title; a
 *  spinner there reads busy where the footer is under the composer, last or
 *  not (codexTitleBusy). */
function layout(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null, startup = true, title?: string | null): { screen: CodexScreenKind; text: string; footer: ScreenLine | null } {
  if (!lines || lines.length === 0) return { screen: 'no-prompt', text: '', footer: null }
  if (blocked(lines)) return { screen: 'blocked', text: '', footer: null }
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  const text = i < 0 ? '' : composerContent(shown[i])
  if (startup && i > 0 && STARTING_RE.test(shown[i - 1].text)) return { screen: 'starting', text, footer: null }
  if (i < 0) return { screen: 'no-prompt', text: '', footer: null }
  const footer = footerRe(models)
  const { under, hint, wrapped } = rowsUnder(shown, i, footer)
  if (under.length === 1 && footer.test(under[0].text)) {
    return { screen: hint?.busy || turnShown(shown, title) ? 'busy' : 'ready', text, footer: wrapped ? null : under[0] }
  }
  if (shown.slice(i + 1).some((l) => footer.test(l.text))) return { screen: codexTitleBusy(title) ? 'busy' : 'unrecognised', text, footer: null }
  return { screen: 'no-prompt', text, footer: null }
}

/** What the live screen shows, and the composer's content when there is one.
 *  `startup` false: the run has had its first turn (or a command sent), so a
 *  row that looks like Codex's start-up row reads as what it says. `title`
 *  (B2): the terminal's window title now; absent or null, the screen alone is
 *  read. */
export function readCodexScreen(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null, opts: { startup?: boolean; title?: string | null } = {}): { screen: CodexScreenKind; text: string } {
  const { screen, text } = layout(lines, models, opts.startup ?? true, opts.title)
  return { screen, text }
}

/** Whether Codex's composer is the one taking keys, from the live screen. */
export function codexComposerState(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null): CodexComposerState {
  const { screen } = readCodexScreen(lines, models)
  return screen === 'ready' ? 'ready' : screen === 'busy' ? 'busy' : 'not-ready'
}

/** What is in the composer ('' for nothing or Codex's placeholder). */
export function codexComposerText(lines: ScreenLine[] | null | undefined): string {
  if (!lines) return ''
  const i = composerIndex(lines)
  return i < 0 ? '' : composerContent(lines[i])
}

/** Whether the screen shows `command` typed at the composer with nothing in
 *  the way (round 2, G5): no blocking prompt, no turn running (by its row,
 *  or by `title`, B2), the composer holding exactly the command, and under it
 *  only its popup or the footer (C7: and Codex's warning count alone under
 *  the footer, as the last row; #436: the footer wrapped onto two rows as
 *  recorded, as the last rows, rowsToConfirm). */
export function codexCommandTyped(lines: ScreenLine[] | null | undefined, command: string, models?: readonly string[] | null, title?: string | null): boolean {
  if (!lines || lines.length === 0 || blocked(lines) || turnShown(lines, title)) return false
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  if (i < 0 || composerContent(shown[i]) !== command) return false
  const footer = footerRe(models)
  return rowsToConfirm(shown, i, footer).every((l) => POPUP_ROW_RE.test(l.text) || footer.test(l.text))
}

/** A row Codex wraps the composer's text onto: indented under the text. */
const WRAPPED_ROW_RE = /^ {2,}\S/

/** P3.15 round 1 (F8): whether the screen shows `text` typed at the composer,
 *  over the composer row and the rows Codex wraps it onto in a narrow pane
 *  (each indented under the text), with nothing in the way: no blocking
 *  prompt, no turn running (by its row, or by `title`, B2), and under it only
 *  those rows and then the footer (C7: and Codex's warning count alone under
 *  the footer, as the last row; #436: the footer wrapped onto two rows as
 *  recorded, rowsToConfirm).
 *  The rows are read together with their spaces dropped, because a wrap may
 *  fall at a space (which the wrap takes) or inside a word. */
export function codexTextTyped(lines: ScreenLine[] | null | undefined, text: string, models?: readonly string[] | null, title?: string | null): boolean {
  const want = text.replace(/\s+/g, '')
  if (want === '' || !lines || lines.length === 0 || blocked(lines) || turnShown(lines, title)) return false
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  if (i < 0) return false
  const footer = footerRe(models)
  const below = rowsToConfirm(shown, i, footer)
  if (below.length === 0 || !footer.test(below[below.length - 1].text)) return false
  const wrapped = below.slice(0, -1)
  if (!wrapped.every((l) => WRAPPED_ROW_RE.test(l.text))) return false
  return [composerContent(shown[i]), ...wrapped.map((l) => l.text)].join('').replace(/\s+/g, '') === want
}

/** 2.1.3-beta.10 section A2 (PR #746 review): what the composer holds now,
 *  read as codexTextTyped reads it (the composer row and the rows Codex wraps
 *  it onto, each indented under the text, together with every space dropped);
 *  '' for nothing or Codex's placeholder. Null when what it holds cannot be
 *  read: a prompt up, no composer, or anything but those rows between it and
 *  the footer (a popup, say; one of Codex's rows under the footer, as the
 *  last row, is read whatever the composer's height: HINT_ROWS, the queue
 *  hint too, and C7's warning row, the count alone under a draft; #436: and
 *  the footer wrapped onto two rows as recorded). */
export function codexComposerDraft(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null): string | null {
  if (!lines || lines.length === 0 || blocked(lines)) return null
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  if (i < 0) return null
  const footer = footerRe(models)
  const { under } = rowsUnder(shown, i, footer)
  if (under.length === 0 || !footer.test(under[under.length - 1].text)) return null
  const wrapped = under.slice(0, -1)
  if (!wrapped.every((l) => WRAPPED_ROW_RE.test(l.text))) return null
  return [composerContent(shown[i]), ...wrapped.map((l) => l.text)].join('').replace(/\s+/g, '')
}

/** The placeholder Codex draws in its composer for a long paste: the count is
 *  the paste's length in code points (PB3, PB9). */
const PASTED_CONTENT_RE = /^\[Pasted Content (\d{1,7}) chars\]$/

/** WP2 PR 4, P4.1 (PB9): whether the screen shows Codex's paste placeholder
 *  for exactly `codePoints` at the composer, with nothing in the way: no
 *  blocking prompt, no turn running (by its row, or by `title`, B2), the
 *  composer holding only the placeholder, and under it only the footer (C7:
 *  and Codex's warning count alone under it, as recorded; #436: the footer
 *  wrapped onto two rows as recorded, rowsToConfirm). Codex folds a text
 *  into it from 1,001 code points on, both supported versions, every width
 *  probed. */
export function codexPastedContentShown(lines: ScreenLine[] | null | undefined, codePoints: number, models?: readonly string[] | null, title?: string | null): boolean {
  if (!Number.isInteger(codePoints) || codePoints < 1) return false
  if (!lines || lines.length === 0 || blocked(lines) || turnShown(lines, title)) return false
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  if (i < 0) return false
  const m = PASTED_CONTENT_RE.exec(composerContent(shown[i]))
  if (!m || Number(m[1]) !== codePoints) return false
  const footer = footerRe(models)
  const below = rowsToConfirm(shown, i, footer)
  return below.length === 1 && footer.test(below[0].text)
}

/** WP2 PR 4, P4.1 (PB9): how many rows the composer takes on screen now, from
 *  the row with the prompt glyph down to the row above the footer (the rows
 *  Codex wraps a text onto included), or null when no composer stands on a
 *  footer. Codex's composer is at most the pane's rows minus 4 high, and a
 *  taller text scrolls inside it (its first rows hidden), so a composer this
 *  tall holds a text that cannot be confirmed on screen. 2.1.3-beta.12 C3:
 *  one of Codex's rows under the footer, as the last row, is not counted,
 *  whatever the composer's height (HINT_ROWS; since 2.1.3-beta.17 C7 the
 *  warning row too), nor (#436) the second row of a footer Codex wraps onto
 *  two rows as recorded. */
export function codexComposerRows(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null): number | null {
  if (!lines || lines.length === 0) return null
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  if (i < 0) return null
  const footer = footerRe(models)
  const { under } = rowsUnder(shown, i, footer)
  if (under.length === 0 || !footer.test(under[under.length - 1].text)) return null
  return under.length
}

/** Codex's Plan mode label, right-aligned in its footer after the folder. */
const PLAN_MODE_SEGMENT_RE = /^Plan mode(?: \(shift\+tab to cycle\))?$/
/** The cells Codex leaves after its footer's right segment (the raw bytes). */
const PLAN_MODE_RIGHT_MARGIN = 2
/** Whether Codex's footer shows its Plan mode (rounds 2 and 3; PM1, T19):
 *  read only from the footer row under the composer (the screen's own
 *  structure, the session's models when given), and only from its
 *  right-aligned segment after the folder, so neither a folder named "Plan
 *  mode" nor a footer-shaped line elsewhere reads as it. null when no footer
 *  shows there (a popup, a prompt or start-up: nothing to go by). */
export function codexPlanModeOnScreen(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null): boolean | null {
  const { screen, footer } = layout(lines, models)
  if ((screen !== 'ready' && screen !== 'busy') || footer === null) return null
  const right = / {3,}(\S(?:.*\S)?)\s*$/.exec(footer.text)
  if (!right || !PLAN_MODE_SEGMENT_RE.test(right[1])) return false
  // Round 4 (E4): Codex draws the segment right-aligned, ending two cells
  // from the right edge (the raw footer bytes: the segment, then two
  // spaces); a screen reader that knows the row's width holds it to that.
  if (footer.width !== undefined && footer.end !== undefined && footer.end !== footer.width - PLAN_MODE_RIGHT_MARGIN) return false
  return true
}

/**
 * WP2 PR 4, P4.3 (section 10 question 6, default A): the text Codex's prompt
 * keeps, and how many characters it would have dropped. Codex's composer
 * drops every character outside the Basic Multilingual Plane (emoji, some
 * rare CJK, mathematical letters) on both supported versions, written plainly
 * or as a bracketed paste (PB3, PB4); everything else arrives. So before a
 * question is typed into it they are removed here, and counted, so the app
 * can say so; a lone surrogate (not a character at all) goes too. Argv keeps
 * them (PB4), so the launch argument is never passed through this.
 */
export function codexPromptKeeps(text: string): { text: string; removed: number } {
  let kept = ''
  let removed = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) { removed++; i++; continue }
    }
    if (c >= 0xd800 && c <= 0xdfff) { removed++; continue }
    kept += text[i]
  }
  return { text: kept, removed }
}
