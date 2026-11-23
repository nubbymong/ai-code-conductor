// 2.1.3-beta.14, plan section A1 (S16 step 4, aicc_planning#359): the hook
// folder of a Codex session an app update kept running. The sweep of
// left-behind hook folders passes by the ones the session helper's records
// name, whatever their age (the preparation asks for them when it sweeps),
// and a recorded folder is removed on asking once its session is no longer
// kept: only a per-launch folder directly inside this install's own hook
// root, emptied of what the app put there, as the sweep removes one.
//
// No link, junction or hard link is planted here (the host-safe file); the
// link cases of the shared folder check (realFolderChainBelow) are
// hooks-links.test.ts, quarantined from the host.
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  writeCodexHookFile,
  sweepStaleCodexHookFolders,
  removeKeptCodexHookFolder,
  prepareCodexHookFolders,
  __resetCodexHookFoldersForTests,
  CODEX_HOOK_DIR_PREFIX,
  CODEX_HOOK_ROOT_NAME,
  CODEX_HOOK_STALE_MS,
} from '../../../../src/main/providers/codex/hooks'

const TOKEN = '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60'
const TEST_PREFIX = 'a1-kept-hooks-test-'
const made: string[] = []
function tmp(): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), TEST_PREFIX)))
  made.push(d)
  return d
}
afterEach(() => {
  __resetCodexHookFoldersForTests()
  // TEST CLEANUP GUARD: only the folders this test made, by their own prefix, under the temp folder.
  for (const d of made.splice(0)) {
    if (!path.basename(d).startsWith(TEST_PREFIX) || path.dirname(d) !== fs.realpathSync.native(os.tmpdir())) continue
    fs.rmSync(d, { recursive: true, force: true })
  }
})

/** A data folder with its hook root. */
function dataWithRoot(): { data: string; root: string } {
  const data = tmp()
  const root = path.join(data, CODEX_HOOK_ROOT_NAME)
  fs.mkdirSync(root)
  return { data, root }
}
const aged = (dir: string): void => {
  const past = new Date(Date.now() - CODEX_HOOK_STALE_MS - 60_000)
  fs.utimesSync(dir, past, past)
}

describe('the sweep passes by a kept session\'s hook folder', () => {
  it('a recorded folder older than a day survives; an unrecorded one of the same age goes', () => {
    const { root } = dataWithRoot()
    const kept = writeCodexHookFile('sess-kept', 51234, TOKEN, root)!
    const left = writeCodexHookFile('sess-left', 51234, TOKEN, root)!
    aged(kept.dir)
    aged(left.dir)
    expect(sweepStaleCodexHookFolders(root, Date.now(), CODEX_HOOK_STALE_MS, [kept.dir])).toBe(1)
    expect(fs.existsSync(kept.file)).toBe(true)
    expect(fs.existsSync(left.dir)).toBe(false)
  })

  it('the record\'s spelling of the folder need not be the sweep\'s own (a relative step, and on Windows another case)', () => {
    const { root } = dataWithRoot()
    const kept = writeCodexHookFile('sess-kept', 51234, TOKEN, root)!
    aged(kept.dir)
    const spelled = path.join(root, '..', CODEX_HOOK_ROOT_NAME, path.basename(kept.dir))
    const named = process.platform === 'win32' ? spelled.toUpperCase() : spelled
    expect(sweepStaleCodexHookFolders(root, Date.now(), CODEX_HOOK_STALE_MS, [named])).toBe(0)
    expect(fs.existsSync(kept.file)).toBe(true)
  })

  it('the preparation hands the sweep what it is told is kept, asked when it sweeps', async () => {
    const { data, root } = dataWithRoot()
    const kept = fs.mkdtempSync(path.join(root, CODEX_HOOK_DIR_PREFIX))
    const left = fs.mkdtempSync(path.join(root, CODEX_HOOK_DIR_PREFIX))
    aged(kept)
    aged(left)
    const res = tmp()
    fs.mkdirSync(path.join(res, 'scripts'))
    const secure = async (dirs: readonly string[]) => dirs.map((dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir); return { dir, ok: true } })
    let asked = 0
    const out = await prepareCodexHookFolders({ dataDir: data, scriptsDir: path.join(res, 'scripts'), plainDir: null }, secure, () => { asked++; return [kept] })
    expect(out.root).toBe(true)
    expect(asked).toBe(1)
    expect(fs.existsSync(kept)).toBe(true)
    expect(fs.existsSync(left)).toBe(false)
  })
})

describe('a kept session\'s hook folder, removed once it is not kept', () => {
  it('a per-launch folder of this install\'s hook root: emptied of the hook file and removed', () => {
    const { data, root } = dataWithRoot()
    const h = writeCodexHookFile('sess-kept', 51234, TOKEN, root)!
    expect(removeKeptCodexHookFolder(h.dir, data)).toBe(true)
    expect(fs.existsSync(h.dir)).toBe(false)
  })

  it('a folder holding anything else: only the hook file goes, and the folder stays', () => {
    const { data, root } = dataWithRoot()
    const h = writeCodexHookFile('sess-kept', 51234, TOKEN, root)!
    fs.writeFileSync(path.join(h.dir, 'keep.txt'), 'x')
    expect(removeKeptCodexHookFolder(h.dir, data)).toBe(false)
    expect(fs.readdirSync(h.dir)).toEqual(['keep.txt'])
  })

  it('any other path is left as it is: another folder\'s, one without the prefix, one below a per-launch folder, a relative path, no data folder', () => {
    const { data, root } = dataWithRoot()
    const elsewhere = tmp()
    const lookalike = fs.mkdtempSync(path.join(elsewhere, CODEX_HOOK_DIR_PREFIX))
    fs.writeFileSync(path.join(lookalike, 'hook.json'), '{}')
    const foreign = fs.mkdtempSync(path.join(root, 'someone-else-'))
    fs.writeFileSync(path.join(foreign, 'hook.json'), '{}')
    const h = writeCodexHookFile('sess-kept', 51234, TOKEN, root)!
    const below = path.join(h.dir, `${CODEX_HOOK_DIR_PREFIX}inner`)
    fs.mkdirSync(below)
    fs.writeFileSync(path.join(below, 'hook.json'), '{}')
    expect(removeKeptCodexHookFolder(lookalike, data)).toBe(false)
    expect(removeKeptCodexHookFolder(foreign, data)).toBe(false)
    expect(removeKeptCodexHookFolder(below, data)).toBe(false)
    // (A relative spelling written out: path.relative answers an absolute
    // path when the temp folder is on another drive.)
    expect(removeKeptCodexHookFolder(path.join(CODEX_HOOK_ROOT_NAME, path.basename(h.dir)), data)).toBe(false)
    expect(removeKeptCodexHookFolder(h.dir, null)).toBe(false)
    expect(removeKeptCodexHookFolder(h.dir, path.basename(data))).toBe(false)
    for (const f of [path.join(lookalike, 'hook.json'), path.join(foreign, 'hook.json'), path.join(below, 'hook.json'), h.file]) expect(fs.existsSync(f), f).toBe(true)
  })
})
