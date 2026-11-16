#!/usr/bin/env node
// The slowest test files of one vitest run, read from its JSON report
// (vitest's own `json` reporter: `--reporter=json --outputFile.json=<file>`),
// written to the job summary and the log. ci.yml's Windows parts run it after
// the suite, so every run names the files that make a part slow, and a part
// that drifts toward its budget shows which file to split or speed up.
//
// It never fails the job: a missing or unreadable report is said, and it
// exits 0. Zero dependencies.
//
//   node scripts/ci/slow-test-files.mjs <report.json> [count] [title]   # env: GITHUB_STEP_SUMMARY

import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_COUNT = 15

/** A file path as the repository names it: relative to `root`, with forward slashes. */
export function repoPath(file, root) {
  const norm = (p) => String(p).replace(/\\/g, '/')
  const f = norm(file)
  const r = norm(root).replace(/\/+$/, '')
  return r !== '' && f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : f
}

/**
 * The files of a vitest JSON report, slowest first. A file's time is its
 * tests' time (endTime - startTime), as the default reporter prints it.
 *
 * @returns {{ files: Array<{ file: string, ms: number, tests: number, status: string }>, total: number, sumMs: number }}
 */
export function slowestFiles(report, count = DEFAULT_COUNT, root = process.cwd()) {
  const results = report && Array.isArray(report.testResults) ? report.testResults : []
  const files = []
  for (const r of results) {
    if (!r || typeof r.name !== 'string') continue
    const ms = Number(r.endTime) - Number(r.startTime)
    if (!Number.isFinite(ms) || ms < 0) continue
    files.push({ file: repoPath(r.name, root), ms, tests: Array.isArray(r.assertionResults) ? r.assertionResults.length : 0, status: typeof r.status === 'string' ? r.status : '' })
  }
  const sumMs = files.reduce((a, f) => a + f.ms, 0)
  files.sort((a, b) => b.ms - a.ms || (a.file < b.file ? -1 : 1))
  const n = Number.isInteger(count) && count > 0 ? count : DEFAULT_COUNT
  return { files: files.slice(0, n), total: files.length, sumMs }
}

const secs = (ms) => (ms / 1000).toFixed(1)

/** The job summary, as text. */
export function formatSlowest(s, title) {
  const head = `### Slowest test files${title ? `, ${title}` : ''}`
  if (s.total === 0) return `${head}\n\nNo file times were read from the report.\n`
  const lines = [head, '', `${s.total} files, ${secs(s.sumMs)} s of test time in all (files run side by side, so this is more than the step took).`, '', '| Seconds | Tests | File |', '|---:|---:|---|']
  for (const f of s.files) lines.push(`| ${secs(f.ms)} | ${f.tests} | \`${f.file}\`${f.status === 'failed' ? ' (failed)' : ''} |`)
  return lines.join('\n') + '\n'
}

export function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const log = io.log || ((s) => console.log(s))
  const write = io.write || ((file, text) => appendFileSync(file, text))
  const read = io.read || ((file) => readFileSync(file, 'utf8'))
  const [file, countArg, ...titleParts] = argv
  const title = titleParts.join(' ')
  let text
  try {
    if (!file) throw new Error('no report file was named')
    const s = slowestFiles(JSON.parse(read(file)), Number.parseInt(countArg ?? '', 10), io.root ?? process.cwd())
    text = formatSlowest(s, title)
  } catch (err) {
    text = `### Slowest test files${title ? `, ${title}` : ''}\n\nNo report was read (${err && err.message ? err.message : err}).\n`
  }
  log(text)
  try { if (env.GITHUB_STEP_SUMMARY) write(env.GITHUB_STEP_SUMMARY, text) } catch { /* the summary is a record only */ }
  return 0
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = main()
