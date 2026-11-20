import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { evalIf } from '../../helpers/gha-expr'

/**
 * .github/workflows/upstream-cli-watch.yml (aicc_planning#368): the daily check
 * of the newest Codex and Claude Code. GitHub runs a schedule, and a dispatch of
 * a workflow file, only from the DEFAULT branch's copy of the file (main), so
 * the file is read here as the one both branches carry: it checks beta out
 * itself, dispatches ci.yml on beta, and holds no logic of its own (the script
 * does). These cases hold the safety rules of the workflow as text GitHub will
 * run: least privilege per job, actions pinned by commit, no untrusted text in
 * a shell line, no secret but the two it names.
 */

const ROOT = resolve(__dirname, '../../..')
const FILE = '.github/workflows/upstream-cli-watch.yml'
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')
type Step = { name?: string; id?: string; if?: unknown; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; shell?: string; 'continue-on-error'?: unknown }
type Job = { name?: string; if?: unknown; needs?: string | string[]; steps: Step[]; permissions?: Record<string, string>; outputs?: Record<string, string>; 'runs-on'?: string; 'timeout-minutes'?: number; 'continue-on-error'?: unknown; env?: Record<string, string> }
type Workflow = { name: string; on: Record<string, unknown>; jobs: Record<string, Job>; concurrency?: { group: string; 'cancel-in-progress': unknown }; permissions?: unknown; env?: Record<string, string> }

const text = read(FILE)
// The file less its full-line comments: the header explains the rules in words that would trip a text match.
const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
const wf = yaml.load(text) as Workflow
const ci = yaml.load(read('.github/workflows/ci.yml')) as Workflow
const allSteps = Object.entries(wf.jobs).flatMap(([id, j]) => j.steps.map((s) => ({ id, step: s })))

describe('upstream-cli-watch.yml: when it runs', () => {
  it('runs once a day at an off-minute, and by hand; on no other event', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch'])
    const schedule = wf.on.schedule as Array<{ cron: string }>
    expect(schedule).toHaveLength(1)
    const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(schedule[0].cron)
    expect(m, `cron ${schedule[0].cron} is not a once-a-day schedule`).toBeTruthy()
    expect([0, 30], 'the top and the half hour are when every other schedule fires').not.toContain(Number(m![1]))
    expect(Number(m![1])).toBeLessThan(60)
    expect(Number(m![2])).toBeLessThan(24)
  })

  it('never has the triggers that run fork or attacker-written code with a token', () => {
    for (const bad of ['pull_request', 'pull_request_target', 'workflow_run', 'issue_comment', 'issues', 'push']) expect(wf.on[bad], bad).toBeUndefined()
    expect(code).not.toMatch(/pull_request_target/)
  })

  it('two runs never overlap, and a run in progress is not cancelled', () => {
    expect(wf.concurrency).toBeDefined()
    expect(wf.concurrency!.group).toBe('upstream-cli-watch')
    expect(wf.concurrency!['cancel-in-progress']).toBe(false)
  })
})

describe('upstream-cli-watch.yml: least privilege', () => {
  it('has no permission at the top, and each job names exactly what it needs', () => {
    expect(wf.permissions).toEqual({})
    expect(wf.jobs.plan.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(wf.jobs.check.permissions).toEqual({ contents: 'read', actions: 'write' })
    expect(wf.jobs.ticket.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(wf.jobs).sort()).toEqual(['check', 'plan', 'ticket'])
  })

  it('only the job that dispatches may write actions, and no job writes contents, issues, pull requests or packages', () => {
    for (const [id, job] of Object.entries(wf.jobs)) {
      for (const [scope, level] of Object.entries(job.permissions ?? {})) {
        if (level === 'write') expect([id, scope], `${id} writes ${scope}`).toEqual(['check', 'actions'])
      }
    }
  })

  it('every job has a timeout, and none continues on error', () => {
    for (const [id, job] of Object.entries(wf.jobs)) {
      expect(typeof job['timeout-minutes'], `${id} has no timeout`).toBe('number')
      expect(job['continue-on-error'], id).toBeUndefined()
      for (const s of job.steps) expect(s['continue-on-error'], `${id}: ${s.name}`).toBeUndefined()
    }
  })
})

describe('upstream-cli-watch.yml: nothing untrusted reaches a shell, and every action is pinned', () => {
  it('pins every action by its full commit sha, with the tag in a comment, and uses only the actions this repo already uses', () => {
    const uses = allSteps.map((s) => s.step.uses).filter((u): u is string => !!u)
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    for (const line of text.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l))) expect(line, line).toMatch(/@[0-9a-f]{40} # v\d+$/)
    // The same commits ci.yml pins (its helper and PR numbers jobs).
    const ciText = read('.github/workflows/ci.yml')
    for (const u of new Set(uses)) expect(ciText, `${u} is not a commit ci.yml already pins`).toContain(u)
  })

  it('has no ${{ }} expression in any shell line: every value reaches the script through env', () => {
    for (const { id, step } of allSteps) if (step.run !== undefined) expect(step.run, `${id}: ${step.name}`).not.toContain('${{')
    expect(allSteps.filter((s) => s.step.run !== undefined).length).toBeGreaterThan(0)
  })

  it('calls only the one script, with a constant mode, and nothing else in a run line', () => {
    const runs = allSteps.filter((s) => s.step.run !== undefined).map((s) => ({ id: s.id, run: s.step.run!.trim() }))
    expect(runs).toEqual([
      { id: 'plan', run: 'node scripts/ci/upstream-cli-watch.mjs plan' },
      { id: 'check', run: 'node scripts/ci/upstream-cli-watch.mjs check' },
      { id: 'ticket', run: 'node scripts/ci/upstream-cli-watch.mjs ticket' },
    ])
  })

  it('checks beta out, by name, without leaving the token on disk, in every job that runs the script', () => {
    for (const [id, job] of Object.entries(wf.jobs)) {
      const co = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'))
      expect(co, `${id} has no checkout`).toBeDefined()
      expect(co!.with, id).toEqual({ ref: 'beta', 'persist-credentials': false })
    }
  })

  it('names no secret but the job token and the optional planning-repo token, and hands the planning token to the ticket step only', () => {
    const found = [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1])
    expect([...new Set(found)].sort()).toEqual(['AICC_PLANNING_ISSUES_TOKEN', 'GITHUB_TOKEN'])
    for (const { id, step } of allSteps) {
      const hasPlanning = JSON.stringify(step.env ?? {}).includes('AICC_PLANNING_ISSUES_TOKEN')
      expect(hasPlanning, `${id}: ${step.name}`).toBe(id === 'ticket' && step.run?.includes(' ticket') === true)
    }
    for (const job of Object.values(wf.jobs)) expect(JSON.stringify(job.env ?? {})).not.toContain('secrets.')
    expect(JSON.stringify(wf.env ?? {})).not.toContain('secrets.')
  })

  it('writes no repository variable, secret or file back: no git push, no gh api or secret or variable call in the workflow', () => {
    expect(code).not.toMatch(/git\s+(push|commit|tag)/)
    expect(code).not.toMatch(/gh\s+(secret|variable|api)/)
  })
})

describe('upstream-cli-watch.yml: how the jobs hand over', () => {
  it('check runs only when the plan found a version, and ticket only after a red check', () => {
    expect(wf.jobs.check.needs).toBe('plan')
    const ctx = (any: string) => ({ needs: { plan: { result: 'success', outputs: { any } } } })
    expect(evalIf(wf.jobs.check.if, ctx('true'))).toBe(true)
    expect(evalIf(wf.jobs.check.if, ctx('false'))).toBe(false)
    expect(evalIf(wf.jobs.check.if, ctx(''))).toBe(false)
    const t = (check: string) => ({ needs: { plan: { result: 'success' }, check: { result: check, outputs: { failures: '[]' } } } })
    expect(evalIf(wf.jobs.ticket.if, t('failure'))).toBe(true)
    for (const r of ['success', 'skipped', 'cancelled']) expect(evalIf(wf.jobs.ticket.if, t(r)), r).toBe(false)
  })

  it('every value the script needs comes from the plan job or the job itself, through env', () => {
    const check = wf.jobs.check.steps.find((s) => s.run?.includes(' check'))!
    expect(check.env).toMatchObject({
      CODEX_VERSION: '${{ needs.plan.outputs.codex_version }}',
      CLAUDE_VERSION: '${{ needs.plan.outputs.claude_version }}',
      PREVIOUS_RECORD: '${{ needs.plan.outputs.record }}',
      WATCH_REF: 'beta',
    })
    expect(check.env!.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}')
    const ticket = wf.jobs.ticket.steps.find((s) => s.run?.includes(' ticket'))!
    expect(ticket.env).toMatchObject({ FAILURES: '${{ needs.check.outputs.failures }}', AICC_PLANNING_ISSUES_TOKEN: '${{ secrets.AICC_PLANNING_ISSUES_TOKEN }}' })
    for (const out of ['codex_version', 'claude_version', 'any', 'record']) expect(wf.jobs.plan.outputs![out], out).toContain('steps.plan.outputs.')
    expect(wf.jobs.check.outputs!.failures).toContain('steps.check.outputs.failures')
  })

  it('leaves the record as a run artifact, also when the check is red, and also on a day nothing is checked', () => {
    const uploads = (id: string) => wf.jobs[id].steps.filter((s) => s.uses?.startsWith('actions/upload-artifact@'))
    expect(uploads('check')).toHaveLength(1)
    expect(uploads('check')[0].if).toBe('always()')
    expect(uploads('check')[0].with).toMatchObject({ name: 'upstream-cli-watch-record', 'retention-days': 90 })
    expect(uploads('plan')).toHaveLength(1)
    expect(uploads('plan')[0].with).toMatchObject({ name: 'upstream-cli-watch-record', 'retention-days': 90 })
    expect(evalIf(uploads('plan')[0].if, { steps: { plan: { outputs: { any: 'false' } } } })).toBe(true)
    expect(evalIf(uploads('plan')[0].if, { steps: { plan: { outputs: { any: 'true' } } } })).toBe(false)
    expect(uploads('ticket')).toEqual([])
  })

  it('is the same file for both branches: it names no branch but beta, and no path that exists on only one', () => {
    for (const branch of code.match(/\b(?:ref|branches?):\s*\S+/g) ?? []) expect(branch).toMatch(/beta/)
    // ci.yml is what it dispatches; that file takes both inputs the script passes.
    expect((ci.on.workflow_dispatch as { inputs: Record<string, unknown> }).inputs).toHaveProperty('codex_rc_version')
    expect((ci.on.workflow_dispatch as { inputs: Record<string, unknown> }).inputs).toHaveProperty('claude_rc_version')
  })
})
