// Performance harness (scripts/perf, see README.md): set a seeded README staging root up for one
// measured run, with the app closed.
//
//   CCC_STAGE_ROOT=<root> node gen-sessions.cjs --n 25 [--mode idle|busy] [--off none|tokenomics|logging|hooks]
//   CCC_STAGE_ROOT=<root> node gen-sessions.cjs --mode busy      only the mode (the running fake CLIs read it within 2 s)
//
// --n writes N Claude sessions into the staging session-state.json, for the start-up prompt to offer
// and Resume to open: the seed's Claude sessions first, then copies of them with their own ids and
// conversations (each copy's transcript is a copy of its template's, so Tokenomics and session logging
// find a file per session). The seed's own session-state.json is kept once in the runner folder and
// every run starts from it, so runs with different N do not build on each other.
// --mode writes `mode` into the fake CLIs' fake-stage.json: idle draws the conversation and then sits
// at the prompt; busy also redraws a spinner every 120 ms and writes its status file every 2 s
// (scripts/readme-shots/stage/fake-claude.js).
// --off switches one service off in the staging settings (Tokenomics, session logging or the hooks
// gateway) for an ablation run; none switches all three on.
//
// Everything is written inside the staging root, through the README staging's own guard
// (scripts/readme-shots/stage/stage-root.js): the VM user's own app data is never touched.
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const S = require(path.join(__dirname, '..', 'readme-shots', 'stage', 'stage-root.js'))

const OFF_SETTING = Object.freeze({ tokenomics: 'tokenomicsEnabled', logging: 'loggingEnabled', hooks: 'hooksEnabled' })
const MODES = Object.freeze(['idle', 'busy'])

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex')
/** A stable 24-hex session id and a v4-shaped conversation uuid for copy i. */
const sessionIdFor = (i) => hash('ccc-perf-session-' + i).slice(0, 24)
function uuidFor(i) {
  const h = hash('ccc-perf-conversation-' + i)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
const slugOf = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-')

/** The seed's sessions a copy can be made from: the Claude sessions (the ones
 *  with claudeOptions), each with a conversation. */
function claudeTemplates(sessions) {
  return (sessions || []).filter((s) => s && s.claudeOptions && !s.shellOnly && typeof s.resumeUuid === 'string' && s.resumeUuid)
}

/** N sessions: the templates as they are, then copies with their own id, conversation and name. */
function planSessions(templates, n) {
  if (!templates.length) throw new Error('the seeded session-state.json has no Claude session to copy')
  const out = []
  for (let i = 0; i < n; i++) {
    const t = templates[i % templates.length]
    if (i < templates.length) { out.push({ session: { ...t }, from: null }); continue }
    out.push({
      session: { ...t, id: sessionIdFor(i), resumeUuid: uuidFor(i), customName: `${t.customName || t.label} ${i + 1}` },
      from: t.resumeUuid,
    })
  }
  return out
}

function main(argv, env) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const stage = S.resolveStage(env)
  S.ensureMarker(stage.ROOT, { create: false })
  const inRoot = (p) => { if (!S.inside(p, stage.ROOT)) throw new S.StageRefusal(`${p} is outside the staging root`); return p }
  const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
  const writeJson = (p, v) => { fs.mkdirSync(path.dirname(inRoot(p)), { recursive: true }); fs.writeFileSync(inRoot(p), JSON.stringify(v, null, 2) + '\n') }
  const CONFIG = path.join(stage.RES, 'CONFIG')

  const mode = opt('--mode')
  if (mode !== undefined && !MODES.includes(mode)) throw new S.StageRefusal(`--mode is idle or busy, not ${mode}`)
  if (mode) {
    const file = path.join(stage.NPM_BIN, 'fake-stage.json')
    if (!fs.existsSync(file)) throw new S.StageRefusal(`no ${file}: seed the root first`)
    writeJson(file, { ...readJson(file), mode })
    console.log(`mode ${mode}`)
  }

  const off = opt('--off')
  if (off !== undefined) {
    if (off !== 'none' && !OFF_SETTING[off]) throw new S.StageRefusal(`--off is none, ${Object.keys(OFF_SETTING).join(', ')}; not ${off}`)
    const file = path.join(CONFIG, 'settings.json')
    const settings = readJson(file)
    for (const [svc, key] of Object.entries(OFF_SETTING)) settings[key] = svc !== off
    writeJson(file, settings)
    console.log(`services: ${Object.entries(OFF_SETTING).map(([s, k]) => `${s} ${settings[k] ? 'on' : 'OFF'}`).join(', ')}`)
  }

  const nArg = opt('--n')
  if (nArg === undefined) return
  const n = Number(nArg)
  if (!Number.isInteger(n) || n < 1 || n > 60) throw new S.StageRefusal(`--n is a whole number from 1 to 60, not ${nArg}`)
  const stateFile = path.join(CONFIG, 'session-state.json')
  const templateFile = path.join(stage.RUNNER, 'perf-seed-session-state.json')
  if (!fs.existsSync(templateFile)) {
    const seeded = readJson(stateFile)
    if ((seeded.sessions || []).some((s) => s.id === sessionIdFor(claudeTemplates(seeded.sessions).length))) throw new S.StageRefusal('session-state.json already holds harness copies: re-seed the root')
    writeJson(templateFile, seeded)
  }
  const templates = claudeTemplates(readJson(templateFile).sessions)
  const planned = planSessions(templates, n)
  const projects = path.join(stage.HOME, '.claude', 'projects')
  const record = []
  for (const { session, from } of planned) {
    const dir = path.join(projects, slugOf(session.resumeCwd || session.workingDirectory))
    const file = path.join(dir, `${session.resumeUuid}.jsonl`)
    if (from && !fs.existsSync(file)) {
      const src = path.join(dir, `${from}.jsonl`)
      if (fs.existsSync(src)) {
        const text = fs.readFileSync(src, 'utf8').split(from).join(session.resumeUuid)
        fs.mkdirSync(inRoot(dir), { recursive: true })
        fs.writeFileSync(inRoot(file), text)
      }
    }
    record.push({ id: session.id, resumeUuid: session.resumeUuid, cwd: session.resumeCwd || session.workingDirectory, model: (session.claudeOptions && session.claudeOptions.model) || null, transcript: fs.existsSync(file) ? file : null })
  }
  const sessions = planned.map((p) => p.session)
  writeJson(stateFile, { sessions, activeSessionId: sessions[0].id, savedAt: Date.now() - 60 * 1000 })
  writeJson(path.join(stage.RUNNER, 'perf-sessions.json'), { n, at: new Date().toISOString(), sessions: record })
  // The fake CLI draws a copy as the seeded session it was made from, and names its own transcript.
  const fakeStage = path.join(stage.NPM_BIN, 'fake-stage.json')
  if (!fs.existsSync(fakeStage)) throw new S.StageRefusal(`no ${fakeStage}: seed the root first`)
  writeJson(fakeStage, { ...readJson(fakeStage), copies: Object.fromEntries(planned.filter((p) => p.from).map((p) => [p.session.resumeUuid, p.from])) })
  console.log(`${n} Claude sessions written (${Math.min(n, templates.length)} seeded, ${n - Math.min(n, templates.length)} copies; ${record.filter((r) => r.transcript).length} with a transcript)`)
}

module.exports = { planSessions, claudeTemplates, sessionIdFor, uuidFor, OFF_SETTING }

if (require.main === module) {
  try { main(process.argv.slice(2), process.env) } catch (e) {
    if (e instanceof S.StageRefusal) { console.error('refusing: ' + e.message); process.exit(2) }
    console.error(e && e.stack ? e.stack : e)
    process.exit(1)
  }
}
