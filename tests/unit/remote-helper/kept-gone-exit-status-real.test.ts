// HOST QUARANTINE: starts real processes (Node in ssh's place). [CI] [VM] only -- never run on the owner's machine.
/**
 * A bridge that finds no holder, over a real process in ssh's place (plan
 * 2.1.3-beta.19 section 1.2; aicc_planning#437; the Rocky host line's
 * in-feature finding 1). The measurement behind the fix: ssh closes its
 * standard output when the host's side ends and exits with the host's status
 * a moment later; the bridge stream (ssh-exec.ts ExecStream) ended itself on
 * that output's end and ended ssh with it, so the exit status read as a
 * kill's (code null, SIGTERM) and the bridge's 3 (no holder) was lost: the
 * driver's try failed with "the holder closed the connection before its
 * hello", the very line the Rocky host logged 8 times over 96 s.
 *
 * - the stream that ended with the host's side keeps ssh's exit status;
 * - a re-attach try that reaches the machine and finds no holder is final,
 *   and the driver marks the session gone.
 *
 * kept-gone-exit-status.test.ts holds the tab's side on the fake ssh, which
 * gives the same order (fake-ssh.ts finishAfterOutput).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openScriptStream, type SshRunner } from '../../../src/main/remote-helper/ssh-exec'
import { RemoteDriver, remoteSessionId } from '../../../src/main/remote-helper/session'
import { readRecord, type HolderRecord } from '../../../src/main/session-helper/protocol'
import type { RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
import { FakeHolder } from '../main/session-helper-fake-holder'
import { parseCommand } from './fake-ssh'

const SHA = 'a'.repeat(64)
const INSTALL = 'f'.repeat(32)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: null, helper: { path: 'linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
}
const T = { host: MACHINE.host, port: 22, user: MACHINE.user }

let work = ''
let store = ''
let logs: string[] = []
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-kept-gone-real-'))
  store = path.join(work, 'store')
  logs = []
})
afterEach(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true })
})

/**
 * A runner whose every exec is a real Node process in ssh's place, as a bridge
 * that finds no holder runs over ssh: it prints the launcher's hash line,
 * closes that output (the host's side has ended), and exits `code` `gapMs`
 * later (ssh's exit once the host's exit status reached it). Its output is an
 * extra pipe (fd 3), handed on as the process's standard output: a Node
 * process on Windows cannot close its own fd 1 before it exits (measured: the
 * end came only with the exit), and fd 3 it can. Its variables are a folder
 * of the test's own.
 */
function realBridge(gapMs: number, code = 3): SshRunner & { spawned: number } {
  const own = { HOME: work, USERPROFILE: work, APPDATA: work, LOCALAPPDATA: work, CLAUDE_CONFIG_DIR: work, CODEX_HOME: work }
  const r = {
    spawned: 0,
    sshPath: () => 'ssh',
    version: async () => [9, 5] as [number, number],
    env: () => ({}),
    spawn: ((_file: string, args: readonly string[]) => {
      r.spawned++
      const { values } = parseCommand(args[args.length - 1])
      const script = `const fs = require('fs'); fs.writeSync(3, 'AICC-HASH ' + process.argv[1] + ' ok ' + process.argv[2] + String.fromCharCode(10)); fs.closeSync(3); setTimeout(() => process.exit(${code}), ${gapMs})`
      const child = spawn(process.execPath, ['-e', script, values[0], values[4]], {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...own },
      })
      Object.defineProperty(child, 'stdout', { value: child.stdio[3], configurable: true })
      return child
    }) as SshRunner['spawn'],
  }
  return r
}

/** A record as the helper prints it on Linux, for a holder that is gone. */
function goneRecord(id: string): HolderRecord {
  const h = new FakeHolder(remoteSessionId(id), id, store)
  const rec = readRecord({ ...h.record(), endpoint: `/tmp/aicc-1000/${h.sid}-0123456789abcdef.sock`, away: null, lifetime: 'until-ended' }, 'unix')
  if (!rec) throw new Error('the record does not read')
  return rec
}

describe('a bridge that finds no holder, over a real process in ssh\'s place', () => {
  it('the stream that ended with the host\'s side keeps ssh\'s exit status after it (3), not a kill\'s', async () => {
    const runner = realBridge(300)
    const N = '0'.repeat(32)
    const opened = await openScriptStream(runner, T, 'bridge', [N, MACHINE.did, INSTALL, MACHINE.helper.folder, SHA, remoteSessionId('x')], N, 10_000)
    // Read to its end, as the hello reader does: the stream closes by itself.
    opened.stream.on('data', () => { /* nothing after the hash line */ })
    await new Promise<void>((r) => opened.stream.once('close', () => r()))
    const r = await opened.result
    expect({ code: r.code, signal: r.signal ?? null }).toEqual({ code: 3, signal: null })
  })

  it('a re-attach try that reaches the machine and finds no holder is final: the driver marks the session gone', async () => {
    const id = 'kept-gone-real'
    const runner = realBridge(300)
    const driver = new RemoteDriver({ appPtyId: id, machine: MACHINE, installId: INSTALL, runner, spec: { argv: ['x'], cwd: '/', env: {}, cols: 80, rows: 24 }, log: (m) => logs.push(m), kind: 'until-ended', sleep: async () => {} })
    await expect(driver.connect(goneRecord(id))).rejects.toThrow(`no holder runs for this tab on ${MACHINE.host} any more`)
    expect(driver.keptGone).toBe(true)
    expect(runner.spawned).toBe(1)
  })
})
