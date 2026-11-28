/**
 * PR-level ADR-009 round 1 (A1): with a saved image, main says (off Windows)
 * whether the shell it spawns a local plain terminal and a partner shell with
 * (login-shell.ts localSessionShell) is
 * of the sh family, the shells Alt+V types a path into. Windows answers as
 * before. Nothing is read from the real clipboard and no file is written: the
 * readers are faked.
 *
 * 2.1.3-beta.21 (ADR-032, plan phase 2, 2.1.1; review round 1, R1-5): only
 * the path route behind the test switch asks for this save (the old SSH
 * path's fetch request saves through saveClipboardImage in main), so main
 * answers it only with the switch on (src/main/paste/path-route.ts: the app
 * not packaged and CCC_E2E_PATH_ROUTE=1). A packaged app saves nothing for
 * it and answers no image. The tests above that one run with the switch on.
 * Red on 0fce95b6: a packaged app saved the clipboard's picture and answered
 * its path. Mutant this must catch: the switch check dropped from the
 * handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const h = vi.hoisted(() => ({ shell: '/bin/bash', shellThrows: false, picked: { path: '/res/screenshots/clipboard-1.png' } as { path: string } | { error: 'no-image' }, packaged: false, reads: 0 }))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: () => {} },
  app: { get isPackaged() { return h.packaged } },
}))
vi.mock('../../../src/main/clipboard-image', () => ({ readClipboardImageWithRetry: async () => { h.reads++; return null } }))
vi.mock('../../../src/main/clipboard-text', () => ({ readClipboardTextWithRetry: async () => '' }))
// Electron 44: the copied-file fallback is async (it reads clipboard.read()), so
// the handler must await it before it adds the shell answer.
vi.mock('../../../src/main/clipboard-file', () => ({ readClipboardImageFilePath: async () => { h.reads++; return h.picked } }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }))
vi.mock('../../../src/main/login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/login-shell')>()),
  localSessionShell: () => { if (h.shellThrows) throw new Error('no shell'); return h.shell },
}))

const { registerClipboardHandlers } = await import('../../../src/main/ipc/clipboard-handlers')
const { IPC } = await import('../../../src/shared/ipc-channels')
registerClipboardHandlers()
const saveImage = handlers.get(IPC.CLIPBOARD_SAVE_IMAGE)!

const realPlatform = process.platform
const onPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p, configurable: true })
beforeEach(() => {
  h.shell = '/bin/bash'
  h.shellThrows = false
  h.picked = { path: '/res/screenshots/clipboard-1.png' }
  h.reads = 0
  // The path route's switch on: an unpackaged run with CCC_E2E_PATH_ROUTE=1.
  h.packaged = false
  vi.stubEnv('CCC_E2E_PATH_ROUTE', '1')
})
afterEach(() => { onPlatform(realPlatform); vi.unstubAllEnvs() })

describe('clipboard:saveImage says whether a plain terminal\'s shell is of the sh family (PR-level ADR-009 round 1, A1)', () => {
  it('macOS and Linux: sh for a shell of the sh family, other for any other', async () => {
    for (const [p, shell, kind] of [['linux', '/bin/bash', 'sh'], ['darwin', '/bin/zsh', 'sh'], ['linux', '/bin/dash', 'sh'], ['linux', '/usr/bin/fish', 'other'], ['darwin', '/opt/homebrew/bin/nu', 'other'], ['linux', '/usr/bin/pwsh', 'other']] as const) {
      onPlatform(p)
      h.shell = shell
      expect(await saveImage({}), `${p} ${shell}`).toEqual({ path: '/res/screenshots/clipboard-1.png', posixShell: kind })
    }
  })

  it('round 2 (A3): a shell check that throws answers other, so nothing is typed', async () => {
    onPlatform('linux')
    h.shellThrows = true
    expect(await saveImage({})).toEqual({ path: '/res/screenshots/clipboard-1.png', posixShell: 'other' })
  })

  it('Windows: the answer it always gave', async () => {
    onPlatform('win32')
    h.shell = '/usr/bin/fish'
    expect(await saveImage({})).toEqual({ path: '/res/screenshots/clipboard-1.png' })
  })

  it('no image: the error alone, on every platform', async () => {
    h.picked = { error: 'no-image' }
    for (const p of ['linux', 'win32'] as const) {
      onPlatform(p)
      expect(await saveImage({}), p).toEqual({ error: 'no-image' })
    }
  })
})

describe('clipboard:saveImage serves the path route only (ADR-032; review round 1, R1-5)', () => {
  it('a packaged app saves nothing and answers no image, even with the switch set', async () => {
    h.packaged = true
    for (const p of ['win32', 'linux'] as const) {
      onPlatform(p)
      expect(await saveImage({}), p).toEqual({ error: 'no-image' })
    }
    expect(h.reads).toBe(0)
  })

  it('an unpackaged app without the switch saves nothing either', async () => {
    vi.stubEnv('CCC_E2E_PATH_ROUTE', '')
    onPlatform('win32')
    expect(await saveImage({})).toEqual({ error: 'no-image' })
    expect(h.reads).toBe(0)
  })

  it('with the switch on, the save it always made', async () => {
    onPlatform('win32')
    expect(await saveImage({})).toEqual({ path: '/res/screenshots/clipboard-1.png' })
    expect(h.reads).toBe(2)
  })
})
