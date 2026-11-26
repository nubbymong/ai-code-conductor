/**
 * A tab through the session helper on another machine gets its status line,
 * its hook events and every Conductor tool, together (plan 2.1.3-beta.18,
 * section 3.2; aicc_planning#431), against section 3.1's helper contract
 * with a fake holder and a fake ssh:
 *
 * - its own files on the host: the host's settings files are read first (one
 *   exec, as data), the holder is started, then one exec writes settings.json
 *   (the status mode as its status line; the host's own hooks first, then the
 *   hook mode's nine, an identical entry once) and mcp.json (the helper's
 *   relay) into the session's own folder, before the launch. They name the
 *   helper's path, its store and the session id only: no address, port,
 *   token or path of this computer. A file the host would not let be read is
 *   left out with one log line. A start whose files cannot be written ends
 *   the holder it started. At the end its folder goes, once the holder ended;
 * - its connections ack `status`, `hooks` and `mcp`; a status reaches the
 *   status strip once, as the tab's own, cut to the keep-list; a hook event
 *   reaches the session signals module, cut to its keep-list; a tool stream
 *   is served as the tab's session;
 * - a dropped link: the events queued meanwhile arrive once, and the newest
 *   status once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ProviderRemoteLaunch, RemoteStatusLine, SessionProvider } from '../../../src/main/providers/types'
import { registerProvider } from '../../../src/main/providers'
import { claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import { remoteHelperPty, setRemoteHelperDeps, type RemoteSignalDeps } from '../../../src/main/remote-helper'
import { remoteHelperCommands, remoteSessionId } from '../../../src/main/remote-helper/session'
import type { RemoteMachineRecord, RemoteMachines } from '../../../src/main/remote-helper/machines'
import type { HelperToolLink } from '../../../src/main/session-helper/manager'
import type { HookEventFrame, HolderRecord } from '../../../src/main/session-helper/protocol'
import { DEFAULT_PROVIDER_ID } from '../../../src/shared/providers/ids'
import type { SSHOptions } from '../../../src/main/ssh-options'
import { FakeHolder } from '../main/session-helper-fake-holder'
import { FakeSsh, result, type ExecCall, type FakeAnswer } from './fake-ssh'

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: null, helper: { version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
}
const SSH_TAB: SSHOptions = { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~/work', detachable: false }
const INSTALL = 'f'.repeat(32)
const NINE = ['PreToolUse', 'PostToolUse', 'Notification', 'SessionStart', 'Stop', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'StopFailure']

/** What the provider's status line mapping was handed, each time. */
let statusInputs: Array<Record<string, unknown>> = []
const spied: ProviderRemoteLaunch = {
  ...claudeRemoteLaunch,
  statusLine: (p) => { statusInputs.push(JSON.parse(JSON.stringify(p))); return claudeRemoteLaunch.statusLine!(p) },
}
const provider = {
  id: DEFAULT_PROVIDER_ID, displayName: 'The default provider', resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  detectUiRunning: () => false, exitKeys: [], ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {}, remoteLaunch: spied,
} as unknown as SessionProvider

let store = ''
let logs: string[] = []
let ssh: FakeSsh
let shown: Map<string, string>
const win = { webContents: { send: (ch: string, d: unknown) => { const m = /^pty:data:(.+)$/.exec(ch); if (m) shown.set(m[1], (shown.get(m[1]) ?? '') + String(d)) } }, isDestroyed: () => false }

/** The app's side, recorded. */
function signals(tools = true) {
  const status: Array<[string, RemoteStatusLine]> = []
  const events: Array<[string, HookEventFrame]> = []
  const served: Array<{ id: string; provider: string; link: HelperToolLink }> = []
  const ended: string[] = []
  const accounts: Array<[string, unknown]> = []
  const deps: RemoteSignalDeps = {
    toolsServed: () => tools,
    status: (id, line) => { status.push([id, line]) },
    event: (id, e) => { events.push([id, e]) },
    serve: (id, p, link) => { served.push({ id, provider: p, link }); return true },
    ended: (id) => { ended.push(id) },
    account: (id, read) => { accounts.push([id, read]) },
  }
  return { deps, status, events, served, ended, accounts }
}

function plugIn(deps: RemoteSignalDeps | undefined): void {
  ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
  setRemoteHelperDeps({
    platform: 'win32',
    settings: () => ({ remoteSessionsThroughHelper: true }),
    machines: { findByTarget: () => MACHINE, installId: () => INSTALL } as unknown as RemoteMachines,
    runner: ssh,
    bundledSha256: () => SHA,
    systemPrefersDark: () => true,
    onOutput: () => {},
    log: (m) => logs.push(m),
    ...(deps ? { signals: deps } : {}),
  })
}

function linuxRecord(h: FakeHolder): HolderRecord {
  return { ...h.record(), endpoint: `/tmp/aicc-1000/${h.sid}-0123456789abcdef.sock` }
}

const hex = (text: string, encoding: BufferEncoding = 'utf8'): string => Buffer.from(text, encoding).toString('hex')

/** The fake host: the reads (keyed `f<i>`), the hold, the files and the folder's removal. */
function answering(holder: FakeHolder, o: { reads?: Record<string, string>; files?: (c: ExecCall) => FakeAnswer; unsession?: (c: ExecCall) => void } = {}) {
  ssh.host = {
    answer: (c) => {
      const n = c.values[0]
      if (c.script === 'reads') return { stdout: `rc file text\n${result(n, o.reads ?? {})}` }
      // The helper's field mode (2.1.3-beta.19 section 3): the account the host's Claude Code is signed in as.
      if (c.script === 'field') return { stdout: `AICC-HASH ${n} ok ${SHA}\nnick@example.com\n` }
      if (c.script === 'hold') return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify(linuxRecord(holder))}\n` }
      if (c.script === 'files') return o.files ? o.files(c) : { stdout: result(n, {}) }
      if (c.script === 'unsession') { o.unsession?.(c); return { stdout: result(n, {}) } }
      return { code: 1 }
    },
    bridge: () => holder.connect(),
  }
}

/** The files exec's files, by name, from its layout value and its standard input. */
function filesOf(c: ExecCall): Map<string, string> {
  const out = new Map<string, string>()
  let at = 0
  for (const part of c.values[4].split(',')) {
    const [name, size] = part.split(':')
    out.set(name, c.stdin.subarray(at, at + Number(size)).toString('utf8'))
    at += Number(size)
  }
  expect(at).toBe(c.stdin.length)
  return out
}

/** A holder of this version: it offers `status` too (section 3.1). */
function holderFor(id: string): FakeHolder {
  const h = new FakeHolder(remoteSessionId(id), id, store)
  h.caps = ['core', 'local', 'hooks', 'mcp', 'away', 'screen', 'title', 'status']
  return h
}

/** The holder's `status` to the attached connection, when it acked `status` (section 3.1's frame). */
function sendStatus(h: FakeHolder, seq: number, payload: Record<string, unknown>): boolean {
  const c = h.attached
  if (!c || !c.ackedCaps.includes('status')) return false
  c.sendJson({ t: 'status', seq, payload })
  return true
}

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-signals-'))
  logs = []
  shown = new Map()
  statusInputs = []
  registerProvider(provider)
})
afterEach(() => {
  setRemoteHelperDeps(null)
  fs.rmSync(store, { recursive: true, force: true })
})

const helper = (id: string) => remoteHelperCommands(MACHINE, remoteSessionId(id))

describe('a helper tab\'s own files on its host', () => {
  it('reads the settings files first, starts the holder, writes its files into its own folder, then launches: they name the helper, its store and the session only', async () => {
    const id = 'sig-files'
    const s = signals()
    plugIn(s.deps)
    const holder = holderFor(id)
    answering(holder)
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    expect(pty).not.toBeNull()
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    expect(ssh.scripts()).toEqual(['reads', 'field', 'hold', 'files', 'bridge'])
    // The reads: the session folder, then the four settings files Claude Code reads, as data on standard input.
    expect(ssh.calls[0].values.slice(1)).toEqual([MACHINE.did, INSTALL])
    expect(ssh.calls[0].stdin.toString()).toBe('/home/nick/work\nhome .claude/settings.json\ncwd .claude/settings.json\ncwd .claude/settings.local.json\ncheckout .claude/settings.local.json\n')
    // The files: the session's id and the layout on the command line, the bytes on standard input.
    const sid = remoteSessionId(id)
    const files = ssh.calls.find((c) => c.script === 'files')!
    expect(files.values.slice(1, 4)).toEqual([MACHINE.did, INSTALL, sid])
    const written = filesOf(files)
    expect([...written.keys()]).toEqual(['settings.json', 'mcp.json'])
    const h = helper(id)
    const settings = JSON.parse(written.get('settings.json')!)
    expect(settings.statusLine).toEqual({ type: 'command', command: `'${h.helperPath}' status --store '${h.store}' --session ${sid}` })
    expect(Object.keys(settings.hooks).sort()).toEqual([...NINE].sort())
    for (const kind of NINE) expect(settings.hooks[kind]).toEqual([{ matcher: '', hooks: [{ type: 'command', command: `'${h.helperPath}' hook --store '${h.store}' --session ${sid}`, timeout: 10 }] }])
    expect(JSON.parse(written.get('mcp.json')!)).toEqual({ mcpServers: { conductor: { type: 'stdio', command: h.helperPath, args: ['mcp', '--store', h.store, '--session', sid] } } })
    // Nothing of this computer: no address, port, token, secret or local path.
    const all = [...written.values()].join('\n')
    expect(all).not.toMatch(/localhost|127\.0\.0\.1|::1|https?:|token|secret|[A-Za-z]:[\\/]|\\\\/i)
    expect(all).not.toContain(os.homedir())
    expect(all).not.toContain(os.tmpdir())
    expect(all).not.toContain(store)
    // The CLI is pointed at its own folder's files, first on its line.
    const launch = holder.launch as { argv: string[] }
    expect(launch.argv.slice(4, 9)).toEqual([MACHINE.claudePath, '--settings', `${h.folder}/settings.json`, '--mcp-config', `${h.folder}/mcp.json`])
    expect(h.folder).toBe(`/home/nick/.aicc/${MACHINE.did}/sessions/${sid}`)
    // Its connection asks for the status line, hook events and tool streams.
    expect(holder.attached!.ackedCaps).toEqual(expect.arrayContaining(['core', 'local', 'hooks', 'mcp', 'status']))
    // 2.1.3-beta.19 section 3: the account its host's Claude Code is signed in
    // as, read beside the settings files, reached the app once, for this tab.
    expect(ssh.calls[1].values.slice(5)).toEqual(['.claude.json', 'oauthAccount.emailAddress'])
    expect(s.accounts).toEqual([[id, { account: 'nick@example.com' }]])
    pty!.kill()
    await until('the holder to end', () => holder.ended)
  })

  it('the host\'s own hooks come first, in the order Claude Code reads them (user, project, local, the checkout root\'s local), then the app\'s; an identical entry once', async () => {
    const id = 'sig-merge'
    plugIn(signals().deps)
    const holder = holderFor(id)
    const user = { matcher: '', hooks: [{ type: 'command', command: '/home/nick/bin/user-hook' }] }
    const project = { matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/project-hook.sh' }] }
    const local = { matcher: '', hooks: [{ type: 'command', command: 'echo local' }] }
    const root = { matcher: '', hooks: [{ type: 'command', command: 'echo root' }] }
    answering(holder, {
      reads: {
        // The user's file as UTF-16LE with its mark, as Claude Code decodes it too.
        f0: `ok ${hex('﻿' + JSON.stringify({ hooks: { PreToolUse: [user] }, model: 'opus' }), 'utf16le')}`,
        f1: `ok ${hex(JSON.stringify({ hooks: { PreToolUse: [project], Stop: [user] } }))}`,
        // The same entry as the user's: kept once.
        f2: `ok ${hex(JSON.stringify({ hooks: { PreToolUse: [user, local], NotAnArray: 'x' } }))}`,
        f3: `ok ${hex(JSON.stringify({ hooks: { PreToolUse: [root] } }))}`,
      },
    })
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    await until('the launch', () => holder.launch !== null)
    const settings = JSON.parse(filesOf(ssh.calls.find((c) => c.script === 'files')!).get('settings.json')!)
    const own = settings.hooks.Stop[1]
    expect(own.hooks[0].command).toContain(' hook --store ')
    expect(settings.hooks.PreToolUse).toEqual([user, project, local, root, own])
    expect(settings.hooks.Stop).toEqual([user, own])
    expect(settings.hooks.NotAnArray).toBeUndefined()
    // The user's own settings keys are carried, as today's SSH session file
    // carries them (2.1.3-beta.18 fix round, item 2: effortLevel there is the
    // session's effort); a project file's are Claude Code's own to read.
    expect(settings.model).toBe('opus')
    pty!.kill()
    await until('the holder to end', () => holder.ended)
  })

  it('a file there that is not taken (a link, another user\'s, over the bound) adds nothing, with one log line each; an answer that does not read is not read', async () => {
    const id = 'sig-skips'
    plugIn(signals().deps)
    const holder = holderFor(id)
    answering(holder, { reads: { f0: 'skip size', f1: 'skip link', f2: 'skip owner', f3: 'ok zz' } })
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    await until('the launch', () => holder.launch !== null)
    const settings = JSON.parse(filesOf(ssh.calls.find((c) => c.script === 'files')!).get('settings.json')!)
    for (const kind of NINE) expect(settings.hooks[kind]).toHaveLength(1)
    const sid = remoteSessionId(id)
    expect(logs.filter((l) => l.includes('was not read'))).toEqual([
      `[remote-helper] ${sid}: home .claude/settings.json on rocky.lan was not read (size), so nothing it sets is in the session's settings`,
      `[remote-helper] ${sid}: cwd .claude/settings.json on rocky.lan was not read (link), so nothing it sets is in the session's settings`,
      `[remote-helper] ${sid}: cwd .claude/settings.local.json on rocky.lan was not read (owner), so nothing it sets is in the session's settings`,
      `[remote-helper] ${sid}: checkout .claude/settings.local.json on rocky.lan was not read (unknown), so nothing it sets is in the session's settings`,
    ])
    pty!.kill()
    await until('the holder to end', () => holder.ended)
  })

  it('the app\'s tools off: no mcp.json, no --mcp-config, and the connection asks for no tool streams', async () => {
    const id = 'sig-no-tools'
    plugIn(signals(false).deps)
    const holder = holderFor(id)
    answering(holder)
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    expect([...filesOf(ssh.calls.find((c) => c.script === 'files')!).keys()]).toEqual(['settings.json'])
    expect((holder.launch as { argv: string[] }).argv).not.toContain('--mcp-config')
    expect(holder.attached!.ackedCaps).not.toContain('mcp')
    expect(holder.attached!.ackedCaps).toEqual(expect.arrayContaining(['hooks', 'status']))
    pty!.kill()
    await until('the holder to end', () => holder.ended)
  })

  it('a start whose files cannot be written ends the holder it started, and the tab says why', async () => {
    const id = 'sig-files-fail'
    plugIn(signals().deps)
    const holder = holderFor(id)
    answering(holder, { files: (c) => ({ stdout: result(c.values[0], {}, 'refused session-folder-not-private') }) })
    remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    await until('the holder to end', () => holder.ended)
    expect(holder.endsAsked).toBe(1)
    expect(holder.launch).toBeNull()
    await until('the note', () => (shown.get(id) ?? '').includes('could not start through the session helper on rocky.lan'))
    expect(shown.get(id)).toContain("the session's files could not be written on rocky.lan: the session's folder there is not a private folder of yours")
  })

  it('at its end its folder goes, once its holder ended', async () => {
    const id = 'sig-end'
    plugIn(signals().deps)
    const holder = holderFor(id)
    let endedFirst: boolean | null = null
    answering(holder, { unsession: () => { endedFirst = holder.ended } })
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    await until('the launch', () => holder.attached !== null)
    pty!.kill()
    await until('the folder\'s removal', () => ssh.scripts().includes('unsession'))
    const un = ssh.calls.find((c) => c.script === 'unsession')!
    expect(un.values.slice(1)).toEqual([MACHINE.did, INSTALL, remoteSessionId(id)])
    expect(endedFirst).toBe(true)
  })

  // Reviewer finding (3.2's fix round): a helper tab's hook state (its feed
  // ring, its overflow and lost-event marks, all kept by the tab's id) was
  // never ended, so a Restart's Hooks feed held the last run's events and its
  // notices never fired again. The local held session ends it; now so does a
  // remote tab, once its holder ended and before its folder goes.
  it('at its end its hook state is ended once, for its own id, after its holder ended and before its folder goes', async () => {
    const id = 'sig-hooks-end'
    const s = signals()
    plugIn(s.deps)
    const holder = holderFor(id)
    let atFolder: { holderEnded: boolean; ended: string[] } | null = null
    answering(holder, { unsession: () => { atFolder = { holderEnded: holder.ended, ended: [...s.ended] } } })
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    await until('attached', () => holder.attached !== null)
    holder.hookEvent('Stop', { hook_event_name: 'Stop', session_id: 's1' })
    await until('the event', () => s.events.length === 1)
    expect(s.ended).toEqual([])
    pty!.kill()
    await until('the folder\'s removal', () => atFolder !== null)
    expect(atFolder).toEqual({ holderEnded: true, ended: [id] })
    await new Promise((r) => setTimeout(r, 30))
    expect(s.ended).toEqual([id])
  })
})

describe('the status line, hook events and tool streams of a helper tab', () => {
  const STATUS = {
    session_id: 'another-session',
    transcript_path: '/home/nick/.claude/projects/-home-nick-work/abc.jsonl',
    cwd: '/home/nick/work',
    model: { id: 'claude-opus-4-1', display_name: 'Opus', secret: 'not kept' },
    workspace: { current_dir: '/home/nick/work', project_dir: '/home/nick/work' },
    version: '2.1.300',
    cost: { total_cost_usd: 1.25, total_duration_ms: 60000, total_lines_added: 10, total_lines_removed: 2, total_api_duration_ms: 5 },
    context_window: { used_percentage: 12, remaining_percentage: 88, context_window_size: 200000, current_usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } },
    rate_limits: { five_hour: { used_percentage: 41.6, resets_at: 1764000000 }, seven_day: { used_percentage: 7, resets_at: '2026-11-30T00:00:00Z' } },
    output_style: { name: 'default' },
    exceeds_200k_tokens: false,
  }

  it('a status reaches the status strip once, as the tab\'s own, cut to the keep-list; its session id and transcript path go nowhere', async () => {
    const id = 'sig-status'
    const s = signals()
    plugIn(s.deps)
    const holder = holderFor(id)
    answering(holder)
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    await until('attached', () => holder.attached !== null)
    expect(sendStatus(holder, 1, STATUS)).toBe(true)
    await until('the status', () => s.status.length === 1)
    // The same seq again (a holder never sends one twice; the tab takes it once all the same).
    sendStatus(holder, 1, STATUS)
    await new Promise((r) => setTimeout(r, 30))
    expect(s.status).toHaveLength(1)
    const [to, line] = s.status[0]
    expect(to).toBe(id)
    expect(line).toEqual({
      model: 'Opus', modelId: 'claude-opus-4-1',
      contextUsedPercent: 12, contextRemainingPercent: 88, contextWindowSize: 200000, inputTokens: 150, outputTokens: 40,
      costUsd: 1.25, totalDurationMs: 60000, linesAdded: 10, linesRemoved: 2,
      rateLimitCurrent: 42, rateLimitCurrentResets: new Date(1764000000 * 1000).toISOString(),
      rateLimitWeekly: 7, rateLimitWeeklyResets: '2026-11-30T00:00:00Z',
    })
    expect(JSON.stringify(line)).not.toMatch(/another-session|abc\.jsonl|sessionId|transcriptPath/)
    // The mapping was handed only what the keep-list names.
    expect(statusInputs).toHaveLength(1)
    expect(statusInputs[0]).toEqual({
      session_id: 'another-session', transcript_path: STATUS.transcript_path, cwd: '/home/nick/work', version: '2.1.300',
      model: { id: 'claude-opus-4-1', display_name: 'Opus' },
      workspace: STATUS.workspace,
      cost: { total_cost_usd: 1.25, total_duration_ms: 60000, total_lines_added: 10, total_lines_removed: 2 },
      context_window: STATUS.context_window,
      rate_limits: STATUS.rate_limits,
    })
    pty!.kill()
    await until('the holder to end', () => holder.ended)
  })

  it('a hook event reaches the session signals module for the tab, cut to the keep-list (no prompt, tool input or result)', async () => {
    const id = 'sig-hook'
    const s = signals()
    plugIn(s.deps)
    const holder = holderFor(id)
    answering(holder)
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    await until('attached', () => holder.attached !== null)
    holder.hookEvent('Notification', { hook_event_name: 'Notification', session_id: 's1', transcript_path: '/home/nick/t.jsonl', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt', cwd: '/home/nick/work' })
    holder.hookEvent('PreToolUse', { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'cat ~/.ssh/id_rsa' }, effort: { level: 'high', other: 1 }, agent_id: 'a1' })
    holder.hookEvent('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'my password is hunter2' })
    holder.hookEvent('StopFailure', { hook_event_name: 'StopFailure', session_id: 's1', error: 'overloaded_error', tool_response: { x: 1 } })
    await until('the events', () => s.events.length === 4)
    expect(s.events.map(([to]) => to)).toEqual([id, id, id, id])
    expect(s.events.map(([, e]) => ({ seq: e.seq, kind: e.kind, payload: e.payload }))).toEqual([
      { seq: 1, kind: 'Notification', payload: { hook_event_name: 'Notification', session_id: 's1', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt', transcript_path: '/home/nick/t.jsonl' } },
      { seq: 2, kind: 'PreToolUse', payload: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', agent_id: 'a1', effort: { level: 'high' } } },
      { seq: 3, kind: 'UserPromptSubmit', payload: { hook_event_name: 'UserPromptSubmit', session_id: 's1' } },
      { seq: 4, kind: 'StopFailure', payload: { hook_event_name: 'StopFailure', session_id: 's1', error: 'overloaded_error' } },
    ])
    expect(JSON.stringify(s.events)).not.toMatch(/id_rsa|hunter2|tool_response|tool_input/)
    pty!.kill()
    await until('the holder to end', () => holder.ended)
  })

  it('a tool stream its holder opens is served as the tab\'s session, its provider\'s, and messages go both ways', async () => {
    const id = 'sig-tools'
    const s = signals()
    plugIn(s.deps)
    const holder = holderFor(id)
    answering(holder)
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    await until('attached', () => holder.attached !== null)
    const n = holder.openToolStream()
    expect(n).not.toBeNull()
    await until('served', () => s.served.length === 1)
    const { link } = s.served[0]
    expect(s.served[0].id).toBe(id)
    expect(s.served[0].provider).toBe(DEFAULT_PROVIDER_ID)
    const got: unknown[] = []
    link.take((m) => got.push(m), () => got.push('closed'))
    holder.relay(n!, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'canvas_render' } })
    await until('the call', () => got.length === 1)
    link.send({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    await until('the answer', () => holder.toolSent.length === 1)
    expect(holder.toolSent[0]).toEqual({ stream: n, message: { jsonrpc: '2.0', id: 1, result: { content: [] } } })
    holder.endToolStream(n!)
    await until('the end', () => got.includes('closed'))
    pty!.kill()
    await until('the holder to end', () => holder.ended)
  })

  it('a dropped link: the events queued meanwhile arrive once, and the newest status once; a tool stream it kept is served again', async () => {
    const id = 'sig-drop'
    const s = signals()
    plugIn(s.deps)
    const holder = holderFor(id)
    answering(holder)
    let bridges = 0
    // The first try after the cut finds the link still down (the bridge exits 1
    // before its hello): the next try, after the first wait, attaches.
    ssh.host.bridgeExit = 1
    ssh.host.bridge = () => (++bridges === 2 ? null : holder.connect())
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    await until('attached', () => holder.attached !== null)
    sendStatus(holder, 1, STATUS)
    holder.hookEvent('Stop', { hook_event_name: 'Stop', session_id: 's1' })
    await until('the first status and event', () => s.status.length === 1 && s.events.length === 1)
    // A stream whose relay keeps it through a cut (its `away`): given back on the next attach.
    const kept = holder.openToolStream({ away: true })
    await until('served', () => s.served.length === 1)
    // The link drops: the bridge's ssh ends.
    const first = ssh.children[ssh.calls.findIndex((c) => c.script === 'bridge')]
    first.kill()
    await until('the holder to see it', () => holder.attached === null)
    holder.hookEvent('Notification', { hook_event_name: 'Notification', session_id: 's1', message: 'while away' })
    holder.hookEvent('Stop', { hook_event_name: 'Stop', session_id: 's1' })
    expect(holder.waitingEvents).toHaveLength(2)
    await until('attached again, and what waited delivered', () => bridges === 3 && holder.attached !== null && s.events.length === 3 && s.served.length === 2, 8000)
    // The new connection's ack: the holder sends it the newest status once
    // (section 3.1); an older one sent again is not taken twice.
    expect(sendStatus(holder, 2, { ...STATUS, version: 'newest' })).toBe(true)
    sendStatus(holder, 1, STATUS)
    await until('the newest status', () => s.status.length === 2)
    await new Promise((r) => setTimeout(r, 50))
    expect(s.events.map(([, e]) => e.seq)).toEqual([1, 2, 3])
    expect(s.events[1][1].payload).toEqual({ hook_event_name: 'Notification', session_id: 's1', message: 'while away' })
    expect(s.status).toHaveLength(2)
    expect(statusInputs.map((p) => p.version)).toEqual(['2.1.300', 'newest'])
    // The kept stream, served again as the tab's on the new connection.
    expect(kept).not.toBeNull()
    expect(s.served[1].id).toBe(id)
    expect(holder.relayTold.map((r) => r.t)).toEqual(['mcp.away', 'mcp.back'])
    pty!.kill()
    await until('the holder to end', () => holder.ended)
  })

  it('a second tab on the same machine: each status, event and tool stream goes to its own tab, and each has its own folder', async () => {
    const s = signals()
    plugIn(s.deps)
    const one = holderFor('sig-one')
    const two = holderFor('sig-two')
    const bySid = new Map([[one.sid, one], [two.sid, two]])
    ssh.host = {
      answer: (c) => {
        const n = c.values[0]
        if (c.script === 'hold') return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify(linuxRecord(bySid.get(c.values[5])!))}\n` }
        if (c.script === 'reads' || c.script === 'files' || c.script === 'unsession') return { stdout: result(n, {}) }
        return { code: 1 }
      },
      bridge: (c) => bySid.get(c.values[5])!.connect(),
    }
    const p1 = remoteHelperPty(win, 'sig-one', { ssh: SSH_TAB }, 100, 30)
    const p2 = remoteHelperPty(win, 'sig-two', { ssh: SSH_TAB }, 100, 30)
    await until('both attached', () => one.attached !== null && two.attached !== null)
    sendStatus(two, 1, { ...STATUS, version: 'two' })
    sendStatus(one, 1, { ...STATUS, version: 'one' })
    two.hookEvent('Stop', { hook_event_name: 'Stop', session_id: 'b' })
    one.openToolStream()
    await until('all delivered', () => s.status.length === 2 && s.events.length === 1 && s.served.length === 1)
    expect(s.status.map(([id]) => id).sort()).toEqual(['sig-one', 'sig-two'])
    expect(statusInputs.map((p) => p.version).sort()).toEqual(['one', 'two'])
    expect(s.events.map(([id]) => id)).toEqual(['sig-two'])
    expect(s.served.map((x) => x.id)).toEqual(['sig-one'])
    const folders = ssh.calls.filter((c) => c.script === 'files').map((c) => c.values[3])
    expect(folders.sort()).toEqual([one.sid, two.sid].sort())
    p1!.kill()
    p2!.kill()
    await until('both holders to end', () => one.ended && two.ended)
    // Each tab's hook state is ended for its own id, once.
    await until('both ends', () => s.ended.length === 2)
    expect([...s.ended].sort()).toEqual(['sig-one', 'sig-two'])
  })

  it('with no app side plugged in, its connections ask for none of them, and its files still go', async () => {
    const id = 'sig-none'
    plugIn(undefined)
    const holder = holderFor(id)
    answering(holder)
    const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30)
    await until('attached', () => holder.attached !== null)
    expect(holder.attached!.ackedCaps).toEqual(['core', 'local'])
    expect(ssh.scripts()).toEqual(['reads', 'field', 'hold', 'files', 'bridge'])
    pty!.kill()
    await until('the holder to end', () => holder.ended)
  })
})
