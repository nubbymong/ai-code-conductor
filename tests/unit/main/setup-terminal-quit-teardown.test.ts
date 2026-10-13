// [host] The first-run Claude Code setup terminal (setup-handlers.ts,
// cliSetupPty) is main's own, outside pty-manager, so killAllPty never reached
// it. Only the setup screen's own ways out (Skip for now, Finish, Exit, and its
// Close, which runs Exit) stopped it, through setup:killCliSetup. Alt+F4, the
// taskbar close, Cmd+Q and the macOS red button reached the app's quit (or the
// macOS last-window sweep) without that stop, and left the terminal to process
// exit. The quit teardown and the sweep now call killCliSetupPty.
//
// The stop runs before killAllPty in both places,
// so a throw there cannot skip it, and an earlier terminal's late exit no
// longer drops a newer terminal from the slot (the stop would then miss it).
//
// index.ts cannot be imported in a unit test (it boots the app), so the quit
// teardown and the window-all-closed callback are cut out of its source,
// type-stripped with esbuild and run against fakes, as
// app-lifecycle-wiring.test.ts does. The kill they call is the REAL one, on the
// real setup-handlers module; only its PTY, the Claude Code resolution and the
// first-start warm-up are faked. Nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const RESOLVED = 'C:\\Users\\A\\.local\\bin\\claude.exe'
type FakePty = { onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }
const h = vi.hoisted(() => ({
  ptys: [] as FakePty[],
  killThrows: false,
  warm: 0,
  gate: null as null | Promise<void>,
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: () => os.tmpdir() },
}))
vi.mock('node-pty', () => ({
  spawn: () => {
    const p = {
      onData: vi.fn(), onExit: vi.fn(), write: vi.fn(),
      kill: vi.fn(() => { if (h.killThrows) throw new Error('the terminal has already gone') }),
    }
    h.ptys.push(p)
    return p
  },
}))
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: RESOLVED, args: [] }) }))
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null }))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/claude-cli-probe', () => ({ probeClaudeCli: vi.fn(), CLAUDE_WINDOWS_NAMES: ['claude.exe', 'claude.cmd', 'claude.bat'] }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/data-paths', () => ({
  getDataDirectory: () => os.tmpdir(), getResourcesDirectory: () => os.tmpdir(),
  setDataDirectory: vi.fn(), setResourcesDirectory: vi.fn(), isDataDirFromRegistry: () => true,
}))
vi.mock('../../../src/main/first-start-warmup', () => ({
  warmFirstStart: async () => {
    h.warm++
    if (h.gate) await h.gate
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
}))

// The quit hold is the real one (quit-hold.ts).
const { beginQuitHold, _resetQuitHoldForTest } = await import('../../../src/main/quit-hold')

// The shared test setup replaces setup-handlers with a stub; this suite drives the real one.
const real = await vi.importActual<typeof import('../../../src/main/ipc/setup-handlers')>('../../../src/main/ipc/setup-handlers')
real.registerSetupHandlers()
const spawnCliSetup = h.handlers.get('setup:spawnCliSetup')!
const killCliSetupIpc = h.handlers.get('setup:killCliSetup')!

// --- index.ts, cut out and run ---------------------------------------------

const INDEX = fs.readFileSync(path.resolve(process.cwd(), 'src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The text from `from` to the brace that closes the block opened by the
 *  first `{` at or after `from`. Strings, template literals and comments are
 *  skipped. */
function block(src: string, from: number): string {
  let i = src.indexOf('{', from)
  expect(i, 'an opening brace').toBeGreaterThan(-1)
  let depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(from, i + 1) }
  }
  throw new Error('unbalanced braces')
}

/** A stand-in for every other service the code calls: any property, any call,
 *  answers itself (so `getGateway()?.stop().catch(...)` runs), never a promise. */
function inert(): unknown {
  const f: unknown = new Proxy(() => {}, { get: (_t, k) => (k === 'then' ? undefined : f), apply: () => f })
  return f
}

/** Compile an arrow cut from the source and evaluate it with `fakes`; every
 *  other name it uses gets an inert stand-in, so a teardown step another change
 *  adds does not break this suite. */
function run<T>(code: string, fakes: Record<string, unknown>): T {
  const globals: Record<string, unknown> = {}
  for (const name of new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    if (!(name in globalThis)) globals[name] = inert()
  }
  const js = transformSync(`(${code})`, { loader: 'ts', target: 'es2022', format: 'esm' }).code
  return vm.runInContext(js, vm.createContext({ ...globals, console, ...fakes })) as T
}

const TEARDOWN = (() => {
  const marker = 'quitTeardown = '
  const at = INDEX.indexOf(`${marker}() => {`)
  expect(at, 'the quit teardown').toBeGreaterThan(-1)
  return block(INDEX, at + marker.length)
})()

/** Runs the quit teardown once; returns, in order, the PTY kills and the
 *  debug logger's close it made. killCliSetupPty is the real one. With
 *  `withFlush`, the provider CLI flush sets the real quit hold, as its
 *  flush of the first-start warm-ups does (quit-hold.test.ts). */
function quitTeardown(withFlush = false): string[] {
  const order: string[] = []
  run<() => void>(TEARDOWN, {
    killAllPty: () => { order.push('killAllPty') },
    killCliSetupPty: () => { order.push('killCliSetupPty'); real.killCliSetupPty() },
    closeDebugLogger: () => { order.push('closeDebugLogger') },
    ...(withFlush ? { flushPendingProviderCliKills: () => { order.push('flushPendingProviderCliKills'); beginQuitHold() } } : {}),
  })()
  return order
}

/** 'pending' when `p` has not settled once every step it could take has run. */
async function stateOf(p: unknown): Promise<'pending' | 'settled'> {
  return Promise.race([Promise.resolve(p).then(() => 'settled' as const, () => 'settled' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), 20))])
}

const started = async () => {
  expect(await spawnCliSetup({ sender: {} }, 100, 20)).toBe('__cli_setup__')
  expect(h.ptys).toHaveLength(1)
  expect(real.countCliSetupInUse()).toBe(1)
  return h.ptys[0]
}

beforeEach(async () => {
  // A terminal an earlier case started is ended first (the in-page route), so
  // each case starts with none.
  h.killThrows = false
  await killCliSetupIpc({ sender: {} })
  h.ptys.length = 0; h.warm = 0; h.gate = null
  _resetQuitHoldForTest()
})

describe('quitting the app ends the Claude Code setup terminal, whatever closed the window', () => {
  it('a running setup terminal is killed exactly once by the quit teardown, before the debug logger closes', async () => {
    const pty = await started()
    const order = quitTeardown()
    expect(pty.kill).toHaveBeenCalledTimes(1) // beta.2: 0, left to process exit
    expect(real.countCliSetupInUse()).toBe(0)
    expect(order.filter((o) => o === 'killCliSetupPty')).toHaveLength(1)
    // Its "killed" line is written while the log is still open.
    expect(order.indexOf('killCliSetupPty')).toBeLessThan(order.indexOf('closeDebugLogger'))
    expect(order).toContain('killAllPty')
  })

  it('with no setup terminal running, the teardown asks nothing of node-pty and does not throw', () => {
    expect(() => quitTeardown()).not.toThrow()
    expect(h.ptys).toHaveLength(0)
    expect(real.countCliSetupInUse()).toBe(0)
  })

  it('the in-page Exit route still stops it, and the quit teardown after it kills nothing a second time', async () => {
    const pty = await started()
    // Exit (and Close, Skip for now, Finish): setup:killCliSetup.
    expect(await killCliSetupIpc({ sender: {} })).toBe(true)
    expect(pty.kill).toHaveBeenCalledTimes(1)
    expect(real.countCliSetupInUse()).toBe(0)
    // Then the window closes and the app quits.
    expect(() => quitTeardown()).not.toThrow()
    expect(pty.kill).toHaveBeenCalledTimes(1)
  })

  it('the kill is safe twice: a second call, or the in-page route after it, does not kill again', async () => {
    const pty = await started()
    quitTeardown()
    expect(() => real.killCliSetupPty()).not.toThrow()
    expect(await killCliSetupIpc({ sender: {} })).toBe(true)
    expect(pty.kill).toHaveBeenCalledTimes(1)
  })

  it('a terminal that has already gone (its kill throws) does not stop the rest of the teardown', async () => {
    h.killThrows = true
    const pty = await started()
    let order: string[] = []
    expect(() => { order = quitTeardown() }).not.toThrow()
    expect(pty.kill).toHaveBeenCalledTimes(1)
    expect(real.countCliSetupInUse()).toBe(0)
    expect(order.at(-1)).toBe('closeDebugLogger')
  })

  it('the teardown takes the kill from setup-handlers (the function these cases run)', () => {
    expect(INDEX).toMatch(/import \{[^}]*\bkillCliSetupPty\b[^}]*\} from '\.\/ipc\/setup-handlers'/)
  })

  it('a killAllPty that throws does not skip it: the setup terminal is stopped before killAllPty runs', async () => {
    const pty = await started()
    const order: string[] = []
    expect(() => run<() => void>(TEARDOWN, {
      killAllPty: () => { order.push('killAllPty'); throw new Error('a session would not end') },
      killCliSetupPty: () => { order.push('killCliSetupPty'); real.killCliSetupPty() },
      closeDebugLogger: () => { order.push('closeDebugLogger') },
    })()).toThrow('a session would not end')
    expect(pty.kill).toHaveBeenCalledTimes(1) // before this change: 0, the throw came first
    expect(real.countCliSetupInUse()).toBe(0)
    expect(order.slice(0, 2)).toEqual(['killCliSetupPty', 'killAllPty'])
  })
})

describe('an earlier setup terminal\'s late exit does not drop the one running now', () => {
  // On macOS: the red button on the setup screen ends terminal A (the
  // window-all-closed sweep), the Dock icon opens a new window, and its setup
  // screen starts terminal B. A's exit, which node-pty reports after the kill,
  // must not drop B from the slot, or the quit teardown cannot reach B.
  const exitOf = (p: FakePty) => p.onExit.mock.calls[0][0] as (e: { exitCode: number }) => void

  it('the quit teardown still kills the newer terminal', async () => {
    const first = await started()
    real.killCliSetupPty()
    expect(first.kill).toHaveBeenCalledTimes(1)
    expect(await spawnCliSetup({ sender: {} }, 100, 20)).toBe('__cli_setup__')
    expect(h.ptys).toHaveLength(2)
    const second = h.ptys[1]
    exitOf(first)({ exitCode: 0 })
    expect(real.countCliSetupInUse()).toBe(1) // before this change: 0, the newer terminal untracked
    quitTeardown()
    expect(second.kill).toHaveBeenCalledTimes(1) // before this change: 0, left running after the quit
    expect(real.countCliSetupInUse()).toBe(0)
  })

  it('a terminal\'s own exit still drops it, and the quit teardown then has nothing to kill', async () => {
    const pty = await started()
    exitOf(pty)({ exitCode: 0 })
    expect(real.countCliSetupInUse()).toBe(0)
    quitTeardown()
    expect(pty.kill).not.toHaveBeenCalled()
  })
})

describe.runIf(process.platform === 'win32')('a quit while the setup terminal\'s first start is being prepared (ADR-025)', () => {
  it('the start then starts nothing, so no terminal is left running after the teardown', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const start = spawnCliSetup({ sender: {} }, 100, 20)
    await vi.waitFor(() => expect(h.warm).toBe(1))
    quitTeardown()
    release()
    expect(await start).toBeNull() // beta.2: '__cli_setup__', a terminal started after the teardown
    expect(h.ptys).toHaveLength(0)
    expect(real.countCliSetupInUse()).toBe(0)
  })
})

// On macOS and Linux the setup terminal never asks for a warm-up, so the
// warm-up's latch alone would not hold it, and a start the renderer asked for
// after the teardown would make a terminal nothing would end. The quit hold,
// which the teardown's flush sets, holds it on every platform.
describe('a setup terminal asked for after the quit teardown starts nothing, on any platform', () => {
  const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  afterEach(() => { Object.defineProperty(process, 'platform', hostPlatform) })

  it.each(['linux', 'darwin', 'win32'])('%s: no terminal is made, and the start is never answered', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    expect(quitTeardown(true)).toContain('flushPendingProviderCliKills')
    const start = spawnCliSetup({ sender: {} }, 100, 20)
    expect(await stateOf(start)).toBe('pending') // the candidate: '__cli_setup__' on macOS and Linux
    expect(h.ptys).toHaveLength(0)
    expect(real.countCliSetupInUse()).toBe(0)
  })

  it('before the teardown, the same start on Linux makes its terminal (the control)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(await spawnCliSetup({ sender: {} }, 100, 20)).toBe('__cli_setup__')
    expect(h.ptys).toHaveLength(1)
  })
})

describe('macOS: the last window closing (the red button on a setup screen) ends the setup terminal too', () => {
  const marker = "app.on('window-all-closed', "
  const at = INDEX.indexOf(marker)

  it('the window-all-closed sweep kills a running setup terminal once, alongside killAllPty', async () => {
    expect(at, marker).toBeGreaterThan(-1)
    const pty = await started()
    const killAllPty = vi.fn()
    const onAllWindowsClosed = vi.fn((deps: { endStragglerPtys: () => void }) => { deps.endStragglerPtys(); return 'stay-resident' })
    run<() => void>(block(INDEX, at + marker.length), {
      onAllWindowsClosed, killAllPty, killCliSetupPty: () => real.killCliSetupPty(),
      process: { platform: 'darwin' }, app: { quit: vi.fn() },
    })()
    expect(onAllWindowsClosed).toHaveBeenCalledTimes(1)
    expect(killAllPty).toHaveBeenCalledTimes(1)
    expect(pty.kill).toHaveBeenCalledTimes(1) // beta.2: 0, running behind the empty Dock icon
    expect(real.countCliSetupInUse()).toBe(0)
  })

  it('a killAllPty that throws in the sweep does not skip the setup terminal', async () => {
    expect(at, marker).toBeGreaterThan(-1)
    const pty = await started()
    const onAllWindowsClosed = vi.fn((deps: { endStragglerPtys: () => void }) => { deps.endStragglerPtys(); return 'stay-resident' })
    expect(() => run<() => void>(block(INDEX, at + marker.length), {
      onAllWindowsClosed,
      killAllPty: () => { throw new Error('a session would not end') },
      killCliSetupPty: () => real.killCliSetupPty(),
      process: { platform: 'darwin' }, app: { quit: vi.fn() },
    })()).toThrow('a session would not end')
    expect(pty.kill).toHaveBeenCalledTimes(1) // before this change: 0, the throw came first
    expect(real.countCliSetupInUse()).toBe(0)
  })
})
