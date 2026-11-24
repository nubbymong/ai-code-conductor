// aicc_planning#404: a Claude Code tab that grows keeps the rows above its banner.
//
// beta.15 M1 recorded a Claude Code tab (Claude Code 2.1.328 in PowerShell, both
// helper switches off) on the published beta.14, Windows 11 build 22621, while its
// window was given 1280x800 (the grow) and maximised again (the max): the tab's rows
// before (xterm's buffer, text only, each row as xterm held it), each size its
// terminal took, what the console sent after it, byte for byte, and the rows the VM
// read after. Two screens: Claude Code's main screen (g-ccmain) and its question
// whether to trust the folder (g-cctrust). Runs of `─` are written <─N> (N of
// them). Source: M1's out/vmout-hold1/g-<tab>-<grow|max>-stream.stream.json,
// g-<tab>-<grow|max>-sizes.sizes.json and g-<tab>-<0before|1grown|2back>.buf.json.
//
// PUBLISHED_CONTROL is beta.15 A1's VM line on the published beta.14 (A1's
// out/67-control-cc-size-published.txt, Claude Code 2.1.330): the screen before
// the grow as the VM read it (its rows 5 to 10 are one line the console wrapped),
// and the console's paint after each size. That line kept each paint's length, not
// its bytes: each is rebuilt from g-ccmain's paint at the same size with this
// session's version and suggestion in it, and comes to the recorded length.
//
// Not a test file: tests/unit/renderer/console-repaint-claude-code.test.ts reads it.
export interface RecordedRows {
  /** The terminal's size, columns x rows. */
  size: string
  baseY: number
  /** The cursor's column and row on the screen. */
  cursor: [number, number]
  /** The rows the buffer held. */
  length: number
  /** The rows wrapped on to the row above. */
  wrapped: number[]
  /** Each row's text, to the last row with text. */
  rows: string[]
}
export type RecordedCcEvent = { resize: string } | { write: string; chars: number }
export interface RecordedCcResize {
  name: string
  before: RecordedRows
  events: RecordedCcEvent[]
  after: RecordedRows
}

/** Expands the <─N> runs. */
export function expandRules(s: string): string {
  return s.replace(/<─(\d+)>/g, (_m, n: string) => '─'.repeat(Number(n)))
}

export const RECORDED_CC_RESIZES: RecordedCcResize[] = [
  {
    name: 'g-ccmain-grow',
    // g-ccmain-0before.buf.json: the terminal's rows before the first size.
    before: {
      size: '103x27', baseY: 4, cursor: [2, 6], length: 31,
      wrapped: [],
      rows: [
        "Windows PowerShell",
        "Copyright (C) Microsoft Corporation. All rights reserved.",
        "",
        "<─103>",
        " ▐▛███▛█   Claude Code v2.1.328",
        "▝▜██████▀  Opus 5.5 with medium effort · API Usage Billing",
        " ▝▝   ▝▝   C:\\Users\\User\\p2w\\projects\\web-app",
        "",
        "",
        "<─103>",
        "> Try \"fix typecheck errors\"",
        "<─103>",
        "  ⏵⏵ auto mode on (shift+tab to cycle)                                     Not logged in · run /login",
      ],
    },
    events: [
      { resize: '140x28' }, // 2575 ms after the watch started
      { chars: 972, write: "\u001b[?25l\u001b[38;2;215;119;87m\u001b[H ▐\u001b[48;2;0;0;0m▛███▛█\u001b[m   \u001b[1mClaude\u001b[22m \u001b[1mCode\u001b[22m \u001b[38;2;153;153;153mv2.1.328\u001b[K\u001b[38;2;215;119;87m\r\n▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mOpus 5.5 with medium effort · API Usage Billing\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153mC:\\Users\\User\\p2w\\projects\\web-app\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\u001b[38;2;136;136;136m\r\n<─140>\u001b[m\r\n> \u001b[2mTry\u001b[22m \u001b[2m\"fix\u001b[22m \u001b[2mtypecheck\u001b[22m \u001b[2merrors\"\u001b[22m\u001b[K\u001b[38;2;136;136;136m\r\n<─140>\u001b[m\r\n  \u001b[38;2;255;193;7m⏵⏵ auto mode on \u001b[38;2;153;153;153m(shift+tab to cycle)\u001b[74X\u001b[38;2;255;107;128m\u001b[74CNot logged in · run /login  \u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[7;3H\u001b[?25h" }, // 8 ms after the size
    ],
    // g-ccmain-1grown.buf.json: the VM's reading after it.
    after: {
      size: '140x28', baseY: 4, cursor: [2, 6], length: 32,
      wrapped: [],
      rows: [
        "Windows PowerShell",
        "Copyright (C) Microsoft Corporation. All rights reserved.",
        "",
        "<─103>",
        " ▐▛███▛█   Claude Code v2.1.328",
        "▝▜██████▀  Opus 5.5 with medium effort · API Usage Billing",
        " ▝▝   ▝▝   C:\\Users\\User\\p2w\\projects\\web-app",
        "",
        "",
        "<─140>",
        "> Try \"fix typecheck errors\"",
        "<─140>",
        "  ⏵⏵ auto mode on (shift+tab to cycle)                                                                          Not logged in · run /login  ",
      ],
    },
  },
  {
    name: 'g-ccmain-max',
    // g-ccmain-1grown.buf.json: the terminal's rows before the first size.
    before: {
      size: '140x28', baseY: 4, cursor: [2, 6], length: 32,
      wrapped: [],
      rows: [
        "Windows PowerShell",
        "Copyright (C) Microsoft Corporation. All rights reserved.",
        "",
        "<─103>",
        " ▐▛███▛█   Claude Code v2.1.328",
        "▝▜██████▀  Opus 5.5 with medium effort · API Usage Billing",
        " ▝▝   ▝▝   C:\\Users\\User\\p2w\\projects\\web-app",
        "",
        "",
        "<─140>",
        "> Try \"fix typecheck errors\"",
        "<─140>",
        "  ⏵⏵ auto mode on (shift+tab to cycle)                                                                          Not logged in · run /login  ",
      ],
    },
    events: [
      { resize: '103x27' }, // 550 ms after the watch started
      { chars: 893, write: "\u001b[?25l\u001b[38;2;215;119;87m\u001b[H ▐\u001b[48;2;0;0;0m▛███▛█\u001b[m   \u001b[1mClaude\u001b[22m \u001b[1mCode\u001b[22m \u001b[38;2;153;153;153mv2.1.328\u001b[K\u001b[38;2;215;119;87m\r\n▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mOpus 5.5 with medium effort · API Usage Billing\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153mC:\\Users\\User\\p2w\\projects\\web-app\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\u001b[38;2;136;136;136m\r\n<─103>\u001b[m\r\n> \u001b[2mTry\u001b[22m \u001b[2m\"fix\u001b[22m \u001b[2mtypecheck\u001b[22m \u001b[2merrors\"\u001b[22m\u001b[K\u001b[38;2;136;136;136m\r\n<─103>\u001b[m\r\n  \u001b[38;2;255;193;7m⏵⏵ auto mode on \u001b[38;2;153;153;153m(shift+tab to cycle)\u001b[37X\u001b[38;2;255;107;128m\u001b[37CNot logged in · run /login  \u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[7;3H\u001b[?25h" }, // 3 ms after the size
    ],
    // g-ccmain-2back.buf.json: the VM's reading after it.
    after: {
      size: '103x27', baseY: 6, cursor: [2, 6], length: 33,
      wrapped: [],
      rows: [
        "Windows PowerShell",
        "Copyright (C) Microsoft Corporation. All rights reserved.",
        "",
        "<─103>",
        " ▐▛███▛█   Claude Code v2.1.328",
        "▝▜██████▀  Opus 5.5 with medium effort · API Usage Billing",
        " ▐▛███▛█   Claude Code v2.1.328",
        "▝▜██████▀  Opus 5.5 with medium effort · API Usage Billing",
        " ▝▝   ▝▝   C:\\Users\\User\\p2w\\projects\\web-app",
        "",
        "",
        "<─103>",
        "> Try \"fix typecheck errors\"",
        "<─103>",
        "  ⏵⏵ auto mode on (shift+tab to cycle)                                     Not logged in · run /login  ",
      ],
    },
  },
  {
    name: 'g-cctrust-grow',
    // g-cctrust-0before.buf.json: the terminal's rows before the first size.
    before: {
      size: '103x27', baseY: 3, cursor: [102, 26], length: 30,
      wrapped: [],
      rows: [
        "Windows PowerShell",
        "Copyright (C) Microsoft Corporation. All rights reserved.",
        "",
        "",
        "<─103>",
        " Accessing workspace:",
        "",
        " C:\\Users\\User\\p2w\\projects\\web-app",
        "",
        " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known ",
        " open source project, or work from your team). If not, take a moment to review what's in this folder   ",
        " first.",
        "",
        " Claude Code'll be able to read, edit, and execute files here.",
        "",
        " Security guide",
        "",
        " > No, exit",
        "   Yes, I trust this folder",
        "",
        " Enter to confirm · Esc to cancel",
      ],
    },
    events: [
      { resize: '140x24' }, // 2604 ms after the watch started
      { chars: 907, write: "\u001b[H\u001b[K\u001b[38;2;255;193;7m\r\n<─140>\u001b[m\r\n \u001b[38;2;255;193;7m\u001b[1mAccessing\u001b[m \u001b[38;2;255;193;7m\u001b[1mworkspace:\u001b[m\u001b[K\r\n\u001b[K\r\n \u001b[1mC:\\Users\\User\\p2w\\projects\\web-app\u001b[22m\u001b[K\r\n\u001b[K\r\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from    \r\n your team). If not, take a moment to review what's in this folder first.\u001b[K\r\n\u001b[K\r\n Claude Code'll be able to read, edit, and execute files here.\u001b[K\r\n\u001b[K\r\n \u001b[38;2;153;153;153m\u001b]8;id=u-zaxmda%10079904217656203891;https://code.claude.com/docs/en/security\u001b\\Security guide\u001b[m\u001b]8;;\u001b\\\u001b[K\r\n\u001b[K\r\n \u001b[38;2;177;185;249m> No, exit\u001b[K\u001b[m\r\n   Yes, I trust this folder\u001b[K\r\n\u001b[K\r\n \u001b[38;2;153;153;153mEnter to confirm · Esc to cancel\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[140C" }, // 7 ms after the size
      { resize: '140x28' }, // 3004 ms after the watch started
      { chars: 925, write: "\u001b[H\u001b[K\u001b[38;2;255;193;7m\r\n<─140>\u001b[m \u001b[38;2;255;193;7m\u001b[1mAccessing\u001b[m \u001b[38;2;255;193;7m\u001b[1mworkspace:\u001b[m\u001b[K\r\n\u001b[K\r\n \u001b[1mC:\\Users\\User\\p2w\\projects\\web-app\u001b[22m\u001b[K\r\n\u001b[K\r\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from    \r\n your team). If not, take a moment to review what's in this folder first.\u001b[K\r\n\u001b[K\r\n Claude Code'll be able to read, edit, and execute files here.\u001b[K\r\n\u001b[K\r\n \u001b[38;2;153;153;153m\u001b]8;id=u-zaxmda%10079904217656203891;https://code.claude.com/docs/en/security\u001b\\Security guide\u001b[m\u001b]8;;\u001b\\\u001b[K\r\n\u001b[K\r\n \u001b[38;2;177;185;249m> No, exit\u001b[K\u001b[m\r\n   Yes, I trust this folder\u001b[K\r\n\u001b[K\r\n \u001b[38;2;153;153;153mEnter to confirm · Esc to cancel\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[140C" }, // 0 ms after the size
    ],
    // g-cctrust-1grown.buf.json: the VM's reading after it.
    after: {
      size: '140x28', baseY: 2, cursor: [139, 27], length: 30,
      wrapped: [4],
      rows: [
        "Windows PowerShell",
        "Copyright (C) Microsoft Corporation. All rights reserved.",
        "",
        "<─140>",
        " Accessing workspace:",
        "",
        " C:\\Users\\User\\p2w\\projects\\web-app",
        "",
        " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from    ",
        " your team). If not, take a moment to review what's in this folder first.",
        "",
        " Claude Code'll be able to read, edit, and execute files here.",
        "",
        " Security guide",
        "",
        " > No, exit",
        "   Yes, I trust this folder",
        "",
        " Enter to confirm · Esc to cancel",
      ],
    },
  },
  {
    name: 'g-cctrust-max',
    // g-cctrust-1grown.buf.json: the terminal's rows before the first size.
    before: {
      size: '140x28', baseY: 2, cursor: [139, 27], length: 30,
      wrapped: [4],
      rows: [
        "Windows PowerShell",
        "Copyright (C) Microsoft Corporation. All rights reserved.",
        "",
        "<─140>",
        " Accessing workspace:",
        "",
        " C:\\Users\\User\\p2w\\projects\\web-app",
        "",
        " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from    ",
        " your team). If not, take a moment to review what's in this folder first.",
        "",
        " Claude Code'll be able to read, edit, and execute files here.",
        "",
        " Security guide",
        "",
        " > No, exit",
        "   Yes, I trust this folder",
        "",
        " Enter to confirm · Esc to cancel",
      ],
    },
    events: [
      { resize: '103x27' }, // 517 ms after the watch started
      { chars: 882, write: "\u001b[H\u001b[K\u001b[38;2;255;193;7m\r\n<─103>\u001b[m\r\n \u001b[38;2;255;193;7m\u001b[1mAccessing\u001b[m \u001b[38;2;255;193;7m\u001b[1mworkspace:\u001b[m\u001b[K\r\n\u001b[K\r\n \u001b[1mC:\\Users\\User\\p2w\\projects\\web-app\u001b[22m\u001b[K\r\n\u001b[K\r\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known \r\n open source project, or work from your team). If not, take a moment to review what's in this folder   \r\n first.\u001b[K\r\n\u001b[K\r\n Claude Code'll be able to read, edit, and execute files here.\u001b[K\r\n\u001b[K\r\n \u001b[38;2;153;153;153m\u001b]8;id=u-zaxmda%10079904217656203891;https://code.claude.com/docs/en/security\u001b\\Security guide\u001b[m\u001b]8;;\u001b\\\u001b[K\r\n\u001b[K\r\n \u001b[38;2;177;185;249m> No, exit\u001b[K\u001b[m\r\n   Yes, I trust this folder\u001b[K\r\n\u001b[K\r\n \u001b[38;2;153;153;153mEnter to confirm · Esc to cancel\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[103C" }, // 16 ms after the size
    ],
    // g-cctrust-2back.buf.json: the VM's reading after it.
    after: {
      size: '103x27', baseY: 4, cursor: [102, 26], length: 31,
      wrapped: [],
      rows: [
        "Windows PowerShell",
        "Copyright (C) Microsoft Corporation. All rights reserved.",
        "",
        "<─103>",
        "",
        "<─103>",
        " Accessing workspace:",
        "",
        " C:\\Users\\User\\p2w\\projects\\web-app",
        "",
        " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known ",
        " open source project, or work from your team). If not, take a moment to review what's in this folder   ",
        " first.",
        "",
        " Claude Code'll be able to read, edit, and execute files here.",
        "",
        " Security guide",
        "",
        " > No, exit",
        "   Yes, I trust this folder",
        "",
        " Enter to confirm · Esc to cancel",
      ],
    },
  },
]

/** The published beta.14's Claude Code tab in A1's VM line: grown from 103x27 to
 *  140x28 in one size, then maximised again to 103x27. */
export const PUBLISHED_CONTROL = {
  name: 'pg-pcc',
  before: {
    size: '103x27', baseY: 0, cursor: [2, 17] as [number, number], length: 27,
    wrapped: [6, 7, 8, 9, 10],
    rows: [
      "Windows PowerShell",
      "Copyright (C) Microsoft Corporation. All rights reserved.",
      "",
      "Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows",
      "",
      "PS C:\\Users\\User\\p2w\\projects\\web-app> Set-Location -LiteralPath 'C:\\Users\\User\\p2w\\projects\\web-app'; ",
      "$env:CCC_CLAUDE_BIN = 'C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd'; & 'C:\\Program Files\\nodejs\\node.e",
      "xe' 'C:\\Users\\User\\AppData\\Local\\AI Code Conductor\\resources\\scripts\\resume-picker.js' --model 'opus' -",
      "-settings 'C:\\Users\\User\\.claude\\settings-b52094a0cbaa9a2da8ce72ce.json' --mcp-config 'C:\\Users\\User\\.c",
      "laude\\mcp-b52094a0cbaa9a2da8ce72ce.json' --plugin-dir 'C:\\Users\\User\\AppData\\Local\\AI Code Conductor\\re",
      "sources\\canvas-plugin'; exit",
      " ▐▛███▛█   Claude Code v2.1.330",
      "▝▜██████▀  Opus 5.5 with medium effort · API Usage Billing",
      " ▝▝   ▝▝   C:\\Users\\User\\p2w\\projects\\web-app",
      "",
      "",
      "<─103>",
      "> Try \"edit <filepath> to…\"",
      "<─103>",
      "  ⏵⏵ auto mode on (shift+tab to cycle)                                     Not logged in · run /login",
    ],
  } satisfies RecordedRows,
  /** Each paint's recorded length, in characters. */
  growChars: 971,
  maxChars: 892,
  /** The VM's reading after the grow and after the max: the shell's rows gone. */
  read: { baseY: 0, cursor: [2, 6] as [number, number], topRow: ' ▐▛███▛█   Claude Code v2.1.330' },
  version: ['v2.1.328', 'v2.1.330'] as [string, string],
  suggestion: [
    '\u001b[2m"fix\u001b[22m \u001b[2mtypecheck\u001b[22m \u001b[2merrors"\u001b[22m',
    '\u001b[2m"edit\u001b[22m \u001b[2m<filepath>\u001b[22m \u001b[2mto…"\u001b[22m',
  ] as [string, string],
}

/** A paint of g-ccmain's with the published control's version and suggestion in it. */
export function controlPaint(gccmainPaint: string): string {
  const [oldVersion, newVersion] = PUBLISHED_CONTROL.version
  const [oldSuggestion, newSuggestion] = PUBLISHED_CONTROL.suggestion
  if (!gccmainPaint.includes(oldVersion) || !gccmainPaint.includes(oldSuggestion)) throw new Error('not a paint of g-ccmain')
  return gccmainPaint.replace(oldVersion, newVersion).replace(oldSuggestion, newSuggestion)
}
