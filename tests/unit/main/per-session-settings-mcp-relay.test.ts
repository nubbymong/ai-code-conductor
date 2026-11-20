/**
 * 2.1.3-beta.11, plan section B2: a held Claude Code session's per-session MCP
 * config switched to the session helper's relay (per-session-settings.ts
 * switchMcpConfigToHelper).
 *
 * The file is the one writeLocalSessionMcpConfig writes, in a temp home. The
 * secure writers (an owner-only folder and file) are plain writes here, so no
 * folder's permissions change on the machine the test runs on; a flag makes
 * the file write fail. The server's port and the session's token are
 * stand-ins.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../src/main/account-profiles', async (importOriginal) => {
  const real = await import('node:fs')
  return {
    ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
    mkdirSecure: (d: string) => { real.mkdirSync(d, { recursive: true }) },
    hardenCredentialDir: () => {},
    atomicWriteSecure: (f: string, data: string) => {
      if ((globalThis as { __relayWriteFails?: boolean }).__relayWriteFails) throw new Error('EPERM: the stand-in refused the write')
      real.writeFileSync(f, data)
    },
  }
})
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => (globalThis as { __relayPort?: number }).__relayPort ?? 19433,
  issueMcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))

const { writeLocalSessionMcpConfig, getLocalSessionMcpConfigPath, switchMcpConfigToHelper } = await import('../../../src/main/hooks/per-session-settings')

const SID = 'abcdef0123456789abcdef60'
const HELD = 'ag0123456789abcdef0123456789abcd'

describe('a held Claude Code session\'s MCP config through its holder (2.1.3-beta.11, plan section B2)', () => {
  let home: string
  let realHomedir: typeof os.homedir
  let relay: { helperPath: string; store: string; sid: string }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-mcp-relay-'))
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    realHomedir = os.homedir
    ;(os as { homedir: () => string }).homedir = () => home
    // The helper's copy under a folder with a space, as the installed app's is.
    relay = { helperPath: path.join(home, 'AI Code Conductor', 'helper', '0.1.0-0123456789ab', process.platform === 'win32' ? 'aicc-helper.exe' : 'aicc-helper'), store: path.join(home, 'AI Code Conductor', 'helper', 'store'), sid: HELD }
    delete (globalThis as { __relayWriteFails?: boolean }).__relayWriteFails
    delete (globalThis as { __relayPort?: number }).__relayPort
  })

  afterEach(() => {
    ;(os as { homedir: () => string }).homedir = realHomedir
    delete (globalThis as { __relayWriteFails?: boolean }).__relayWriteFails
    delete (globalThis as { __relayPort?: number }).__relayPort
    fs.rmSync(home, { recursive: true, force: true })
  })

  const read = (): string => fs.readFileSync(getLocalSessionMcpConfigPath(SID), 'utf-8')

  it('a file with the app\'s conductor entry is rewritten to the relay form, and nothing else in it changes', () => {
    writeLocalSessionMcpConfig(SID)
    // Something besides the app's entry, before and after it, and another key.
    const loopback = JSON.parse(read()).mcpServers.conductor
    expect(loopback).toEqual({ type: 'sse', url: `http://localhost:19433/sse?cccSessionId=${SID}&token=tok-${SID}` })
    const before = { note: 'kept', mcpServers: { first: { type: 'stdio', command: 'x' }, conductor: loopback, last: { type: 'sse', url: 'http://example.test/sse' } }, after: [1, 2] }
    fs.writeFileSync(getLocalSessionMcpConfigPath(SID), JSON.stringify(before, null, 2))
    expect(switchMcpConfigToHelper({ configPath: getLocalSessionMcpConfigPath(SID), sessionId: SID, relay })).toBe('switched')
    const entry = { type: 'stdio', command: relay.helperPath, args: ['mcp', '--store', relay.store, '--session', HELD] }
    // Byte for byte: only the conductor entry's own text differs, in its place.
    expect(read()).toBe(JSON.stringify({ ...before, mcpServers: { ...before.mcpServers, conductor: entry } }, null, 2))
    // No loopback address or credential is left in the file.
    expect(read()).not.toContain('localhost')
    expect(read()).not.toContain(`tok-${SID}`)
  })

  it('a file without the entry (the tools off, the server not started, another session\'s, already switched, or not the app\'s shape) is left alone', () => {
    const p = getLocalSessionMcpConfigPath(SID)
    // The built-in tools off: no conductor entry at all.
    writeLocalSessionMcpConfig(SID, false)
    const off = read()
    expect(JSON.parse(off).mcpServers).toEqual({})
    expect(switchMcpConfigToHelper({ configPath: getLocalSessionMcpConfigPath(SID), sessionId: SID, relay })).toBe('no-conductor')
    expect(read()).toBe(off)
    // The server not started when the file was written: the same.
    ;(globalThis as { __relayPort?: number }).__relayPort = 0
    writeLocalSessionMcpConfig(SID)
    expect(switchMcpConfigToHelper({ configPath: getLocalSessionMcpConfigPath(SID), sessionId: SID, relay })).toBe('no-conductor')
    delete (globalThis as { __relayPort?: number }).__relayPort
    // Another session's entry, an entry with a field the app does not write,
    // one without a token, and one already switched: none is this session's own.
    const others = [
      { type: 'sse', url: 'http://localhost:19433/sse?cccSessionId=abcdef0123456789abcdef61&token=tok-x' },
      { type: 'sse', url: `http://localhost:19433/sse?cccSessionId=${SID}&token=tok-${SID}`, headers: { a: 'b' } },
      { type: 'sse', url: `http://localhost:19433/sse?cccSessionId=${SID}&token=` },
      { type: 'sse', url: `http://example.test:19433/sse?cccSessionId=${SID}&token=tok-${SID}` },
      { type: 'stdio', command: relay.helperPath, args: ['mcp', '--store', relay.store, '--session', HELD] },
    ]
    for (const conductor of others) {
      const text = JSON.stringify({ mcpServers: { conductor } }, null, 2)
      fs.writeFileSync(p, text)
      expect(switchMcpConfigToHelper({ configPath: getLocalSessionMcpConfigPath(SID), sessionId: SID, relay }), JSON.stringify(conductor)).toBe('no-conductor')
      expect(read()).toBe(text)
    }
    // No file, and a file that is not JSON.
    fs.rmSync(p)
    expect(switchMcpConfigToHelper({ configPath: getLocalSessionMcpConfigPath(SID), sessionId: SID, relay })).toBe('no-conductor')
    expect(fs.existsSync(p)).toBe(false)
    fs.writeFileSync(p, '{ not json')
    expect(switchMcpConfigToHelper({ configPath: getLocalSessionMcpConfigPath(SID), sessionId: SID, relay })).toBe('no-conductor')
    expect(read()).toBe('{ not json')
  })

  it('a path that cannot be written into the file exactly is left alone and answered as such', () => {
    writeLocalSessionMcpConfig(SID)
    const text = read()
    const bad: Array<[string, typeof relay, NodeJS.Platform?]> = [
      ['a relative path', { ...relay, helperPath: path.join('helper', 'aicc-helper') }],
      ['a control character', { ...relay, store: `${relay.store}\nx` }],
      ['a C1 control character', { ...relay, store: `${relay.store}${String.fromCharCode(0x9b)}` }],
      ['a lone surrogate', { ...relay, helperPath: `${relay.helperPath}${String.fromCharCode(0xdc00)}` }],
      ['a session id of another pattern', { ...relay, sid: '../ag' }],
      ['a network path on Windows', { ...relay, helperPath: '\\\\server\\share\\aicc-helper.exe', store: 'C:\\helper\\store' }, 'win32'],
      ['a device path on Windows', { ...relay, helperPath: '\\\\?\\C:\\helper\\aicc-helper.exe', store: 'C:\\helper\\store' }, 'win32'],
      ['a Windows path elsewhere', { ...relay, helperPath: 'C:\\helper\\aicc-helper.exe', store: 'C:\\helper\\store' }, 'linux'],
    ]
    for (const [what, r, platform] of bad) {
      expect(switchMcpConfigToHelper({ configPath: getLocalSessionMcpConfigPath(SID), sessionId: SID, relay: r, ...(platform ? { platform } : {}) }), what).toBe('unsafe-path')
      expect(read(), what).toBe(text)
    }
    // A drive path with spaces on Windows is fine.
    expect(switchMcpConfigToHelper({ configPath: getLocalSessionMcpConfigPath(SID), sessionId: SID, relay: { ...relay, helperPath: 'C:\\Users\\some one\\AI Code Conductor\\aicc-helper.exe', store: 'C:\\Users\\some one\\AI Code Conductor\\store' }, platform: 'win32' })).toBe('switched')
  })

  it('a file that cannot be written is left as it was: not-written', () => {
    writeLocalSessionMcpConfig(SID)
    const text = read()
    ;(globalThis as { __relayWriteFails?: boolean }).__relayWriteFails = true
    expect(switchMcpConfigToHelper({ configPath: getLocalSessionMcpConfigPath(SID), sessionId: SID, relay })).toBe('not-written')
    expect(read()).toBe(text)
  })
})
