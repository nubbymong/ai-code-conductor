/**
 * 2.1.3-beta.17 C6 (aicc_planning#415): a saved image (Snap's picture,
 * Alt+V's) into a Codex session on this computer.
 *  - sendImageToCodexSession asks main to paste the path as Codex's own paste
 *    (pty.submitImage) with the sentence as given; nothing is typed from
 *    here when main sent it.
 *  - Main's `not-taken` (Codex not ready, no placeholder),
 *    or an ask that fails: today's line, by the rule that types into Codex
 *    (sendImagePathToCodex), with the same words and the note callback.
 *  - Main's `not-taken` with `left` (its paste may still be at the prompt):
 *    nothing typed; the note says the image is at the prompt. Only main
 *    knows the placeholder is its own (mutant: `left` ignored).
 *  - The session gone, or a path main refuses: nothing typed; the note says so.
 *  - sendImageToSession hands a local Codex session there (its notes to the
 *    session's paste hint), and never types the raw line into it; an SSH one
 *    keeps the host fetch line.
 * Red on beta: sendImageToCodexSession does not exist, and Snap typed the raw
 * line (the sentence, the path and Enter in one write) into a Codex session
 * main did not take.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ writeSessionInput: vi.fn(), submitImage: vi.fn(), sendImagePathToCodex: vi.fn() }))
vi.mock('../../../src/renderer/components/terminal/tmuxWheelScroll', () => ({ writeSessionInput: h.writeSessionInput }))
vi.mock('../../../src/renderer/lib/codexComposer', () => ({
  sendImagePathToCodex: h.sendImagePathToCodex,
  NOT_AT_PROMPT: 'Codex is not at its prompt, so nothing was sent.',
  IMAGE_AT_PROMPT: 'The image is at the Codex prompt but was not sent: check it, then press Enter.',
}))
;(globalThis as unknown as { window: unknown }).window = { electronAPI: { pty: { submitImage: h.submitImage } } }

const { sendImageToCodexSession, sendImageToSession, imagePathRefusedNote } = await import('../../../src/renderer/utils/imageTransfer')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { usePasteHintStore } = await import('../../../src/renderer/stores/pasteHintStore')

const PATH = 'C:\\Users\\me\\AppData\\Local\\AI Code Conductor\\resources\\screenshots\\screenshot-2026-11-24-061500.jpg'
const SNAP = 'I just snapped a region of my screen \u2014 please view it.'
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  h.writeSessionInput.mockReset()
  h.submitImage.mockReset()
  h.sendImagePathToCodex.mockReset()
  usePasteHintStore.setState({ hints: {} })
})

describe('sendImageToCodexSession', () => {
  it('asks main to paste the path, with the sentence as given, and types nothing itself when it was sent', async () => {
    h.submitImage.mockResolvedValue({ outcome: 'sent' })
    const notes: string[] = []
    sendImageToCodexSession('cx1', PATH, SNAP, (n) => notes.push(n))
    await flush()
    expect(h.submitImage).toHaveBeenCalledWith({ sessionId: 'cx1', path: PATH, sentence: SNAP })
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
    expect(h.writeSessionInput).not.toHaveBeenCalled()
    expect(notes).toEqual([])
  })

  it('main did not paste it (not-taken): today\'s line by the Codex rule, with the same words and the note callback', async () => {
    h.submitImage.mockResolvedValue({ outcome: 'not-taken' })
    const onNote = vi.fn()
    sendImageToCodexSession('cx1', PATH, SNAP, onNote)
    await flush()
    expect(h.sendImagePathToCodex).toHaveBeenCalledTimes(1)
    expect(h.sendImagePathToCodex).toHaveBeenCalledWith('cx1', PATH, onNote, undefined, SNAP)
    expect(h.writeSessionInput).not.toHaveBeenCalled()
  })

  it('not-taken with left: IMAGE_AT_PROMPT, the typing rule not asked', async () => {
    h.submitImage.mockResolvedValue({ outcome: 'not-taken', left: true })
    const notes: string[] = []
    sendImageToCodexSession('cx1', PATH, SNAP, (n) => notes.push(n))
    await flush()
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
    expect(h.writeSessionInput).not.toHaveBeenCalled()
    expect(notes).toEqual(['The image is at the Codex prompt but was not sent: check it, then press Enter.'])
  })

  it('not-taken without left: the typing rule is asked, and no note from here', async () => {
    h.submitImage.mockResolvedValue({ outcome: 'not-taken' })
    const notes: string[] = []
    sendImageToCodexSession('cx1', PATH, SNAP, (n) => notes.push(n))
    await flush()
    expect(h.sendImagePathToCodex).toHaveBeenCalledTimes(1)
    expect(notes).toEqual([])
  })

  it('an ask that fails: the same fallback', async () => {
    h.submitImage.mockRejectedValue(new Error('no handler'))
    sendImageToCodexSession('cx1', PATH, 'look', () => {})
    await flush()
    expect(h.sendImagePathToCodex).toHaveBeenCalledTimes(1)
    expect(h.sendImagePathToCodex.mock.calls[0][4]).toBe('look')
  })

  it.each([
    ['session-gone', 'Codex is not at its prompt, so nothing was sent.'],
    ['refused-text', imagePathRefusedNote(PATH)],
  ])('not sent (%s): nothing typed, and the note says so', async (reason, note) => {
    h.submitImage.mockResolvedValue({ outcome: 'not-sent', reason })
    const notes: string[] = []
    sendImageToCodexSession('cx1', PATH, 'look', (n) => notes.push(n))
    await flush()
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
    expect(h.writeSessionInput).not.toHaveBeenCalled()
    expect(notes).toEqual([note])
  })

  it('no words: the default sentence', async () => {
    h.submitImage.mockResolvedValue({ outcome: 'sent' })
    sendImageToCodexSession('cx1', PATH, '  ', () => {})
    await flush()
    expect(h.submitImage).toHaveBeenCalledWith({ sessionId: 'cx1', path: PATH, sentence: 'Please view this image.' })
  })
})

describe('sendImageToSession with a Codex session', () => {
  const codexTab = (sessionType: 'local' | 'ssh') => useSessionStore.setState({
    sessions: [{ id: 'cx9', label: 'cx9', workingDirectory: '/x', model: 'gpt-5.5', color: '#89b4fa', status: 'idle', createdAt: 0, sessionType, provider: 'codex' } as never],
  })

  it('on this computer: main is asked as for Alt+V; its fallback\'s note goes to the session\'s paste hint, and the raw line is never typed', async () => {
    codexTab('local')
    h.submitImage.mockResolvedValue({ outcome: 'not-taken' })
    sendImageToSession('cx9', PATH, SNAP, 'local')
    await flush()
    expect(h.submitImage).toHaveBeenCalledWith({ sessionId: 'cx9', path: PATH, sentence: SNAP })
    expect(h.writeSessionInput).not.toHaveBeenCalled()
    const onNote = h.sendImagePathToCodex.mock.calls[0][2] as (n: string) => void
    onNote('Codex is busy with a turn, so nothing was sent.')
    expect(usePasteHintStore.getState().hints.cx9).toBe('Codex is busy with a turn, so nothing was sent.')
  })

  it('over SSH: the host fetch line, as before, and main is not asked', async () => {
    codexTab('ssh')
    sendImageToSession('cx9', PATH, 'look', 'ssh')
    await flush()
    expect(h.submitImage).not.toHaveBeenCalled()
    expect(h.writeSessionInput).toHaveBeenCalledTimes(1)
  })
})
