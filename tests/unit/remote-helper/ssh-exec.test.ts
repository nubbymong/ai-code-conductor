/**
 * Remote step 1's ssh commands (plan 2.1.3-beta.17, section A2;
 * docs/remote/helper-protocol.md sections 2, 4 and 6): the exec argv carries
 * section 2's fixed options a key-only host needs, a versioned one only from
 * the ssh version that knows it, and nothing after `--` but the target and
 * the command; every value is checked before ssh starts; the fixed scripts
 * hold no single quote, backslash or line end; ssh sees only allow-listed
 * variables; and what a host's rc files print before the marked lines is
 * dropped, up to 64 KiB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'

// No process starts in this file: the real runner's `ssh -V` (execFile) and
// spawn are fakes, and a test that sets no answer gets an error from them.
type ExecFileCb = (e: Error | null, stdout: string, stderr: string) => void
const cp = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }))
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  return { ...real, execFile: cp.execFile, spawn: cp.spawn, default: { ...real, execFile: cp.execFile, spawn: cp.spawn } }
})
beforeEach(() => {
  cp.execFile.mockReset().mockImplementation((file: string, _a: unknown, _o: unknown, cb: ExecFileCb) => {
    setImmediate(() => cb(new Error(`no process in this test: ${file}`), '', ''))
    return {}
  })
  cp.spawn.mockReset().mockImplementation((file: string) => { throw new Error(`no process in this test: ${file}`) })
})
import {
  ExecStream, PREAMBLE_MAX, execArgv, markedLines, nodeSshRunner, openScriptStream, parseSshVersion, readHashLine, readScriptResult, runScript, sshEnv, sshFailure, targetProblem,
  type SshRunner,
} from '../../../src/main/remote-helper/ssh-exec'
import { scriptCommand, scriptText, holderLabel, type ScriptName } from '../../../src/main/remote-helper/scripts'
import { FakeSsh } from './fake-ssh'

const T = { host: 'rocky.lan', port: 2222, user: 'nick' }
const N = '0'.repeat(32)
const D = '1'.repeat(32)
const I = '2'.repeat(32)
const SHA = 'a'.repeat(64)
const FOLDER = `0.1.0-${SHA.slice(0, 12)}`
const SID = `rm${'3'.repeat(30)}`
const NOT_STARTED = /ssh could not be started on this computer/

describe('ssh exec: the argv', () => {
  it('carries the fixed options of a key-only host, then -p, -l, -- target command, in that order', () => {
    const a = execArgv(T, { version: [9, 6] }, 'CMD')
    expect(a.slice(0, 5)).toEqual(['-a', '-x', '-T', '-e', 'none'])
    for (const o of ['BatchMode=yes', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'ControlMaster=no', 'ControlPath=none', 'RemoteCommand=none', 'StrictHostKeyChecking=yes', 'SetEnv=AICC_NONE=1', 'StdinNull=no', 'SessionType=default', 'ForkAfterAuthentication=no', 'EnableEscapeCommandline=no']) {
      const at = a.indexOf(o)
      expect(at, o).toBeGreaterThan(0)
      expect(a[at - 1]).toBe('-o')
    }
    expect(a.slice(-7)).toEqual(['-p', '2222', '-l', 'nick', '--', 'rocky.lan', 'CMD'])
    // Nothing forwards, and no option comes after `--`.
    expect(a).not.toContain('-R')
    expect(a).not.toContain('-L')
    expect(a).not.toContain('-A')
  })

  it('leaves out an option the local ssh is too old to know', () => {
    const old = execArgv(T, { version: [8, 1] }, 'CMD')
    expect(old).toContain('SetEnv=AICC_NONE=1')
    expect(old).not.toContain('StdinNull=no')
    expect(old).not.toContain('EnableEscapeCommandline=no')
    const unknown = execArgv(T, { version: null }, 'CMD')
    expect(unknown).not.toContain('SetEnv=AICC_NONE=1')
    expect(unknown).toContain('BatchMode=yes')
  })

  it('accepts a host key it does not know yet only on a machine\'s first connection', () => {
    expect(execArgv(T, { version: [9, 6], firstConnection: true }, 'C')).toContain('StrictHostKeyChecking=accept-new')
    expect(execArgv(T, { version: [9, 6] }, 'C')).toContain('StrictHostKeyChecking=yes')
  })

  it('reads ssh -V on Windows and elsewhere', () => {
    expect(parseSshVersion('OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2')).toEqual([9, 5])
    expect(parseSshVersion('OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024')).toEqual([9, 6])
    expect(parseSshVersion('nonsense')).toBeNull()
  })
})

describe('ssh exec: values are checked before ssh starts', () => {
  it('a bad host, user or port is refused, and no ssh starts', async () => {
    for (const bad of [{ ...T, host: '-oProxyCommand=x' }, { ...T, host: 'a b' }, { ...T, host: 'h;rm' }, { ...T, user: 'a b' }, { ...T, user: '-l' }, { ...T, port: 0 }, { ...T, port: 70000 }]) {
      expect(targetProblem(bad), JSON.stringify(bad)).not.toBeNull()
      expect(() => execArgv(bad, { version: [9, 6] }, 'C')).toThrow()
      const ssh = new FakeSsh({ answer: () => ({}) })
      await expect(runScript(ssh, bad, 'probe', [N, D, I])).rejects.toThrow()
      expect(ssh.calls).toHaveLength(0)
    }
  })

  it('a bad device id, nonce, install id, session id, folder or hash is refused, and no ssh starts', async () => {
    const cases: Array<[ScriptName, string[]]> = [
      ['probe', ['x'.repeat(32), D, I]],
      ['probe', [N, '../../etc', I]],
      ['probe', [N, '', I]],
      ['remove', [N, 'A'.repeat(32), I]],
      ['probe', [N, D, 'z'.repeat(32)]],
      ['hold', [N, D, I, FOLDER, SHA, 'bad sid;x', 'tab']],
      ['hold', [N, D, I, '../x', SHA, SID, 'tab']],
      ['hold', [N, D, I, FOLDER, 'b'.repeat(63), SID, 'tab']],
      ['hold', [N, D, I, FOLDER, SHA, SID, '$(id)']],
      ['install', [N, D, I, '1e9']],
      ['probe', [N, D]],
    ]
    for (const [script, values] of cases) {
      expect(() => scriptCommand(script, values), `${script} ${values.join(' ')}`).toThrow()
      const ssh = new FakeSsh({ answer: () => ({}) })
      await expect(runScript(ssh, T, script, values)).rejects.toThrow()
      expect(ssh.calls).toHaveLength(0)
    }
  })

  it('a holder label is the app session id when it can be one, else a fixed word', () => {
    expect(holderLabel('tab-123_x')).toBe('tab-123_x')
    expect(holderLabel('-x')).toBe('tab')
    expect(holderLabel('a b')).toBe('tab')
  })
})

describe('the fixed scripts', () => {
  const names: ScriptName[] = ['probe', 'install', 'commit', 'discard', 'remove', 'version', 'selftest', 'list', 'hold', 'bridge']

  it('hold no single quote, backslash or line end, and run as /bin/sh -c with values after them', () => {
    for (const n of names) {
      expect(scriptText(n), n).not.toMatch(/['\\\r\n]/)
    }
    const cmd = scriptCommand('bridge', [N, D, I, FOLDER, SHA, SID])
    expect(cmd).toBe(`/bin/sh -c '${scriptText('bridge')}' aicc ${N} ${D} ${I} ${FOLDER} ${SHA} ${SID}`)
  })

  it('every script checks the device id, the home folder and (but probe and install) the owner marker before it acts', () => {
    for (const n of names) {
      const t = scriptText(n)
      expect(t, n).toContain('no bad-device-id')
      expect(t, n).toContain('no home-open-to-others')
      if (n !== 'probe' && n !== 'install') expect(t, n).toContain('mk || no not-this-install')
    }
  })

  it('the launcher scripts hash the helper file and run it only on its expected hash', () => {
    for (const n of ['version', 'selftest', 'list', 'hold', 'bridge'] as ScriptName[]) {
      const t = scriptText(n)
      expect(t.indexOf('echo "AICC-HASH $N ok $x"'), n).toBeLessThan(t.indexOf('exec "$P"'))
      expect(t, n).toContain('[ "$x" = "$H" ] || { echo "AICC-HASH $N mismatch $x"; exit 97; }')
    }
  })

  it('Remove deletes only ~/.aicc/<did>, after the marker check', () => {
    const t = scriptText('remove')
    const del = t.indexOf('rm -rf -- "${HOME:?}/.aicc/${D:?}"')
    expect(del).toBeGreaterThan(t.indexOf('mk || no not-this-install'))
    expect(del).toBeGreaterThan(t.indexOf('[ ${#D} -eq 32 ] || no bad-device-id'))
    expect(t.match(/rm -rf/g)).toHaveLength(1)
  })

  // vm:A2 (WINDOWS_1 to Ubuntu): Add's self-test made /tmp/aicc-<uid>, the
  // holders' run folder (helper/src/transport/unix.rs run_dir), and Remove left
  // it behind, empty. Remove now takes it away only when it is empty: rmdir,
  // never a recursive delete, since another session of the same account may
  // hold a socket there.
  it('Remove takes the holders\' run folder /tmp/aicc-<uid> away only when it is the user\'s, private and empty, after the device folder', () => {
    const cmd = scriptCommand('remove', [N, D, I])
    const rmdirRun = 'pv "/tmp/aicc-$u" && rmdir -- "/tmp/aicc-$u" 2>/dev/null'
    expect(cmd).toBe(`/bin/sh -c '${scriptText('remove')}' aicc ${N} ${D} ${I}`)
    expect(cmd).toContain(rmdirRun)
    expect(cmd.indexOf(rmdirRun)).toBeGreaterThan(cmd.indexOf('u=$(id -u)'))
    expect(cmd.indexOf(rmdirRun)).toBeGreaterThan(cmd.indexOf('rm -rf -- "${HOME:?}/.aicc/${D:?}" || no cannot-remove'))
    // Nothing but that rmdir touches the run folder: no rm of any kind.
    expect(cmd).not.toMatch(/rm (-[a-z]+ )*(--)? *"?\/tmp\/aicc/)
    expect(cmd.match(/\/tmp\/aicc-/g)).toHaveLength(2)
    // No other script names the run folder.
    for (const n of names.filter((x) => x !== 'remove')) expect(scriptText(n), n).not.toContain('/tmp/aicc')
  })
})

describe('ssh exec: what a host prints', () => {
  it('ssh sees only allow-listed variables, never a token or key', () => {
    const env = sshEnv({ PATH: 'p', USERPROFILE: 'u', SystemRoot: 's', ANTHROPIC_API_KEY: 'k', GH_TOKEN: 't', CCC_SESSION_WORKTREE: 'w', SSH_AUTH_SOCK: 'a' })
    expect(env).toEqual({ PATH: 'p', USERPROFILE: 'u', SystemRoot: 's', SSH_AUTH_SOCK: 'a' })
  })

  it('rc file text before the marked lines is dropped up to 64 KiB, and past that nothing counts', () => {
    const lines = `AICC-RESULT ${N} os Linux\nAICC-RESULT ${N} end ok\n`
    const small = `Welcome to Ubuntu\n${'x'.repeat(1000)}\n${lines}`
    expect(readScriptResult(small, N)?.values.get('os')).toBe('Linux')
    const big = `${'x'.repeat(PREAMBLE_MAX + 10)}\n${lines}`
    expect(markedLines(big, 'AICC-RESULT', N)).toEqual([])
    expect(readScriptResult(big, N)).toBeNull()
    // Another exec's nonce never counts.
    expect(readScriptResult(lines.replaceAll(N, '9'.repeat(32)), N)).toBeNull()
  })

  it('reads a refusal and the launcher\'s first hash line', () => {
    expect(readScriptResult(`AICC-RESULT ${N} end refused not-this-install\n`, N)).toMatchObject({ ok: false, refused: 'not-this-install' })
    expect(readHashLine(`hi\nAICC-HASH ${N} ok ${SHA}\nAICC-HASH ${N} mismatch x\n`, N)).toEqual({ state: 'ok', hex: SHA })
  })

  it('names a sign-in or host key failure in plain words', () => {
    expect(sshFailure({ code: 255, stderr: 'Permission denied (publickey).', timedOut: false })).toMatch(/key sign-in/)
    expect(sshFailure({ code: 255, stderr: 'Host key verification failed.', timedOut: false })).toMatch(/host key/)
    expect(sshFailure({ code: 3, stderr: '', timedOut: false })).toBeNull()
  })
})

class Child extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  exitCode: number | null = null
  signalCode: string | null = null
  kill() { this.exitCode = 1; this.emit('close', 1); return true }
}

describe('ssh exec: the bridge stream', () => {
  it('drops what comes before the launcher\'s ok line, then passes the holder\'s bytes as they are', async () => {
    const child = new Child()
    const seen: string[] = []
    const s = new ExecStream(child as unknown as ChildProcess, N, (state) => seen.push(state))
    let got = ''
    s.on('data', (b: Buffer) => { got += b.toString() })
    child.stdout.write('motd line\r\nmore rc\n')
    child.stdout.write(`AICC-HASH ${N} ok ${SHA}\nAICC-HELLO abc {}\n\x00\x00`)
    await new Promise((r) => setImmediate(r))
    expect(seen).toEqual(['ok'])
    expect(got).toBe('AICC-HELLO abc {}\n\x00\x00')
    let wrote = ''
    child.stdin.on('data', (b: Buffer) => { wrote += b.toString() })
    s.write(Buffer.from('frame'))
    await new Promise((r) => setImmediate(r))
    expect(wrote).toBe('frame')
  })

  it('refuses more than 64 KiB before the ok line, and a hash that is not the expected one', async () => {
    const big = new Child()
    const s1 = new ExecStream(big as unknown as ChildProcess, N, () => {})
    const e1 = new Promise<Error>((r) => s1.on('error', r))
    big.stdout.write(`${'x'.repeat(PREAMBLE_MAX + 2)}`)
    expect((await e1).message).toMatch(/64 KiB/)
    const bad = new Child()
    const s2 = new ExecStream(bad as unknown as ChildProcess, N, () => {})
    const e2 = new Promise<Error>((r) => s2.on('error', r))
    bad.stdout.write(`AICC-HASH ${N} mismatch ${'b'.repeat(64)}\n`)
    expect((await e2).message).toMatch(/hash check \(mismatch\)/)
  })
})

// Found by the beta.17 final-head review: sshProgram() throws when no ssh is
// found, and the runner kept that failure as its version for the rest of the
// run, so every later exec failed before its own handling, even once ssh was
// installed. Nothing starts here: the stand-in throws before any spawn.
describe('ssh exec: no ssh found', () => {
  it('reads as an unknown version, an exec answers its own failure, and the next call looks for ssh again', async () => {
    let looks = 0
    const runner = nodeSshRunner(() => { looks++; throw new Error('no ssh program was found') }, () => ({}))
    await expect(runner.version()).resolves.toBeNull()
    const r = await runScript(runner, T, 'probe', [N, D, I])
    expect(r).toMatchObject({ code: null, stdout: '', timedOut: false, notStarted: true })
    expect(r.stderr).toContain('no ssh program was found')
    expect(sshFailure(r)).toMatch(NOT_STARTED)
    const before = looks
    await expect(runner.version()).resolves.toBeNull()
    expect(looks).toBe(before + 1)
  })

  // An ssh found by path that then cannot be spawned (gone, or not runnable)
  // fails with an error before it has a process id. One that started and then
  // errs is not "not started".
  const erring = (child: Child): SshRunner => ({
    sshPath: () => 'ssh',
    version: async () => null,
    env: () => ({}),
    spawn: (() => {
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })))
      return child as unknown as ChildProcess
    }) as SshRunner['spawn'],
  })

  it('an ssh that errs before it has a process id is not started; one that errs after it started is not that', async () => {
    const lost = await runScript(erring(new Child()), T, 'probe', [N, D, I])
    expect(lost).toMatchObject({ code: null, notStarted: true })
    expect(sshFailure(lost)).toMatch(NOT_STARTED)
    const ran = await runScript(erring(Object.assign(new Child(), { pid: 4242 })), T, 'probe', [N, D, I])
    expect(ran.notStarted).toBeUndefined()
    expect(sshFailure(ran)).toBeNull()
  })

  it('the bridge exec (a tab\'s reconnect) names an ssh that cannot be found or spawned, and starts nothing', async () => {
    const values = [N, D, I, FOLDER, SHA, SID]
    const none = new FakeSsh({ answer: () => ({}) })
    none.sshPath = () => { throw new Error('no ssh program was found') }
    await expect(openScriptStream(none, T, 'bridge', values, N, 5000)).rejects.toThrow(NOT_STARTED)
    expect(none.calls).toHaveLength(0)
    await expect(openScriptStream(erring(new Child()), T, 'bridge', values, N, 5000)).rejects.toThrow(NOT_STARTED)
  })

  it('only the app sets it: host text that reads like it is a plain failure', () => {
    expect(sshFailure({ code: null, stderr: 'ssh could not be started on this computer', timedOut: false })).toBeNull()
    expect(sshFailure({ code: null, stderr: '', timedOut: false, notStarted: true })).toMatch(NOT_STARTED)
  })
})

// Found by the beta.17 final-head review: a version read is kept for the run
// (one `ssh -V`), and only a version is: an `ssh -V` that failed after it
// started (a kept path gone, its 10 s time out) gave null, and that null was
// kept for the rest of the run, so every exec left out the versioned options.
describe('ssh exec: the local ssh version', () => {
  const answers = (...outs: Array<{ err?: Error; stderr?: string }>) => {
    for (const o of outs) {
      cp.execFile.mockImplementationOnce((_f: string, _a: unknown, _o: unknown, cb: ExecFileCb) => {
        setImmediate(() => cb(o.err ?? null, '', o.stderr ?? ''))
        return {}
      })
    }
  }

  it('a version read is kept for the run: one ssh -V, however many ask, at once or later', async () => {
    answers({ stderr: 'OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2\r\n' })
    const runner = nodeSshRunner(() => 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', () => ({}))
    expect(await Promise.all([runner.version(), runner.version()])).toEqual([[9, 5], [9, 5]])
    expect(await runner.version()).toEqual([9, 5])
    expect(await runner.version()).toEqual([9, 5])
    expect(cp.execFile).toHaveBeenCalledTimes(1)
    expect(cp.execFile.mock.calls[0].slice(0, 2)).toEqual(['C:\\Windows\\System32\\OpenSSH\\ssh.exe', ['-V']])
  })

  it('an ssh -V that fails after it started is not kept: the next call reads it again, until a version is read', async () => {
    answers(
      { err: Object.assign(new Error('spawn /usr/bin/ssh ENOENT'), { code: 'ENOENT' }) },
      { err: Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }) },
      { stderr: 'OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024\n' },
    )
    const runner = nodeSshRunner(() => '/usr/bin/ssh', () => ({}))
    expect(await runner.version()).toBeNull()
    expect(await runner.version()).toBeNull()
    expect(await runner.version()).toEqual([9, 6])
    expect(await runner.version()).toEqual([9, 6])
    expect(cp.execFile).toHaveBeenCalledTimes(3)
  })
})
