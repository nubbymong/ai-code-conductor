// The status line command a local Claude session's settings get (the Claude
// provider's statuslineSetting: statusline.ts launchStatuslineSetting) names
// the deployed claude-multi-statusline.js only while a launch may run it: a
// plain file with one name, in a scripts folder the start made this user's
// alone in this run (script-folders.ts checkDeployedScript). Otherwise no
// command (undefined), said in one warning naming the file or the folder,
// never a path: the session starts without the app's status line, and a
// status line of the user's own stays. A path the shell would read as more
// than a path still gives null, as before, and is said by the settings
// writer. Mutation to prove this can fail: give buildStatuslineSetting's
// command without the check.
//
// [host] The start's folder check is the module's own, with a stand-in rule;
// the folders and files are real ones in a fresh temp folder, made with this
// user's modes (folders 0700, files 0600) whatever the runner's umask.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const warned = vi.hoisted(() => [] as string[])
vi.mock('../../../../src/main/debug-logger', () => ({
  logInfo: () => {},
  logError: () => {},
  logWarn: (...a: unknown[]) => { warned.push(a.map(String).join(' ')) },
}))

import { launchStatuslineSetting } from '../../../../src/main/providers/claude/statusline'
import { buildStatuslineSetting } from '../../../../src/main/providers/claude/statusline-command'
import { ClaudeProvider } from '../../../../src/main/providers/claude'
import { __markScriptFoldersCheckedForTests, __resetScriptFoldersForTests, secureScriptFolders, scriptFoldersDeployed } from '../../../../src/main/script-folders'

const PREFIX = 'ccc-statusline-gate-'
let res = ''
const script = (): string => join(res, 'scripts', 'claude-multi-statusline.js')
const URL_FILE = join(tmpdir(), 'ccc-status-sid-1.url')
const GATE_REFUSED = /; this session starts without the app's status line$/

beforeEach(() => {
  res = realpathSync.native(mkdtempSync(join(tmpdir(), PREFIX)))
  mkdirSync(join(res, 'scripts'), { mode: 0o700 })
  warned.length = 0
  __markScriptFoldersCheckedForTests(res)
})

afterEach(() => {
  __resetScriptFoldersForTests()
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (res.startsWith(join(realpathSync.native(tmpdir()), PREFIX))) rmSync(res, { recursive: true, force: true })
})

describe('the status line command a local session gets', () => {
  it('a plain script in a scripts folder made the user\'s alone this run: the command, exactly as built, and nothing said', () => {
    writeFileSync(script(), '// the app\'s\n', { mode: 0o600 })
    expect(launchStatuslineSetting(res, 'sid-1', URL_FILE)).toEqual(buildStatuslineSetting(res, 'sid-1', URL_FILE))
    expect(launchStatuslineSetting(res, 'sid-1', URL_FILE)?.command).toContain('claude-multi-statusline.js')
    expect(warned).toEqual([])
  })

  it('a directory holding index.js at the script path: no command, the path never given, and one warning naming the file, never its folder', () => {
    mkdirSync(script())
    writeFileSync(join(script(), 'index.js'), '// not the app\'s\n')
    expect(launchStatuslineSetting(res, 'sid-1', URL_FILE)).toBeUndefined()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toMatch(GATE_REFUSED)
    expect(warned[0]).toContain('claude-multi-statusline.js in the resources folder is not a plain file with one name')
    expect(warned[0]).not.toContain(res)
  })

  it('the start never checked the scripts folder: no command, and one warning naming the folder', () => {
    writeFileSync(script(), '// the app\'s\n', { mode: 0o600 })
    __resetScriptFoldersForTests()
    expect(launchStatuslineSetting(res, 'sid-1', URL_FILE)).toBeUndefined()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain("the scripts folder in the resources folder was not made this user's alone in this run")
  })

  it('the owner-only rule refused the scripts folder at start: no command, and one warning', async () => {
    writeFileSync(script(), '// the app\'s\n', { mode: 0o600 })
    await secureScriptFolders(res, async (dirs) => dirs.map((dir) => ({ dir, ok: false, detail: 'not owner-only' })))
    scriptFoldersDeployed()
    warned.length = 0
    expect(launchStatuslineSetting(res, 'sid-1', URL_FILE)).toBeUndefined()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toMatch(GATE_REFUSED)
  })

  it('not deployed: no command (it would run nothing), and one warning', () => {
    expect(launchStatuslineSetting(res, 'sid-1', URL_FILE)).toBeUndefined()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('claude-multi-statusline.js is not deployed in the resources folder')
  })

  it('a resources path the shell would read as more than a path: null, as before, and nothing said here', () => {
    const odd = join(res, 'odd$x')
    mkdirSync(join(odd, 'scripts'), { recursive: true, mode: 0o700 })
    writeFileSync(join(odd, 'scripts', 'claude-multi-statusline.js'), '// the app\'s\n', { mode: 0o600 })
    expect(launchStatuslineSetting(odd, 'sid-1', URL_FILE)).toBeNull()
    expect(warned).toEqual([])
  })

  it('the Claude provider gives exactly these answers', () => {
    const provider = new ClaudeProvider()
    expect(provider.statuslineSetting(res, 'sid-1', URL_FILE)).toBeUndefined()
    writeFileSync(script(), '// the app\'s\n', { mode: 0o600 })
    expect(provider.statuslineSetting(res, 'sid-1', URL_FILE)).toEqual(buildStatuslineSetting(res, 'sid-1', URL_FILE))
  })
})
