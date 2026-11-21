import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { join, resolve } from 'path'

/**
 * The parts of probe P20 (helper/probes/p20-probe.cjs and its stand-in model,
 * p20-model-stand-in.cjs; ADR-030, plan 2.1.3-beta.13 section C1) that decide
 * something without a real program: each question's outcome per run and its
 * verdict over the runs (the decision lines in the probe's header), and how
 * the stand-in reads a request (a turn that gets a tool call, the request that
 * carries the call's result, a turn that asks which tools it was given). The
 * probe itself is a measurement, run on the Windows test machine, not here.
 *
 * Not checked here: the CLIs themselves, the screens the probe answers on its
 * way to a prompt, the hook endpoint and the tool server as running programs,
 * the process clean-up (p19-record.cjs's code, tested in probe-p19-record.test.ts),
 * and the result's placeholders for personal paths beyond one sample.
 */

const PROBES = resolve(__dirname, '../../../helper/probes')
const req = createRequire(join(PROBES, 'p20-probe.cjs'))
type Hook = { path: string; t: number; event: string | null; heldMs?: number | null }
type Turn = { callAt?: number | null; resultAt?: number | null; ran?: boolean | null; noTool?: string | null; waitMs?: number }
type Reading = {
  turns?: Record<string, Turn>
  lists?: Record<string, { first: boolean | null; second: boolean | null }>
  hooks?: Hook[]
  server?: Array<{ label: string; ev: string; method?: string | null; t: number }>
  hookRows?: string[]
  rewrittenAt?: number | null
  reconnectAt?: number | null
  notifiedAt?: number | null
  firstList?: boolean | null
}
type V = { verdict: string; outcomes: string[] }
const P = req('./p20-probe.cjs') as {
  CASES: Array<{ id: string; cli: string; q: string; mode?: string }>
  pickCases: (only: string[] | null) => Array<{ id: string }>
  verdictA: (r: Reading[], runs: number) => V & { hookSeen: number; summary: string; waits: number[] }
  verdictACli: (byMode: Record<string, { outcomes: string[]; hookSeen: number }>) => { usable: boolean; line: string | null }
  verdictBSettings: (r: Reading[], runs: number) => V
  verdictBMcp: (r: Reading[], runs: number) => V & { startedOfItself: number }
  verdictC: (r: Reading[], runs: number) => V & { turnHalfMeasured: number }
  sanitizer: (pairs: Array<[string, string]>) => (v: unknown) => unknown
}
const S = req('./p20-model-stand-in.cjs') as {
  classifyAnthropic: (body: unknown) => { kind: string; run?: string; turn?: string; path?: string | null; ran?: boolean; callId?: string }
  classifyResponses: (body: unknown) => { kind: string; run?: string; turn?: string; ran?: boolean; callId?: string }
  codexShellCall: (tools: string[], platform: string) => { name: string; args: Record<string, unknown> } | null
  FILE_MARKER: string
}

const three = <T>(x: T): T[] => [x, x, x]
const ranTurn = (waitMs: number): Reading => ({ turns: { 1: { callAt: 1000, resultAt: 1000 + waitMs, ran: true, waitMs } }, hooks: [{ path: 'session', t: 1100, event: 'PreToolUse' }], hookRows: [] })

describe('P20 (a): the endpoint behaviour verdicts', () => {
  it('reads RUNS THE TOOL only when the file marker came back in 3 of 3 runs, with the wait range and the hook count', () => {
    const v = P.verdictA([ranTurn(200), ranTurn(900), ranTurn(400)], 3)
    expect(v.verdict).toBe('RUNS THE TOOL')
    expect(v.hookSeen).toBe(3)
    expect(v.summary).toContain('wait 0.2 to 0.9 s')
    // Another event of the session's is not the hook the control needs.
    expect(P.verdictA(three({ ...ranTurn(200), hooks: [{ path: 'session', t: 900, event: 'SessionStart' }] }), 3).hookSeen).toBe(0)
  })
  it('a result without the marker is BLOCKS THE TOOL; no result is STILL WAITING; no call is CANNOT MEASURE', () => {
    expect(P.verdictA(three({ turns: { 1: { callAt: 1, resultAt: 5, ran: false } } }), 3).verdict).toBe('BLOCKS THE TOOL')
    expect(P.verdictA(three({ turns: { 1: { callAt: 1, resultAt: null } } }), 3).verdict).toBe('STILL WAITING')
    expect(P.verdictA(three({ turns: { 1: { noTool: 'no Read tool among 0' } } }), 3).verdict).toBe('CANNOT MEASURE')
    expect(P.verdictA(three({ turns: {} }), 3).verdict).toBe('CANNOT MEASURE')
  })
  it('runs that disagree are NO VERDICT, and any count but 3 is a CHECK RUN', () => {
    expect(P.verdictA([ranTurn(1), ranTurn(1), { turns: { 1: { callAt: 1, resultAt: null } } }], 3).verdict).toBe('NO VERDICT')
    expect(P.verdictA([ranTurn(1)], 1).verdict).toBe('CHECK RUN (runs the tool in 1 runs)')
    expect(P.verdictA([ranTurn(1), ranTurn(1)], 3).verdict).toMatch(/^CHECK RUN/)
  })
  it('names how long the CLI held a request that was never answered, and the rows the screen showed about a hook', () => {
    const r: Reading = { ...ranTurn(600000), hooks: [{ path: 'session', t: 1, event: 'PreToolUse', heldMs: 600000 }], hookRows: ['PreToolUse hook error: timed out'] }
    const v = P.verdictA(three(r), 3)
    expect(v.summary).toContain('given up by the CLI after 600.0 to 600.0 s')
    expect(v.summary).toContain('"PreToolUse hook error: timed out"')
  })
  it('a CLI whose control did not run the tool with its hook seen in every run is CANNOT MEASURE as a whole', () => {
    const ran = ['ran', 'ran', 'ran']
    expect(P.verdictACli({ ok: { outcomes: ran, hookSeen: 3 } })).toEqual({ usable: true, line: null })
    expect(P.verdictACli({ ok: { outcomes: ran, hookSeen: 2 } }).line).toBe('CANNOT MEASURE (the control: ran, ran, ran; PreToolUse seen in 2 of 3)')
    expect(P.verdictACli({ ok: { outcomes: ['ran', 'ran', 'waiting'], hookSeen: 3 } }).usable).toBe(false)
    expect(P.verdictACli({ ok: { outcomes: [], hookSeen: 0 } }).usable).toBe(false)
    // A check run of one: the same rule over the runs it has.
    expect(P.verdictACli({ ok: { outcomes: ['ran'], hookSeen: 1 } }).usable).toBe(true)
    expect(P.verdictACli({})).toEqual({ usable: false, line: null })
  })
})

describe('P20 (b): does Claude Code read its files again', () => {
  const settings = (after: string[]): Reading => ({
    rewrittenAt: 5000,
    hooks: [{ path: 'one', t: 2000, event: 'PreToolUse' }, ...after.map((p, i) => ({ path: p, t: 6000 + i, event: 'PreToolUse' }))],
  })
  it('--settings: the second turn at the new URL only is READS AGAIN; at the old only READS ONCE; at neither HOOK DROPPED', () => {
    expect(P.verdictBSettings(three(settings(['two'])), 3).verdict).toBe('READS AGAIN')
    expect(P.verdictBSettings(three(settings(['one'])), 3).verdict).toBe('READS ONCE')
    expect(P.verdictBSettings(three(settings([])), 3).verdict).toBe('HOOK DROPPED')
    expect(P.verdictBSettings(three(settings(['one', 'two'])), 3).outcomes).toEqual(['both', 'both', 'both'])
  })
  it('--settings: no first-turn hook before the change is CANNOT MEASURE; mixed runs NO VERDICT', () => {
    expect(P.verdictBSettings(three({ rewrittenAt: 5000, hooks: [{ path: 'two', t: 6000, event: 'PreToolUse' }] }), 3).verdict).toBe('CANNOT MEASURE')
    expect(P.verdictBSettings([settings(['two']), settings(['two']), settings(['one'])], 3).verdict).toBe('NO VERDICT')
  })
  const mcp = (starts: string[], before: string[] = []): Reading => ({
    firstList: true, rewrittenAt: 3000, reconnectAt: 9000,
    server: [{ label: 'one', ev: 'start', t: 100 }, ...before.map((l) => ({ label: l, ev: 'start', t: 4000 })), ...starts.map((l) => ({ label: l, ev: 'start', t: 9500 }))],
  })
  it('--mcp-config: after the reconnect the new server only is READS AGAIN; the old only READS ONCE; neither NO RECONNECT', () => {
    expect(P.verdictBMcp(three(mcp(['two'])), 3).verdict).toBe('READS AGAIN')
    expect(P.verdictBMcp(three(mcp(['one'])), 3).verdict).toBe('READS ONCE')
    expect(P.verdictBMcp(three(mcp([])), 3).verdict).toBe('NO RECONNECT')
    expect(P.verdictBMcp(three({ ...mcp(['two']), firstList: false }), 3).verdict).toBe('CANNOT MEASURE')
  })
  it('--mcp-config: a server started before /mcp is counted apart and is not the reconnect', () => {
    const v = P.verdictBMcp(three(mcp([], ['one'])), 3)
    expect(v.verdict).toBe('NO RECONNECT')
    expect(v.startedOfItself).toBe(3)
  })
})

describe('P20 (c): tools/list_changed', () => {
  const run = (relistAt: number | null, first: boolean, second: boolean): Reading => ({
    firstList: true, notifiedAt: 10000,
    server: [{ label: 'one', ev: 'method', method: 'tools/list', t: 500 }, ...(relistAt === null ? [] : [{ label: 'one', ev: 'method', method: 'tools/list', t: relistAt }])],
    lists: { 1: { first, second: false }, 2: { first, second } },
  })
  it('a second tools/list within 10 s and the new tool in the next turn, in 3 of 3, is LISTS AGAIN', () => {
    expect(P.verdictC(three(run(10400, true, true)), 3).verdict).toBe('LISTS AGAIN')
  })
  it('neither is DOES NOT LIST AGAIN; a tools/list after 10 s does not count', () => {
    expect(P.verdictC(three(run(null, true, false)), 3).verdict).toBe('DOES NOT LIST AGAIN')
    expect(P.verdictC(three(run(20001, true, false)), 3).verdict).toBe('DOES NOT LIST AGAIN')
  })
  it('a list sent again with the tool missing from the turn is its own outcome, so the case is NO VERDICT', () => {
    const v = P.verdictC(three(run(10400, true, false)), 3)
    expect(v.outcomes).toEqual(['listed, not in the turn', 'listed, not in the turn', 'listed, not in the turn'])
    expect(v.verdict).toBe('NO VERDICT')
  })
  it('the added tool in the next turn with no tools/list in the window is its own outcome, so the case is NO VERDICT', () => {
    const v = P.verdictC(three(run(null, true, true)), 3)
    expect(v.outcomes).toEqual(['in the turn, not listed', 'in the turn, not listed', 'in the turn, not listed'])
    expect(v.verdict).toBe('NO VERDICT')
    expect(P.verdictC(three(run(20001, true, true)), 3).verdict).toBe('NO VERDICT')
  })
  it('a first turn that never named the first tool leaves the outcome on tools/list alone', () => {
    const v = P.verdictC(three(run(10400, false, false)), 3)
    expect(v.verdict).toBe('LISTS AGAIN')
    expect(v.turnHalfMeasured).toBe(0)
    expect(P.verdictC(three({ ...run(10400, true, true), firstList: false }), 3).verdict).toBe('CANNOT MEASURE')
  })
})

describe('P20 stand-in model: what a request asks for', () => {
  const tools = [{ name: 'Read' }, { name: 'Bash' }]
  it('Claude Code: a streamed turn naming the prompt gets a tool call with the path; the next request carries its result', () => {
    const turn = S.classifyAnthropic({ stream: true, tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'p20 tool p20claudeaok1 1: read C:\\t\\work\\p20-file.txt' }] }] })
    expect(turn).toMatchObject({ kind: 'tool', run: 'p20claudeaok1', turn: '1', path: 'C:\\t\\work\\p20-file.txt' })
    const result = S.classifyAnthropic({
      stream: true, tools,
      messages: [
        { role: 'user', content: 'p20 tool p20claudeaok1 1: read C:\\t\\work\\p20-file.txt' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p20_7', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p20_7', content: `1\t${S.FILE_MARKER}` }] },
      ],
    })
    expect(result).toMatchObject({ kind: 'result', callId: 'toolu_p20_7', ran: true })
    const blocked = S.classifyAnthropic({ stream: true, tools, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p20_8', is_error: true, content: 'blocked by a hook' }] }] })
    expect(blocked).toMatchObject({ kind: 'result', ran: false })
  })
  it('Claude Code: a request with no tools, or not streamed, is not a turn', () => {
    const messages = [{ role: 'user', content: 'p20 tool p20x 1: read C:\\x\\p20-file.txt' }]
    expect(S.classifyAnthropic({ stream: true, tools: [], messages }).kind).toBe('ok')
    expect(S.classifyAnthropic({ stream: false, tools, messages }).kind).toBe('ok')
  })
  it('Codex: the newest user message is the turn unless the model or a tool answered after it; a call output is the result', () => {
    const t = [{ type: 'function', name: 'shell_command' }]
    const prompt = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'p20 list p20codexc1 2' }] }
    expect(S.classifyResponses({ tools: t, input: [prompt] })).toMatchObject({ kind: 'list', run: 'p20codexc1', turn: '2' })
    expect(S.classifyResponses({ tools: t, input: [prompt, { type: 'message', role: 'assistant', content: [] }] }).kind).toBe('ok')
    expect(S.classifyResponses({ tools: t, input: [prompt, { type: 'function_call_output', call_id: 'call_p20_3', output: S.FILE_MARKER }] })).toMatchObject({ kind: 'result', ran: true })
    expect(S.classifyResponses({ tools: t, input: [prompt, { type: 'function_call_output', call_id: 'call_p20_4', output: 'blocked by a hook' }] })).toMatchObject({ kind: 'result', callId: 'call_p20_4', ran: false })
    expect(S.classifyResponses({ tools: [], input: [prompt] }).kind).toBe('ok')
  })
  it('Codex: the shell tool it offers, with the arguments that read the file', () => {
    expect(S.codexShellCall(['shell_command', 'update_plan'], 'win32')).toEqual({ name: 'shell_command', args: { command: 'type p20-file.txt' } })
    expect(S.codexShellCall(['exec_command'], 'linux')).toEqual({ name: 'exec_command', args: { cmd: 'cat p20-file.txt' } })
    expect(S.codexShellCall(['shell'], 'win32')).toEqual({ name: 'shell', args: { command: ['cmd.exe', '/c', 'type p20-file.txt'] } })
    expect(S.codexShellCall(['update_plan'], 'win32')).toBeNull()
  })
})

describe('P20: the cases and the result', () => {
  it('has the five endpoint behaviours per CLI, the two Claude Code file cases and the list case per CLI', () => {
    expect(P.CASES.map((c) => c.id)).toEqual([
      'claude-a-ok', 'claude-a-refused', 'claude-a-401', 'claude-a-404', 'claude-a-never',
      'codex-a-ok', 'codex-a-refused', 'codex-a-401', 'codex-a-404', 'codex-a-never',
      'claude-b-settings', 'claude-b-mcp', 'claude-c', 'codex-c',
    ])
    expect(P.pickCases(['claude-a']).map((c) => c.id)).toHaveLength(5)
    expect(P.pickCases(['codex-c', 'claude-b-mcp']).map((c) => c.id)).toEqual(['claude-b-mcp', 'codex-c'])
  })
  it('writes a path as its placeholder in every form the result can hold it', () => {
    const clean = P.sanitizer([['C:\\Users\\someone\\AppData\\Local\\Temp\\p20-abc', '<temp>']])
    expect(clean({ a: 'C:\\Users\\someone\\AppData\\Local\\Temp\\p20-abc\\x', b: ['C:/Users/someone/AppData/Local/Temp/p20-abc/y'], c: 'C:\\\\Users\\\\someone\\\\AppData\\\\Local\\\\Temp\\\\p20-abc' }))
      .toEqual({ a: '<temp>\\x', b: ['<temp>/y'], c: '<temp>' })
  })
})
