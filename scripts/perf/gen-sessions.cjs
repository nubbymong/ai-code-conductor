// Performance harness (scripts/perf, see README.md): set a seeded README staging root up for one
// measured run, with the app closed.
//
//   CCC_STAGE_ROOT=<root> node gen-sessions.cjs --n 25 [--mode idle|busy] [--off none|tokenomics|logging|hooks]
//   CCC_STAGE_ROOT=<root> node gen-sessions.cjs --mode busy      only the mode (the running fake CLIs read it within 2 s)
//
// --n writes N Claude sessions into the staging session-state.json, for the start-up prompt to offer
// and Resume to open: the seed's Claude sessions first, then copies of them with their own ids and
// conversations (each copy's transcript is a copy of its template's, so Tokenomics and session logging
// find a file per session). The first --n on a root keeps the state every run starts from in the
// runner folder: the seed's session-state.json, the transcripts under the staging home, and the
// Tokenomics and session logging databases. Every --n puts all three back before it writes its
// sessions, so no run starts from transcripts an earlier run's writer grew or from databases an
// earlier run filled: runs with different N, and the ablations, do not build on each other.
// --mode writes `mode` into the fake CLIs' fake-stage.json (a temporary file, then a rename, so a CLI
// never reads half of it): idle draws the conversation and then sits at the prompt; busy also redraws
// a spinner every 120 ms and writes its status file every 2 s (scripts/readme-shots/stage/fake-claude.js).
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
const MAX_SESSIONS = 60
/** The databases the app keeps in its data folder (seed.js builds the first). */
const DB_FILES = Object.freeze(['transcripts.db', 'transcripts.db-wal', 'transcripts.db-shm', 'tokenomics.db', 'tokenomics.db-wal', 'tokenomics.db-shm'])

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

/** Write JSON so a reader never sees half of it: a temporary file beside it,
 *  then a rename over it (tried again for up to a second while a reader or a
 *  scanner holds the file). fsx (for the unit suite) stands in for fs. */
function writeJsonAtomic(file, value, fsx = fs) {
  const tmp = `${file}.${process.pid}.tmp`
  fsx.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  for (let i = 0; ; i++) {
    try { fsx.renameSync(tmp, file); return } catch (e) {
      if (i >= 20 || !e || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

/**
 * Set the root up. stage: the layout stage-root.js's resolveStage gives
 * (ROOT, DATA, RES, HOME, NPM_BIN, RUNNER), its marker checked. Writes only
 * inside stage.ROOT. Returns what it did, for the log.
 */
function generate(argv, stage) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const inRoot = (p) => { if (!S.inside(p, stage.ROOT)) throw new S.StageRefusal(`${p} is outside the staging root`); return p }
  const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
  const writeJson = (p, v) => { fs.mkdirSync(path.dirname(inRoot(p)), { recursive: true }); writeJsonAtomic(inRoot(p), v) }
  const remove = (p) => S.removeNoFollow(inRoot(p))
  const CONFIG = path.join(stage.RES, 'CONFIG')
  const said = []
  const say = (s) => { said.push(s); console.log(s) }

  const mode = opt('--mode')
  if (mode !== undefined && !MODES.includes(mode)) throw new S.StageRefusal(`--mode is idle or busy, not ${mode}`)
  const off = opt('--off')
  if (off !== undefined && off !== 'none' && !OFF_SETTING[off]) throw new S.StageRefusal(`--off is none, ${Object.keys(OFF_SETTING).join(', ')}; not ${off}`)
  const nArg = opt('--n')
  const n = nArg === undefined ? null : Number(nArg)
  if (nArg !== undefined && (!Number.isInteger(n) || n < 1 || n > MAX_SESSIONS)) throw new S.StageRefusal(`--n is a whole number from 1 to ${MAX_SESSIONS}, not ${nArg}`)

  if (n !== null) {
    // The state every run starts from: kept the first time, put back every time.
    const stateFile = path.join(CONFIG, 'session-state.json')
    const templateFile = path.join(stage.RUNNER, 'perf-seed-session-state.json')
    const pristine = path.join(stage.RUNNER, 'perf-pristine')
    const projects = path.join(stage.HOME, '.claude', 'projects')
    if (!fs.existsSync(templateFile)) {
      const seeded = readJson(stateFile)
      if ((seeded.sessions || []).some((s) => s.id === sessionIdFor(claudeTemplates(seeded.sessions).length))) throw new S.StageRefusal('session-state.json already holds harness copies: re-seed the root')
      remove(pristine)
      fs.mkdirSync(inRoot(path.join(pristine, 'db')), { recursive: true })
      if (fs.existsSync(projects)) fs.cpSync(projects, inRoot(path.join(pristine, 'projects')), { recursive: true })
      for (const f of DB_FILES) if (fs.existsSync(path.join(stage.DATA, f))) fs.copyFileSync(path.join(stage.DATA, f), inRoot(path.join(pristine, 'db', f)))
      fs.writeFileSync(inRoot(path.join(pristine, '.done')), new Date().toISOString() + '\n')
      writeJson(templateFile, seeded)
      say('kept the seeded state every run starts from')
    } else if (!fs.existsSync(path.join(pristine, '.done'))) {
      throw new S.StageRefusal('this root was set up by an older harness (no kept start state): re-seed it')
    }
    remove(projects)
    if (fs.existsSync(path.join(pristine, 'projects'))) fs.cpSync(path.join(pristine, 'projects'), inRoot(projects), { recursive: true })
    for (const f of DB_FILES) {
      remove(path.join(stage.DATA, f))
      if (fs.existsSync(path.join(pristine, 'db', f))) fs.copyFileSync(path.join(pristine, 'db', f), inRoot(path.join(stage.DATA, f)))
    }
    say('transcripts and databases put back as seeded')

    const templates = claudeTemplates(readJson(templateFile).sessions)
    const planned = planSessions(templates, n)
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
    say(`${n} Claude sessions written (${Math.min(n, templates.length)} seeded, ${n - Math.min(n, templates.length)} copies; ${record.filter((r) => r.transcript).length} with a transcript)`)
  }

  if (mode) {
    const file = path.join(stage.NPM_BIN, 'fake-stage.json')
    if (!fs.existsSync(file)) throw new S.StageRefusal(`no ${file}: seed the root first`)
    writeJson(file, { ...readJson(file), mode })
    say(`mode ${mode}`)
  }

  if (off !== undefined) {
    const file = path.join(CONFIG, 'settings.json')
    const settings = readJson(file)
    for (const [svc, key] of Object.entries(OFF_SETTING)) settings[key] = svc !== off
    writeJson(file, settings)
    say(`services: ${Object.entries(OFF_SETTING).map(([s, k]) => `${s} ${settings[k] ? 'on' : 'OFF'}`).join(', ')}`)
  }
  return said
}

module.exports = { planSessions, claudeTemplates, sessionIdFor, uuidFor, writeJsonAtomic, generate, OFF_SETTING, MODES, MAX_SESSIONS, DB_FILES }

if (require.main === module) {
  try {
    const stage = S.resolveStage(process.env)
    S.ensureMarker(stage.ROOT, { create: false })
    generate(process.argv.slice(2), stage)
  } catch (e) {
    if (e instanceof S.StageRefusal) { console.error('refusing: ' + e.message); process.exit(2) }
    console.error(e && e.stack ? e.stack : e)
    process.exit(1)
  }
}
