/**
 * The clipboard stand-in's launch (plan 2.1.3-beta.21 phase 5, 5.1 and 5.3;
 * ADR-032; docs/remote/helper-protocol.md section 15). On a Linux host Claude
 * Code reads a picture by running `xclip` or `wl-paste`, found by PATH, so a
 * helper tab's launch asks for the session helper's stand-in:
 *
 * - core's remoteLaunchSpec puts the session's bin/ folder first on PATH, in
 *   both shapes: inside the `-c` wrapper text, after the rc files, for a login
 *   shell of the sh family (the folder an argument, never in the text), and in
 *   front of the host account's PATH for one outside it, where no rc file
 *   runs. A launch that does not ask, or a folder that cannot go on PATH or
 *   into the scripts, changes nothing;
 * - the Claude package's session launch asks; its sign-in launch does not;
 * - the `files` exec carries the helper's folder and `clip` (or `none`), and
 *   its script writes the two scripts 0700 into bin/; a stand-in it could not
 *   write fails nothing, and the log says why.
 *
 * Mutants (5.3): the bin folder after the user's PATH, in either shape; a
 * script written 0600. The real sh runs of the same script and wrapper are
 * clip-stand-in-sh.test.ts's (CI only).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { RemoteLaunchOptions, SessionProvider } from '../../../src/main/providers/types'
import { registerProvider } from '../../../src/main/providers'
import { claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import { remoteHelperPty, remoteLaunchOf, setRemoteHelperDeps } from '../../../src/main/remote-helper'
import { CLIP_STAND_IN_WRAPPER, PLAIN_WRAPPER, clipStandInFolder, remoteHelperCommands, remoteLaunchSpec, remoteSessionId, type RemoteHelperPty } from '../../../src/main/remote-helper/session'
import { STAND_IN_RE, scriptCommand, scriptText } from '../../../src/main/remote-helper/scripts'
import type { RemoteMachineRecord, RemoteMachines } from '../../../src/main/remote-helper/machines'
import type { HolderRecord } from '../../../src/main/session-helper/protocol'
import { DEFAULT_PROVIDER_ID } from '../../../src/shared/providers/ids'
import type { SSHOptions } from '../../../src/main/ssh-options'
import { FakeHolder } from '../main/session-helper-fake-holder'
import { FakeSsh, result, type ExecCall, type FakeAnswer } from './fake-ssh'

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: null, helper: { version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
}
const FISH: RemoteMachineRecord = { ...MACHINE, shell: '/usr/bin/fish', shellIsSh: false }
const SID = remoteSessionId('tab-1')
const FOLDER = `/home/nick/.aicc/${MACHINE.did}/sessions/${SID}`
const BIN = `${FOLDER}/bin`
const CLI = { program: '/home/nick/.local/bin/claude', args: ['--model', 'opus'], env: { ONE: '1' } }
const TERMINAL = { COLORFGBG: '15;0' }

describe('remoteLaunchSpec: the stand-in\'s bin/ first on PATH, in both shapes', () => {
  it('a login shell of the sh family: the wrapper text puts the folder, its first argument after the program, first on PATH after the rc files', () => {
    const spec = remoteLaunchSpec(MACHINE, { ...CLI, clipStandIn: true }, TERMINAL, '~/work', 100, 30, FOLDER)
    expect(spec.argv).toEqual(['/bin/bash', '-il', '-c', CLIP_STAND_IN_WRAPPER, CLI.program, BIN, '--model', 'opus'])
    // The folder goes in front of PATH, an empty one gets no trailing colon
    // (the working folder), then the folder is shifted off and the program
    // starts with its own arguments, as the plain wrapper starts it.
    expect(CLIP_STAND_IN_WRAPPER).toBe('PATH="$1${PATH:+:$PATH}"; export PATH; shift; exec "$0" "$@"')
    expect(CLIP_STAND_IN_WRAPPER.endsWith(`; ${PLAIN_WRAPPER}`)).toBe(true)
    // No host path is in the text: the folder is an argument.
    expect(CLIP_STAND_IN_WRAPPER).not.toContain('/')
    // The PATH the rc files start from is the host account's, unchanged.
    expect(spec.env.PATH).toBe(MACHINE.path)
    expect(Object.keys(spec.env)).toEqual(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'TERM', 'COLORTERM', 'ONE', 'COLORFGBG'])
    expect(spec.cwd).toBe('/home/nick/work')
  })

  it('a login shell outside the sh family (no wrapper, no rc file): the folder goes in front of the host account\'s PATH', () => {
    const spec = remoteLaunchSpec(FISH, { ...CLI, clipStandIn: true }, TERMINAL, '~', 100, 30, FOLDER)
    expect(spec.argv).toEqual([CLI.program, '--model', 'opus'])
    expect(spec.env.PATH).toBe(`${BIN}:${MACHINE.path}`)
    expect(spec.env.PATH.split(':')[0]).toBe(BIN)
    expect(Object.keys(spec.env)).toEqual(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'TERM', 'COLORTERM', 'ONE', 'COLORFGBG'])
    // An empty PATH: the folder alone, never a trailing colon.
    expect(remoteLaunchSpec({ ...FISH, path: '' }, { ...CLI, clipStandIn: true }, TERMINAL, '~', 100, 30, FOLDER).env.PATH).toBe(BIN)
  })

  it('a launch that does not ask, or no session folder: the plain wrapper and the host account\'s PATH, as before', () => {
    for (const cli of [CLI, { ...CLI, clipStandIn: false }]) {
      for (const folder of [undefined, FOLDER]) {
        expect(remoteLaunchSpec(MACHINE, cli, TERMINAL, '~', 100, 30, folder).argv).toEqual(['/bin/bash', '-il', '-c', PLAIN_WRAPPER, CLI.program, '--model', 'opus'])
        expect(remoteLaunchSpec(FISH, cli, TERMINAL, '~', 100, 30, folder).env.PATH).toBe(MACHINE.path)
      }
    }
    expect(remoteLaunchSpec(MACHINE, { ...CLI, clipStandIn: true }, TERMINAL, '~', 100, 30).argv[3]).toBe(PLAIN_WRAPPER)
    expect(PLAIN_WRAPPER).toBe('exec "$0" "$@"')
  })

  it('a folder that cannot go on PATH or into the scripts gets no stand-in: a colon, a single quote, a backslash, a control character, or not absolute', () => {
    for (const home of ['/home/a:b', "/home/o'brien", '/home/back\\slash', '/home/new\nline', '/home/tab\there', '/home/del\u007f']) {
      const folder = `${home}/.aicc/${MACHINE.did}/sessions/${SID}`
      expect(clipStandInFolder({ clipStandIn: true }, folder), JSON.stringify(home)).toBeNull()
      const m = { ...MACHINE, home }
      expect(remoteLaunchSpec(m, { ...CLI, clipStandIn: true }, TERMINAL, '~', 100, 30, folder).argv[3]).toBe(PLAIN_WRAPPER)
      expect(remoteLaunchSpec({ ...FISH, home }, { ...CLI, clipStandIn: true }, TERMINAL, '~', 100, 30, folder).env.PATH).toBe(MACHINE.path)
    }
    expect(clipStandInFolder({ clipStandIn: true }, 'home/nick/x')).toBeNull()
    expect(clipStandInFolder({ clipStandIn: true }, '')).toBeNull()
    // A space or another plain character is fine, and a trailing slash goes.
    expect(clipStandInFolder({ clipStandIn: true }, '/home/my name/s/')).toBe('/home/my name/s/bin')
    expect(clipStandInFolder({ clipStandIn: true }, '/home/jé/s')).toBe('/home/jé/s/bin')
  })
})

describe('the Claude package asks for the stand-in for a session, never for a sign-in', () => {
  const o: RemoteLaunchOptions = { reconnect: false, cwd: '/home/nick', settings: null, tools: true }
  it('its session launch carries clipStandIn; remoteLaunchOf builds the spec with the session folder\'s bin/', () => {
    const helper = remoteHelperCommands(MACHINE, SID)
    expect(claudeRemoteLaunch.launch(o, MACHINE, helper, []).clipStandIn).toBe(true)
    expect(claudeRemoteLaunch.launch({ ...o, configDir: '/home/nick/.aicc/accounts/p1', signIn: {} }, MACHINE, helper, []).clipStandIn).not.toBe(true)
    const plan = remoteLaunchOf(claudeRemoteLaunch, MACHINE, { ssh: { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~', detachable: false } }, null, () => true, SID, 100, 30, true)
    expect(plan.first.clipStandIn).toBe(true)
    expect(plan.spec.argv.slice(0, 6)).toEqual(['/bin/bash', '-il', '-c', CLIP_STAND_IN_WRAPPER, MACHINE.claudePath, `${helper.folder}/bin`])
    expect(plan.spec.argv.slice(6, 8)).toEqual(['--settings', `${helper.folder}/settings.json`])
  })
})

describe('the files script writes the stand-in when asked, 0700, and fails nothing when it cannot', () => {
  const t = scriptText('files')
  it('takes the helper\'s folder and clip or none after its layout, and refuses any other word', () => {
    expect(STAND_IN_RE.test('clip') && STAND_IN_RE.test('none')).toBe(true)
    for (const w of ['', 'Clip', 'yes', 'clip ', 'none;']) expect(STAND_IN_RE.test(w), w).toBe(false)
    const n = '0'.repeat(32)
    const base = [n, MACHINE.did, 'f'.repeat(32), SID, 'settings.json:2', MACHINE.helper.folder]
    expect(scriptCommand('files', [...base, 'clip'])).toContain(` aicc ${base.join(' ')} clip`)
    expect(() => scriptCommand('files', [...base, 'maybe'])).toThrow(/clipboard stand-in/)
    expect(() => scriptCommand('files', base)).toThrow(/takes 7 values/)
    expect(() => scriptCommand('files', [n, MACHINE.did, 'f'.repeat(32), SID, 'settings.json:2', '../x', 'clip'])).toThrow(/helper folder/)
    expect(t.startsWith('N=$1; D=$2; I=$3; X=$4; L=$5; G=$6; C=$7; ')).toBe(true)
    expect(t).toContain('; case "$C" in clip|none) ;; *) no bad-stand-in;; esac; ')
  })

  it('writes each script to a staging name, sets it 0700 and moves it over its name, in a bin/ folder that is private; after the session\'s own files', () => {
    expect(t).toContain('; [ -e "$B" ] || [ -L "$B" ] || mkdir "$B" || { r clip cannot-make-bin; return 0; }; pv "$B" || { r clip bin-not-private; return 0; }; ')
    expect(t).toContain('W=$B/.$t.$N; ')
    expect(t).toContain('chmod 700 "$W" || { rm -f -- "$W"; r clip cannot-set-mode; return 0; }; mv -f -- "$W" "$B/$t" || ')
    // Only the staging file is ever set, and only to 0700: one chmod, of it.
    expect(t.match(/\bchmod\b/g)).toHaveLength(1)
    expect(t.match(/\bchmod [0-7]+ "[^"]*"/g)).toEqual(['chmod 700 "$W"'])
    expect(t.indexOf('rm -f -- "$T"; cb() {')).toBeGreaterThan(t.indexOf('mv -f -- "$F" "$Q/$m"'))
    expect(t.endsWith('; r clip ok; }; [ "$C" = clip ] && cb; r end ok')).toBe(true)
  })

  it('the two lines name the helper and the store by absolute path from $HOME, the session, the tool\'s name, and the real tool only from outside bin/', () => {
    expect(t).toContain('P=$A/helper/$G/aicc-helper; Y=$A/store; B=$Q/bin; ')
    expect(t).toContain('for t in xclip wl-paste; do R=$(command -v "$t" 2>/dev/null); case "$R" in /*) ;; *) R=;; esac; case "$R" in "$B"/*|*"$q"*|*"$b"*|*[[:cntrl:]]*) R=;; esac; j=; [ -n "$R" ] && j=" --real $q$R$q"; ')
    expect(t).toContain('{ echo "#!/bin/sh"; echo "exec $q$P$q clip --store $q$Y$q --session $q$X$q --as $t$j -- $w${v}@$w"; } > "$W"')
    // A helper, store or bin/ path holding a quote, a backslash or a control character: no script.
    expect(t).toContain('for x in "$P" "$Y" "$B"; do case "$x" in *"$q"*|*"$b"*|*[[:cntrl:]]*) r clip bad-path; return 0;; esac; done; ')
    // The characters the text cannot hold come from awk, checked by their bytes.
    expect(t).toContain('= 27225c ] || { r clip no-awk; return 0; }')
    // Every refusal of the stand-in returns; none ends the script (`no`).
    const cb = t.slice(t.indexOf('cb() {'), t.indexOf('r clip ok; }'))
    expect(cb).not.toMatch(/\bno [a-z]/)
  })
})

// ── the driver: the files exec, the launch, and what the script said ────────

let store = ''
let logs: string[] = []
let ssh: FakeSsh
const win = { webContents: { send: () => {} }, isDestroyed: () => false }
const SSH_TAB: SSHOptions = { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~/work', detachable: false }

function plugIn(machine: RemoteMachineRecord): void {
  ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
  setRemoteHelperDeps({
    platform: 'win32',
    settings: () => ({ remoteSessionsThroughHelper: true }),
    machines: { findByTarget: () => machine, installId: () => 'f'.repeat(32) } as unknown as RemoteMachines,
    runner: ssh,
    bundledSha256: () => SHA,
    systemPrefersDark: () => true,
    onOutput: () => {},
    log: (m) => logs.push(m),
  })
}

function answering(holder: FakeHolder, files: (c: ExecCall) => FakeAnswer): void {
  const record = (): HolderRecord => ({ ...holder.record(), endpoint: `/tmp/aicc-1000/${holder.sid}-0123456789abcdef.sock` })
  ssh.host = {
    answer: (c) => {
      const n = c.values[0]
      if (c.script === 'reads') return { stdout: result(n, {}) }
      if (c.script === 'field') return { stdout: `AICC-HASH ${n} ok ${SHA}\n` }
      if (c.script === 'hold') return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify(record())}\n` }
      if (c.script === 'files') return files(c)
      if (c.script === 'unsession') return { stdout: result(n, {}) }
      return { code: 1 }
    },
    bridge: () => holder.connect(),
  }
}

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function claude(asks = true): SessionProvider {
  const remoteLaunch = asks ? claudeRemoteLaunch : { ...claudeRemoteLaunch, launch: (...a: Parameters<typeof claudeRemoteLaunch.launch>) => ({ ...claudeRemoteLaunch.launch(...a), clipStandIn: false }) }
  return {
    id: DEFAULT_PROVIDER_ID, displayName: 'The default provider', resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
    detectUiRunning: () => false, exitKeys: [], ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
    resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {}, remoteLaunch,
  } as unknown as SessionProvider
}

/** Starts tab `id` on `machine` with the files exec answered by `files`, and waits for its launch. */
async function start(id: string, machine: RemoteMachineRecord, files: (c: ExecCall) => FakeAnswer, asks = true) {
  registerProvider(claude(asks))
  plugIn(machine)
  const holder = new FakeHolder(remoteSessionId(id), id, store)
  answering(holder, files)
  const pty = remoteHelperPty(win, id, { ssh: SSH_TAB }, 100, 30) as unknown as RemoteHelperPty
  expect(pty).not.toBeNull()
  await until('the launch', () => holder.launch !== null && holder.attached !== null)
  const call = ssh.calls.find((c) => c.script === 'files') as ExecCall
  return { pty, holder, call, folder: remoteHelperCommands(machine, remoteSessionId(id)).folder }
}

describe('a helper tab\'s start: the files exec carries the stand-in, and the CLI starts with bin/ first on PATH', () => {
  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-clip-'))
    logs = []
  })
  afterEach(() => {
    setRemoteHelperDeps(null)
    fs.rmSync(store, { recursive: true, force: true })
  })

  it('asked and written: the files exec gets the helper\'s folder and clip, the launch\'s wrapper puts bin/ first, and the tab knows its image paste is served', async () => {
    const { pty, holder, call, folder } = await start('clip-ok', MACHINE, (c) => ({ stdout: result(c.values[0], { clip: 'ok' }) }))
    expect(call.values.slice(3)).toEqual([remoteSessionId('clip-ok'), call.values[4], MACHINE.helper.folder, 'clip'])
    expect(call.values[4]).toMatch(/^settings\.json:\d+,mcp\.json:\d+$|^settings\.json:\d+$/)
    const argv = (holder.launch as { argv: string[] }).argv
    expect(argv.slice(0, 6)).toEqual(['/bin/bash', '-il', '-c', CLIP_STAND_IN_WRAPPER, MACHINE.claudePath, `${folder}/bin`])
    expect((holder.launch as { env: Record<string, string> }).env.PATH).toBe(MACHINE.path)
    expect(pty.clipStandInReady).toBe(true)
    expect(logs.filter((l) => l.includes('clipboard stand-in'))).toEqual([])
    pty.kill()
  })

  it('a login shell outside the sh family: no wrapper, and bin/ in front of the PATH the CLI starts with', async () => {
    const { pty, holder, folder } = await start('clip-fish', FISH, (c) => ({ stdout: result(c.values[0], { clip: 'ok' }) }))
    const launch = holder.launch as { argv: string[]; env: Record<string, string> }
    expect(launch.argv[0]).toBe(MACHINE.claudePath)
    expect(launch.argv).not.toContain(CLIP_STAND_IN_WRAPPER)
    expect(launch.env.PATH).toBe(`${folder}/bin:${MACHINE.path}`)
    pty.kill()
  })

  it('a stand-in the host could not write fails nothing: the CLI starts, the tab knows it has none, and the log says why once', async () => {
    const { pty, holder } = await start('clip-bad', MACHINE, (c) => ({ stdout: result(c.values[0], { clip: 'bad-path' }) }))
    expect(holder.launch).not.toBeNull()
    expect(pty.clipStandInReady).toBe(false)
    expect(logs.filter((l) => l.includes('clipboard stand-in'))).toEqual([`[remote-helper] ${remoteSessionId('clip-bad')}: the clipboard stand-in was not written on rocky.lan (bad-path); image paste in this tab is not available`])
    pty.kill()
  })

  it('a host that says nothing of it, or something that is not a word: not written, said as no answer', async () => {
    const { pty } = await start('clip-silent', MACHINE, (c) => ({ stdout: `AICC-RESULT ${c.values[0]} clip Bad Word!\n${result(c.values[0], {})}` }))
    expect(pty.clipStandInReady).toBe(false)
    expect(logs.filter((l) => l.includes('clipboard stand-in'))).toEqual([`[remote-helper] ${remoteSessionId('clip-silent')}: the clipboard stand-in was not written on rocky.lan (no answer); image paste in this tab is not available`])
    pty.kill()
  })

  it('a launch that does not ask: the files exec gets none, the plain wrapper, and nothing logged of a stand-in', async () => {
    const { pty, holder, call } = await start('clip-none', MACHINE, (c) => ({ stdout: result(c.values[0], {}) }), false)
    expect(call.values.slice(5)).toEqual([MACHINE.helper.folder, 'none'])
    expect((holder.launch as { argv: string[] }).argv.slice(0, 5)).toEqual(['/bin/bash', '-il', '-c', PLAIN_WRAPPER, MACHINE.claudePath])
    expect(pty.clipStandInReady).toBe(false)
    expect(logs.filter((l) => l.includes('clipboard stand-in'))).toEqual([])
    pty.kill()
  })
})
