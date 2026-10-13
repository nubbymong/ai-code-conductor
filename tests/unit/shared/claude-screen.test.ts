/**
 * Reading Claude Code's TUI from the terminal's live screen
 * (src/shared/claude-screen.ts): the status strip types Compact, a model or an
 * effort into Claude Code only when this reads its ready, empty prompt. Every
 * screen that is not that prompt reads as something else, and anything the
 * reader does not recognise reads as not ready.
 */
import { describe, it, expect } from 'vitest'
import { readClaudeScreen } from '../../../src/shared/claude-screen'
import * as S from './claude-screens'

describe("Claude Code's ready prompt", () => {
  it('reads the empty prompt after a turn as ready and empty', () => {
    expect(readClaudeScreen(S.READY)).toEqual({ screen: 'ready', text: '' })
  })

  it("reads a new session's empty prompt under the welcome box as ready", () => {
    expect(readClaudeScreen(S.READY_NEW)).toEqual({ screen: 'ready', text: '' })
  })

  it('reads the prompt drawn with the ">" pointer as ready', () => {
    expect(readClaudeScreen(S.READY_ASCII)).toEqual({ screen: 'ready', text: '' })
  })

  it("reads the prompt as ready under a conversation holding a question's or a picker's rows", () => {
    expect(readClaudeScreen(S.READY_UNDER_QUESTION_PROSE)).toEqual({ screen: 'ready', text: '' })
  })

  it('reads a suggested prompt under the cursor as empty, wrapped or not', () => {
    expect(readClaudeScreen(S.READY_SUGGESTION)).toEqual({ screen: 'ready', text: '' })
    expect(readClaudeScreen(S.READY_SUGGESTION_WRAPPED)).toEqual({ screen: 'ready', text: '' })
  })

  it('reads a suggested prompt drawn wholly dim, the terminal not focused, as empty', () => {
    expect(readClaudeScreen(S.READY_SUGGESTION_UNFOCUSED)).toEqual({ screen: 'ready', text: '' })
  })

  it('reads the prompt as ready over a footer of several rows (a tall status line and a notice)', () => {
    expect(readClaudeScreen(S.READY_TALL_FOOTER)).toEqual({ screen: 'ready', text: '' })
  })

  it("reads the prompt as ready under Claude Code's own advice to double press esc to go back, wrapped or not", () => {
    expect(readClaudeScreen(S.READY_UNDER_ERROR_ADVICE)).toEqual({ screen: 'ready', text: '' })
    expect(readClaudeScreen(S.READY_UNDER_ERROR_ADVICE_NARROW)).toEqual({ screen: 'ready', text: '' })
  })

  it("reads the prompt as ready when a command's output a few rows up holds a retry count", () => {
    expect(readClaudeScreen(S.READY_UNDER_RETRY_OUTPUT)).toEqual({ screen: 'ready', text: '' })
  })

  it('reads one typed character before the cursor block and a dim completion as text, not as an empty prompt', () => {
    const read = readClaudeScreen(S.TYPED_ONE_BEFORE_GHOST)
    expect(read.screen).toBe('ready')
    expect(read.text).not.toBe('')
  })

  it("reads the user's own text as text, one character or wrapped, whichever space follows the pointer", () => {
    expect(readClaudeScreen(S.TYPED)).toEqual({ screen: 'ready', text: 'fix the failing test' })
    expect(readClaudeScreen(S.TYPED_ONE)).toEqual({ screen: 'ready', text: 'x' })
    expect(readClaudeScreen(S.TYPED_WRAPPED)).toEqual({ screen: 'ready', text: 'fix the failing test in the parser and then run the suite' })
  })

  it('reads the ready prompt over a tmux status bar on the last row as ready', () => {
    expect(readClaudeScreen(S.READY_UNDER_TMUX_STATUS_BAR)).toEqual({ screen: 'ready', text: '' })
  })

  it('reads one character before a dim completion as text when no cursor block is shown on it', () => {
    // Only a cursor block proven inverse makes the suggestion's shape empty.
    expect(readClaudeScreen(S.ONE_CHAR_BEFORE_GHOST_NO_CURSOR)).toEqual({ screen: 'ready', text: 'run the tests' })
    expect(readClaudeScreen(S.SUGGESTION_SHAPE_NO_ATTRIBUTES).text).not.toBe('')
  })

  it("reads text that starts on the prompt's second row as text, the first row holding only the pointer", () => {
    expect(readClaudeScreen(S.TYPED_FROM_SECOND_ROW)).toEqual({ screen: 'ready', text: 'then fix the parser' })
  })
})

describe('screens that are not the ready prompt', () => {
  it('reads a running turn as busy, retrying or not', () => {
    expect(readClaudeScreen(S.BUSY).screen).toBe('busy')
    expect(readClaudeScreen(S.BUSY_RETRYING).screen).toBe('busy')
  })

  it('reads a running turn as busy by its dim pointer when a narrow pane wraps the busy row', () => {
    expect(readClaudeScreen(S.BUSY_NARROW)).toEqual({ screen: 'busy', text: '' })
  })

  it("reads the interrupt hint, a retry's error row and a wait for background agents as busy, each on its own", () => {
    expect(readClaudeScreen(S.BUSY_HINT_ONLY).screen).toBe('busy')
    expect(readClaudeScreen(S.BUSY_RETRY_ROW).screen).toBe('busy')
    expect(readClaudeScreen(S.BUSY_BACKGROUND_AGENTS).screen).toBe('busy')
  })

  it('reads a question before a command runs as blocked, and as no prompt once a narrow pane wraps its words', () => {
    expect(readClaudeScreen(S.TOOL_QUESTION)).toEqual({ screen: 'blocked', text: '' })
    expect(readClaudeScreen(S.TOOL_QUESTION_NARROW)).toEqual({ screen: 'no-prompt', text: '' })
  })

  it('reads a question before a file is written or edited as blocked', () => {
    expect(readClaudeScreen(S.FILE_QUESTION)).toEqual({ screen: 'blocked', text: '' })
    expect(readClaudeScreen(S.EDIT_QUESTION)).toEqual({ screen: 'blocked', text: '' })
  })

  it('reads the folder-trust screen as blocked, and as no prompt once every phrase of it wraps', () => {
    expect(readClaudeScreen(S.TRUST)).toEqual({ screen: 'blocked', text: '' })
    expect(readClaudeScreen(S.TRUST_NARROW)).toEqual({ screen: 'no-prompt', text: '' })
  })

  it('reads a picker as blocked, numbered or not', () => {
    expect(readClaudeScreen(S.MODEL_PICKER).screen).toBe('blocked')
    expect(readClaudeScreen(S.PICKER_UNDER_OLD_PROMPT).screen).toBe('blocked')
  })

  it('reads a question drawn under an earlier prompt box as blocked', () => {
    expect(readClaudeScreen(S.QUESTION_UNDER_OLD_PROMPT).screen).toBe('blocked')
  })

  it("reads a picker under an earlier prompt box as blocked with a no-break space after its pointer, numbered or not", () => {
    expect(readClaudeScreen(S.PICKER_UNDER_OLD_PROMPT_NB).screen).toBe('blocked')
    expect(readClaudeScreen(S.NUMBERED_PICKER_IN_SIDES_UNDER_OLD_PROMPT_NB).screen).toBe('blocked')
  })

  it('reads bash mode, a prompt row without its bottom border, a tall tail and a shell as no prompt', () => {
    for (const [name, screen] of [['bash mode', S.BASH_MODE], ['no bottom border', S.NO_BOTTOM_BORDER], ['tall tail', S.TALL_TAIL], ['shell', S.SHELL]] as const) {
      expect(readClaudeScreen(screen).screen, name).toBe('no-prompt')
    }
  })

  it('reads an earlier prompt box above a shell, a password prompt or a question it does not know as no prompt', () => {
    // Under the box only the footer may be drawn, two columns in.
    expect(readClaudeScreen(S.OLD_FRAME_ABOVE_SHELL)).toEqual({ screen: 'no-prompt', text: '' })
    expect(readClaudeScreen(S.OLD_FRAME_ABOVE_SSH_PASSWORD)).toEqual({ screen: 'no-prompt', text: '' })
    expect(readClaudeScreen(S.UNKNOWN_QUESTION_UNDER_OLD_PROMPT)).toEqual({ screen: 'no-prompt', text: '' })
  })

  it("reads an earlier prompt box above a shell prompt shaped like the start of tmux's status bar as no prompt", () => {
    // Only the whole bar, its right part too, is taken for tmux's.
    expect(readClaudeScreen(S.OLD_FRAME_ABOVE_BRACKETED_SHELL_PROMPT)).toEqual({ screen: 'no-prompt', text: '' })
  })

  it('reads a prompt box painted in an answer above a picker with side borders as not ready, indented or not', () => {
    for (const shown of [S.PAINTED_BOX_ABOVE_SIDE_PICKER, S.PAINTED_BOX_ABOVE_INDENTED_SIDE_PICKER]) {
      expect(readClaudeScreen(shown).screen).not.toBe('ready')
    }
    // The picker's focused row inside its side border is a picker's row.
    expect(readClaudeScreen(S.PAINTED_BOX_ABOVE_INDENTED_SIDE_PICKER)).toEqual({ screen: 'blocked', text: '' })
  })

  it("reads vim mode's normal and visual modes as no prompt, and its insert mode as the ready prompt", () => {
    expect(readClaudeScreen(S.VIM_NORMAL)).toEqual({ screen: 'no-prompt', text: '' })
    expect(readClaudeScreen(S.VIM_VISUAL)).toEqual({ screen: 'no-prompt', text: '' })
    expect(readClaudeScreen(S.READY_VIM_INSERT)).toEqual({ screen: 'ready', text: '' })
  })

  it('reads a view of the history as scrolled back, under a status bar at the top or not', () => {
    expect(readClaudeScreen(S.SCROLLED_BACK)).toEqual({ screen: 'scrolled-back', text: '' })
    expect(readClaudeScreen(S.SCROLLED_BACK_UNDER_STATUS_BAR)).toEqual({ screen: 'scrolled-back', text: '' })
  })

  it('reads no screen as no prompt', () => {
    expect(readClaudeScreen(null).screen).toBe('no-prompt')
    expect(readClaudeScreen(undefined).screen).toBe('no-prompt')
    expect(readClaudeScreen([]).screen).toBe('no-prompt')
  })
})

describe('only the ready, empty prompt is ready and empty', () => {
  const READY_EMPTY = new Set([
    'READY', 'READY_NEW', 'READY_ASCII', 'READY_UNDER_QUESTION_PROSE', 'READY_SUGGESTION', 'READY_SUGGESTION_WRAPPED', 'READY_SUGGESTION_UNFOCUSED', 'READY_TALL_FOOTER',
    'READY_UNDER_ERROR_ADVICE', 'READY_UNDER_ERROR_ADVICE_NARROW', 'READY_UNDER_RETRY_OUTPUT',
    'READY_VIM_INSERT', 'READY_UNDER_TMUX_STATUS_BAR',
  ])
  const screens = Object.entries(S).filter(([, v]) => Array.isArray(v)) as Array<[string, S.Row[]]>

  it('has every fixture to check', () => {
    expect(screens.length).toBeGreaterThanOrEqual(50)
  })

  for (const [name, rows] of screens) {
    it(`${name} reads ${READY_EMPTY.has(name) ? 'ready and empty' : 'as anything else'}`, () => {
      const read = readClaudeScreen(rows)
      expect(read.screen === 'ready' && read.text === '').toBe(READY_EMPTY.has(name))
    })
  }
})
