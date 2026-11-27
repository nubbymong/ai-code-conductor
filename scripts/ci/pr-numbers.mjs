#!/usr/bin/env node
// "PR numbers": the few numbers a reviewer needs on every pull request, printed
// to the job summary (ADR-030, SDLC table: "a check that prints these numbers
// on every PR is its own slice"): how long src/main/pty-manager.ts is, against
// its cap.
//
// Until 2.1.3-beta.13 it also said whether a PR touched the files of the live
// SSH blast radius and whether the live SSH matrix was owed. That matrix is
// retired (owner, 2026-11-22; AGENTS.md, Release Process), so it says neither.
//
// The job FAILS only when pty-manager.ts grows past the cap. A PR that has to
// (a fix that cannot be smaller) carries the `cap-override` label and the
// summary says so.
//
// Like the Desktop test gate and the Test jobs' scope step, the job ALWAYS
// runs on a pull request and decides inside: a job-level path filter would
// leave a check that never reports. The changed paths are the difference
// between the PR's base (the merge commit's first parent) and the merge commit
// CI checked out, as in scripts/ci/change-scope.mjs. Anything this cannot read
// for certain is treated as touched (fail closed): the cap is checked.
//
// The cap started at the length of pty-manager.ts on beta when this check was
// added (ADR-030 gives that starting number once), and has been lowered since by
// each PR that shortened the file. PTY_MANAGER_LINE_CAP below is the ONE source
// of truth for it; nothing else in the repo restates the number. It may only go
// down: a PR that shortens pty-manager.ts should lower the constant with it.
// That is a reminder (a summary line and a warning annotation), not enforced:
// the job fails only for growing past the cap.
//
// Zero dependencies (plain node), like change-scope.mjs.
//
//   node scripts/ci/pr-numbers.mjs      # env: GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_STEP_SUMMARY

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { changedPaths } from './change-scope.mjs'

export const PTY_MANAGER = 'src/main/pty-manager.ts'
/**
 * The most lines pty-manager.ts may have. It started at the file's length on
 * beta when this check was added (ADR-030 states that starting value) and was
 * last lowered by the 2.1.3-beta.19 fix round after the host line, which moved
 * a Restart's resume-target read into restart-resume-target.ts (before it,
 * section 2, aicc_planning#439, moved a provider's direct launch into its
 * package's local launch group). Lower it, never raise it, whenever a PR
 * shortens the file.
 */
export const PTY_MANAGER_LINE_CAP = 7517
/** The PR label that lets pty-manager.ts grow past the cap. */
export const OVERRIDE_LABEL = 'cap-override'

/** Lines as `wc -l` counts them, plus a last line with no line end. */
export function countLines(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return text.charCodeAt(text.length - 1) === 10 ? n : n + 1
}

/**
 * The numbers and the verdict.
 *
 * @param {{ paths: string[]|null, ptyLines: number|null, baseLines: number|null, labels: string[] }} input
 *   paths: the PR's changed paths, null when they could not be read.
 *   ptyLines: length of pty-manager.ts in the PR's merge commit, null when unreadable.
 *   baseLines: its length on the base, null when unreadable.
 */
export function buildReport({ paths, ptyLines, baseLines, labels }) {
  const known = Array.isArray(paths)
  // Unreadable paths fail closed: pty-manager.ts counts as touched.
  const ptyTouched = known ? paths.includes(PTY_MANAGER) : true
  const override = Array.isArray(labels) && labels.includes(OVERRIDE_LABEL)

  const overBy = ptyLines === null ? null : ptyLines - PTY_MANAGER_LINE_CAP
  const grew = baseLines === null || ptyLines === null ? true : ptyLines > baseLines
  // Over the cap, in a PR that touches the file and did not shorten it.
  const exceeds = overBy !== null && overBy > 0 && ptyTouched && grew
  const unreadable = ptyLines === null
  const failed = (exceeds || unreadable) && !override

  let capVerdict
  if (unreadable) capVerdict = override ? `could not read the file (${OVERRIDE_LABEL} label: passing)` : 'FAIL: could not read src/main/pty-manager.ts'
  else if (exceeds) capVerdict = override ? `over the cap by ${overBy} (${OVERRIDE_LABEL} label: passing)` : `FAIL: over the cap by ${overBy}; shorten the file, or add the ${OVERRIDE_LABEL} label if this cannot be smaller`
  else if (overBy > 0) capVerdict = `over the cap by ${overBy}, but this PR does not make it longer`
  else if (overBy === 0) capVerdict = 'at the cap'
  else capVerdict = `${-overBy} under the cap`

  return {
    known,
    ptyTouched,
    ptyLines,
    baseLines,
    cap: PTY_MANAGER_LINE_CAP,
    overBy,
    override,
    exceeds,
    failed,
    capVerdict,
    // The cap is today's length and only goes down: a PR that shortens the file lowers it.
    // A PR that grows the file (but stays under the cap) is not told to give headroom away.
    lowerTheCap: !unreadable && overBy < 0 && ptyTouched && ptyLines > 0 && baseLines !== null && ptyLines < baseLines,
  }
}

const code = (s) => '`' + s + '`'

/** The Markdown the job summary shows. */
export function renderSummary(r) {
  const lengthCell =
    r.ptyLines === null
      ? 'unreadable'
      : `${r.ptyLines} lines, cap ${r.cap}` + (r.baseLines === null ? '' : `, ${r.ptyLines - r.baseLines >= 0 ? '+' : ''}${r.ptyLines - r.baseLines} against the base (${r.baseLines})`)
  const rows = [
    '### PR numbers',
    '',
    '| Check | Result |',
    '| --- | --- |',
    `| ${code(PTY_MANAGER)} length | ${lengthCell} |`,
    `| Cap | ${r.capVerdict} |`,
  ]
  if (!r.known) rows.push('', `Could not read the changed paths, so ${code(PTY_MANAGER)} counts as touched.`)
  if (r.override && r.exceeds) rows.push('', `The ${code(OVERRIDE_LABEL)} label is on this PR, so growing ${code(PTY_MANAGER)} past ${r.cap} lines does not fail the job. Say in the PR why the file could not be smaller.`)
  // When the file could not be read the label is the only reason the job passes, so it is never called unneeded then.
  else if (r.override && r.ptyLines !== null) rows.push('', `The ${code(OVERRIDE_LABEL)} label is on this PR; it is not needed here.`)
  if (r.lowerTheCap) rows.push('', `${code(PTY_MANAGER)} is now ${r.ptyLines} lines, under the cap of ${r.cap}: lower ${code('PTY_MANAGER_LINE_CAP')} in ${code('scripts/ci/pr-numbers.mjs')} to ${r.ptyLines} so it only goes down.`)
  return rows.join('\n') + '\n'
}

const defaultRunGit = (args) => execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })

/** The PR's base commit: the merge commit's first parent. Null when HEAD is not a two-parent merge. */
function baseCommit(runGit) {
  try {
    const parents = String(runGit(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(/\s+/)
    return parents.length === 3 ? parents[1] : null
  } catch {
    return null
  }
}

function labelsOf(event) {
  const labels = event && event.pull_request && event.pull_request.labels
  return Array.isArray(labels) ? labels.map((l) => (l && typeof l.name === 'string' ? l.name : '')).filter(Boolean) : []
}

/**
 * @param {Record<string,string|undefined>} env
 * @param {{ runGit?: (a: string[]) => string, readFile?: (p: string) => string, write?: (f: string, t: string) => void, log?: (s: string) => void, readEvent?: (p: string) => any }} io
 * @returns {number} the exit code
 */
export function main(env = process.env, io = {}) {
  const log = io.log || ((s) => console.log(s))
  const write = io.write || ((file, text) => appendFileSync(file, text))
  const readFile = io.readFile || ((p) => readFileSync(p, 'utf-8'))
  const readEvent = io.readEvent || ((p) => JSON.parse(readFileSync(p, 'utf-8')))
  const runGit = io.runGit || defaultRunGit

  if ((env.GITHUB_EVENT_NAME || '') !== 'pull_request') {
    log(`PR numbers: a ${env.GITHUB_EVENT_NAME || '(unknown)'} run is not a pull request; nothing to print.`)
    return 0
  }

  let paths = null
  let ptyLines = null
  let baseLines = null
  let labels = []
  try {
    paths = changedPaths(runGit)
  } catch {
    paths = null
  }
  try {
    ptyLines = countLines(readFile(PTY_MANAGER))
  } catch (err) {
    // A PR that deletes the file (the remote deletion, ADR-030) leaves nothing over the cap.
    // Absent counts as deleted only when the changed paths say the PR removed it; a file that is
    // missing for any other reason (the job started in the wrong folder) is unreadable and fails.
    ptyLines = err && err.code === 'ENOENT' && Array.isArray(paths) && paths.includes(PTY_MANAGER) ? 0 : null
  }
  // The base's length is only needed to tell "grew" from "did not", when the file is over the cap.
  const base = baseCommit(runGit)
  if (base) {
    try {
      baseLines = countLines(String(runGit(['show', `${base}:${PTY_MANAGER}`])))
    } catch {
      baseLines = null
    }
  }
  try {
    if (env.GITHUB_EVENT_PATH) labels = labelsOf(readEvent(env.GITHUB_EVENT_PATH))
  } catch {
    labels = []
  }

  const report = buildReport({ paths, ptyLines, baseLines, labels })
  const summary = renderSummary(report)
  log(summary)
  if (env.GITHUB_STEP_SUMMARY) write(env.GITHUB_STEP_SUMMARY, summary + '\n')
  // A reminder, not a failure: a shorter file should lower the cap in the same PR.
  if (report.lowerTheCap) log(`::warning title=lower the pty-manager.ts cap::${PTY_MANAGER} is ${report.ptyLines} lines, under the cap of ${report.cap}. Lower PTY_MANAGER_LINE_CAP in scripts/ci/pr-numbers.mjs to ${report.ptyLines}.`)
  if (report.failed) {
    log(`::error title=pty-manager.ts is over its cap::${PTY_MANAGER} is ${report.ptyLines === null ? 'unreadable' : `${report.ptyLines} lines; the cap is ${report.cap}`}. Make it shorter, or add the ${OVERRIDE_LABEL} label and say why in the PR.`)
    return 1
  }
  return 0
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = main()
