// The paste route of a tab through the session helper on a Linux host (plan
// 2.1.3-beta.21, block 5.1, its App bullet; ADR-032 decisions 2, 3, 5 and 9):
// src/main/paste/helper-route.ts, registered into phase 2's paste module by
// its seam (setRemotePasteRoute), against a fake tab (the remote helper's
// remoteTabPaste), fake clipboard reads and writes, and a fake door (the
// session input module's pasteFromClipboard).
//  - Alt+V and Ctrl+V with only a picture: the picture to the tab's machine
//    by file.put (its PNG), then the tab's key through the door: from outside
//    the terminal with the sentence, in it with none. A copied image file
//    (Alt+V only): its picture sent the same way. The host account's rebound
//    key is the one sent; a binding the app cannot send: the picture is sent
//    and the hint asks for Claude Code's own key.
//  - Snap: the picture also stays on this computer's clipboard (Q1), then
//    the same route with Snap's sentence.
//  - The stand-in not ready on the host (the s5 fallback until probe PR1),
//    and a Codex helper tab (Q7): "not available yet", nothing sent, nothing
//    typed, never a path.
//  - file.put's refusals, each with its own hint; a picture over 20 MiB as a
//    PNG goes as a JPEG; over that too, "too large".
//  - No path anywhere: what the door types is the key and the sentence only;
//    no answer names a file.
//  - Through the paste module: a helper tab's press and Snap reach the route;
//    a tab on the old SSH path is unchanged (Q9: today's fetch request by
//    file name), and the route is not asked.
// Red on e89996bb: no such route. Mutants this must catch: a path typed into
// a helper tab; the picture not sent before the key; Snap's picture not left
// on this computer's clipboard; a tab whose stand-in is not ready sent to.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/session-input', () => ({ pasteFromClipboard: vi.fn(), providerOfSession: () => null, isPasteKeyBytes: () => true }))
vi.mock('../../../src/main/providers', () => ({ tryGetProvider: () => undefined }))

const route = await import('../../../src/main/paste/helper-route')
const paste = await import('../../../src/main/paste')
const { PASTE_SENTENCE, PASTE_NOTES, SNAP_RECTANGLE_SENTENCE, SNAP_WINDOW_SENTENCE } = await import('../../../src/shared/clipboard-paste')
const { HolderError } = await import('../../../src/main/session-helper/connection')
const { PASTE_PICTURE_MAX } = await import('../../../src/main/session-helper/protocol')
import type { NativeImage } from 'electron'
import type { PasteKey } from '../../../src/main/providers/types'

const CTRL_V = '\u0016'
const ESC_V = '\u001bv'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 9, 9])
const FILE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7])
const picture = (png = PNG, jpg = JPG) => ({ isEmpty: () => png.length === 0, toPNG: () => png, toJPEG: () => jpg }) as unknown as NativeImage

let tab: { standIn: boolean; key: PasteKey | undefined; put: (b: Buffer, k: 'png' | 'jpg') => Promise<{ name: string; sha256: string }> } | null
let puts: Array<{ bytes: Buffer; kind: string }>
let putError: Error | null
let onClipboard: NativeImage | null
let copied: { picture: NativeImage } | { error: 'no-image' | 'too-large' }
let written: NativeImage[]
let door: Array<{ sessionId: string; key: string; sentence: string | null }>
let doorAnswer: { outcome: string }
let order: string[]

beforeEach(() => {
  puts = []
  putError = null
  order = []
  tab = {
    standIn: true,
    key: { bytes: CTRL_V, chord: 'ctrl+v', from: 'default' },
    put: async (bytes, kind) => { order.push('put'); if (putError) throw putError; puts.push({ bytes, kind }); return { name: `paste-${puts.length}.${kind}`, sha256: 'a'.repeat(64) } },
  }
  onClipboard = picture()
  copied = { error: 'no-image' }
  written = []
  door = []
  doorAnswer = { outcome: 'sent' }
})

const deps = (): Parameters<typeof route.helperPasteRoute>[0] => ({
  tab: () => tab,
  readPicture: async () => onClipboard,
  readCopiedImage: async () => copied,
  write: async (p) => { order.push('write'); written.push(p); return 'written' },
  door: async (sessionId, key, sentence) => { order.push('door'); door.push({ sessionId, key, sentence }); return doorAnswer as never },
})
const press = (chord: 'image' | 'text', focused: boolean) => route.helperPasteRoute(deps()).paste('h1', { press: { sessionId: 'h1', chord, focused } })
const snap = (sentence = SNAP_RECTANGLE_SENTENCE) => route.helperPasteRoute(deps()).paste('h1', { snap: { picture: picture(), sentence } })

/** Nothing the door typed is a path, a picture's name or anything but the key and a fixed sentence. */
function noPath(): void {
  for (const d of door) {
    expect([CTRL_V, ESC_V, '\u0007']).toContain(d.key)
    expect([null, PASTE_SENTENCE, SNAP_RECTANGLE_SENTENCE, SNAP_WINDOW_SENTENCE]).toContain(d.sentence)
  }
}

describe('Alt+V and Ctrl+V in a helper tab: the picture by file.put, then the key', () => {
  it('from outside the terminal: the picture\'s PNG sent first, then the tab\'s key with the sentence, and Enter by the door', async () => {
    expect(await press('image', false)).toEqual({ outcome: 'sent' })
    expect(puts).toEqual([{ bytes: PNG, kind: 'png' }])
    expect(door).toEqual([{ sessionId: 'h1', key: CTRL_V, sentence: PASTE_SENTENCE }])
    expect(order).toEqual(['put', 'door'])
    // Alt+V of a picture already on this computer's clipboard writes nothing there.
    expect(written).toEqual([])
    noPath()
  })

  it('in the terminal: the key and nothing more (the user is writing)', async () => {
    doorAnswer = { outcome: 'placeholder' }
    expect(await press('image', true)).toEqual({ outcome: 'pasted' })
    expect(door).toEqual([{ sessionId: 'h1', key: CTRL_V, sentence: null }])
    noPath()
  })

  it('Ctrl+V with only a picture (Q2) takes the same route; with a copied file or nothing, nothing to paste and nothing sent', async () => {
    expect(await press('text', true)).toEqual({ outcome: 'sent' })
    expect(puts).toHaveLength(1)
    onClipboard = null
    copied = { picture: picture(FILE_PNG) }
    expect(await press('text', true)).toEqual(PASTE_NOTES['no-picture'] && { outcome: 'not-pasted', reason: 'no-picture', note: PASTE_NOTES['no-picture'] })
    copied = { error: 'no-image' }
    expect((await press('text', false)).outcome).toBe('not-pasted')
    expect(puts).toHaveLength(1)
    expect(door).toHaveLength(1)
  })

  it('Alt+V with a copied image file: its picture sent the same way; too large or none, the hint says so and nothing is sent', async () => {
    onClipboard = null
    copied = { picture: picture(FILE_PNG) }
    expect(await press('image', false)).toEqual({ outcome: 'sent' })
    expect(puts).toEqual([{ bytes: FILE_PNG, kind: 'png' }])
    copied = { error: 'too-large' }
    expect(await press('image', false)).toEqual({ outcome: 'not-pasted', reason: 'too-large', note: PASTE_NOTES['too-large'] })
    copied = { error: 'no-image' }
    expect(await press('image', false)).toEqual({ outcome: 'not-pasted', reason: 'no-picture', note: PASTE_NOTES['no-picture'] })
    expect(puts).toHaveLength(1)
  })

  it('the host account\'s rebound key is the one sent', async () => {
    tab!.key = { bytes: ESC_V, chord: 'alt+v', from: 'keybindings' }
    await press('image', false)
    expect(door[0].key).toBe(ESC_V)
  })

  it('a binding the app cannot send: the picture is sent, no key is typed, and the hint asks for Claude Code\'s own key', async () => {
    tab!.key = { bytes: null, chord: 'ctrl+x ctrl+v', why: 'unexpressible' }
    expect(await press('image', false)).toEqual({ outcome: 'not-pasted', reason: 'no-key', note: PASTE_NOTES['no-key'] })
    expect(puts).toHaveLength(1)
    expect(door).toEqual([])
  })

  it('the door\'s answers: no placeholder in the wait, the sentence not sent, the session gone', async () => {
    for (const [answer, reason] of [['no-placeholder', 'no-placeholder'], ['sentence-not-sent', 'sentence-not-sent'], ['session-gone', 'session-gone'], ['refused-key', 'no-key']] as const) {
      doorAnswer = { outcome: answer }
      expect(await press('image', false), answer).toEqual({ outcome: 'not-pasted', reason, note: PASTE_NOTES[reason] })
    }
  })
})

describe('Snap into a helper tab', () => {
  it('the picture stays on this computer\'s clipboard (Q1), then goes by file.put, then the key and Snap\'s sentence', async () => {
    expect(await snap()).toEqual({ outcome: 'sent' })
    expect(written).toHaveLength(1)
    expect(puts).toEqual([{ bytes: PNG, kind: 'png' }])
    expect(door).toEqual([{ sessionId: 'h1', key: CTRL_V, sentence: SNAP_RECTANGLE_SENTENCE }])
    expect(order).toEqual(['write', 'put', 'door'])
    await snap(SNAP_WINDOW_SENTENCE)
    expect(door[1].sentence).toBe(SNAP_WINDOW_SENTENCE)
    noPath()
  })

  it('a picture this computer\'s clipboard did not take still goes to the tab', async () => {
    const r = route.helperPasteRoute({ ...deps(), write: async () => 'not-yet' })
    expect(await r.paste('h1', { snap: { picture: picture(), sentence: SNAP_RECTANGLE_SENTENCE } })).toEqual({ outcome: 'sent' })
    expect(puts).toHaveLength(1)
  })
})

describe('not available yet, never a path', () => {
  it('the stand-in not ready on the host (the s5 fallback until probe PR1): nothing sent, nothing typed', async () => {
    tab!.standIn = false
    expect(await press('image', false)).toEqual({ outcome: 'not-pasted', reason: 'not-available', note: PASTE_NOTES['not-available'] })
    expect(await press('image', true)).toEqual({ outcome: 'not-pasted', reason: 'not-available', note: PASTE_NOTES['not-available'] })
    expect(await press('text', true)).toEqual({ outcome: 'not-pasted', reason: 'not-available', note: PASTE_NOTES['not-available'] })
    expect(puts).toEqual([])
    expect(door).toEqual([])
  })

  it('a Codex helper tab (Q7): its launch has no stand-in and no key, so not available yet; Snap leaves the picture on this computer\'s clipboard only', async () => {
    tab = { standIn: false, key: undefined, put: async () => { throw new Error('nothing is sent to a Codex tab') } }
    expect(await press('image', false)).toEqual({ outcome: 'not-pasted', reason: 'not-available', note: PASTE_NOTES['not-available'] })
    expect(await snap()).toEqual({ outcome: 'not-pasted', reason: 'not-available', note: PASTE_NOTES['not-available'] })
    expect(written).toHaveLength(1)
    expect(door).toEqual([])
  })

  it('a launch that gave no key: not available yet, nothing sent', async () => {
    tab!.key = undefined
    expect(await press('image', false)).toEqual({ outcome: 'not-pasted', reason: 'not-available', note: PASTE_NOTES['not-available'] })
    expect(puts).toEqual([])
  })

  it('no such tab, or a door that throws: the session is gone', async () => {
    tab = null
    expect(await press('image', false)).toEqual({ outcome: 'not-pasted', reason: 'session-gone', note: PASTE_NOTES['session-gone'] })
    tab = { standIn: true, key: { bytes: CTRL_V, chord: 'ctrl+v', from: 'default' }, put: async () => ({ name: 'paste-1.png', sha256: 'a'.repeat(64) }) }
    const r = route.helperPasteRoute({ ...deps(), door: async () => { throw new Error('ports not registered') } })
    expect(await r.paste('h1', { press: { sessionId: 'h1', chord: 'image', focused: false } })).toEqual({ outcome: 'not-pasted', reason: 'session-gone', note: PASTE_NOTES['session-gone'] })
  })
})

describe('the picture to the machine: its size and file.put\'s refusals', () => {
  it('over 20 MiB as a PNG: sent as a JPEG; over that too: too large to send, nothing typed', async () => {
    const big = Buffer.alloc(PASTE_PICTURE_MAX + 1, 1)
    onClipboard = picture(big, JPG)
    expect(await press('image', false)).toEqual({ outcome: 'sent' })
    expect(puts).toEqual([{ bytes: JPG, kind: 'jpg' }])
    onClipboard = picture(big, Buffer.alloc(PASTE_PICTURE_MAX + 1, 2))
    expect(await press('image', false)).toEqual({ outcome: 'not-pasted', reason: 'too-large', note: route.HELPER_TOO_LARGE_NOTE })
    expect(puts).toHaveLength(1)
    expect(door).toHaveLength(1)
  })

  it('each refusal its own hint, nothing typed after it', async () => {
    const cases: Array<[string, { reason: string; note: string }]> = [
      ['not-connected', { reason: 'not-written', note: route.HELPER_NOT_CONNECTED_NOTE }],
      ['unknown-type', { reason: 'not-available', note: PASTE_NOTES['not-available'] }],
      ['too-large', { reason: 'too-large', note: route.HELPER_TOO_LARGE_NOTE }],
      ['busy', { reason: 'busy', note: PASTE_NOTES.busy }],
      ['io', { reason: 'not-written', note: route.HELPER_NOT_SENT_NOTE }],
      ['timeout', { reason: 'not-written', note: route.HELPER_NOT_SENT_NOTE }],
    ]
    for (const [code, want] of cases) {
      putError = new HolderError(code, 'refused')
      expect(await press('image', false), code).toEqual({ outcome: 'not-pasted', ...want })
    }
    putError = new Error('anything else')
    expect(await press('image', false)).toEqual({ outcome: 'not-pasted', reason: 'not-written', note: route.HELPER_NOT_SENT_NOTE })
    expect(door).toEqual([])
  })

  it('no answer names a file or a path', async () => {
    for (const r of [await press('image', false), await snap()]) {
      expect(JSON.stringify(r)).not.toMatch(/paste-\d|\/|\\|filename/)
    }
  })
})

describe('through the paste module\'s seam', () => {
  beforeEach(() => {
    paste._resetPasteForTest()
    paste.setRemotePasteRoute(route.helperPasteRoute(deps()))
  })

  it('a helper tab\'s press and Snap reach the route', async () => {
    paste.setPasteDeps({ where: () => 'helper', takeSnap: () => ({ file: 'C:\\res\\screenshots\\snap-1.jpg', picture: picture() }) } as never)
    expect(await paste.pasteImageKey({ sessionId: 'h1', chord: 'image', focused: false })).toEqual({ outcome: 'sent' })
    expect(await paste.pasteImageKey({ sessionId: 'h1', chord: 'snap', focused: false, snap: { token: '0123456789abcdef', item: 'window' } })).toEqual({ outcome: 'sent' })
    expect(door.map((d) => d.sentence)).toEqual([PASTE_SENTENCE, SNAP_WINDOW_SENTENCE])
    expect(puts).toHaveLength(2)
    noPath()
  })

  it('a tab on the old SSH path is unchanged (Q9): today\'s request by file name, and the route is not asked', async () => {
    let saves = 0
    paste.setPasteDeps({ where: () => 'ssh', savePicture: async () => { saves++; return { path: 'C:\\res\\screenshots\\clipboard-1-abcd.jpg' } } } as never)
    expect(await paste.pasteImageKey({ sessionId: 's1', chord: 'image', focused: false })).toEqual({ outcome: 'fetch', filename: 'clipboard-1-abcd.jpg' })
    expect(await paste.pasteImageKey({ sessionId: 's1', chord: 'image', focused: true })).toEqual({ outcome: 'not-pasted', reason: 'no-picture', note: PASTE_NOTES['no-picture'] })
    expect(saves).toBe(1)
    expect(puts).toEqual([])
    expect(door).toEqual([])
  })
})
