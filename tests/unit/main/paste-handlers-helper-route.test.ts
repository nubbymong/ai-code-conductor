// The paste channel's handler registers the helper tab's route (plan
// 2.1.3-beta.21, block 5.1; src/main/ipc/paste-handlers.ts): a press for a
// tab through the session helper reaches the remote helper's open tab
// (remoteTabPaste) and the session input module's one door, with the
// picture this computer's clipboard holds, or a copied image file's; a tab
// on the old SSH path still gets today's request by file name (Q9).
// Mutant this must catch: the route not registered (the helper tab then got
// the old path's request, as before phase 5).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  helper: new Set<string>(),
  ssh: new Set<string>(),
  puts: [] as Array<{ id: string; bytes: Buffer; kind: string }>,
  door: [] as Array<{ id: string; key: string; sentence: string | null }>,
  clipboard: null as unknown,
  files: [] as string[],
  fromFile: [] as string[],
  saves: 0,
}))
const pic = (bytes: number[]) => ({ isEmpty: () => false, toPNG: () => Buffer.from(bytes), toJPEG: () => Buffer.from([0xff, 0xd8, 0xff]) })

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { h.handlers.set(ch, fn) } },
  nativeImage: { createFromPath: (p: string) => { h.fromFile.push(p); return pic([0x89, 0x50, 0x4e, 0x47, 2]) } },
}))
vi.mock('../../../src/main/ipc/trusted-sender', () => ({ appWindowSender: () => () => true }))
vi.mock('../../../src/main/pty-manager', () => ({ isSessionLiveOrStarting: () => true, getSshFlow: (id: string) => (h.ssh.has(id) ? {} : undefined) }))
vi.mock('../../../src/main/remote-helper', () => ({
  isRemoteHelperTab: (id: string) => h.helper.has(id),
  remoteTabPaste: (id: string) => (h.helper.has(id)
    ? { standIn: true, key: { bytes: '\u0016', chord: 'ctrl+v', from: 'default' }, put: async (bytes: Buffer, kind: string) => { h.puts.push({ id, bytes, kind }); return { name: 'paste-1.png', sha256: 'a'.repeat(64) } } }
    : null),
}))
vi.mock('../../../src/main/session-input', () => ({
  pasteFromClipboard: async (id: string, key: string, sentence: string | null) => { h.door.push({ id, key, sentence }); return { outcome: sentence === null ? 'placeholder' : 'sent' } },
  providerOfSession: () => null,
}))
vi.mock('../../../src/main/clipboard-image', () => ({ readClipboardImageWithRetry: async () => h.clipboard }))
vi.mock('../../../src/main/clipboard-file', async (orig) => ({ ...(await orig<typeof import('../../../src/main/clipboard-file')>()), readClipboardFilePaths: async () => h.files }))
vi.mock('../../../src/main/paste/clipboard-writer', () => ({ writeClipboardPicture: async () => 'written' }))
vi.mock('../../../src/main/ipc/clipboard-handlers', () => ({ saveClipboardImage: async () => { h.saves++; return { path: 'C:\\res\\screenshots\\clipboard-9-abcd.jpg' } } }))
vi.mock('../../../src/main/claude-account-identity', () => ({ getClaudeProfileId: () => null }))
vi.mock('../../../src/main/account-profiles', () => ({ getProfileConfigDir: () => null }))
vi.mock('../../../src/main/screenshot-capture', () => ({ takeSnapForPaste: () => null }))
vi.mock('../../../src/main/providers', () => ({ tryGetProvider: () => undefined }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { registerPasteHandlers } = await import('../../../src/main/ipc/paste-handlers')
const { IPC } = await import('../../../src/shared/ipc-channels')
const { PASTE_SENTENCE } = await import('../../../src/shared/clipboard-paste')

let dir = ''
beforeEach(() => {
  h.handlers.clear()
  h.helper = new Set(['h1'])
  h.ssh = new Set(['s1'])
  h.puts = []
  h.door = []
  h.clipboard = pic([0x89, 0x50, 0x4e, 0x47, 1])
  h.files = []
  h.fromFile = []
  h.saves = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-handlers-'))
  registerPasteHandlers(() => null)
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const press = (sessionId: string, focused = false) => h.handlers.get(IPC.PASTE_IMAGE_KEY)!({}, { sessionId, chord: 'image', focused })

describe('the paste channel registers the helper tab\'s route', () => {
  it('a press in a helper tab: the clipboard\'s picture to its machine, then its key through the door', async () => {
    expect(await press('h1')).toEqual({ outcome: 'sent' })
    expect(h.puts).toEqual([{ id: 'h1', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]), kind: 'png' }])
    expect(h.door).toEqual([{ id: 'h1', key: '\u0016', sentence: PASTE_SENTENCE }])
    expect(h.saves).toBe(0)
  })

  it('a copied image file: read from the file the clipboard names, and sent the same way', async () => {
    h.clipboard = null
    const file = path.join(dir, 'shot.png')
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    h.files = [file]
    expect(await press('h1', true)).toEqual({ outcome: 'pasted' })
    expect(h.fromFile).toEqual([file])
    expect(h.puts.map((p) => p.bytes)).toEqual([Buffer.from([0x89, 0x50, 0x4e, 0x47, 2])])
    expect(h.door).toEqual([{ id: 'h1', key: '\u0016', sentence: null }])
  })

  it('a tab on the old SSH path is unchanged: today\'s request by file name, and nothing is sent by file.put', async () => {
    expect(await press('s1')).toEqual({ outcome: 'fetch', filename: 'clipboard-9-abcd.jpg' })
    expect(h.puts).toEqual([])
    expect(h.door).toEqual([])
  })
})
