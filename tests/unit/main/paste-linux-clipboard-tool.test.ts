// Claude Code on a Linux app machine reads the clipboard by running xclip or
// wl-paste (ADR-032's table; plan 2.1.3-beta.21 phase 3, 3.1): without the
// one its read needs, its own paste cannot read the picture, so the app
// sends no key and the paste hint names the two programs.
//  - The program (src/main/providers/claude/linux-clipboard-tools.ts): under
//    X11 (no WAYLAND_DISPLAY, or an empty one) xclip: probe PL1 (run
//    46139776011, the Ubuntu runner under Xvfb) read Claude Code 2.1.332
//    attach with xclip and not with wl-paste alone. Under Wayland (not
//    measured) wl-paste, as the table says; xclip alone is missing there
//    (review round 1, N2).
//  - Where it is looked for (review round 1, F1): a local session runs on
//    the PATH its login shell builds, not the app's. Found in the app's PATH
//    or the system folders: not missing, and no login shell is asked.
//    Otherwise the login shell: a shell outside the sh family by the PATH it
//    builds, then the sh-family launcher's `command -v`, `-l -c`, and after
//    its plain "not found" once more as the launcher runs, an interactive
//    login shell, `-l -i -c` (review round 2, R2-F1: the launcher is `-l` in
//    the session's terminal, so .bashrc past its interactive guard and
//    .zshrc add to its PATH; Homebrew on Linux puts its line there). Found
//    only on the login shell's PATH: not missing. A plain "not found" from
//    both: missing. No answer from either (a timeout, a cut answer, a shell
//    that cannot start): not missing, so the key goes, as before the check.
//  - An alias or a function by the program's name (review round 3, R3-F1:
//    `alias xclip='xclip -selection clipboard'` is common in dotfiles) hides
//    the program from `command -v` but not from Claude Code, which runs it
//    by PATH: each question clears both first (`unalias`, `unset -f`), so
//    the program's path is read. A line that still names the program
//    without being its path (a definition that could not be cleared) is no
//    answer, so the key goes; a line a profile printed that does not name it
//    is not.
//  - The check as a press asks it: an answer that is not missing is kept for
//    the run; a missing one is asked again (the hint says to install, then
//    press Alt+V); callers asking together share one check.
//  - The question itself: a fixed command; its output whatever the exit
//    status; settles by its timeout plus a grace, the shell killed. `-l -c`
//    through execFile; `-l -i -c` in a session of its own (detached), so the
//    interactive shell finds no terminal to take for job control, its stdin
//    from nowhere, killed as its process group (never after it has ended,
//    never a group of 1 or less). The question to a login shell outside the
//    sh family goes the same way, with the launch's timeout (R2-N1).
//  - Never missing on Windows or macOS; Codex reads the clipboard itself.
//  - The paste module (row 8): the check is awaited. A press, the text chord
//    with a picture, and Snap into a Claude Code session on Linux with the
//    tool missing: no key to the door, and the hint naming xclip and
//    wl-paste (Snap's picture is still written: it stays on the clipboard,
//    plan Q1). The same session with a tool there: the key, as before.
//  - The hint's line: names both programs, no path, no em dash.
// Red on e89996bb: no such check; the key went and the session showed
// nothing. Red on a0b4b151: wl-paste alone under X11 read as installed (PL1).
// Red on ce65a7dc: only the app's PATH was searched, so xclip on the login
// shell's PATH alone read as missing; xclip alone under Wayland read as
// there; and the paste module did not await the check. Red on 77ace5dd: only
// a non-interactive `-l -c` was asked, so xclip on the PATH .bashrc or
// .zshrc builds read as missing; and the question to a shell outside the sh
// family had no kill after its SIGTERM. Red on 4fc2ca6a: an alias or a
// function named xclip made `command -v` print it, read as a plain "not
// found", so xclip from Homebrew on Linux with that alias in .bashrc got no
// key and the hint to install it (R3-F1). Mutants this must catch: the check
// skipped (the key sent anyway); the login shell's answer ignored; no answer
// read as missing; xclip taken under Wayland; the interactive question
// skipped, or asked without its own session, or its no answer read as
// missing; the group killed after the shell ended; the outside shell asked
// without the grace; the alias and function not cleared before `command -v`;
// a line naming the program but not its path read as a miss.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// No real process in this file: execFile and spawn throw unless a test
// gives the one call it expects (a question that cannot start: no answer).
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  const none = () => { throw new Error('no real process in this test') }
  return { ...real, execFile: vi.fn(none), spawn: vi.fn(none) }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/session-input', () => ({ pasteFromClipboard: vi.fn(), providerOfSession: () => null }))
vi.mock('../../../src/main/providers', () => ({ tryGetProvider: () => undefined }))

const paste = await import('../../../src/main/paste')
const claude = await import('../../../src/main/providers/claude/clipboard-paste')
const tools = await import('../../../src/main/providers/claude/linux-clipboard-tools')
const { CODEX_CLIPBOARD_PASTE } = await import('../../../src/main/providers/codex/clipboard-paste')
const { PASTE_NOTES, SNAP_RECTANGLE_SENTENCE } = await import('../../../src/shared/clipboard-paste')
const { LOGIN_SHELL_PATH_COMMAND, LOGIN_SHELL_PATH_TIMEOUT_MS } = await import('../../../src/main/login-shell')
const childProcess = await import('child_process')
import type { NativeImage } from 'electron'

const picture = () => ({ isEmpty: () => false, toPNG: () => Buffer.from([0x89, 0x50]) }) as unknown as NativeImage
const CTRL_V = '\u0016'
const END = '__CCC_CLIPBOARD_TOOL_END__'

type Env = Record<string, string | undefined>
const x11 = (path: string, extra: Env = {}): Env => ({ PATH: path, SHELL: '/bin/bash', ...extra })
const wayland = (path: string, extra: Env = {}): Env => ({ PATH: path, SHELL: '/bin/bash', WAYLAND_DISPLAY: 'wayland-0', ...extra })

/** Seams for one check: the files on this computer, what the sh-family
 *  launcher's `command -v` prints under `-l -c` (shAnswer) and under
 *  `-l -i -c` (shInteractive; by default the same: an interactive login
 *  shell reads what a login shell reads, and more), null for no answer, and
 *  the PATH a shell outside the sh family builds (null: none). Every
 *  question is recorded. */
function seams(o: { files?: string[]; shAnswer?: Record<string, string | null>; shInteractive?: Record<string, string | null>; ownPath?: string | null } = {}) {
  const files = o.files ?? []
  const asked: Array<{ shell: string; command: string; interactive: boolean }> = []
  const ownAsked: string[] = []
  return {
    asked,
    ownAsked,
    s: {
      runnable: (p: string) => files.includes(p),
      runnableAsync: async (p: string) => files.includes(p),
      ownShellPath: async (shell: string) => { ownAsked.push(shell); return o.ownPath ?? null },
      ask: async (shell: string, command: string, _env: unknown, interactive?: boolean) => {
        const i = interactive === true
        asked.push({ shell, command, interactive: i })
        const tool = /command -v (\S+);/.exec(command)?.[1] ?? ''
        const a = i && o.shInteractive && tool in o.shInteractive ? o.shInteractive[tool] : o.shAnswer?.[tool]
        return a === undefined ? `${END}\n` : a
      },
    },
  }
}

/** A child process as the own-session runner sees one: its output, its
 *  pid, and the signals sent to it by its own kill. */
function fakeChild(pid: number | undefined) {
  const stdout = Object.assign(new EventEmitter(), {
    destroyed: false,
    setEncoding: () => stdout,
    destroy: () => { stdout.destroyed = true; return stdout },
  })
  const kills: string[] = []
  const child = Object.assign(new EventEmitter(), { pid, stdout, kills, kill: (s?: string | number) => { kills.push(String(s)); return true } })
  return child
}

const XCLIP = tools.loginShellToolCommand('xclip')
const LINUXBREW = `/home/linuxbrew/.linuxbrew/bin/xclip\n${END}\n`

describe('which program Claude Code reads the clipboard with on Linux', () => {
  it('X11 (no WAYLAND_DISPLAY, or an empty one): xclip; Wayland: wl-paste (the table)', () => {
    expect(tools.claudeLinuxClipboardTool({})).toBe('xclip')
    expect(tools.claudeLinuxClipboardTool({ WAYLAND_DISPLAY: '' })).toBe('xclip')
    expect(tools.claudeLinuxClipboardTool({ WAYLAND_DISPLAY: 'wayland-0' })).toBe('wl-paste')
  })
})

describe('the login shell\'s answer, read', () => {
  it('found: an absolute path ending in the program, after any lines a profile printed', () => {
    expect(tools.readLoginShellToolAnswer('xclip', `/home/me/.local/bin/xclip\n${END}\n`)).toBe('found')
    expect(tools.readLoginShellToolAnswer('xclip', `welcome back\r\n/usr/bin/xclip\r\n${END}\r\n`)).toBe('found')
    expect(tools.readLoginShellToolAnswer('wl-paste', `/nix/var/nix/profiles/per-user/me/bin/wl-paste\n${END}\n`)).toBe('found')
  })

  it('a plain "not found": the marker and no such line (nothing, another program\'s path, or only what a profile printed)', () => {
    expect(tools.readLoginShellToolAnswer('xclip', `${END}\n`)).toBe('miss')
    expect(tools.readLoginShellToolAnswer('xclip', `/usr/bin/xclipboard\n${END}\n`)).toBe('miss')
    expect(tools.readLoginShellToolAnswer('xclip', `/usr/bin/wl-paste\n${END}\n`)).toBe('miss')
    // Ubuntu's /etc/bash.bashrc prints this on stdout in an interactive shell
    // for a user in the sudo group who has not used sudo yet: a line of the
    // profile's own, which says nothing of the program.
    expect(tools.readLoginShellToolAnswer('xclip', `To run a command as administrator (user "root"), use "sudo <command>".\nSee "man sudo_root" for details.\n\n${END}\n`)).toBe('miss')
    expect(tools.readLoginShellToolAnswer('wl-paste', `welcome back\r\n${END}\r\n`)).toBe('miss')
  })

  it('a line before the marker that names the program but is not its path (an alias or a function the question could not clear): no answer, so the key goes (R3-F1)', () => {
    expect(tools.readLoginShellToolAnswer('xclip', `alias xclip='xclip -selection clipboard'\n${END}\n`)).toBe('none')
    expect(tools.readLoginShellToolAnswer('xclip', `xclip\n${END}\n`)).toBe('none')
    expect(tools.readLoginShellToolAnswer('xclip', `welcome back\r\nxclip\r\n${END}\r\n`)).toBe('none')
    expect(tools.readLoginShellToolAnswer('wl-paste', `alias wl-paste='wl-paste --no-newline'\n${END}\n`)).toBe('none')
    expect(tools.readLoginShellToolAnswer('wl-paste', `wl-paste\n${END}\n`)).toBe('none')
    // Its path, when there too, is still found.
    expect(tools.readLoginShellToolAnswer('xclip', `xclip\n/usr/bin/xclip\n${END}\n`)).toBe('found')
  })

  it('no answer: no output, or the marker missing (cut short by a timeout or a profile that exits)', () => {
    expect(tools.readLoginShellToolAnswer('xclip', null)).toBe('none')
    expect(tools.readLoginShellToolAnswer('xclip', '')).toBe('none')
    expect(tools.readLoginShellToolAnswer('xclip', '/usr/bin/xclip\n')).toBe('none')
  })

  it('the command is fixed text for one of the two programs, never another word: any alias and function of that name cleared, then `command -v` (R3-F1)', () => {
    expect(tools.loginShellToolCommand('xclip')).toBe(`unalias xclip 2>/dev/null; unset -f xclip 2>/dev/null; command -v xclip; printf '%s\\n' ${END}`)
    expect(tools.loginShellToolCommand('wl-paste')).toBe(`unalias wl-paste 2>/dev/null; unset -f wl-paste 2>/dev/null; command -v wl-paste; printf '%s\\n' ${END}`)
    expect(() => tools.loginShellToolCommand('xclip; true' as never)).toThrow()
  })
})

describe('an alias or a function by the program\'s name hides it, not stands in for it (R3-F1)', () => {
  /** The launcher as a user's .bashrc or .zshrc makes it: xclip on the PATH
   *  Homebrew's shellenv line builds, and a definition of that name. Until
   *  the definition is cleared (`unalias xclip` for the alias, `unset -f
   *  xclip` for the function, ahead of `command -v`), `command -v` prints the
   *  definition; once cleared, the program's path. */
  const hidden = (answer: string, cleared: (command: string) => boolean) => {
    const asked: Array<{ command: string; interactive: boolean }> = []
    return {
      asked,
      s: {
        runnable: () => false,
        runnableAsync: async () => false,
        ask: async (_shell: string, command: string, _env: unknown, interactive?: boolean) => {
          asked.push({ command, interactive: interactive === true })
          return cleared(command) ? LINUXBREW : `${answer}\n${END}\n`
        },
      },
    }
  }
  const cases: Array<[string, string, (command: string) => boolean]> = [
    ['an alias', `alias xclip='xclip -selection clipboard'`, (c) => c.startsWith('unalias xclip')],
    ['a function', 'xclip', (c) => /unset -f xclip 2>\/dev\/null; command -v xclip;/.test(c)],
  ]

  for (const [what, answer, cleared] of cases) {
    it(`${what} named xclip in .bashrc or .zshrc over xclip from Homebrew on Linux: found, so not missing and the key goes`, async () => {
      for (const shell of ['/bin/bash', '/usr/bin/zsh', '/bin/sh']) {
        const env = x11('/usr/bin:/bin', { SHELL: shell })
        const t = hidden(answer, cleared)
        expect(await tools.claudeClipboardToolMissing('linux', env, t.s), `${shell}: not missing`).toBe(false)
        const u = hidden(answer, cleared)
        expect(await tools.loginShellToolAnswer('xclip', env, 'linux', u.s), `${shell}: the program found, not only no answer`).toBe('found')
        expect(u.asked, `${shell}: found by \`-l -c\`, nothing more asked`).toEqual([{ command: XCLIP, interactive: false }])
      }
    })
  }

  it('a definition the question could not clear (a readonly function): no answer, so not missing; nothing more asked', async () => {
    for (const answer of [`alias xclip='xclip -selection clipboard'`, 'xclip']) {
      const t = hidden(answer, () => false)
      expect(await tools.claudeClipboardToolMissing('linux', x11('/usr/bin:/bin'), t.s), answer).toBe(false)
      expect(await tools.loginShellToolAnswer('xclip', x11('/usr/bin:/bin'), 'linux', hidden(answer, () => false).s), answer).toBe('none')
      expect(t.asked.map((a) => a.interactive), answer).toEqual([false])
    }
  })
})

describe('is the program there? (F1: the PATH the session runs on)', () => {
  it('xclip only on the login shell\'s PATH (~/.local/bin, which the app\'s PATH lacks): not missing', async () => {
    const t = seams({ shAnswer: { xclip: `/home/me/.local/bin/xclip\n${END}\n` } })
    expect(await tools.claudeClipboardToolMissing('linux', x11('/usr/bin:/bin'), t.s)).toBe(false)
    expect(t.asked).toEqual([{ shell: '/bin/bash', command: XCLIP, interactive: false }])
  })

  it('a plain "not found" from `-l -c` and from `-l -i -c`, and none in the app\'s PATH or the system folders: missing', async () => {
    const t = seams()
    expect(await tools.claudeClipboardToolMissing('linux', x11('/home/me/bin:/usr/bin'), t.s)).toBe(true)
    expect(t.asked).toEqual([
      { shell: '/bin/bash', command: XCLIP, interactive: false },
      { shell: '/bin/bash', command: XCLIP, interactive: true },
    ])
  })

  it('on the PATH only the launcher as it runs builds (.bashrc past its interactive guard, .zshrc; Homebrew on Linux): not missing (R2-F1)', async () => {
    for (const shell of ['/bin/bash', '/usr/bin/zsh']) {
      const t = seams({ shInteractive: { xclip: LINUXBREW } })
      expect(await tools.claudeClipboardToolMissing('linux', x11('/usr/bin:/bin', { SHELL: shell }), t.s), shell).toBe(false)
      expect(t.asked, shell).toEqual([
        { shell, command: XCLIP, interactive: false },
        { shell, command: XCLIP, interactive: true },
      ])
    }
  })

  it('the interactive login shell is asked only after a plain "not found": found by `-l -c`, or no answer from it, asks nothing more', async () => {
    for (const answer of [`/home/me/.local/bin/xclip\n${END}\n`, null, '/usr/bin/xc']) {
      const t = seams({ shAnswer: { xclip: answer }, shInteractive: { xclip: `${END}\n` } })
      expect(await tools.claudeClipboardToolMissing('linux', x11('/usr/bin'), t.s), String(answer)).toBe(false)
      expect(t.asked.map((a) => a.interactive), String(answer)).toEqual([false])
    }
  })

  it('no answer from the login shell: not missing (the key goes, as before the check)', async () => {
    expect(await tools.claudeClipboardToolMissing('linux', x11('/usr/bin'), seams({ shAnswer: { xclip: null } }).s)).toBe(false)
    expect(await tools.claudeClipboardToolMissing('linux', x11('/usr/bin'), seams({ shAnswer: { xclip: '/usr/bin/xc' } }).s), 'cut short').toBe(false)
    for (const answer of [null, '/home/linuxbrew/.linuxbrew/bin/xc']) {
      const t = seams({ shInteractive: { xclip: answer } })
      expect(await tools.claudeClipboardToolMissing('linux', x11('/usr/bin'), t.s), `a plain miss, then ${String(answer)}`).toBe(false)
      expect(t.asked.map((a) => a.interactive)).toEqual([false, true])
    }
  })

  it('found in the app\'s PATH or a system folder: not missing, and no login shell is asked', async () => {
    const cases: Array<[Env, string]> = [[x11('/home/me/bin'), '/home/me/bin/xclip'], [x11(''), '/usr/bin/xclip'], [x11('relative/bin'), '/bin/xclip']]
    for (const [env, file] of cases) {
      const t = seams({ files: [file] })
      expect(await tools.claudeClipboardToolMissing('linux', env, t.s), file).toBe(false)
      expect(t.asked).toEqual([])
    }
  })

  it('a relative PATH folder is never searched here, and a near name is not the program', async () => {
    expect(await tools.claudeClipboardToolMissing('linux', x11('bin:./tools'), seams({ files: ['bin/xclip', 'tools/xclip', './tools/xclip'] }).s)).toBe(true)
    expect(await tools.claudeClipboardToolMissing('linux', x11(''), seams({ files: ['/usr/bin/xclipboard', '/opt/xclip'] }).s)).toBe(true)
  })

  it('X11 with wl-paste alone, here or on the login shell\'s PATH: missing (PL1)', async () => {
    expect(await tools.claudeClipboardToolMissing('linux', x11('/home/me/bin'), seams({ files: ['/home/me/bin/wl-paste', '/usr/bin/wl-paste'] }).s)).toBe(true)
    const t = seams({ shAnswer: { 'wl-paste': `/home/me/.local/bin/wl-paste\n${END}\n` } })
    expect(await tools.claudeClipboardToolMissing('linux', x11(''), t.s)).toBe(true)
    expect(t.asked.map((a) => a.command)).toEqual([XCLIP, XCLIP])
  })

  it('Wayland (not measured): wl-paste, as the table says; xclip alone is missing (N2)', async () => {
    expect(await tools.claudeClipboardToolMissing('linux', wayland('/home/me/bin'), seams({ files: ['/home/me/bin/wl-paste'] }).s)).toBe(false)
    expect(await tools.claudeClipboardToolMissing('linux', wayland(''), seams({ files: ['/usr/bin/xclip'] }).s)).toBe(true)
    expect(await tools.claudeClipboardToolMissing('linux', wayland(''), seams({ shAnswer: { xclip: `/usr/bin/xclip\n${END}\n` } }).s)).toBe(true)
    expect(await tools.claudeClipboardToolMissing('linux', wayland(''), seams({ shAnswer: { 'wl-paste': `/home/me/.nix-profile/bin/wl-paste\n${END}\n` } }).s)).toBe(false)
    const t = seams({ shInteractive: { 'wl-paste': `/home/linuxbrew/.linuxbrew/bin/wl-paste\n${END}\n` } })
    expect(await tools.claudeClipboardToolMissing('linux', wayland(''), t.s), 'wl-paste on the interactive PATH only').toBe(false)
    expect(t.asked.map((a) => [a.command, a.interactive])).toEqual([[tools.loginShellToolCommand('wl-paste'), false], [tools.loginShellToolCommand('wl-paste'), true]])
  })

  it('a login shell outside the sh family: the PATH it builds first; then the sh-family launcher', async () => {
    const fish = (path: string) => x11(path, { SHELL: '/usr/bin/fish' })
    const there = seams({ ownPath: '/home/me/.local/bin:/usr/bin', files: ['/home/me/.local/bin/xclip'] })
    expect(await tools.claudeClipboardToolMissing('linux', fish('/usr/bin'), there.s)).toBe(false)
    expect(there.ownAsked).toEqual(['/usr/bin/fish'])
    expect(there.asked, 'found in its PATH: the launcher is not asked').toEqual([])
    for (const ownPath of ['/usr/bin', null]) {
      const t = seams({ ownPath, shAnswer: { xclip: `/home/me/bin/xclip\n${END}\n` } })
      expect(await tools.claudeClipboardToolMissing('linux', fish('/usr/bin'), t.s), String(ownPath)).toBe(false)
      expect(t.asked.map((a) => a.shell), 'the sh-family launcher, $SHELL set aside').toEqual([expect.stringMatching(/^\/bin\/(bash|zsh|sh)$/)])
    }
    expect(await tools.claudeClipboardToolMissing('linux', fish('/usr/bin'), seams({ ownPath: '/usr/bin' }).s), 'neither has it').toBe(true)
  })

  it('never missing on Windows or macOS (PowerShell and osascript come with the system), and nothing asked', async () => {
    for (const os of ['win32', 'darwin'] as const) {
      const t = seams()
      expect(await tools.claudeClipboardToolMissing(os, x11(''), t.s), os).toBe(false)
      expect(t.asked).toEqual([])
    }
  })
})

describe('the check as a press asks it', () => {
  it('an answer that is not missing is kept for the run; nothing asked again', async () => {
    const t = seams({ shAnswer: { xclip: `/home/me/.local/bin/xclip\n${END}\n` } })
    const check = tools.createClaudeClipboardToolCheck(() => x11('/usr/bin'), t.s)
    expect(await check('linux')).toBe(false)
    expect(await check('linux')).toBe(false)
    expect(t.asked).toHaveLength(1)
  })

  it('a missing answer is asked again, so a program installed after the hint is found', async () => {
    const answer: Record<string, string | null> = {}
    const t = seams({ shAnswer: answer })
    const check = tools.createClaudeClipboardToolCheck(() => x11('/usr/bin'), t.s)
    expect(await check('linux')).toBe(true)
    expect(await check('linux')).toBe(true)
    answer.xclip = `/home/me/.local/bin/xclip\n${END}\n`
    expect(await check('linux')).toBe(false)
    expect(t.asked.map((a) => a.interactive), 'two questions for each miss, one for the find').toEqual([false, true, false, true, false])
  })

  it('callers asking together share one check; another OS asks nothing', async () => {
    const t = seams()
    const check = tools.createClaudeClipboardToolCheck(() => x11('/usr/bin'), t.s)
    expect(await Promise.all([check('linux'), check('linux'), check('linux')])).toEqual([true, true, true])
    expect(t.asked).toHaveLength(2)
    expect(await check('darwin')).toBe(false)
    expect(t.asked).toHaveLength(2)
  })
})

describe('one question to the login shell', () => {
  type Cb = (err: Error | null, stdout: string) => void
  it('`-l -c` and the fixed command, with the environment given; its output whatever the exit status', async () => {
    const calls: Array<{ file: string; args: string[]; opts: { cwd: string; env: unknown; timeout: number } }> = []
    const env = { PATH: '/usr/bin' }
    const out = await tools.askLoginShell('/bin/bash', XCLIP, env, { exec: (file, args, opts, cb: Cb) => {
      calls.push({ file, args, opts })
      cb(new Error('exit 1'), `${END}\n`)
      return { kill: () => true }
    } })
    expect(out).toBe(`${END}\n`)
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/bin/bash')
    expect(calls[0].args).toEqual(['-l', '-c', XCLIP])
    expect(calls[0].opts.env).toBe(env)
    expect(calls[0].opts.timeout).toBe(tools.LOGIN_SHELL_TOOL_TIMEOUT_MS)
  })

  it('interactive: `-l -i -c` and the same fixed command, as the launcher runs (R2-F1)', async () => {
    const calls: string[][] = []
    await tools.askLoginShell('/bin/bash', XCLIP, {}, { interactive: true, exec: (_file, args, _opts, cb: Cb) => { calls.push(args); cb(null, LINUXBREW); return { kill: () => true } } })
    expect(calls).toEqual([['-l', '-i', '-c', XCLIP]])
  })

  it('a shell that cannot start: no answer', async () => {
    expect(await tools.askLoginShell('/bin/bash', 'x', {}, { exec: () => { throw new Error('ENOENT') } })).toBeNull()
    expect(await tools.askLoginShell('/bin/bash', 'x', {}, { interactive: true, exec: () => { throw new Error('ENOENT') } })).toBeNull()
  })

  it('a shell that never answers: settles by its timeout plus the grace, and is killed', async () => {
    vi.useFakeTimers()
    try {
      const kills: string[] = []
      const p = tools.askLoginShell('/bin/bash', 'x', {}, { exec: () => ({ kill: (s?: NodeJS.Signals | number) => { kills.push(String(s)); return true } }), timeoutMs: 100 })
      let settled: string | null | undefined
      void p.then((v) => { settled = v })
      await vi.advanceTimersByTimeAsync(100)
      expect(settled).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1000)
      expect(settled).toBeNull()
      expect(kills).toEqual(['SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the runner each question goes through (R2-F1, R2-N1)', () => {
  type Cb = (err: Error | null, stdout: string) => void
  const execFileMock = vi.mocked(childProcess.execFile)
  const spawnMock = vi.mocked(childProcess.spawn)
  beforeEach(() => { execFileMock.mockClear(); spawnMock.mockClear() })

  it('`-l -c` through execFile; `-l -i -c` in a session of its own (spawn, detached), stdin from nowhere, never execFile', async () => {
    execFileMock.mockImplementationOnce(((_f: string, _a: string[], _o: unknown, cb: Cb) => { cb(null, `${END}\n`); return { kill: () => true } }) as never)
    expect(await tools.askLoginShell('/bin/bash', XCLIP, { PATH: '/usr/bin' })).toBe(`${END}\n`)
    expect(spawnMock).not.toHaveBeenCalled()
    const child = fakeChild(4242)
    spawnMock.mockImplementationOnce((() => child) as never)
    const env = { PATH: '/usr/bin' }
    const p = tools.askLoginShell('/bin/bash', XCLIP, env, { interactive: true })
    child.stdout.emit('data', '/home/linuxbrew/.linuxbrew/bin/xclip\n')
    child.stdout.emit('data', `${END}\n`)
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    expect(await p).toBe(LINUXBREW)
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [file, args, opts] = spawnMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
    expect(file).toBe('/bin/bash')
    expect(args).toEqual(['-l', '-i', '-c', XCLIP])
    expect(opts).toMatchObject({ detached: true, stdio: ['ignore', 'pipe', 'ignore'], env, windowsHide: true })
  })

  it('the check itself asks the interactive question in its own session after a plain "not found" (Homebrew on Linux: not missing)', async () => {
    execFileMock.mockImplementationOnce(((_f: string, _a: string[], _o: unknown, cb: Cb) => { cb(null, `${END}\n`); return { kill: () => true } }) as never)
    const child = fakeChild(4243)
    spawnMock.mockImplementationOnce((() => { queueMicrotask(() => { child.stdout.emit('data', LINUXBREW); child.emit('exit', 0, null); child.emit('close', 0, null) }); return child }) as never)
    expect(await tools.claudeClipboardToolMissing('linux', x11('/usr/bin'), { runnable: () => false })).toBe(false)
    expect(execFileMock.mock.calls.map((c) => c[1])).toEqual([['-l', '-c', XCLIP]])
    expect(spawnMock.mock.calls.map((c) => [c[1], (c[2] as { detached?: boolean }).detached])).toEqual([[['-l', '-i', '-c', XCLIP], true]])
  })

  it('a login shell outside the sh family: the same question, the launch\'s timeout, the grace, then killed, so a press always settles (R2-N1)', async () => {
    vi.useFakeTimers()
    try {
      const kills: string[] = []
      const calls: Array<{ file: string; args: string[]; timeout: number }> = []
      execFileMock.mockImplementationOnce(((file: string, args: string[], opts: { timeout: number }) => {
        calls.push({ file, args, timeout: opts.timeout })
        return { kill: (s?: string) => { kills.push(String(s)); return true } }
      }) as never)
      const asked: boolean[] = []
      let settled: boolean | undefined
      const p = tools.claudeClipboardToolMissing('linux', x11('/usr/bin', { SHELL: '/usr/bin/fish' }), {
        runnable: () => false,
        runnableAsync: async () => false,
        ask: async (_s, _c, _e, interactive) => { asked.push(interactive === true); return `${END}\n` },
      })
      void p.then((v) => { settled = v })
      await vi.advanceTimersByTimeAsync(LOGIN_SHELL_PATH_TIMEOUT_MS)
      expect(settled, 'still waiting for its answer').toBeUndefined()
      expect(kills).toEqual([])
      await vi.advanceTimersByTimeAsync(1000)
      expect(kills).toEqual(['SIGKILL'])
      vi.useRealTimers()
      expect(await p, 'no PATH from it; both sh-family questions a plain miss').toBe(true)
      expect(calls).toEqual([{ file: '/usr/bin/fish', args: ['-l', '-c', LOGIN_SHELL_PATH_COMMAND], timeout: LOGIN_SHELL_PATH_TIMEOUT_MS }])
      expect(asked).toEqual([false, true])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a login shell outside the sh family: the PATH between its markers is searched, whatever printed around it', async () => {
    execFileMock.mockImplementationOnce(((_f: string, _a: string[], _o: unknown, cb: Cb) => {
      cb(null, 'hello\n__CCC_LOGIN_PATH_BEGIN__/home/me/.local/bin:rel:/usr/bin__CCC_LOGIN_PATH_END__bye')
      return { kill: () => true }
    }) as never)
    const searched: string[] = []
    const t = seams()
    expect(await tools.claudeClipboardToolMissing('linux', x11('/usr/bin', { SHELL: '/usr/bin/fish' }), {
      runnable: () => false,
      runnableAsync: async (f) => { searched.push(f); return f === '/home/me/.local/bin/xclip' },
      ask: t.s.ask,
    })).toBe(false)
    expect(searched).toEqual(['/home/me/.local/bin/xclip'])
    expect(t.asked, 'found in its PATH: the launcher is not asked').toEqual([])
  })
})

describe('the own-session runner (the interactive question)', () => {
  type Cb = (err: Error | null, stdout: string) => void
  const opts = { cwd: '/home/me', env: { PATH: '/usr/bin' }, encoding: 'utf8' as const, timeout: 100, windowsHide: true }
  const runner = (pid: number | undefined) => {
    const child = fakeChild(pid)
    const groups: Array<[number, string]> = []
    const spawned: Array<[string, string[], Record<string, unknown>]> = []
    const results: Array<[Error | null, string]> = []
    const deps = {
      spawn: (file: string, args: string[], o: Record<string, unknown>) => { spawned.push([file, args, o]); return child as never },
      killGroup: (pgid: number, signal: NodeJS.Signals) => { groups.push([pgid, signal]) },
    }
    const handle = tools.execInOwnSession('/bin/bash', ['-l', '-i', '-c', XCLIP], opts, ((err, out) => { results.push([err, out]) }) as Cb, deps as never)
    return { child, groups, spawned, results, handle }
  }

  it('started detached, stdin from nowhere, its output kept to the end', () => {
    const r = runner(4300)
    expect(r.spawned).toEqual([['/bin/bash', ['-l', '-i', '-c', XCLIP], { cwd: '/home/me', env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }]])
    r.child.stdout.emit('data', 'a\n')
    r.child.stdout.emit('data', `${END}\n`)
    r.child.emit('exit', 0, null)
    r.child.emit('close', 0, null)
    expect(r.results).toEqual([[null, `a\n${END}\n`]])
  })

  it('its timeout: the output closed and SIGTERM to its process group; the answer so far, with an error', () => {
    vi.useFakeTimers()
    try {
      const r = runner(4301)
      r.child.stdout.emit('data', 'partial')
      vi.advanceTimersByTime(100)
      expect(r.child.stdout.destroyed).toBe(true)
      expect(r.groups).toEqual([[4301, 'SIGTERM']])
      r.child.emit('exit', null, 'SIGTERM')
      r.child.emit('close', null, 'SIGTERM')
      expect(r.results).toHaveLength(1)
      expect(r.results[0][0]).toBeInstanceOf(Error)
      expect(r.results[0][1]).toBe('partial')
    } finally {
      vi.useRealTimers()
    }
  })

  it('the kill the question holds: SIGKILL to the group while the shell runs; nothing to the group once it has ended (its pid may be another\'s)', () => {
    const r = runner(4302)
    r.handle?.kill('SIGKILL')
    expect(r.groups).toEqual([[4302, 'SIGKILL']])
    r.child.emit('exit', 0, null)
    r.handle?.kill('SIGKILL')
    expect(r.groups).toHaveLength(1)
    expect(r.child.kills).toEqual([])
  })

  it('never a group of 1 or less, nor one with no pid: the child itself is signalled', () => {
    for (const pid of [undefined, 0, 1, -5]) {
      const r = runner(pid)
      r.handle?.kill('SIGKILL')
      expect(r.groups, String(pid)).toEqual([])
      expect(r.child.kills, String(pid)).toEqual(['SIGKILL'])
    }
  })

  it('a shell that could not start: the error, once', () => {
    const r = runner(undefined)
    r.child.emit('error', new Error('ENOENT'))
    r.child.emit('close', -2, null)
    expect(r.results).toHaveLength(1)
    expect(r.results[0][0]?.message).toBe('ENOENT')
  })

  it('output past the bound: kept to the bound, and the shell stopped', () => {
    const r = runner(4303)
    r.child.stdout.emit('data', 'x'.repeat(tools.LOGIN_SHELL_TOOL_MAX_OUTPUT + 10))
    expect(r.groups).toEqual([[4303, 'SIGTERM']])
    r.child.emit('exit', null, 'SIGTERM')
    r.child.emit('close', null, 'SIGTERM')
    expect(r.results[0][1]).toHaveLength(tools.LOGIN_SHELL_TOOL_MAX_OUTPUT)
  })
})

describe('the provider rules', () => {
  it('Claude Code\'s rule asks the check (never missing on Windows or macOS); Codex\'s has no such program to miss', async () => {
    expect(typeof claude.CLAUDE_CLIPBOARD_PASTE.clipboardToolMissing).toBe('function')
    expect(await claude.CLAUDE_CLIPBOARD_PASTE.clipboardToolMissing!('win32')).toBe(false)
    expect(await claude.CLAUDE_CLIPBOARD_PASTE.clipboardToolMissing!('darwin')).toBe(false)
    expect((await CODEX_CLIPBOARD_PASTE.clipboardToolMissing?.('linux')) ?? false).toBe(false)
  })
})

describe('the paste module, a Claude Code session on Linux', () => {
  let missing: boolean
  let door: Array<{ key: string; sentence: string | null }>
  let written: number
  const snaps = new Map<string, { file: string; picture: NativeImage }>()

  beforeEach(() => {
    paste._resetPasteForTest()
    missing = true
    door = []
    written = 0
    snaps.clear()
    paste.setPasteDeps({
      platform: 'linux',
      where: () => 'local',
      provider: () => 'claude',
      // Asynchronous, as the package's own check is.
      rule: () => ({ ...claude.CLAUDE_CLIPBOARD_PASTE, key: () => ({ bytes: CTRL_V, chord: 'ctrl+v', from: 'default' }), clipboardToolMissing: async (p: NodeJS.Platform) => p === 'linux' && missing }),
      accountDir: () => null,
      readPicture: async () => picture(),
      readFiles: async () => [],
      fileSize: () => null,
      decodeFile: () => null,
      write: async () => { written++; return 'written' },
      savePicture: async () => ({ error: 'no-image' }),
      door: async (_s: string, key: string, sentence: string | null) => { door.push({ key, sentence }); return { outcome: 'sent' } as never },
      pathRoute: () => false,
      takeSnap: (token: string) => { const k = snaps.get(token) ?? null; snaps.delete(token); return k },
    } as never)
  })

  const NOTE = { outcome: 'not-pasted', reason: 'no-clipboard-tool', note: PASTE_NOTES['no-clipboard-tool'] }

  it('the tool missing: Alt+V in and out of the terminal, and Ctrl+V with a picture, send no key and name the programs', async () => {
    expect(await paste.pasteImageKey({ sessionId: 's1', chord: 'image', focused: false })).toEqual(NOTE)
    expect(await paste.pasteImageKey({ sessionId: 's1', chord: 'image', focused: true })).toEqual(NOTE)
    expect(await paste.pasteImageKey({ sessionId: 's1', chord: 'text', focused: true })).toEqual(NOTE)
    expect(door).toEqual([])
  })

  it('Snap with the tool missing: the picture written (it stays on the clipboard), no key, the same hint', async () => {
    expect(await paste.pasteSnapPicture('s1', picture(), '/res/screenshots/s.jpg', SNAP_RECTANGLE_SENTENCE)).toEqual(NOTE)
    expect(written).toBe(1)
    expect(door).toEqual([])
  })

  it('a tool there (the check answers false, asynchronously): the key goes, as before', async () => {
    missing = false
    expect(await paste.pasteImageKey({ sessionId: 's1', chord: 'image', focused: true })).toEqual({ outcome: 'sent' })
    expect(door).toEqual([{ key: CTRL_V, sentence: null }])
  })

  it('the hint names xclip and wl-paste, and no path or em dash', () => {
    const line = PASTE_NOTES['no-clipboard-tool']
    expect(line).toMatch(/\bxclip\b/)
    expect(line).toMatch(/\bwl-paste\b/)
    expect(line).not.toMatch(/[\\/]/)
    expect(line).not.toContain('—')
  })
})
