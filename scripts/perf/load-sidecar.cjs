// Performance harness (scripts/perf, see README.md): give the transcript readers work while the
// sessions are busy. The fake CLI draws a terminal but writes no transcript, so this appends one
// assistant line (with token usage, as Claude Code writes them) to each harness session's transcript
// every --every-ms, spread evenly across the sessions. Tokenomics and session logging read those files.
//
//   CCC_STAGE_ROOT=<root> node load-sidecar.cjs [--every-ms 5000] [--seconds 0] [--exit-on-stdin-close]
//
// --seconds 0 runs until stopped. --exit-on-stdin-close ends it when its standard input closes:
// run-matrix.cjs starts it with a pipe there, so it ends with the runner even when the runner is
// killed, and gives it a --seconds limit too.
// The sessions and their transcripts are the ones gen-sessions.cjs recorded (runner/perf-sessions.json).
// It writes only into those transcripts, each inside the staging root's home (checked).
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const S = require(path.join(__dirname, '..', 'readme-shots', 'stage', 'stage-root.js'))

/** The options; throws on a value that is not a number or is below its floor
 *  (every 200 ms at the fastest; seconds from 0). */
function parseSidecarOptions(argv) {
  const num = (name, d, min) => {
    const i = argv.indexOf(name)
    if (i < 0) return d
    const v = Number(argv[i + 1])
    if (argv[i + 1] === undefined || !Number.isFinite(v) || v < min) throw new Error(`${name} must be a number of at least ${min}, not ${argv[i + 1]}`)
    return v
  }
  return { everyMs: num('--every-ms', 5000, 200), seconds: num('--seconds', 0, 0), exitOnStdinClose: argv.includes('--exit-on-stdin-close') }
}

const hex = (n) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n)
const rint = (lo, hi) => lo + crypto.randomInt(hi - lo + 1)

/** One assistant line, in the shape Claude Code writes its transcripts in. */
function assistantLine(s, parentUuid, n) {
  return {
    parentUuid, isSidechain: false, userType: 'external', cwd: s.cwd, sessionId: s.resumeUuid, version: '2.1.290', gitBranch: 'main',
    type: 'assistant', requestId: 'req_011' + hex(21).toUpperCase(), uuid: crypto.randomUUID(), timestamp: new Date().toISOString(),
    message: {
      id: 'msg_01' + hex(22).toUpperCase(), type: 'message', role: 'assistant', model: 'claude-fable-5-1',
      content: [{ type: 'text', text: `Still working through the change (step ${n}): reading the next file and checking the tests that cover it.` }],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: rint(3, 11), cache_creation_input_tokens: rint(180, 2400), cache_read_input_tokens: rint(18000, 90000), output_tokens: rint(40, 400), service_tier: 'standard' },
    },
  }
}

function main(o) {
  const stage = S.resolveStage(process.env)
  S.ensureMarker(stage.ROOT, { create: false })
  const rec = JSON.parse(fs.readFileSync(path.join(stage.RUNNER, 'perf-sessions.json'), 'utf8'))
  const home = path.join(stage.HOME, '.claude', 'projects')
  const targets = rec.sessions.filter((s) => s.transcript && S.inside(s.transcript, home) && fs.existsSync(s.transcript))
  if (!targets.length) { console.error('refusing: no harness transcript to write to (run gen-sessions.cjs first)'); process.exit(2) }
  let lines = 0
  const parents = new Map()
  const stagger = o.everyMs / targets.length
  targets.forEach((s, i) => {
    let n = 0
    setTimeout(() => {
      const write = () => {
        const line = assistantLine(s, parents.get(s.id) || null, ++n)
        parents.set(s.id, line.uuid)
        fs.appendFileSync(s.transcript, JSON.stringify(line) + '\n')
        lines++
      }
      write()
      setInterval(write, o.everyMs)
    }, Math.round(i * stagger))
  })
  console.log(`appending to ${targets.length} transcripts every ${o.everyMs} ms${o.seconds ? ` for ${o.seconds} s` : ''}`)
  setInterval(() => console.log(`${new Date().toISOString()} lines written: ${lines}`), 60000)
  if (o.seconds > 0) setTimeout(() => { console.log(`done: ${lines} lines`); process.exit(0) }, o.seconds * 1000)
  if (o.exitOnStdinClose) {
    process.stdin.on('end', () => { console.log(`input closed: ${lines} lines`); process.exit(0) })
    process.stdin.on('error', () => process.exit(0))
    process.stdin.resume()
  }
}

module.exports = { assistantLine, parseSidecarOptions }

if (require.main === module) {
  let o
  try { o = parseSidecarOptions(process.argv.slice(2)) } catch (e) { console.error('refusing: ' + e.message); process.exit(2) }
  try { main(o) } catch (e) {
    if (e instanceof S.StageRefusal) { console.error('refusing: ' + e.message); process.exit(2) }
    console.error(e && e.stack ? e.stack : e)
    process.exit(1)
  }
}
