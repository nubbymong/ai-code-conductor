/**
 * Every Agent Canvas channel answers only the app's own window, its main frame
 * (ipc/trusted-sender.ts), as `canvas:agentMarker` already did.
 *
 * Any other sender or frame, a destroyed window and a call made while there is
 * no window get the channel's own empty or refused answer (listed per channel
 * below), before the payload is read: no canvas, review, evidence, completion
 * or session-link call is reached. A refusal writes one warning line, which
 * carries no part of the request. The app window's main frame is served as
 * before.
 *
 * The app window is the only caller these channels have: the canvas content
 * frames have no bridge (tests/e2e/agent-canvas-frame-security.spec.ts), and
 * the snapshot reply is sent by the app's main frame
 * (src/renderer/canvas/canvas-snapshot-host.ts). The last case below drives
 * that reply round trip end to end through the real broker.
 *
 * The table is checked against the channels the file registers, so a channel
 * added later without a row fails this suite. Every collaborator is an inert
 * recording fake: nothing reads or writes disk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'
import { notAppMainFrameEvents } from '../../helpers/app-window-events'

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const OTHER_SID = 'f0e1d2c3b4a5f6e7d8c9b0a1'
const CID = 'c1c2c3c4c5c6c7c8c9c0d1d2'

const h = vi.hoisted(() => {
  const calls: string[] = []
  /** A fake collaborator that records that it was reached, then answers `impl`. */
  const rec =
    (name: string, impl: (...a: any[]) => unknown = () => undefined) =>
    (...a: unknown[]) => {
      calls.push(name)
      return impl(...a)
    }
  const state = {
    canvasId: 'c1c2c3c4c5c6c7c8c9c0d1d2',
    sessionId: 'a1b2c3d4e5f6a7b8c9d0e1f2',
    completed: false,
    versions: [{ id: 'v1', mode: 'uat', draft: false }],
  }
  return {
    handlers: new Map<string, (...a: unknown[]) => unknown>(),
    listeners: new Map<string, (...a: unknown[]) => unknown>(),
    logs: [] as string[],
    calls,
    rec,
    state,
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => h.listeners.set(ch, fn),
  },
  BrowserWindow: { fromWebContents: () => null },
}))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { h.logs.push(['INFO', ...a].map(String).join(' ')) },
  logWarn: (...a: unknown[]) => { h.logs.push(['WARN', ...a].map(String).join(' ')) },
  logError: (...a: unknown[]) => { h.logs.push(['ERROR', ...a].map(String).join(' ')) },
  logDebug: () => {}, logTrace: () => {}, setVerboseMode: () => {}, isVerboseMode: () => false, setVerboseBaseline: () => {},
  setTraceMode: () => {}, isTraceMode: () => false, installGlobalErrorHandlers: () => {}, closeDebugLogger: () => {},
}))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: h.rec('readConfig', () => null) }))
vi.mock('../../../src/main/canvas/canvas-store', () => ({
  canvasProjectDirOf: h.rec('canvasProjectDirOf', () => null),
  deleteArtifact: h.rec('deleteArtifact', () => ({ ok: true, deletedVersionIds: [] })),
  deleteCanvas: h.rec('deleteCanvas', () => true),
  getCanvasStateById: h.rec('getCanvasStateById', () => h.state),
  getCanvasStateForSession: h.rec('getCanvasStateForSession', () => h.state),
  isSameCanvasProject: h.rec('isSameCanvasProject', () => true),
  listAllCanvases: h.rec('listAllCanvases', () => []),
  onCanvasChanged: h.rec('onCanvasChanged', () => () => {}),
  renderVersion: h.rec('renderVersion', () => ({ canvasId: h.state.canvasId, versionId: 'v1' })),
  reopenVersionForReview: h.rec('reopenVersionForReview', () => ({ state: h.state, withdrawn: [] })),
  setActiveVersion: h.rec('setActiveVersion', () => h.state),
  setArtifactArchived: h.rec('setArtifactArchived', () => h.state),
  setPackName: h.rec('setPackName', () => h.state),
  setVersionVerdict: h.rec('setVersionVerdict', () => h.state),
  verdictTargetVersionId: h.rec('verdictTargetVersionId', () => null),
}))
vi.mock('../../../src/main/canvas/canvas-library-rows', () => ({
  buildLibraryRows: h.rec('buildLibraryRows', () => ({ rows: [], truncated: false })),
}))
vi.mock('../../../src/main/canvas/canvas-evidence', () => ({
  claimCaptureSlot: h.rec('claimCaptureSlot', () => false),
  clampCaptureRect: h.rec('clampCaptureRect', () => null),
  discardPendingEvidence: h.rec('discardPendingEvidence', () => true),
  encodeEvidenceShot: h.rec('encodeEvidenceShot', () => null),
  evidencePackIsFull: h.rec('evidencePackIsFull', () => false),
  evidencePreviewDataUrl: h.rec('evidencePreviewDataUrl', () => ''),
  storePendingEvidence: h.rec('storePendingEvidence', () => 'e'),
  sweepStalePendingEvidence: h.rec('sweepStalePendingEvidence'),
}))
vi.mock('../../../src/main/canvas/ccc-ux-protocol', () => ({
  setCanvasFrameNavigatedSink: h.rec('setCanvasFrameNavigatedSink'),
}))
vi.mock('../../../src/main/canvas/canvas-marker-delivery', () => ({
  deliverCanvasMarker: h.rec('deliverCanvasMarker', () => 'sent'),
}))
vi.mock('../../../src/main/canvas/canvas-review-store', () => ({
  MAX_SKETCH_PNG_BYTES: 4 * 1024 * 1024,
  clearComposerDraft: h.rec('clearComposerDraft', () => ({})),
  deleteAnnotation: h.rec('deleteAnnotation', () => ({})),
  dropReviewsForCanvas: h.rec('dropReviewsForCanvas'),
  getReviewCountsForCanvas: h.rec('getReviewCountsForCanvas', () => null),
  getReviewSnapshotForCanvas: h.rec('getReviewSnapshotForCanvas', () => null),
  getReviewStateForSession: h.rec('getReviewStateForSession', () => null),
  deleteAnnotationsForVersions: h.rec('deleteAnnotationsForVersions', () => 0),
  markAddressedNotesSeen: h.rec('markAddressedNotesSeen', () => ({ state: {}, seen: [] })),
  onReviewChanged: h.rec('onReviewChanged', () => () => {}),
  readRecordedCanvasImage: h.rec('readRecordedCanvasImage', () => null),
  reopenAnnotation: h.rec('reopenAnnotation', () => ({})),
  reopenReview: h.rec('reopenReview', () => ({})),
  setComposerDraft: h.rec('setComposerDraft', () => ({})),
  settleReviewsForSupersededVersions: h.rec('settleReviewsForSupersededVersions'),
  settleRoundsForUserDecision: h.rec('settleRoundsForUserDecision'),
  submitReview: h.rec('submitReview', () => ({ canvasId: h.state.canvasId })),
  upsertAnnotation: h.rec('upsertAnnotation', () => ({ state: {}, annotationId: 'a1' })),
}))
vi.mock('../../../src/main/canvas/canvas-completion', () => ({
  completeCanvasGuarded: h.rec('completeCanvasGuarded', () => h.state),
  describeForceClosures: h.rec('describeForceClosures', () => null),
  reopenCanvasGuarded: h.rec('reopenCanvasGuarded', () => h.state),
}))
vi.mock('../../../src/main/canvas/canvas-snapshot-broker', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/canvas/canvas-snapshot-broker')>()
  return {
    ...real,
    resolveCanvasSnapshot: h.rec('resolveCanvasSnapshot', (reply: unknown) => real.resolveCanvasSnapshot(reply as never)),
    setSnapshotSender: (fn: unknown) => real.setSnapshotSender(fn as never),
  }
})
vi.mock('../../../src/main/canvas/claude-marker-typing', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/canvas/claude-marker-typing')>()
  return {
    ...real,
    resolveClaudeMarkerAnswer: h.rec('resolveClaudeMarkerAnswer', (answer: unknown) => real.resolveClaudeMarkerAnswer(answer)),
    setClaudeMarkerSender: (fn: unknown) => real.setClaudeMarkerSender(fn as never),
  }
})
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({
  canvasArtifactMutationAllowed: h.rec('canvasArtifactMutationAllowed', () => ({ ok: true })),
  canvasConfigNameForSession: h.rec('canvasConfigNameForSession', () => undefined),
  canvasCwdForSession: h.rec('canvasCwdForSession', () => undefined),
  canvasLivenessQuery: h.rec('canvasLivenessQuery', () => ({ isSessionLive: () => false })),
  canvasMutationAllowed: h.rec('canvasMutationAllowed', () => ({ ok: true })),
  dismissCanvasForSession: h.rec('dismissCanvasForSession', () => ({ ok: true })),
  installCanvasSessionLink: h.rec('installCanvasSessionLink'),
  listResumableRows: h.rec('listResumableRows', () => []),
  openOwnCanvasForSessionLink: h.rec('openOwnCanvasForSessionLink', () => true),
  resumeCanvasFromSession: h.rec('resumeCanvasFromSession', () => ({ ok: true })),
}))

const { registerCanvasHandlers } = await import('../../../src/main/ipc/canvas-handlers')
const { requestCanvasSnapshot, _resetSnapshotBrokerForTest } = await import('../../../src/main/canvas/canvas-snapshot-broker')
const { askClaudePrompt, _resetClaudeMarkerTypingForTest } = await import('../../../src/main/canvas/claude-marker-typing')

const NOT_APP_REASON = 'not-app-window'
const REQUEST_ID = '0123456789abcdef01234567'

interface Row {
  /** A well-formed payload, so a missing check would reach a collaborator
   *  rather than fail validation. */
  args: unknown
  /** What a refused request is answered (undefined for a fire-and-forget send). */
  refused: unknown
}

/** One row per channel the file registers, request and send alike. */
const ROWS: Record<string, Row> = {
  [IPC.CANVAS_GET_STATE]: { args: { sessionId: SID }, refused: null },
  [IPC.CANVAS_RECLAIM]: { args: { sessionId: SID, canvasId: CID }, refused: { ok: false, state: null } },
  [IPC.CANVAS_LIBRARY_LIST]: { args: { sessionId: SID, query: 'checkout-flow' }, refused: { rows: [], truncated: false } },
  [IPC.CANVAS_LIST_RESUMABLES]: { args: { sessionId: SID }, refused: [] },
  [IPC.CANVAS_RESUME]: { args: { sessionId: SID, canvasId: CID, expectedOwnerSessionId: OTHER_SID }, refused: { ok: false } },
  [IPC.CANVAS_DISMISS]: { args: { sessionId: SID, canvasId: CID }, refused: { ok: false } },
  [IPC.CANVAS_GET_READONLY]: { args: { sessionId: SID, canvasId: CID }, refused: null },
  [IPC.CANVAS_LIST_ALL]: { args: { sessionId: SID }, refused: [] },
  [IPC.CANVAS_DELETE]: { args: { sessionId: SID, canvasId: CID }, refused: { ok: false } },
  [IPC.CANVAS_RENDER]: { args: { sessionId: SID, source: { mode: 'design', html: '<p>rendered page</p>' } }, refused: null },
  [IPC.CANVAS_VERSION_VERDICT]: {
    args: { sessionId: SID, versionId: 'v1', state: 'rejected', note: 'the header wraps' },
    refused: { error: NOT_APP_REASON },
  },
  [IPC.CANVAS_AGENT_MARKER]: {
    args: { sessionId: SID, canvasId: CID, line: 'Approved v1 on the canvas' },
    refused: { delivery: 'refused', reason: NOT_APP_REASON },
  },
  [IPC.CANVAS_VERSION_REOPEN]: { args: { sessionId: SID, versionId: 'v1' }, refused: { error: NOT_APP_REASON } },
  [IPC.CANVAS_ARCHIVE_ARTIFACT]: {
    args: { sessionId: SID, canvasId: CID, versionId: 'v1', archived: true },
    refused: { ok: false, state: null },
  },
  [IPC.CANVAS_DELETE_ARTIFACT]: {
    args: { sessionId: SID, canvasId: CID, versionId: 'v1' },
    refused: { ok: false, reason: 'not-eligible' },
  },
  [IPC.CANVAS_SET_ACTIVE_VERSION]: { args: { sessionId: SID, versionId: 'v1' }, refused: null },
  [IPC.CANVAS_REVIEW_GET_STATE]: { args: { sessionId: SID }, refused: null },
  [IPC.CANVAS_ANNOTATION_UPSERT]: {
    args: { sessionId: SID, draft: { scope: 'general', note: 'the header wraps', versionId: 'v1' } },
    refused: null,
  },
  [IPC.CANVAS_ANNOTATION_DELETE]: { args: { sessionId: SID, annotationId: 'a1' }, refused: null },
  [IPC.CANVAS_REVIEW_SUBMIT]: { args: { sessionId: SID, reviewId: 'R1', sketches: [], decision: 'reject' }, refused: null },
  [IPC.CANVAS_REVIEW_REOPEN]: { args: { sessionId: SID, canvasId: CID, reviewId: 'R1' }, refused: null },
  [IPC.CANVAS_REVIEW_MARK_SEEN]: { args: { sessionId: SID, canvasId: CID, annotationIds: ['a1'] }, refused: null },
  [IPC.CANVAS_COMPOSER_DRAFT_SET]: {
    args: { sessionId: SID, canvasId: CID, draft: { versionId: 'v1', text: 'half a note', images: [] } },
    refused: null,
  },
  [IPC.CANVAS_COMPOSER_DRAFT_CLEAR]: { args: { sessionId: SID, canvasId: CID }, refused: null },
  [IPC.CANVAS_ANNOTATION_REOPEN]: { args: { sessionId: SID, annotationId: 'a1' }, refused: null },
  [IPC.CANVAS_COMPLETE]: { args: { sessionId: SID, canvasId: CID }, refused: { ok: false, reason: NOT_APP_REASON } },
  [IPC.CANVAS_COMPLETE_FORCE]: { args: { sessionId: SID, canvasId: CID }, refused: { ok: false, reason: NOT_APP_REASON } },
  [IPC.CANVAS_DESCRIBE_FORCE_CLOSURES]: { args: { sessionId: SID, canvasId: CID }, refused: null },
  [IPC.CANVAS_COMPLETE_REOPEN]: { args: { sessionId: SID, canvasId: CID }, refused: { ok: false, reason: NOT_APP_REASON } },
  [IPC.CANVAS_EVIDENCE_CAPTURE]: {
    args: {
      sessionId: SID,
      canvasId: CID,
      versionId: 'v1',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      stamp: { viewport: { width: 10, height: 10, scrollX: 0, scrollY: 0, dpr: 1, zoom: 1 }, dialogs: [], fields: [] },
      trail: [],
    },
    refused: { ok: false, reason: 'not-owner' },
  },
  [IPC.CANVAS_EVIDENCE_DISCARD]: { args: { sessionId: SID, canvasId: CID, evidenceId: REQUEST_ID }, refused: { ok: false } },
  [IPC.CANVAS_EVIDENCE_READ]: { args: { sessionId: SID, canvasId: CID, path: 'evidence/shot-one.png' }, refused: null },
  [IPC.CANVAS_SET_PACK_NAME]: { args: { sessionId: SID, canvasId: CID, versionId: 'v1', name: 'Checkout pack' }, refused: null },
  [IPC.CANVAS_SNAPSHOT_RESULT]: { args: { requestId: REQUEST_ID, ok: false, error: 'frame gone' }, refused: undefined },
  [IPC.CANVAS_CLAUDE_MARKER_ANSWER]: { args: { requestId: REQUEST_ID, ok: true }, refused: undefined },
}
const CHANNELS = Object.keys(ROWS)

const mainFrame = { name: 'main' }
let sent: Array<{ channel: string; payload: unknown }> = []
const webContents = { mainFrame, send: (channel: string, payload: unknown) => { sent.push({ channel, payload }) } }
let destroyed = false
const win = { isDestroyed: () => destroyed, webContents }
/** Read by main's getter at call time: null is "no window" (none yet, or a closed one not re-created). */
let current: typeof win | null = win

const APP = { sender: webContents, senderFrame: mainFrame }
/** Every frame shape that is not the app window's main frame. */
const FOREIGN = notAppMainFrameEvents(webContents)

function call(channel: string, event: unknown): unknown {
  const fn = h.handlers.get(channel) ?? h.listeners.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return fn(event, ROWS[channel].args)
}

/** Every string the request carries, for the "no part of the request is logged" check. */
function requestStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.length >= 3 ? [value] : []
  if (Array.isArray(value)) return value.flatMap(requestStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(requestStrings)
  return []
}

const refusalLines = () => h.logs.filter((l) => l.includes('not the app window'))

beforeEach(() => {
  h.handlers.clear()
  h.listeners.clear()
  _resetSnapshotBrokerForTest()
  _resetClaudeMarkerTypingForTest()
  destroyed = false
  current = win
  sent = []
  registerCanvasHandlers(() => current as never)
  h.calls.length = 0
  h.logs.length = 0
})

describe('every canvas channel answers only the app window', () => {
  it('the table covers every channel the file registers', () => {
    const registered = [...h.handlers.keys(), ...h.listeners.keys()].sort()
    expect(registered).toEqual([...CHANNELS].sort())
  })

  it.each(CHANNELS)('%s: the app window main frame is served', async (channel) => {
    const answer = await call(channel, APP)
    expect(refusalLines()).toEqual([])
    // Served: the request reached a collaborator, or was answered something
    // other than the refusal.
    const reached = h.calls.length > 0
    expect(reached || JSON.stringify(answer) !== JSON.stringify(ROWS[channel].refused), channel).toBe(true)
  })

  it.each(CHANNELS)('%s: any other sender or frame is refused, and nothing is reached', async (channel) => {
    for (const [shape, event] of FOREIGN) {
      expect(await call(channel, event), shape).toEqual(ROWS[channel].refused)
    }
    expect(h.calls).toEqual([])
    expect(refusalLines().length).toBe(FOREIGN.length)
  })

  it.each(CHANNELS)('%s: a refused request is answered before its payload is read', async (channel) => {
    const fn = h.handlers.get(channel) ?? h.listeners.get(channel)
    await expect(Promise.resolve(fn!(FOREIGN[0][1], { not: 'a valid payload' }))).resolves.toEqual(ROWS[channel].refused)
    await expect(Promise.resolve(fn!(FOREIGN[2][1], undefined))).resolves.toEqual(ROWS[channel].refused)
    expect(h.calls).toEqual([])
  })

  it.each(CHANNELS)('%s: a destroyed window, or no window at all, is refused', async (channel) => {
    destroyed = true
    expect(await call(channel, APP)).toEqual(ROWS[channel].refused)
    destroyed = false
    current = null
    expect(await call(channel, APP)).toEqual(ROWS[channel].refused)
    expect(h.calls).toEqual([])
    current = win
    h.logs.length = 0
    await call(channel, APP)
    expect(refusalLines()).toEqual([])
  })

  it.each(CHANNELS)('%s: a refusal writes one warning line, which carries no part of the request', async (channel) => {
    await call(channel, FOREIGN[0][1])
    expect(h.logs.length).toBe(1)
    expect(h.logs[0]).toMatch(/^WARN \[canvas\] .*refused: not the app window$/)
    for (const part of requestStrings(ROWS[channel].args)) expect(h.logs[0]).not.toContain(part)
  })

  it('the snapshot reply from the app main frame still completes the request; another frame cannot answer it', async () => {
    const pending = requestCanvasSnapshot({ sessionId: SID, canvasId: CID, versionId: 'v1', options: {} })
    const pushed = sent.find((s) => s.channel === IPC.CANVAS_SNAPSHOT_REQUEST)
    expect(pushed).toBeDefined()
    const { requestId } = pushed!.payload as { requestId: string }
    const reply = {
      requestId,
      ok: true,
      result: { viewport: { width: 800, height: 600, dpr: 1 }, root: { ref: 'e0', role: 'document', name: 'ok', box: {}, children: [] } },
    }
    const onReply = h.listeners.get(IPC.CANVAS_SNAPSHOT_RESULT)!
    // A reply from any other sender or frame is dropped: the request stays open.
    for (const [, event] of FOREIGN) onReply(event, { ...reply, result: { ...reply.result, root: { ...reply.result.root, name: 'other-frame' } } })
    // The app's own reply completes it.
    onReply(APP, reply)
    await expect(pending).resolves.toMatchObject({ root: { name: 'ok' } })
  })

  it('a Claude marker request goes to the app window; only its main frame can answer it', async () => {
    const pending = askClaudePrompt(SID, 'type', 'Approved v1 on the canvas', 'marker-1')
    const pushed = sent.find((s) => s.channel === IPC.CANVAS_CLAUDE_MARKER_ASK)
    expect(pushed).toBeDefined()
    expect(pushed!.payload).toMatchObject({ sessionId: SID, markerId: 'marker-1', mode: 'type', line: 'Approved v1 on the canvas' })
    const { requestId } = pushed!.payload as { requestId: string }
    const onAnswer = h.listeners.get(IPC.CANVAS_CLAUDE_MARKER_ANSWER)!
    // An answer from any other sender or frame is dropped: the request stays open.
    for (const [, event] of FOREIGN) onAnswer(event, { requestId, ok: true, reason: 'other-frame' })
    onAnswer(APP, { requestId, ok: true })
    await expect(pending).resolves.toEqual({ requestId, ok: true })
  })
})
