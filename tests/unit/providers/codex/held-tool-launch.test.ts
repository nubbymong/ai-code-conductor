/**
 * 2.1.3-beta.11, plan section B2: a held Codex session's launch with its
 * `conductor` tool server started as the session helper's relay
 * (src/main/providers/codex/held-tool-launch.ts). Every launch here is the
 * one the real builder makes (CodexProvider.buildSpawnCommand), so the three
 * loopback entries the module replaces are the builder's own; only the
 * server's port and the session's token are stand-ins, and the built-in tools'
 * switch is read as on (or off) without reading any settings file.
 *
 * Pure: no file, no process, no folder of the host is read or written.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => '',
  getDataDirectory: () => '',
}))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => (globalThis as { __relayPort?: number }).__relayPort ?? 19333,
  issueMcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))
vi.mock('../../../../src/main/conductor-tools-switch', () => ({
  readConductorToolSwitches: () => ({ master: (globalThis as { __relayTools?: boolean }).__relayTools ?? true, switches: {} }),
}))

import { CodexProvider } from '../../../../src/main/providers/codex'
import { codexCmdExeTarget, CMD_EXE_LINE_MAX } from '../../../../src/main/providers/codex/spawn'
import { codexHeldToolLaunch, codexRelayEntries } from '../../../../src/main/providers/codex/held-tool-launch'
import type { HeldToolRelay } from '../../../../src/main/providers/types'

const SID = 'abcdef0123456789abcdef60'
const HELD = 'ag0123456789abcdef0123456789abcd'
const WIN_ENV = { SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\res\\codex-realms\\r1' }
/** The installed helper's copy and store on Windows: the app's folder name has spaces. */
const WIN_RELAY: HeldToolRelay = {
  helperPath: 'C:\\Users\\some one\\AppData\\Local\\AI Code Conductor\\helper\\0.1.0-0123456789ab\\aicc-helper.exe',
  store: 'C:\\Users\\some one\\AppData\\Local\\AI Code Conductor\\helper\\store',
  sid: HELD,
}
/** A folder with no space or cmd.exe character in it (a dev data folder). */
const PLAIN_RELAY: HeldToolRelay = { helperPath: 'C:\\aicc\\helper\\0.1.0-0123456789ab\\aicc-helper.exe', store: 'C:\\aicc\\helper\\store', sid: HELD }
const POSIX_RELAY: HeldToolRelay = { helperPath: '/home/some one/.ai-code-conductor/helper/0.1.0-0123456789ab/aicc-helper', store: '/home/some one/.ai-code-conductor/helper/store', sid: HELD }

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const was = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    if (was) Object.defineProperty(process, 'platform', was)
  }
}

/** The builder's launch for a fresh session. */
function built(executable: string, platform: NodeJS.Platform, preset = 'unrestricted', env: Record<string, string> = platform === 'win32' ? WIN_ENV : { PATH: '/usr/bin', CODEX_HOME: '/res/r1' }) {
  return withPlatform(platform, () => new CodexProvider().buildSpawnCommand({
    sessionId: SID,
    cwd: platform === 'win32' ? 'C:\\work' : '/work',
    realmLaunch: { executable, env, sessionsDir: platform === 'win32' ? 'C:\\res\\codex-realms\\r1\\sessions' : '/res/r1/sessions' },
    codexOptions: { model: 'gpt-5.5', permissionsPreset: preset },
  } as never))
}

/** The builder's args with its three loopback entries replaced by `entries`, where they were. */
function replaced(args: readonly string[], entries: string[]): string[] {
  const at = args.indexOf(`mcp_servers.conductor.url=http://localhost:19333/mcp?cccSessionId=${SID}`) - 1
  expect(at).toBeGreaterThanOrEqual(0)
  expect(args.slice(at, at + 6)).toEqual([
    '-c', `mcp_servers.conductor.url=http://localhost:19333/mcp?cccSessionId=${SID}`,
    '-c', 'mcp_servers.conductor.enabled=true',
    '-c', 'mcp_servers.conductor.bearer_token_env_var=CONDUCTOR_MCP_TOKEN',
  ])
  return [...args.slice(0, at), ...entries, ...args.slice(at + 6)]
}

describe('a held Codex launch in its relay form (2.1.3-beta.11, plan section B2)', () => {
  it('the argument list, for a path with a space: the three loopback entries are gone, the command and its arguments are in their place, and the timeout, the approvals and every other argument stay', () => {
    const b = built(WIN_RELAY.helperPath.replace('aicc-helper.exe', 'codex.exe'), 'win32')
    const answer = codexHeldToolLaunch(SID, { file: b.cmd, args: b.args, env: b.env }, WIN_RELAY, 'win32')
    const expected = replaced(b.args, [
      '-c', `mcp_servers.conductor.command='${WIN_RELAY.helperPath}'`,
      '-c', `mcp_servers.conductor.args=['mcp','--store','${WIN_RELAY.store}','--session','${HELD}']`,
    ])
    expect(answer).toEqual({ args: expected })
    const args = (answer as { args: string[] }).args
    expect(args.some((a) => a.startsWith('mcp_servers.conductor.url=') || a.includes('bearer_token_env_var') || a.includes('conductor.enabled'))).toBe(false)
    expect(args).toContain('mcp_servers.conductor.tool_timeout_sec=1000.0')
    // Unrestricted: the two pre-allowed tools and the preset's own, all kept.
    const approvals = b.args.filter((a) => a.endsWith('.approval_mode=approve'))
    expect(approvals.length).toBeGreaterThan(2)
    expect(args.filter((a) => a.endsWith('.approval_mode=approve'))).toEqual(approvals)
    // The environment is not the module's: the token variable stays as built.
    expect(b.env.CONDUCTOR_MCP_TOKEN).toBe(`tok-${SID}`)
    // macOS and Linux: the same, with their paths.
    const p = built('/usr/local/bin/codex', 'linux', 'standard')
    expect(codexHeldToolLaunch(SID, { file: p.cmd, args: p.args, env: p.env }, POSIX_RELAY, 'linux')).toEqual({ args: replaced(p.args, codexRelayEntries(POSIX_RELAY)) })
  })

  it('a path that holds a single quote goes as a TOML basic string, and the input list is never changed', () => {
    const b = built('C:\\bin\\codex.exe', 'win32', 'standard')
    const before = [...b.args]
    const relay = { ...WIN_RELAY, helperPath: "C:\\Users\\o'brien\\AppData\\Local\\AI Code Conductor\\helper\\0.1.0-0123456789ab\\aicc-helper.exe" }
    const answer = codexHeldToolLaunch(SID, { file: b.cmd, args: b.args, env: b.env }, relay, 'win32') as { args: string[] }
    expect(answer.args).toContain(`mcp_servers.conductor.command=${JSON.stringify(relay.helperPath)}`)
    expect(b.args).toEqual(before)
  })

  it('the one-line cmd.exe form (an npm launcher): rewritten only when the quoting rule carries the relay, built by that same rule, and declined otherwise', () => {
    const b = built('C:\\npm\\codex.cmd', 'win32', 'standard')
    expect(b.commandLine).toBeDefined()
    const launch = { file: b.cmd, args: b.commandLine!, env: b.env }
    // The installed app's folder has spaces: the rule refuses them, so the line is not touched.
    expect(codexHeldToolLaunch(SID, launch, WIN_RELAY, 'win32')).toEqual({ refused: 'cmd-line' })
    // A folder with none: the same line, the relay in the loopback entries' place.
    const flags = b.commandLine!.slice('/d /v:off /s /c ""C:\\npm\\codex.cmd" '.length, -1).split(' ')
    const line = codexCmdExeTarget('C:\\npm\\codex.cmd', replaced(flags, codexRelayEntries(PLAIN_RELAY)), b.env).commandLine
    expect(codexHeldToolLaunch(SID, launch, PLAIN_RELAY, 'win32')).toEqual({ args: line })
    expect(line).toContain(`mcp_servers.conductor.command='${PLAIN_RELAY.helperPath}'`)
    expect(line).not.toContain('mcp_servers.conductor.url=')
    // Each cmd.exe character the rule refuses keeps the loopback route.
    for (const c of ['(', ')', '%', '!', '&', '^']) {
      expect(codexHeldToolLaunch(SID, launch, { ...PLAIN_RELAY, store: `C:\\aicc${c}x\\store` }, 'win32'), c).toEqual({ refused: 'cmd-line' })
    }
    // A line over cmd.exe's limit keeps it too.
    const long = { ...PLAIN_RELAY, store: `C:\\${'s'.repeat(CMD_EXE_LINE_MAX)}` }
    expect(codexHeldToolLaunch(SID, launch, long, 'win32')).toEqual({ refused: 'cmd-line' })
    // A line not of that rule's making is not read.
    expect(codexHeldToolLaunch(SID, { ...launch, args: `${b.commandLine!} ` }, PLAIN_RELAY, 'win32')).toEqual({ refused: 'cmd-line' })
    expect(codexHeldToolLaunch(SID, { ...launch, args: b.commandLine!.replace('/v:off', '/v:on') }, PLAIN_RELAY, 'win32')).toEqual({ refused: 'cmd-line' })
    expect(codexHeldToolLaunch(SID, launch, PLAIN_RELAY, 'linux')).toEqual({ refused: 'cmd-line' })
  })

  it('the resume list: its flags handed to an npm launcher are rewritten only when that line\'s rule carries them; handed to codex.exe, as a list', () => {
    const b = built('C:\\bin\\codex.exe', 'win32', 'standard')
    // As spawn.ts builds the picker's launch: node, the script, then the flags.
    const picker = ['C:\\res\\scripts\\codex-resume-picker.js', ...b.args]
    const viaNpm = { ...b.env, CCC_CODEX_EXECUTABLE: 'C:\\npm\\codex.cmd' }
    expect(codexHeldToolLaunch(SID, { file: 'C:\\node\\node.exe', args: picker, env: viaNpm }, WIN_RELAY, 'win32')).toEqual({ refused: 'cmd-line' })
    // Any spelling of the variable is the same one on Windows.
    expect(codexHeldToolLaunch(SID, { file: 'C:\\node\\node.exe', args: picker, env: { ...b.env, ccc_codex_executable: 'C:\\npm\\codex.cmd' } }, WIN_RELAY, 'win32')).toEqual({ refused: 'cmd-line' })
    expect(codexHeldToolLaunch(SID, { file: 'C:\\node\\node.exe', args: picker, env: viaNpm }, PLAIN_RELAY, 'win32')).toEqual({ args: replaced(picker, codexRelayEntries(PLAIN_RELAY)) })
    const viaExe = { ...b.env, CCC_CODEX_EXECUTABLE: 'C:\\bin\\codex.exe' }
    expect(codexHeldToolLaunch(SID, { file: 'C:\\node\\node.exe', args: picker, env: viaExe }, WIN_RELAY, 'win32')).toEqual({ args: replaced(picker, codexRelayEntries(WIN_RELAY)) })
  })

  it('a launch with the tools off is not touched: no loopback entries, no relay', () => {
    ;(globalThis as { __relayTools?: boolean }).__relayTools = false
    try {
      const off = built('C:\\bin\\codex.exe', 'win32')
      expect(off.args.some((a) => a.startsWith('mcp_servers.conductor'))).toBe(false)
      expect(codexHeldToolLaunch(SID, { file: off.cmd, args: off.args, env: off.env }, WIN_RELAY, 'win32')).toEqual({ refused: 'no-tools' })
      const npm = built('C:\\npm\\codex.cmd', 'win32')
      expect(codexHeldToolLaunch(SID, { file: npm.cmd, args: npm.commandLine!, env: npm.env }, PLAIN_RELAY, 'win32')).toEqual({ refused: 'no-tools' })
    } finally {
      delete (globalThis as { __relayTools?: boolean }).__relayTools
    }
    ;(globalThis as { __relayPort?: number }).__relayPort = 0
    try {
      const unbound = built('/usr/local/bin/codex', 'linux')
      expect(codexHeldToolLaunch(SID, { file: unbound.cmd, args: unbound.args, env: unbound.env }, POSIX_RELAY, 'linux')).toEqual({ refused: 'no-tools' })
    } finally {
      delete (globalThis as { __relayPort?: number }).__relayPort
    }
  })

  it('only this session\'s own entries, before any `--`: another session\'s, or the same words after `--` (an Ask question), are not taken', () => {
    const b = built('/usr/local/bin/codex', 'linux', 'standard')
    expect(codexHeldToolLaunch('abcdef0123456789abcdef61', { file: b.cmd, args: b.args, env: b.env }, POSIX_RELAY, 'linux')).toEqual({ refused: 'no-tools' })
    const at = b.args.indexOf('-c', b.args.findIndex((a) => a.startsWith('mcp_servers.conductor.url=')) - 1)
    const triple = b.args.slice(at, at + 6)
    const afterDashes = [...b.args.slice(0, at), ...b.args.slice(at + 6), '--', ...triple]
    expect(codexHeldToolLaunch(SID, { file: b.cmd, args: afterDashes, env: b.env }, POSIX_RELAY, 'linux')).toEqual({ refused: 'no-tools' })
    // The three out of order are not the builder's.
    const swapped = [...b.args.slice(0, at), ...triple.slice(2, 4), ...triple.slice(0, 2), ...triple.slice(4), ...b.args.slice(at + 6)]
    expect(codexHeldToolLaunch(SID, { file: b.cmd, args: swapped, env: b.env }, POSIX_RELAY, 'linux')).toEqual({ refused: 'no-tools' })
  })

  it('a path the relay needs that cannot ride the launch exactly keeps the loopback route', () => {
    const b = built('C:\\bin\\codex.exe', 'win32', 'standard')
    const launch = { file: b.cmd, args: b.args, env: b.env }
    const bad: Array<[string, HeldToolRelay]> = [
      ['relative', { ...WIN_RELAY, helperPath: 'helper\\aicc-helper.exe' }],
      ['a network path', { ...WIN_RELAY, store: '\\\\server\\share\\store' }],
      ['a device path', { ...WIN_RELAY, helperPath: '\\\\?\\C:\\helper\\aicc-helper.exe' }],
      ['a control character', { ...WIN_RELAY, store: 'C:\\helper\\st\nore' }],
      ['a C1 control character', { ...WIN_RELAY, store: `C:\\helper\\st${String.fromCharCode(0x85)}ore` }],
      ['a lone surrogate', { ...WIN_RELAY, helperPath: `C:\\helper\\${String.fromCharCode(0xd800)}\\aicc-helper.exe` }],
      ['a session id of another pattern', { ...WIN_RELAY, sid: 'ag 1' }],
      ['an empty path', { ...WIN_RELAY, helperPath: '' }],
    ]
    for (const [what, relay] of bad) expect(codexHeldToolLaunch(SID, launch, relay, 'win32'), what).toEqual({ refused: 'unsafe-path' })
    expect(codexHeldToolLaunch(SID, launch, POSIX_RELAY, 'win32')).toEqual({ refused: 'unsafe-path' })
    expect(codexHeldToolLaunch(SID, { file: b.cmd, args: b.args, env: b.env }, WIN_RELAY, 'linux')).toEqual({ refused: 'unsafe-path' })
  })

  it('the Codex package offers it through its entry point (heldToolLaunch)', () => {
    const b = built('/usr/local/bin/codex', 'linux', 'standard')
    const launch = { file: b.cmd, args: b.args, env: b.env }
    expect(withPlatform('linux', () => new CodexProvider().heldToolLaunch(SID, launch, POSIX_RELAY))).toEqual(codexHeldToolLaunch(SID, launch, POSIX_RELAY, 'linux'))
  })
})
