// Screens of Claude Code's TUI, as the app's screen reader reports them: each
// row is { text, typed }, `typed` being the text with every dim cell blanked,
// and, where a fixture needs it, `inverse`: the text with every cell that is
// not drawn inverse blanked (the reader reports it for a real terminal).
// Built from the strings of the Claude Code 2.1.294 to 2.1.296 builds (the
// prompt box with only its top and bottom borders, the select pointer and its
// fallback, the question and key-hint wording), the folder-trust screen of
// 2.1.280 as a test VM recorded it, and the render shapes the Watchdog's send
// gate is tested against (tests/unit/main/watchdog/patterns.test.ts). Paths
// are made up. Non-ASCII glyphs are written as escapes. The prompt row is the
// pointer, a no-break space (as those builds draw it), then the text; the
// pointer is dim while a turn runs.
//
// Still to be confirmed against a live, signed-in Claude Code (VM): the exact
// rows of a tool question, a file question and an edit question, the
// placeholder under the cursor after a turn, the busy row's wording, that
// the pointer is plain at the ready prompt in every idle state, which space
// follows a picker's pointer, and how a completion is drawn after one typed
// character (with the cursor block, and with the terminal not focused).

export interface Row { text: string; typed: string; inverse?: string }

const POINTER = '\u276f'
/** What the build draws between the prompt's pointer and its text. */
const NB = '\u00a0'
const H = '\u2500'
const DOT = '\u00b7'
const BULLET = '\u25cf'
const MODE = '\u23f5\u23f5'
const SPIN = '\u273b'
const ELLIPSIS = '\u2026'
const DASH = '\u254c'
const CHECK = '\u2714'
const ELBOW = '\u23bf'
const SIDE = '\u2502'

/** A row with no dim cells. */
export const plain = (text: string): Row => ({ text, typed: text })
/** A row drawn all dim. */
export const dim = (text: string): Row => ({ text, typed: '' })
/** A row whose cells from `from` on are dim. */
export const dimFrom = (text: string, from: number): Row => ({ text, typed: text.slice(0, from).replace(/\s+$/, '') })
const blank = (n: number): Row[] => Array.from({ length: n }, () => plain(''))
/** The same row with the cell at `at` drawn inverse (the cursor block) and no
 *  other cell inverse. */
const cursorAt = (row: Row, at: number): Row => ({ ...row, inverse: ' '.repeat(at) + row.text.charAt(at) })
/** The same row with no cell drawn inverse. */
const noInverse = (row: Row): Row => ({ ...row, inverse: '' })

const rule = (width = 100): Row => plain(H.repeat(width))
const STATUS = plain('  Opus 4.8 | demo@main | 5h 12% | v2.1.296')
const MODE_ROW = plain(`  ${MODE} accept edits on (shift+tab to cycle) ${DOT} ? for shortcuts`)
const SHORTCUTS = plain('  ? for shortcuts')

/** What an earlier turn left on screen: the user's message (the pointer and
 *  its text, with no borders round it) and Claude's answer. */
const HISTORY: Row[] = [
  plain(`${POINTER} add a hello script`),
  plain(''),
  plain(`${BULLET} Write(hello.sh)`),
  plain('  Wrote 2 lines to hello.sh'),
  plain(''),
  plain(`${BULLET} Done. hello.sh prints "hello".`),
  plain(''),
]

/** The welcome box of a new session (rounded, with side borders). */
const WELCOME: Row[] = [
  plain('\u256d' + H.repeat(40) + '\u256e'),
  plain('\u2502 ' + '\u273b' + ' Welcome to Claude Code!               \u2502'),
  plain('\u2502                                        \u2502'),
  plain('\u2502   cwd: C:\\Users\\alex\\projects\\demo     \u2502'),
  plain('\u2570' + H.repeat(40) + '\u256f'),
  plain(''),
]

/** The ready, empty prompt after a turn. */
export const READY: Row[] = [...HISTORY, rule(), plain(POINTER), rule(), STATUS, MODE_ROW, ...blank(6)]

/** The ready, empty prompt of a new session, under the welcome box. */
export const READY_NEW: Row[] = [...WELCOME, rule(), plain(POINTER), rule(), SHORTCUTS, ...blank(12)]

/** The same, where Claude Code takes the terminal not to support Unicode and
 *  draws its pointer as ">" (a Windows console outside Windows Terminal). */
export const READY_ASCII: Row[] = [...WELCOME, rule(), plain('>'), rule(), SHORTCUTS, ...blank(12)]

/** The ready, empty prompt under a conversation that holds rows a question
 *  or a picker would draw: the user's own numbered message, and an answer
 *  whose second paragraph asks "Do you want to ...?". */
export const READY_UNDER_QUESTION_PROSE: Row[] = [
  plain(`${POINTER} 1. fix the parser`),
  plain('  2. then run the suite'),
  plain(''),
  plain(`${BULLET} Fixed the parser; the suite passes.`),
  plain(''),
  plain('  Do you want to run the slow tests as well?'),
  plain(''),
  rule(), plain(POINTER), rule(), STATUS, MODE_ROW,
]

/** The ready prompt holding a suggested next prompt: the cursor block sits on
 *  its first character (drawn inverse, not dim) and the rest is dim. Empty. */
export const READY_SUGGESTION: Row[] = [
  ...HISTORY, rule(), cursorAt(dimFrom(`${POINTER}${NB}run the tests again`, 3), 2), rule(), STATUS, MODE_ROW,
]

/** The same with a long suggestion wrapped onto a second, all-dim row. */
export const READY_SUGGESTION_WRAPPED: Row[] = [
  ...HISTORY, rule(40), cursorAt(dimFrom(`${POINTER}${NB}run the full test suite and then fix`, 3), 2), dim('  any failing tests'), rule(40), SHORTCUTS,
]

/** The suggested next prompt with the terminal not focused (the user on the
 *  canvas page), or with Claude Code's native cursor on: no cursor block, so
 *  the whole suggestion is dim and no cell is inverse (2.1.296's placeholder
 *  renderer inverts the first character only when focused). Empty. */
export const READY_SUGGESTION_UNFOCUSED: Row[] = [
  ...HISTORY, rule(), noInverse(dimFrom(`${POINTER}${NB}run the tests again`, 2)), rule(), STATUS, MODE_ROW,
]

/** One character typed by the user, then a dim completion right after it,
 *  with no cursor block drawn (a terminal that is not focused): cell for cell
 *  the suggestion above but for the cursor's inverse cell. Not empty. */
export const ONE_CHAR_BEFORE_GHOST_NO_CURSOR: Row[] = [
  ...HISTORY, rule(), noInverse(dimFrom(`${POINTER}${NB}run the tests`, 3)), rule(), STATUS, MODE_ROW,
]

/** The suggestion's shape from a reader that does not report which cells are
 *  inverse: the cursor block cannot be told from a typed character. */
export const SUGGESTION_SHAPE_NO_ATTRIBUTES: Row[] = [
  ...HISTORY, rule(), dimFrom(`${POINTER}${NB}run the tests again`, 3), rule(), STATUS, MODE_ROW,
]

/** The ready, empty prompt in vim mode's insert mode: its indicator under the
 *  prompt (keys typed there are text, as at the plain prompt). */
export const READY_VIM_INSERT: Row[] = [...HISTORY, rule(), plain(POINTER), rule(), STATUS, plain('  -- INSERT --'), ...blank(4)]

/** Vim mode's normal and visual modes, where a key is a command, not text:
 *  their indicator under the prompt. */
export const VIM_NORMAL: Row[] = [...HISTORY, rule(), plain(POINTER), rule(), STATUS, plain('  -- NORMAL --'), ...blank(4)]
export const VIM_VISUAL: Row[] = [...HISTORY, rule(), plain(POINTER), rule(), STATUS, plain('  -- VISUAL --'), ...blank(4)]

/** The ready, empty prompt in tmux with tmux's status bar on (a remote host's
 *  own tmux setting): the bar on the screen's last row. */
export const READY_UNDER_TMUX_STATUS_BAR: Row[] = [
  ...HISTORY, rule(), plain(POINTER), rule(), STATUS, MODE_ROW, ...blank(3),
  plain('[demo] 0:claude*' + ' '.repeat(60) + '"build-box" 12:01 11-Oct-26'),
]

/** The ready, empty prompt over a tall footer: a status line of four rows,
 *  the mode row and a notice. */
export const READY_TALL_FOOTER: Row[] = [
  ...HISTORY, rule(), plain(POINTER), rule(),
  plain('  Opus 4.8 | demo@main'),
  plain('  ctx 41% | 5h 12% | 7d 3%'),
  plain('  $0.42 | 18m'),
  plain('  v2.1.296'),
  MODE_ROW,
  dim('  9% until auto-compact'),
]

/** The ready, empty prompt under Claude Code's own error after a request
 *  grew too large, which tells the user to run /compact or to double press
 *  esc to go back (2.1.296 wording). */
export const READY_UNDER_ERROR_ADVICE: Row[] = [
  plain(`${POINTER} summarise these screenshots`),
  plain(''),
  plain(`  ${ELBOW}  Accumulated images and attachments in the conversation pushed the request over the limit. Run /compact,`),
  plain('     or double press esc to go back and remove attachments.'),
  plain(''),
  rule(), plain(POINTER), rule(), STATUS, MODE_ROW,
]

/** The same kind of advice in a narrow pane, wrapped between "Double press"
 *  and "esc to go back" (2.1.296 wording for content too large to send). */
export const READY_UNDER_ERROR_ADVICE_NARROW: Row[] = [
  plain(`  ${ELBOW}  Double press`),
  plain('     esc to go back past the'),
  plain('     large content, or /clear'),
  plain('     to start a new'),
  plain('     conversation.'),
  plain(''),
  rule(30), plain(POINTER), rule(30), SHORTCUTS,
]

/** The ready, empty prompt when a command's output, a few rows up, holds a
 *  retry count. */
export const READY_UNDER_RETRY_OUTPUT: Row[] = [
  plain(`${POINTER} fetch the release notes`),
  plain(''),
  plain(`${BULLET} Bash(./fetch-notes.sh)`),
  plain(`  ${ELBOW}  Retrying download, attempt 1/3`),
  plain('     Saved notes.md'),
  plain(''),
  plain(`${BULLET} The notes are in notes.md. The first download failed and the script tried again.`),
  plain(''),
  rule(), plain(POINTER), rule(), STATUS, MODE_ROW,
]

/** The user's own text at the prompt. */
export const TYPED: Row[] = [...HISTORY, rule(), plain(`${POINTER}${NB}fix the failing test`), rule(), STATUS, MODE_ROW]

/** One character typed by the user (the cursor after it), with a plain space
 *  after the pointer: the reader takes either space. */
export const TYPED_ONE: Row[] = [...HISTORY, rule(), plain(`${POINTER} x`), rule(), STATUS, MODE_ROW]

/** One character typed by the user, the cursor block after it (an inverse
 *  space, not dim), then a dim completion of what was typed. Not empty. */
export const TYPED_ONE_BEFORE_GHOST: Row[] = [
  ...HISTORY, rule(), { text: `${POINTER}${NB}r un the tests`, typed: `${POINTER}${NB}r` }, rule(), STATUS, MODE_ROW,
]

/** The user's text wrapped onto a second row in a narrow pane. */
export const TYPED_WRAPPED: Row[] = [
  ...HISTORY, rule(40), plain(`${POINTER}${NB}fix the failing test in the parser`), plain('  and then run the suite'), rule(40), SHORTCUTS,
]

/** The user's text starting on the prompt's second row (a new line typed
 *  first): the first row holds only the pointer. */
export const TYPED_FROM_SECOND_ROW: Row[] = [
  ...HISTORY, rule(), plain(POINTER), plain('  then fix the parser'), rule(), STATUS, MODE_ROW,
]

/** A turn running: the busy row above the prompt, the pointer drawn dim. */
export const BUSY: Row[] = [
  ...HISTORY,
  plain(`${SPIN} Cogitating${ELLIPSIS} (12s ${DOT} esc to interrupt)`),
  plain(''),
  rule(), dim(POINTER), rule(), STATUS, MODE_ROW,
]

/** A turn running in a narrow pane: its busy row wraps, so no one row says
 *  "esc to interrupt". Only the dim pointer tells. */
export const BUSY_NARROW: Row[] = [
  plain(`${SPIN} Cogitating${ELLIPSIS} (12s ${DOT} esc to`),
  plain('interrupt)'),
  plain(''),
  rule(30), dim(POINTER), rule(30), SHORTCUTS,
]

/** A turn waiting to retry a request (its status row, as 2.1.296 words it). */
export const BUSY_RETRYING: Row[] = [
  ...HISTORY,
  plain(`${SPIN} Cogitating${ELLIPSIS} ${DOT} next try in 8s ${DOT} attempt 2 ${DOT} esc to interrupt`),
  rule(), dim(POINTER), rule(), STATUS,
]

/** A turn's busy row with the pointer drawn plain (it is dim on a live
 *  screen), so that only the interrupt hint tells. */
export const BUSY_HINT_ONLY: Row[] = [
  ...HISTORY,
  plain(`${SPIN} Cogitating${ELLIPSIS} (12s ${DOT} esc to interrupt)`),
  plain(''),
  rule(), plain(POINTER), rule(), STATUS, MODE_ROW,
]

/** The error row of Claude Code's own retry, as the Watchdog's tests record
 *  it, with no interrupt hint. The pointer is drawn plain here (it is dim on
 *  a live screen) so that only the retry words tell. */
export const BUSY_RETRY_ROW: Row[] = [
  ...HISTORY,
  plain(`  API Error: 529 Overloaded ${DOT} Retrying in 5s ${DOT} attempt 3/10`),
  rule(), plain(POINTER), rule(), STATUS,
]

/** Waiting for background agents, as the Watchdog's patterns word it. The
 *  pointer is drawn plain here so that only those words tell. */
export const BUSY_BACKGROUND_AGENTS: Row[] = [
  ...HISTORY,
  plain(`${SPIN} Waiting for 2 background agents to finish`),
  rule(), plain(POINTER), rule(), STATUS,
]

/** Claude Code asking before it runs a shell command. */
export const TOOL_QUESTION: Row[] = [
  ...HISTORY,
  rule(),
  plain(' Bash command'),
  plain(''),
  plain('   npm test'),
  plain('   Run the test suite'),
  plain(''),
  plain(' Do you want to proceed?'),
  plain(` ${POINTER} 1. Yes`),
  dim("   2. Yes, and don't ask again for npm test commands in C:\\Users\\alex\\projects\\demo"),
  dim('   3. No, and tell Claude what to do differently (esc)'),
  plain(''),
]

/** The same question in a pane narrow enough to wrap its telling words, with
 *  no key hints: only the missing prompt box tells. */
export const TOOL_QUESTION_NARROW: Row[] = [
  rule(30),
  plain(' Bash command'),
  plain('   npm test'),
  plain(' Do you want to'),
  plain(' proceed?'),
  plain(` ${POINTER} 1. Yes`),
  dim("   2. Yes, and don't ask"),
  dim('   again for npm test'),
  dim('   3. No, and tell Claude'),
  dim('   what to do'),
  dim('   differently (esc)'),
]

/** Claude Code asking before it creates a file. */
export const FILE_QUESTION: Row[] = [
  ...HISTORY,
  rule(),
  plain(' Create file'),
  plain(' notes.txt'),
  plain(' ' + DASH.repeat(60)),
  plain('  1 hello'),
  plain(' ' + DASH.repeat(60)),
  plain(' Do you want to create notes.txt?'),
  plain(` ${POINTER} 1. Yes`),
  dim('   2. Yes, allow all edits during this session (shift+tab)'),
  dim('   3. No, and tell Claude what to do differently (esc)'),
]

/** Claude Code asking before it edits an existing file (2.1.296: title
 *  "Edit file", the question "Do you want to make this edit to <file>?"). */
export const EDIT_QUESTION: Row[] = [
  ...HISTORY,
  rule(),
  plain(' Edit file'),
  plain(' hello.sh'),
  plain(' ' + DASH.repeat(60)),
  plain('  1  #!/bin/sh'),
  plain('  2 -echo "hello"'),
  plain('  2 +echo "hello, world"'),
  plain(' ' + DASH.repeat(60)),
  plain(' Do you want to make this edit to hello.sh?'),
  plain(` ${POINTER} 1. Yes`),
  dim('   2. Yes, allow all edits during this session (shift+tab)'),
  dim('   3. No, and tell Claude what to do differently (esc)'),
]

/** The folder-trust screen at the start of a session in a new folder
 *  (2.1.280 on the VM: pointer drawn as ">", "No, exit" first). */
export const TRUST: Row[] = [
  rule(),
  plain(' Accessing workspace:'),
  plain(''),
  plain(' C:\\Users\\alex\\projects\\demo'),
  plain(''),
  plain(' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or'),
  plain(" work from your team). If not, take a moment to review what's in this folder first."),
  plain(''),
  plain(" Claude Code'll be able to read, edit, and execute files here."),
  plain(''),
  plain(' Security guide'),
  plain(''),
  plain(' > No, exit'),
  dim('   Yes, I trust this folder'),
  plain(''),
  plain(` Enter to confirm ${DOT} Esc to cancel`),
  ...blank(6),
]

/** The folder-trust screen in a narrow pane: every phrase that names it is
 *  wrapped, so only the missing prompt box tells. */
export const TRUST_NARROW: Row[] = [
  rule(24),
  plain(' Accessing workspace:'),
  plain(' C:\\Users\\alex\\projects'),
  plain(' \\demo'),
  plain(' Quick safety check: Is'),
  plain(' this a project you'),
  plain(' created or one you'),
  plain(' trust?'),
  plain(' > No, exit'),
  dim('   Yes, I trust this'),
  dim('   folder'),
  plain(' Enter to'),
  plain(` confirm ${DOT} Esc to`),
  plain(' cancel'),
]

/** The model picker the user opened with /model. */
export const MODEL_PICKER: Row[] = [
  ...HISTORY,
  rule(),
  plain(' Select model'),
  plain(' Switch between Claude models. Applies to this session and future Claude Code sessions.'),
  plain(''),
  plain(` ${POINTER} 1. Default (recommended)  ${CHECK}  Opus 4.8`),
  dim('   2. Sonnet'),
  dim('   3. Haiku'),
  plain(''),
  plain(` Enter to confirm ${DOT} Esc to exit`),
]

/** An unnumbered picker (its rows have no index and no key hint) drawn under
 *  an earlier frame's prompt box. */
export const PICKER_UNDER_OLD_PROMPT: Row[] = [
  ...HISTORY,
  rule(), plain(POINTER), rule(),
  plain(' Review the proposed setup?'),
  plain(` ${POINTER} Looks good, save it`),
  dim('  Let me adjust it first'),
]

/** The same with a no-break space after the picker's pointer, as the prompt
 *  row of these builds has it. */
export const PICKER_UNDER_OLD_PROMPT_NB: Row[] = [
  ...HISTORY,
  rule(), plain(POINTER), rule(),
  plain(' Review the proposed setup?'),
  plain(`${POINTER}${NB}Looks good, save it`),
  dim('  Let me adjust it first'),
]

/** A numbered picker in a box with side borders (as older builds drew their
 *  questions) under an earlier frame's prompt box, a no-break space after its
 *  pointer, and no key hints. */
export const NUMBERED_PICKER_IN_SIDES_UNDER_OLD_PROMPT_NB: Row[] = [
  ...HISTORY,
  rule(), plain(POINTER), rule(),
  plain('╭' + H.repeat(40) + '╮'),
  plain(`${SIDE} Select model${' '.repeat(27)}${SIDE}`),
  plain(`${SIDE} ${POINTER}${NB}1. Default (recommended)${' '.repeat(12)}${SIDE}`),
  dim(`${SIDE}   2. Sonnet${' '.repeat(28)}${SIDE}`),
  plain('╰' + H.repeat(40) + '╯'),
]

/** A question under an earlier frame's prompt box. */
export const QUESTION_UNDER_OLD_PROMPT: Row[] = [
  rule(), plain(POINTER), rule(), STATUS,
  plain(' Do you want to proceed?'),
  plain(` ${POINTER} 1. Yes`),
  dim('   2. No'),
]

/** An earlier frame's prompt box left on screen above what came after it:
 *  Claude Code exited to the shell. */
export const OLD_FRAME_ABOVE_SHELL: Row[] = [
  ...HISTORY, rule(), plain(POINTER), rule(), STATUS, SHORTCUTS,
  plain('Resume this session with: claude --resume 1234'),
  plain('PS C:\\Users\\alex\\demo> '),
]

/** The same above an SSH session's closed connection and a password prompt. */
export const OLD_FRAME_ABOVE_SSH_PASSWORD: Row[] = [
  ...HISTORY, rule(), plain(POINTER), rule(), STATUS, SHORTCUTS,
  plain('Connection to build-box closed.'),
  plain("alex@build-box's password: "),
]

/** The same with only a shell prompt under it, on the screen's last row, in
 *  a shape that starts like tmux's status bar ("[venv] 12:01"). */
export const OLD_FRAME_ABOVE_BRACKETED_SHELL_PROMPT: Row[] = [
  ...HISTORY, rule(), plain(POINTER), rule(), STATUS, SHORTCUTS, ...blank(2),
  plain('[venv] 12:01 ~/demo $'),
]

/** The same above a question whose words and key hints this does not know. */
export const UNKNOWN_QUESTION_UNDER_OLD_PROMPT: Row[] = [
  ...HISTORY, rule(), plain(POINTER), rule(), STATUS, SHORTCUTS,
  plain(' Allow this MCP server to connect?'),
  plain('   Yes      No'),
]

/** A prompt box painted inside an answer (two columns in, as an answer's
 *  text is), above an unnumbered picker drawn with side borders, whose key
 *  hint a narrow pane wraps. */
export const PAINTED_BOX_ABOVE_SIDE_PICKER: Row[] = [
  plain(`${BULLET} Here is the layout:`),
  plain('  ' + H.repeat(40)),
  plain(`  ${POINTER} `),
  plain('  ' + H.repeat(40)),
  plain('\u256d' + H.repeat(30) + '\u256e'),
  plain(`${SIDE} Allow this action?${' '.repeat(11)}${SIDE}`),
  plain(`${SIDE}   ${POINTER} Yes${' '.repeat(22)}${SIDE}`),
  dim(`${SIDE}     No${' '.repeat(23)}${SIDE}`),
  plain('\u2570' + H.repeat(30) + '\u256f'),
  plain(' Enter to'),
  plain(' approve'),
]

/** The same with the picker itself drawn two columns in, so only its focused
 *  row, inside its side border, tells. */
export const PAINTED_BOX_ABOVE_INDENTED_SIDE_PICKER: Row[] = [
  plain(`${BULLET} Here is the layout:`),
  plain('  ' + H.repeat(40)),
  plain(`  ${POINTER} `),
  plain('  ' + H.repeat(40)),
  plain('  \u256d' + H.repeat(30) + '\u256e'),
  plain(`  ${SIDE} Allow this action?${' '.repeat(11)}${SIDE}`),
  plain(`  ${SIDE}   ${POINTER} Yes${' '.repeat(22)}${SIDE}`),
  dim(`  ${SIDE}     No${' '.repeat(23)}${SIDE}`),
  plain('  \u2570' + H.repeat(30) + '\u256f'),
]

/** Bash mode ("!" typed at an empty prompt): the pointer is "!". */
export const BASH_MODE: Row[] = [...HISTORY, rule(), plain('!'), rule(), plain('  ! for bash mode')]

/** A prompt row with a top border and no bottom border in reach. */
export const NO_BOTTOM_BORDER: Row[] = [...HISTORY, rule(), plain(POINTER), plain('  ? for shortcuts')]

/** A prompt box with more rows under it than any footer has. */
export const TALL_TAIL: Row[] = [
  rule(), plain(POINTER), rule(),
  ...Array.from({ length: 13 }, (_, i) => plain(`  line ${i + 1} of some output`)),
]

/** The shell after Claude Code exited. */
export const SHELL: Row[] = [
  plain('Resume this session with: claude --resume 1234'),
  plain(''),
  plain('PS C:\\Users\\alex\\projects\\demo> '),
  ...blank(20),
]

/** A view of the history (tmux's copy mode, opened by a wheel scroll over an
 *  SSH session in tmux): its position at the right of the top row, and an
 *  earlier frame's prompt box in view. */
export const SCROLLED_BACK: Row[] = [
  plain(`${BULLET} Done. hello.sh prints "hello".` + ' '.repeat(60) + '[42/1300]'),
  rule(), plain(POINTER), rule(), STATUS, MODE_ROW,
  ...HISTORY,
]

/** The same under a tmux status bar drawn at the top (a user's own tmux
 *  setting): the position is on the screen's second row. */
export const SCROLLED_BACK_UNDER_STATUS_BAR: Row[] = [
  plain('[demo] 0:claude*' + ' '.repeat(70) + '"build-box" 12:01 11-Oct-26'),
  plain(`${BULLET} Done. hello.sh prints "hello".` + ' '.repeat(60) + '[42/1300]'),
  rule(), plain(POINTER), rule(), STATUS, MODE_ROW,
  ...HISTORY,
]
