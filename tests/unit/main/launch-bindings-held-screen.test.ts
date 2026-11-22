// 2.1.3-beta.14 B2 (aicc_planning#388): bindCodexPane hands a held run's
// screen read to the Codex run screen, so a held Codex session's composer
// rule reads its holder's screen and main opens no pane for it. The real
// HelperPty and HolderConnection against the fake holder, the real run
// screen (providers/codex/session-screen.ts), and the run's data fed to it as
// pty-manager.ts's Codex data handler feeds it (the colour filter, then the
// run screen).
//
// The cases:
//  1. a run node-pty started gets its pane at once, with no `held`, as before;
//  2. a run on a holder whose connection acked `screen` and `title`: no pane,
//     and the rule's reads are the holder's `screen.read`, title included;
//  3. a holder that offers no screen reads: the pane, opened at the first
//     byte, holds that byte;
//  4. a launch that falls back to a direct terminal (the helper could not
//     hold it): the pane, opened at its first byte, holds that byte;
//  5. a held run's colour answers are still main's.
//
// Not checked here: which sessions' connections ask for the screen
// (tests/unit/main/session-helper-agent-screen.test.ts), and the rule's reading
// of the holder's answer (tests/unit/main/codex-held-screen.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'

const h = vi.hoisted(() => ({ infos: [] as string[] }))

vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: false } }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  removeLocalSessionSettings: () => {}, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: (m: string) => { h.infos.push(m) }, logWarn: () => {}, logError: () => {} }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => ({}) }))
vi.mock('../../../src/main/path-utils', () => ({ isHomeOrAncestor: () => false }))
vi.mock('../../../src/main/account-color', () => ({ decorateStatuslineWithColour: (d: unknown) => d }))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({ clampAnsiChunk: (d: string) => d }))
vi.mock('../../../src/main/logging/should-register-run', () => ({ shouldRegisterRun: () => false }))
vi.mock('../../../src/main/logging/indexing-gaps', () => ({ openNotIndexedWindow: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null }))
vi.mock('../../../src/main/logging/codex-log-binder', () => ({ getCodexLogBinder: () => null }))
vi.mock('../../../src/main/spawn-claude-command', () => ({ buildResumeTranscriptPath: () => null }))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, getAccountIdentity: () => null,
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  registerCodexReviewSession: () => {}, registerClaudeReviewSession: () => {}, unregisterCodexReviewSession: () => {}, releaseMcpSessionProvider: () => {},
}))
vi.mock('../../../src/main/canvas/canvas-store', () => ({
  registerCanvasUatRoot: () => true, revokeCanvasUatRoots: () => {}, designateCanvasWorktreeRoot: () => true,
  canvasRootRefusalReason: () => null, describeCanvasRootRefusal: () => '', setCanvasRootRefusal: () => {},
}))
vi.mock('../../../src/main/canvas/canvas-marker-delivery', () => ({ forgetCanvasMarkers: () => {} }))
vi.mock('../../../src/main/canvas/codex-canvas-roots', () => ({ registerCodexCanvasRoots: () => {} }))
vi.mock('../../../src/main/canvas/codex-guidance', () => ({ noteCodexSessionGuidance: () => {}, forgetCodexSessionGuidance: () => {} }))

const lb = await import('../../../src/main/sessions/launch-bindings')
const screen = await import('../../../src/main/providers/codex/session-screen')
const { HelperPty } = await import('../../../src/main/session-helper/helper-pty')
const { HolderConnection } = await import('../../../src/main/session-helper/connection')
const { heldAgentSessionId } = await import('../../../src/main/session-helper/protocol')
const { FakeHolder } = await import('./session-helper-fake-holder')
type HolderRecord = import('../../../src/main/session-helper/protocol').HolderRecord
type HelperPtyDriver = import('../../../src/main/session-helper/helper-pty').HelperPtyDriver
type Ports = Parameters<typeof lb.setLaunchBindingPorts>[0]

const SID = 'abcdef0123456789abcdef9a'
const ptySessions = new Map<string, { ptyProcess: unknown }>()
const runScreen = {
  open: screen.openCodexScreen, feed: screen.feedCodexScreen, resize: screen.resizeCodexScreen,
  close: screen.closeCodexScreen, has: screen.hasCodexScreen, submit: screen.submitCodexText,
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}

/** A terminal the usual way whose output the test writes. */
function emittingDirect() {
  const listeners: Array<(d: string) => void> = []
  const inner = {
    pid: 7, cols: 100, rows: 30, process: 'codex', handleFlowControl: false,
    onData: (l: (d: string) => void) => { listeners.push(l); return { dispose() {} } },
    onExit: () => ({ dispose() {} }), resize() {}, clear() {}, write() {}, kill() {}, pause() {}, resume() {},
  } as unknown as IPty
  return { inner, emit: (d: string) => { for (const l of listeners) l(d) } }
}

const folders: string[] = []
const holders: InstanceType<typeof FakeHolder>[] = []
const conns: InstanceType<typeof HolderConnection>[] = []

/** A Codex run through one fake holder offering `caps`, as the manager's
 *  driver starts one; `screenAsk` is what its connections ask for. A `hold`
 *  that throws is a launch the helper could not hold. */
function heldRun(o: { caps: string[]; screenAsk: boolean; holdThrows?: boolean }) {
  const store = mkdtempSync(join(tmpdir(), 'aicc-held-screen-'))
  folders.push(store)
  const holder = new FakeHolder(heldAgentSessionId(SID, 'codex'), SID, store)
  holder.caps = o.caps
  holders.push(holder)
  const direct = emittingDirect()
  const driver: HelperPtyDriver = {
    hold: async () => {
      if (o.holdThrows) throw new Error('the helper is not installed')
      holder.writeRecord()
      return holder.record()
    },
    connect: async (record: HolderRecord) => {
      const c = await HolderConnection.open({
        record, os: 'windows', openStream: async () => holder.connect(), replyTimeoutMs: 2000, pingEveryMs: 0,
        ...(o.screenAsk ? { screen: true, title: true } : {}),
      })
      conns.push(c)
      return c
    },
    direct: () => direct.inner,
    ending: () => {}, attachedChanged: () => {}, log: () => {},
  }
  const p = new HelperPty({ sid: holder.sid, label: SID, spec: { argv: ['C:\\Users\\someone\\bin\\codex.exe'], cwd: 'C:\\Users\\someone\\project', env: { Path: 'C:\\Windows' }, cols: 100, rows: 30 }, driver })
  return { holder, p, direct }
}

/** bindCodexPane for `run`, and its output fed as pty-manager.ts feeds it. */
function bind(run: IPty, colourAnswers: string[] = []) {
  ptySessions.set(SID, { ptyProcess: run })
  const colours = lb.bindCodexPane({ sessionId: SID, codexRun: run, runScreen, cols: 100, rows: 30, write: (d) => run.write(d), writeColourAnswer: (b) => { colourAnswers.push(b) } })
  run.onData((raw) => {
    const data = colours.filter(raw)
    if (data === '') return
    runScreen.feed(SID, data)
  })
  return colours
}

beforeEach(() => {
  h.infos.length = 0
  ptySessions.clear()
  lb.setLaunchBindingPorts({ ptySessions } as unknown as Ports)
})

afterEach(async () => {
  screen._resetCodexScreensForTest()
  for (const x of holders.splice(0)) x.vanish()
  for (const c of conns.splice(0)) c.close()
  await tick(10)
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

const HELD_LINE = `[codex-screen] ${SID}: held by the session helper, so its composer rule reads the holder's screen and no pane is opened`
const PANE_LINE = `[codex-screen] ${SID}: not on a holder that reads its screen (started the usual way, or its holder reads none), so main's own pane is opened before its first byte`

describe('the run screen bindCodexPane opens', () => {
  it('1. a run node-pty started: its pane at once, with no `held`, as before', () => {
    const opened: Array<Record<string, unknown>> = []
    const direct = emittingDirect()
    ptySessions.set(SID, { ptyProcess: direct.inner })
    lb.bindCodexPane({ sessionId: SID, codexRun: direct.inner, runScreen: { ...runScreen, open: (sid: string, o: Parameters<typeof screen.openCodexScreen>[1]) => { opened.push(o); screen.openCodexScreen(sid, o) } }, cols: 100, rows: 30, write: () => {}, writeColourAnswer: () => {} })
    expect(opened).toHaveLength(1)
    expect('held' in opened[0]).toBe(false)
    expect(screen.readCodexSessionScreen(SID)).toHaveLength(30)
  })

  it('2. a run on a holder whose connection acked screen and title: no pane, and the rule reads the holder\'s screen.read', async () => {
    const { holder, p } = heldRun({ caps: ['core', 'local', 'screen', 'title'], screenAsk: true })
    bind(p)
    expect(screen.hasCodexScreen(SID)).toBe(true)
    await until(() => p.isAttached, 'the run to attach')
    expect(holder.attached!.ackedCaps).toEqual(['core', 'local', 'screen', 'title'])
    holder.output('Codex is starting\r\n')
    await until(() => h.infos.includes(HELD_LINE), 'the first byte')
    expect(screen.readCodexSessionScreen(SID)).toBeNull()
    const shot = await screen.readCodexScreenOnce(SID)
    expect(holder.screenReads).toBe(1)
    // The fake holder's rows are blank, at the launch's size, and it sets no title.
    expect(shot!.lines).toHaveLength(30)
    expect(shot!.title).toBeNull()
    expect(h.infos).not.toContain(PANE_LINE)
  })

  it('3. a holder that offers no screen reads: the pane, opened at the first byte, holds that byte', async () => {
    const { holder, p } = heldRun({ caps: ['core', 'local'], screenAsk: true })
    bind(p)
    await until(() => p.isAttached, 'the run to attach')
    expect(holder.attached!.ackedCaps).toEqual(['core', 'local'])
    holder.output('FIRST BYTES of the run')
    await until(() => h.infos.includes(PANE_LINE), 'the first byte')
    expect(await screen.settleCodexScreen(SID)).toBe(true)
    expect(screen.readCodexSessionScreen(SID)![0].text).toBe('FIRST BYTES of the run')
    expect(holder.screenReads).toBe(0)
  })

  it('4. a launch that falls back to a direct terminal: the pane, opened at its first byte, holds that byte', async () => {
    const { p, direct } = heldRun({ caps: ['core', 'local', 'screen', 'title'], screenAsk: true, holdThrows: true })
    bind(p)
    await until(() => !p.throughHelper, 'the fall back')
    expect(p.screenRead).toBeUndefined()
    direct.emit('FIRST BYTES of the direct run')
    expect(h.infos).toContain(PANE_LINE)
    expect(await screen.settleCodexScreen(SID)).toBe(true)
    expect(screen.readCodexSessionScreen(SID)![0].text).toBe('FIRST BYTES of the direct run')
  })

  it('5. a held run\'s colour answers are still main\'s, written into the run', async () => {
    const { holder, p } = heldRun({ caps: ['core', 'local', 'screen', 'title'], screenAsk: true })
    const answers: string[] = []
    bind(p, answers)
    await until(() => p.isAttached, 'the run to attach')
    holder.output('\x1b]11;?\x07')
    await until(() => answers.length === 1, 'the colour answer')
    expect(answers[0].startsWith('\x1b]11;rgb:')).toBe(true)
    // What the filter passes on in the query's place is the run's first byte.
    await until(() => h.infos.includes(HELD_LINE), 'the first byte')
    expect(screen.readCodexSessionScreen(SID)).toBeNull()
  })
})
