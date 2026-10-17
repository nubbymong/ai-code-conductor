// A headless Claude Code run when macOS opens the app from the Dock or Finder:
// the app's PATH is launchd's (/usr/bin:/bin:/usr/sbin:/sbin), and Claude Code
// is in a folder only the login shell names (Homebrew, ~/.local/bin). The CLI
// probe finds it (`<login shell> -lc 'command -v claude'`), but the run started
// `sh -c claude` with the app's own PATH and exited 127. The run must start the
// Claude Code the probe found, with its folder first on PATH, and an npm claude
// (a `#!/usr/bin/env node` script) must find the node beside it.
//
// The runs are REAL: `sh -c claude` into a FAKE claude in a temp folder off
// PATH. Their environment is built from nothing (env -i style): withProfileHome
// is replaced by one that returns only a bare PATH and a fake HOME, so a run
// never sees this process's HOME, PATH or credentials. The probe's login shell
// is never started: execFile, the probe's only process, answers
// `/bin/zsh -lc 'command -v claude'` itself. No real Claude Code starts.
//
// POSIX only (skipped on Windows, where a run starts Claude Code by the full
// path found in PATH's folders, with no shell): on the owner's workstation this
// file starts nothing.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BARE = '/usr/bin:/bin:/usr/sbin:/sbin'

const h = vi.hoisted(() => ({
  env: {} as Record<string, string>,
  answer: null as string | null,
  delayMs: 0,
  asked: [] as string[],
}))

vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))
// env -i: the run's environment is h.env alone, never this process's.
vi.mock('../../src/main/pty-manager', () => ({ withProfileHome: () => ({ ...h.env }) }))
vi.mock('../../src/main/managed-launch-diagnostics', () => ({ gateManagedLaunch: async () => ({ status: 'clean' }), peekGateVerdict: () => undefined }))
vi.mock('../../src/main/profile-consumers', () => ({ acquireProfileConsumer: () => null, pendingProfileRefresh: () => null }))
vi.mock('../../src/main/profile-id', () => ({ profileIdFromHome: () => null }))
// The probe asks a sh-family login shell, zsh as on macOS (named, never started).
vi.mock('../../src/main/login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/login-shell')>()),
  loginShellWithOwnPath: () => null,
  shFamilyLoginShell: () => '/bin/zsh',
}))
// execFile is only the probe's (claude-cli-probe.ts probeOnce): it answers
// `command -v claude` with h.answer and `which claude` with nothing, after
// h.delayMs, and starts no process. spawn, the run's, is the real one.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  const execFile = (file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void): object => {
    h.asked.push([file, ...args].join(' '))
    const answer = file === '/bin/zsh' && args[0] === '-lc' && args[1] === 'command -v claude' ? h.answer : null
    setTimeout(() => (answer ? cb(null, answer + '\n') : cb(new Error('not found'), '')), h.delayMs)
    return {}
  }
  return { ...real, execFile }
})

const { spawnClaudeHeadless, withClaudeFolderOnPath } = await import('../../src/main/claude-headless')
const { probeClaudeCli, _resetClaudeCliProbeForTest } = await import('../../src/main/claude-cli-probe')

const IS_WIN = process.platform === 'win32'
const PREFIX = 'ccc-headless-posix-path-'
let dir = ''
let home = ''
/** Native-style Claude Code: a program in a folder off the bare PATH. */
let nativeBin = ''
/** npm-style Claude Code: `#!/usr/bin/env node`, with a node beside it. */
let npmBin = ''

const sh = (lines: string[]): string => lines.join('\n') + '\n'

beforeAll(() => {
  if (IS_WIN) return
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  home = path.join(dir, 'home')
  nativeBin = path.join(dir, 'native', 'bin')
  npmBin = path.join(dir, 'npm', 'bin')
  for (const d of [home, nativeBin, npmBin]) fs.mkdirSync(d, { recursive: true })
  // Records the PATH and HOME it was started with, and answers as Claude Code does.
  fs.writeFileSync(path.join(nativeBin, 'claude'), sh([
    '#!/bin/sh',
    'printf "%s" "$PATH" > "$(dirname "$0")/path.txt"',
    'printf "%s" "$HOME" > "$(dirname "$0")/home.txt"',
    'echo "2.1.999 (Claude Code)"',
  ]), { mode: 0o755 })
  // An npm install: the CLI is a node script, and node is in the same folder
  // (this one marks that it was the node used, then runs this test's node).
  fs.writeFileSync(path.join(npmBin, 'claude'), sh([
    '#!/usr/bin/env node',
    "console.log('2.1.998 (Claude Code)')",
  ]), { mode: 0o755 })
  fs.writeFileSync(path.join(npmBin, 'node'), sh([
    '#!/bin/sh',
    ': > "$(dirname "$0")/node-used.txt"',
    `exec ${JSON.stringify(process.execPath)} "$@"`,
  ]), { mode: 0o755 })
})
afterAll(() => {
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (dir && path.basename(dir).startsWith(PREFIX) && path.dirname(dir) === fs.realpathSync.native(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})
beforeEach(() => {
  _resetClaudeCliProbeForTest()
  h.env = { PATH: BARE, HOME: home }
  h.answer = null
  h.delayMs = 0
  h.asked = []
  for (const f of [path.join(nativeBin, 'path.txt'), path.join(nativeBin, 'home.txt'), path.join(npmBin, 'node-used.txt')]) fs.rmSync(f, { force: true })
})

const read = (f: string): string => fs.readFileSync(f, 'utf8')

describe.skipIf(IS_WIN)('a headless run under launchd\'s bare PATH starts the Claude Code the CLI probe found (POSIX only)', () => {
  it('a Claude Code only the login shell finds: its folder first on PATH, nothing else from this process', async () => {
    h.answer = path.join(nativeBin, 'claude')
    expect((await probeClaudeCli()).path).toBe(h.answer)
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code, res.stderr).toBe(0)
    expect(res.stdout).toContain('2.1.999 (Claude Code)')
    expect(read(path.join(nativeBin, 'path.txt'))).toBe(`${nativeBin}:${BARE}`)
    expect(read(path.join(nativeBin, 'home.txt'))).toBe(home)
    // The run started no login shell of its own: the one probe asked once.
    expect(h.asked).toEqual(['/bin/zsh -lc command -v claude'])
  }, 60_000)

  it('an npm Claude Code (#!/usr/bin/env node) finds the node in its own folder', async () => {
    h.answer = path.join(npmBin, 'claude')
    await probeClaudeCli()
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code, res.stderr).toBe(0)
    expect(res.stdout).toContain('2.1.998 (Claude Code)')
    expect(fs.existsSync(path.join(npmBin, 'node-used.txt'))).toBe(true)
  }, 60_000)

  it('a run that starts while the probe is still asking (Sentinel at start) waits for its answer', async () => {
    h.answer = path.join(nativeBin, 'claude')
    h.delayMs = 300
    const probe = probeClaudeCli()
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code, res.stderr).toBe(0)
    expect(read(path.join(nativeBin, 'path.txt'))).toBe(`${nativeBin}:${BARE}`)
    expect((await probe).path).toBe(h.answer)
    expect(h.asked).toEqual(['/bin/zsh -lc command -v claude'])
  }, 60_000)

  it('a PATH that already names the folder is left exactly as it is', async () => {
    h.answer = path.join(nativeBin, 'claude')
    h.env = { PATH: `${BARE}:${nativeBin}`, HOME: home }
    await probeClaudeCli()
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code, res.stderr).toBe(0)
    expect(read(path.join(nativeBin, 'path.txt'))).toBe(`${BARE}:${nativeBin}`)
  }, 60_000)

  it('nothing found and no probe running: the run starts as before (claude by name in the bare PATH)', async (ctx) => {
    // Never start a real Claude Code: only when the bare PATH has none.
    if (BARE.split(':').some((d) => fs.existsSync(path.join(d, 'claude')))) ctx.skip()
    await probeClaudeCli()
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code).toBe(127)
    expect(fs.existsSync(path.join(nativeBin, 'path.txt'))).toBe(false)
    expect(h.asked).toEqual(['/bin/zsh -lc command -v claude', 'which claude'])
  }, 60_000)
})

describe('withClaudeFolderOnPath (the PATH a POSIX run starts with)', () => {
  it('puts the folder the probe named first, keeps the rest, and leaves its input as it was', () => {
    const env = { PATH: BARE, HOME: '/Users/someone', LANG: 'en_GB.UTF-8' }
    const out = withClaudeFolderOnPath(env, '/opt/homebrew/bin/claude')
    expect(out).toEqual({ PATH: `/opt/homebrew/bin:${BARE}`, HOME: '/Users/someone', LANG: 'en_GB.UTF-8' })
    expect(env.PATH).toBe(BARE)
    expect(withClaudeFolderOnPath({ PATH: BARE }, '/Users/someone/.local/bin/claude').PATH).toBe(`/Users/someone/.local/bin:${BARE}`)
  })

  it.each([
    ['no path found', { PATH: BARE }, null],
    ['the folder already on PATH', { PATH: `/usr/local/bin:/opt/homebrew/bin:${BARE}` }, '/opt/homebrew/bin/claude'],
    ['a name, not a path (command -v of a function)', { PATH: BARE }, 'claude'],
    ['an alias line (command -v of an alias)', { PATH: BARE }, "alias claude='/opt/x/claude'"],
    ['a folder with a colon (no PATH entry can name it)', { PATH: BARE }, '/opt/a:b/claude'],
    ['no PATH at all', {}, '/opt/homebrew/bin/claude'],
    ['an empty PATH (an empty entry would mean the run\'s folder)', { PATH: '' }, '/opt/homebrew/bin/claude'],
  ] as Array<[string, Record<string, string>, string | null]>)('%s: the environment itself, unchanged', (_label, env, claudePath) => {
    const before = { ...env }
    expect(withClaudeFolderOnPath(env, claudePath)).toBe(env)
    expect(env).toEqual(before)
  })
})
