/**
 * nubbymong/aicc_planning#446 (2.1.3-beta.21, plan block 6): the remote half
 * of a review on the machine a remote session runs on, against a fake ssh
 * (fake-ssh.ts). The real scripts and the real run mode run on sh in the
 * remote-helper-e2e job (tests/live/remote-helper-device.live.ts) and in the
 * Helper job (helper/tests/run.rs).
 *
 * - Registration: a Claude Code tab through the helper registers its folder
 *   on its machine; the home folder there or a folder above it is never
 *   registered; a shell-only tab is not.
 * - The machine's record: a Check reads where Codex is (the same lookup as
 *   Claude Code's), its version, the exec's git, the probes PV1 and PV2's
 *   line, and Codex's own model list there (in a fresh, empty Codex home),
 *   and keeps them through the records file.
 * - The host read: its request on standard input; the change or the files
 *   back as data; its refusals in review-diff.ts's words; the bound checked
 *   again here on what came back (a host that sends more is refused).
 * - The run (docs/remote/helper-protocol.md section 4): the request line and
 *   the input on standard input, each within its bound, nothing of the host
 *   on the command line but the nonce and the timeout (30 to 900 s); the
 *   result line read as the exec's last line, with this exec's nonce and
 *   exactly its object, and anything else a failure; the program's output
 *   everything between the hash line and it; the exec's limit the review's
 *   own plus 30 s, its standard output cap above the run mode's; a cancel
 *   ends ssh; and a 900 s review is not cut by the relay's limit or the host
 *   read's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
vi.mock('../../../src/main/codex-review-usage', () => ({ recordReview: () => {} }))
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'
import { FakeSsh, parseCommand, result, type ExecCall, type FakeAnswer } from './fake-ssh'
import { RemoteMachines, type MachineStore, type RemoteMachineRecord, gitVersionOf, reviewProbesOf } from '../../../src/main/remote-helper/machines'
import type { BundledLinuxHelper } from '../../../src/main/remote-helper/manifest'
import { readHostReviewMaterial, runOnHost, remoteReviewLimits, hostReviewPaths, parseRunResult, REMOTE_RELAY_MAX_MS, REMOTE_RUN_EXTRA_MS, RUN_INPUT_MAX, RUN_OUTPUT_MAX, RUN_REQUEST_MAX, RUN_STDOUT_MAX, type HostReviewCtx } from '../../../src/main/remote-helper/review'
import { registerRemoteReviewSession, remoteReviewTarget, forgetRemoteReviewSession, hostFolderIsHomeOrAbove } from '../../../src/main/remote-helper/review-sessions'
import { scriptText, scriptCommand, RUN_TIMEOUT_RE, REVIEW_PROBES_FILE } from '../../../src/main/remote-helper/scripts'
import { hostRunEnv } from '../../../src/main/remote-helper/session'
import { EXEC_TIMEOUT_MS, type SshRunner } from '../../../src/main/remote-helper/ssh-exec'
import { setRemoteHelperDeps, remoteHelperPty, forgetRemoteHelperTab } from '../../../src/main/remote-helper'
import { registerProvider } from '../../../src/main/providers'
import type { SessionProvider } from '../../../src/main/providers/types'
import { claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import { CLAUDE_RUN_SCREEN } from '../../../src/main/providers/claude/run-screen'
import { runRemoteCodexReview, type RemoteReviewDeps } from '../../../src/main/codex-review-mcp-tool'
import { GIT_HARDENING, DIFF_HARDENING, REVIEW_DIFF_MAX_BYTES, WORK_TREE_KEYS_PATTERN } from '../../../src/main/review-diff'
import { codexCommandLine } from '../../../src/main/providers/codex/cli-runner'
import { codexRemoteReview } from '../../../src/main/providers/codex/remote-review'
import { mergeRegistry, type ModelRegistry } from '../../../src/shared/model-registry'
import registryJson from '../../../resources/model-registry.json'

const SHA = 'a'.repeat(64)
const HELPER: BundledLinuxHelper = { arch: 'x86_64', path: 'linux-x64/aicc-helper', file: '/x/linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, size: 4096, folder: `0.1.0-${SHA.slice(0, 12)}` }
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: null, helper: { path: 'linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
  logind: { kill: 'no', exclude: '', linger: 'no' },
  codex: { path: '/home/nick/.npm-global/bin/codex', version: '0.157.1' }, git: '2.47.1', reviewProbes: { codex: '0.157.1', git: '2.47.1' },
}
const INSTALL = 'f'.repeat(32)
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex')
let logs: string[] = []
const ctx = (runner: SshRunner): HostReviewCtx => ({ runner, installId: INSTALL, log: (l) => { logs.push(l) } })

beforeEach(() => { logs = [] })

// ── registration ─────────────────────────────────────────────────────────────

describe('a remote tab\'s registration for a review on its machine', () => {
  afterEach(() => { forgetRemoteReviewSession('rr-reg') })

  it('a project folder there is registered; the home folder, a folder above it, the root or a relative path never is', () => {
    expect(registerRemoteReviewSession('rr-reg', { did: MACHINE.did, cwd: '/home/nick/proj' }, '/home/nick')).toBe(true)
    expect(remoteReviewTarget('rr-reg')).toEqual({ did: MACHINE.did, cwd: '/home/nick/proj' })
    for (const cwd of ['/home/nick', '/home/nick/', '/home/nick/.', '/home', '/', '//', 'proj', '/home/nick/proj/..']) {
      expect(registerRemoteReviewSession('rr-reg', { did: MACHINE.did, cwd }, '/home/nick'), cwd).toBe(false)
      expect(remoteReviewTarget('rr-reg'), cwd).toBeNull()
    }
    expect(hostFolderIsHomeOrAbove('/home/nicholas', '/home/nick')).toBe(false)
    expect(hostFolderIsHomeOrAbove('/home/nick/x', '/home/nick')).toBe(false)
  })

  it('goes when the session does', () => {
    registerRemoteReviewSession('rr-reg', { did: MACHINE.did, cwd: '/home/nick/proj' }, '/home/nick')
    forgetRemoteReviewSession('rr-reg')
    expect(remoteReviewTarget('rr-reg')).toBeNull()
  })
})

describe('a Claude Code tab through the helper registers its folder there at its start', () => {
  const fakeProvider = {
    id: 'claude', displayName: 'Claude', resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
    detectUiRunning: () => false, ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
    resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {}, getSshSettingsPath: () => '', getSshMcpConfigPath: () => '', configureRemoteSettings: () => '',
    remoteLaunch: claudeRemoteLaunch,
    runScreen: CLAUDE_RUN_SCREEN,
  } as unknown as SessionProvider
  const win = { webContents: { send() {} }, isDestroyed: () => false }
  const ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
  beforeEach(() => {
    registerProvider(fakeProvider)
    setRemoteHelperDeps({
      platform: 'win32',
      settings: () => ({ remoteSessionsThroughHelper: true }),
      machines: { findByTarget: () => MACHINE, installId: () => INSTALL } as unknown as RemoteMachines,
      runner: ssh,
      bundledSha256: () => SHA,
      systemPrefersDark: () => true,
      onOutput: () => {},
      log: (m) => { logs.push(m) },
    })
  })
  afterEach(() => setRemoteHelperDeps(null))

  const start = (id: string, remotePath: string, extra: Record<string, unknown> = {}) => {
    forgetRemoteHelperTab(id)
    forgetRemoteReviewSession(id)
    const pty = remoteHelperPty(win, id, { provider: 'claude', ssh: { host: 'rocky.lan', port: 22, username: 'nick', remotePath, detachable: false }, ...extra }, 100, 30)
    pty?.kill()
    return { through: pty !== null, target: remoteReviewTarget(id) }
  }

  it('its folder there, from the config\'s remote path', () => {
    expect(start('rr-tab-proj', 'proj')).toEqual({ through: true, target: { did: MACHINE.did, cwd: '/home/nick/proj' } })
    expect(start('rr-tab-abs', '/srv/code/app')).toEqual({ through: true, target: { did: MACHINE.did, cwd: '/srv/code/app' } })
  })

  it('a tab in the home folder there is not registered, and the log says why', () => {
    expect(start('rr-tab-home', '~')).toEqual({ through: true, target: null })
    expect(logs.some((l) => l.includes('rr-tab-home: codex_review NOT registered'))).toBe(true)
  })

  it('a shell-only tab (the usual path) is not registered', () => {
    expect(start('rr-tab-shell', 'proj', { shellOnly: true })).toEqual({ through: false, target: null })
  })
})

// ── the machine's record ─────────────────────────────────────────────────────

/** Codex's own catalogue, as `codex debug models --bundled` prints it. */
const CATALOGUE = JSON.stringify({
  models: [
    { slug: 'gpt-host-1', display_name: 'GPT Host 1', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
    { slug: 'gpt-host-2', display_name: 'GPT Host 2', visibility: 'list', priority: 2 },
  ],
}, null, 2)

function host(over: Partial<Record<ExecCall['script'], (c: ExecCall) => FakeAnswer>> = {}, probe: Record<string, string> = {}) {
  return {
    answer: (c: ExecCall): FakeAnswer => {
      const custom = over[c.script]
      if (custom) return custom(c)
      const n = c.values[0]
      switch (c.script) {
        case 'probe': return { stdout: `Welcome!\n${result(n, { os: 'Linux', arch: 'x86_64', home: '/home/nick', user: 'nick', shell: '/bin/bash', path: '/usr/bin:/bin', lang: 'C.UTF-8', claude: '', 'il-path': '/home/nick/.npm-global/bin:/usr/bin:/bin', 'il-claude': '/home/nick/.npm-global/bin/claude', ...probe })}` }
        case 'install': return { stdout: result(n, { hash: SHA }) }
        case 'commit': case 'discard': case 'remove': return { stdout: result(n, {}) }
        case 'version': return { stdout: `AICC-HASH ${n} ok ${SHA}\naicc-helper 0.1.0\n` }
        case 'selftest': return { stdout: `AICC-HASH ${n} ok ${SHA}\nAICC-RESULT ${n} {"ok":true,"helper":"0.1.0","checks":[{"name":"frames","ok":true}]}\n` }
        case 'list': return { stdout: `AICC-HASH ${n} ok ${SHA}\n{"v":1,"sessions":[],"removed":0,"skipped":0}\n` }
        case 'sweep': return { stdout: `AICC-HASH ${n} ok ${SHA}\n${result(n, { swept: '0' })}` }
        case 'cliread': return { stdout: result(n, { out: hex(`rc file text\nAICC-CLI ${n}\n${CATALOGUE}\n`) }) }
        default: return { code: 1 }
      }
    },
  }
}
const CODEX_PROBE = {
  'il-codex': '/home/nick/.npm-global/bin/codex', 'il-codex-version': 'codex-cli 0.157.1', git: 'git version 2.47.1',
  'review-probes': 'aicc-review-probes 1 codex 0.157.1 git 2.47.1',
}

function memoryStore(): MachineStore {
  let v: unknown = null
  return { read: () => v, write: (x) => { v = JSON.parse(JSON.stringify(x)) } }
}

async function added(ssh: FakeSsh): Promise<RemoteMachines> {
  const m = new RemoteMachines({ runner: ssh, store: memoryStore(), bundled: async () => ({ ok: true, helpers: [HELPER] }), readFile: async () => Buffer.alloc(4096, 7), inUse: () => 0, log: (l) => { logs.push(l) }, reviewer: () => codexRemoteReview })
  const q = await m.prepare([{ id: 'cfg', label: 'Rocky', sessionType: 'ssh', sshConfig: { host: 'rocky.lan', port: 22, username: 'nick' } }], 'cfg')
  if (!q.ok) throw new Error(q.message)
  const r = await m.add(q.token)
  expect(r.ok, r.message).toBe(true)
  return m
}

describe('a Check reads Codex, its model list, the git and the probes\' line there', () => {
  it('kept in the record, through the records file', async () => {
    const ssh = new FakeSsh(host({}, CODEX_PROBE))
    const m = await added(ssh)
    const [rec] = m.list()
    expect(rec.codex).toEqual({ path: '/home/nick/.npm-global/bin/codex', version: '0.157.1', models: { version: '0.157.1', models: [{ id: 'gpt-host-1', label: 'GPT Host 1', efforts: ['low', 'medium', 'high'] }, { id: 'gpt-host-2', label: 'GPT Host 2' }] } })
    expect(rec.git).toBe('2.47.1')
    expect(rec.reviewProbes).toEqual({ codex: '0.157.1', git: '2.47.1' })
    // The model list's read runs once Codex was found, after the helper's own checks.
    const scripts = ssh.scripts()
    expect(scripts.indexOf('cliread')).toBeGreaterThan(scripts.indexOf('selftest'))
    expect(ssh.calls.find((c) => c.script === 'cliread')!.values.slice(3)).toEqual(['codex', 'debug,models,--bundled', 'CODEX_HOME'])
  })

  it('no Codex there: no Codex in the record, and no model list read', async () => {
    const ssh = new FakeSsh(host({}, { git: 'git version 2.47.1' }))
    const [rec] = (await added(ssh)).list()
    expect(rec.codex).toBeUndefined()
    expect(ssh.scripts()).not.toContain('cliread')
  })

  it('a Codex older than the oldest this app runs: kept with its version, and no model list read', async () => {
    const ssh = new FakeSsh(host({}, { ...CODEX_PROBE, 'il-codex-version': 'codex-cli 0.150.0' }))
    const [rec] = (await added(ssh)).list()
    expect(rec.codex).toEqual({ path: '/home/nick/.npm-global/bin/codex', version: '0.150.0' })
    expect(ssh.scripts()).not.toContain('cliread')
  })

  it('a model list that does not read is not kept, with one log line; the Check still passes', async () => {
    const ssh = new FakeSsh(host({ cliread: (c) => ({ stdout: result(c.values[0], { out: hex('no marker here\n{}') }) }) }, CODEX_PROBE))
    const [rec] = (await added(ssh)).list()
    expect(rec.check.ok).toBe(true)
    expect(rec.codex).toEqual({ path: '/home/nick/.npm-global/bin/codex', version: '0.157.1' })
    expect(logs.filter((l) => l.includes('the Codex model list there was not read'))).toHaveLength(1)
  })

  it('reads the lines strictly', () => {
    expect(gitVersionOf('git version 2.39.5 (Apple Git-154)')).toBe('2.39.5')
    expect(gitVersionOf('git version 2.45.1.windows.1')).toBe('2.45.1')
    expect(gitVersionOf('git version x')).toBeNull()
    expect(gitVersionOf('')).toBeNull()
    expect(reviewProbesOf('aicc-review-probes 1 codex 0.157.1 git 2.47.1')).toEqual({ codex: '0.157.1', git: '2.47.1' })
    expect(reviewProbesOf('aicc-review-probes 1 codex 0.157.1 git 2.47.1 extra')).toBeNull()
    expect(reviewProbesOf('aicc-review-probes 2 codex 0.157.1 git 2.47.1')).toBeNull()
    expect(reviewProbesOf('aicc-review-probes 1 codex $(id) git 2.47.1')).toBeNull()
  })

  it('the probe reads the probes\' line only from a regular file of the user\'s own, and Codex\'s version only within a bound', () => {
    const t = scriptText('probe')
    expect(t).toContain(`Q=$HOME/.aicc/${REVIEW_PROBES_FILE}; if [ -f "$Q" ] && [ ! -L "$Q" ]; then set -- $(ls -ldn "$Q"); [ "$3" = "$u" ] && r review-probes`)
    expect(t).toContain('W=; command -v timeout >/dev/null 2>&1 && W="timeout 10"')
    expect(t).toContain('il-codex-version ${v}(command -v codex >/dev/null 2>&1 && $W codex --version')
  })

  it('the model list is read in a fresh, empty Codex home in the device folder, removed after it', () => {
    const t = scriptText('cliread')
    expect(t).toContain('T=$A/cli-$N')
    expect(t).toContain('mkdir "$T" "$T/home" || no busy')
    expect(t).toContain('export "$E=$T/home"')
    expect(t).toContain('cl() { [ -d "$T" ] && rm -rf -- "${A:?}/cli-${N:?}"; }')
    expect(t).toContain('trap cl EXIT')
    // The words are the Codex package's: the runner's own models constant.
    const local = codexCommandLine('/x/codex', 'models', 'linux', {})
    if ('refused' in local) throw new Error(local.refused)
    expect([...codexRemoteReview.modelListRead.words]).toEqual(local.args)
    expect(codexRemoteReview.modelListRead.configVariable).toBe('CODEX_HOME')
    expect(() => scriptCommand('cliread', ['0'.repeat(32), MACHINE.did, INSTALL, 'codex', 'debug,models;id', 'CODEX_HOME'])).toThrow(/words/)
  })
})

describe('the review\'s three scripts are fixed scripts like every other (protocol sections 4 and 13)', () => {
  const names = ['run', 'reviewread', 'cliread'] as const
  it('hold no single quote, backslash or line end; check the device id, the home folder and the owner marker first', () => {
    for (const n of names) {
      const t = scriptText(n)
      expect(t, n).not.toMatch(/['\\\r\n]/)
      expect(t, n).toContain('no bad-device-id')
      expect(t, n).toContain('no home-open-to-others')
      expect(t, n).toContain('mk || no not-this-install')
    }
  })

  it('each command line fits one argument of a Linux exec (128 KiB), with its values', () => {
    const N = '0'.repeat(32)
    const lines = [
      scriptCommand('run', [N, MACHINE.did, INSTALL, MACHINE.helper.folder, SHA, '900']),
      scriptCommand('reviewread', [N, MACHINE.did, INSTALL]),
      scriptCommand('cliread', [N, MACHINE.did, INSTALL, 'codex', 'debug,models,--bundled', 'CODEX_HOME']),
    ]
    for (const l of lines) expect(Buffer.byteLength(l), l.slice(0, 40)).toBeLessThan(128 * 1024)
  })

  it('the host read and the CLI read write only their own folder in the device folder, removed when they end', () => {
    expect(scriptText('reviewread').match(/rm -rf/g)).toEqual(['rm -rf'])
    expect(scriptText('reviewread')).toContain('cl() { [ -d "$T" ] && rm -rf -- "${A:?}/rv-${N:?}"; }')
    expect(scriptText('cliread').match(/rm -rf/g)).toEqual(['rm -rf'])
    expect(scriptText('run')).not.toMatch(/rm |mkdir|>\s*"?\$/)
  })
})

// ── the host read ────────────────────────────────────────────────────────────

describe('the change, read on the machine', () => {
  const reading = (answer: (c: ExecCall) => FakeAnswer) => {
    const ssh = new FakeSsh({ answer })
    return { ssh, read: (input: Parameters<typeof readHostReviewMaterial>[2]) => readHostReviewMaterial(ctx(ssh), MACHINE, input) }
  }

  it('its request on standard input; the change back as data', async () => {
    const diff = 'diff --git a/x b/x\n+ünï "q" \\ $(id)\n'
    const { ssh, read } = reading((c) => ({ stdout: `rc text\n${result(c.values[0], { diff: hex(diff) })}` }))
    expect(await read({ cwd: '/home/nick/proj', mode: 'range', range: 'HEAD~1..HEAD' })).toEqual({ ok: true, kind: 'diff', diff })
    const call = ssh.calls[0]
    expect(call.script).toBe('reviewread')
    expect(call.values).toEqual([call.values[0], MACHINE.did, INSTALL])
    expect(call.stdin.toString('utf8')).toBe('/home/nick/proj\nrange\nHEAD~1..HEAD\n')
  })

  it('its refusals in review-diff.ts\'s words', async () => {
    const said = async (lines: Record<string, string>, word: string) => {
      const { read } = reading((c) => ({ stdout: result(c.values[0], lines, `refused ${word}`) }))
      const r = await read({ cwd: '/home/nick/proj', mode: 'working' })
      if (r.ok) throw new Error('read')
      return r.message
    }
    expect(await said({ why: hex('fatal: not a git repository (or any of the parent directories): .git') }, 'git-failed')).toBe('fatal: not a git repository (or any of the parent directories): .git')
    expect(await said({}, 'project-is-home')).toMatch(/is its home folder or a folder above it/)
    expect(await said({}, 'too-large')).toBe(`the change is larger than ${REVIEW_DIFF_MAX_BYTES / 1024} KB; review a narrower range, or name files with mode "paths"`)
    expect(await said({ path: hex('src/link.ts') }, 'file-link')).toBe('"src/link.ts" is a link (a symbolic link or a junction), so it is not sent')
    expect(await said({}, 'head-not-a-commit')).toBe('HEAD is not a commit')
  })

  it('a host that sends more than the bound is refused here', async () => {
    const big = 'x'.repeat(REVIEW_DIFF_MAX_BYTES + 1)
    const { read } = reading((c) => ({ stdout: result(c.values[0], { diff: hex(big) }) }))
    const r = await read({ cwd: '/home/nick/proj', mode: 'working' })
    expect(r).toEqual({ ok: false, message: `the change is larger than ${REVIEW_DIFF_MAX_BYTES / 1024} KB; review a narrower range, or name files with mode "paths"` })
  })

  it('mode paths: each file, and a binary one named; the bound counted as here over what came back', async () => {
    const { ssh, read } = reading((c) => ({ stdout: `AICC-RESULT ${c.values[0]} file ${hex('src/a.ts')} ${hex('const a = 1\n')}\nAICC-RESULT ${c.values[0]} binary ${hex('img.png')}\nAICC-RESULT ${c.values[0]} file ${hex('empty.txt')} \n${result(c.values[0], {})}` }))
    expect(await read({ cwd: '/home/nick/proj', mode: 'paths', paths: ['src/a.ts', 'img.png', 'empty.txt'] })).toEqual({ ok: true, kind: 'files', files: [{ path: 'src/a.ts', text: 'const a = 1\n' }, { path: 'img.png', binary: true }, { path: 'empty.txt', text: '' }] })
    expect(ssh.calls[0].stdin.toString('utf8')).toBe('/home/nick/proj\npaths\nsrc/a.ts\nimg.png\nempty.txt\n')
    const over = reading((c) => ({ stdout: `AICC-RESULT ${c.values[0]} file ${hex('a.ts')} ${hex('y'.repeat(REVIEW_DIFF_MAX_BYTES))}\n${result(c.values[0], {})}` }))
    expect(await over.read({ cwd: '/home/nick/proj', mode: 'paths', paths: ['a.ts'] })).toEqual({ ok: false, message: `the files are larger than ${REVIEW_DIFF_MAX_BYTES / 1024} KB together; name fewer or smaller files` })
  })

  it('a range this computer would refuse is refused before ssh starts, in the same words; a good one goes as review-diff.ts reads it', async () => {
    const { ssh, read } = reading((c) => ({ stdout: result(c.values[0], { diff: hex('') }) }))
    for (const range of ['-x..HEAD', 'HEAD', 'HEAD~1..HEAD:src', 'a b..c', '..', `${'a'.repeat(201)}..HEAD`, 'HEAD~1..--output=x']) {
      const r = await read({ cwd: '/home/nick/proj', mode: 'range', range })
      expect(r, range).toEqual({ ok: false, message: 'the range must be two revisions joined by ".." or "..." (for example HEAD~1..HEAD): no spaces, no leading "-", no ":"' })
    }
    expect(ssh.calls).toHaveLength(0)
    for (const range of ['HEAD~1..HEAD', 'main...feature/x', '..HEAD', 'abc123..']) {
      expect((await read({ cwd: '/home/nick/proj', mode: 'range', range })).ok, range).toBe(true)
    }
    expect(ssh.calls.map((c) => c.stdin.toString('utf8').split('\n')[2])).toEqual(['HEAD~1..HEAD', 'main...feature/x', '..HEAD', 'abc123..'])
  })

  it('a request that holds a line end, or names past the bound, is refused before ssh starts', async () => {
    const { ssh, read } = reading(() => ({ code: 0 }))
    expect((await read({ cwd: '/home/nick/proj', mode: 'range', range: 'HEAD\nx' })).ok).toBe(false)
    expect((await read({ cwd: '/home/nick/proj\n/etc', mode: 'working' })).ok).toBe(false)
    expect((await read({ cwd: '/home/nick/proj', mode: 'paths', paths: ['z'.repeat(REVIEW_DIFF_MAX_BYTES)] })).ok).toBe(false)
    expect(ssh.calls).toHaveLength(0)
  })

  it('mode paths\' names: inside the folder, relative, as a path on the machine', () => {
    expect(hostReviewPaths('/home/nick/proj', ['a.ts', './b/../c.ts', '/home/nick/proj/d/e.ts'])).toEqual({ ok: true, paths: ['a.ts', 'c.ts', 'd/e.ts'] })
    for (const p of ['../x', '/etc/passwd', '.', 'a\nb', '/home/nick/projx/a']) expect(hostReviewPaths('/home/nick/proj', [p]).ok, p).toBe(false)
  })

  it('the script runs review-diff.ts\'s hardened git, refuses the home folder there, and removes its own folder', () => {
    const t = scriptText('reviewread')
    for (const s of [...GIT_HARDENING, ...DIFF_HARDENING]) expect(t, s).toContain(s)
    expect(t).toContain(`"${WORK_TREE_KEYS_PATTERN}"`)
    expect(t).toContain('ab "$w" "$h" && no project-is-home')
    expect(t).toContain('--end-of-options "$q" --')
    expect(t).toContain('--end-of-options "${hd:-$E}" --')
    expect(t).toContain('GIT_OPTIONAL_LOCKS=0; GIT_TERMINAL_PROMPT=0; GIT_NO_LAZY_FETCH=1')
    expect(t).toContain('cl() { [ -d "$T" ] && rm -rf -- "${A:?}/rv-${N:?}"; }')
    expect(t).toContain(`M=${REVIEW_DIFF_MAX_BYTES}`)
  })
})

// ── the run ──────────────────────────────────────────────────────────────────

const SPEC = { argv: ['/home/nick/.npm-global/bin/codex', 'exec', '--json', '-'], cwd: '/home/nick/proj', env: hostRunEnv(MACHINE) }
/** The run mode's result line for nonce `n` (helper/src/run.rs). */
const ok = (n: string, more: { code?: number | null; signal?: number | null; timeout?: boolean; cut?: boolean } = {}) =>
  `AICC-RESULT ${n} ${JSON.stringify({ code: 0, signal: null, timeout: false, cut: false, ...more })}\n`

describe('one program run on the machine through the helper\'s run mode', () => {
  it('the request line, then the input, on standard input; on the command line only the nonce and the timeout', async () => {
    const ssh = new FakeSsh({ answer: (c) => ({ stdout: `rc text\nAICC-HASH ${c.values[0]} ok ${SHA}\n{"type":"x"}\n${ok(c.values[0])}`, code: 0 }) })
    const r = await runOnHost(ctx(ssh), MACHINE, SPEC, 'the prompt\n', 300_000)
    expect(r).toEqual({ outcome: { code: 0, signal: null, timeout: false, cut: false }, stdout: '{"type":"x"}\n', stderr: '', timedOut: false, cancelled: false })
    const call = ssh.calls[0]
    expect(call.script).toBe('run')
    expect(call.values.slice(1)).toEqual([MACHINE.did, INSTALL, MACHINE.helper.folder, MACHINE.helper.sha256, '300'])
    const [head, ...rest] = call.stdin.toString('utf8').split('\n')
    expect(JSON.parse(head)).toEqual({ argv: SPEC.argv, cwd: SPEC.cwd, env: SPEC.env })
    expect(Object.keys(JSON.parse(head))).toEqual(['argv', 'cwd', 'env'])
    expect(rest.join('\n')).toBe('the prompt\n')
    const command = call.args[call.args.length - 1]
    for (const v of [SPEC.argv[0], SPEC.cwd, MACHINE.home]) expect(command).not.toContain(v)
    // The program's environment is the host account's own and LANG: nothing of this computer's.
    expect(SPEC.env).toEqual({ HOME: '/home/nick', USER: 'nick', LOGNAME: 'nick', SHELL: '/bin/bash', PATH: MACHINE.path, LANG: 'C.UTF-8' })
    // The exec keeps more than the run mode copies: its 4 MiB, the line end
    // it may add, the preamble, the hash line and the result line.
    expect(RUN_OUTPUT_MAX).toBe(4 * 1024 * 1024)
    expect(RUN_STDOUT_MAX).toBeGreaterThan(RUN_OUTPUT_MAX + 1 + 64 * 1024 + 2 * 200)
  })

  it("output up to the run mode's 4 MiB is read whole: the exec's cap is above it, not the one-shot exec's 2 MiB", async () => {
    const big = `${"e".repeat(1023)}
`.repeat(4 * 1024)
    const ssh = new FakeSsh({ answer: (c) => ({ stdout: `AICC-HASH ${c.values[0]} ok ${SHA}
${big}${ok(c.values[0])}`, code: 0 }) })
    const r = await runOnHost(ctx(ssh), MACHINE, SPEC, "", 300_000)
    expect(r.failure).toBeUndefined()
    expect(r.stdout.length).toBe(RUN_OUTPUT_MAX)
    expect(r.outcome).toEqual({ code: 0, signal: null, timeout: false, cut: false })
  })

  it('the launcher runs the helper\'s run mode with the nonce and the timeout, after the hash check', () => {
    const t = scriptText('run')
    expect(t).toContain('exec "$P" run --nonce "$N" --timeout "$T"')
    expect(t.indexOf('echo "AICC-HASH $N ok $x"')).toBeGreaterThan(-1)
    expect(t.indexOf('echo "AICC-HASH $N ok $x"')).toBeLessThan(t.indexOf('exec "$P" run'))
  })

  it('its timeout goes on the command line in whole seconds, 30 to 900', async () => {
    for (const good of ['30', '99', '100', '330', '899', '900']) expect(RUN_TIMEOUT_RE.test(good), good).toBe(true)
    for (const bad of ['0', '1', '29', '030', '901', '1000', '01', '-5', '5s', '']) expect(RUN_TIMEOUT_RE.test(bad), bad).toBe(false)
    expect(() => scriptCommand('run', ['0'.repeat(32), MACHINE.did, INSTALL, MACHINE.helper.folder, SHA, '901'])).toThrow(/run timeout/)
    expect(() => scriptCommand('run', ['0'.repeat(32), MACHINE.did, INSTALL, MACHINE.helper.folder, SHA, '29'])).toThrow(/run timeout/)
    const ssh = new FakeSsh({ answer: () => ({ code: 0 }) })
    expect((await runOnHost(ctx(ssh), MACHINE, SPEC, '', 901_000)).failure).toMatch(/30 to 900 seconds/)
    expect((await runOnHost(ctx(ssh), MACHINE, SPEC, '', 29_000)).failure).toMatch(/30 to 900 seconds/)
    expect(ssh.calls).toHaveLength(0)
  })

  it('a request or an input past its bound is refused here, before ssh starts', async () => {
    const ssh = new FakeSsh({ answer: () => ({ code: 0 }) })
    expect(RUN_REQUEST_MAX).toBe(64 * 1024)
    expect(RUN_INPUT_MAX).toBe(2 * 1024 * 1024)
    const fat = { ...SPEC, env: { ...SPEC.env, BIG: 'x'.repeat(RUN_REQUEST_MAX) } }
    expect((await runOnHost(ctx(ssh), MACHINE, fat, '', 300_000)).failure).toMatch(/request line is over 64 KiB/)
    expect((await runOnHost(ctx(ssh), MACHINE, SPEC, 'p'.repeat(RUN_INPUT_MAX + 1), 300_000)).failure).toMatch(/over 2 MiB/)
    expect(ssh.calls).toHaveLength(0)
    // At the bound, it is sent.
    await runOnHost(ctx(ssh), MACHINE, SPEC, 'p'.repeat(RUN_INPUT_MAX), 300_000)
    expect(ssh.calls).toHaveLength(1)
  })

  it('the result line is the exec\'s last line, with this exec\'s nonce and exactly its object', () => {
    const N = '0123456789abcdef0123456789abcdef'
    expect(parseRunResult(`out 1\nout 2\n${ok(N)}`, N)).toEqual({ outcome: { code: 0, signal: null, timeout: false, cut: false }, output: 'out 1\nout 2\n' })
    expect(parseRunResult(ok(N, { code: null, signal: 1, timeout: true }), N)).toEqual({ outcome: { code: null, signal: 1, timeout: true, cut: false }, output: '' })
    // A line in the output that looks like a result is the program's own: only the last line counts.
    expect(parseRunResult(`${ok(N)}more\n${ok(N, { code: 3 })}`, N)).toEqual({ outcome: { code: 3, signal: null, timeout: false, cut: false }, output: `${ok(N)}more\n` })
    for (const bad of [
      '', 'out\n', `${ok(N)}after\n`, ok(N).trimEnd(), ok('f'.repeat(32)),
      `AICC-RESULT ${N} {"code":0,"signal":null,"timeout":false}\n`,
      `AICC-RESULT ${N} {"code":0,"signal":null,"timeout":false,"cut":false,"extra":1}\n`,
      `AICC-RESULT ${N} {"code":"0","signal":null,"timeout":false,"cut":false}\n`,
      `AICC-RESULT ${N} {"code":0.5,"signal":null,"timeout":false,"cut":false}\n`,
      `AICC-RESULT ${N} {"code":0,"signal":null,"timeout":"no","cut":false}\n`,
      `AICC-RESULT ${N} [0]\n`,
      `AICC-RESULT ${N} not json\n`,
    ]) expect(parseRunResult(bad, N), JSON.stringify(bad)).toBeNull()
  })

  it('how the run ended, from its result line; anything else is a failure, never a result', async () => {
    const answering = (a: FakeAnswer) => runOnHost(ctx(new FakeSsh({ answer: (c) => ({ ...a, stdout: (a.stdout ?? '').split('NONCE').join(c.values[0]) }) })), MACHINE, SPEC, '', 60_000)
    const hash = `AICC-HASH NONCE ok ${SHA}\n`
    expect(await answering({ stdout: `${hash}partial\nAICC-RESULT NONCE {"code":null,"signal":1,"timeout":true,"cut":false}\n`, code: 0 }))
      .toEqual({ outcome: { code: null, signal: 1, timeout: true, cut: false }, stdout: 'partial\n', stderr: '', timedOut: false, cancelled: false })
    expect((await answering({ stdout: `${hash}AICC-RESULT NONCE {"code":141,"signal":null,"timeout":false,"cut":true}\n`, code: 0 })).outcome).toEqual({ code: 141, signal: null, timeout: false, cut: true })
    // The run mode refused, or could not start the program: exit 1, its words on standard error.
    const refused = await answering({ stdout: hash, stderr: 'aicc-helper: run: the program /home/nick/.npm-global/bin/codex is not a file there, so nothing was started\n', code: 1 })
    expect(refused.outcome).toBeNull()
    expect(refused.failure).toBe('the session helper started nothing there: the program /home/nick/.npm-global/bin/codex is not a file there, so nothing was started')
    // A result line with an exit that is not 0, or an exit 0 with none: failures, never results.
    expect((await answering({ stdout: `${hash}AICC-RESULT NONCE {"code":0,"signal":null,"timeout":false,"cut":false}\n`, code: 1 })).failure).toMatch(/no result line/)
    expect((await answering({ stdout: `${hash}{"type":"x"}\n`, code: 0 })).failure).toMatch(/no result line/)
    expect((await answering({ stdout: 'AICC-HASH NONCE mismatch bb\n', code: 97 })).failure).toMatch(/did not pass its hash check \(mismatch\)/)
    expect((await answering({ stdout: 'nothing\n', code: 0 })).failure).toMatch(/did not answer the session helper/)
    expect((await answering({ stderr: 'ssh: connect to host rocky.lan port 22: Connection refused', code: 255 })).failure).toMatch(/could not be reached: it refused the connection/)
  })
})

/** An ssh that answers a run after `afterMs`, or never; its kill is seen. */
class SlowSsh implements SshRunner {
  killed = 0
  calls: Array<{ script: string; values: string[] }> = []
  constructor(private readonly afterMs: number | null, private readonly stdout: (nonce: string) => string) {}
  sshPath(): string { return 'ssh' }
  version = async (): Promise<[number, number] | null> => [9, 5]
  env(): Record<string, string> { return {} }
  spawn = ((_f: string, args: readonly string[]) => {
    const { script, values } = parseCommand(args[args.length - 1])
    this.calls.push({ script, values })
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, exitCode: null as number | null, signalCode: null as string | null })
    let over = false
    const finish = (code: number | null, signal: string | null) => {
      if (over) return
      over = true
      child.exitCode = code
      child.signalCode = signal
      child.stdout.end()
      child.stderr.end()
      setImmediate(() => child.emit('close', code, signal))
    }
    Object.assign(child, { kill: () => { this.killed++; finish(null, 'SIGTERM'); return true } })
    child.stdin.resume()
    if (this.afterMs !== null) setTimeout(() => { child.stdout.write(this.stdout(values[0])); finish(0, null) }, this.afterMs)
    return child as unknown as ChildProcess
  }) as SshRunner['spawn']
}

describe('the limits, and a stop', () => {
  afterEach(() => { vi.useRealTimers() })

  it('the run\'s exec gets the review\'s own timeout and 30 s more; the relay its timeout and 90 s, at most 990 s', async () => {
    expect(REMOTE_RUN_EXTRA_MS).toBe(30_000)
    expect(remoteReviewLimits(300_000)).toEqual({ readMs: EXEC_TIMEOUT_MS, runMs: 330_000, relayMs: 390_000 })
    expect(remoteReviewLimits(900_000)).toEqual({ readMs: 60_000, runMs: 930_000, relayMs: 990_000 })
    expect(REMOTE_RELAY_MAX_MS).toBe(990_000)
    for (const t of [30_000, 300_000, 900_000]) {
      const l = remoteReviewLimits(t)
      expect(l.relayMs).toBeGreaterThan(l.runMs)
      expect(l.relayMs).toBeGreaterThanOrEqual(l.readMs + l.runMs)
    }
    vi.useFakeTimers()
    const ssh = new SlowSsh(null, () => '')
    let done = false
    const p = runOnHost(ctx(ssh), MACHINE, SPEC, '', 900_000).then((r) => { done = true; return r })
    await vi.advanceTimersByTimeAsync(929_000)
    expect(done).toBe(false)
    expect(ssh.killed).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    const r = await p
    expect(r.timedOut).toBe(true)
    expect(ssh.killed).toBe(1)
  })

  it('a stop ends ssh at once: the exec closes there, and the run mode ends the program', async () => {
    const ssh = new SlowSsh(null, () => '')
    const stop = new AbortController()
    const p = runOnHost(ctx(ssh), MACHINE, SPEC, '', 300_000, stop.signal)
    await vi.waitFor(() => expect(ssh.calls).toHaveLength(1))
    stop.abort()
    expect(await p).toMatchObject({ cancelled: true, outcome: null })
    expect(ssh.killed).toBe(1)
  })

  it('a 900 s review on the machine is not cut short: neither by the host read\'s 60 s nor by a 10 minute limit', async () => {
    vi.useFakeTimers()
    const events = `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Slow but fine.' } })}\n`
    const ssh = new SlowSsh(899_000, (n) => `AICC-HASH ${n} ok ${SHA}\n${events}${ok(n)}`)
    const m: RemoteMachineRecord = MACHINE
    const deps: RemoteReviewDeps = {
      machine: () => m,
      read: async () => ({ ok: true, kind: 'diff', diff: 'diff --git a/x b/x\n+x\n' }),
      run: (rec, spec, input, timeoutMs, signal) => runOnHost(ctx(ssh), rec, spec, input, timeoutMs, signal),
      env: hostRunEnv,
      registry: () => mergeRegistry(registryJson as unknown as ModelRegistry, null),
      launchRefusal: () => null,
      reviewer: () => codexRemoteReview,
    }
    let done = false
    const p = runRemoteCodexReview({ cccSessionId: 'rr-slow', mode: 'working', timeoutSeconds: 900 }, { did: m.did, cwd: '/home/nick/proj' }, deps).then((r) => { done = true; return r })
    await vi.advanceTimersByTimeAsync(600_001)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(299_000)
    const r = await p
    expect(r.isError, r.text).toBe(false)
    expect(r.text.startsWith('Slow but fine.')).toBe(true)
    expect(ssh.killed).toBe(0)
    expect(ssh.calls.map((c) => c.script)).toEqual(['run'])
    expect(ssh.calls[0].values.at(-1)).toBe('900')
  })
})
