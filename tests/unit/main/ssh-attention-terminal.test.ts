// aicc_planning#93: a remote SSH session's attention events, end to end on
// THIS side: the real spawnPty SSH branch (node-pty and Electron faked) gets
// the bytes a remote hook writes into the session's terminal, takes the
// sentinel out of what the terminal shows (plain SSH: nothing else strips it,
// so a sentinel left in would print as junk), and hands it to the real
// attention source, which pushes the indicator. A sentinel that is not this
// spawn's own is still taken out of the terminal and reaches nothing.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import * as os from 'os'

const h = vi.hoisted(() => ({
  ptys: [] as Array<{ emitData: (d: string) => void }>,
  sent: [] as Array<[string, unknown]>,
  /** What the settings file holds (the HTTP Hooks Gateway switch); every other config key reads as {}. */
  settings: {} as Record<string, unknown>,
}))

vi.mock('node-pty', () => ({
  spawn: () => {
    const { EventEmitter } = require('events') as typeof import('events')
    const out = new EventEmitter()
    out.on('error', () => {})
    const dataCbs: Array<(d: string) => void> = []
    h.ptys.push({ emitData: (d: string) => { for (const cb of dataCbs) cb(d) } })
    return {
      pid: 4646,
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
  readConfig: (key: string) => (key === 'settings' ? h.settings : {}),
  getConfigDir: () => require('os').tmpdir(),
}))
vi.mock('../../../src/main/sentinel/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/sentinel/index')>()),
  sentinelObserve: () => {},
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

const OWN = 'sshattnowna000000001'
const OTHER = 'sshattnothr000000002'
const ch = (code: number): string => String.fromCharCode(code)
/** The attention sentinel exactly as the remote hook writes it. */
const sentinel = (b: Record<string, unknown>): string => `${ch(27)}]9999;CMATTN=${JSON.stringify(b)}${ch(7)}`
const pushed: Array<[string, boolean]> = []

beforeAll(() => { registerProvider(sshProvider as never) })
beforeEach(() => {
  h.sent.length = 0
  h.settings = {}
  pushed.length = 0
  _resetAttentionSourceForTest()
  startAttentionSource({ push: (sid, v) => { pushed.push([sid, v]) } })
})
afterEach(() => { try { killPty(OWN) } catch { /* gone */ } })

/** A spawn's emitter, its nonce, and its attention key (what its remote hook
 *  sends: remoteAttentionKey of the nonce). */
const spawnOwn = (): { emitData: (d: string) => void; nonce: string; key: string } => {
  spawnPty(fakeWin, OWN, { ssh: { username: 'me', host: 'example.com', port: 22, remotePath: '~' }, cwd: os.homedir() } as never)
  const p = h.ptys[h.ptys.length - 1]
  const nonce = _getSshNonceForTest(OWN)
  expect(nonce).toBeTruthy()
  return { emitData: p.emitData, nonce: nonce!, key: remoteAttentionKey(nonce!) }
}
const shown = (): string => h.sent.filter(([c]) => c === `pty:data:${OWN}`).map(([, d]) => String(d)).join('')

describe('an SSH session\'s attention sentinel', () => {
  // Mutation to prove this can fail: drop the attention prefix from
  // nextSshSentinel -- the sentinel is shown in the terminal and nothing is pushed.
  it('raises the indicator for its own session and never reaches the terminal', () => {
    const { emitData, key } = spawnOwn()
    emitData(`before ${sentinel({ s: OWN, n: key, e: 'Notification', t: 'permission_prompt' })} after`)
    expect(pushed).toEqual([[OWN, true]])
    expect(shown()).toBe('before  after')
  })

  it('clears on the events a local session clears on', () => {
    const { emitData, key } = spawnOwn()
    emitData(sentinel({ s: OWN, n: key, e: 'Notification', t: 'idle_prompt' }))
    emitData(sentinel({ s: OWN, n: key, e: 'UserPromptSubmit' }))
    expect(pushed).toEqual([[OWN, true], [OWN, false]])
    expect(shown()).toBe('')
  })

  it('is taken out of the terminal even when it arrives split across two reads', () => {
    const { emitData, key } = spawnOwn()
    const s = sentinel({ s: OWN, n: key, e: 'Notification', t: 'agent_needs_input' })
    const cut = s.indexOf('"e"')
    emitData(`x${s.slice(0, cut)}`)
    expect(pushed).toEqual([])
    emitData(`${s.slice(cut)}y`)
    expect(pushed).toEqual([[OWN, true]])
    expect(shown()).toBe('xy')
  })

  // Mutation to prove this can fail: pass `undefined` for the key check in
  // extractSshOscSentinels' attention branch, or skip the check -- a forged one is pushed.
  it('a sentinel without this spawn\'s attention key, or naming another session, reaches nothing and is still not shown', () => {
    const { emitData, key } = spawnOwn()
    emitData(`a${sentinel({ s: OWN, n: 'forgedNonce1', e: 'Notification', t: 'permission_prompt' })}b`)
    emitData(`c${sentinel({ s: OTHER, n: key, e: 'Notification', t: 'permission_prompt' })}d`)
    emitData(`e${sentinel({ s: OWN, n: key, e: 'Notification', t: 'auth_success' })}f`)
    expect(pushed).toEqual([])
    expect(shown()).toBe('abcdef')
  })

  it('a respawn takes the new attention key only: the previous connection\'s is refused', () => {
    const first = spawnOwn()
    killPty(OWN)
    const second = spawnOwn()
    expect(second.nonce).not.toBe(first.nonce)
    second.emitData(sentinel({ s: OWN, n: first.key, e: 'Notification', t: 'permission_prompt' }))
    expect(pushed).toEqual([])
    second.emitData(sentinel({ s: OWN, n: second.key, e: 'Notification', t: 'permission_prompt' }))
    expect(pushed).toEqual([[OWN, true]])
  })

  // The remote hook is installed when the session connects, so the switch is
  // read as each raise arrives: turning the HTTP Hooks Gateway switch off
  // stops a running session raising the indicator at once. Mutations to prove
  // this can fail: drop the switch check in remoteAttentionTaken (the second
  // raise is pushed), or apply it to every event (the clear is lost).
  it('once the HTTP Hooks Gateway switch is turned off, a running session raises nothing, but its clear still goes through', () => {
    const { emitData, key } = spawnOwn()
    emitData(sentinel({ s: OWN, n: key, e: 'Notification', t: 'permission_prompt' }))
    expect(pushed).toEqual([[OWN, true]])
    h.settings = { hooksEnabled: false }
    emitData(`a${sentinel({ s: OWN, n: key, e: 'Notification', t: 'idle_prompt' })}b`)
    expect(pushed).toEqual([[OWN, true]])
    emitData(sentinel({ s: OWN, n: key, e: 'PostToolUse' }))
    expect(pushed).toEqual([[OWN, true], [OWN, false]])
    // Still taken out of the terminal either way.
    expect(shown()).toBe('ab')
    // On again: the same session raises again, no reconnect needed.
    h.settings = { hooksEnabled: true }
    emitData(sentinel({ s: OWN, n: key, e: 'Notification', t: 'permission_prompt' }))
    expect(pushed).toEqual([[OWN, true], [OWN, false], [OWN, true]])
  })

  // The remote setup's completion line prints the spawn's nonce in plain text,
  // and the terminal shows it. A sentinel made from that printed value reaches
  // nothing: only the attention key is taken. (This checks the plain-text
  // nonce only. The fake pty here never echoes the typed setup command, which
  // does carry the key base64-encoded; see remoteAttentionKey.)
  // Mutation to prove this can fail: make remoteAttentionKey return the nonce.
  it('a sentinel made from the nonce the setup line prints reaches nothing; the real key still raises and clears', () => {
    const { emitData, nonce, key } = spawnOwn()
    emitData(`setup ok ${nonce} tmux=none acct=\r\n`)
    expect(key).not.toBe(nonce)
    emitData(sentinel({ s: OWN, n: key, e: 'Notification', t: 'permission_prompt' }))
    expect(pushed).toEqual([[OWN, true]])
    emitData(sentinel({ s: OWN, n: nonce, e: 'PreToolUse' }))
    emitData(sentinel({ s: OWN, n: nonce, e: 'Notification', t: 'idle_prompt' }))
    expect(pushed).toEqual([[OWN, true]])
    emitData(sentinel({ s: OWN, n: key, e: 'PreToolUse' }))
    expect(pushed).toEqual([[OWN, true], [OWN, false]])
  })

  it('travels with a status sentinel in one read without disturbing it', () => {
    const { emitData, key } = spawnOwn()
    const status = `${ch(27)}]9999;CMSTATUS=${JSON.stringify({ sessionId: OWN, model: 'm' })}${ch(7)}`
    emitData(`1${status}2${sentinel({ s: OWN, n: key, e: 'Notification', t: 'elicitation_dialog' })}3`)
    expect(pushed).toEqual([[OWN, true]])
    expect(shown()).toBe('123')
  })
})
