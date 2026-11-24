// HOST QUARANTINE: plants a directory junction (a symbolic link off Windows). [CI] [VM] only -- never run on the owner's machine.
// 2.1.3-beta.17, plan section C4 (aicc_planning#407), the link case of
// pick-folder-sweep.test.ts, here so the host-safe file plants no link: a
// link or junction with a pick folder's name, itself a day old, pointing at
// a day-old folder that holds only a pick file (what the sweep would take,
// were it to follow the link), is left as it is, and nothing in the folder
// it points at is removed.
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '', getDataDirectory: () => '' }))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))
vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: () => ({}),
  readConfigChecked: () => ({ outcome: 'absent', value: null }),
  getConfigDir: () => '/cfg',
}))
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { sweepStaleCodexPickFolders, CODEX_PICK_DIR_PREFIX, CODEX_PICK_FILE_NAME } = await import('../../../../src/main/providers/codex/spawn')

const TEST_PREFIX = 'c4-pick-sweep-links-'
const HOUR = 3_600_000
const made: string[] = []
const links: string[] = []

function root(): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), TEST_PREFIX)))
  made.push(d)
  return d
}

/** A folder link: a junction on Windows (no special right needed), a symlink elsewhere. */
function folderLink(target: string, at: string): void {
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(at)
}

afterEach(() => {
  // Links first, removed as links (never followed).
  for (const l of links.splice(0)) {
    const st = fs.lstatSync(l, { throwIfNoEntry: false })
    if (!st || !st.isSymbolicLink()) continue
    try { fs.unlinkSync(l) } catch { fs.rmdirSync(l) }
  }
  // TEST CLEANUP GUARD: only the folders this test made, by their own prefix, directly in the temp folder.
  for (const d of made.splice(0)) {
    if (!path.basename(d).startsWith(TEST_PREFIX) || path.dirname(d) !== fs.realpathSync.native(os.tmpdir())) continue
    fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('the start-up sweep of left-behind pick folders: links (aicc_planning#407)', () => {
  it('leaves a link or junction with a pick folder\'s name, and everything in the folder it points at', () => {
    const tmp = root()
    const old = new Date(Date.now() - 25 * HOUR)
    const target = path.join(tmp, 'elsewhere')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, CODEX_PICK_FILE_NAME), '{"fresh":true}')
    fs.utimesSync(target, old, old)
    const link = path.join(tmp, `${CODEX_PICK_DIR_PREFIX}link01`)
    folderLink(target, link)
    fs.lutimesSync(link, old, old)
    // What a sweep that followed the link, or read its age, would see: a
    // day-old folder holding only a pick file.
    expect(fs.statSync(link).isDirectory()).toBe(true)
    expect(Date.now() - fs.statSync(link).mtimeMs).toBeGreaterThan(24 * HOUR)
    expect(Date.now() - fs.lstatSync(link).mtimeMs).toBeGreaterThan(24 * HOUR)
    expect(fs.readdirSync(link)).toEqual([CODEX_PICK_FILE_NAME])

    expect(sweepStaleCodexPickFolders(tmp)).toBe(0)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readdirSync(target)).toEqual([CODEX_PICK_FILE_NAME])
  })
})
