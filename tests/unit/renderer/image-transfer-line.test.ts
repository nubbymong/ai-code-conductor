/**
 * 2.1.3-beta.18 section 4 (aicc_planning#432): the renderer's image sender
 * asks main's image door for every session on this computer and stops
 * testing the provider. What main did not paste is typed by the session's own
 * image line (sessionCapabilities' imageLine): Claude Code's `enter`, Codex's
 * `composer`, and none for a session whose main pane runs no agent, which
 * then gets nothing typed, never Claude Code's line.
 *  - The capability: Claude Code `enter`, Codex `composer`, a plain shell
 *    none, a record with no provider read as Claude Code (as every reader of
 *    the store reads one), and a provider with no line of its own (a
 *    stand-in third provider) none: never Claude Code's.
 *  - sendImageToSession for a session with no image line (a plain shell, or
 *    the third provider's session): main is asked once, and its `not-taken`,
 *    or an ask that fails, types nothing.
 *  - The sender reads no provider: no 'claude' or 'codex' string in
 *    imageTransfer.ts.
 * Red on d0be048e: the capability had no imageLine; the sender typed Claude
 * Code's line (the sentence, the path and Enter) for every session it did
 * not read as Codex in the store, and compared the provider to 'codex'.
 * The third provider's cases were red on b3a0d2f4 too: the capability read
 * every provider that is not Codex as Claude Code, so that session's image
 * line was `enter`, and main's `not-taken` got Claude Code's line typed.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ writeSessionInput: vi.fn(), submitImage: vi.fn(), sendImagePathToCodex: vi.fn() }))
vi.mock('../../../src/renderer/components/terminal/tmuxWheelScroll', () => ({ writeSessionInput: h.writeSessionInput }))
vi.mock('../../../src/renderer/lib/codexComposer', () => ({
  sendImagePathToCodex: h.sendImagePathToCodex,
  NOT_AT_PROMPT: 'Codex is not at its prompt, so nothing was sent.',
  IMAGE_AT_PROMPT: 'The image is at the Codex prompt but was not sent: check it, then press Enter.',
}))
;(globalThis as unknown as { window: unknown }).window = { electronAPI: { pty: { submitImage: h.submitImage } } }

const { sendImageToSession } = await import('../../../src/renderer/utils/imageTransfer')
const { sessionCapabilities } = await import('../../../src/renderer/lib/session-capabilities')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

const PATH = 'C:\\Users\\me\\AppData\\Local\\AI Code Conductor\\resources\\screenshots\\screenshot-2026-11-25-080000.jpg'
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  h.writeSessionInput.mockReset()
  h.submitImage.mockReset()
  h.sendImagePathToCodex.mockReset()
})

describe('the image line, as sessionCapabilities says it', () => {
  it('Claude Code enter, Codex composer, a plain shell none, no provider read as Claude Code', () => {
    expect(sessionCapabilities({ provider: 'claude', sessionType: 'local' } as never).imageLine).toBe('enter')
    expect(sessionCapabilities({ provider: 'codex', sessionType: 'local' } as never).imageLine).toBe('composer')
    expect(sessionCapabilities({ provider: 'claude', sessionType: 'local', shellOnly: true } as never).imageLine).toBeNull()
    expect(sessionCapabilities({ sessionType: 'local' } as never).imageLine).toBe('enter')
    expect(sessionCapabilities(undefined).imageLine).toBe('enter')
  })

  it('a provider with no line of its own gets none, never Claude Code\'s', () => {
    expect(sessionCapabilities({ provider: 'third', sessionType: 'local' } as never).imageLine).toBeNull()
  })
})

describe('sendImageToSession for a session with no image line', () => {
  const plainTab = (): void => useSessionStore.setState({
    sessions: [{ id: 'pl1', label: 'pl1', workingDirectory: '/x', model: '', color: '#89b4fa', status: 'idle', createdAt: 0, sessionType: 'local', provider: 'claude', shellOnly: true } as never],
  })

  it('main is asked once; its not-taken types nothing (not Claude Code\'s line)', async () => {
    plainTab()
    h.submitImage.mockResolvedValue({ outcome: 'not-taken' })
    sendImageToSession('pl1', PATH, 'look', 'local')
    await flush()
    expect(h.submitImage).toHaveBeenCalledTimes(1)
    expect(h.writeSessionInput).not.toHaveBeenCalled()
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
  })

  it('an ask that fails types nothing either', async () => {
    plainTab()
    h.submitImage.mockRejectedValue(new Error('no handler'))
    sendImageToSession('pl1', PATH, 'look', 'local')
    await flush()
    expect(h.writeSessionInput).not.toHaveBeenCalled()
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
  })

  it('a session of a provider with no image line: main\'s not-taken types nothing (not Claude Code\'s line)', async () => {
    useSessionStore.setState({
      sessions: [{ id: 'tp1', label: 'tp1', workingDirectory: '/x', model: '', color: '#89b4fa', status: 'idle', createdAt: 0, sessionType: 'local', provider: 'third' } as never],
    })
    h.submitImage.mockResolvedValue({ outcome: 'not-taken' })
    sendImageToSession('tp1', PATH, 'look', 'local')
    await flush()
    expect(h.submitImage).toHaveBeenCalledTimes(1)
    expect(h.writeSessionInput).not.toHaveBeenCalled()
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
  })
})

describe('the sender reads no provider', () => {
  it('no \'claude\' or \'codex\' string in imageTransfer.ts', () => {
    const text = readFileSync(resolve(__dirname, '../../../src/renderer/utils/imageTransfer.ts'), 'utf8')
    expect(text.match(/(['"`])(claude|codex)\1/gi) ?? []).toEqual([])
  })
})
