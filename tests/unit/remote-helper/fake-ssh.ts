/**
 * A fake ssh for remote step 1's unit tests (plan 2.1.3-beta.17, section A2):
 * an SshRunner whose spawn answers each fixed script (src/main/remote-helper/
 * scripts.ts) as a Linux host would, with no process started. Each exec is
 * recorded (its script, values, argv and what it got on standard input), so a
 * test reads which execs ran and in what order.
 *
 * The bridge exec (A1's `bridge` mode) is answered by `bridge`, which a test
 * sets to hand back the holder's end of a connection (a FakeHolder's), after
 * the launcher's hash line, as the real bridge would. A bridge that finds no
 * holder ends as ssh does: its output closes first, its exit status after.
 */
import { EventEmitter } from 'events'
import { PassThrough, type Duplex } from 'stream'
import type { ChildProcess } from 'child_process'
import { scriptText, type ScriptName } from '../../../src/main/remote-helper/scripts'
import type { SshRunner } from '../../../src/main/remote-helper/ssh-exec'

export interface ExecCall {
  script: ScriptName
  values: string[]
  args: string[]
  stdin: Buffer
}

/** What one exec prints and how it exits. */
export interface FakeAnswer {
  stdout?: string
  stderr?: string
  code?: number
}

const NAMES: ScriptName[] = ['probe', 'install', 'commit', 'discard', 'remove', 'version', 'selftest', 'list', 'hold', 'bridge', 'reads', 'files', 'unsession', 'sweep', 'sessions', 'field']

/** Which script and values a command line runs. */
export function parseCommand(command: string): { script: ScriptName; values: string[] } {
  const m = /^\/bin\/sh -c '([^']*)' aicc (.*)$/.exec(command)
  if (!m) throw new Error(`not a fixed-script command: ${command.slice(0, 80)}`)
  const script = NAMES.find((n) => scriptText(n) === m[1])
  if (!script) throw new Error('an unknown script text')
  return { script, values: m[2].split(' ') }
}

export class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid: number
  exitCode: number | null = null
  signalCode: string | null = null
  killed = false
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  kill(): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.killed = true
    this.finish(null, 'SIGTERM')
    return true
  }
  /** As ssh ends once the host's side has ended: its standard output closes
   *  first, and its exit status (the host's) comes a moment later
   *  (2.1.3-beta.19 section 1.2, the Rocky host line's finding 1). Ended on
   *  this computer meanwhile (kill), it keeps the kill's. */
  finishAfterOutput(code: number, gapMs = 20): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.stdout.end()
    this.stderr.end()
    setTimeout(() => this.finish(code), gapMs)
  }
  finish(code: number | null, signal: string | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.emit('close', code, signal))
  }
}

export interface FakeHost {
  /** Answers a one-shot exec; called once its standard input has ended. */
  answer: (call: ExecCall) => FakeAnswer
  /** Answers a bridge exec: the holder's end of the connection, or null for
   *  none, when the bridge exits `bridgeExit` (3, no holder, unless set). */
  bridge?: (call: ExecCall, child: FakeChild) => Duplex | null
  bridgeExit?: number
  /** A bridge exec whose ssh ends on this computer before the launcher's
   *  hash line (a cut link: ssh killed), with this exit code or signal;
   *  undefined: the bridge runs as `bridge` says. */
  bridgeCut?: (call: ExecCall) => { code: number | null; signal?: string } | undefined
}

export class FakeSsh implements SshRunner {
  readonly calls: ExecCall[] = []
  readonly children: FakeChild[] = []
  private nextPid = 40000
  version: () => Promise<[number, number] | null> = async () => [9, 5]
  constructor(public host: FakeHost) {}
  sshPath(): string { return 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' }
  env(): Record<string, string> { return { PATH: 'C:\\Windows' } }
  scripts(): ScriptName[] { return this.calls.map((c) => c.script) }

  spawn = ((_file: string, args: readonly string[]): ChildProcess => {
    const child = new FakeChild(this.nextPid++)
    this.children.push(child)
    const { script, values } = parseCommand(args[args.length - 1])
    const call: ExecCall = { script, values, args: [...args], stdin: Buffer.alloc(0) }
    this.calls.push(call)
    if (script === 'bridge') {
      const nonce = values[0]
      setImmediate(() => {
        const cut = this.host.bridgeCut?.(call)
        if (cut) { child.finish(cut.code, cut.signal ?? null); return }
        const end = this.host.bridge?.(call, child) ?? null
        child.stdout.write(`some rc file text\nAICC-HASH ${nonce} ok ${values[4]}\n`)
        if (!end) { child.finishAfterOutput(this.host.bridgeExit ?? 3); return }
        // The link going down cuts the holder's connection; that is not news.
        end.on('error', () => { /* the link went down */ })
        end.on('data', (b: Buffer) => child.stdout.write(b))
        end.on('end', () => child.finish(0))
        end.on('close', () => child.finish(0))
        // A dead ssh carries nothing more to the host.
        child.stdin.on('data', (b: Buffer) => { if (child.exitCode === null && child.signalCode === null) end.write(b) })
        child.stdin.on('end', () => end.end())
        // ssh gone: the bridge's socket closes, so the holder sees its connection end.
        child.on('close', () => end.end())
      })
      return child as unknown as ChildProcess
    }
    const chunks: Buffer[] = []
    child.stdin.on('data', (b: Buffer) => chunks.push(b))
    child.stdin.on('finish', () => {
      call.stdin = Buffer.concat(chunks)
      setImmediate(() => {
        const a = this.host.answer(call)
        if (a.stdout) child.stdout.write(a.stdout)
        if (a.stderr) child.stderr.write(a.stderr)
        child.finish(a.code ?? 0)
      })
    })
    return child as unknown as ChildProcess
  }) as SshRunner['spawn']
}

/** A result line block for a script answer. */
export function result(nonce: string, lines: Record<string, string>, end = 'ok'): string {
  return `${Object.entries(lines).map(([k, v]) => `AICC-RESULT ${nonce} ${k} ${v}`).join('\n')}${Object.keys(lines).length ? '\n' : ''}AICC-RESULT ${nonce} end ${end}\n`
}

/**
 * One machine's device folder (`~/.aicc/<did>`), as the paths under it (a
 * folder with nothing in it is `<path>/`), for the cases that read what a
 * Check or a Remove leaves there (2.1.3-beta.19: the earlier builds' helper
 * folders). `answer` changes it as the install, commit, sweep and remove
 * scripts do and answers as they print; any other script gets null. The
 * sweep removes the earlier builds' folders only when its own text carries
 * that step (scripts.ts SWEEP_EARLIER_HELPERS, its `r helpers` line), by the
 * rule that text states. The real scripts' run on sh is
 * tests/live/remote-helper-device.live.ts's.
 */
export class DeviceTree {
  readonly paths: Set<string>
  constructor(paths: string[]) { this.paths = new Set(paths) }
  /** The names directly in `dir` (`''` for the device folder itself). */
  names(dir: string): string[] {
    const at = dir === '' ? '' : `${dir}/`
    const out = new Set<string>()
    for (const p of this.paths) if (p.startsWith(at) && p.length > at.length) out.add(p.slice(at.length).split('/')[0])
    return [...out].sort()
  }
  private drop(prefix: string): void {
    for (const p of [...this.paths]) if (p === prefix || p.startsWith(`${prefix}/`)) this.paths.delete(p)
  }
  answer(c: ExecCall): FakeAnswer | null {
    const n = c.values[0]
    switch (c.script) {
      case 'install': {
        this.paths.add(`helper/.new-${n}/aicc-helper`)
        return null
      }
      case 'commit': {
        const [, , , folder, staged] = c.values
        this.drop(`helper/${folder}`)
        this.drop(`helper/.new-${staged}`)
        this.paths.add(`helper/${folder}/aicc-helper`)
        return { stdout: result(n, {}) }
      }
      case 'sweep': {
        const folder = c.values[3]
        const lines: Record<string, string> = {}
        if (/; r helpers \$h; /.test(scriptText('sweep'))) {
          let h = 0
          const held = this.names('store').some((x) => /\.json$|\.json\./.test(x))
          if (!held) {
            for (const v of this.names('helper')) {
              if (v === folder || v.startsWith('.') || !/^[0-9A-Za-z.-]+$/.test(v)) continue
              this.paths.delete(`helper/${v}/aicc-helper`)
              // rmdir: only a folder left empty goes.
              if (this.names(`helper/${v}`).length === 0) { this.paths.delete(`helper/${v}/`); h++ }
            }
          }
          lines.helpers = String(h)
        }
        let swept = 0
        for (const x of this.names('sessions')) {
          if (this.paths.has(`store/${x}.json`)) continue
          this.drop(`sessions/${x}`)
          swept++
        }
        lines.swept = String(swept)
        return { stdout: `AICC-HASH ${n} ok ${c.values[4]}\n${result(n, lines)}` }
      }
      case 'remove': {
        this.paths.clear()
        return { stdout: result(n, {}) }
      }
      default: return null
    }
  }
}
