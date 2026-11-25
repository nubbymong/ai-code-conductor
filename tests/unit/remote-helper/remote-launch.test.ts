/**
 * The remote launch comes from the provider package, not from core (plan
 * 2.1.3-beta.18 section 2; aicc_planning#430).
 *
 * - Characterisation: for a table of saved options, settings, machines and
 *   folders, the launch core builds from the Claude package's remote launch
 *   is the launch d0be048e built in core, byte for byte (argv, folder,
 *   environment and its order). The "before" is d0be048e's own code, copied
 *   below unchanged but for the one host-account line it called.
 * - src/main/remote-helper names no flag or variable of a CLI and no path to
 *   a provider's CLI (red on d0be048e: index.ts's four flags and five
 *   CLAUDE_CODE_ variables, session.ts's fallback path).
 * - Core asks the registry by the tab's provider id, and gives the package
 *   the options, the machine, the helper's commands and no host read; a
 *   provider with no remote launch, or a launch that asks for what this build
 *   does not carry, sends the tab the usual way.
 * - The real Claude package carries the group.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { parse } from '@babel/parser'
import type { ProviderRemoteLaunch, RemoteHelperCommands, RemoteHostFile, RemoteLaunchMachine, RemoteLaunchOptions, SessionProvider } from '../../../src/main/providers/types'
import { registerProvider, tryGetProvider } from '../../../src/main/providers'
import { createClaudePackage } from '../../../src/main/providers/claude'
import { claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import { colorFgBgValue, resolveHostColorScheme } from '../../../src/main/providers/host-color-scheme'
import { DEFAULT_PROVIDER_ID, PROVIDER_IDS } from '../../../src/shared/providers/ids'
import { remoteHelperPty, remoteLaunchOf, setRemoteHelperDeps, type RemoteSpawnOptions } from '../../../src/main/remote-helper'
import { remoteCwd, remoteHelperCommands, remoteLaunchSpec, remoteSessionId } from '../../../src/main/remote-helper/session'
import type { RemoteMachineRecord, RemoteMachines } from '../../../src/main/remote-helper/machines'
import type { LaunchSpec } from '../../../src/main/session-helper/protocol'
import type { SSHOptions } from '../../../src/main/ssh-options'
import { FakeHolder } from '../main/session-helper-fake-holder'
import { FakeSsh } from './fake-ssh'

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: null, helper: { version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
}
const SSH_TAB: SSHOptions = { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~/work', detachable: false }

// ── d0be048e's launch, copied unchanged (remote-helper/index.ts:109-136,
// session.ts:82-96); hostAccountEnv's one line written in place. ─────────────
function beforeCliArgs(o: RemoteSpawnOptions): string[] {
  const args: string[] = []
  if (o.effortLevel) args.push('--effort', o.effortLevel)
  if (o.model) args.push('--model', o.model)
  if (o.permissionMode && o.permissionMode !== 'default') args.push('--permission-mode', o.permissionMode)
  if (o.ssh?.reconnect) args.push('--continue')
  const extra = o.extraArgs?.trim()
  if (extra) args.push(...extra.split(/\s+/))
  return args
}
function beforeCliEnv(settings: Record<string, unknown> | null, o: RemoteSpawnOptions, systemPrefersDark: () => boolean): Record<string, string> {
  const env: Record<string, string> = {}
  if (o.disableAutoMemory) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  if (settings?.classicTerminalCopyPaste !== false) {
    env.CLAUDE_CODE_DISABLE_MOUSE = '1'
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1'
  }
  if (settings?.clickableQuestions !== true) env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = '1'
  if (settings?.disableBackgroundTasks !== false) env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
  const theme = typeof settings?.theme === 'string' ? settings.theme : undefined
  env.COLORFGBG = colorFgBgValue(resolveHostColorScheme(theme, theme === 'system' ? systemPrefersDark() : true))
  return env
}
function beforeLaunchSpec(m: RemoteMachineRecord, cliArgs: readonly string[], cliEnv: Record<string, string>, remotePath: string | undefined, cols: number, rows: number): LaunchSpec {
  const claude = m.claudePath ?? '/usr/local/bin/claude'
  const argv = m.shellIsSh ? [m.shell, '-il', '-c', 'exec "$0" "$@"', claude, ...cliArgs] : [claude, ...cliArgs]
  const env: Record<string, string> = {
    HOME: m.home, USER: m.user, LOGNAME: m.user, SHELL: m.shell, PATH: m.path,
    LANG: m.lang ?? 'C.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor',
    ...cliEnv,
  }
  return { argv, cwd: remoteCwd(remotePath, m.home), env, cols, rows }
}

describe('the launch is the same, byte for byte (characterisation against d0be048e)', () => {
  const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions', 'manual']
  const tab = (over: Partial<SSHOptions> = {}): SSHOptions => ({ ...SSH_TAB, ...over })
  const OPTIONS: RemoteSpawnOptions[] = [
    { ssh: tab() },
    { ssh: tab(), effortLevel: 'high' },
    { ssh: tab(), model: 'opus[1m]' },
    { ssh: tab(), effortLevel: 'max', model: 'claude-sonnet-4-5' },
    ...PERMISSION_MODES.map((permissionMode) => ({ ssh: tab(), permissionMode })),
    { ssh: tab({ reconnect: true }) },
    { ssh: tab({ reconnect: false }) },
    { ssh: tab(), extraArgs: '  --verbose   --add-dir /srv/x  ' },
    { ssh: tab(), extraArgs: '   ' },
    { ssh: tab(), extraArgs: '' },
    { ssh: tab(), disableAutoMemory: true },
    { ssh: tab(), disableAutoMemory: false },
    { ssh: tab({ reconnect: true }), effortLevel: 'low', model: 'haiku', permissionMode: 'plan', extraArgs: '--debug', disableAutoMemory: true },
    {},
  ]
  const SETTINGS: Array<Record<string, unknown> | null> = [
    null, {},
    { classicTerminalCopyPaste: false }, { classicTerminalCopyPaste: true },
    { clickableQuestions: true }, { clickableQuestions: false },
    { disableBackgroundTasks: false }, { disableBackgroundTasks: true },
    { theme: 'light' }, { theme: 'dark' }, { theme: 'system' }, { theme: 42 },
    { classicTerminalCopyPaste: false, clickableQuestions: true, disableBackgroundTasks: false, theme: 'system' },
  ]
  const MACHINES: RemoteMachineRecord[] = [
    MACHINE,
    { ...MACHINE, claudePath: null },
    { ...MACHINE, shellIsSh: false, shell: '/usr/bin/fish' },
    { ...MACHINE, lang: 'en_GB.UTF-8' },
    { ...MACHINE, home: '/home/nick/' },
  ]
  const PATHS: Array<string | undefined> = [undefined, '~', '~/work', '/srv/app', 'rel/dir']

  it('every row: argv, folder and environment equal, in the same order', () => {
    let rows = 0
    const differ: string[] = []
    for (const m of MACHINES) for (const remotePath of PATHS) for (const o of OPTIONS) for (const settings of SETTINGS) for (const dark of [true, false]) {
      const options: RemoteSpawnOptions = o.ssh ? { ...o, ssh: { ...o.ssh, remotePath } } : o
      const systemPrefersDark = () => dark
      const before = beforeLaunchSpec(m, beforeCliArgs(options), beforeCliEnv(settings, options, systemPrefersDark), options.ssh?.remotePath, 100, 30)
      const after = remoteLaunchOf(claudeRemoteLaunch, m, options, settings, systemPrefersDark, remoteSessionId('tab-1'), 100, 30)
      rows++
      if (JSON.stringify(after) !== JSON.stringify(before)) differ.push(`${JSON.stringify({ m: m.claudePath, remotePath, options, settings, dark })}\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`)
    }
    expect(differ.slice(0, 3)).toEqual([])
    expect(rows).toBe(MACHINES.length * PATHS.length * OPTIONS.length * SETTINGS.length * 2)
  })
})

describe('src/main/remote-helper names no flag or variable of a CLI, and no path to one', () => {
  const DIR = resolve(__dirname, '../../../src/main/remote-helper')
  const FLAG = /^--[a-z][a-z0-9-]*$/
  const VARIABLE = new RegExp(`\\b(?:${PROVIDER_IDS.map((id) => id.toUpperCase()).join('|')})_[A-Z0-9_]+`)
  const CLI_PATH = new RegExp(`/(?:${PROVIDER_IDS.join('|')})$`)

  const named = (file: string): string[] => namedIn(file, readFileSync(join(DIR, file), 'utf8'))

  /** What a file names: a string or template text that is exactly one flag,
   *  or ends in a path to a provider's CLI; a CLI variable in a string, a
   *  template's text or a name. Code only: comments are not read. */
  function namedIn(file: string, text: string): string[] {
    const parsed = parse(text, { sourceType: 'module', plugins: ['typescript'], attachComment: false, errorRecovery: true })
    expect(parsed.errors ?? [], `${file} parses`).toEqual([])
    const ast = parsed as unknown as Record<string, unknown>
    const out: string[] = []
    const at = (n: Record<string, unknown>) => `${file}:${(n.loc as { start: { line: number } }).start.line}`
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(walk); return }
      const node = n as Record<string, unknown>
      if (typeof node.type === 'string') {
        const value = node.type === 'StringLiteral' ? (node.value as string)
          : node.type === 'TemplateElement' ? (node.value as { cooked: string }).cooked
            : null
        if (value !== null) {
          if (FLAG.test(value)) out.push(`${at(node)} flag ${value}`)
          if (CLI_PATH.test(value)) out.push(`${at(node)} path ${value}`)
          if (VARIABLE.test(value)) out.push(`${at(node)} variable ${value}`)
        }
        if (node.type === 'Identifier' && VARIABLE.test(node.name as string)) out.push(`${at(node)} variable ${node.name as string}`)
      }
      for (const [k, v] of Object.entries(node)) if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments' && k !== 'innerComments') walk(v)
    }
    walk(ast.program)
    return out
  }

  it('none in any file of the folder (index.ts and session.ts named them at d0be048e)', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'))
    expect(files).toEqual(expect.arrayContaining(['index.ts', 'session.ts', 'scripts.ts', 'machines.ts']))
    expect(files.flatMap(named)).toEqual([])
  })

  it('the scan sees each shape, and reads no comment (it is not blind)', () => {
    // Every provider's CLI name and variable prefix, from the app's own list.
    const [first, second] = PROVIDER_IDS
    const secondVariable = `${second.toUpperCase()}_HOME`
    const text = [
      "const a = ['--effort', `--model`, '-il', '--', 'hold --detach']",
      "env.CLAUDE_CODE_DISABLE_MOUSE = '1'",
      `const p = '/usr/local/bin/${first}'`,
      'const q = `${h}/' + second + '`',
      `const v = '${secondVariable}'`,
      `const w = probe.get('${first}') + claudePath`,
      "// '--continue' and CLAUDE_CODE_X in a comment are not read",
      `/* '/usr/local/bin/${first}' */`,
    ].join('\n')
    expect(namedIn('probe.ts', text)).toEqual([
      'probe.ts:1 flag --effort',
      'probe.ts:1 flag --model',
      'probe.ts:2 variable CLAUDE_CODE_DISABLE_MOUSE',
      `probe.ts:3 path /usr/local/bin/${first}`,
      `probe.ts:4 path /${second}`,
      `probe.ts:5 variable ${secondVariable}`,
    ])
  })
})

async function until(what: string, ok: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('core asks the tab\'s provider, by its id, through the registry', () => {
  /** This test's log lines: each test has its own, so a late line of a tab an
   *  earlier test closed never lands in a later test's. */
  let logs: string[] = []
  let ssh: FakeSsh
  let store = ''
  const win = { webContents: { send() {} }, isDestroyed: () => false }
  /** The default provider, and another one. */
  const DEFAULT = DEFAULT_PROVIDER_ID
  const OTHER = PROVIDER_IDS.find((p) => p !== DEFAULT_PROVIDER_ID)!
  function plugIn(settings: Record<string, unknown> = { remoteSessionsThroughHelper: true }): void {
    const mine: string[] = []
    logs = mine
    ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
    setRemoteHelperDeps({
      platform: 'win32',
      settings: () => settings,
      machines: { findByTarget: () => MACHINE, installId: () => 'f'.repeat(32) } as unknown as RemoteMachines,
      runner: ssh,
      bundledSha256: () => SHA,
      systemPrefersDark: () => true,
      onOutput: () => {},
      log: (m) => mine.push(m),
    })
  }
  function provider(id: string, remoteLaunch?: ProviderRemoteLaunch): SessionProvider {
    return { id, displayName: `Fake ${id}`, resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }), detectUiRunning: () => false, exitKeys: [], ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [], resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {}, ...(remoteLaunch ? { remoteLaunch } : {}) } as unknown as SessionProvider
  }
  /** A remote launch that records what it was given. */
  function recording(program: string) {
    const calls: Array<{ step: string; options: RemoteLaunchOptions; machine: RemoteLaunchMachine; helper?: RemoteHelperCommands; reads?: readonly RemoteHostFile[] }> = []
    const launch: ProviderRemoteLaunch = {
      hostReads: (options, machine) => { calls.push({ step: 'hostReads', options, machine }); return [] },
      launch: (options, machine, helper, reads) => { calls.push({ step: 'launch', options, machine, helper, reads }); return { program, args: ['--x', 'y'], env: { FAKE_CLI_VAR: '1' }, files: [], statusKeep: [], hookKeep: [] } },
    }
    return { launch, calls }
  }

  afterEach(() => {
    setRemoteHelperDeps(null)
    if (store) rmSync(store, { recursive: true, force: true })
    store = ''
  })

  it('the tab\'s own provider id picks the package; its launch reaches the holder through core; the other package is not asked', async () => {
    const byDefault = recording('/opt/default-cli')
    const other = recording('/opt/other-cli')
    registerProvider(provider(DEFAULT, byDefault.launch))
    registerProvider(provider(OTHER, other.launch))
    plugIn({ remoteSessionsThroughHelper: true, theme: 'light', classicTerminalCopyPaste: false })
    const id = 'rl-by-id'
    store = mkdtempSync(join(tmpdir(), 'rh-launch-'))
    const holder = new FakeHolder(remoteSessionId(id), id, store)
    ssh.host = {
      answer: (c) => (c.script === 'hold' ? { stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n${JSON.stringify({ ...holder.record(), endpoint: `/tmp/aicc-1000/${holder.sid}-0123456789abcdef.sock` })}\n` } : { code: 1 }),
      bridge: () => holder.connect(),
    }
    const pty = remoteHelperPty(win, id, { provider: OTHER, ssh: { ...SSH_TAB, reconnect: true }, model: 'm1', effortLevel: 'high', permissionMode: 'plan', extraArgs: '-a b', disableAutoMemory: true }, 100, 30)
    expect(pty).not.toBeNull()
    expect(byDefault.calls).toEqual([])
    const sid = remoteSessionId(id)
    const options: RemoteLaunchOptions = { model: 'm1', effortLevel: 'high', permissionMode: 'plan', extraArgs: '-a b', disableAutoMemory: true, reconnect: true, cwd: '/home/nick/work', settings: { remoteSessionsThroughHelper: true, theme: 'light', classicTerminalCopyPaste: false } }
    expect(other.calls).toEqual([
      { step: 'hostReads', options, machine: MACHINE },
      { step: 'launch', options, machine: MACHINE, helper: { helperPath: `/home/nick/.aicc/${MACHINE.did}/helper/${MACHINE.helper.folder}/aicc-helper`, store: `/home/nick/.aicc/${MACHINE.did}/store`, sid }, reads: [] },
    ])
    await until('the launch', () => holder.launch !== null && holder.attached !== null)
    const launch = holder.launch as { argv: string[]; cwd: string; env: Record<string, string> }
    expect(launch.argv).toEqual(['/bin/bash', '-il', '-c', 'exec "$0" "$@"', '/opt/other-cli', '--x', 'y'])
    expect(launch.cwd).toBe('/home/nick/work')
    expect(launch.env).toEqual({ HOME: '/home/nick', USER: 'nick', LOGNAME: 'nick', SHELL: '/bin/bash', PATH: MACHINE.path, LANG: 'C.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor', FAKE_CLI_VAR: '1', COLORFGBG: '0;15' })
    pty!.kill()
    await until('the holder to end', () => holder.ended)
  })

  it('a tab that names no provider is the default provider\'s', () => {
    const byDefault = recording('/opt/default-cli')
    const other = recording('/opt/other-cli')
    registerProvider(provider(DEFAULT, byDefault.launch))
    registerProvider(provider(OTHER, other.launch))
    plugIn()
    const pty = remoteHelperPty(win, 'rl-default', { ssh: SSH_TAB }, 100, 30)
    expect(pty).not.toBeNull()
    expect(byDefault.calls.map((c) => c.step)).toEqual(['hostReads', 'launch'])
    expect(other.calls).toEqual([])
    pty!.kill()
  })

  const usualCases: Array<[string, () => SessionProvider, string]> = [
    ['a provider with no remote launch', () => provider(DEFAULT), `its provider (Fake ${DEFAULT}) has no launch through the session helper`],
    ['a launch that asks for a host file read first', () => provider(DEFAULT, { hostReads: () => [{ from: 'home', path: '.cli/settings.json' }], launch: () => { throw new Error('not reached') } }), 'its provider asks for files on the host to be read before the launch, which this build does not do'],
    ['a launch that gives a file for the session\'s folder', () => provider(DEFAULT, { hostReads: () => [], launch: () => ({ program: '/opt/cli', args: [], env: {}, files: [{ name: 'settings.json', content: '{}' }], statusKeep: [], hookKeep: [] }) }), 'its provider gives files for the session\'s folder on the host, which this build does not write'],
    ['a launch that sets a variable core sets', () => provider(DEFAULT, { hostReads: () => [], launch: () => ({ program: '/opt/cli', args: [], env: { Path: '/elsewhere' }, files: [], statusKeep: [], hookKeep: [] }) }), 'the provider\'s launch sets Path, which the session helper\'s launch sets itself'],
    ['a launch that sets the terminal\'s scheme', () => provider(DEFAULT, { hostReads: () => [], launch: () => ({ program: '/opt/cli', args: [], env: { COLORFGBG: '1;2' }, files: [], statusKeep: [], hookKeep: [] }) }), 'the provider\'s launch sets COLORFGBG, which the session helper\'s launch sets itself'],
    ['a launch that throws', () => provider(DEFAULT, { hostReads: () => [], launch: () => { throw new Error('the package could not build it') } }), 'the package could not build it'],
  ]
  for (const [name, make, why] of usualCases) {
    it(`${name}: the usual path, nothing asked of the machine, and the log says why`, () => {
      registerProvider(make())
      plugIn()
      expect(remoteHelperPty(win, 'rl-usual', { ssh: SSH_TAB }, 100, 30)).toBeNull()
      expect(ssh.calls).toHaveLength(0)
      expect(logs).toEqual([`[remote-helper] rl-usual: the usual SSH path, because ${why}`])
    })
  }
})

describe('the session helper\'s commands and the spec core builds', () => {
  it('name the helper and the store by the layout scripts.ts keeps, under the home the check read', () => {
    expect(remoteHelperCommands(MACHINE, 'rmabc')).toEqual({ helperPath: `/home/nick/.aicc/${MACHINE.did}/helper/${MACHINE.helper.folder}/aicc-helper`, store: `/home/nick/.aicc/${MACHINE.did}/store`, sid: 'rmabc' })
    expect(remoteHelperCommands({ ...MACHINE, home: '/home/nick//' }, 'rmabc').store).toBe(`/home/nick/.aicc/${MACHINE.did}/store`)
  })

  it('core\'s own variables first, the package\'s next, the terminal\'s last; a package variable that is core\'s, in any case, is refused', () => {
    const spec = remoteLaunchSpec(MACHINE, { program: '/opt/cli', args: ['a'], env: { ONE: '1' } }, { COLORFGBG: '15;0' }, '~', 80, 24)
    expect(Object.keys(spec.env)).toEqual(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'TERM', 'COLORTERM', 'ONE', 'COLORFGBG'])
    for (const k of Object.keys(spec.env).filter((k) => k !== 'ONE')) {
      expect(() => remoteLaunchSpec(MACHINE, { program: '/opt/cli', args: [], env: { [k.toLowerCase()]: 'x' } }, { COLORFGBG: '15;0' }, '~', 80, 24)).toThrow(/sets itself/)
    }
  })
})

describe('the real Claude package carries the group', () => {
  it('its session surface is the one the registry hands core', () => {
    const pkg = createClaudePackage()
    expect(pkg.session.remoteLaunch).toBe(claudeRemoteLaunch)
    registerProvider(pkg.session)
    expect(tryGetProvider(pkg.id)?.remoteLaunch).toBe(claudeRemoteLaunch)
    expect(claudeRemoteLaunch.hostReads({ reconnect: false, cwd: '/home/nick', settings: null }, MACHINE)).toEqual([])
    const l = claudeRemoteLaunch.launch({ reconnect: false, cwd: '/home/nick', settings: null }, MACHINE, remoteHelperCommands(MACHINE, 'rmx'), [])
    expect({ files: l.files, statusKeep: l.statusKeep, hookKeep: l.hookKeep }).toEqual({ files: [], statusKeep: [], hookKeep: [] })
  })
})
