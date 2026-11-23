#!/usr/bin/env node
/**
 * Fails a Playwright run that was retried, that Playwright reported flaky, that
 * failed, or that ran nothing (plan 2.1.3-beta.16, section A1, rule 27;
 * aicc_planning#401). The snap-e2e job in ci.yml runs Playwright with
 * --retries=0 and then this, on the JSON report, so a test that passed only on
 * a second try can never read as a pass, even if a later config or command
 * line brings a retry back.
 *
 *   node scripts/ci/playwright-no-retry.mjs <playwright-report.json>
 *
 * Exit 0: every test ran once and passed, at least one test ran, and the
 * report has no error of its own. Exit 1: anything else, each reason on its
 * own line. Exit 2: no file named.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Every test in a report: the suites nest, each spec holds its tests. */
function testsOf(suites, out = []) {
  for (const suite of Array.isArray(suites) ? suites : []) {
    for (const spec of Array.isArray(suite?.specs) ? suite.specs : []) {
      for (const t of Array.isArray(spec?.tests) ? spec.tests : []) out.push({ title: String(spec.title ?? ''), test: t })
    }
    testsOf(suite?.suites, out)
  }
  return out
}

/** The judgement on one report: `ok` and one line per reason it is not. */
export function judgeReport(report) {
  const lines = []
  if (!report || typeof report !== 'object' || !report.stats || typeof report.stats !== 'object') {
    return { ok: false, lines: ['the report has no stats: Playwright did not write a whole report'] }
  }
  const stats = report.stats
  const tests = testsOf(report.suites)
  for (const { title, test } of tests) {
    const results = Array.isArray(test?.results) ? test.results : []
    if (results.length > 1 || results.some((r) => Number(r?.retry ?? 0) > 0)) lines.push(`retried: "${title}" ran ${results.length} times`)
    if (test?.status === 'flaky') lines.push(`flaky: "${title}"`)
    if (test?.status === 'unexpected') lines.push(`failed: "${title}"`)
  }
  if (Number(stats.flaky ?? 0) > 0) lines.push(`the report counts ${stats.flaky} flaky`)
  if (Number(stats.unexpected ?? 0) > 0) lines.push(`the report counts ${stats.unexpected} failed`)
  if (Number(stats.expected ?? 0) === 0) lines.push('no test passed: the run ran nothing, or skipped everything')
  const errors = Array.isArray(report.errors) ? report.errors : []
  if (errors.length > 0) lines.push(`the run itself reported ${errors.length} error(s): ${String(errors[0]?.message ?? '').split('\n')[0]}`)
  return { ok: lines.length === 0, lines: [...new Set(lines)] }
}

function main(argv) {
  const file = argv[0]
  if (!file) {
    console.error('usage: node scripts/ci/playwright-no-retry.mjs <playwright-report.json>')
    return 2
  }
  let report
  try {
    report = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    console.error(`no readable Playwright report at ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const { ok, lines } = judgeReport(report)
  if (ok) {
    console.log(`every test ran once and passed (${report.stats.expected} passed, ${report.stats.skipped ?? 0} skipped)`)
    return 0
  }
  for (const line of lines) console.error(line)
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)))
