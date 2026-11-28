// The paste module (ADR-032, row 8; plan 2.1.3-beta.21 phase 2, 2.1.1):
// src/main/paste pasteImageKey and pasteSnapPicture, against fake reads,
// writes and a fake door.
//  - A picture already on the clipboard: nothing written; the CLI's key from
//    its table, to the door; a press from outside the terminal with the
//    sentence, one in the terminal with none.
//  - A copied image file: written as a picture for Claude Code, never for
//    Codex on Windows (it reads copied files itself); too large, or one that
//    does not decode: nothing, and the hint says so. On a machine whose
//    writer is not in this beta (macOS until plan 3.1), no key and the line
//    s6 names for a copied file (review round 1, R1-3).
//  - The text chord (Ctrl+V with no text): only a picture pastes; a copied
//    file or nothing answers no picture.
//  - A tab on the old SSH path: a press from outside the terminal saves the
//    picture and answers the fetch request by its file name, never its path;
//    a press in the terminal takes nothing.
//  - A helper tab before phase 5's route: the same request from outside the
//    terminal, "not available yet" in it, nothing to paste for the text
//    chord; with the route registered, the route.
//  - Snap: the picture onto the clipboard for every kind of session (Q1),
//    then the key and the sentence on this computer, the request by file
//    name elsewhere; on a machine whose writer is not in this beta, nothing
//    pasted and the line s6 names. No path in any answer or door call, on
//    Rectangle's and Window's sentences alike.
//  - Snap's token is taken for the press's own session (review round 1,
//    R1-2).
//  - The session's account folder (the profile it spawned under) reaches
//    the table.
//  - The path route behind the test switch: the line, and nothing written
//    or typed.
// Red on 0c54a1c6: no such module. Mutants this must catch: a write when the
// clipboard already holds a picture; the copied-file rule ignored; the path
// fallback restored (a path handed to the door). Red on 0fce95b6: a copied
// file the writer could not write there answered the generic line (R1-3);
// the token was taken for no session (R1-2).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/session-input', () => ({ pasteFromClipboard: vi.fn(), providerOfSession: () => null }))
vi.mock('../../../src/main/providers', () => ({ tryGetProvider: () => undefined }))

const paste = await import('../../../src/main/paste')
const { CLAUDE_CLIPBOARD_PASTE } = await import('../../../src/main/providers/claude/clipboard-paste')
const { CODEX_CLIPBOARD_PASTE } = await import('../../../src/main/providers/codex/clipboard-paste')
const { PASTE_SENTENCE, PASTE_NOTES, SNAP_RECTANGLE_SENTENCE, SNAP_WINDOW_SENTENCE } = await import('../../../src/shared/clipboard-paste')
import type { NativeImage } from 'electron'
import type { PasteSessionWhere } from '../../../src/main/paste'

const picture = (empty = false) => ({ isEmpty: () => empty, toPNG: () => Buffer.from([0x89, 0x50]) }) as unknown as NativeImage
const FILE = 'C:\\Users\\me\\Pictures\\shot.png'
const SNAP_FILE = 'C:\\res\\screenshots\\screenshot-2026-11-28-101500.jpg'
const ESC_V = '\u001bv'

let where: PasteSessionWhere | null
let provider: 'claude' | 'codex' | null
let onClipboard: NativeImage | null
let files: string[]
let sizes: Record<string, number>
let decoded: NativeImage | null
let written: NativeImage[]
let writeResult: 'written' | 'failed' | 'not-yet'
let door: Array<{ sessionId: string; key: string; sentence: string | null }>
let doorAnswer: { outcome: string }
let saves: number
let saved: { path: string } | { error: 'no-image' | 'too-large' }
let pathRoute: boolean
/** The OS the module reads (a spread copies values, so it is set through setPasteDeps). */
const setPlatform = (p: NodeJS.Platform) => { paste.setPasteDeps({ platform: p }) }
let keyCtx: Array<{ platform: NodeJS.Platform; accountDir: string | null }>
let accountDir: string | null

beforeEach(() => {
  paste._resetPasteForTest()
  where = 'local'
  provider = 'claude'
  onClipboard = picture()
  files = []
  sizes = {}
  decoded = picture()
  written = []
  writeResult = 'written'
  door = []
  doorAnswer = { outcome: 'sent' }
  saves = 0
  saved = { path: 'C:\\res\\screenshots\\clipboard-1-abcd.jpg' }
  pathRoute = false
  keyCtx = []
  accountDir = null
  snaps.clear()
  snapTakes = []
  const spy = (rule: typeof CLAUDE_CLIPBOARD_PASTE) => ({ ...rule, key: (ctx: { platform: NodeJS.Platform; accountDir: string | null }) => { keyCtx.push(ctx); return rule.key(ctx) } })
  paste.setPasteDeps({
    platform: 'win32',
    where: () => where,
    provider: () => provider,
    rule: (id) => (id === 'claude' ? spy(CLAUDE_CLIPBOARD_PASTE) : id === 'codex' ? spy(CODEX_CLIPBOARD_PASTE) : undefined),
    accountDir: () => accountDir,
    readPicture: async () => onClipboard,
    readFiles: async () => files,
    fileSize: (p) => sizes[p] ?? null,
    decodeFile: () => decoded,
    write: async (pic) => { written.push(pic); return writeResult },
    savePicture: async () => { saves++; return saved },
    door: async (sessionId, key, sentence) => { door.push({ sessionId, key, sentence }); return doorAnswer as never },
    pathRoute: () => pathRoute,
    takeSnap: (token: string, sessionId: string) => { snapTakes.push(sessionId); const k = snaps.get(token) ?? null; snaps.delete(token); return k },
  } as never)
})

/** Snap tokens main keeps (screenshot-capture's, faked): one-shot. */
const snaps = new Map<string, { file: string; picture: NativeImage }>()
/** The session each token was taken for (R1-2: the token is bound to it). */
let snapTakes: string[] = []
const SNAP_TOKEN = '0123456789abcdef0123456789abcdef'

const press = (chord: 'image' | 'text', focused: boolean) => paste.pasteImageKey({ sessionId: 's1', chord, focused })

describe('a Claude Code or Codex session on this computer', () => {
  it('a picture already on the clipboard: nothing written, the CLI\'s own key to the door; from outside the terminal with the sentence', async () => {
    expect(await press('image', false)).toEqual({ outcome: 'sent' })
    expect(written).toEqual([])
    expect(door).toEqual([{ sessionId: 's1', key: ESC_V, sentence: PASTE_SENTENCE }])
  })

  it('a press in the terminal: the key with no sentence, and the door\'s placeholder answer is "pasted"', async () => {
    doorAnswer = { outcome: 'placeholder' }
    expect(await press('image', true)).toEqual({ outcome: 'pasted' })
    expect(door).toEqual([{ sessionId: 's1', key: ESC_V, sentence: null }])
  })

  it('the key is each CLI\'s own, per OS', async () => {
    setPlatform('linux')
    await press('image', true)
    provider = 'codex'
    setPlatform('win32')
    await press('image', true)
    expect(door.map((d) => d.key)).toEqual(['\u0016', ESC_V])
  })

  it('a copied image file for Claude Code: its picture written, then the key', async () => {
    onClipboard = null
    files = [FILE]
    sizes = { [FILE]: 1000 }
    expect(await press('image', false)).toEqual({ outcome: 'sent' })
    expect(written).toEqual([decoded])
    expect(door).toHaveLength(1)
  })

  it('a copied image file for Codex on Windows and macOS: nothing written, Codex reads it itself', async () => {
    for (const p of ['win32', 'darwin'] as const) {
      setPlatform(p)
      provider = 'codex'
      onClipboard = null
      files = [FILE]
      sizes = { [FILE]: 1000 }
      written = []
      door = []
      await press('image', false)
      expect(written, p).toEqual([])
      expect(door, p).toHaveLength(1)
    }
  })

  it('a copied image file for Claude Code on a machine whose writer is not in this beta (macOS until plan 3.1): no key, and the line s6 names', async () => {
    setPlatform('darwin')
    onClipboard = null
    files = [FILE]
    sizes = { [FILE]: 1000 }
    writeResult = 'not-yet'
    expect(await press('image', false)).toEqual({ outcome: 'not-pasted', reason: 'not-available', note: paste.COPIED_FILE_NOT_AVAILABLE_NOTE })
    expect(paste.COPIED_FILE_NOT_AVAILABLE_NOTE).toBe('Pasting a copied image file is not available on this computer in this beta.')
    expect(door).toEqual([])
    writeResult = 'failed'
    expect(await press('image', false)).toMatchObject({ outcome: 'not-pasted', reason: 'not-written' })
    expect(door).toEqual([])
  })

  it('a copied file too large, one that does not decode, or nothing: no key, and the hint', async () => {
    onClipboard = null
    files = [FILE]
    sizes = { [FILE]: 11 * 1024 * 1024 }
    expect(await press('image', false)).toEqual({ outcome: 'not-pasted', reason: 'too-large', note: PASTE_NOTES['too-large'] })
    sizes = { [FILE]: 1000 }
    decoded = null
    expect(await press('image', false)).toMatchObject({ outcome: 'not-pasted', reason: 'no-picture' })
    files = []
    expect(await press('image', false)).toMatchObject({ outcome: 'not-pasted', reason: 'no-picture' })
    expect(door).toEqual([])
    expect(written).toEqual([])
  })

  it('the text chord: a picture pastes; a copied file or nothing is no picture (the renderer says nothing to paste)', async () => {
    doorAnswer = { outcome: 'placeholder' }
    expect(await press('text', true)).toEqual({ outcome: 'pasted' })
    onClipboard = null
    files = [FILE]
    sizes = { [FILE]: 1000 }
    expect(await press('text', true)).toMatchObject({ outcome: 'not-pasted', reason: 'no-picture' })
    expect(door).toHaveLength(1)
    expect(written).toEqual([])
  })

  it('the door\'s answers as the hint\'s words', async () => {
    for (const [outcome, reason] of [['no-placeholder', 'no-placeholder'], ['busy', 'busy'], ['sentence-not-sent', 'sentence-not-sent'], ['session-gone', 'session-gone'], ['refused-key', 'no-key'], ['not-taken', 'not-available'], ['no-screen', 'not-available']] as const) {
      doorAnswer = { outcome }
      expect(await press('image', false), outcome).toEqual({ outcome: 'not-pasted', reason, note: PASTE_NOTES[reason] })
    }
  })

  it('an account binding the table cannot send: no key, nothing typed, the hint for Claude Code\'s own key', async () => {
    const rule = { ...CLAUDE_CLIPBOARD_PASTE, key: () => ({ bytes: null, chord: 'cmd+i', why: 'unexpressible' as const }) }
    paste.setPasteDeps({ rule: () => rule })
    expect(await press('image', false)).toEqual({ outcome: 'not-pasted', reason: 'no-key', note: PASTE_NOTES['no-key'] })
    expect(door).toEqual([])
  })

  it('the session\'s account folder (the profile it spawned under) reaches the table; none is this computer\'s own sign-in', async () => {
    await press('image', true)
    accountDir = 'C:\\acct\\one'
    await press('image', true)
    expect(keyCtx).toEqual([{ platform: 'win32', accountDir: null }, { platform: 'win32', accountDir: 'C:\\acct\\one' }])
  })

  it('a plain shell (no provider) or a provider with no table: not available, nothing read or typed', async () => {
    provider = null
    expect(await press('image', false)).toMatchObject({ outcome: 'not-pasted', reason: 'not-available' })
    expect(door).toEqual([])
  })

  it('the path route behind the test switch: the session\'s line, and nothing written or typed', async () => {
    pathRoute = true
    expect(await press('image', false)).toEqual({ outcome: 'path-route', line: 'enter' })
    provider = 'codex'
    expect(await press('image', false)).toEqual({ outcome: 'path-route', line: 'composer' })
    expect(door).toEqual([])
    expect(written).toEqual([])
  })

  it('a malformed press, or no session: nothing', async () => {
    expect(await paste.pasteImageKey({ sessionId: '', chord: 'image', focused: false })).toMatchObject({ reason: 'session-gone' })
    expect(await paste.pasteImageKey({ sessionId: 's1', chord: 'other', focused: false } as never)).toMatchObject({ reason: 'session-gone' })
    expect(await paste.pasteImageKey({ sessionId: 's1', chord: 'image' } as never)).toMatchObject({ reason: 'session-gone' })
    where = null
    expect(await press('image', false)).toMatchObject({ reason: 'session-gone' })
    expect(door).toEqual([])
  })
})

describe('a tab on the old SSH path (Q9), and a helper tab before phase 5\'s route', () => {
  it('old SSH path, from outside the terminal: the picture saved and the request by file name, never its path', async () => {
    where = 'ssh'
    const r = await press('image', false)
    expect(r).toEqual({ outcome: 'fetch', filename: 'clipboard-1-abcd.jpg' })
    expect(saves).toBe(1)
    expect(JSON.stringify(r)).not.toMatch(/\\\\|res/)
    expect(door).toEqual([])
  })

  it('old SSH path, a press in the terminal, or the text chord: nothing taken, nothing saved', async () => {
    where = 'ssh'
    expect(await press('image', true)).toMatchObject({ reason: 'no-picture' })
    expect(await press('text', true)).toMatchObject({ reason: 'no-picture' })
    expect(saves).toBe(0)
  })

  it('old SSH path, nothing to save: the hint', async () => {
    where = 'ssh'
    saved = { error: 'too-large' }
    expect(await press('image', false)).toMatchObject({ outcome: 'not-pasted', reason: 'too-large' })
  })

  it('a helper tab with no remote route: the request from outside the terminal, "not available yet" in it, nothing to paste for the text chord', async () => {
    where = 'helper'
    expect(await press('image', false)).toEqual({ outcome: 'fetch', filename: 'clipboard-1-abcd.jpg' })
    expect(await press('image', true)).toMatchObject({ reason: 'not-available' })
    expect(await press('text', true)).toMatchObject({ reason: 'no-picture' })
    expect(door).toEqual([])
  })

  it('a helper tab with the remote route registered (phase 5): the route takes the press, and Snap', async () => {
    where = 'helper'
    const route = { paste: vi.fn(async () => ({ outcome: 'sent' as const })) }
    paste.setRemotePasteRoute(route)
    expect(await press('image', true)).toEqual({ outcome: 'sent' })
    expect(route.paste).toHaveBeenCalledWith('s1', { press: { sessionId: 's1', chord: 'image', focused: true } })
    const pic = picture()
    await paste.pasteSnapPicture('s1', pic, SNAP_FILE, SNAP_RECTANGLE_SENTENCE)
    expect(route.paste).toHaveBeenLastCalledWith('s1', { snap: { picture: pic, sentence: SNAP_RECTANGLE_SENTENCE } })
    expect(saves).toBe(0)
  })
})

describe('Snap\'s picture (2.1.5)', () => {
  it('on this computer: the picture onto the clipboard, then the key and the sentence, on Rectangle and Window alike; no path anywhere', async () => {
    for (const sentence of [SNAP_RECTANGLE_SENTENCE, SNAP_WINDOW_SENTENCE]) {
      door = []
      written = []
      const pic = picture()
      const r = await paste.pasteSnapPicture('s1', pic, SNAP_FILE, sentence)
      expect(r).toEqual({ outcome: 'sent' })
      expect(written).toEqual([pic])
      expect(door).toEqual([{ sessionId: 's1', key: ESC_V, sentence }])
      expect(JSON.stringify({ r, door })).not.toContain('screenshot-2026')
    }
  })

  it('a tab on the old SSH path or a helper tab: the picture still onto this computer\'s clipboard (Q1), and the request by file name', async () => {
    for (const w of ['ssh', 'helper'] as const) {
      where = w
      written = []
      expect(await paste.pasteSnapPicture('s1', picture(), SNAP_FILE, SNAP_RECTANGLE_SENTENCE), w).toEqual({ outcome: 'fetch', filename: 'screenshot-2026-11-28-101500.jpg' })
      expect(written, w).toHaveLength(1)
    }
    expect(door).toEqual([])
  })

  it('a machine whose writer is not in this beta (macOS and Linux until plan 3.1): nothing pasted, and the line s6 names', async () => {
    writeResult = 'not-yet'
    expect(await paste.pasteSnapPicture('s1', picture(), SNAP_FILE, SNAP_RECTANGLE_SENTENCE)).toEqual({ outcome: 'not-pasted', reason: 'not-available', note: paste.SNAP_NOT_AVAILABLE_NOTE })
    expect(door).toEqual([])
    writeResult = 'failed'
    expect(await paste.pasteSnapPicture('s1', picture(), SNAP_FILE, SNAP_RECTANGLE_SENTENCE)).toMatchObject({ reason: 'not-written' })
    expect(door).toEqual([])
  })

  it('the path route\'s line for Snap: the session\'s own table\'s, none off this computer', () => {
    expect(paste.pathRouteLineOf('s1')).toBe('enter')
    provider = 'codex'
    expect(paste.pathRouteLineOf('s1')).toBe('composer')
    where = 'ssh'
    expect(paste.pathRouteLineOf('s1')).toBeNull()
  })
})

describe('Snap\'s press on the paste channel, by the token its capture answered (2.1.5)', () => {
  it('the token\'s picture onto the clipboard, then the key and the item\'s own sentence; the token is one-shot', async () => {
    const pic = picture()
    snaps.set(SNAP_TOKEN, { file: SNAP_FILE, picture: pic })
    const r = await paste.pasteImageKey({ sessionId: 's1', chord: 'snap', focused: false, snap: { token: SNAP_TOKEN, item: 'window' } })
    expect(r).toEqual({ outcome: 'sent' })
    expect(written).toEqual([pic])
    expect(door).toEqual([{ sessionId: 's1', key: ESC_V, sentence: SNAP_WINDOW_SENTENCE }])
    expect(await paste.pasteImageKey({ sessionId: 's1', chord: 'snap', focused: false, snap: { token: SNAP_TOKEN, item: 'window' } })).toMatchObject({ reason: 'no-picture' })
    expect(door).toHaveLength(1)
    // Review round 1 (R1-2): the token is taken for the press's own session.
    expect(snapTakes).toEqual(['s1', 's1'])
  })

  it('Rectangle\'s sentence for a rectangle; an unknown token pastes nothing', async () => {
    snaps.set(SNAP_TOKEN, { file: SNAP_FILE, picture: picture() })
    await paste.pasteImageKey({ sessionId: 's1', chord: 'snap', focused: false, snap: { token: SNAP_TOKEN, item: 'rectangle' } })
    expect(door[0].sentence).toBe(SNAP_RECTANGLE_SENTENCE)
    expect(await paste.pasteImageKey({ sessionId: 's1', chord: 'snap', focused: false, snap: { token: 'f'.repeat(32), item: 'rectangle' } })).toMatchObject({ reason: 'no-picture' })
    expect(door).toHaveLength(1)
  })

  it('a malformed Snap press (no token, a token that is not one, another item, focused, or a token on another chord) is refused', async () => {
    snaps.set(SNAP_TOKEN, { file: SNAP_FILE, picture: picture() })
    for (const bad of [
      { sessionId: 's1', chord: 'snap', focused: false },
      { sessionId: 's1', chord: 'snap', focused: false, snap: { token: 'C:\\res\\x.jpg', item: 'rectangle' } },
      { sessionId: 's1', chord: 'snap', focused: false, snap: { token: SNAP_TOKEN, item: 'screen' } },
      { sessionId: 's1', chord: 'snap', focused: true, snap: { token: SNAP_TOKEN, item: 'rectangle' } },
      { sessionId: 's1', chord: 'image', focused: false, snap: { token: SNAP_TOKEN, item: 'rectangle' } },
    ]) {
      expect(await paste.pasteImageKey(bad as never), JSON.stringify(bad)).toMatchObject({ reason: 'session-gone' })
    }
    expect(door).toEqual([])
    expect(snaps.has(SNAP_TOKEN)).toBe(true)
  })
})

describe('the test switch (Q5)', () => {
  it('on only when the app is not packaged and CCC_E2E_PATH_ROUTE=1; a packaged app never takes it', () => {
    expect(paste.pathRouteOn(false, { CCC_E2E_PATH_ROUTE: '1' })).toBe(true)
    expect(paste.pathRouteOn(true, { CCC_E2E_PATH_ROUTE: '1' })).toBe(false)
    expect(paste.pathRouteOn(false, {})).toBe(false)
    expect(paste.pathRouteOn(false, { CCC_E2E_PATH_ROUTE: 'true' })).toBe(false)
  })
})
