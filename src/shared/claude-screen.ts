/**
 * Reading Claude Code's TUI from its screen. Pure: the rows of a terminal's
 * live screen in, what they show out. The status strip's Compact, model and
 * effort controls type into Claude Code only when this reads its ready, empty
 * prompt (src/renderer/lib/claudePrompt.ts), the rule the strip keeps for the
 * other agent CLI it types into.
 *
 * Evidence (the strings of the Claude Code 2.1.294 to 2.1.296 builds, the
 * folder-trust screen of 2.1.280 recorded on a test VM, and the render shapes
 * the Watchdog's send gate is tested against), in short:
 *  - the prompt is a box drawn with only its top and bottom borders, two rows
 *    of U+2500, and between them the prompt row: the pointer (U+276F, or ">"
 *    where Claude Code takes the terminal not to support Unicode, as in a
 *    Windows console outside Windows Terminal), a no-break space (U+00A0),
 *    then what is typed;
 *  - the pointer is drawn dim while a turn runs (its colour follows Claude
 *    Code's loading state), and plain at the prompt that takes keys;
 *  - an empty prompt holds nothing after the pointer, or a dim placeholder (a
 *    hint, a suggested next prompt) whose first character carries the cursor
 *    block, drawn inverse rather than dim (a typed character before a dim
 *    completion, with no cursor block drawn, looks the same but for that
 *    inverse cell, so the placeholder is taken as empty only when the reader
 *    reports the cell inverse); with the terminal not focused, or Claude
 *    Code's native cursor on, no cursor block is drawn and the whole
 *    placeholder is dim, which reads empty too (2.1.296's placeholder
 *    renderer inverts the first character only when focused);
 *  - under the prompt box only its footer is drawn, two columns in (the mode,
 *    the shortcuts hint, the status line, notices, vim mode's indicator); a
 *    row nearer the edge under it is not the footer (an earlier frame's box
 *    left above a shell, a password prompt or a question), except tmux's own
 *    status bar on the screen's last row;
 *  - vim mode's indicator names INSERT or VISUAL mode, where keys are text or
 *    commands; it names no mode in NORMAL mode, which therefore cannot be
 *    told from the plain prompt (a build that names it is read as no prompt);
 *  - a question Claude Code asks (before a command runs or a file is written,
 *    the folder-trust screen) and its pickers take the prompt's place, so no
 *    prompt box is drawn, and name themselves in words and key hints ("Do you
 *    want to proceed?", "Yes, I trust this folder", "Enter to confirm", "Esc
 *    to cancel");
 *  - a running turn says "esc to interrupt" (a narrow pane can wrap or cut
 *    that row, which leaves the dim pointer to tell).
 * A screen this does not recognise reads as no prompt: nothing is typed.
 */

/** One row of a terminal's live screen, as the app's screen reader reports
 *  it: the text, the same text with every dim cell as a space, and (when the
 *  reader knows) the same text with every cell that is not inverse as a space
 *  (all with trailing spaces trimmed). */
export interface ScreenRow {
  text: string
  typed: string
  inverse?: string
}

/** What the live screen shows. 'ready': the prompt takes keys (empty or not:
 *  see `text`). 'busy': a turn is running. 'blocked': a question or a picker
 *  is up. 'scrolled-back': a view of the history (tmux's copy mode) rather
 *  than the live screen. 'no-prompt': anything else. */
export type ClaudeScreenKind = 'ready' | 'busy' | 'blocked' | 'scrolled-back' | 'no-prompt'

const POINTER = String.fromCharCode(0x276f)
const RULE = String.fromCharCode(0x2500)
const SIDE = String.fromCharCode(0x2502)
const NO_BREAK_SPACE = String.fromCharCode(0xa0)

/** The prompt row: the pointer at the row's start, then a space (U+00A0 as
 *  the build draws it, or a plain one) or nothing. */
const PROMPT_ROW_RE = new RegExp(`^ {0,2}[${POINTER}>](?:[ ${NO_BREAK_SPACE}]|$)`)
const PROMPT_PREFIX_RE = new RegExp(`^ {0,2}[${POINTER}>][ ${NO_BREAK_SPACE}]?`)
const POINTER_RE = new RegExp(`[${POINTER}>]`)
/** A border of the prompt box: a run of U+2500 and nothing else. */
const BORDER_ROW_RE = new RegExp(`^ {0,2}${RULE}{8,} *$`)
/** The most rows the prompt's text may wrap onto. */
const MAX_PROMPT_ROWS = 24
/** The most rows under the prompt box: its footer (the mode, the shortcuts
 *  hint, a status line of a few rows, notices). More is not the prompt. */
const MAX_FOOTER_ROWS = 12
/** A row of the footer: drawn two columns in. */
const FOOTER_ROW_RE = /^ {2}/
/** tmux's own status bar (on when a host's tmux settings turn it on; the app
 *  turns it off), as tmux draws it by default: "[session] 0:window" at the
 *  left and '"host" 12:01 11-Oct-26' at the right. Read only on the screen's
 *  last row, and only whole: a shell prompt that starts "[venv] 12:01" is not
 *  the bar. A bar drawn any other way (a host's own format, a pane too narrow
 *  for its right part) is not the footer either, so nothing is typed. */
const TMUX_STATUS_BAR_RE = /^\[[^\]]{1,40}\] \d+:\S.*"[^"]*" \d{2}:\d{2} \d{2}-[^\s"-]{2,8}-\d{2}$/
/** Vim mode's indicator for a mode in which keys are commands, not text. */
const VIM_COMMAND_MODE_RE = /(?:^|\s)-- (?:NORMAL|VISUAL(?: LINE| BLOCK)?|REPLACE) --(?:\s|$)/

/** Anywhere on screen, the prompt is not the one taking keys: the words and
 *  key hints only Claude Code's questions and pickers draw. Not "Esc to go
 *  back": Claude Code's own error advice in the conversation says "double
 *  press esc to go back" while its prompt takes keys (and a narrow pane can
 *  wrap the row between "press" and "esc"), and the one key hint with those
 *  words ("Press Esc to go back") is on a screen with no prompt box. */
const BLOCKING_WORDS_RE: RegExp[] = [
  /\bIs this a project you created or one you trust\b/,
  /\bYes, I trust this folder\b/,
  /\bNo, continue without these permissions\b/,
  /\bDo you trust the files in this folder\b/,
  /\btell Claude what to do differently\b/,
  /\bEnter to (?:confirm|select|approve|continue|apply|submit)\b/i,
  /\bEsc to (?:cancel|exit)\b/i,
]
/** Rows of a question or a picker that the conversation above the prompt can
 *  also hold (an answer's paragraph asking "Do you want to ...?", the user's
 *  own message): they block under the prompt box. A question that takes the
 *  prompt's place leaves no prompt box, which reads as no prompt. The space
 *  after a picker's pointer may be a no-break space, as on the prompt row. */
const BLOCKING_ROW_RE: RegExp[] = [
  // "Do you want to proceed?", "Do you want to create notes.txt?",
  // "Do you want to make this edit to x?", "Do you want to allow ...?"
  new RegExp(`^[ ${SIDE}]*Do you want to\\b`),
  // A numbered picker's focused row ("> 1. Yes").
  new RegExp(`^[ ${SIDE}]*[${POINTER}>][ ${NO_BREAK_SPACE}]?\\d{1,2}\\. \\S`),
  // Any picker's focused row, inside side borders or not.
  new RegExp(`^[ ${SIDE}]*[${POINTER}>][ ${NO_BREAK_SPACE}]\\S`),
]
/** A turn running, anywhere on screen: its status row's hint. */
const BUSY_RE = /\besc to interrupt\b/i
/** A turn running, read only next to the prompt box (the rows just above it
 *  and its footer): its retry status, and a wait for background agents. The
 *  same words in a command's output further up are not a turn running. */
const BUSY_NEAR_RE: RegExp[] = [
  /\battempt \d+\/\d+/i,
  /\bwaiting for \d+ background agents? to finish\b/i,
]
/** How many rows above the prompt box BUSY_NEAR_RE reads: a status row, a
 *  second row it wraps onto, and the blank row under it. */
const BUSY_ROWS_ABOVE = 3
/** tmux's copy mode draws its position, "[line/history]", at the right of
 *  the pane's top row (and, after a search, the result count): the screen's
 *  first row, or its second under a tmux status bar drawn at the top. */
const COPY_MODE_POSITION_RE = /\[\d+\/\d+\](?: \([^)]*\))?$/

const nonBlank = (l: ScreenRow): boolean => l.text.trim() !== ''

/** The prompt box nearest the bottom: the rows of its top and bottom borders,
 *  with the prompt row directly under the top one. Null when there is none,
 *  or when the lowest prompt row has no bottom border in reach. */
function promptBox(lines: readonly ScreenRow[]): { top: number; bottom: number } | null {
  for (let i = lines.length - 1; i > 0; i--) {
    if (!PROMPT_ROW_RE.test(lines[i].text) || !BORDER_ROW_RE.test(lines[i - 1].text)) continue
    for (let j = i + 1; j < lines.length && j <= i + MAX_PROMPT_ROWS; j++) {
      if (BORDER_ROW_RE.test(lines[j].text)) return { top: i - 1, bottom: j }
    }
    return null
  }
  return null
}

/** What the prompt holds: '' for nothing, or for a dim placeholder (whose
 *  first character may carry the cursor block, the one cell of it not dim);
 *  anything else, the user's own text. */
function promptText(rows: readonly ScreenRow[]): string {
  const [first, ...rest] = rows
  const lead = PROMPT_PREFIX_RE.exec(first.text)?.[0].length ?? 0
  const shown = first.text.slice(lead)
  const all = [shown, ...rest.map((r) => r.text)].map((s) => s.trim()).filter((s) => s !== '').join(' ')
  const inkFirst = (first.typed ?? '').slice(lead)
  if (rest.some((r) => (r.typed ?? '').trim() !== '')) return all
  if (inkFirst.trim() === '') return ''
  // `typed` is `text` with its dim cells blanked, cell for cell, so when the
  // only ink is at the first shown character, that character is the cursor
  // block on a dim placeholder. Not when a space follows it: that is a typed
  // character, then the cursor block (an inverse space), then a completion.
  // And only when the reader reports that character's cell inverse: a typed
  // character right before a dim completion, with no cursor block drawn (a
  // terminal not focused), has the same cells but for that one.
  const at = shown.length - shown.trimStart().length
  const cursorAt = lead + at
  const cursorDrawn = typeof first.inverse === 'string'
    && first.inverse.charAt(cursorAt) !== ''
    && first.inverse.charAt(cursorAt) === first.text.charAt(cursorAt)
  const cursorOnly = shown.trim().length > 1
    && shown.charAt(at + 1).trim() !== ''
    && inkFirst.slice(0, at).trim() === ''
    && inkFirst.slice(at + 1).trim() === ''
    && cursorDrawn
  return cursorOnly ? '' : all
}

/** Whether every row under the prompt box is its footer: drawn two columns
 *  in, or tmux's status bar on the screen's last row. */
function onlyFooterBelow(lines: readonly ScreenRow[], bottom: number): boolean {
  for (let i = bottom + 1; i < lines.length; i++) {
    const text = lines[i].text
    if (text.trim() === '' || FOOTER_ROW_RE.test(text)) continue
    if (i === lines.length - 1 && TMUX_STATUS_BAR_RE.test(text)) continue
    return false
  }
  return true
}

/** Whether the prompt row's pointer is drawn dim (no ink at its cell): a
 *  turn is running. */
function pointerDim(row: ScreenRow): boolean {
  const at = row.text.search(POINTER_RE)
  return at < 0 || (row.typed ?? '').charAt(at).trim() === ''
}

/** What Claude Code's live screen shows, and what its prompt holds when the
 *  prompt is up ('' for empty). */
export function readClaudeScreen(lines: readonly ScreenRow[] | null | undefined): { screen: ClaudeScreenKind; text: string } {
  if (!lines || lines.length === 0) return { screen: 'no-prompt', text: '' }
  if (lines.slice(0, 2).some((l) => COPY_MODE_POSITION_RE.test(l.text))) return { screen: 'scrolled-back', text: '' }
  if (lines.some((l) => BLOCKING_WORDS_RE.some((re) => re.test(l.text)))) return { screen: 'blocked', text: '' }
  const box = promptBox(lines)
  if (!box) return { screen: 'no-prompt', text: '' }
  const below = lines.slice(box.bottom + 1).filter(nonBlank)
  if (below.some((l) => BLOCKING_ROW_RE.some((re) => re.test(l.text)))) return { screen: 'blocked', text: '' }
  if (below.length > MAX_FOOTER_ROWS) return { screen: 'no-prompt', text: '' }
  if (!onlyFooterBelow(lines, box.bottom)) return { screen: 'no-prompt', text: '' }
  if (below.some((l) => VIM_COMMAND_MODE_RE.test(l.text))) return { screen: 'no-prompt', text: '' }
  const text = promptText(lines.slice(box.top + 1, box.bottom))
  if (pointerDim(lines[box.top + 1])) return { screen: 'busy', text }
  if (lines.some((l) => BUSY_RE.test(l.text))) return { screen: 'busy', text }
  const near = [...lines.slice(Math.max(0, box.top - BUSY_ROWS_ABOVE), box.top), ...below]
  if (near.some((l) => BUSY_NEAR_RE.some((re) => re.test(l.text)))) return { screen: 'busy', text }
  return { screen: 'ready', text }
}
