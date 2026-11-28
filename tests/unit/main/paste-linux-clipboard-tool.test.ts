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
//    builds, then the sh-family launcher's `command -v`. Found only on the
//    login shell's PATH: not missing. Its plain "not found": missing. No
//    answer (a timeout, a cut answer, a shell that cannot start): not
//    missing, so the key goes, as before the check.
//  - The check as a press asks it: an answer that is not missing is kept for
//    the run; a missing one is asked again (the hint says to install, then
//    press Alt+V); callers asking together share one question.
//  - The question itself: one login shell, `-l -c`, a fixed command; its
//    output whatever the exit status; settles by its timeout plus a grace,
//    the shell killed.
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
// there; and the paste module did not await the check. Mutants this must
// catch: the check skipped (the key sent anyway); the login shell's answer
// ignored; no answer read as missing; xclip taken under Wayland.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/session-input', () => ({ pasteFromClipboard: vi.fn(), providerOfSession: () => null }))
vi.mock('../../../src/main/providers', () => ({ tryGetProvider: () => undefined }))

const paste = await import('../../../src/main/paste')
const claude = await import('../../../src/main/providers/claude/clipboard-paste')
const tools = await import('../../../src/main/providers/claude/linux-clipboard-tools')
const { CODEX_CLIPBOARD_PASTE } = await import('../../../src/main/providers/codex/clipboard-paste')
const { PASTE_NOTES, SNAP_RECTANGLE_SENTENCE } = await import('../../../src/shared/clipboard-paste')
import type { NativeImage } from 'electron'

const picture = () => ({ isEmpty: () => false, toPNG: () => Buffer.from([0x89, 0x50]) }) as unknown as NativeImage
const CTRL_V = '\u0016'
const END = '__CCC_CLIPBOARD_TOOL_END__'

type Env = Record<string, string | undefined>
const x11 = (path: string, extra: Env = {}): Env => ({ PATH: path, SHELL: '/bin/bash', ...extra })
const wayland = (path: string, extra: Env = {}): Env => ({ PATH: path, SHELL: '/bin/bash', WAYLAND_DISPLAY: 'wayland-0', ...extra })

/** Seams for one check: the files on this computer, what the sh-family
 *  launcher's `command -v` prints (null: no answer), and the PATH a shell
 *  outside the sh family builds (null: none). Every question is recorded. */
function seams(o: { files?: string[]; shAnswer?: Record<string, string | null>; ownPath?: string | null } = {}) {
  const files = o.files ?? []
  const asked: Array<{ shell: string; command: string }> = []
  const ownAsked: string[] = []
  return {
    asked,
    ownAsked,
    s: {
      runnable: (p: string) => files.includes(p),
      runnableAsync: async (p: string) => files.includes(p),
      ownShellPath: async (shell: string) => { ownAsked.push(shell); return o.ownPath ?? null },
      ask: async (shell: string, command: string) => {
        asked.push({ shell, command })
        const tool = /command -v (\S+);/.exec(command)?.[1] ?? ''
        const a = o.shAnswer?.[tool]
        return a === undefined ? `${END}\n` : a
      },
    },
  }
}

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

  it('a plain "not found": the marker and no such line (nothing, another program, an alias or a function by name)', () => {
    expect(tools.readLoginShellToolAnswer('xclip', `${END}\n`)).toBe('miss')
    expect(tools.readLoginShellToolAnswer('xclip', `/usr/bin/xclipboard\n${END}\n`)).toBe('miss')
    expect(tools.readLoginShellToolAnswer('xclip', `xclip\n${END}\n`)).toBe('miss')
    expect(tools.readLoginShellToolAnswer('xclip', `alias xclip='true'\n${END}\n`)).toBe('miss')
    expect(tools.readLoginShellToolAnswer('xclip', `/usr/bin/wl-paste\n${END}\n`)).toBe('miss')
  })

  it('no answer: no output, or the marker missing (cut short by a timeout or a profile that exits)', () => {
    expect(tools.readLoginShellToolAnswer('xclip', null)).toBe('none')
    expect(tools.readLoginShellToolAnswer('xclip', '')).toBe('none')
    expect(tools.readLoginShellToolAnswer('xclip', '/usr/bin/xclip\n')).toBe('none')
  })

  it('the command is fixed text for one of the two programs, never another word', () => {
    expect(tools.loginShellToolCommand('xclip')).toBe(`command -v xclip; printf '%s\\n' ${END}`)
    expect(tools.loginShellToolCommand('wl-paste')).toBe(`command -v wl-paste; printf '%s\\n' ${END}`)
    expect(() => tools.loginShellToolCommand('xclip; true' as never)).toThrow()
  })
})

describe('is the program there? (F1: the PATH the session runs on)', () => {
  it('xclip only on the login shell\'s PATH (~/.local/bin, which the app\'s PATH lacks): not missing', async () => {
    const t = seams({ shAnswer: { xclip: `/home/me/.local/bin/xclip\n${END}\n` } })
    expect(await tools.claudeClipboardToolMissing('linux', x11('/usr/bin:/bin'), t.s)).toBe(false)
    expect(t.asked).toEqual([{ shell: '/bin/bash', command: tools.loginShellToolCommand('xclip') }])
  })

  it('the login shell\'s plain "not found", and none in the app\'s PATH or the system folders: missing', async () => {
    const t = seams()
    expect(await tools.claudeClipboardToolMissing('linux', x11('/home/me/bin:/usr/bin'), t.s)).toBe(true)
    expect(t.asked).toHaveLength(1)
  })

  it('no answer from the login shell: not missing (the key goes, as before the check)', async () => {
    expect(await tools.claudeClipboardToolMissing('linux', x11('/usr/bin'), seams({ shAnswer: { xclip: null } }).s)).toBe(false)
    expect(await tools.claudeClipboardToolMissing('linux', x11('/usr/bin'), seams({ shAnswer: { xclip: '/usr/bin/xc' } }).s), 'cut short').toBe(false)
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
    expect(t.asked.map((a) => a.command)).toEqual([tools.loginShellToolCommand('xclip')])
  })

  it('Wayland (not measured): wl-paste, as the table says; xclip alone is missing (N2)', async () => {
    expect(await tools.claudeClipboardToolMissing('linux', wayland('/home/me/bin'), seams({ files: ['/home/me/bin/wl-paste'] }).s)).toBe(false)
    expect(await tools.claudeClipboardToolMissing('linux', wayland(''), seams({ files: ['/usr/bin/xclip'] }).s)).toBe(true)
    expect(await tools.claudeClipboardToolMissing('linux', wayland(''), seams({ shAnswer: { xclip: `/usr/bin/xclip\n${END}\n` } }).s)).toBe(true)
    expect(await tools.claudeClipboardToolMissing('linux', wayland(''), seams({ shAnswer: { 'wl-paste': `/home/me/.nix-profile/bin/wl-paste\n${END}\n` } }).s)).toBe(false)
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
    expect(t.asked).toHaveLength(3)
  })

  it('callers asking together share one question; another OS asks nothing', async () => {
    const t = seams()
    const check = tools.createClaudeClipboardToolCheck(() => x11('/usr/bin'), t.s)
    expect(await Promise.all([check('linux'), check('linux'), check('linux')])).toEqual([true, true, true])
    expect(t.asked).toHaveLength(1)
    expect(await check('darwin')).toBe(false)
    expect(t.asked).toHaveLength(1)
  })
})

describe('one question to the login shell', () => {
  type Cb = (err: Error | null, stdout: string) => void
  it('`-l -c` and the fixed command, with the environment given; its output whatever the exit status', async () => {
    const calls: Array<{ file: string; args: string[]; opts: { cwd: string; env: unknown; timeout: number } }> = []
    const env = { PATH: '/usr/bin' }
    const out = await tools.askLoginShell('/bin/bash', tools.loginShellToolCommand('xclip'), env, (file, args, opts, cb: Cb) => {
      calls.push({ file, args, opts })
      cb(new Error('exit 1'), `${END}\n`)
      return { kill: () => true }
    })
    expect(out).toBe(`${END}\n`)
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/bin/bash')
    expect(calls[0].args).toEqual(['-l', '-c', tools.loginShellToolCommand('xclip')])
    expect(calls[0].opts.env).toBe(env)
    expect(calls[0].opts.timeout).toBe(tools.LOGIN_SHELL_TOOL_TIMEOUT_MS)
  })

  it('a shell that cannot start: no answer', async () => {
    expect(await tools.askLoginShell('/bin/bash', 'x', {}, () => { throw new Error('ENOENT') })).toBeNull()
  })

  it('a shell that never answers: settles by its timeout plus the grace, and is killed', async () => {
    vi.useFakeTimers()
    try {
      const kills: string[] = []
      const p = tools.askLoginShell('/bin/bash', 'x', {}, () => ({ kill: (s?: NodeJS.Signals | number) => { kills.push(String(s)); return true } }), 100)
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
