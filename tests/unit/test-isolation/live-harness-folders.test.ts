// The live SSH pack's harness removes the folders it makes (tests/live/statusline-harness.ts,
// aicc_planning #332).
//
// The live pack runs outside the unit config's temp redirect (vitest.live.config.ts), so
// a folder its harness makes and does not remove stays in the machine temp folder: before
// #332 the data folder was removed at the end of each lane file and the scratch folder
// (its config, resources and app folder) never was.
//
// This loads the harness module with every app module it imports replaced by a fake (no
// pty, no ssh, no MCP server, no logger) and no hosts file, and records the exit hooks it
// registers instead of handing them to the process. Under the unit config tmpdir() is this
// worker's own temp folder, so the folders it makes land there. Nothing of the pack runs.
import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { TEST_TMP_ROOT } from '../../helpers/test-tmp'

vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(), writePty: vi.fn(), resizePty: vi.fn(), endSshRemote: vi.fn(),
}))
vi.mock('../../../src/main/providers', () => ({ registerProvider: vi.fn() }))
vi.mock('../../../src/main/providers/claude', () => ({ ClaudeProvider: class {} }))
vi.mock('../../../src/main/statusline-watcher', () => ({ startStatuslineWatcher: vi.fn() }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({ startConductorMcpServer: vi.fn(), stopConductorMcpServer: vi.fn() }))
vi.mock('../../../src/main/debug-logger', () => ({ closeDebugLogger: vi.fn() }))

const before = new Set(fs.readdirSync(os.tmpdir()))
const exitHooks: Array<() => void> = []
const savedEnv = { CCC_LIVE_HOSTS: process.env.CCC_LIVE_HOSTS, CCC_E2E_DATA_DIR: process.env.CCC_E2E_DATA_DIR }
const realOnce = process.once.bind(process)
const once = vi.spyOn(process, 'once').mockImplementation(((event: string, fn: () => void) => {
  if (event === 'exit') {
    exitHooks.push(fn)
    return process
  }
  return realOnce(event, fn)
}) as typeof process.once)
// No hosts file: the harness reads none of the user's hosts.
process.env.CCC_LIVE_HOSTS = path.join(TEST_TMP_ROOT, 'ccc-live-no-hosts.json')
try {
  await import('../../live/statusline-harness')
} finally {
  once.mockRestore()
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}
const made = fs.readdirSync(os.tmpdir()).filter((n) => !before.has(n) && n.startsWith('ccc-live-')).map((n) => path.join(os.tmpdir(), n))
const scratch = made.filter((p) => !path.basename(p).startsWith('ccc-live-data-'))
const data = made.filter((p) => path.basename(p).startsWith('ccc-live-data-'))

describe('the live harness', () => {
  it('makes one scratch folder and one data folder, in the temp folder', () => {
    expect(scratch, made.join(', ')).toHaveLength(1)
    expect(data, made.join(', ')).toHaveLength(1)
    for (const p of made) expect(path.dirname(p)).toBe(os.tmpdir())
  })

  it('registers a removal at exit that takes the scratch folder as well as the data folder', () => {
    expect(exitHooks.length).toBeGreaterThan(0)
    for (const hook of exitHooks) hook()
    expect(fs.existsSync(data[0]), 'the data folder is still there').toBe(false)
    expect(fs.existsSync(scratch[0]), 'the scratch folder is still there').toBe(false)
  })
})
