// P3.9 round 3 (L5): every feature Sentinel's analysis run disables is one
// both supported CLIs know (their `codex features list`, captured as
// fixtures), since an unknown name fails the run; the two it leaves out are
// listed as removed (off) in both. 2.1.3-beta.8: the review, analysis and
// Insights runs turn off more agent features (multi_agent_v2, sleep_tool, and
// agents.enabled=false in the config), and the review names no model.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexCommandLine } from '../../../../src/main/providers/codex'

const features = (version: string) => {
  const text = readFileSync(join(__dirname, `../../../fixtures/codex/cli/${version}/help/features-list.txt`), 'utf8')
  const out = new Map<string, { stage: string; on: boolean }>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z0-9_]+)\s+(.+?)\s+(true|false)\s*$/.exec(line)
    if (m) out.set(m[1], { stage: m[2], on: m[3] === 'true' })
  }
  return out
}

const VERSIONS = ['0.153.4', '0.155.1']
const argvOf = (op: 'review' | 'analysis' | 'insights'): readonly string[] => {
  const cmd = codexCommandLine('/usr/bin/codex', op, 'linux', {})
  return 'refused' in cmd ? [] : cmd.args
}
const disabledIn = (a: readonly string[]) => a.flatMap((x, i) => (a[i - 1] === '--disable' ? [x] : []))
const overridesIn = (a: readonly string[]) => a.flatMap((x, i) => (a[i - 1] === '-c' ? [x] : []))

describe("the analysis run's disabled features (P3.9 round 3)", () => {
  const disabled = disabledIn(argvOf('analysis'))

  for (const version of VERSIONS) {
    it(`every name is one Codex ${version} lists; code_mode_host (on by default) is among them`, () => {
      const list = features(version)
      expect(list.size).toBeGreaterThan(20)
      for (const name of disabled) expect(list.has(name), name).toBe(true)
      expect(disabled).toEqual(expect.arrayContaining(['code_mode', 'code_mode_host']))
      expect(list.get('code_mode_host')).toEqual({ stage: 'stable', on: true })
      // Left out: removed, and off, in this version.
      for (const name of ['js_repl', 'apply_patch_freeform']) {
        expect(disabled).not.toContain(name)
        expect(list.get(name)).toEqual({ stage: 'removed', on: false })
      }
    })
  }
})

// The reviewer runs no tool either: its change is in its request. An unknown
// feature name fails the run, so every name it turns off is one both
// supported CLIs list, and the set is the analysis run's own.
describe("the review run's disabled features", () => {
  const args = argvOf('review')
  const disabled = disabledIn(args)
  const analysisArgs = argvOf('analysis')
  const analysisDisabled = disabledIn(analysisArgs)

  for (const version of VERSIONS) {
    it(`every name is one Codex ${version} lists, and the set is the analysis run's`, () => {
      const list = features(version)
      expect(disabled.length).toBeGreaterThan(10)
      for (const name of disabled) expect(list.has(name), name).toBe(true)
      expect([...disabled].sort()).toEqual([...analysisDisabled].sort())
      // Each tool a reviewer could run a command with is on by default (stable), so it must be named.
      for (const name of ['shell_tool', 'unified_exec', 'code_mode_host']) {
        expect(disabled).toContain(name)
        expect(list.get(name)?.on, name).toBe(true)
      }
    })
  }

  it("its config overrides are exactly web search off, medium reasoning effort and agents off; web search and agents as the analysis run passes them", () => {
    expect([...overridesIn(args)].sort()).toEqual(['agents.enabled=false', 'model_reasoning_effort=medium', 'web_search=disabled'])
    for (const o of ['web_search=disabled', 'agents.enabled=false']) expect(overridesIn(analysisArgs)).toContain(o)
  })
})

// 2.1.3-beta.8: a review runs on the reviewer account's default Codex model.
describe('the review run names no model (2.1.3-beta.8)', () => {
  it('its argv has no -m or --model, and no override picks a model', () => {
    const args = argvOf('review')
    expect(args.length).toBeGreaterThan(10)
    expect(args).not.toContain('-m')
    expect(args).not.toContain('--model')
    expect(args.some((a) => /^--model=/.test(a))).toBe(false)
    expect(overridesIn(args).filter((o) => /^model=/.test(o))).toEqual([])
    expect(args.join(' ')).not.toMatch(/gpt/i)
  })
})

// 2.1.3-beta.8: more agent features off in the three background runs.
describe('more agent features off in the review, analysis and Insights runs (2.1.3-beta.8)', () => {
  for (const op of ['review', 'analysis', 'insights'] as const) {
    for (const version of VERSIONS) {
      it(`the ${op} run turns off multi_agent_v2 and sleep_tool, and every name it turns off is one Codex ${version} lists`, () => {
        const list = features(version)
        const disabled = disabledIn(argvOf(op))
        expect(disabled.length).toBeGreaterThan(10)
        for (const name of disabled) expect(list.has(name), `${op}: ${name}`).toBe(true)
        expect(disabled).toEqual(expect.arrayContaining(['multi_agent', 'multi_agent_v2', 'sleep_tool']))
      })
    }

    it(`the ${op} run carries agents.enabled=false`, () => {
      expect(overridesIn(argvOf(op))).toContain('agents.enabled=false')
    })
  }
})
