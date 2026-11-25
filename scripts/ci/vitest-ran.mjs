#!/usr/bin/env node
/**
 * Read a vitest JSON report and fail unless at least one test ran and every
 * test that ran passed (plan 2.1.3-beta.17, section A2: the remote-helper-e2e
 * job must fail when no test ran, rule 27's retries-off rule beside it).
 *
 *   node scripts/ci/vitest-ran.mjs <report.json>
 *
 * Exit 0: one test or more, all passed. 1: none ran, one did not pass, or a
 * test was retried. 2: the report cannot be read.
 */
import { readFileSync } from 'node:fs'

export function judge(report) {
  const total = Number(report?.numTotalTests ?? 0)
  const passed = Number(report?.numPassedTests ?? 0)
  const failed = Number(report?.numFailedTests ?? 0)
  const retried = (report?.testResults ?? []).flatMap((f) => f?.assertionResults ?? []).filter((a) => Number(a?.retryCount ?? 0) > 0).length
  if (total === 0) return { ok: false, why: 'no test ran' }
  if (retried > 0) return { ok: false, why: `${retried} test(s) were retried` }
  if (failed > 0 || passed !== total) return { ok: false, why: `${passed} of ${total} tests passed` }
  return { ok: true, why: `${passed} of ${total} tests passed` }
}

if ((process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ci/vitest-ran.mjs')) {
  let report
  try {
    report = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  } catch (err) {
    console.error(`vitest-ran: the report cannot be read (${err.message})`)
    process.exit(2)
  }
  const r = judge(report)
  console.log(`vitest-ran: ${r.why}`)
  process.exit(r.ok ? 0 : 1)
}
