/**
 * 2.1.3-beta.18 fix round, item 2 (found on section 3.2's host line; there
 * since beta.17's A2): a Claude Code tab through the session helper ran at
 * another effort than today's SSH tab for the same config and host. Helper
 * tab: "Fable 5.2" and "medium"; today's SSH tab: "Fable 5.2 with xhigh
 * effort" and "xhigh". The host user's ~/.claude/settings.json holds
 * effortLevel xhigh and model fable[1m]; the config sets no effort.
 *
 * The measured cause. Both launches pass --effort only when the tab's saved
 * options set one (pty-manager.ts's SSH launch line; providers/claude/
 * remote-launch.ts claudeRemoteArgs), so the flag is not it. Claude Code
 * (2.1.332, its effort resolution as read from its own binary) takes a
 * settings file's top-level effortLevel as the session's default from every
 * source but the user's own settings: from ~/.claude/settings.json it is a
 * "legacy" user effort, applied only for some models, and Fable 5.2 was not
 * one of them on the host line. Today's SSH setup copies every top-level key
 * of the host user's settings.json into the session's --settings file (a
 * flag settings source), so there effortLevel is the default; the helper's
 * session file held only statusLine and hooks, so the model's own default
 * effort applied (beta.17's helper tab, with no session file, showed medium
 * too).
 *
 * The fix: the helper's session settings.json carries the host user's own
 * settings keys as today's file does (every key but mcpServers, then the
 * app's statusLine and hooks over them).
 *
 * Today's file is made by RUNNING the real setup script (the text the host
 * runs) against an in-memory file system, as ssh-shim-user-settings.test.ts
 * does; the helper's is the Claude Code package's remote launch. Red on
 * 1656fe80: with no effort saved and effortLevel in the host user's settings,
 * the helper tab resolved to the model's default.
 */
import { describe, it, expect } from 'vitest'
import * as nodePath from 'path'
import { generateRemoteSetupScript } from '../../../src/main/providers/claude/ssh-shim'
import { claudeRemoteLaunch, REMOTE_SETTINGS_FILE } from '../../../src/main/providers/claude/remote-launch'
import type { RemoteHostFile, RemoteLaunchOptions } from '../../../src/main/providers/types'

const HOME = '/home/remote-user'
const SID = 'sid-effort'
const NONCE = 'effortNonce1'
const EUID = 1000

/** Today's per-session settings file for the host user's settings bytes
 *  (null: no file), from the real setup script run in memory. */
function todaysSessionFile(userSettings: string | null): Record<string, unknown> {
  const path = nodePath.posix
  const files = new Map<string, Buffer>()
  const modes = new Map<string, number>()
  const settingsPath = path.join(HOME, '.claude', 'settings.json')
  if (userSettings !== null) files.set(settingsPath, Buffer.from(userSettings, 'utf8'))
  const err = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code })
  const fds = new Map<number, string>()
  let nextFd = 30
  const stat = (t: string) => ({ mode: 0o100000 | (modes.get(t) ?? 0o644), uid: EUID, gid: EUID, nlink: 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false })
  const fs = {
    constants: { X_OK: 1, W_OK: 2 },
    mkdirSync: () => {},
    chmodSync: (p: string, mode: number) => { if (files.has(p)) modes.set(p, mode & 0o7777) },
    existsSync: (p: string) => files.has(p),
    accessSync: (p: string, mode?: number) => { if (mode === 2 && files.has(p)) return; throw err('ENOENT', p) },
    rmSync: (p: string) => { files.delete(p); modes.delete(p) },
    readFileSync: (p: string, enc?: unknown) => {
      const b = files.get(p)
      if (b === undefined) throw err('ENOENT', p)
      const e = typeof enc === 'string' ? enc : (enc as { encoding?: string } | undefined)?.encoding
      return e ? b.toString(e as BufferEncoding) : Buffer.from(b)
    },
    openSync: (p: string, flags: string, mode?: number) => {
      if (flags === 'r+') { if (!files.has(p)) throw err('ENOENT', p) } else if (flags === 'wx') {
        if (files.has(p)) throw err('EEXIST', p)
        files.set(p, Buffer.alloc(0))
        modes.set(p, (mode ?? 0o666) & ~0o022)
      } else throw new Error(`harness: unexpected open flags ${flags}`)
      fds.set(nextFd, p)
      return nextFd++
    },
    fchmodSync: (fd: number, mode: number) => { modes.set(fds.get(fd)!, mode & 0o7777) },
    fstatSync: (fd: number) => stat(fds.get(fd)!),
    fchownSync: () => {},
    closeSync: (fd: number) => { fds.delete(fd) },
    writeFileSync: (p: string | number, c: unknown, opts?: Record<string, unknown>) => {
      const body = Buffer.isBuffer(c) ? Buffer.from(c) : Buffer.from(String(c), 'utf8')
      const t = typeof p === 'number' ? fds.get(p)! : p
      if (typeof p !== 'number' && opts?.flag === 'wx' && files.has(t)) throw err('EEXIST', t)
      if (!files.has(t)) modes.set(t, ((opts?.mode as number | undefined) ?? 0o666) & ~0o022)
      files.set(t, body)
    },
    appendFileSync: () => {},
    realpathSync: (p: string) => { if (!files.has(p) && /\.json$/.test(p)) throw err('ENOENT', p); return p },
    statSync: (p: string) => { if (!files.has(p)) throw err('ENOENT', p); return stat(p) },
    lstatSync: (p: string) => { if (!files.has(p)) throw err('ENOENT', p); return stat(p) },
    renameSync: (a: string, b: string) => { const v = files.get(a); if (v === undefined) throw err('ENOENT', a); files.set(b, v); files.delete(a) },
  }
  const childProcess = {
    execSync: () => { throw new Error('not found') },
    execFileSync: () => { throw new Error('not found') },
    spawn: () => { throw new Error('not in this test') },
  }
  const req = (name: string): unknown => {
    if (name === 'fs') return fs
    if (name === 'os') return { homedir: () => HOME }
    if (name === 'path') return path
    if (name === 'child_process') return childProcess
    throw new Error(`harness: unexpected require ${name}`)
  }
  const proc = { env: {}, pid: 4242, geteuid: () => EUID, stdout: { write: () => true } }
  // eslint-disable-next-line no-new-func -- deliberate: the host's own script, run in memory.
  new Function('require', 'process', generateRemoteSetupScript(SID, null, { includeConductorMcp: false }, NONCE, '~'))(req, proc)
  const out = files.get(path.join(HOME, '.claude', `settings-${SID}.json`))
  if (!out) throw new Error('the setup wrote no per-session settings file')
  return JSON.parse(out.toString('utf8')) as Record<string, unknown>
}

const HELPER = {
  helperPath: `${HOME}/.aicc/d/helper/0.1.0-aaaaaaaaaaaa/aicc-helper`,
  store: `${HOME}/.aicc/d/store`,
  sid: 'rm0123456789abcdef0123456789abcd',
  folder: `${HOME}/.aicc/d/sessions/rm0123456789abcdef0123456789abcd`,
}

/** The helper tab's launch: its arguments and its session settings file. */
function helperLaunch(saved: Saved, userSettings: string | null): { args: readonly string[]; file: Record<string, unknown> } {
  const o: RemoteLaunchOptions = { ...saved, reconnect: false, cwd: `${HOME}/work`, settings: null, tools: true }
  const reads: RemoteHostFile[] = [
    { from: 'home', path: '.claude/settings.json', content: userSettings },
    { from: 'cwd', path: '.claude/settings.json', content: null },
    { from: 'cwd', path: '.claude/settings.local.json', content: null },
    { from: 'checkout', path: '.claude/settings.local.json', content: null },
  ]
  const l = claudeRemoteLaunch.launch(o, { home: HOME, user: 'remote-user', claudePath: '/usr/bin/claude' }, HELPER, reads)
  const f = l.files.find((x) => x.name === REMOTE_SETTINGS_FILE)
  if (!f) throw new Error('no session settings file')
  return { args: l.args, file: JSON.parse(f.content) as Record<string, unknown> }
}

/** A value of a flag in an argument list, or none. */
const flagOf = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

/**
 * The effort and model Claude Code runs a session at, by its own rules
 * (2.1.332, read from its binary): --effort and --model on the command line
 * first; then a top-level effortLevel and model from the --settings file (a
 * flag settings source, the session's default); then the user's own
 * settings.json, where model applies but effortLevel is only a "legacy" user
 * effort, which the host line's model (Fable 5.2) did not take; then the
 * model's own default.
 */
function runsAt(args: readonly string[], flagFile: Record<string, unknown>, userSettings: Record<string, unknown>): { effort: string; model: string } {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return {
    effort: flagOf(args, '--effort') ?? str(flagFile.effortLevel) ?? 'the model\'s default',
    model: flagOf(args, '--model') ?? str(flagFile.model) ?? str(userSettings.model) ?? 'the account\'s default',
  }
}

/** Today's SSH launch line passes --effort and --model from the saved
 *  options only (pty-manager.ts, the SSH branch's claudeAppFlags). */
const todaysArgs = (saved: Saved): string[] => [
  ...(saved.effortLevel ? ['--effort', saved.effortLevel] : []),
  ...(saved.model ? ['--model', saved.model] : []),
]

type Saved = Pick<RemoteLaunchOptions, 'effortLevel' | 'model'>

describe('the model of Claude Code\'s effort agrees with the host line', () => {
  const user = { effortLevel: 'xhigh', model: 'fable[1m]' }
  it('today\'s SSH tab, no effort saved: xhigh (its session file carries the user\'s effortLevel)', () => {
    expect(runsAt(todaysArgs({}), todaysSessionFile(JSON.stringify(user)), user)).toEqual({ effort: 'xhigh', model: 'fable[1m]' })
  })
  it('beta.17\'s helper tab, no session file: the model\'s default, the user\'s model', () => {
    expect(runsAt([], {}, user)).toEqual({ effort: 'the model\'s default', model: 'fable[1m]' })
  })
})

const HOST_SETTINGS: Array<[string, Record<string, unknown> | null]> = [
  ['effortLevel xhigh and model fable[1m] (the host line)', { effortLevel: 'xhigh', model: 'fable[1m]', permissions: { allow: ['Bash(ls:*)'] }, enabledPlugins: { 'p@m': true } }],
  ['effortLevel low only', { effortLevel: 'low' }],
  ['a model only', { model: 'opus' }],
  ['neither', { permissions: { deny: ['Bash(rm:*)'] } }],
  ['the user\'s own statusLine, hooks and mcpServers', { effortLevel: 'high', statusLine: { type: 'command', command: 'my-line' }, mcpServers: { mine: { command: 'my-server' } }, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-stop' }] }] } }],
  ['an empty file', {}],
  ['no file', null],
]
const SAVED: Array<[string, Saved]> = [
  ['nothing saved', {}],
  ['effort high saved', { effortLevel: 'high' }],
  ['a model saved', { model: 'sonnet' }],
  ['both saved', { effortLevel: 'max', model: 'opus[1m]' }],
]

describe('a helper tab runs at the effort and model today\'s SSH tab runs at, for the same config and host', () => {
  for (const [hostName, host] of HOST_SETTINGS) {
    for (const [savedName, saved] of SAVED) {
      it(`host settings: ${hostName}; ${savedName}`, () => {
        const text = host === null ? null : JSON.stringify(host)
        const today = todaysSessionFile(text)
        const helper = helperLaunch(saved, text)
        expect(runsAt(helper.args, helper.file, host ?? {})).toEqual(runsAt(todaysArgs(saved), today, host ?? {}))
        // The same flags from the saved options.
        expect(flagOf(helper.args, '--effort')).toBe(flagOf(todaysArgs(saved), '--effort'))
        expect(flagOf(helper.args, '--model')).toBe(flagOf(todaysArgs(saved), '--model'))
      })
    }
  }

  it('every key of the user\'s own settings today\'s file carries, the helper\'s carries with the same value (the app\'s statusLine and hooks aside)', () => {
    for (const [, host] of HOST_SETTINGS) {
      const text = host === null ? null : JSON.stringify(host)
      const { statusLine: _a, hooks: _b, ...today } = todaysSessionFile(text)
      const { statusLine: _c, hooks: _d, ...helper } = helperLaunch({}, text).file
      expect(helper).toEqual(today)
    }
  })

  it('the app\'s own keys stay the app\'s: the status line is the helper\'s status mode, the user\'s hooks come first, mcpServers is not carried', () => {
    const host = HOST_SETTINGS[4][1]!
    const file = helperLaunch({}, JSON.stringify(host)).file
    expect((file.statusLine as { command: string }).command).toContain(' status --store ')
    const stop = (file.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).Stop
    expect(stop[0].hooks[0].command).toBe('my-stop')
    expect(stop[1].hooks[0].command).toContain(' hook --store ')
    expect(file.mcpServers).toBeUndefined()
  })
})
