/**
 * 2.1.3-beta.19 fix round, item CONPTY (published beta.18 control): a new
 * Codex tab the session helper could not hold started the usual way, and
 * nothing on the tab said so; only the log did ("starting it the usual way,
 * because the helper could not hold it: the bundled ConPTY beside the helper
 * is not available (...)"). A tab now says so in one plain line before its
 * program's output; a run of the app's own (Insights' report), whose output
 * is read, never gets the line; nor does a terminal that starts nothing.
 *
 * PURE: the real HelperPty with a driver whose hold fails, and a stand-in for
 * the usual-way terminal.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { IPty } from 'node-pty'
import { HelperPty, NothingStartedError, notHeldLine, type HelperPtyDriver } from '../../../src/main/session-helper/helper-pty'
import { heldSessionId } from '../../../src/main/session-helper/protocol'

/** What the manager's hold throws (manager.ts); the HelperPty's log line puts 'the helper could not hold it: ' before it. */
const WHY = "the bundled ConPTY beside the helper is not available (the bundled ConPTY's copy is in use by a running session (or cannot be removed), so it is not replaced now: EPERM: operation not permitted, unlink 'C:\\Users\\someone\\AppData\\Local\\AI Code Conductor\\helper\\0.1.0-1edd29551e80\\conpty\\conpty.dll')"

function usualWay(): IPty & { said: (d: string) => void } {
  const data: Array<(d: string) => void> = []
  return {
    pid: 1, process: 'codex.exe', cols: 80, rows: 24, handleFlowControl: false,
    onData: (cb: (d: string) => void) => { data.push(cb); return { dispose: () => {} } },
    onExit: () => ({ dispose: () => {} }),
    write: () => {}, resize: () => {}, clear: () => {}, pause: () => {}, resume: () => {}, kill: () => {},
    said: (d: string) => { for (const cb of data) cb(d) },
  } as unknown as IPty & { said: (d: string) => void }
}

async function until(ok: () => boolean, what: string): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

function terminal(hold: HelperPtyDriver['hold'], extra: Partial<HelperPtyDriver>) {
  const seen: string[] = []
  const direct = usualWay()
  const app = 'abcdef0123456789abcdefc0'
  const p = new HelperPty({
    sid: heldSessionId(app),
    label: app,
    spec: { argv: ['C:\\codex.exe'], cwd: 'C:\\Users\\someone', env: {}, cols: 80, rows: 24 },
    driver: { hold, connect: async () => { throw new Error('no holder') }, direct: () => direct, ending: () => {}, attachedChanged: () => {}, log: () => {}, ...extra },
  })
  p.onData((d) => seen.push(d))
  return { p, seen, direct }
}

describe('a tab the session helper could not hold says so in one line', () => {
  it('the line comes first, then the program\'s own output; it names the reason without its bracketed detail', async () => {
    const { p, seen, direct } = terminal(async () => { throw new Error(WHY) }, { notHeldNote: true })
    await until(() => !p.throughHelper, 'the usual way')
    direct.said('codex draws')
    expect(seen).toEqual([notHeldLine(`the helper could not hold it: ${WHY}`), 'codex draws'])
    expect(seen[0]).toBe('\r\n[Not held by the session helper: the bundled ConPTY beside the helper is not available. This tab runs the usual way and ends when the app closes.]\r\n')
    expect(seen[0]).not.toContain('EPERM')
    expect(seen[0]).not.toContain('C:\\')
  })

  it('a reason that is already a sentence (the helper\'s own, when its set-up failed while the tab waited) ends in one full stop, not two', () => {
    expect(notHeldLine('the helper could not hold it: The session helper is not part of this installation.')).toBe('\r\n[Not held by the session helper: The session helper is not part of this installation. This tab runs the usual way and ends when the app closes.]\r\n')
    expect(notHeldLine('the helper could not hold it: The session helper copy on this computer does not match the one installed with the app, so nothing is started through it.  ')).not.toContain('..')
  })

  it('a run of the app\'s own (no notHeldNote) gets no line: its output is the program\'s only', async () => {
    const { p, seen, direct } = terminal(async () => { throw new Error(WHY) }, {})
    await until(() => !p.throughHelper, 'the usual way')
    direct.said('report output')
    expect(seen).toEqual(['report output'])
  })

  it('a terminal that starts nothing gets no such line', async () => {
    const { p, seen } = terminal(async () => { throw new NothingStartedError('it was ended before its holder started') }, { notHeldNote: true })
    await until(() => !p.throughHelper, 'the hand-over')
    expect(seen.join('')).not.toContain('Not held by the session helper')
  })

  it('the manager asks for it for a tab, a Claude Code or Codex tab and a plain terminal, and never for a run of the app\'s own', () => {
    const manager = readFileSync(join(__dirname, '../../../src/main/session-helper/manager.ts'), 'utf8')
    const agent = manager.slice(manager.indexOf('  spawnAgent(ctx'), manager.indexOf('  spawnAgent(ctx') + 6000)
    expect(agent).toContain("...(ctx.run === true ? {} : { notHeldNote: true as const })")
    const plain = manager.slice(manager.indexOf('  spawn(ctx: PlainSpawnContext'), manager.indexOf('  spawnAgent(ctx'))
    expect(plain).toContain('driver: { ...this.plainDriver(direct, true), notHeldNote: true }')
  })
})
