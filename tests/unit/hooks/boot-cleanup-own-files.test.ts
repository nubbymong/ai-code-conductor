// The start-up sweep of ~/.claude/settings-<sid>.json (aicc_planning#385): a
// file a local launch of this install wrote for a session that is over is
// removed; any other file keeps today's handling (the app's /hook/ entries
// taken out, the file kept).
//
// Each file is built by the app's own builders (the status line command, the
// gateway hooks and the session helper's hook mode), so a change to how a
// launch writes its file shows here. The home and the resources folder are
// this test's own temp folders; the owner-only writer is replaced by a plain
// write, so nothing but those folders is touched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({ resources: '', logs: [] as string[] }))

vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.resources }))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { h.logs.push(a.map(String).join(' ')) },
  logWarn: () => {}, logError: () => {}, logDebug: () => {},
}))
// A plain write in place of the owner-only one (only this test's folders).
vi.mock('../../../src/main/account-profiles', async () => {
  const nodeFs = await import('node:fs')
  return {
    mkdirSecure: (dir: string) => { nodeFs.mkdirSync(dir, { recursive: true }) },
    hardenCredentialDir: () => {},
    atomicWriteSecure: (file: string, data: string) => { nodeFs.writeFileSync(file, data) },
  }
})

const { cleanupStaleHookEntries, cleanupStaleMcpConfigs } = await import('../../../src/main/hooks/boot-cleanup')
const { buildHooksBlock, buildHelperHooksBlock, MVP_EVENTS } = await import('../../../src/main/hooks/session-hooks-writer')
const { buildStatuslineSetting } = await import('../../../src/main/providers/claude/statusline-command')
const { heldAgentSessionId } = await import('../../../src/main/session-helper/protocol')

/** App session ids: 12 random bytes as hex, as the app makes them. */
const SID = '181cf10c8af1b95dccecce06'
const OTHER = '51166611f2e5e31450c55ba0'
const HELPER = 'C:\\Users\\user\\AppData\\Local\\AI Code Conductor\\helper\\aicc-helper.exe'
const STORE = 'C:\\Users\\user\\AppData\\Local\\AI Code Conductor\\helper\\store'

let home = ''
let claudeDir = ''

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bootclean-own-')))
  claudeDir = path.join(home, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  h.resources = path.join(home, 'resources')
  h.logs.length = 0
  vi.spyOn(os, 'homedir').mockReturnValue(home)
})
afterEach(() => {
  vi.restoreAllMocks()
  // TEST CLEANUP GUARD: only this test's own folder under the temp folder.
  if (path.basename(home).startsWith('bootclean-own-') && path.dirname(home) === fs.realpathSync.native(os.tmpdir())) {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/** The status line a local launch of this install writes for `sid`. */
function appStatusLine(sid: string, withUrlFile: boolean, resources = h.resources): unknown {
  const s = buildStatuslineSetting(resources, sid, withUrlFile ? path.join(claudeDir, `ccc-status-${sid}.url`) : undefined)
  expect(s).not.toBeNull()
  return s
}

/** The hooks of a held Claude Code session: the helper's hook mode for its holder. */
function heldHooks(sid: string, holderOf = sid): Record<string, unknown[]> {
  const hooks = buildHelperHooksBlock({ helperPath: HELPER, store: STORE, sid: heldAgentSessionId(holderOf, 'claude'), launcher: 'git-bash' })
  expect(hooks).not.toBeNull()
  return hooks as Record<string, unknown[]>
}

function put(sid: string, body: unknown): string {
  const f = path.join(claudeDir, `settings-${sid}.json`)
  fs.writeFileSync(f, JSON.stringify(body, null, 2))
  return f
}

const read = (f: string): Record<string, unknown> => JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, unknown>

describe('the start-up sweep removes a settings file this install\'s launch left', () => {
  // Mutation to prove this can fail: strip the hooks and keep the file, as before.
  it('a file with the launch\'s status line, its status file and its gateway hooks', () => {
    const f = put(SID, { effortLevel: 'high', statusLine: appStatusLine(SID, true), hooks: buildHooksBlock(SID, 19334, 'token') })
    expect(cleanupStaleHookEntries(new Set())).toBe(1)
    expect(fs.existsSync(f)).toBe(false)
    expect(h.logs).toEqual([expect.stringContaining('removed 1 settings file(s) an earlier run of the app left')])
  })

  it('the file an earlier start already rewrote with no hooks (the 462-byte leftover)', () => {
    const f = put(SID, { effortLevel: 'high', theme: 'dark', statusLine: appStatusLine(SID, true), permissions: { allow: ['mcp__conductor__canvas_snapshot'] } })
    expect(cleanupStaleHookEntries(new Set())).toBe(1)
    expect(fs.existsSync(f)).toBe(false)
  })

  it('a file whose status line has no status file (the tool server was not up)', () => {
    const f = put(SID, { statusLine: appStatusLine(SID, false), hooks: buildHooksBlock(SID, 19334, 'token') })
    expect(cleanupStaleHookEntries(new Set())).toBe(1)
    expect(fs.existsSync(f)).toBe(false)
  })

  // Mutation to prove this can fail: drop the hook-mode check.
  it('a held session\'s file with no status line of the app\'s (its hooks run the helper\'s hook mode)', () => {
    const f = put(SID, { statusLine: { type: 'command', command: 'my-own-status-line' }, hooks: heldHooks(SID) })
    expect(cleanupStaleHookEntries(new Set())).toBe(1)
    expect(fs.existsSync(f)).toBe(false)
  })

  it('a held session\'s file whose PreToolUse runs the hook mode too', () => {
    const command = (heldHooks(SID).Stop[0] as { hooks: Array<{ command: string }> }).hooks[0].command
    const hooks = Object.fromEntries(MVP_EVENTS.map((e) => [e, [{ matcher: '', hooks: [{ type: 'command', command, timeout: 10 }] }]]))
    const f = put(SID, { hooks })
    expect(cleanupStaleHookEntries(new Set())).toBe(1)
    expect(fs.existsSync(f)).toBe(false)
  })

  // Mutation to prove this can fail: leave the settings files to the hooks pass.
  it('the always-run pass removes it too (the hooks switched off), with the sidecars', () => {
    const f = put(SID, { statusLine: appStatusLine(SID, true) })
    const user = put('work', { statusLine: { type: 'command', command: 'my-own-status-line' } })
    fs.writeFileSync(path.join(claudeDir, `mcp-${SID}.json`), '{}')
    fs.writeFileSync(path.join(claudeDir, `ccc-status-${SID}.url`), 'http://localhost:1/status')
    expect(cleanupStaleMcpConfigs(new Set())).toBe(3)
    expect(fs.existsSync(f)).toBe(false)
    expect(fs.existsSync(user)).toBe(true)
    expect(fs.readdirSync(claudeDir)).toEqual(['settings-work.json'])
  })
})

describe('the start-up sweep keeps every other settings file', () => {
  // Mutation to prove these can fail: remove every stale settings file.
  it('an active session\'s file stays as it is', () => {
    const body = { statusLine: appStatusLine(SID, true), hooks: buildHooksBlock(SID, 19334, 'token') }
    const f = put(SID, body)
    expect(cleanupStaleHookEntries(new Set([SID]))).toBe(0)
    expect(cleanupStaleMcpConfigs(new Set([SID]))).toBe(0)
    expect(read(f)).toEqual(body)
  })

  it('a user\'s own file of the same name pattern stays as it is', () => {
    const body = { statusLine: { type: 'command', command: 'node "C:\\\\tools\\\\line.js"' }, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo done' }] }] } }
    const app = put(OTHER, body)
    const named = put('work', body)
    expect(cleanupStaleHookEntries(new Set())).toBe(0)
    expect(cleanupStaleMcpConfigs(new Set())).toBe(0)
    expect(read(app)).toEqual(body)
    expect(read(named)).toEqual(body)
  })

  // Mutation to prove this can fail: drop the id-shape check.
  it('a name that is not an app session id stays, even with the bridge for that name in it', () => {
    const f = put('work', { statusLine: appStatusLine('work', false) })
    expect(cleanupStaleHookEntries(new Set())).toBe(0)
    expect(cleanupStaleMcpConfigs(new Set())).toBe(0)
    expect(fs.existsSync(f)).toBe(true)
  })

  // Mutation to prove these can fail: match the bridge or the hook mode without the file's id.
  it('the bridge for another session, or another install\'s bridge, is not this file\'s', () => {
    const other = put(SID, { statusLine: appStatusLine(OTHER, true) })
    const elsewhere = put(OTHER, { statusLine: appStatusLine(OTHER, true, path.join(home, 'another-install')) })
    expect(cleanupStaleHookEntries(new Set())).toBe(0)
    expect(cleanupStaleMcpConfigs(new Set())).toBe(0)
    expect(fs.existsSync(other)).toBe(true)
    expect(fs.existsSync(elsewhere)).toBe(true)
  })

  it('the hook mode for another session\'s holder is not this file\'s: its app hooks are taken out, the file kept', () => {
    // A held session's file as a build before 2.1.3-beta.14 wrote it, with
    // PreToolUse still on the gateway: that /hook/ entry is what is taken out.
    const f = put(SID, { hooks: { ...heldHooks(SID, OTHER), PreToolUse: buildHooksBlock(SID, 19334, 'token').PreToolUse } })
    expect(cleanupStaleHookEntries(new Set())).toBe(1)
    expect(fs.existsSync(f)).toBe(true)
    expect(read(f).hooks).toBeUndefined()
    // From 2.1.3-beta.14 every entry runs the hook mode and none names a
    // /hook/ address, so there is nothing to take out: the file stays as it is.
    const body = { hooks: heldHooks(SID, OTHER) }
    put(SID, body)
    expect(cleanupStaleHookEntries(new Set())).toBe(0)
    expect(read(f)).toEqual(body)
  })

  it('a file an SSH session from another computer wrote here: its hooks are taken out, the file kept', () => {
    const statusLine = { type: 'command', command: `CLAUDE_MULTI_SESSION_ID=${SID} CCC_TMUX_BIN=/usr/bin/tmux node /home/user/.claude/conductor-ssh-statusline.js` }
    const f = put(SID, { theme: 'dark', statusLine, hooks: buildHooksBlock(SID, 19555, 'token') })
    expect(cleanupStaleHookEntries(new Set())).toBe(1)
    expect(cleanupStaleMcpConfigs(new Set())).toBe(0)
    expect(read(f)).toEqual({ theme: 'dark', statusLine })
    expect(h.logs).toEqual([expect.stringContaining('took the app\'s hooks out of 1 other file(s), which stay')])
  })
})
