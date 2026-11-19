/**
 * A held Codex session's tool server through its holder (2.1.3-beta.11, plan
 * section B2).
 *
 * A Codex session names its `conductor` tool server in its launch flags
 * (spawn.ts buildCodexSpawnCommand): the loopback address with the session's
 * id, the switch, and the variable that holds its credential, three `-c`
 * entries in that order. Those flags are fixed before the session helper's
 * holder exists. For the launch a holder runs, with the agent sessions' switch
 * on, the three entries are replaced here by the helper's relay mode, as a
 * command and its arguments, so Codex starts the relay as its tool server and
 * its tool calls reach the app through the holder. Everything else stays
 * where it was: the tool timeout and each tool's approval (they key on the
 * server's name, which stays `conductor`), the user's own arguments, and the
 * environment.
 *
 * Three launch shapes come from the builder: Codex started directly, its
 * arguments a list; the resume list (node running the picker script, which
 * hands its flags on to Codex, through cmd.exe when Codex is an npm
 * launcher); and an npm launcher, one cmd.exe line that goes verbatim.
 * Anything that reaches cmd.exe must pass the rule it passes today
 * (codexCmdExeTarget): the relay's arguments are put on such a line only when
 * that rule takes them, and the launch keeps its loopback route otherwise.
 * The rule is not widened for it. The values are TOML, as Codex reads a `-c`
 * value: a literal string in single quotes, or a basic string in double quotes
 * for a path that holds a single quote (which cmd.exe's rule then refuses).
 *
 * Pure: it reads nothing and writes nothing.
 */
import { SID_RE } from '../../session-helper/protocol'
import { CMD_EXE_LINE_MAX, codexCmdExeTarget } from './spawn'
import type { HeldToolLaunch, HeldToolLaunchAnswer, HeldToolRelay } from '../types'

const SERVER = 'mcp_servers.conductor'
const ENABLED_ENTRY = `${SERVER}.enabled=true`
const TOKEN_VAR_ENTRY = `${SERVER}.bearer_token_env_var=CONDUCTOR_MCP_TOKEN`
/** A file Windows runs through cmd.exe: a batch file, its name read as
 *  Windows reads it (trailing dots and spaces dropped), as spawn.ts reads it. */
const WIN_BATCH_NAME_RE = /\.(bat|cmd)[. ]*$/i
/** The variable that names the Codex the resume list starts (spawn.ts). */
const PICKER_EXECUTABLE_ENV = 'CCC_CODEX_EXECUTABLE'
/** What the resume list may put before the flags it hands on: an exact
 *  resume's `resume <id>`, as spawn.ts measures the picker's line. */
const PICKER_PREFIX = ['resume', '00000000-0000-0000-0000-000000000000']
/** A control character anywhere (C0, DEL, C1). */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/
/** Half of a surrogate pair on its own: not Unicode, so Codex cannot read it back. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Whether `arg` is the builder's loopback address entry for this session. */
function isLoopbackUrlEntry(arg: string | undefined, sessionId: string): boolean {
  if (typeof arg !== 'string') return false
  const head = `${SERVER}.url=http://localhost:`
  let tail: string
  try { tail = `/mcp?cccSessionId=${encodeURIComponent(sessionId)}` } catch { return false }
  if (arg.length <= head.length + tail.length || !arg.startsWith(head) || !arg.endsWith(tail)) return false
  return /^[0-9]{1,5}$/.test(arg.slice(head.length, arg.length - tail.length))
}

/** Where the three loopback entries start (each `-c` and its value, in the
 *  builder's order), before any `--`; -1 when they are not there. The first
 *  match is the builder's: the user's own arguments come after its flags. */
function loopbackAt(args: readonly string[], sessionId: string): number {
  for (let i = 0; i + 5 < args.length; i++) {
    if (args[i] === '--') return -1
    if (args[i] === '-c' && isLoopbackUrlEntry(args[i + 1], sessionId) && args[i + 2] === '-c' && args[i + 3] === ENABLED_ENTRY && args[i + 4] === '-c' && args[i + 5] === TOKEN_VAR_ENTRY) return i
  }
  return -1
}

/** One TOML string: literal (single quotes, nothing escaped) unless the text
 *  holds a single quote, then basic (JSON's escapes are TOML's). */
function tomlString(s: string): string {
  return s.includes("'") ? JSON.stringify(s) : `'${s}'`
}

/** Whether `p` can be the helper's path or its store's on Codex's launch
 *  exactly: absolute (on Windows from a drive's root, never a network or
 *  device path), with no control character and no lone surrogate. */
function relayPathUsable(p: unknown, win32: boolean): p is string {
  if (typeof p !== 'string' || p.length === 0 || CONTROL_RE.test(p) || LONE_SURROGATE_RE.test(p)) return false
  return win32 ? /^[A-Za-z]:\\/.test(p) : p.startsWith('/')
}

/** The two `-c` entries that start the relay as the `conductor` server. */
export function codexRelayEntries(relay: HeldToolRelay): string[] {
  const args = ['mcp', '--store', relay.store, '--session', relay.sid].map(tomlString).join(',')
  return ['-c', `${SERVER}.command=${tomlString(relay.helperPath)}`, '-c', `${SERVER}.args=[${args}]`]
}

function withRelay(args: readonly string[], at: number, relay: HeldToolRelay): string[] {
  return [...args.slice(0, at), ...codexRelayEntries(relay), ...args.slice(at + 6)]
}

/** The shim and its arguments of a line codexCmdExeTarget built, read back
 *  only when building them again gives this very line. */
function readCmdExeLine(line: string, env: HeldToolLaunch['env']): { shim: string; args: string[] } | null {
  const head = '/d /v:off /s /c ""'
  if (!line.startsWith(head) || !line.endsWith('"')) return null
  const body = line.slice(head.length, -1)
  const close = body.indexOf('"')
  if (close <= 0) return null
  const shim = body.slice(0, close)
  const rest = body.slice(close + 1)
  if (rest !== '' && !rest.startsWith(' ')) return null
  const args = rest === '' ? [] : rest.slice(1).split(' ')
  try {
    return codexCmdExeTarget(shim, args, env).commandLine === line ? { shim, args } : null
  } catch {
    return null
  }
}

/** The Codex the resume list starts, by every spelling of its variable (on
 *  Windows a name in any case is the same variable). */
function pickerExecutables(env: HeldToolLaunch['env']): string[] {
  return Object.keys(env).filter((k) => k.toUpperCase() === PICKER_EXECUTABLE_ENV).map((k) => env[k]).filter((v): v is string => typeof v === 'string')
}

/**
 * The launch's arguments with its `conductor` server started as the helper's
 * relay, in the shape they were given, or why the launch keeps its loopback
 * route (see HeldToolLaunchAnswer). A launch that names none of this
 * session's loopback entries (the tools off) is not touched.
 */
export function codexHeldToolLaunch(sessionId: string, launch: HeldToolLaunch, relay: HeldToolRelay, platform: NodeJS.Platform = process.platform): HeldToolLaunchAnswer {
  const win32 = platform === 'win32'
  const usable = relayPathUsable(relay.helperPath, win32) && relayPathUsable(relay.store, win32) && SID_RE.test(relay.sid)
  if (typeof launch.args === 'string') {
    // The npm launcher's cmd.exe line (Windows only): read back, rewritten,
    // and built again by the same rule, or not at all.
    const read = win32 ? readCmdExeLine(launch.args, launch.env) : null
    if (!read) return { refused: 'cmd-line' }
    const at = loopbackAt(read.args, sessionId)
    if (at < 0) return { refused: 'no-tools' }
    if (!usable) return { refused: 'unsafe-path' }
    let target: { cmd: string; commandLine: string }
    try {
      target = codexCmdExeTarget(read.shim, withRelay(read.args, at, relay), launch.env)
    } catch {
      return { refused: 'cmd-line' }
    }
    if (target.cmd !== launch.file || target.commandLine.length >= CMD_EXE_LINE_MAX) return { refused: 'cmd-line' }
    return { args: target.commandLine }
  }
  const at = loopbackAt(launch.args, sessionId)
  if (at < 0) return { refused: 'no-tools' }
  if (!usable) return { refused: 'unsafe-path' }
  const args = withRelay(launch.args, at, relay)
  // The resume list hands its flags (all but its script, the first argument)
  // to Codex, through cmd.exe when Codex is an npm launcher, by the same rule
  // and its line limit (scripts/lib/codex-resume-picker-lib.js launchTarget).
  if (win32) {
    for (const exe of pickerExecutables(launch.env)) {
      if (!WIN_BATCH_NAME_RE.test(exe)) continue
      try {
        if (codexCmdExeTarget(exe, [...PICKER_PREFIX, ...args.slice(1)], launch.env).commandLine.length >= CMD_EXE_LINE_MAX) return { refused: 'cmd-line' }
      } catch {
        return { refused: 'cmd-line' }
      }
    }
  }
  return { args }
}
