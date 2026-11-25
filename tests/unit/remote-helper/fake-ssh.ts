/**
 * A fake ssh for remote step 1's unit tests (plan 2.1.3-beta.17, section A2):
 * an SshRunner whose spawn answers each fixed script (src/main/remote-helper/
 * scripts.ts) as a Linux host would, with no process started. Each exec is
 * recorded (its script, values, argv and what it got on standard input), so a
 * test reads which execs ran and in what order.
 *
 * The bridge exec (A1's `bridge` mode) is answered by `bridge`, which a test
 * sets to hand back the holder's end of a connection (a FakeHolder's), after
 * the launcher's hash line, as the real bridge would.
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

const NAMES: ScriptName[] = ['probe', 'install', 'commit', 'discard', 'remove', 'version', 'selftest', 'list', 'hold', 'bridge', 'reads', 'files', 'unsession', 'sweep']

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
        if (!end) { child.finish(this.host.bridgeExit ?? 3); return }
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
