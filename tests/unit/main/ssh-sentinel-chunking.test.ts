// How the SSH sentinel parser treats the read
// boundaries of the byte stream and a sentinel that never ends.
//
// node-pty hands the SSH stream over in reads that can end anywhere. A status
// (`ESC ]9999;CMSTATUS=`) or attention (`ESC ]9999;CMATTN=`) sentinel cut
// inside its opening bytes is now held until the next read, so it is still
// taken (the status reaches the statusline, the attention event the
// indicator) and none of it, the attention nonce included, reaches the
// terminal. Bytes held that turn out to be no sentinel are passed on intact.
//
// An attention payload is at most 512 characters and is compact JSON, so it
// holds no control character. An attention opening with no BEL within that
// length, or with a control character (a line break, an escape) before its
// BEL, is no sentinel: its opening and the payload read so far are taken out,
// and every byte after that is terminal output again. Before, it held back
// everything up to the next BEL anywhere in the stream (up to 32 KiB). The
// same rule holds for a status opening, with 16 KiB.
//
// The real spawnPty SSH branch (node-pty and Electron faked) and the real
// attention source; the statusline dispatch is watched.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import * as os from 'os'

const h = vi.hoisted(() => ({
  ptys: [] as Array<{ emitData: (d: string) => void }>,
  sent: [] as Array<[string, unknown]>,
  /** Every status payload handed to the statusline, with the session it came from. */
  status: [] as Array<[string | undefined, string]>,
}))

vi.mock('node-pty', () => ({
  spawn: () => {
    const { EventEmitter } = require('events') as typeof import('events')
    const out = new EventEmitter()
    out.on('error', () => {})
    const dataCbs: Array<(d: string) => void> = []
    h.ptys.push({ emitData: (d: string) => { for (const cb of dataCbs) cb(d) } })
    return {
      pid: 4747,
      process: 'ssh',
      onData: (cb: (d: string) => void) => { dataCbs.push(cb); return { dispose: () => {} } },
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
      on: (ev: string, l: (...a: unknown[]) => void) => { out.on(ev, l) },
      _agent: { inSocket: new EventEmitter() },
    }
  },
}))
vi.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir(), getAppPath: () => process.cwd(), on: () => {}, quit: () => {}, isPackaged: false },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: true },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: () => {} },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => require('os').tmpdir(),
}))
vi.mock('../../../src/main/sentinel/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/sentinel/index')>()),
  sentinelObserve: () => {},
}))
vi.mock('../../../src/main/statusline-watcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/statusline-watcher')>()),
  dispatchSSHStatuslineUpdate: (json: string, fromSessionId?: string) => { h.status.push([fromSessionId, json]) },
}))

const { spawnPty, killPty, _getSshNonceForTest } = await import('../../../src/main/pty-manager')
const { registerProvider } = await import('../../../src/main/providers')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')
const { startAttentionSource, _resetAttentionSourceForTest } = await import('../../../src/main/attention-source')
const { remoteAttentionKey } = await import('../../../src/main/ssh-attention')

const sshProvider = Object.assign(Object.create(ClaudeProvider.prototype) as object, {
  id: 'claude', displayName: 'Claude',
  resolveBinary: () => null,
  buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  ingestSessionTelemetry: () => ({ stop() {} }),
  listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }),
  configureMcpServer: async () => {},
  getSshSettingsPath: () => '',
  getSshMcpConfigPath: () => '',
  configureRemoteSettings: () => '',
  deliverStatusline: () => {},
})
const fakeWin = { webContents: { send: (ch: string, d: unknown) => { h.sent.push([ch, d]) } }, isDestroyed: () => false } as never

const OWN = 'sshchunkowna00000001'
const ch = (code: number): string => String.fromCharCode(code)
const ESC = ch(27)
const BEL = ch(7)
const ATTN = `${ESC}]9999;CMATTN=`
const STATUS = `${ESC}]9999;CMSTATUS=`
/** The attention sentinel exactly as the remote hook writes it. */
const attention = (b: Record<string, unknown>): string => `${ATTN}${JSON.stringify(b)}${BEL}`
const pushed: Array<[string, boolean]> = []

beforeAll(() => { registerProvider(sshProvider as never) })
beforeEach(() => {
  h.sent.length = 0
  h.status.length = 0
  pushed.length = 0
  _resetAttentionSourceForTest()
  startAttentionSource({ push: (sid, v) => { pushed.push([sid, v]) } })
})
afterEach(() => { try { killPty(OWN) } catch { /* gone */ } })

/** A fresh SSH spawn of OWN (spawnPty ends any earlier one first), with
 *  nothing yet shown, pushed or dispatched. */
const spawnOwn = (): { emitData: (d: string) => void; nonce: string; key: string } => {
  spawnPty(fakeWin, OWN, { ssh: { username: 'me', host: 'example.com', port: 22, remotePath: '~' }, cwd: os.homedir() } as never)
  const p = h.ptys[h.ptys.length - 1]
  const nonce = _getSshNonceForTest(OWN)
  expect(nonce).toBeTruthy()
  h.sent.length = 0
  h.status.length = 0
  pushed.length = 0
  // The remote hook sends the attention key derived from the nonce, not the nonce.
  return { emitData: p.emitData, nonce: nonce!, key: remoteAttentionKey(nonce!) }
}
const shown = (): string => h.sent.filter(([c]) => c === `pty:data:${OWN}`).map(([, d]) => String(d)).join('')

describe('a sentinel cut by a read boundary', () => {
  // Mutation to prove this can fail: drop the hold of a trailing partial
  // opening (beta.2): a cut at bytes 1 to 13 loses the event and shows the
  // whole sentinel, nonce included.
  it('an attention sentinel cut at any byte, its opening included, is taken and none of it is shown', () => {
    const probe = spawnOwn()
    const len = attention({ s: OWN, n: probe.key, e: 'Notification', t: 'permission_prompt' }).length
    for (let cut = 1; cut < len; cut++) {
      const { emitData, nonce, key } = spawnOwn()
      const s = attention({ s: OWN, n: key, e: 'Notification', t: 'permission_prompt' })
      emitData(`x${s.slice(0, cut)}`)
      emitData(`${s.slice(cut)}y`)
      expect(pushed, `cut at ${cut}`).toEqual([[OWN, true]])
      expect(shown(), `cut at ${cut}`).toBe('xy')
      expect(shown().includes(nonce), `cut at ${cut}`).toBe(false)
    }
  })

  it('an attention sentinel read one byte at a time is taken and none of it is shown', () => {
    const { emitData, nonce, key } = spawnOwn()
    const s = attention({ s: OWN, n: key, e: 'Notification', t: 'idle_prompt' })
    emitData('x')
    for (const c of s) emitData(c)
    emitData('y')
    expect(pushed).toEqual([[OWN, true]])
    expect(shown()).toBe('xy')
  })

  // Mutation to prove this can fail: as above, for the status opening.
  it('a status sentinel cut at any byte of its opening or payload reaches the statusline once and none of it is shown', () => {
    const json = JSON.stringify({ sessionId: OWN, model: 'm' })
    const s = `${STATUS}${json}${BEL}`
    for (let cut = 1; cut < s.length; cut++) {
      const { emitData } = spawnOwn()
      emitData(`x${s.slice(0, cut)}`)
      emitData(`${s.slice(cut)}y`)
      expect(h.status, `cut at ${cut}`).toEqual([[OWN, json]])
      expect(shown(), `cut at ${cut}`).toBe('xy')
    }
  })

  it('a sentinel cut inside its opening, behind other output in the same read, is taken after that output is shown', () => {
    const { emitData, nonce, key } = spawnOwn()
    const s = attention({ s: OWN, n: key, e: 'Notification', t: 'agent_needs_input' })
    emitData(`line one\r\nline two${s.slice(0, 5)}`)
    expect(shown()).toBe('line one\r\nline two')
    emitData(`${s.slice(5)}after`)
    expect(pushed).toEqual([[OWN, true]])
    expect(shown()).toBe('line one\r\nline twoafter')
  })

  // A guard on the hold itself. Mutation to prove this can fail: drop the
  // held bytes instead of putting them back in front of the next read.
  it('bytes held because they might open a sentinel are passed on intact, in order, when they do not', () => {
    const cases: Array<[string, string]> = [
      [`a${ESC}]9999;CM`, `X=1${BEL}b`],
      [`a${ESC}]9999;CMATTN`, `X${BEL}b`],
      [`a${ESC}]9999;CMSTATUS`, `:z${BEL}b`],
      [`a${ESC}]`, `0;title${BEL}b`],
      [`a${ESC}`, '[31mred'],
      [`a${ESC}]9`, `;notify${BEL}b`],
    ]
    for (const [first, second] of cases) {
      const { emitData } = spawnOwn()
      emitData(first)
      emitData(second)
      expect(shown(), JSON.stringify(first)).toBe(first + second)
      expect(pushed, JSON.stringify(first)).toEqual([])
      expect(h.status, JSON.stringify(first)).toEqual([])
    }
  })
})

describe('an attention opening that is not a sentinel', () => {
  // A line break before any BEL. Mutation to prove this can fail: drop the control
  // character check (the question is held to the title's BEL and dropped).
  it('an opening with no BEL before a line break: the question that follows is shown', () => {
    const { emitData } = spawnOwn()
    emitData(`file line\r\n${ATTN}`)
    emitData('\r\n Do you want to proceed?\r\n > 1. Yes\r\n')
    emitData(`${ESC}]0;title${BEL}after`)
    expect(shown()).toBe(`file line\r\n\r\n Do you want to proceed?\r\n > 1. Yes\r\n${ESC}]0;title${BEL}after`)
    expect(pushed).toEqual([])
  })

  it('an opening followed by another escape before any BEL: the escape and what follows are shown', () => {
    const { emitData } = spawnOwn()
    emitData(`a${ATTN}junk${ESC}[31mred${BEL}`)
    expect(shown()).toBe(`a${ESC}[31mred${BEL}`)
  })

  // Mutation to prove this can fail: drop the 512-character cap (beta.2 held
  // up to 32 KiB, and then dropped it all).
  it('an opening with no BEL within the longest valid payload: the bytes past it are shown at once', () => {
    const { emitData } = spawnOwn()
    emitData(`a${ATTN}${'z'.repeat(600)}b`)
    expect(shown()).toBe(`a${'z'.repeat(88)}b`)
    // The same across several reads.
    const second = spawnOwn()
    second.emitData(`a${ATTN}`)
    second.emitData('z'.repeat(300))
    expect(shown()).toBe('a')
    second.emitData('z'.repeat(300))
    expect(shown()).toBe(`a${'z'.repeat(88)}`)
    second.emitData('b')
    expect(shown()).toBe(`a${'z'.repeat(88)}b`)
  })

  it('a payload of exactly 512 characters is still a sentinel; one of 513 is not, and its excess is shown', () => {
    const body = (nonce: string, pad: number): Record<string, unknown> => ({ s: OWN, n: nonce, e: 'Notification', t: 'permission_prompt', p: 'z'.repeat(pad) })
    const at512 = spawnOwn()
    const base = JSON.stringify(body(at512.key, 0)).length
    const fits = attention(body(at512.key, 512 - base))
    expect(fits.length - ATTN.length - 1).toBe(512)
    at512.emitData(`x${fits}y`)
    expect(pushed).toEqual([[OWN, true]])
    expect(shown()).toBe('xy')

    const at513 = spawnOwn()
    const over = attention(body(at513.key, 513 - base))
    expect(over.length - ATTN.length - 1).toBe(513)
    at513.emitData(`x${over}y`)
    expect(pushed).toEqual([])
    expect(shown()).toBe(`x}${BEL}y`)
    expect(shown().includes(at513.nonce)).toBe(false)
  })

  it('a real sentinel right after one that is not is still taken', () => {
    const { emitData, nonce, key } = spawnOwn()
    emitData(`${ATTN}\r\n${attention({ s: OWN, n: key, e: 'Notification', t: 'elicitation_dialog' })}z`)
    expect(pushed).toEqual([[OWN, true]])
    expect(shown()).toBe('\r\nz')
  })
})

// The attention rule, applied to the status
// sentinel. A status payload is JSON.stringify output (ssh-shim.ts), so it
// holds no control character, and it is never near 16 KiB. A status opening
// with a control character (a line break, an escape) before its BEL, or with
// no BEL within 16 KiB, is no sentinel: its opening and the payload read so far
// are taken out, and every byte after that is terminal output again. Before,
// it held back everything up to the next BEL anywhere in the stream (up to
// 32 KiB, then dropped it all), a real attention sentinel included.
describe('a status opening that is not a sentinel', () => {
  // Mutation to prove this can fail: drop the control character check on the
  // status path (beta.2: the question is held to the title's BEL and dropped).
  it('an opening with no BEL before a line break: the question that follows is shown', () => {
    const { emitData } = spawnOwn()
    emitData(`file line\r\n${STATUS}`)
    emitData('\r\n Do you want to proceed?\r\n 1. Yes\r\n')
    emitData(`${ESC}]0;title${BEL}after`)
    expect(shown()).toBe(`file line\r\n\r\n Do you want to proceed?\r\n 1. Yes\r\n${ESC}]0;title${BEL}after`)
    expect(h.status).toEqual([])
  })

  // Mutation to prove this can fail: as above (beta.2 handed the whole real
  // attention sentinel, nonce included, to the statusline as its payload, and
  // the raise was lost).
  it('an unended opening, then a real attention sentinel: the raise is taken and its nonce is not shown', () => {
    const { emitData, nonce, key } = spawnOwn()
    emitData(`x${STATUS}junk`)
    emitData(`${attention({ s: OWN, n: key, e: 'Notification', t: 'permission_prompt' })}y`)
    expect(pushed).toEqual([[OWN, true]])
    expect(shown()).toBe('xy')
    expect(shown().includes(nonce)).toBe(false)
    expect(h.status).toEqual([])
  })

  it('an unended opening, then a real status sentinel: the real one reaches the statusline', () => {
    const json = JSON.stringify({ sessionId: OWN, model: 'm' })
    const { emitData } = spawnOwn()
    emitData(`x${STATUS}junk`)
    emitData(`${STATUS}${json}${BEL}y`)
    expect(h.status).toEqual([[OWN, json]])
    expect(shown()).toBe('xy')
  })

  it('an opening followed by another escape before any BEL: the escape and what follows are shown', () => {
    const { emitData } = spawnOwn()
    emitData(`a${STATUS}junk${ESC}[31mred${BEL}`)
    expect(shown()).toBe(`a${ESC}[31mred${BEL}`)
    expect(h.status).toEqual([])
  })

  // Mutation to prove this can fail: drop the 16 KiB cap on the status path
  // (beta.2 held up to 32 KiB, and then dropped it all).
  it('an opening with no BEL within 16 KiB: the bytes past it are shown at once', () => {
    const max = 16 * 1024
    const { emitData } = spawnOwn()
    emitData(`x${STATUS}`)
    emitData('q'.repeat(33 * 1024))
    expect(shown()).toBe(`x${'q'.repeat(33 * 1024 - max)}`)
    emitData('visible after')
    expect(shown()).toBe(`x${'q'.repeat(33 * 1024 - max)}visible after`)
    expect(h.status).toEqual([])
  })

  it('a payload of exactly 16 KiB is still a sentinel; one a character longer is not, and its excess is shown', () => {
    const max = 16 * 1024
    const body = (pad: number): string => JSON.stringify({ sessionId: OWN, model: 'm', p: 'z'.repeat(pad) })
    const base = body(0).length
    const fits = body(max - base)
    expect(fits.length).toBe(max)
    const at = spawnOwn()
    at.emitData(`x${STATUS}${fits}${BEL}y`)
    expect(h.status).toEqual([[OWN, fits]])
    expect(shown()).toBe('xy')

    const over = body(max + 1 - base)
    const past = spawnOwn()
    past.emitData(`x${STATUS}${over}${BEL}y`)
    expect(h.status).toEqual([])
    expect(shown()).toBe(`x}${BEL}y`)
  })
})
