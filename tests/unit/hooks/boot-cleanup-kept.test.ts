// 2.1.3-beta.14, plan section A1 (S16 step 4, aicc_planning#359): the start-up
// sweeps of per-session files leave the files of the agent sessions the
// session helper keeps for the next run (its records of sessions an app
// update kept running, keptSessionIdsIn), and still sweep every other
// session's. index.ts hands both sweeps that set (read here from its source).
//
// The settings writer's hardened write (an owner-only folder and file) is a
// plain write here, so no folder's permissions change on the machine that
// runs this; boot-cleanup.test.ts covers the sweeps with the real writer.
//
// Not checked here: the sweeps' own rules for a file not kept (boot-cleanup's
// own tests); that a start which ends a kept session removes its record
// before the sweeps run (tests/unit/main/session-helper-update-keep.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

vi.mock('../../../src/main/account-profiles', async (importOriginal) => {
  const nodeFs = await import('node:fs')
  return {
    ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
    mkdirSecure: (d: string) => { nodeFs.mkdirSync(d, { recursive: true }) },
    hardenCredentialDir: () => {},
    atomicWriteSecure: (f: string, data: string) => { nodeFs.writeFileSync(f, data) },
  }
})
// The manager's module loads node-pty; nothing here starts a terminal.
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not used in this file') } }))

import { cleanupStaleHookEntries, cleanupStaleMcpConfigs } from '../../../src/main/hooks/boot-cleanup'
import { keptSessionIdsIn } from '../../../src/main/session-helper/manager'
import { heldAgentSessionId } from '../../../src/main/session-helper/protocol'

const KEPT_TAB = 'abcdef0123456789abcdee11'
const GONE_TAB = 'abcdef0123456789abcdee12'
const HOOKS = { hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:19334/hook/x' }] }] } }

let base = ''
let claudeDir = ''
let helperRoot = ''
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-bootclean-kept-'))
  claudeDir = path.join(base, '.claude')
  helperRoot = path.join(base, 'helper')
  fs.mkdirSync(claudeDir, { recursive: true })
  vi.spyOn(os, 'homedir').mockReturnValue(base)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(base, { recursive: true, force: true })
})

/** One session's three per-session files, as its launch wrote them. */
function filesOf(tab: string): string[] {
  const settings = path.join(claudeDir, `settings-${tab}.json`)
  const mcp = path.join(claudeDir, `mcp-${tab}.json`)
  const status = path.join(claudeDir, `ccc-status-${tab}.url`)
  fs.writeFileSync(settings, JSON.stringify(HOOKS))
  fs.writeFileSync(mcp, '{"mcpServers":{}}')
  fs.writeFileSync(status, 'http://127.0.0.1:19333/status?token=t')
  return [settings, mcp, status]
}

/** The record an update's release writes for a kept Claude Code session. */
function recordKept(tab: string): void {
  const sid = heldAgentSessionId(tab, 'claude')
  fs.mkdirSync(path.join(helperRoot, 'kept'), { recursive: true })
  fs.writeFileSync(path.join(helperRoot, 'kept', `${sid}.json`), JSON.stringify({ v: 1, session: sid, label: tab, provider: 'claude', conversation: null, account: null, hookFolder: null, at: 1 }))
}

describe('the start-up sweeps leave a kept session\'s files (S16 step 4, #359)', () => {
  it('a kept tab\'s three files survive both sweeps; another tab\'s go as before', () => {
    recordKept(KEPT_TAB)
    const [keptSettings, keptMcp, keptStatus] = filesOf(KEPT_TAB)
    const [goneSettings, goneMcp, goneStatus] = filesOf(GONE_TAB)
    const keep = keptSessionIdsIn(helperRoot)
    expect(keep).toEqual(new Set([KEPT_TAB]))
    expect(cleanupStaleHookEntries(keep)).toBe(1)
    expect(cleanupStaleMcpConfigs(keep)).toBe(2)
    expect(JSON.parse(fs.readFileSync(keptSettings, 'utf8'))).toEqual(HOOKS)
    expect(fs.existsSync(keptMcp)).toBe(true)
    expect(fs.existsSync(keptStatus)).toBe(true)
    expect(JSON.parse(fs.readFileSync(goneSettings, 'utf8')).hooks).toBeUndefined()
    expect(fs.existsSync(goneMcp)).toBe(false)
    expect(fs.existsSync(goneStatus)).toBe(false)
  })

  it('no records, or none that reads: nothing is kept', () => {
    expect(keptSessionIdsIn(helperRoot)).toEqual(new Set())
    fs.mkdirSync(path.join(helperRoot, 'kept'), { recursive: true })
    fs.writeFileSync(path.join(helperRoot, 'kept', `${heldAgentSessionId(KEPT_TAB, 'claude')}.json`), '{ not json')
    expect(keptSessionIdsIn(helperRoot)).toEqual(new Set())
  })
})

describe('index.ts hands both sweeps the kept set', () => {
  const root = path.resolve(__dirname, '../../..')
  const index = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')
  const wiring = fs.readFileSync(path.join(root, 'src/main/session-helper/app-wiring.ts'), 'utf8').replace(/\r\n/g, '\n')

  it('each sweep is called once, with sessionHelperKeptIds(), and never with an empty set', () => {
    expect(index.match(/cleanupStaleHookEntries\(/g)).toHaveLength(1)
    expect(index.match(/cleanupStaleMcpConfigs\(/g)).toHaveLength(1)
    expect(index).toContain('cleanupStaleHookEntries(sessionHelperKeptIds())')
    expect(index).toContain('cleanupStaleMcpConfigs(sessionHelperKeptIds())')
    expect(index).not.toMatch(/cleanupStale(HookEntries|McpConfigs)\(new Set/)
  })

  it('sessionHelperKeptIds reads the helper\'s records from its folder, and the hook folder sweep is given the same records\' folders', () => {
    expect(wiring).toMatch(/export function sessionHelperKeptIds\(\): Set<string> \{\n {2}try \{\n {4}return keptSessionIdsIn\(rootDir\(\)\)/)
    expect(wiring).toMatch(/export function sessionHelperKeptHookFolders\(\): string\[\] \{\n {2}try \{\n {4}return keptHookFoldersIn\(rootDir\(\)\)/)
    expect(index).toContain('prepareHookFolders?.(getResourcesDirectory(), secureOwnerOnlyFolders, sessionHelperKeptHookFolders)')
  })
})
