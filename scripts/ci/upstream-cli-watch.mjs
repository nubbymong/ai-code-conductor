#!/usr/bin/env node
// The daily upstream CLI watch (aicc_planning#368). A new Codex or Claude Code
// release used to be found by chance (Codex 0.157.1 broke several features and
// was found by hand). Once a day this finds the newest published version of each
// CLI, compares it with the newest version the app was tested with, and, when it
// is newer and not already checked green, runs the real-CLI conformance jobs of
// ci.yml against it and says what failed.
//
// The workflow (.github/workflows/upstream-cli-watch.yml) only calls this script
// and gh; the logic is here so it is tested with no network
// (tests/unit/scripts/upstream-cli-watch.test.ts injects npm, gh, the files and
// the clock). Three modes, one per job:
//
//   plan     look up the newest Codex and Claude Code with `npm view <package>
//            version` (what the app's own install recipes install:
//            src/main/providers/*/install-recipes.ts), read the tested-up-to
//            versions from the app's code, read the record of versions already
//            checked, decide what to run. Outputs: codex_version, claude_version
//            (empty when nothing to check), any, record. [actions: read]
//   check    dispatch ci.yml on beta with the versions to check
//            (codex_rc_version, claude_rc_version), wait for that one run, read
//            each CLI's rc legs, write the record and the job summary, and FAIL
//            when anything failed. Output: failures. [actions: write, because it
//            dispatches]
//   ticket   OPTIONAL and dormant: when the secret AICC_PLANNING_ISSUES_TOKEN is
//            set, open or update ONE issue per failing CLI version in the private
//            aicc_planning repository (found by its exact title first, never a
//            second one). Without the secret it says so in one line. The default
//            GITHUB_TOKEN cannot write to that repository, so this step is the
//            only one that ever uses the secret, and it never asks for or
//            handles one any other way.
//
// WHERE THE TESTED-UP-TO VERSION LIVES (read from the code, not restated here):
//   Codex        CODEX_MAX_TESTED_VERSION in src/main/providers/codex/cli-contract.ts:
//                the newest release the managed flows were tested on.
//   Claude Code  the app declares NO tested-up-to version ("No tested CLI version
//                range is declared yet", src/main/providers/claude/index.ts). The
//                only Claude Code version its evidence names is the managed-launch
//                floor, CLAUDE_MIN_MANAGED_CLI_VERSION in src/main/providers/
//                claude/managed-launch.ts (2.1.278: every managed-launch fact was
//                measured on it). That is the baseline; so the newest Claude Code
//                is checked until the record holds it green, and raising a
//                tested-up-to number for Claude Code on that evidence is a later,
//                separate decision.
//
// WHY THE RECORD IS AN ARTIFACT. A version is not run again once it was checked
// green. Each run leaves `record.json` as the run artifact `upstream-cli-watch-
// record`; the next run reads it from the newest earlier run that left one (also
// a red run: it still says which versions were checked, and reading only green
// runs would run an already-green Codex again every day while Claude Code stays
// red). A version checked RED is run again the next day, so a fix shows up as
// green with no one asking. The record is read only from the watch's own
// scheduled or manually started runs. Nothing here commits, pushes, writes a
// repository variable or a secret.
//
// WHY ci.yml IS DISPATCHED ON BETA. GitHub runs a schedule, and a dispatch of a
// workflow file, from the DEFAULT branch's copy of that file (main). The newest
// app code is on beta, so the workflow runs from main's copy of itself and
// dispatches ci.yml with `--ref beta`: the newest app code against the newest
// CLI. ci.yml's dispatch validates its inputs against the ref's own copy.
//
// The version strings from npm go through a strict semver check before any use;
// they and every other value reach this script through env, never a shell line.
//
// Zero dependencies (plain node), like the other scripts in scripts/ci/.
//
//   node scripts/ci/upstream-cli-watch.mjs plan|check|ticket
//
// Env: GH_TOKEN, GH_REPO (gh reads them); GITHUB_OUTPUT, GITHUB_STEP_SUMMARY,
// RUNNER_TEMP, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID (the runner's);
// check: CODEX_VERSION, CLAUDE_VERSION, PREVIOUS_RECORD, WATCH_REF (default beta),
// WATCH_WAIT_MINUTES (default 70); ticket: FAILURES, WATCH_RUN_URL,
// AICC_PLANNING_ISSUES_TOKEN.

import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const run = promisify(execFile)

export const CI_WORKFLOW = 'ci.yml'
export const WATCH_WORKFLOW = 'upstream-cli-watch.yml'
export const RECORD_ARTIFACT = 'upstream-cli-watch-record'
export const RECORD_FILE = 'record.json'
export const PLANNING_REPO = 'nubbymong/aicc_planning'
/** The operating systems ci.yml's rc legs run on (held to ci.yml by a test). */
export const RC_OSES = Object.freeze(['windows-2025', 'macos-latest', 'ubuntu-latest'])
const MAX_ENTRIES = 200

export const CLIS = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    npm: '@openai/codex',
    input: 'codex_rc_version',
    legPrefix: 'Codex CLI rc (',
    testedFile: 'src/main/providers/codex/cli-contract.ts',
    testedConst: 'CODEX_MAX_TESTED_VERSION',
    testedNote: 'the newest Codex the managed flows were tested on',
  }),
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    npm: '@anthropic-ai/claude-code',
    input: 'claude_rc_version',
    legPrefix: 'Claude Code CLI rc (',
    testedFile: 'src/main/providers/claude/managed-launch.ts',
    testedConst: 'CLAUDE_MIN_MANAGED_CLI_VERSION',
    testedNote: 'the managed-launch floor: the app declares no newer tested Claude Code version',
  }),
})

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

/** A plain semver and nothing else (no leading v, no build metadata, no
 *  whitespace): a version becomes an npm package spec and a gh input value. */
export const isVersion = (v) => typeof v === 'string' && v.length <= 64 && SEMVER.test(v)

/** Semver precedence: the numbers, then a release above its prereleases, then
 *  the prerelease identifiers (numbers below words). < 0, 0 or > 0. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(a)
  const pb = SEMVER.exec(b)
  if (!pa || !pb) throw new TypeError(`not a plain semver: ${JSON.stringify(pa ? b : a)}`)
  for (let i = 1; i <= 3; i += 1) {
    const d = BigInt(pa[i]) - BigInt(pb[i])
    if (d !== 0n) return d < 0n ? -1 : 1
  }
  if (!pa[4] && !pb[4]) return 0
  if (!pa[4]) return 1
  if (!pb[4]) return -1
  const xa = pa[4].split('.')
  const xb = pb[4].split('.')
  for (let i = 0; i < Math.max(xa.length, xb.length); i += 1) {
    if (xa[i] === undefined) return -1
    if (xb[i] === undefined) return 1
    const na = /^\d+$/.test(xa[i])
    const nb = /^\d+$/.test(xb[i])
    if (na && nb) {
      const d = BigInt(xa[i]) - BigInt(xb[i])
      if (d !== 0n) return d < 0n ? -1 : 1
    } else if (na !== nb) return na ? -1 : 1
    else if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1
  }
  return 0
}

/** The tested-up-to version of each CLI, read from the app's own code. */
export function readTested(readRepoFile) {
  const out = {}
  for (const cli of Object.values(CLIS)) {
    let src
    try { src = readRepoFile(cli.testedFile) } catch (err) { throw new Error(`cannot read ${cli.testedFile}, where the watch reads ${cli.label}'s tested-up-to version: ${err && err.message ? err.message : err}`) }
    const m = new RegExp(`^export const ${cli.testedConst} = '([^']+)'`, 'm').exec(src)
    if (!m || !isVersion(m[1])) throw new Error(`${cli.testedFile} has no ${cli.testedConst} written as a plain semver, which is where the watch reads ${cli.label}'s tested-up-to version (${cli.testedNote})`)
    out[cli.id] = m[1]
  }
  return out
}

/** The newest published version, the way the app's own recipes install it. */
async function lookupLatest(cli, deps) {
  const out = String(await deps.npm(['view', cli.npm, 'version'])).trim()
  if (!isVersion(out)) throw new Error(`npm view ${cli.npm} version printed ${JSON.stringify(out.slice(0, 80))}, which is not a plain semver`)
  return out
}

// ---------------------------------------------------------------------------
// The record of checked versions
// ---------------------------------------------------------------------------
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const RUN_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/

const emptyRecord = () => ({ schema: 1, entries: [] })

/** A record, from its text. Anything that is not exactly what this script
 *  writes is refused, so a damaged record is never taken for history. */
export function parseRecord(text) {
  let data
  try { data = JSON.parse(text) } catch { throw new Error('the record is not valid JSON') }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.schema !== 1 || !Array.isArray(data.entries)) throw new Error('the record has the wrong shape (schema 1 with a list of entries)')
  if (data.entries.length > MAX_ENTRIES) throw new Error(`the record holds more than ${MAX_ENTRIES} entries`)
  const entries = data.entries.map((e, i) => {
    if (!e || typeof e !== 'object') throw new Error(`record entry ${i} is not an object`)
    if (!Object.prototype.hasOwnProperty.call(CLIS, e.cli)) throw new Error(`record entry ${i} names an unknown CLI`)
    if (!isVersion(e.version)) throw new Error(`record entry ${i} has a version that is not a plain semver`)
    if (e.result !== 'green' && e.result !== 'red') throw new Error(`record entry ${i} has a result that is not green or red`)
    if (typeof e.at !== 'string' || !ISO_TIME.test(e.at)) throw new Error(`record entry ${i} has no valid time`)
    if (e.ciRun !== undefined && e.ciRun !== null && !(typeof e.ciRun === 'string' && RUN_URL.test(e.ciRun))) throw new Error(`record entry ${i} has a run link that is not a GitHub Actions run`)
    return { cli: e.cli, version: e.version, result: e.result, at: e.at, ciRun: e.ciRun ?? null }
  })
  return { schema: 1, entries }
}

/** The entry that says this CLI version was checked green, or null. */
export function recordedGreen(record, cli, version) {
  return record.entries.find((e) => e.cli === cli && e.version === version && e.result === 'green') ?? null
}

/** The record with new results in: a result replaces the older one for the same
 *  CLI and version; the list keeps its order, newest last, and its bound. */
export function mergeRecord(record, results, { at, ciRun }) {
  const kept = record.entries.filter((e) => !results.some((r) => r.cli === e.cli && r.version === e.version))
  const added = results.map((r) => ({ cli: r.cli, version: r.version, result: r.result, at, ciRun: ciRun ?? null }))
  return { schema: 1, entries: [...kept, ...added].slice(-MAX_ENTRIES) }
}

/** What may start a watch run whose record is read: the schedule and a manual
 *  start, the only two triggers the workflow file has. */
const WATCH_EVENTS = new Set(['schedule', 'workflow_dispatch'])

/** Reads the record the newest earlier watch run left (success or failure; a
 *  cancelled run left none worth reading). Only runs the schedule or a manual
 *  start began are read; a run of any other kind, one with no artifact, or one
 *  that does not parse, is passed over. */
export async function findPreviousRecord({ gh, readText, dir, log, tries = 10 }) {
  const runs = JSON.parse(await gh(['run', 'list', '--workflow', WATCH_WORKFLOW, '--status', 'completed', '--limit', '20', '--json', 'databaseId,conclusion,createdAt,event']))
  let tried = 0
  for (const r of runs) {
    const id = String(r.databaseId)
    if (!/^\d+$/.test(id)) continue
    if (!WATCH_EVENTS.has(r.event)) { log(`run ${id} was passed over: it was not started by the schedule or by hand`); continue }
    if (r.conclusion !== 'success' && r.conclusion !== 'failure') continue
    if (tried >= tries) break
    tried += 1
    const target = `${dir}/${id}`
    try { await gh(['run', 'download', id, '--name', RECORD_ARTIFACT, '--dir', target]) } catch { log(`run ${id} left no record artifact`); continue }
    try { return parseRecord(readText(`${target}/${RECORD_FILE}`)) } catch (err) { log(`run ${id} left a file that is not a valid record (${err.message})`) }
  }
  log('no earlier record was found: every version newer than the tested-up-to one will be checked')
  return emptyRecord()
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------
/** Per CLI: check it, or skip it and say why. */
export function decide({ tested, latest, record }) {
  const out = {}
  for (const cli of Object.values(CLIS)) {
    const t = tested[cli.id]
    const l = latest[cli.id]
    if (compareVersions(l, t) <= 0) { out[cli.id] = { action: 'skip', latest: l, tested: t, reason: `the newest, ${l}, is not newer than the tested-up-to ${t}` }; continue }
    const g = recordedGreen(record, cli.id, l)
    if (g) { out[cli.id] = { action: 'skip', latest: l, tested: t, reason: `${l} was already checked green (${g.at})` }; continue }
    out[cli.id] = { action: 'check', latest: l, tested: t, reason: `${l} is newer than the tested-up-to ${t} and is not recorded green` }
  }
  return out
}

// ---------------------------------------------------------------------------
// Dispatching ci.yml and reading its result
// ---------------------------------------------------------------------------
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
const INPUTS = new Set(Object.values(CLIS).map((c) => c.input))

/** The names of the jobs that carry the result for a CLI's release candidate. */
export const expectedLegNames = (cli) => RC_OSES.map((os) => `${CLIS[cli].legPrefix}${os})`)

/** The step of an rc leg that installs the version it was dispatched with (ci.yml
 *  names it with the version, so a leg is held to the version asked about). */
export const installStepName = (cli, version) => `Install ${CLIS[cli].label} ${version} into its own prefix`

function explainDispatchFailure(err, ref) {
  const msg = String(err && err.message ? err.message : err).trim()
  const hint = /workflow_dispatch|HTTP 422|HTTP 404/i.test(msg)
    ? ` If it says the workflow has no workflow_dispatch trigger, or names an input it does not expect, look at ${CI_WORKFLOW} on ${ref} first: GitHub checks a dispatch against the copy on the ref it is dispatched on, not the default branch's copy.`
    : ''
  return `could not dispatch ${CI_WORKFLOW} on ${ref}: ${msg.slice(0, 600)}.${hint}`
}

/** How many reads in a row may fail while waiting before the check gives up. */
const MAX_POLL_FAILURES = 5
const shortText = (err) => String(err && err.message ? err.message : err).trim().slice(0, 300)

/** An error that carries the ci.yml run the watch already knows about. */
const errorWithRun = (message, runId, runUrl) => Object.assign(new Error(message), { runId, runUrl })

/** Dispatches ci.yml on `ref` with the inputs, finds the one run that dispatch
 *  made (a run that was not there before and was created after the dispatch;
 *  the earliest if two appear), and waits for it. One failed read while waiting
 *  (a gateway error, say) is logged and tried again; five in a row give up, and
 *  once the run is known the error carries its id and link. */
export async function dispatchAndWait({ gh, sleep, now, ref, inputs, timing, log = () => {} }) {
  if (typeof ref !== 'string' || !REF.test(ref) || ref.includes('..')) throw new Error(`the ref ${JSON.stringify(String(ref).slice(0, 60))} is not a plain branch name`)
  for (const [name, value] of Object.entries(inputs)) {
    if (!INPUTS.has(name)) throw new Error(`unknown ${CI_WORKFLOW} input ${JSON.stringify(name)}`)
    if (!isVersion(value)) throw new Error(`the ${name} value ${JSON.stringify(String(value).slice(0, 40))} is not a plain semver`)
  }
  const list = async () => JSON.parse(await gh(['run', 'list', '--workflow', CI_WORKFLOW, '--branch', ref, '--event', 'workflow_dispatch', '--limit', '30', '--json', 'databaseId,createdAt,url']))
  const startedAt = now().getTime()
  const before = new Set((await list()).map((r) => String(r.databaseId)))
  try {
    await gh(['workflow', 'run', CI_WORKFLOW, '--ref', ref, ...Object.entries(inputs).flatMap(([k, v]) => ['-f', `${k}=${v}`])])
  } catch (err) { throw new Error(explainDispatchFailure(err, ref)) }

  let found = null
  let lookFailures = 0
  for (;;) {
    let fresh
    try {
      fresh = (await list()).filter((r) => !before.has(String(r.databaseId)) && Date.parse(r.createdAt) >= startedAt - 60_000)
    } catch (err) {
      lookFailures += 1
      log(`looking for the ${CI_WORKFLOW} run failed (${lookFailures} in a row of ${MAX_POLL_FAILURES} allowed): ${shortText(err)}`)
      if (lookFailures >= MAX_POLL_FAILURES) throw new Error(`${CI_WORKFLOW} was dispatched on ${ref}, but its run could not be found after ${lookFailures} failed lookups in a row: ${shortText(err)}`)
      await sleep(timing.newRunPollMs)
      continue
    }
    lookFailures = 0
    if (fresh.length > 0) { found = fresh.sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt))[0]; break }
    if (now().getTime() - startedAt >= timing.newRunWaitMs) throw new Error(`no new ${CI_WORKFLOW} run showed up on ${ref} after the dispatch`)
    await sleep(timing.newRunPollMs)
  }
  const runId = String(found.databaseId)
  const foundUrl = typeof found.url === 'string' ? found.url : ''
  const waitFrom = now().getTime()
  let readFailures = 0
  for (;;) {
    let view
    try {
      view = JSON.parse(await gh(['run', 'view', runId, '--json', 'status,conclusion,url,jobs']))
    } catch (err) {
      readFailures += 1
      log(`reading ${CI_WORKFLOW} run ${runId} failed (${readFailures} in a row of ${MAX_POLL_FAILURES} allowed): ${shortText(err)}`)
      if (readFailures >= MAX_POLL_FAILURES) throw errorWithRun(`${CI_WORKFLOW} run ${runId} could not be read after ${readFailures} failed reads in a row: ${shortText(err)}`, runId, foundUrl)
      await sleep(timing.runPollMs)
      continue
    }
    readFailures = 0
    const done = view.status === 'completed'
    if (done || now().getTime() - waitFrom >= timing.runWaitMs) {
      return {
        runId,
        url: typeof view.url === 'string' && view.url ? view.url : String(found.url ?? ''),
        status: String(view.status ?? ''),
        conclusion: String(view.conclusion ?? ''),
        timedOut: !done,
        jobs: (Array.isArray(view.jobs) ? view.jobs : []).map((j) => ({
          name: String(j.name ?? ''),
          conclusion: String(j.conclusion ?? ''),
          status: String(j.status ?? ''),
          url: String(j.url ?? ''),
          steps: (Array.isArray(j.steps) ? j.steps : []).map((s) => ({ name: String(s.name ?? ''), conclusion: String(s.conclusion ?? '') })),
        })),
      }
    }
    await sleep(timing.runPollMs)
  }
}

const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'])

/** Which checks of the run failed, for which CLI version. A CLI is red when any
 *  of its rc legs did not pass (a leg that is missing, skipped or cancelled is
 *  not a pass; neither is one that succeeded without installing the version
 *  asked about, which says the run is not the one this watch dispatched). A run
 *  that did not finish in time is red, and still names each leg that failed or
 *  is still running. A failing check that is no rc leg (the minimum and pinned
 *  legs, the changelog check) is reported as an other check and blamed on no
 *  version. */
export function classifyRun(runInfo, wanted) {
  const results = {}
  const legNames = new Set()
  const byName = new Map(runInfo.jobs.map((j) => [j.name, j]))
  for (const [cli, version] of Object.entries(wanted)) {
    const failing = []
    const installed = installStepName(cli, version)
    for (const name of expectedLegNames(cli)) {
      legNames.add(name)
      const job = byName.get(name)
      if (!job) failing.push(`${name} (${runInfo.timedOut ? 'had not started' : 'did not run'})`)
      else if (job.conclusion !== 'success') failing.push(`${name} (${job.conclusion || job.status || 'unknown'})`)
      else if (!(job.steps ?? []).some((s) => s.name === installed && s.conclusion === 'success')) failing.push(`${name} (did not install ${version})`)
    }
    if (runInfo.timedOut) failing.unshift(`the ${CI_WORKFLOW} run did not finish in time`)
    results[cli] = { version, result: failing.length === 0 ? 'green' : 'red', failing }
  }
  const others = runInfo.jobs.filter((j) => !legNames.has(j.name) && BAD.has(j.conclusion)).map((j) => `${j.name} (${j.conclusion})`)
  const anyRed = Object.values(results).some((r) => r.result === 'red')
  if (!anyRed && others.length === 0 && !runInfo.timedOut && runInfo.conclusion !== 'success') others.push(`the ${CI_WORKFLOW} run concluded ${runInfo.conclusion || runInfo.status || 'unknown'}`)
  return { results, others }
}

// ---------------------------------------------------------------------------
// The planning-repository issue
// ---------------------------------------------------------------------------
export const ticketTitle = (cli, version) => `Upstream CLI watch: ${CLIS[cli].label} ${version} fails the conformance checks`

const cleanName = (s) => String(s).replace(/[^A-Za-z0-9 ().,:_/-]/g, '').slice(0, 120)

/** The failures the check job wrote, refused unless exactly what it writes. */
function parseFailures(text) {
  let data
  try { data = JSON.parse(text) } catch { throw new Error('the failures are not valid JSON') }
  if (!Array.isArray(data) || data.length > 2) throw new Error('the failures are not a list of at most two entries')
  return data.map((f, i) => {
    if (!f || typeof f !== 'object' || !Object.prototype.hasOwnProperty.call(CLIS, f.cli)) throw new Error(`failure ${i} names an unknown CLI`)
    if (!isVersion(f.version)) throw new Error(`failure ${i} has a version that is not a plain semver`)
    if (!Array.isArray(f.failing) || f.failing.length > 20) throw new Error(`failure ${i} has no list of failing checks`)
    if (f.ciRun !== null && !(typeof f.ciRun === 'string' && RUN_URL.test(f.ciRun))) throw new Error(`failure ${i} has a run link that is not a GitHub Actions run`)
    return { cli: f.cli, version: f.version, failing: f.failing.map(cleanName), ciRun: f.ciRun }
  })
}

function ticketBody(f, watchRunUrl) {
  return [
    'Found by the daily upstream CLI watch in AI Code Conductor: the real-CLI conformance jobs of ci.yml, run on beta against this version, failed.',
    '',
    `CLI: ${CLIS[f.cli].label}`,
    `Version: ${f.version}`,
    '',
    'Checks that failed:',
    ...(f.failing.length > 0 ? f.failing.map((n) => `- ${n}`) : ['- (none named: see the run)']),
    '',
    `ci.yml run: ${f.ciRun ?? '(no link)'}`,
    ...(watchRunUrl ? [`Watch run: ${watchRunUrl}`] : []),
    '',
    'This issue is kept up to date by the watch: one issue for this CLI version, never a second one. Fix what failed, or show the app works with this version and raise its tested-up-to version, then close this issue.',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
function writeOutputs(env, deps, pairs) {
  const text = Object.entries(pairs).map(([k, v]) => {
    if (/[\r\n]/.test(String(v))) throw new Error(`output ${k} holds a line break`)
    return `${k}=${v}\n`
  }).join('')
  if (env.GITHUB_OUTPUT) deps.appendText(env.GITHUB_OUTPUT, text)
  else deps.log(text.trimEnd())
}

function writeSummary(env, deps, text) {
  if (env.GITHUB_STEP_SUMMARY) deps.appendText(env.GITHUB_STEP_SUMMARY, `${text}\n`)
  else deps.log(text)
}

const watchDir = (env) => `${(env.RUNNER_TEMP || os.tmpdir()).replace(/\\/g, '/')}/upstream-cli-watch`
const runLink = (env) => {
  const url = env.GITHUB_SERVER_URL === 'https://github.com' && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : ''
  return RUN_URL.test(url) ? url : ''
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------
export async function runPlan({ env, deps }) {
  const dir = watchDir(env)
  deps.mkdirp(dir)
  const tested = readTested(deps.readRepoFile)
  const latest = {}
  for (const cli of Object.values(CLIS)) latest[cli.id] = await lookupLatest(cli, deps)
  const record = await findPreviousRecord({ gh: deps.gh, readText: deps.readText, dir: `${dir}/previous`, log: deps.log })
  const decision = decide({ tested, latest, record })
  // Written on every run: on a day nothing is checked the workflow uploads it, so the record
  // does not expire after the run that last changed it.
  deps.writeText(`${dir}/${RECORD_FILE}`, `${JSON.stringify(record, null, 2)}\n`)
  const pick = (id) => (decision[id].action === 'check' ? decision[id].latest : '')
  const any = Object.values(CLIS).some((c) => decision[c.id].action === 'check')
  writeOutputs(env, deps, { codex_version: pick('codex'), claude_version: pick('claude'), any: String(any), record: JSON.stringify(record) })
  writeSummary(env, deps, [
    '## Upstream CLI watch: what is newest',
    '',
    '| CLI | Newest published | Tested up to | Decision |',
    '| --- | --- | --- | --- |',
    ...Object.values(CLIS).map((c) => `| ${c.label} | ${decision[c.id].latest} | ${decision[c.id].tested} (${c.testedNote}) | ${decision[c.id].action === 'check' ? 'check it: ' : 'nothing to run: '}${decision[c.id].reason} |`),
    '',
    any ? 'ci.yml is dispatched on beta next, with the versions to check.' : 'Nothing to run today.',
  ].join('\n'))
  return 0
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------
export async function runCheck({ env, deps }) {
  const wanted = {}
  const inputs = {}
  for (const cli of Object.values(CLIS)) {
    const v = env[`${cli.id.toUpperCase()}_VERSION`] ?? ''
    if (v === '') continue
    if (!isVersion(v)) throw new Error(`${cli.id.toUpperCase()}_VERSION ${JSON.stringify(v.slice(0, 40))} is not a plain semver`)
    wanted[cli.id] = v
    inputs[cli.input] = v
  }
  if (Object.keys(wanted).length === 0) throw new Error('there is nothing to check: neither CODEX_VERSION nor CLAUDE_VERSION is set')
  const ref = env.WATCH_REF ? env.WATCH_REF : 'beta'
  const previous = env.PREVIOUS_RECORD ? parseRecord(env.PREVIOUS_RECORD) : emptyRecord()
  const minutes = env.WATCH_WAIT_MINUTES ? Number(env.WATCH_WAIT_MINUTES) : null
  if (minutes !== null && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 120)) throw new Error('WATCH_WAIT_MINUTES is not a whole number from 1 to 120')
  const timing = { ...deps.timing, ...(minutes ? { runWaitMs: minutes * 60_000 } : {}) }
  const dir = watchDir(env)
  deps.mkdirp(dir)
  const keep = (record) => deps.writeText(`${dir}/${RECORD_FILE}`, `${JSON.stringify(record, null, 2)}\n`)
  const label = Object.entries(wanted).map(([id, v]) => `${CLIS[id].label} ${v}`).join(' and ')

  let runInfo
  try {
    runInfo = await dispatchAndWait({ gh: deps.gh, sleep: deps.sleep, now: deps.now, ref, inputs, timing, log: deps.log })
  } catch (err) {
    keep(previous)
    writeOutputs(env, deps, { failures: '[]' })
    // The run that was dispatched goes on unobserved: its link is what the owner needs.
    const runLine = err && err.runId ? [`The ${CI_WORKFLOW} run that was dispatched and could not be followed: ${RUN_URL.test(err.runUrl ?? '') ? err.runUrl : `run ${err.runId}`}`, ''] : []
    writeSummary(env, deps, [`## Upstream CLI watch: ${label} could not be checked`, '', String(err.message), '', ...runLine].join('\n'))
    throw err
  }
  const { results, others } = classifyRun(runInfo, wanted)
  const ciRun = RUN_URL.test(runInfo.url) ? runInfo.url : null
  const record = mergeRecord(previous, Object.entries(results).map(([cli, r]) => ({ cli, version: r.version, result: r.result })), { at: deps.now().toISOString(), ciRun })
  keep(record)
  const failures = Object.entries(results).filter(([, r]) => r.result === 'red').map(([cli, r]) => ({ cli, version: r.version, failing: r.failing, ciRun }))
  writeOutputs(env, deps, { failures: JSON.stringify(failures) })

  const watchRun = runLink(env)
  writeSummary(env, deps, [
    `## Upstream CLI watch: ${label}`,
    '',
    `ci.yml was dispatched on ${ref} and ran as ${runInfo.url || `run ${runInfo.runId}`}.`,
    ...(watchRun ? [`This watch run: ${watchRun}`] : []),
    '',
    ...Object.entries(results).flatMap(([cli, r]) => (r.result === 'green'
      ? [`- ${CLIS[cli].label} ${r.version}: green (the release-candidate legs on ${RC_OSES.join(', ')} all passed)`]
      : [`- ${CLIS[cli].label} ${r.version}: RED`, ...r.failing.map((n) => `  - failed: ${n}`)])),
    ...(others.length > 0 ? ['', 'Other checks of the same run that failed:', ...others.map((n) => `- ${n}`)] : []),
    '',
    Object.values(results).every((r) => r.result === 'green') && others.length === 0
      ? 'Result: green. Each version is recorded as checked and is not run again.'
      : 'Result: RED. This run fails so the usual Actions failure notice reaches the owner. A red version is run again tomorrow.',
  ].join('\n'))
  return failures.length > 0 || others.length > 0 ? 1 : 0
}

// ---------------------------------------------------------------------------
// ticket (optional)
// ---------------------------------------------------------------------------
export async function runTicket({ env, deps }) {
  const token = (env.AICC_PLANNING_ISSUES_TOKEN ?? '').trim()
  if (!token) {
    deps.log('Skipping the aicc_planning ticket: AICC_PLANNING_ISSUES_TOKEN is not set (this step is optional).')
    return 0
  }
  const failures = parseFailures(env.FAILURES ?? '')
  if (failures.length === 0) { deps.log('No failing CLI version to ticket.'); return 0 }
  const watchRun = RUN_URL.test(env.WATCH_RUN_URL ?? '') ? env.WATCH_RUN_URL : ''
  const dir = watchDir(env)
  deps.mkdirp(dir)
  for (const f of failures) {
    const title = ticketTitle(f.cli, f.version)
    const found = JSON.parse(await deps.gh(['issue', 'list', '--repo', PLANNING_REPO, '--state', 'all', '--search', `"${title}" in:title`, '--json', 'number,title,state', '--limit', '30'], { token }))
    const same = found.filter((i) => i && i.title === title).sort((a, b) => a.number - b.number)
    const bodyFile = `${dir}/ticket-${f.cli}-${f.version}.md`
    deps.writeText(bodyFile, ticketBody(f, watchRun))
    if (same.length > 0) {
      await deps.gh(['issue', 'edit', String(same[0].number), '--repo', PLANNING_REPO, '--body-file', bodyFile], { token })
      deps.log(`Updated aicc_planning issue ${same[0].number} (${same[0].state}) for ${CLIS[f.cli].label} ${f.version}.`)
    } else {
      const url = String(await deps.gh(['issue', 'create', '--repo', PLANNING_REPO, '--title', title, '--body-file', bodyFile], { token })).trim()
      deps.log(`Opened ${url} for ${CLIS[f.cli].label} ${f.version}.`)
    }
  }
  return 0
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function realDeps(env) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const exec = async (file, args, extraEnv = {}) => {
    try {
      const { stdout } = await run(file, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' && file === 'npm', env: { ...process.env, ...extraEnv } })
      return stdout
    } catch (err) {
      throw new Error(`${file} ${args.slice(0, 2).join(' ')} failed: ${String(err.stderr || err.message || err).trim().slice(0, 800)}`)
    }
  }
  return {
    root,
    readRepoFile: (rel) => readFileSync(path.join(root, rel), 'utf8'),
    readText: (p) => readFileSync(p, 'utf8'),
    writeText: (p, t) => writeFileSync(p, t),
    appendText: (p, t) => appendFileSync(p, t),
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    log: (line) => console.log(line),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    npm: (args) => exec('npm', args),
    gh: (args, opts = {}) => exec('gh', args, opts.token ? { GH_TOKEN: opts.token } : {}),
    timing: { newRunWaitMs: 180_000, newRunPollMs: 6_000, runWaitMs: 70 * 60_000, runPollMs: 30_000 },
    env,
  }
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = realDeps(env)) {
  const mode = argv[0]
  const modes = { plan: runPlan, check: runCheck, ticket: runTicket }
  if (!Object.prototype.hasOwnProperty.call(modes, mode)) {
    deps.log('usage: node scripts/ci/upstream-cli-watch.mjs plan|check|ticket')
    return 2
  }
  try {
    return await modes[mode]({ env, deps })
  } catch (err) {
    deps.log(`::error::upstream CLI watch (${mode}): ${err && err.message ? err.message : err}`)
    return 1
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  // exitCode, not process.exit(): output already written is flushed.
  main().then((code) => { process.exitCode = code }, () => { process.exitCode = 1 })
}
