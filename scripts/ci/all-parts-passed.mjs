#!/usr/bin/env node
// `Test (windows-2025)` is a required check (ADR-028). The Windows suite runs
// in parts, each a job of its own (ci.yml): `test-windows-part` splits the unit
// suite with vitest --shard, and `test-windows-build` runs the typecheck, the
// native tests, the build and, on a release/* branch, the installer. The job
// named `Test (windows-2025)` needs all of them, starts whatever they ended
// with (`always()`, a run cancelled as a whole included), and runs this, so
// the required check passes only when every part did.
//
// It passes only when all of this holds:
//   1. NEEDS (the job's `needs` context, as JSON) names exactly the jobs in
//      EXPECT, no more and no fewer;
//   2. each of them ended with the result `success`. Failed, cancelled (a
//      timeout included) and skipped all fail here: a job skipped by its
//      condition reports as passed, so a part that never ran must not pass;
//   3. they agree on the scope (scripts/ci/change-scope.mjs): every one says
//      suite=false (a documentation-only change, the suite skipped) or none
//      does.
// It then writes suite=true or suite=false to GITHUB_OUTPUT. The step that
// names the tested tree, which a beta release reads to reuse this run
// (scripts/ci/reuse-green-ci.mjs), runs only on suite=true, as it does in the
// other Test jobs.
//
// Anything it cannot read fails the check. Zero dependencies.
//
//   node scripts/ci/all-parts-passed.mjs   # env: NEEDS, EXPECT, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY

import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * @param {unknown} needs     the `needs` context: { [jobId]: { result, outputs } }
 * @param {string[]} expected the job ids that must be there
 * @returns {{ ok: boolean, suite: boolean|null, problems: string[], rows: Array<{ id: string, result: string, suite: string }> }}
 */
export function decideParts(needs, expected) {
  const fail = (problems, rows = []) => ({ ok: false, suite: null, problems, rows })
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) return fail(['the needs context could not be read'])
  const want = Array.isArray(expected) ? [...new Set(expected.filter((id) => typeof id === 'string' && id !== ''))] : []
  if (want.length === 0) return fail(['no job is named in EXPECT'])
  const problems = []
  const rows = []
  for (const id of Object.keys(needs)) if (!want.includes(id)) problems.push(`${id} is needed but not in EXPECT`)
  const skippedSuite = []
  for (const id of want) {
    const need = needs[id]
    if (need === undefined) { problems.push(`${id} is not among the jobs this one needs`); continue }
    if (!need || typeof need !== 'object') { problems.push(`${id} could not be read`); continue }
    const result = typeof need.result === 'string' && need.result !== '' ? need.result : 'unknown'
    const outputs = need.outputs && typeof need.outputs === 'object' ? need.outputs : {}
    const suite = typeof outputs.suite === 'string' ? outputs.suite : ''
    rows.push({ id, result, suite })
    if (result !== 'success') problems.push(`${id} is ${result}, not success`)
    // Only the literal 'false' says the suite was skipped, as in every step of those jobs.
    skippedSuite.push(suite === 'false')
  }
  if (problems.length === 0 && skippedSuite.some(Boolean) && !skippedSuite.every(Boolean)) {
    problems.push('the parts disagree on the scope: some skipped the suite as documentation only, some ran it')
  }
  if (problems.length > 0) return fail(problems, rows)
  return { ok: true, suite: !skippedSuite.every(Boolean), problems: [], rows }
}

/** The job summary, as text. */
export function formatParts(d) {
  const lines = [d.ok ? '### Every Windows part passed' : '### Not every Windows part passed', '', '| Job | Result | Suite |', '|---|---|---|']
  for (const r of d.rows) lines.push(`| ${r.id} | ${r.result} | ${r.suite === 'false' ? 'skipped (documentation only)' : 'ran'} |`)
  if (d.rows.length === 0) lines.push('| (none read) | | |')
  if (!d.ok) lines.push('', ...d.problems.map((p) => `- ${p}`))
  return lines.join('\n') + '\n'
}

export function main(env = process.env, io = {}) {
  const log = io.log || ((s) => console.log(s))
  const write = io.write || ((file, text) => appendFileSync(file, text))
  let needs = null
  try { needs = JSON.parse(env.NEEDS ?? '') } catch { needs = null }
  const expected = String(env.EXPECT ?? '').split(/\s+/).filter((s) => s !== '')
  const d = decideParts(needs, expected)
  for (const r of d.rows) log(`${r.id}: ${r.result}${r.suite === 'false' ? ' (suite skipped: documentation only)' : ''}`)
  try { if (env.GITHUB_STEP_SUMMARY) write(env.GITHUB_STEP_SUMMARY, formatParts(d)) } catch { /* the summary is a record, not the decision */ }
  if (!d.ok) {
    for (const p of d.problems) log(`::error::${p}`)
    return 1
  }
  // No output, no pass: the tree step must never run on a decision that was
  // not written. With no output, its condition (suite != 'false') would be
  // true, and a run that skipped the suite would name a tree.
  if (!env.GITHUB_OUTPUT) {
    log('::error::GITHUB_OUTPUT is not set; the decision cannot be handed to the tree step')
    return 1
  }
  log(d.suite ? 'Every Windows part passed, and the suite ran.' : 'Every Windows part passed; the suite was skipped (documentation only).')
  try { write(env.GITHUB_OUTPUT, `suite=${d.suite ? 'true' : 'false'}\n`) } catch (err) { log(`::error::could not write the step output: ${err && err.message}`); return 1 }
  return 0
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = main()
