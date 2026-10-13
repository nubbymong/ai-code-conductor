// A fresh Claude session on a computer without Node.js (2.1.1-beta.3, S10).
// Every fresh local session asks for the resume list, which runs on node, and
// a native Claude Code needs no Node.js, so the session must still start:
//  - Windows: with no node.exe in a folder PATH names in full (where the
//    session's PowerShell looks), Claude Code starts directly, by the line the
//    app builds when the list is not deployed, and the log says why once;
//  - macOS and Linux: the line asks the session's own shell, which runs the
//    list when it finds node on PATH or as a shell function (a lazy nvm
//    loader), as beta.2 did, with any alias named node dropped first, and
//    otherwise says why in the session and starts Claude Code directly; the
//    options are on the line once;
//  - with node found, the same command runs as before (on Windows node.exe
//    is started by the full path the app found, never by a name).
// On Windows the app looks for node.exe off the event loop beside the 30 s
// CLI check, and a launch reads that answer while it is less than a minute
// old; only without one does the launch walk PATH itself.
// The Windows lookup is mocked: no PATH is walked and no process starts. The
// last block runs the macOS/Linux line in real POSIX shells with stub
// programs (never a real node or Claude Code), off Windows only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'

const lookups: Array<{ names: readonly string[]; path: string | undefined }> = []
/** Looks made off the event loop (findOnWindowsPathAsync). */
const asyncLookups: Array<{ names: readonly string[]; path: string | undefined }> = []
/** When set, an off-the-loop look waits for it before it answers. */
let asyncGate: Promise<void> | null = null
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  return {
    ...actual,
    findOnWindowsPath: vi.fn((names: readonly string[], env: NodeJS.ProcessEnv) => {
      lookups.push({ names, path: actual.windowsEnvValue(env, 'PATH') })
      return ((globalThis as any).__nodeExe as string | undefined) ?? null
    }),
    findOnWindowsPathAsync: vi.fn(async (names: readonly string[], env: NodeJS.ProcessEnv) => {
      asyncLookups.push({ names, path: actual.windowsEnvValue(env, 'PATH') })
      const answer = ((globalThis as any).__nodeExe as string | undefined) ?? null
      if (asyncGate) await asyncGate
      return answer
    }),
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const mod = await import('../../../src/main/spawn-claude-command')
const { buildClaudeLaunchCommand, claudeLaunchProgram, launchStartsPicker, quoteArgForShell, CLAUDE_NETWORK_FOLDER_REFUSAL, LAUNCHER_PROGRAM_LOOKUP } = mod
const { logInfo } = await import('../../../src/main/debug-logger')

const PICKER = 'C:\\ccc\\scripts\\resume-picker.js'
const EXE = 'C:\\Users\\u\\.local\\bin\\claude.exe'
const CMD = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const PATH_A = 'C:\\Windows\\System32;C:\\Program Files\\nodejs'
const PATH_B = 'C:\\Windows\\System32;C:\\tools'
const BASE = { platform: 'win32', cwd: 'C:\\work', claudeBin: EXE, extraFlags: ' --model opus', agentsFlag: '', useResumePicker: true, pickerScript: PICKER as string | null }
const LEAD = "$PSNativeCommandArgumentPassing = 'Legacy'; "
/** What a Windows line that starts the picker sets first: the Claude Code
 *  the session would start itself, for the picker to start (CLAUDE_BIN_ENV). */
const NAMED = `$env:CCC_CLAUDE_BIN = '${EXE}'; `
/** How a Windows line starts the picker's node: the full path the lookup
 *  returned, single-quoted, after PowerShell's call operator. */
const RUN_NODE = `& '${NODE}'`
const SKIPPED = 'Node.js was not found in a folder PATH names (node.exe), so the resume list was skipped and Claude Code starts directly'
const NOTICE = 'Node.js was not found, so the resume list was skipped.'
/** The check the macOS/Linux line makes, up to the picker's path: any alias
 *  named node dropped in the session's shell, then node asked for, which a
 *  node on PATH or a shell function answers. */
const ASK_IF = 'if { unalias node; command -v node; } >/dev/null 2>&1; then '
/** Claude Code named once (CLAUDE_BIN_ENV), then ASK_IF, then the picker by
 *  node, as beta.2 started it. */
const ASK = `export CCC_CLAUDE_BIN='claude' && ${ASK_IF}set -- node`
/** The macOS/Linux branch without node: the notice, then Claude Code by the
 *  name the line gave it. */
const ELSE = `else printf '%s\\n' 'Node.js was not found, so the resume list was skipped.'; set -- "$CCC_CLAUDE_BIN"; fi`
/** How long an answer about node.exe is used (PICKER_NODE_REUSE_MS). */
const REUSE_MS = 60_000

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
function onPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
/** The single-quoted PowerShell word at the start of `s` (any of the five
 *  characters PowerShell takes as a single quote; a doubled one inside is
 *  one literal), and how many characters it takes. */
function psSingleQuoted(s: string): { value: string; length: number } {
  const Q = String.fromCharCode(0x27, 0x2018, 0x2019, 0x201a, 0x201b)
  if (!Q.includes(s[0])) throw new Error(`not single-quoted: ${s}`)
  let value = ''
  for (let i = 1; i < s.length; i++) {
    if (Q.includes(s[i])) {
      if (i + 1 < s.length && Q.includes(s[i + 1])) { value += s[i + 1]; i++; continue }
      return { value, length: i + 1 }
    }
    value += s[i]
  }
  throw new Error(`unterminated: ${s}`)
}
function nodeExe(p: string | null): void {
  if (p) (globalThis as any).__nodeExe = p
  else delete (globalThis as any).__nodeExe
}
/** The clock pickerNodeFound reads, set by the test. */
let clock = 1_000
let clockSpy: { mockRestore: () => void } | null = null
function later(ms: number): void {
  clock += ms
}

beforeEach(() => {
  lookups.length = 0
  asyncLookups.length = 0
  asyncGate = null
  vi.mocked(logInfo).mockClear()
  ;(mod as any)._resetPickerNodeFoundForTest?.()
  clock = 1_000
  clockSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
  onPlatform('win32')
  vi.stubEnv('PATH', PATH_A)
  nodeExe(null)
})
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  vi.unstubAllEnvs()
  clockSpy?.mockRestore()
  clockSpy = null
  nodeExe(null)
  ;(mod as any)._resetPickerNodeFoundForTest?.()
})

describe('Windows, no node.exe in a folder PATH names in full', () => {
  it('a fresh session starts Claude Code directly, by the line built when the resume list is not deployed', () => {
    const line = buildClaudeLaunchCommand(BASE)
    expect(line).toBe(`Set-Location -LiteralPath 'C:\\work'; & '${EXE}' --model opus; exit`)
    expect(line).toBe(buildClaudeLaunchCommand({ ...BASE, pickerScript: null }))
    expect(line).not.toMatch(/\bnode\b/)
    expect(launchStartsPicker(BASE)).toBe(false)
    expect(claudeLaunchProgram(BASE)).toBe(EXE)
  })

  it('says once in the log that the resume list was skipped because Node.js was not found', () => {
    buildClaudeLaunchCommand(BASE)
    expect(vi.mocked(logInfo)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(`[spawn-claude] ${SKIPPED}`)
    expect((mod as any).CLAUDE_RESUME_LIST_SKIPPED_NO_NODE).toBe(SKIPPED)
  })

  // Mutation to prove this can fail: write the log line before the line is built.
  it('a launch refused for another reason writes no line about the resume list', () => {
    const tooLong = { ...BASE, agentsFromEnv: true, agentsValueLength: 40_000 }
    expect(() => buildClaudeLaunchCommand(tooLong)).toThrow(/Cannot start Claude Code with these agent templates/)
    expect(vi.mocked(logInfo)).not.toHaveBeenCalled()
  })

  it('the log line names the session when the builder is given a plain session id, and only then', () => {
    buildClaudeLaunchCommand({ ...BASE, sessionId: 'sess_01-AB' })
    expect(vi.mocked(logInfo)).toHaveBeenLastCalledWith(`[spawn-claude] sess_01-AB: ${SKIPPED}`)
    buildClaudeLaunchCommand({ ...BASE, sessionId: 'a b\nc' })
    expect(vi.mocked(logInfo)).toHaveBeenLastCalledWith(`[spawn-claude] ${SKIPPED}`)
  })

  it('asks for node.exe only, in the PATH the session inherits', () => {
    buildClaudeLaunchCommand(BASE)
    expect(lookups.length).toBeGreaterThan(0)
    for (const l of lookups) expect(l).toEqual({ names: ['node.exe'], path: PATH_A })
  })

  it('with agent templates in the environment, their value is written for Claude Code, which the line starts', () => {
    const opts = { ...BASE, agentsFromEnv: true, agentsValueLength: 40 }
    expect(claudeLaunchProgram(opts)).toBe(EXE)
    expect(buildClaudeLaunchCommand(opts)).toBe(`${LEAD}Set-Location -LiteralPath 'C:\\work'; & '${EXE}' --agents \${env:CCC_AGENTS} --model opus; exit`)
  })

  it('through npm\'s claude.cmd in a network folder it is refused with the reason, as any direct start there', () => {
    const share = { ...BASE, claudeBin: CMD, cwd: '\\\\srv\\share\\proj' }
    expect(() => buildClaudeLaunchCommand(share)).toThrow(CLAUDE_NETWORK_FOLDER_REFUSAL)
    // With node, the picker starts there as before (node can; the picker refuses its own launch).
    nodeExe(NODE)
    later(REUSE_MS)
    expect(buildClaudeLaunchCommand(share)).toBe(`Set-Location -LiteralPath '\\\\srv\\share\\proj'; $env:CCC_CLAUDE_BIN = '${CMD}'; ${RUN_NODE} '${PICKER}' --model opus; exit`)
  })

  it('one launch gets one answer: a miss is kept under the same PATH, so node.exe arriving between its two questions changes nothing', () => {
    const opts = { ...BASE, agentsFromEnv: true, agentsValueLength: 40 }
    // The templates' value is written for Claude Code (pty-manager asks first)...
    expect(claudeLaunchProgram(opts)).toBe(EXE)
    // ...node.exe appears before the line is built...
    nodeExe(NODE)
    later(5)
    // ...and the line still starts what the value was written for.
    expect(buildClaudeLaunchCommand(opts)).toBe(`${LEAD}Set-Location -LiteralPath 'C:\\work'; & '${EXE}' --agents \${env:CCC_AGENTS} --model opus; exit`)
    expect(lookups).toHaveLength(1)
  })

  // A fresh Node.js install adds a PATH folder this process does not read
  // until an explicit check (or a restart): that is the changed PATH below.
  it('a node.exe put into a folder PATH already names is used a minute after the miss; a PATH that reads differently (after Check again or a restart) is asked at once', () => {
    expect(buildClaudeLaunchCommand(BASE)).toBe(`Set-Location -LiteralPath 'C:\\work'; & '${EXE}' --model opus; exit`)
    nodeExe(NODE)
    later(REUSE_MS - 1)
    expect(buildClaudeLaunchCommand(BASE)).toBe(`Set-Location -LiteralPath 'C:\\work'; & '${EXE}' --model opus; exit`)
    expect(lookups).toHaveLength(1)
    later(1)
    expect(buildClaudeLaunchCommand(BASE)).toBe(`Set-Location -LiteralPath 'C:\\work'; ${NAMED}${RUN_NODE} '${PICKER}' --model opus; exit`)
    expect(lookups).toHaveLength(2)
    // A miss under one PATH is not an answer for another.
    nodeExe(null)
    vi.stubEnv('PATH', PATH_B)
    expect(claudeLaunchProgram(BASE)).toBe(EXE)
    nodeExe(NODE)
    vi.stubEnv('PATH', PATH_A)
    expect(claudeLaunchProgram(BASE)).toBe('node')
    expect(lookups.at(-1)).toEqual({ names: ['node.exe'], path: PATH_A })
  })
})

describe('Windows, node.exe found: nothing changes', () => {
  beforeEach(() => nodeExe(NODE))

  it('the line starts the resume list by node, as before, and the log says nothing about it', () => {
    expect(buildClaudeLaunchCommand(BASE)).toBe(`Set-Location -LiteralPath 'C:\\work'; ${NAMED}${RUN_NODE} '${PICKER}' --model opus; exit`)
    expect(launchStartsPicker(BASE)).toBe(true)
    expect(claudeLaunchProgram(BASE)).toBe('node')
    expect(vi.mocked(logInfo)).not.toHaveBeenCalled()
  })

  // The session's PowerShell runs the user's profile after the app kept PATH
  // to fully qualified folders. A program started by a name is looked up by
  // PowerShell's own rules (functions, aliases, PATHEXT, and the PATH the
  // profile leaves); one started by its full path is that file. So the line
  // starts the node.exe the app found by its full path (measured with
  // Windows PowerShell 5.1 and PowerShell 7.6; run for real in
  // spawn-claude-picker-node-powershell.test.ts, CI and VM only).
  // Mutation to prove this can fail: start the picker by the file name node.exe, as the line did before.
  it('node is started by the full path the app found, single-quoted after the call operator: never by a name PowerShell would look up', () => {
    expect((mod as any).PICKER_NODE_ON_WINDOWS).toBeUndefined()
    for (const claudeBin of [EXE, CMD]) {
      const line = buildClaudeLaunchCommand({ ...BASE, claudeBin })
      expect(line).toContain(`; ${RUN_NODE} '${PICKER}' `)
      // No command position on the line names node.
      expect(line).not.toMatch(/(^|[;&] )node(\.exe)? /i)
    }
  })

  // Mutation to prove this can fail: write node's path without escapeForCwdQuote (or by name).
  it('whatever the path holds (a space, an apostrophe, a curly quote, parentheses, $ and a backtick, a share), PowerShell reads back exactly the path found', () => {
    const paths = [
      'C:\\Program Files\\nodejs\\node.exe',
      "C:\\Users\\o'brien\\AppData\\Local\\fnm_multishells\\1_2\\node.exe",
      'C:\\Users\\it\u2019s \u2018x\u2019 \u201Ay\u201B\\nvm\\v20 (lts)\\node.exe',
      'C:\\tools\\$(whoami)\\`n\\node.exe',
      '\\\\srv\\tools\\node.exe',
    ]
    for (const p of paths) {
      nodeExe(p)
      ;(mod as any)._resetPickerNodeFoundForTest()
      const line = buildClaudeLaunchCommand(BASE)
      const head = `Set-Location -LiteralPath 'C:\\work'; ${NAMED}& `
      expect(line.startsWith(head), line).toBe(true)
      const word = psSingleQuoted(line.slice(head.length))
      expect(word.value, line).toBe(p)
      expect(line.slice(head.length + word.length)).toBe(` '${PICKER}' --model opus; exit`)
    }
  })

  // The agent templates' length is held to what the picker's own launch of a
  // batch launcher through cmd.exe may carry (8191). node's path is in no
  // command line the picker hands on, so the budget is the one the line had
  // when it named node by its file name, whatever that path is.
  // Mutation to prove this can fail: count the line's node path in the length.
  it('with agent templates in the environment, the longest value let through is the same as before, whatever node\'s path', () => {
    const longest = (nodePath: string): number => {
      nodeExe(nodePath)
      ;(mod as any)._resetPickerNodeFoundForTest()
      const ok = (n: number): boolean => { try { buildClaudeLaunchCommand({ ...BASE, agentsFromEnv: true, agentsValueLength: n }); return true } catch { return false } }
      let lo = 0
      let hi = 20_000
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (ok(mid)) lo = mid; else hi = mid - 1 }
      return lo
    }
    const before = 8_191 - (`node.exe '${PICKER}' --agents \${env:CCC_AGENTS} --model opus`.length - '${env:CCC_AGENTS}'.length + 256 + EXE.length)
    expect(longest('C:\\n\\node.exe')).toBe(before)
    expect(longest(`C:\\${'d'.repeat(200)}\\nodejs\\node.exe`)).toBe(before)
  })

  // Windows PowerShell 5.1, the session shell, reads `[` and `]` in the path
  // after `&` as a wildcard pattern before the path as written: with
  // `v[1]\node.exe` found and a `v1\node.exe` beside it, it runs
  // `v1\node.exe` (measured with 5.1.26100; PowerShell 7.6 runs the path as
  // written, and finds nothing when they are escaped). So such a path never
  // reaches the line: Claude Code starts directly, and the log says why
  // without the path. Run for real, CI and VM only:
  // spawn-claude-picker-node-powershell.test.ts.
  // Mutation to prove this can fail: put any found path on the line.
  it('a node.exe found at a path holding [ or ] is never started: Claude Code starts directly, and the log says why without the path', () => {
    for (const p of ['C:\\nvm\\v[1]\\node.exe', 'C:\\tools\\node]\\node.exe', 'C:\\a[b\\node.exe']) {
      nodeExe(p)
      ;(mod as any)._resetPickerNodeFoundForTest()
      vi.mocked(logInfo).mockClear()
      for (const claudeBin of [EXE, CMD]) {
        const opts = { ...BASE, claudeBin }
        expect(launchStartsPicker(opts)).toBe(false)
        expect(claudeLaunchProgram(opts)).toBe(claudeBin)
        expect((mod as any).pickerNodeFound()).toBe(false)
        const line = buildClaudeLaunchCommand(opts)
        // npm's launcher has the session's lookup set again first (LAUNCHER_PROGRAM_LOOKUP).
        const lookup = claudeBin === CMD ? LAUNCHER_PROGRAM_LOOKUP : ''
        expect(line).toBe(`Set-Location -LiteralPath 'C:\\work'; ${lookup}& '${claudeBin}' --model opus; exit`)
        expect(line).not.toContain(p)
        expect(line).not.toMatch(/\bnode(\.exe)?\b/i)
        // With templates in the environment too: written for Claude Code, which the line starts.
        const withAgents = { ...opts, agentsFromEnv: true, agentsValueLength: 40 }
        expect(claudeLaunchProgram(withAgents)).toBe(claudeBin)
        expect(buildClaudeLaunchCommand(withAgents)).toBe(`${LEAD}Set-Location -LiteralPath 'C:\\work'; ${lookup}& '${claudeBin}' --agents \${env:CCC_AGENTS} --model opus; exit`)
      }
      const said = vi.mocked(logInfo).mock.calls.map((c) => String(c[0]))
      expect(said).toEqual(Array(4).fill(`[spawn-claude] ${(mod as any).CLAUDE_RESUME_LIST_SKIPPED_NODE_PATH}`))
      for (const s of said) expect(s).not.toContain(p)
    }
    expect((mod as any).CLAUDE_RESUME_LIST_SKIPPED_NODE_PATH).toMatch(/^Node\.js was found, but its folder path holds \[ or \]/)
    // A found path without them starts the picker by that path, as before.
    nodeExe('C:\\nvm\\v1\\node.exe')
    ;(mod as any)._resetPickerNodeFoundForTest()
    expect(buildClaudeLaunchCommand(BASE)).toBe(`Set-Location -LiteralPath 'C:\\work'; ${NAMED}& 'C:\\nvm\\v1\\node.exe' '${PICKER}' --model opus; exit`)
    expect((mod as any).pickerNodeFound()).toBe(true)
    // A backtick alone, PowerShell's wildcard escape, is started as written
    // by Windows PowerShell 5.1 and PowerShell 7 (measured), so it is not refused.
    nodeExe('C:\\nvm\\v`1\\node.exe')
    ;(mod as any)._resetPickerNodeFoundForTest()
    expect(buildClaudeLaunchCommand(BASE)).toBe(`Set-Location -LiteralPath 'C:\\work'; ${NAMED}& 'C:\\nvm\\v\`1\\node.exe' '${PICKER}' --model opus; exit`)
  })

  it('with agent templates in the environment: written for node, which the line starts, as before', () => {
    const opts = { ...BASE, agentsFromEnv: true, agentsValueLength: 40 }
    expect(claudeLaunchProgram(opts)).toBe('node')
    expect(buildClaudeLaunchCommand(opts)).toBe(`${LEAD}Set-Location -LiteralPath 'C:\\work'; ${NAMED}${RUN_NODE} '${PICKER}' --agents \${env:CCC_AGENTS} --model opus; exit`)
  })

  it('one launch gets one answer: a find is kept under the same PATH, so node.exe going between its two questions changes nothing; another PATH is asked again', () => {
    const opts = { ...BASE, agentsFromEnv: true, agentsValueLength: 40 }
    expect(claudeLaunchProgram(opts)).toBe('node')
    // node.exe goes between the two questions of one launch: the line still
    // starts what the templates' value was written for.
    nodeExe(null)
    later(5)
    expect(buildClaudeLaunchCommand(opts)).toBe(`${LEAD}Set-Location -LiteralPath 'C:\\work'; ${NAMED}${RUN_NODE} '${PICKER}' --agents \${env:CCC_AGENTS} --model opus; exit`)
    expect(lookups).toHaveLength(1)
    vi.stubEnv('PATH', PATH_B)
    expect(claudeLaunchProgram(opts)).toBe(EXE)
    expect(lookups.at(-1)).toEqual({ names: ['node.exe'], path: PATH_B })
  })

  // Mutation to prove this can fail: keep a find for as long as PATH reads the same.
  it('a Node.js removed while the app runs is no longer started a minute after it was found', () => {
    expect(buildClaudeLaunchCommand(BASE)).toBe(`Set-Location -LiteralPath 'C:\\work'; ${NAMED}${RUN_NODE} '${PICKER}' --model opus; exit`)
    nodeExe(null)
    later(REUSE_MS - 1)
    expect(buildClaudeLaunchCommand(BASE)).toBe(`Set-Location -LiteralPath 'C:\\work'; ${NAMED}${RUN_NODE} '${PICKER}' --model opus; exit`)
    expect(lookups).toHaveLength(1)
    later(1)
    expect(buildClaudeLaunchCommand(BASE)).toBe(`Set-Location -LiteralPath 'C:\\work'; & '${EXE}' --model opus; exit`)
    expect(lookups).toHaveLength(2)
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(`[spawn-claude] ${SKIPPED}`)
  })
})

describe('Windows: the CLI check looks for node.exe off the event loop, and a launch reads that answer', () => {
  const warm = async (): Promise<void> => { await (mod as any).warmPickerNodeOnWindows?.(process.env) }

  // Mutation to prove this can fail: walk PATH in pickerNodeFound whatever is kept.
  it('after the look, a launch walks no PATH on the main process: node.exe found, the resume list; none, Claude Code directly', async () => {
    nodeExe(NODE)
    await warm()
    expect(asyncLookups).toEqual([{ names: ['node.exe'], path: PATH_A }])
    expect(buildClaudeLaunchCommand(BASE)).toBe(`Set-Location -LiteralPath 'C:\\work'; ${NAMED}${RUN_NODE} '${PICKER}' --model opus; exit`)
    // The next check, 30 s later, finds none: so does the next launch.
    nodeExe(null)
    later(30_000)
    await warm()
    expect(buildClaudeLaunchCommand(BASE)).toBe(`Set-Location -LiteralPath 'C:\\work'; & '${EXE}' --model opus; exit`)
    expect(lookups).toEqual([])
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(`[spawn-claude] ${SKIPPED}`)
  })

  it('its answer is used for a minute and only under the PATH it was given; then the launch looks for itself', async () => {
    await warm()
    nodeExe(NODE)
    later(REUSE_MS - 1)
    expect(claudeLaunchProgram(BASE)).toBe(EXE)
    expect(lookups).toEqual([])
    later(1)
    expect(claudeLaunchProgram(BASE)).toBe('node')
    expect(lookups).toEqual([{ names: ['node.exe'], path: PATH_A }])
    // An answer for another PATH is not this PATH's.
    ;(mod as any)._resetPickerNodeFoundForTest()
    nodeExe(null)
    await (mod as any).warmPickerNodeOnWindows?.({ PATH: PATH_B })
    nodeExe(NODE)
    expect(claudeLaunchProgram(BASE)).toBe('node')
    expect(lookups).toHaveLength(2)
  })

  // Mutation to prove this can fail: drop the in-flight guard.
  it('one look at a time: a check while a slow look is in flight starts no other, and the launch meanwhile looks for itself', async () => {
    let open = (): void => {}
    asyncGate = new Promise<void>((r) => { open = r })
    nodeExe(NODE)
    const first = (mod as any).warmPickerNodeOnWindows?.(process.env)
    const second = (mod as any).warmPickerNodeOnWindows?.(process.env)
    expect(asyncLookups).toHaveLength(1)
    expect(second).toBe(first)
    expect(claudeLaunchProgram(BASE)).toBe('node')
    expect(lookups).toHaveLength(1)
    open()
    await first
    asyncGate = null
    await warm()
    expect(asyncLookups).toHaveLength(2)
  })

  // Mutation to prove this can fail: clear the in-flight mark whichever look ends.
  it('a look started after a reset keeps its in-flight mark when the look before it ends', async () => {
    let open1 = (): void => {}
    asyncGate = new Promise<void>((r) => { open1 = r })
    const first = (mod as any).warmPickerNodeOnWindows(process.env)
    ;(mod as any)._resetPickerNodeFoundForTest()
    let open2 = (): void => {}
    asyncGate = new Promise<void>((r) => { open2 = r })
    const second = (mod as any).warmPickerNodeOnWindows(process.env)
    expect(asyncLookups).toHaveLength(2)
    open1()
    await first
    // The first look's end leaves the second in flight: a check now joins it.
    expect((mod as any).warmPickerNodeOnWindows(process.env)).toBe(second)
    expect(asyncLookups).toHaveLength(2)
    open2()
    await second
  })

  it('off Windows it looks for nothing', async () => {
    onPlatform('linux')
    await warm()
    expect(asyncLookups).toEqual([])
  })
})

describe('no question about node when the line would not start the resume list', () => {
  it('an exact resume, a launch that asks for no list, and a list that is not deployed walk no PATH', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000'
    expect(buildClaudeLaunchCommand({ ...BASE, resumeUuid: uuid })).toBe(`Set-Location -LiteralPath 'C:\\work'; & '${EXE}' --resume ${uuid} --model opus; exit`)
    expect(buildClaudeLaunchCommand({ ...BASE, useResumePicker: false })).toBe(`Set-Location -LiteralPath 'C:\\work'; & '${EXE}' --model opus; exit`)
    expect(buildClaudeLaunchCommand({ ...BASE, pickerScript: null })).toBe(`Set-Location -LiteralPath 'C:\\work'; & '${EXE}' --model opus; exit`)
    expect(lookups).toEqual([])
    expect(vi.mocked(logInfo)).not.toHaveBeenCalled()
  })
})

describe('macOS and Linux: the line asks the session\'s shell for node', () => {
  const AGENTS = ` --agents '{"a":{"description":"d","prompt":"p"}}'`
  const POSIX = { platform: 'posix', cwd: '/work', claudeBin: 'claude', extraFlags: " --model 'opus'", agentsFlag: AGENTS, useResumePicker: true, pickerScript: '/r/scripts/resume-picker.js' as string | null }
  /** The beta.2 line: node and the picker, then the options. */
  const beta2 = (o: { agentsFlag: string; extraFlags: string }): string => `cd '/work' && node '/r/scripts/resume-picker.js'${o.agentsFlag}${o.extraFlags}; exit`

  it('the shell picks the program: the picker by node when it finds node, else a notice and Claude Code; the options follow once', () => {
    onPlatform('darwin')
    const opts = `${AGENTS} --model 'opus'`
    expect(buildClaudeLaunchCommand(POSIX)).toBe(`cd '/work' && ${ASK} '/r/scripts/resume-picker.js'; ${ELSE} && "$@"${opts}; exit`)
    expect((mod as any).RESUME_LIST_SKIPPED_NOTICE).toBe(NOTICE)
    // No PATH is walked in the app, and the app's log says nothing: the
    // shell decides, and the session itself says why.
    expect(lookups).toEqual([])
    expect(vi.mocked(logInfo)).not.toHaveBeenCalled()
  })

  // The line is typed into a shell that may still be reading its own files,
  // so the terminal may hold it in canonical mode, where macOS keeps at most
  // 1024 bytes (MAX_CANON) and cuts the rest, leaving the shell waiting at a
  // continuation prompt. The rest of a typical line (the folder, the
  // picker's path, --settings, --mcp-config) already takes about half of
  // that, so the fixed length this line adds is held to its measured value
  // (208 bytes) plus Claude Code's path once: a change that adds to it has to
  // be argued against that budget, not met by raising the number here.
  // Mutation to prove this can fail: name Claude Code's path twice, as the line did before.
  it('the options are on the line once, and the line is the beta.2 line plus a fixed length and Claude Code\'s path once, whatever the options', () => {
    onPlatform('linux')
    const long = ` --agents '${JSON.stringify({ r: { description: 'x'.repeat(600), prompt: 'y'.repeat(600) } })}'`
    // Claude Code's path as the line writes it (single-quoted): by name, and a
    // pinned version's path.
    const bins = ["'claude'", "'/Users/someone/Library/Application Support/AI Code Conductor/legacy-versions/2.0.0/node_modules/.bin/claude'"]
    const overheads = [AGENTS, '', long].flatMap((agentsFlag) => bins.map((quoted) => {
      const line = buildClaudeLaunchCommand({ ...POSIX, agentsFlag, claudeBin: quoted.slice(1, -1) })
      expect(line.split(`${agentsFlag} --model 'opus'`)).toHaveLength(2)
      expect(line.split(quoted)).toHaveLength(2)
      return line.length - beta2({ agentsFlag, extraFlags: " --model 'opus'" }).length - quoted.length
    }))
    expect(new Set(overheads).size).toBe(1)
    expect(overheads[0]).toBeLessThanOrEqual(208)
  })

  it('Claude Code\'s path, new on this line, is single-quoted as on every other line, and the notice is plain ASCII text', () => {
    onPlatform('linux')
    const line = buildClaudeLaunchCommand({ ...POSIX, agentsFlag: '', claudeBin: "/opt/it's $(touch x)/claude" })
    expect(line).toContain(`cd '/work' && export CCC_CLAUDE_BIN='/opt/it'\\''s $(touch x)/claude' && if `)
    // The branch without node starts it by that name, double-quoted: one word, read as text.
    expect(line).toContain(`; set -- "$CCC_CLAUDE_BIN"; fi && "$@" --model 'opus'; exit`)
    // Written single-quoted on the line: no quote, backslash or non-ASCII.
    expect(NOTICE).toMatch(/^[\x20-\x7e]+$/)
    expect(NOTICE).not.toMatch(/['\\]/)
  })

  it('the user\'s own words are arguments after the program, never a command', () => {
    onPlatform('linux')
    const line = buildClaudeLaunchCommand({ ...POSIX, agentsFlag: '', userArgs: '--verbose --add-dir=/x' })
    expect(line).toBe(`cd '/work' && ${ASK} '/r/scripts/resume-picker.js'; ${ELSE} && "$@" --model 'opus' --verbose --add-dir=/x; exit`)
  })

  it('an exact resume and a list that is not deployed keep their lines', () => {
    onPlatform('linux')
    const uuid = '123e4567-e89b-12d3-a456-426614174000'
    expect(buildClaudeLaunchCommand({ ...POSIX, agentsFlag: '', resumeUuid: uuid })).toBe(`cd '/work' && 'claude' --resume ${uuid} --model 'opus'; exit`)
    expect(buildClaudeLaunchCommand({ ...POSIX, agentsFlag: '', pickerScript: null })).toBe(`cd '/work' && 'claude' --model 'opus'; exit`)
  })
})

describe('the picker starts the Claude Code the line would start, a pinned one included', () => {
  const PIN = "C:\\res\\it's\\legacy-versions\\2.0.0\\node_modules\\.bin\\claude.cmd"

  // Mutation to prove this can fail: drop the statement that names Claude Code for the picker.
  it('Windows: the line that starts the picker names Claude Code first, single-quoted for PowerShell', () => {
    nodeExe(NODE)
    expect((mod as any).CLAUDE_BIN_ENV).toBe('CCC_CLAUDE_BIN')
    expect(buildClaudeLaunchCommand({ ...BASE, claudeBin: PIN }))
      .toBe(`Set-Location -LiteralPath 'C:\\work'; $env:CCC_CLAUDE_BIN = 'C:\\res\\it''s\\legacy-versions\\2.0.0\\node_modules\\.bin\\claude.cmd'; ${RUN_NODE} '${PICKER}' --model opus; exit`)
  })

  it('Windows: a line that starts Claude Code itself names nothing for a picker', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000'
    nodeExe(NODE)
    for (const opts of [{ ...BASE, resumeUuid: uuid }, { ...BASE, useResumePicker: false }, { ...BASE, pickerScript: null }]) {
      expect(buildClaudeLaunchCommand(opts)).not.toContain('CCC_CLAUDE_BIN')
    }
    nodeExe(null)
    later(REUSE_MS)
    expect(buildClaudeLaunchCommand(BASE)).not.toContain('CCC_CLAUDE_BIN')
  })

  it('macOS and Linux: named once, single-quoted for the sh family, before the shell picks the program; a line that starts Claude Code itself names nothing', () => {
    onPlatform('linux')
    const base = { platform: 'posix', cwd: '/w', claudeBin: "/opt/it's/claude", extraFlags: '', agentsFlag: '', useResumePicker: true, pickerScript: '/r/p.js' as string | null }
    const line = buildClaudeLaunchCommand(base)
    expect(line.startsWith("cd '/w' && export CCC_CLAUDE_BIN='/opt/it'\\''s/claude' && if ")).toBe(true)
    expect(line).toContain(`; then set -- node '/r/p.js'; else `)
    // Named once: the path itself appears nowhere else on the line.
    expect(line.split("'/opt/it'\\''s/claude'")).toHaveLength(2)
    expect(buildClaudeLaunchCommand({ ...base, pickerScript: null })).not.toContain('CCC_CLAUDE_BIN')
    expect(buildClaudeLaunchCommand({ ...base, resumeUuid: '123e4567-e89b-12d3-a456-426614174000' })).not.toContain('CCC_CLAUDE_BIN')
  })
})

// The macOS/Linux line run by real POSIX shells, with a stub `node` that
// prints PICKER and a stub Claude Code that prints CLAUDE, each followed by
// the Claude Code named for the picker (bin=, when it got one) and every
// argument it got in brackets. Off Windows only (CI); never a real node or
// Claude Code.
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash', '/bin/ksh'].filter((s) => process.platform !== 'win32' && fs.existsSync(s))
describe.skipIf(SHELLS.length === 0)('the macOS/Linux line in a real POSIX shell, stub programs only', () => {
  let tmp = ''
  const stub = (name: string): string => `#!/bin/sh\nprintf '${name}'\n[ -n "$CCC_CLAUDE_BIN" ] && printf ' bin=%s' "$CCC_CLAUDE_BIN"\nfor a in "$@"; do printf ' [%s]' "$a"; done\nprintf '\\n'\n`
  beforeEach(() => {
    Object.defineProperty(process, 'platform', realPlatform)
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-no-node-'))
    for (const d of ['with-node', 'without-node', 'bin']) fs.mkdirSync(path.join(tmp, d))
    fs.writeFileSync(path.join(tmp, 'with-node', 'node'), stub('PICKER'), { mode: 0o755 })
    fs.writeFileSync(path.join(tmp, 'bin', 'claude-stub'), stub('CLAUDE'), { mode: 0o755 })
  })
  afterEach(() => {
    if (tmp && path.dirname(tmp) === os.tmpdir() && /^ccc-no-node-/.test(path.basename(tmp))) fs.rmSync(tmp, { recursive: true, force: true })
  })

  // One agent template whose words hold a space and a single quote, quoted
  // for the sh family as pty-manager quotes it.
  const AGENTS_JSON = `{"a":{"description":"d e","prompt":"it's"}}`
  const launch = (cwd: string): string => buildClaudeLaunchCommand({ platform: 'posix', cwd, claudeBin: path.join(tmp, 'bin', 'claude-stub'), extraFlags: " --model 'opus'", agentsFlag: ` --agents ${quoteArgForShell(AGENTS_JSON, false)}`, userArgs: '--verbose', useResumePicker: true, pickerScript: '/r/resume-picker.js' })
  const args = ` [--agents] [${AGENTS_JSON}] [--model] [opus] [--verbose]`
  // The picker gets the Claude Code the line names for it; Claude Code
  // started directly, by that name, inherits it.
  const list = (): string => `PICKER bin=${path.join(tmp, 'bin', 'claude-stub')} [/r/resume-picker.js]${args}\n`
  const direct = (): string => `${NOTICE}\nCLAUDE bin=${path.join(tmp, 'bin', 'claude-stub')}${args}\n`
  // What a session's own shell files may define before the line runs. bash
  // reports an alias only with expand_aliases on, as in an interactive shell;
  // the other shells have no shopt and ignore the line.
  const ALIAS = 'shopt -s expand_aliases 2>/dev/null; alias node=ccc-no-such-node; '
  // A lazy loader, as zsh-nvm and oh-my-zsh's nvm plugin write one: a function
  // named node that puts node on PATH the first time it runs, then runs it. It
  // prints LOADED first, so a test sees that it ran.
  const LAZY = (): string => `node() { unset -f node; printf 'LOADED '; PATH='${path.join(tmp, 'with-node')}':"$PATH"; node "$@"; }; `
  for (const shell of SHELLS) {
    /** The line's output in this shell, `pre` run before it, PATH naming `dir` only. */
    const run = (dir: string, o: { cwd?: string; pre?: string; env?: Record<string, string> } = {}): string =>
      spawnSync(shell, ['-c', `${o.pre ?? ''}${launch(o.cwd ?? tmp)}`], { env: { ...o.env, PATH: path.join(tmp, dir) }, encoding: 'utf8', timeout: 10_000 }).stdout

    it(`${shell}: the list when node is on PATH; a notice and Claude Code directly when it is not; the same arguments either way`, () => {
      expect(run('with-node')).toBe(list())
      expect(run('without-node')).toBe(direct())
      // A folder that cannot be entered starts nothing, as before.
      expect(run('with-node', { cwd: path.join(tmp, 'missing') })).toBe('')
      expect(run('without-node', { cwd: path.join(tmp, 'missing') })).toBe('')
    })

    // Mutation to prove this can fail: drop functions as well as aliases before asking, as the line did before.
    it(`${shell}: a node that is only a shell function (a lazy nvm loader) runs the list, as in beta.2`, () => {
      expect(run('without-node', { pre: LAZY() })).toBe(`LOADED ${list()}`)
      // In front of a node on PATH the function still runs first, as in beta.2.
      expect(run('with-node', { pre: LAZY() })).toBe(`LOADED ${list()}`)
    })

    // Mutation to prove this can fail: keep the alias when asking.
    it(`${shell}: a node that is only an alias: a notice and Claude Code directly, never a closed session; an alias in front of a node on PATH does not hide it`, () => {
      expect(run('without-node', { pre: ALIAS })).toBe(direct())
      expect(run('with-node', { pre: ALIAS })).toBe(list())
    })

    // Mutation to prove this can fail: drop the export from the line.
    it(`${shell}: a CCC_CLAUDE_BIN the session inherited is replaced by this session's Claude Code, for the list and for Claude Code started directly`, () => {
      const env = { CCC_CLAUDE_BIN: '/inherited/claude' }
      expect(run('with-node', { env })).toBe(list())
      expect(run('without-node', { env })).toBe(direct())
    })
  }
})
