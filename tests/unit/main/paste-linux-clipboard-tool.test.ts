// Claude Code on a Linux app machine reads the clipboard by running xclip or
// wl-paste (ADR-032's table; plan 2.1.3-beta.21 phase 3, 3.1): with neither
// installed its own paste cannot read the picture, so the app sends no key
// and the paste hint names the two programs.
//  - The Claude package (row 14): neither xclip nor wl-paste in PATH's
//    folders or the system's (/usr/local/bin, /usr/bin, /bin) on Linux: the
//    tool is missing; either one there: not missing. Never missing on
//    Windows or macOS. Codex reads the clipboard itself (arboard): never.
//  - The paste module (row 8): a press, the text chord with a picture, and
//    Snap into a Claude Code session on Linux with the tool missing: no key
//    to the door, and the hint naming xclip and wl-paste (Snap's picture is
//    still written: it stays on the clipboard, plan Q1). The same session
//    with a tool there: the key, as before.
//  - The hint's line: names both programs, no path, no em dash.
// Red on e89996bb: no such check; the key went and the session showed
// nothing. Mutant this must catch: the check skipped (the key sent anyway).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/session-input', () => ({ pasteFromClipboard: vi.fn(), providerOfSession: () => null }))
vi.mock('../../../src/main/providers', () => ({ tryGetProvider: () => undefined }))

const paste = await import('../../../src/main/paste')
const claude = await import('../../../src/main/providers/claude/clipboard-paste')
const { CODEX_CLIPBOARD_PASTE } = await import('../../../src/main/providers/codex/clipboard-paste')
const { PASTE_NOTES, SNAP_RECTANGLE_SENTENCE } = await import('../../../src/shared/clipboard-paste')
import type { NativeImage } from 'electron'

const picture = () => ({ isEmpty: () => false, toPNG: () => Buffer.from([0x89, 0x50]) }) as unknown as NativeImage
const CTRL_V = '\u0016'

describe('the Claude package: is the program Claude Code reads the clipboard with there?', () => {
  const on = (files: string[]) => (p: string) => files.includes(p)

  it('Linux, neither xclip nor wl-paste in PATH or the system folders: missing', () => {
    expect(claude.claudeClipboardToolMissing('linux', '/home/me/.local/bin:/usr/bin', on([]))).toBe(true)
    expect(claude.claudeClipboardToolMissing('linux', '', on(['/usr/bin/xclipboard', '/opt/xclip']))).toBe(true)
  })

  it('Linux, either one: not missing, in a PATH folder or a system folder', () => {
    expect(claude.claudeClipboardToolMissing('linux', '/home/me/bin', on(['/home/me/bin/xclip']))).toBe(false)
    expect(claude.claudeClipboardToolMissing('linux', '/home/me/bin', on(['/home/me/bin/wl-paste']))).toBe(false)
    expect(claude.claudeClipboardToolMissing('linux', '', on(['/usr/bin/xclip']))).toBe(false)
    expect(claude.claudeClipboardToolMissing('linux', 'relative/bin', on(['/bin/wl-paste']))).toBe(false)
  })

  it('a relative PATH folder is never searched', () => {
    expect(claude.claudeClipboardToolMissing('linux', 'bin:./tools', on(['bin/xclip', 'tools/xclip', './tools/xclip']))).toBe(true)
  })

  it('never missing on Windows or macOS (PowerShell and osascript come with the system)', () => {
    for (const os of ['win32', 'darwin'] as const) expect(claude.claudeClipboardToolMissing(os, '', on([])), os).toBe(false)
  })

  it('the package\'s rule asks it; Codex\'s has no such program to miss', () => {
    expect(typeof claude.CLAUDE_CLIPBOARD_PASTE.clipboardToolMissing).toBe('function')
    expect(claude.CLAUDE_CLIPBOARD_PASTE.clipboardToolMissing!('win32')).toBe(false)
    expect(CODEX_CLIPBOARD_PASTE.clipboardToolMissing?.('linux') ?? false).toBe(false)
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
      rule: () => ({ ...claude.CLAUDE_CLIPBOARD_PASTE, key: () => ({ bytes: CTRL_V, chord: 'ctrl+v', from: 'default' }), clipboardToolMissing: (p: NodeJS.Platform) => p === 'linux' && missing }),
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

  it('a tool there: the key goes, as before', async () => {
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
