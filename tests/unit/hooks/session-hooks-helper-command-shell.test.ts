// HOST QUARANTINE: starts Git Bash (Windows) or /bin/sh, and node, on a stub helper in its own temp folder. CI and VM only -- never run on the owner's machine.
//
// The hook mode's command through a real shell (2.1.3-beta.8, plan section
// A4). session-hooks-helper-block.test.ts pins the exact strings
// helperHookCommand builds; this proves those strings reach the helper as
// exactly the words meant, through the launcher Claude Code uses, started the
// way Claude Code starts it (Node's spawn, an argument list):
//  - Windows: Git for Windows' bin\bash.exe -c "<command>" (ADR-030 probe P16,
//    step 0, Claude Code 2.1.296), so the command crosses libuv's quoting,
//    the MSYS runtime's command line reading, and bash;
//  - macOS and Linux: /bin/sh -c "<command>".
// The stub helper is a Node script (`#!/usr/bin/env node`) in a folder whose
// name holds a space, an apostrophe, $, %, &, ^ and a letter outside ASCII;
// it prints the words it was given as JSON. A wrong parse there would cost a
// session 8 of its 9 hook events without a word, so this runs in CI on all
// three systems. The shell gets a fresh environment: every home and config
// folder inside the test's own temp folder, nothing else inherited.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { helperHookCommand, type HelperHookTarget } from '../../../src/main/hooks/session-hooks-writer'

const SID = 'ag0123456789abcdef0123456789abcd'
const WIN = process.platform === 'win32'

/** Git for Windows' bash, where Claude Code finds it; null when not installed. */
function gitBash(): string | null {
  const roots = [process.env.ProgramFiles, process.env.ProgramW6432, 'C:\\Program Files'].filter((r): r is string => typeof r === 'string' && r.length > 0)
  for (const r of roots) {
    const p = path.join(r, 'Git', 'bin', 'bash.exe')
    if (fs.existsSync(p)) return p
  }
  return null
}

const launcherFile = WIN ? gitBash() : '/bin/sh'
// A Windows CI runner has Git for Windows: there, a missing bash fails the
// test rather than skipping it. A developer's machine without it skips.
const skip = launcherFile === null && process.env.CI !== 'true'

let base: string
let weird: string
let stub: string
let store: string
let env: NodeJS.ProcessEnv

beforeAll(() => {
  // The long form of the temp folder (no 8.3 short names on Windows).
  base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aicc-hook-shell-'))
  weird = path.join(base, "Zoë O'Brien $HOME %PATH% & ^z")
  store = path.join(weird, 'helper', 'store')
  fs.mkdirSync(store, { recursive: true })
  stub = path.join(weird, 'helper', 'aicc-helper')
  fs.writeFileSync(stub, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ script: process.argv[1], words: process.argv.slice(2) }))\n')
  if (!WIN) fs.chmodSync(stub, 0o755)
  const home = path.join(base, 'home')
  fs.mkdirSync(home)
  // A fresh environment, nothing inherited but the PATH (node and, on
  // Windows, what bash needs) and the system root; every home and config
  // folder in the test's own folder. Any other tool's home folder is unset,
  // so it falls back to HOME, which is here too.
  env = {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    TEMP: base,
    TMP: base,
    TMPDIR: base,
    ...(WIN ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', windir: process.env.windir ?? 'C:\\Windows' } : {}),
  }
})

afterAll(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe.skipIf(skip)('the hook mode command through the real launcher', () => {
  it(`${WIN ? 'Git Bash (bin\\bash.exe -c)' : '/bin/sh -c'}: the helper gets exactly hook --store <store> --session <sid>`, () => {
    expect(launcherFile, 'Git for Windows bash.exe on this runner').not.toBeNull()
    const target: HelperHookTarget = { helperPath: stub, store, sid: SID, launcher: WIN ? 'git-bash' : 'sh' }
    const command = helperHookCommand(target)
    expect(command).not.toBeNull()
    const r = spawnSync(launcherFile!, ['-c', command!], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true })
    expect(r.error, String(r.error)).toBeUndefined()
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    const got = JSON.parse(r.stdout) as { script: string; words: string[] }
    // The store as the launcher was given it: forward slashes on Windows.
    const storeWord = WIN ? store.replace(/\\/g, '/') : store
    expect(got.words).toEqual(['hook', '--store', storeWord, '--session', SID])
    // And the program that ran is the stub at its own path (the folder's name
    // whole: a broken quote would have run nothing, or another file).
    const norm = (p: string) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p))
    expect(norm(got.script)).toBe(norm(stub))
  })
})
