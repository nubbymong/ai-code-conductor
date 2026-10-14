// HOST QUARANTINE: plants a junction (Windows) and symbolic links (POSIX) inside its own temp folder. [CI] [VM] only -- never run on the owner's machine.
//
// The cases of session-hooks-inherit-scope.test.ts that need a REAL link: a
// session folder reached through a link to a folder above the home folder,
// and a project settings file or .claude folder that is itself a link (the
// session folder's own, and the checkout root's local file). Everything else
// about which project hooks a local session inherits is in that file, which
// runs anywhere.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

vi.mock('../../../src/main/account-profiles', () => ({
  atomicWriteSecure: vi.fn(),
  mkdirSecure: vi.fn(),
  hardenCredentialDir: vi.fn(),
}))
vi.mock('../../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))

import { resolveInheritedHooks } from '../../../src/main/hooks/session-hooks-writer'
import { logWarn } from '../../../src/main/debug-logger'

const POSIX = process.platform !== 'win32'
const MARKER = 'other-folder-hook'

function cmdHook(command: string, matcher = '') {
  return { matcher, hooks: [{ type: 'command', command }] }
}

/** Write a settings file with the given hooks. On POSIX the folder is made
 *  0755 and the file 0644, whatever the umask. */
function writeSettings(claudeDir: string, hooks: unknown, file = 'settings.json'): string {
  fs.mkdirSync(claudeDir, { recursive: true })
  const p = path.join(claudeDir, file)
  fs.writeFileSync(p, JSON.stringify({ hooks }))
  if (POSIX) {
    fs.chmodSync(claudeDir, 0o755)
    fs.chmodSync(p, 0o644)
  }
  return p
}

const commands = (m: Record<string, unknown[]>, ev: string): string[] =>
  ((m[ev] ?? []) as Array<{ hooks: Array<{ command: string }> }>).map((e) => e.hooks[0].command)

/** What logWarn was given, one call per line. */
const warned = (): string => vi.mocked(logWarn).mock.calls.map((c) => c.join(' ')).join('\n')

let root = ''
let home = ''

beforeEach(() => {
  vi.mocked(logWarn).mockClear()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-links-'))
  home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (root && path.basename(root).startsWith('hooks-links-')) fs.rmSync(root, { recursive: true, force: true })
})

describe('resolveInheritedHooks: links', () => {
  // A junction on Windows (no privilege needed), a symlink elsewhere; both the
  // link and its target sit inside the temp folder. Mutation to prove this can
  // fail: compare the resolved paths only, not the real ones.
  it('a link to a folder above the home folder counts as that folder', () => {
    const realBase = path.join(root, 'real')
    const realHome = path.join(realBase, 'alice')
    fs.mkdirSync(path.join(realHome, '.claude'), { recursive: true })
    writeSettings(path.join(realBase, '.claude'), { Stop: [cmdHook(MARKER)] })
    const alias = path.join(root, 'alias')
    fs.symlinkSync(realBase, alias, 'junction')
    try {
      expect(commands(resolveInheritedHooks(alias, realHome), 'Stop')).toEqual([])
    } finally {
      if (POSIX) fs.unlinkSync(alias)
      else fs.rmdirSync(alias)
    }
  })

  // Real links need POSIX; the Windows checks of the rule are simulated in
  // session-hooks-inherit-scope.test.ts. Mutation to prove this can fail: open
  // the file without O_NOFOLLOW.
  it.runIf(POSIX)('a settings file that is a symbolic link is skipped, and so is a .claude that is one; both are logged', () => {
    const cwd = path.join(root, 'srv', 'linked')
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    fs.chmodSync(path.join(cwd, '.claude'), 0o755)
    const target = writeSettings(path.join(root, 'srv', 'elsewhere'), { Stop: [cmdHook(MARKER)] })
    fs.symlinkSync(target, path.join(cwd, '.claude', 'settings.json'))
    expect(commands(resolveInheritedHooks(cwd, home), 'Stop')).toEqual([])
    expect(warned()).toContain(`${path.join(cwd, '.claude', 'settings.json')} (link)`)
    const cwd2 = path.join(root, 'srv', 'linkeddir')
    fs.mkdirSync(cwd2, { recursive: true })
    fs.symlinkSync(path.join(root, 'srv', 'elsewhere'), path.join(cwd2, '.claude'))
    expect(commands(resolveInheritedHooks(cwd2, home), 'Stop')).toEqual([])
    expect(warned()).toContain(`${path.join(cwd2, '.claude')} (link)`)
  })

  // The checkout root's settings.local.json, which Claude Code also reads on
  // POSIX for a session in a subfolder: a link there is skipped and logged,
  // and so is a root .claude that is a link. Mutation to prove this can fail:
  // read the root's file without the folder or file checks.
  it.runIf(POSIX)('a checkout root\'s settings.local.json or .claude that is a symbolic link is skipped and logged', () => {
    const repo = path.join(root, 'srv', 'repo')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
    fs.chmodSync(path.join(repo, '.claude'), 0o755)
    const target = writeSettings(path.join(root, 'srv', 'elsewhere'), { Stop: [cmdHook(MARKER)] }, 'settings.local.json')
    fs.symlinkSync(target, path.join(repo, '.claude', 'settings.local.json'))
    const sub = path.join(repo, 'pkg')
    fs.mkdirSync(sub, { recursive: true })
    expect(commands(resolveInheritedHooks(sub, home), 'Stop')).toEqual([])
    expect(warned()).toContain(`${path.join(repo, '.claude', 'settings.local.json')} (link)`)
    const repo2 = path.join(root, 'srv', 'repo2')
    fs.mkdirSync(path.join(repo2, '.git'), { recursive: true })
    fs.symlinkSync(path.join(root, 'srv', 'elsewhere'), path.join(repo2, '.claude'))
    const sub2 = path.join(repo2, 'pkg')
    fs.mkdirSync(sub2, { recursive: true })
    expect(commands(resolveInheritedHooks(sub2, home), 'Stop')).toEqual([])
    expect(warned()).toContain(`${path.join(repo2, '.claude')} (link)`)
  })

  // Claude Code walks up from the REAL path of the folder it starts in. A
  // session folder reached through a symbolic link that lands inside another
  // checkout takes THAT checkout's local file, not the one of the checkout
  // the link sits in. Mutation to prove this can fail: walk up from
  // path.resolve(cwd) instead of its real path.
  it.runIf(POSIX)('a session folder reached through a link into another checkout takes that checkout\'s local hooks', () => {
    const a = path.join(root, 'srv', 'a')
    fs.mkdirSync(path.join(a, '.git'), { recursive: true })
    writeSettings(path.join(a, '.claude'), { Stop: [cmdHook('a-local')] }, 'settings.local.json')
    const b = path.join(root, 'srv', 'b')
    fs.mkdirSync(path.join(b, '.git'), { recursive: true })
    writeSettings(path.join(b, '.claude'), { Stop: [cmdHook('b-local')] }, 'settings.local.json')
    fs.mkdirSync(path.join(b, 'sub'), { recursive: true })
    const link = path.join(a, 'link')
    fs.symlinkSync(path.join(b, 'sub'), link)
    expect(commands(resolveInheritedHooks(link, home), 'Stop')).toEqual(['b-local'])
  })
})
