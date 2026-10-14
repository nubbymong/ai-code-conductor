// The resume picker starts the Claude Code the app's launch line named for it
// (CCC_CLAUDE_BIN, set by buildClaudeLaunchCommand when the line starts the
// picker): a session pinned to a version runs that version from the picker
// too, as its exact resume and its Restart do (2.1.1-beta.3). The picker
// takes it only when it is an absolute path (on Windows drive-absolute, never
// a share or a device path, as the app's own lookup refuses one; elsewhere
// absolute) to a file named as Claude Code goes by there (claude.exe,
// claude.cmd or claude.bat; elsewhere claude), with no control character;
// otherwise it looks for Claude Code as it always has. A named claude.cmd or
// claude.bat starts by the same route, and with the same checks, as one found
// in PATH's folders: cmd.exe gets its path only inside the picker's quotes,
// or the launch is refused. A named one on a share or a device path is
// passed over, with one line in the session saying so when the Claude Code
// found in PATH's folders, which starts instead, is another file. Every line that
// starts the picker names this session's Claude Code itself, so a value the
// app inherited never reaches the picker. Pure: file checks answered here,
// nothing started.
import { describe, it, expect, vi } from 'vitest'

// The app's picker lines need node.exe found (the Windows line starts it by
// the path found): answered here, never by this runner's PATH.
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  return { ...actual, findOnWindowsPath: (...a: Parameters<typeof actual.findOnWindowsPath>) => (a[0].length === 1 && a[0][0] === 'node.exe' ? 'C:\\nodejs\\node.exe' : actual.findOnWindowsPath(...a)) }
})

type Env = Record<string, string | undefined>
// eslint-disable-next-line @typescript-eslint/no-var-requires
const picker = require('../../../scripts/resume-picker.js') as {
  CLAUDE_BIN_ENV: string
  resolveClaudeCmd: (platform?: string, env?: Env, isFile?: (p: string) => boolean) => string | null
  launchClaude: (resumeId: string | undefined, sourceCwd: string | undefined, deps: Record<string, unknown>) => void
}
const { CLAUDE_BIN_ENV, buildClaudeLaunchCommand } = await import('../../../src/main/spawn-claude-command')

const PIN = 'C:\\res\\legacy-versions\\2.0.0\\node_modules\\.bin\\claude.cmd'
const PATH_ENV = { PATH: 'C:\\npm;C:\\native', SystemRoot: 'C:\\Windows' }
/** Every file checked, in order, answering yes for `yes` only. */
const recorder = (...yes: string[]): { asked: string[]; isFile: (p: string) => boolean } => {
  const asked: string[] = []
  return { asked, isFile: (p: string) => { asked.push(p); return yes.includes(p) } }
}

describe('the picker reads the variable the app\'s line sets', () => {
  it('one name on both sides', () => {
    expect(picker.CLAUDE_BIN_ENV).toBe('CCC_CLAUDE_BIN')
    expect(CLAUDE_BIN_ENV).toBe(picker.CLAUDE_BIN_ENV)
  })
})

describe('Windows', () => {
  // Mutation to prove this can fail: ignore the variable (the picker walks PATH and runs the installed one).
  it('a named Claude Code that is there is the one started, and PATH is not walked', () => {
    const r = recorder(PIN, 'C:\\native\\claude.exe')
    expect(picker.resolveClaudeCmd('win32', { ...PATH_ENV, CCC_CLAUDE_BIN: PIN }, r.isFile)).toBe(PIN)
    expect(r.asked).toEqual([PIN])
  })

  it('the variable in any case, as Windows names variables; two spellings that disagree are no answer', () => {
    const r = recorder(PIN)
    expect(picker.resolveClaudeCmd('win32', { ...PATH_ENV, Ccc_Claude_Bin: PIN }, r.isFile)).toBe(PIN)
    const two = recorder(PIN, 'C:\\native\\claude.exe')
    expect(picker.resolveClaudeCmd('win32', { ...PATH_ENV, CCC_CLAUDE_BIN: PIN, ccc_claude_bin: 'C:\\other\\claude.exe' }, two.isFile)).toBe('C:\\native\\claude.exe')
  })

  it('every name Claude Code goes by, in any case, on a drive', () => {
    for (const p of ['C:\\x\\claude.exe', 'C:\\x\\claude.cmd', 'C:\\x\\claude.bat', 'D:/y/CLAUDE.CMD', 'z:\\pin dir (x86)\\Claude.Exe']) {
      expect(picker.resolveClaudeCmd('win32', { ...PATH_ENV, CCC_CLAUDE_BIN: p }, recorder(p).isFile), p).toBe(p)
    }
  })

  // The app's own lookup refuses a share for a Claude Code path it is handed
  // (windows-programs.ts powerShellProfileAnswer); the picker takes the same rule.
  // Mutation to prove this can fail: take a share again (FULLY_QUALIFIED_FOLDER_RE, as before).
  it('a share is passed over, unchecked, whichever slashes name it, and the picker looks in PATH\'s folders as before', () => {
    const shares = ['\\\\srv\\share\\pin\\claude.cmd', '//srv/share/pin/claude.exe', '\\\\srv\\share\\claude.bat', '\\/srv/share\\claude.exe', '/\\srv\\share/claude.cmd', '\\\\127.0.0.1\\c$\\pin\\claude.exe']
    for (const p of shares) {
      const r = recorder(p, 'C:\\native\\claude.exe')
      expect(picker.resolveClaudeCmd('win32', { ...PATH_ENV, CCC_CLAUDE_BIN: p }, r.isFile), JSON.stringify(p)).toBe('C:\\native\\claude.exe')
      expect(r.asked, JSON.stringify(p)).not.toContain(p)
    }
  })

  it('anything else is passed over, unchecked, and the picker looks in PATH\'s folders as before', () => {
    const passed = [
      'claude.cmd', '.\\claude.cmd', 'pin\\claude.cmd', 'C:claude.cmd', '\\pin\\claude.cmd', '\\\\?\\C:\\pin\\claude.cmd', '\\\\.\\C:\\pin\\claude.cmd',
      'C:\\pin\\claude.ps1', 'C:\\pin\\node.exe', 'C:\\pin\\claude.cmd.exe', 'C:\\pin\\claude', 'C:\\pin\\claude.cmd ', 'C:\\pin\\claude.cmd.',
      'C:\\pi\u0007n\\claude.cmd', '',
    ]
    for (const p of passed) {
      const r = recorder(p, 'C:\\native\\claude.exe')
      expect(picker.resolveClaudeCmd('win32', { ...PATH_ENV, CCC_CLAUDE_BIN: p }, r.isFile), JSON.stringify(p)).toBe('C:\\native\\claude.exe')
      expect(r.asked, JSON.stringify(p)).not.toContain(p)
    }
  })

  it('a named file that is not there, or whose check fails, is passed over too', () => {
    expect(picker.resolveClaudeCmd('win32', { ...PATH_ENV, CCC_CLAUDE_BIN: PIN }, recorder('C:\\native\\claude.exe').isFile)).toBe('C:\\native\\claude.exe')
    const throwing = (p: string): boolean => { if (p === PIN) throw Object.assign(new Error('does not answer'), { code: 'EIO' }); return p === 'C:\\native\\claude.exe' }
    expect(picker.resolveClaudeCmd('win32', { ...PATH_ENV, CCC_CLAUDE_BIN: PIN }, throwing)).toBe('C:\\native\\claude.exe')
  })

  it('without the variable nothing changes', () => {
    const r = recorder('C:\\native\\claude.exe')
    expect(picker.resolveClaudeCmd('win32', PATH_ENV, r.isFile)).toBe('C:\\native\\claude.exe')
    expect(r.asked).toEqual(['C:\\npm\\claude.exe', 'C:\\native\\claude.exe'])
  })
})

describe('elsewhere', () => {
  it('a named claude the user may run is the one started; anything else is claude by name, as before', () => {
    const pin = '/home/u/res/legacy-versions/2.0.0/node_modules/.bin/claude'
    expect(picker.resolveClaudeCmd('linux', { PATH: '/usr/bin', CCC_CLAUDE_BIN: pin }, recorder(pin).isFile)).toBe(pin)
    for (const p of ['claude', './claude', 'bin/claude', '/opt/x/node', '/opt/x/claude.sh', '/opt/x/cl\u001baude/claude']) {
      expect(picker.resolveClaudeCmd('darwin', { PATH: '/usr/bin', CCC_CLAUDE_BIN: p }, recorder(p).isFile), p).toBe('claude')
    }
    // Not runnable, or not there.
    expect(picker.resolveClaudeCmd('linux', { PATH: '/usr/bin', CCC_CLAUDE_BIN: pin }, () => false)).toBe('claude')
    // The variable's name is matched exactly off Windows.
    expect(picker.resolveClaudeCmd('linux', { PATH: '/usr/bin', ccc_claude_bin: pin }, recorder(pin).isFile)).toBe('claude')
  })
})

describe('the launch starts the named Claude Code by the route and checks of one found in PATH', () => {
  const run = (env: Env, platform: string, isFile: (p: string) => boolean) => {
    const calls: Array<{ file: string; argv: string[] }> = []
    const exits: number[] = []
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      picker.launchClaude(undefined, undefined, {
        spawn: (file: string, argv: string[]) => { calls.push({ file, argv }); return { status: 0 } },
        exit: (code: number) => { exits.push(code) },
        argv: ['--model', 'opus'],
        env,
        platform,
        isFile,
        cwd: platform === 'win32' ? 'C:\\work' : '/work',
      })
      return { calls, exits, said: err.mock.calls.map((c) => String(c[0])).join('\n'), printed: log.mock.calls.map((c) => String(c[0])) }
    } finally {
      err.mockRestore()
      log.mockRestore()
    }
  }

  // The app still names a pinned Claude Code on a share (a resources folder
  // on one), and its exact resume and Restart start it; the picker does not.
  // So the session says which one the resume list starts, never in silence.
  // Mutation to prove this can fail: print nothing when the named one is passed over.
  const NOTICE_RE = /^\n {2}The resume list starts the Claude Code found in PATH's folders \((.*)\), not the one this session names \((.*)\): the resume list does not take a named path on a network share or a device path\. To have it start the named one, reach that folder through a drive letter: map the share to a drive letter and, for a session set to an older Claude Code version, point the app's resources folder at that drive\.\n$/
  it('Windows: a named Claude Code on a share or a device path is passed over with one line saying so, and the one in PATH\'s folders starts', () => {
    for (const p of ['\\\\srv\\share\\pin\\claude.cmd', '//srv/share/pin/claude.exe', '\\/srv/share\\claude.exe', '\\\\?\\C:\\pin\\claude.cmd', '\\\\.\\C:\\pin\\claude.exe', '\\\\?\\C:\\native\\claude.exe']) {
      const out = run({ ...PATH_ENV, CCC_CLAUDE_BIN: p }, 'win32', (f) => f === p || f === 'C:\\native\\claude.exe')
      expect(out.calls, p).toEqual([{ file: 'C:\\native\\claude.exe', argv: ['--model', 'opus'] }])
      expect(out.printed, p).toHaveLength(1)
      expect(out.printed[0], p).toMatch(NOTICE_RE)
      expect(NOTICE_RE.exec(out.printed[0])!.slice(1), p).toEqual(['C:\\native\\claude.exe', p])
    }
    // Another share folder that PATH names holds the one that starts: still another file.
    const other = '\\\\srv\\other\\claude.exe'
    const out = run({ PATH: '\\\\srv\\other;C:\\native', SystemRoot: 'C:\\Windows', CCC_CLAUDE_BIN: '\\\\srv\\share\\pin\\claude.exe' }, 'win32', (f) => f === other || f === 'C:\\native\\claude.exe')
    expect(out.calls).toEqual([{ file: other, argv: ['--model', 'opus'] }])
    expect(out.printed).toHaveLength(1)
    expect(NOTICE_RE.exec(out.printed[0])!.slice(1)).toEqual([other, '\\\\srv\\share\\pin\\claude.exe'])
    // A control character in the named path is never printed.
    const odd = '\\\\srv\\sh\u001b[2Jare\\claude.exe'
    const shown = run({ ...PATH_ENV, CCC_CLAUDE_BIN: odd }, 'win32', (f) => f === 'C:\\native\\claude.exe').printed
    expect(shown).toHaveLength(1)
    expect(shown[0]).toContain('sh [2Jare')
    expect(shown[0].replace(/\n/g, '')).not.toMatch(/\p{Cc}/u)
  })

  // The app also names a Claude Code it found in a share folder on PATH (no
  // pin): the picker's own walk finds that same file, so there is nothing to say.
  // Mutation to prove this can fail: decide the line from the named path alone.
  it('Windows: a named Claude Code in a share folder PATH names, which the picker finds too, starts with no line about it, however it is spelled', () => {
    const SHARE_PATH = { PATH: '\\\\srv\\tools;C:\\native', SystemRoot: 'C:\\Windows' }
    const BIN = '\\\\srv\\tools\\claude.exe'
    for (const p of [BIN, '//srv/tools/claude.exe', '\\\\SRV\\Tools\\CLAUDE.EXE', '\\\\srv\\tools\\.\\x\\..\\claude.exe']) {
      const out = run({ ...SHARE_PATH, CCC_CLAUDE_BIN: p }, 'win32', (f) => f === BIN || f === 'C:\\native\\claude.exe')
      expect(out.calls, p).toEqual([{ file: BIN, argv: ['--model', 'opus'] }])
      expect(out.printed, p).toEqual([])
    }
    // A folder PATH names with a trailing dot is read as Windows runs it, on both sides.
    const dotted = run({ PATH: '\\\\srv\\tools\\bin.;C:\\native', SystemRoot: 'C:\\Windows', CCC_CLAUDE_BIN: '\\\\srv\\tools\\bin.\\claude.exe' }, 'win32', (f) => f === '\\\\srv\\tools\\bin\\claude.exe')
    expect(dotted.calls).toEqual([{ file: '\\\\srv\\tools\\bin\\claude.exe', argv: ['--model', 'opus'] }])
    expect(dotted.printed).toEqual([])
    // npm's claude.cmd in a share folder: the same file, started through cmd.exe, no line.
    const cmdBin = '\\\\srv\\tools\\claude.cmd'
    const viaCmd = run({ ...SHARE_PATH, CCC_CLAUDE_BIN: cmdBin }, 'win32', (f) => f === cmdBin)
    expect(viaCmd.calls).toHaveLength(1)
    expect(viaCmd.calls[0].file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(viaCmd.calls[0].argv[4]).toBe(`""${cmdBin}" "--model" "opus""`)
    expect(viaCmd.printed).toEqual([])
  })

  it('Windows: a named Claude Code on a share with no Claude Code found, or with the one found refused, gets only the reason nothing starts', () => {
    const none = run({ ...PATH_ENV, CCC_CLAUDE_BIN: '\\\\srv\\share\\pin\\claude.exe' }, 'win32', () => false)
    expect(none.calls).toEqual([])
    expect(none.exits).toEqual([1])
    expect(none.printed).toEqual([])
    expect(none.said).toContain('Not starting Claude Code: it was not found in a folder PATH names')
    const refused = run({ PATH: 'C:\\R&D', SystemRoot: 'C:\\Windows', CCC_CLAUDE_BIN: '\\\\srv\\share\\pin\\claude.exe' }, 'win32', (f) => f === 'C:\\R&D\\claude.cmd')
    expect(refused.calls).toEqual([])
    expect(refused.exits).toEqual([1])
    expect(refused.printed).toEqual([])
    expect(refused.said).toContain('cmd.exe would re-read a character in that path')
  })

  it('Windows: no line about it for a named Claude Code on a drive, one passed over for another reason, or none named; and none elsewhere', () => {
    for (const env of [{ ...PATH_ENV, CCC_CLAUDE_BIN: PIN }, { ...PATH_ENV, CCC_CLAUDE_BIN: 'claude.cmd' }, { ...PATH_ENV, CCC_CLAUDE_BIN: 'C:\\pin\\node.exe' }, PATH_ENV]) {
      expect(run(env, 'win32', (f) => f === PIN || f === 'C:\\native\\claude.exe').printed, JSON.stringify(env)).toEqual([])
    }
    expect(run({ PATH: '/usr/bin', CCC_CLAUDE_BIN: '//srv/share/claude' }, 'linux', () => false).printed).toEqual([])
  })

  it('Windows: a named claude.cmd runs through the system cmd.exe, its path quoted on the verbatim line', () => {
    const out = run({ ...PATH_ENV, CCC_CLAUDE_BIN: PIN }, 'win32', (p) => p === PIN || p === 'C:\\native\\claude.exe')
    expect(out.calls).toEqual([{ file: 'C:\\Windows\\System32\\cmd.exe', argv: ['/d', '/v:off', '/s', '/c', `""${PIN}" "--model" "opus""`] }])
    expect(out.exits).toEqual([0])
  })

  it('Windows: a named claude.cmd whose path cmd.exe would re-read is refused with the reason, not swapped for another', () => {
    const bad = 'C:\\R&D\\pin\\claude.cmd'
    const out = run({ ...PATH_ENV, CCC_CLAUDE_BIN: bad }, 'win32', (p) => p === bad || p === 'C:\\native\\claude.exe')
    expect(out.calls).toEqual([])
    expect(out.exits).toEqual([1])
    expect(out.said).toContain('cmd.exe would re-read a character in that path')
  })

  /** What cmd.exe reads outside its quotes in `text`: one quote state,
   *  turned by every double quote. */
  const outsideCmdQuotes = (text: string): string => {
    let quoted = false
    let out = ''
    for (const ch of text) {
      if (ch === '"') quoted = !quoted
      else if (!quoted) out += ch
    }
    return out
  }

  // Each character cmd.exe reads as more than text: in the launcher's own
  // path, it is either inside the quotes the picker writes (| < > ( ) and !,
  // which delayed expansion, off on the line, would otherwise read), or the
  // launch is refused with the reason (" % & ^: cmd.exe or the launcher
  // itself would read them again, inside quotes too).
  // Mutation to prove this can fail: write the launcher's path on the /c line without its quotes.
  it('Windows: a named claude.cmd or claude.bat whose path holds a cmd.exe character reaches cmd.exe only inside the picker\'s quotes, or is refused', () => {
    const refused = ['"', '%', '&', '^']
    for (const ext of ['cmd', 'bat']) {
      for (const c of ['&', '|', '<', '>', '^', '(', ')', '%', '!', '"']) {
        const pin = `C:\\Tools ${c}x\\pin${c}\\claude.${ext}`
        const out = run({ ...PATH_ENV, CCC_CLAUDE_BIN: pin }, 'win32', (p) => p === pin || p === 'C:\\native\\claude.exe')
        const what = `${ext} ${c}`
        if (refused.includes(c)) {
          expect(out.calls, what).toEqual([])
          expect(out.exits, what).toEqual([1])
          expect(out.said, what).toContain('cmd.exe would re-read a character in that path')
          continue
        }
        expect(out.calls, what).toHaveLength(1)
        const { file, argv } = out.calls[0]
        expect(file, what).toBe('C:\\Windows\\System32\\cmd.exe')
        expect(argv.slice(0, 4), what).toEqual(['/d', '/v:off', '/s', '/c'])
        // /s: cmd.exe drops the first and the last quote of the /c text and reads the rest.
        const body = argv[4]
        expect(body.startsWith('"') && body.endsWith('"'), what).toBe(true)
        const read = body.slice(1, -1)
        expect(read, what).toBe(`"${pin}" "--model" "opus"`)
        expect(outsideCmdQuotes(read), what).not.toMatch(/[&|<>^()%!"]/)
        expect(outsideCmdQuotes(read), what).toBe('  ')
      }
    }
  })

  it('elsewhere: the named claude is the program started', () => {
    const pin = '/opt/pin/claude'
    const out = run({ PATH: '/usr/bin', CCC_CLAUDE_BIN: pin }, 'linux', (p) => p === pin)
    expect(out.calls).toEqual([{ file: pin, argv: ['--model', 'opus'] }])
  })
})

describe('every line that starts the picker names this session\'s Claude Code itself, over a value the app inherited', () => {
  const PICKER_JS = 'C:\\res\\scripts\\resume-picker.js'
  const line = (platform: string, claudeBin: string, pickerScript: string): string =>
    buildClaudeLaunchCommand({ platform, cwd: platform === 'win32' ? 'C:\\work' : '/w', claudeBin, extraFlags: '', agentsFlag: '', useResumePicker: true, pickerScript })

  // Mutation to prove this can fail: drop the statement that names Claude Code from the Windows picker line.
  it('Windows: an assignment in the session\'s own PowerShell, right before the picker starts', () => {
    expect(line('win32', PIN, PICKER_JS)).toBe(`Set-Location -LiteralPath 'C:\\work'; $env:${CLAUDE_BIN_ENV} = '${PIN}'; & 'C:\\nodejs\\node.exe' '${PICKER_JS}'; exit`)
  })

  // Mutation to prove this can fail: drop the export from the line.
  it('macOS and Linux: exported before the shell picks the program, whichever it picks', () => {
    const l = line('posix', '/opt/pin/claude', '/r/resume-picker.js')
    expect(l.startsWith(`cd '/w' && export ${CLAUDE_BIN_ENV}='/opt/pin/claude' && if `), l).toBe(true)
    expect(l.indexOf(`export ${CLAUDE_BIN_ENV}=`)).toBeLessThan(l.indexOf(`set -- node '/r/resume-picker.js'`))
    expect(l.split(`${CLAUDE_BIN_ENV}=`)).toHaveLength(2)
  })
})
