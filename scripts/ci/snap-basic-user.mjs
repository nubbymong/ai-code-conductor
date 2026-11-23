#!/usr/bin/env node
/**
 * One run of the helper's capture mode from a basic-user token, on the GitHub
 * Windows runner (plan 2.1.3-beta.16, section A1; aicc_planning#401). Probe
 * P21 read the mode in the runner's own session, which runs elevated; this is
 * the first reading from a token that is not: `runas /trustlevel:0x20000`
 * (Basic User: the Administrators group kept for deny only, a medium
 * mandatory level), and `runas /machine:amd64 /trustlevel:0x20000` when the
 * first is refused.
 *
 *   node scripts/ci/snap-basic-user.mjs --helper <aicc-helper.exe> --out <folder>
 *
 * The restricted run is a small cmd file in a folder of its own under the
 * user's temp folder (the user's own, so the restricted token can write
 * there): it records `whoami /groups`, runs `capture --out` into a folder
 * beside it, and writes its exit status last. runas returns at once, so the
 * status file is waited for, up to WAIT_MS. Each picture is read (its size and
 * its header) and deleted, and the folder is removed. The reading goes to the
 * log, the job summary and <out>/reading.json; no picture is kept.
 *
 * A measurement: exit 0 whatever it read, "not measured" included (the
 * runner refused both forms, or the token it got was not a basic user's).
 * Exit 2: a command line it does not take. Exit 1: the script itself failed.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** How long the restricted run may take to write its status. runas starts it
 *  and returns; cmd, whoami and the capture (44 to 62 ms in P21) follow. */
export const WAIT_MS = 30_000
/** The bytes of a BMP before its pixels (the helper's BMP_HEADER_BYTES). */
export const BMP_HEADER_BYTES = 54

/** The two forms of runas tried, in order. */
export const RUNAS_FORMS = [['/trustlevel:0x20000'], ['/machine:amd64', '/trustlevel:0x20000']]

/** What `whoami /groups` says of the token: the Administrators group
 *  (S-1-5-32-544) as 'deny-only', 'enabled' or 'absent', and the mandatory
 *  level's name (Low, Medium, High, System), or null when no level is listed. */
export function readGroups(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const admin = lines.find((l) => l.includes('S-1-5-32-544'))
  const administrators = !admin ? 'absent' : /deny only/i.test(admin) ? 'deny-only' : /enabled group/i.test(admin) ? 'enabled' : 'listed'
  const label = lines.find((l) => /S-1-16-\d+/.test(l))
  const level = label ? (/Mandatory Label\\(\w+(?: Plus)?) Mandatory Level/i.exec(label)?.[1] ?? 'unnamed') : null
  return { administrators, level }
}

/** A BMP file's header: its width, its height (positive: rows from the
 *  bottom), its bits per pixel. Null when it is not a BMP. */
export function readBmpHeader(buf) {
  if (!buf || buf.length < BMP_HEADER_BYTES || buf[0] !== 0x42 || buf[1] !== 0x4d) return null
  return { width: buf.readInt32LE(18), height: buf.readInt32LE(22), bits: buf.readUInt16LE(28) }
}

/** The cmd file the restricted token runs, in `work`: the token's groups,
 *  the capture into `cap`, then its exit status, written last and moved into
 *  place so it is never read half written. */
export function cmdFileText(work, helper, cap) {
  return [
    '@echo off',
    `whoami /groups > "${join(work, 'groups.txt')}" 2>&1`,
    `"${helper}" capture --out "${cap}" > "${join(work, 'line.txt')}" 2> "${join(work, 'err.txt')}"`,
    // In brackets: a bare `echo 0> file` is read by cmd as a redirect of
    // handle 0, which writes an empty file (the first dispatch's NaN).
    `(echo %ERRORLEVEL%)> "${join(work, 'exit.tmp')}"`,
    `move /y "${join(work, 'exit.tmp')}" "${join(work, 'exit.txt')}" > nul`,
    '',
  ].join('\r\n')
}

/** A file a console program wrote: UTF-16 when it starts with a UTF-16 byte
 *  order mark or holds NUL bytes, else UTF-8. */
export function decodeText(buf) {
  if (!buf || buf.length === 0) return ''
  if ((buf[0] === 0xff && buf[1] === 0xfe) || buf.includes(0)) return buf.toString('utf16le').replace(/^﻿/, '')
  return buf.toString('utf8')
}

/** The capture line's displays, read strictly enough to report: null when the
 *  line is not the mode's answer. */
export function readCaptureLine(text) {
  const line = String(text ?? '').trim()
  if (line === '' || /[\r\n]/.test(line)) return null
  try {
    const v = JSON.parse(line)
    return Array.isArray(v?.displays) ? v.displays : null
  } catch {
    return null
  }
}

/** The verdict line from what the run left. */
export function verdict(r) {
  if (r.refused) return `not measured: the runner refused both forms of runas (${r.refused})`
  if (r.noStatus) return `not measured: the restricted run wrote no status within ${WAIT_MS / 1000} s`
  if (r.token && r.token.administrators === 'enabled') return 'not measured: the token runas gave still has the Administrators group enabled'
  if (r.exit === 0 && r.displays && r.displays.length > 0 && r.pictures.every((p) => p.ok)) {
    const basic = r.token && r.token.administrators === 'deny-only' && r.token.level === 'Medium'
    return basic ? 'CAPTURES' : `CAPTURES, but the token was not read as a basic user's (Administrators ${r.token?.administrators ?? 'not read'}, ${r.token?.level ?? 'no'} mandatory level)`
  }
  return `FAILS (exit ${r.exit}${r.stderr ? `: ${r.stderr}` : ''})`
}

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]]
    if ((k !== '--helper' && k !== '--out') || v === undefined) return null
    opts[k.slice(2)] = v
  }
  return opts.helper && opts.out ? opts : null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function measure(helper) {
  const r = { form: null, refused: null, noStatus: false, token: null, exit: null, stderr: '', ms: null, displays: null, pictures: [] }
  const work = mkdtempSync(join(tmpdir(), 'snap-basic-'))
  try {
    if (/\s/.test(work) || /\s/.test(helper)) {
      r.refused = 'a path with a space, which this script does not quote for runas'
      return r
    }
    const cap = join(work, 'cap')
    mkdirSync(cap)
    const cmdFile = join(work, 'run.cmd')
    writeFileSync(cmdFile, cmdFileText(work, helper, cap))
    const refusals = []
    for (const form of RUNAS_FORMS) {
      const started = Date.now()
      const run = spawnSync('runas.exe', [...form, `cmd /c ${cmdFile}`], { encoding: 'utf8', windowsHide: true, timeout: WAIT_MS })
      const said = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
      // runas says RUNAS ERROR when it starts nothing; its exit status alone is
      // not read as a refusal, so a form that did start is never run twice.
      if (run.error || /RUNAS ERROR/i.test(said)) {
        refusals.push(`${form.join(' ')}: ${run.error ? run.error.message : said}`)
        continue
      }
      r.form = `${form.join(' ')} (runas exit ${run.status}${said ? `, "${said}"` : ''})`
      const statusFile = join(work, 'exit.txt')
      while (!existsSync(statusFile) && Date.now() - started < WAIT_MS) await sleep(100)
      if (!existsSync(statusFile)) {
        r.noStatus = true
        return r
      }
      r.ms = Date.now() - started
      break
    }
    if (!r.form) {
      r.refused = refusals.join('; ')
      return r
    }
    const read = (name) => { try { return decodeText(readFileSync(join(work, name))) } catch { return '' } }
    const groups = read('groups.txt')
    r.token = readGroups(groups)
    // What whoami wrote, kept when it named no group this script reads, so a
    // reading it cannot make is shown, not guessed at.
    if (r.token.administrators === 'absent' || r.token.level === null) r.groupsText = groups.slice(0, 2000)
    r.exitText = read('exit.txt').slice(0, 40)
    r.exit = Number.parseInt(r.exitText.trim(), 10)
    r.stderr = read('err.txt').trim().split(/\r?\n/)[0] ?? ''
    r.displays = readCaptureLine(read('line.txt'))
    for (const d of r.displays ?? []) {
      const file = join(cap, String(d.file ?? ''))
      let header = null
      let bytes = null
      try {
        bytes = statSync(file).size
        header = readBmpHeader(readFileSync(file).subarray(0, BMP_HEADER_BYTES))
      } catch { /* missing: reported below */ }
      const ok = header !== null && header.width === d.width && header.height === d.height && header.bits === 32 && bytes === BMP_HEADER_BYTES + d.width * d.height * 4
      r.pictures.push({ file: d.file, width: d.width, height: d.height, scale: d.scale, primary: d.primary, bytes, header, ok })
    }
    // No picture is kept: the folder goes with the rest of the work folder.
    r.left = readdirSync(cap).length
    return r
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function main(argv) {
  const opts = parseArgs(argv)
  if (!opts || !isAbsolute(resolve(opts.helper))) {
    console.error('usage: node scripts/ci/snap-basic-user.mjs --helper <aicc-helper.exe> --out <folder>')
    return 2
  }
  const out = resolve(opts.out)
  mkdirSync(out, { recursive: true })
  let r
  if (process.platform !== 'win32') {
    r = { refused: 'not Windows', pictures: [] }
  } else {
    r = await measure(resolve(opts.helper))
  }
  const lines = [
    `basic-user: runas ${r.form ?? '(none)'}${r.ms !== null && r.ms !== undefined ? `, the run's status in ${r.ms} ms (runas, cmd, whoami and the capture)` : ''}`,
    `basic-user: token: Administrators ${r.token?.administrators ?? 'not read'}, ${r.token?.level ?? 'no'} mandatory level`,
    ...(r.pictures ?? []).map((p) => `basic-user: ${p.file} ${p.width}x${p.height} at ${p.scale}%${p.primary ? ' (primary)' : ''}: ${p.ok ? 'size and header match the line' : `does not match (${p.bytes ?? 'no'} bytes, header ${JSON.stringify(p.header)})`}`),
    ...(r.groupsText !== undefined ? [`basic-user: whoami /groups wrote: ${JSON.stringify(r.groupsText.slice(0, 600))}`] : []),
    ...(r.exitText !== undefined && Number.isNaN(r.exit) ? [`basic-user: the status file held: ${JSON.stringify(r.exitText)}`] : []),
    `basic-user: verdict: ${verdict(r)}`,
  ]
  for (const line of lines) console.log(line)
  writeFileSync(join(out, 'reading.json'), JSON.stringify({ ...r, verdict: verdict(r) }, null, 2))
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['### Snap: one capture from a basic-user token', '', '```text', ...lines, '```', ''].join('\n'))
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`snap-basic-user: ${err instanceof Error ? err.stack : String(err)}`)
    process.exit(1)
  })
}
