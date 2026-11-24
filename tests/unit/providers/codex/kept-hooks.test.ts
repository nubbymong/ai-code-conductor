// 2.1.3-beta.17, plan section B1.2 (S16 step 5, aicc_planning#412): the hook
// file of a Codex session an app update kept running, written again for the
// run that takes it over (providers/codex/kept-hooks.ts): in the same
// per-launch folder, with this run's gateway port and a token minted for the
// take-over, whole, as the launch wrote it; only in a per-launch folder
// directly inside this install's prepared hook root.
//
// No link, junction or hard link is planted here (the host-safe file); the
// link cases of the shared folder check (realFolderChainBelow) are
// hooks-links.test.ts, quarantined from the host.
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { writeCodexHookFile, prepareCodexHookFolders, __resetCodexHookFoldersForTests, CODEX_HOOK_DIR_PREFIX, CODEX_HOOK_ROOT_NAME } from '../../../../src/main/providers/codex/hooks'
import { rewriteKeptCodexHookFile } from '../../../../src/main/providers/codex/kept-hooks'

const OLD_TOKEN = '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60'
const NEW_TOKEN = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const TEST_PREFIX = 'b1-kept-hooks-test-'
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

/** A data folder whose hook root this run prepared, as the app's start does. */
async function preparedData(): Promise<{ data: string; root: string }> {
  const data = tmp()
  const root = path.join(data, CODEX_HOOK_ROOT_NAME)
  const res = tmp()
  fs.mkdirSync(path.join(res, 'scripts'))
  const secure = async (dirs: readonly string[]) => dirs.map((dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir); return { dir, ok: true } })
  const out = await prepareCodexHookFolders({ dataDir: data, scriptsDir: path.join(res, 'scripts'), plainDir: null }, secure)
  expect(out.root).toBe(true)
  return { data, root }
}

const readHook = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'))

describe('a kept Codex session\'s hook file, written again for the take-over', () => {
  it('in the same folder: this run\'s port and the new token, the session id, whole; nothing else in the folder changes', async () => {
    const { data, root } = await preparedData()
    const last = writeCodexHookFile('sess-kept', 51234, OLD_TOKEN, root)!
    fs.writeFileSync(path.join(last.dir, 'other.txt'), 'x')
    const file = rewriteKeptCodexHookFile(last.dir, 'sess-kept', 51999, NEW_TOKEN, data)
    expect(file).toBe(last.file)
    expect(readHook(last.file)).toEqual({ v: 1, port: 51999, sid: 'sess-kept', token: NEW_TOKEN })
    expect(fs.readdirSync(last.dir).sort()).toEqual(['hook.json', 'other.txt'])
    if (process.platform !== 'win32') expect(fs.statSync(last.file).mode & 0o777).toBe(0o600)
  })

  it('refused, and nothing written, for a folder that is not a per-launch folder of the prepared root: another folder\'s, one without the prefix, one below a per-launch folder, a relative path, a folder that is not there', async () => {
    const { data, root } = await preparedData()
    const elsewhere = tmp()
    const lookalike = fs.mkdtempSync(path.join(elsewhere, CODEX_HOOK_DIR_PREFIX))
    const foreign = fs.mkdtempSync(path.join(root, 'someone-else-'))
    const last = writeCodexHookFile('sess-kept', 51234, OLD_TOKEN, root)!
    const below = path.join(last.dir, `${CODEX_HOOK_DIR_PREFIX}inner`)
    fs.mkdirSync(below)
    for (const dir of [lookalike, foreign, below, path.join(CODEX_HOOK_ROOT_NAME, path.basename(last.dir)), path.join(root, `${CODEX_HOOK_DIR_PREFIX}gone`)]) {
      expect(rewriteKeptCodexHookFile(dir, 'sess-kept', 51999, NEW_TOKEN, data), dir).toBeNull()
    }
    for (const dir of [lookalike, foreign, below]) expect(fs.existsSync(path.join(dir, 'hook.json')), dir).toBe(false)
    expect(readHook(last.file)).toEqual({ v: 1, port: 51234, sid: 'sess-kept', token: OLD_TOKEN })
  })

  it('refused for a value the gateway would not route, no data folder, or a hook root this run did not prepare', async () => {
    const { data, root } = await preparedData()
    const last = writeCodexHookFile('sess-kept', 51234, OLD_TOKEN, root)!
    expect(rewriteKeptCodexHookFile(last.dir, 'sess kept', 51999, NEW_TOKEN, data)).toBeNull()
    expect(rewriteKeptCodexHookFile(last.dir, 'sess-kept', 0, NEW_TOKEN, data)).toBeNull()
    expect(rewriteKeptCodexHookFile(last.dir, 'sess-kept', 51999, 'short', data)).toBeNull()
    expect(rewriteKeptCodexHookFile(last.dir, 'sess-kept', 51999, NEW_TOKEN, null)).toBeNull()
    __resetCodexHookFoldersForTests()
    expect(rewriteKeptCodexHookFile(last.dir, 'sess-kept', 51999, NEW_TOKEN, data)).toBeNull()
    expect(readHook(last.file)).toEqual({ v: 1, port: 51234, sid: 'sess-kept', token: OLD_TOKEN })
  })
})
