/**
 * 2.1.3-beta.16 X1.2 (aicc_planning #405): how sendImageToSession hands a
 * saved image (Snap's picture, Alt+V's) to a session.
 *  - On this computer: main is asked to paste the path into the session
 *    (pty.submitImage, with the caller's sentence, or the default one), and
 *    nothing is typed from here. Main's answer `not-taken` (an SSH Persistent
 *    session) gets the line it always got: the sentence and the path typed, then
 *    Enter. So does an ask that fails. A session that is gone, or a path main
 *    refuses, gets nothing. (A Codex session goes its own way since
 *    2.1.3-beta.17 C6: image-transfer-codex.test.ts.)
 *  - Over SSH, or with no session type: the host fetch line, as before, and
 *    main is not asked.
 * Red on beta: a local image was typed as text and main never asked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ writeSessionInput: vi.fn(), submitImage: vi.fn() }))
vi.mock('../../../src/renderer/components/terminal/tmuxWheelScroll', () => ({ writeSessionInput: h.writeSessionInput }))
;(globalThis as unknown as { window: unknown }).window = { electronAPI: { pty: { submitImage: h.submitImage } } }

const { sendImageToSession } = await import('../../../src/renderer/utils/imageTransfer')

const PATH = 'C:\\Users\\me\\AppData\\Local\\AI Code Conductor\\resources\\screenshots\\screenshot-2026-11-23-221500.jpg'
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  h.writeSessionInput.mockReset()
  h.submitImage.mockReset()
})

describe('sendImageToSession on this computer', () => {
  it('asks main to paste the path, with the caller\'s sentence, and types nothing itself', async () => {
    h.submitImage.mockResolvedValue({ outcome: 'sent' })
    sendImageToSession('cl1', PATH, 'I just snapped a region of my screen \u2014 please view it.', 'local')
    await flush()
    expect(h.submitImage).toHaveBeenCalledTimes(1)
    expect(h.submitImage).toHaveBeenCalledWith({ sessionId: 'cl1', path: PATH, sentence: 'I just snapped a region of my screen \u2014 please view it.' })
    expect(h.writeSessionInput).not.toHaveBeenCalled()
  })

  it('with no sentence given, the default one', async () => {
    h.submitImage.mockResolvedValue({ outcome: 'sent' })
    sendImageToSession('cl1', PATH, '   ', 'local')
    await flush()
    expect(h.submitImage).toHaveBeenCalledWith({ sessionId: 'cl1', path: PATH, sentence: 'Please view this image.' })
  })

  it('a session main does not take (not-taken): the sentence and the path typed, then Enter, as before', async () => {
    h.submitImage.mockResolvedValue({ outcome: 'not-taken' })
    // Since 2.1.3-beta.21 the line is main's path-route answer's (ADR-032 row 14).
    sendImageToSession('cx1', PATH, 'look', 'local', 'enter')
    await flush()
    expect(h.writeSessionInput).toHaveBeenCalledTimes(1)
    expect(h.writeSessionInput).toHaveBeenCalledWith('cx1', `look ${PATH}\r`)
  })

  it('an ask that fails: the same typed line', async () => {
    h.submitImage.mockRejectedValue(new Error('no handler'))
    sendImageToSession('cl1', PATH, 'look', 'local', 'enter')
    await flush()
    expect(h.writeSessionInput).toHaveBeenCalledWith('cl1', `look ${PATH}\r`)
  })

  it.each([['session-gone'], ['refused-text']])('not sent (%s): nothing typed', async (reason) => {
    h.submitImage.mockResolvedValue({ outcome: 'not-sent', reason })
    sendImageToSession('cl1', PATH, 'look', 'local')
    await flush()
    expect(h.writeSessionInput).not.toHaveBeenCalled()
  })
})

describe('sendImageToSession over SSH', () => {
  it.each([['ssh', 'ssh'], ['no session type', undefined]] as const)('%s: the host fetch line by its file name, and main is not asked', async (_name, type) => {
    sendImageToSession('ss1', PATH, 'look', type)
    await flush()
    expect(h.submitImage).not.toHaveBeenCalled()
    expect(h.writeSessionInput).toHaveBeenCalledWith('ss1', 'look (use mcp__conductor__fetch_host_screenshot with filename="screenshot-2026-11-23-221500.jpg" to load the image from the Conductor host)\r')
  })
})
