// HOST QUARANTINE: plants directory junctions and symbolic links in its own temp folder. [CI] [VM] only -- never run on the owner's machine.
// The link cases of managed-launch-picker-siblings.test.ts, kept here so the
// host-safe file plants none. A sibling worktree the resume picker lists at a
// link to a folder is a folder (the folder check follows the link), so once
// the gate finds it clean it is handed to the picker like any other; a link
// that leads nowhere is no folder, and is left out. Real folders in a temp
// folder; nothing is started.
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: () => {}, logError: () => {}, logDebug: () => {}, logWarn: () => {},
}))
vi.mock('../../../src/main/claude-cli-version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/claude-cli-version')>()),
  ensureClaudeCliVersion: () => {},
}))

const { gatePickerSiblingDirs, gateManagedLaunchDirs } = await import('../../../src/main/managed-launch-diagnostics')

const isWin = process.platform === 'win32'
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) {
    // TEST CLEANUP GUARD: only this file's own folders, by their prefix and parent.
    if (path.basename(r).startsWith('ccc-siblings-links-') && path.dirname(r) === path.resolve(os.tmpdir())) fs.rmSync(r, { recursive: true, force: true })
  }
})
const link = (target: string, at: string): void => fs.symlinkSync(target, at, isWin ? 'junction' : 'dir')

// Mutation to prove this can fail: ask for the folder with lstat, which
// answers for the link itself.
describe('a sibling at a link', () => {
  it('is handed over when the link leads to a folder, and left out when it leads nowhere', async () => {
    const made = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-siblings-links-'))
    roots.push(made)
    const root = fs.realpathSync.native(made)
    const main = path.join(root, 'main')
    const wt = path.join(root, 'wt')
    const via = path.join(root, 'wt-via')
    const dangling = path.join(root, 'wt-dangling')
    fs.mkdirSync(main)
    fs.mkdirSync(wt)
    link(wt, via)
    link(path.join(root, 'nothing'), dangling)
    const r = await gatePickerSiblingDirs([main], [main, via, dangling])
    expect(r.launch).toEqual([main])
    expect(r.clean).toEqual([via])
  })

  it('a resume target at a link to a folder is handed over too', async () => {
    const made = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-siblings-links-'))
    roots.push(made)
    const root = fs.realpathSync.native(made)
    const main = path.join(root, 'main')
    const wt = path.join(root, 'wt')
    const via = path.join(root, 'wt-via')
    fs.mkdirSync(main)
    fs.mkdirSync(wt)
    link(wt, via)
    // Gated first, as a launch gates its own folders: the folder check runs
    // for a resume target only once its own gate has answered clean.
    expect(await gateManagedLaunchDirs([main, via])).toEqual({ status: 'clean' })
    expect((await gatePickerSiblingDirs([main, via], [main, via])).launch).toEqual([main, via])
  })
})
