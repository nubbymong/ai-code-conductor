#!/usr/bin/env node
// AI Code Conductor -- Codex hook forwarder (P3.10).
//
// Codex runs this as a command hook (the app gives every Codex launch the same
// hooks through `-c`; providers/codex/hooks.ts): the event's JSON arrives on
// stdin, and this posts it to the app's loopback Hooks gateway for the session
// that started Codex, the way a Claude Code http hook posts to it.
//
// It trusts nothing it is given:
//  - the session is named by the environment Codex passes down
//    (CLAUDE_MULTI_SESSION_ID) and the hook file the app wrote for that launch
//    (CCC_CODEX_HOOK_FILE), laid out as the app makes it:
//    `<app data folder>/codex-hooks/ccc-codex-hook-<random>/hook.json`. Its
//    real path must be that very path below the app data folder's real path
//    (no link or junction at any level the app made, P3.10 round 1), and it
//    must be a small plain file with one name, opened without following a
//    link and still the file looked at; its session id must be the same, its
//    port and token the right shape;
//  - the body is sent as read, at most 4 MiB (the gateway's own cap), and only
//    to 127.0.0.1, never through a proxy the environment names (round 1: Node
//    honours HTTP_PROXY when NODE_USE_ENV_PROXY is set, with no loopback
//    exception, so the request uses no shared agent);
//  - it writes nothing to stdout or stderr (Codex would read stdout as the
//    hook's answer), never waits more than a few seconds, and always exits 0.
// With no hook file (Codex run outside the app with this hook trusted) it does
// nothing.
//
// 2.1.3-beta.18 (ADR-030 S12): a session the session helper holds sends its
// events through its holder instead, so an app update loses none. Its launch
// names the helper's hook mode in the environment (AICC_HELPER_PATH, and
// AICC_HELPER_STORE and AICC_HELPER_SESSION, which the hook mode reads
// itself; session-helper/protocol.ts HOOK_MODE_ENV). Then this runs that
// program, `hook`, with the event on its standard input, and posts nothing.
// The command Codex runs stays the same for every session (its trust is kept
// on the command's text), which is why this script, not the command, chooses.
// It trusts the named program no more than the hook file: it runs it only
// when its real path is this user's helper copy as the app lays it out
// (`<helper folder>/<version>-<12 hex>/aicc-helper[.exe]`: no link at any
// level the app made, one plain file with one name), the store is that
// helper folder's `store` and the session has the helper's shape. Anything
// else, or only some of the three named, does nothing at all.

'use strict'

const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_FILE_BYTES = 4096
const POST_TIMEOUT_MS = 2000
const DEADLINE_MS = 4000
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const TOKEN_RE = /^[A-Za-z0-9-]{16,256}$/
const DIR_PREFIX = 'ccc-codex-hook-'
const FILE_NAME = 'hook.json'
/** The folder in the app's data folder that holds the hook folders
 *  (providers/codex/hooks.ts CODEX_HOOK_ROOT_NAME). */
const ROOT_NAME = 'codex-hooks'
const READ_NO_FOLLOW = fs.constants.O_RDONLY | (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0)
/** The variables a held session's launch names its hook mode by
 *  (src/main/session-helper/protocol.ts HOOK_MODE_ENV). */
const HELPER_ENV = { helper: 'AICC_HELPER_PATH', store: 'AICC_HELPER_STORE', session: 'AICC_HELPER_SESSION' }
/** A holder's session id (helper/src/hello.rs valid_sid; protocol.ts SID_RE). */
const HELPER_SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,31}$/
/** A helper copy's version folder, `<version>-<first 12 hex of its SHA-256>`
 *  (session-helper/protocol.ts HELPER_FOLDER_RE, install.ts versionFolderName). */
const HELPER_FOLDER_RE = /^([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?)-[0-9a-f]{12}$/
/** The folder the helper copies are in: the installed app's `helper`, or a
 *  dev run's `helper/dev` (session-helper/install.ts helperRootDir). */
const HELPER_ROOT_NAMES = ['helper', 'dev']
/** The holders' store, beside the version folders (manager.ts). */
const HELPER_STORE_NAME = 'store'
/** How long the hook mode may run: it ends itself within 2 s (helper/src/hook.rs DEADLINE). */
const HELPER_TIMEOUT_MS = 3000
const CONTROL_RE = /[\x00-\x1f\x7f]/

/** The helper's program name (session-helper/install.ts HELPER_EXE_NAME). */
function helperExeName(platform) {
  return platform === 'win32' ? 'aicc-helper.exe' : 'aicc-helper'
}

/** Two paths as the platform's file system compares them. */
function samePath(a, b, platform) {
  const fold = platform === 'win32' || platform === 'darwin'
  return fold ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** The file's real path is the path the app made: the app data folder's real
 *  path, then `codex-hooks`, the hook folder and `hook.json`, so nothing the
 *  app made on the way is a link or a junction, and the file is inside that
 *  folder. */
function laidOutAsMade(file, platform) {
  const dir = path.dirname(file)
  const root = path.dirname(dir)
  const appDir = path.dirname(root)
  if (!path.basename(dir).startsWith(DIR_PREFIX) || path.basename(root) !== ROOT_NAME) return false
  if (!appDir || appDir === root) return false
  let realFile
  let realApp
  try {
    realFile = fs.realpathSync.native(file)
    realApp = fs.realpathSync.native(appDir)
  } catch {
    return false
  }
  return samePath(realFile, path.join(realApp, ROOT_NAME, path.basename(dir), FILE_NAME), platform)
}

/** The session's hook file, checked, or null. */
function readHookFile(env, platform) {
  const plat = platform || process.platform
  const file = env.CCC_CODEX_HOOK_FILE
  const sid = env.CLAUDE_MULTI_SESSION_ID
  if (typeof file !== 'string' || typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) return null
  if (!path.isAbsolute(file) || path.basename(file) !== FILE_NAME) return null
  if (!laidOutAsMade(file, plat)) return null
  // Identities as bigints (round 2): an NTFS file id can pass 2^53, where a
  // number loses its low bits and two files could compare equal; on Windows
  // (no O_NOFOLLOW) this comparison is the only check that the file opened is
  // the one looked at.
  let st
  try { st = fs.lstatSync(file, { bigint: true }) } catch { return null }
  if (!st.isFile() || st.nlink !== 1n || st.size > BigInt(MAX_FILE_BYTES)) return null
  let text
  let fd = null
  try {
    fd = fs.openSync(file, READ_NO_FOLLOW)
    const opened = fs.fstatSync(fd, { bigint: true })
    // Still the file looked at (not one put in its place since).
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || opened.nlink !== 1n || opened.size > BigInt(MAX_FILE_BYTES)) return null
    const size = Number(opened.size)
    const buf = Buffer.alloc(size)
    const n = size > 0 ? fs.readSync(fd, buf, 0, size, 0) : 0
    text = buf.subarray(0, n).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* closed */ } }
  }
  let j
  try { j = JSON.parse(text) } catch { return null }
  if (!j || typeof j !== 'object' || j.v !== 1) return null
  if (!Number.isInteger(j.port) || j.port < 1 || j.port > 65535) return null
  if (typeof j.sid !== 'string' || j.sid !== sid) return null
  if (typeof j.token !== 'string' || !TOKEN_RE.test(j.token)) return null
  return { port: j.port, sid: j.sid, token: j.token }
}

/**
 * The hook mode a held session's launch names (2.1.3-beta.18), checked:
 * `{ exe }` to run; null when the environment names none of the three
 * variables (not a held session: the hook file's route, as before); false
 * when it names any of them and they do not all check (nothing is done).
 * The program must be this user's helper copy as the app lays it out: its
 * name the helper's, in a version folder, in the helper folder, whose real
 * path is that very path below the real path of the folder the helper folder
 * is in (no link or junction at any level the app made), a plain file with
 * one name. The store must be that helper folder's `store`, and the session
 * of the helper's shape. `fsx` stands in for fs in tests.
 */
function readHelper(env, platform, fsx) {
  const plat = platform || process.platform
  const io = fsx || fs
  const exe = env[HELPER_ENV.helper]
  const store = env[HELPER_ENV.store]
  const sid = env[HELPER_ENV.session]
  if (exe === undefined && store === undefined && sid === undefined) return null
  if (typeof exe !== 'string' || typeof store !== 'string' || typeof sid !== 'string') return false
  if (!HELPER_SID_RE.test(sid)) return false
  if (!path.isAbsolute(exe) || !path.isAbsolute(store) || CONTROL_RE.test(exe) || CONTROL_RE.test(store)) return false
  if (path.basename(exe) !== helperExeName(plat)) return false
  const version = path.dirname(exe)
  const root = path.dirname(version)
  const above = path.dirname(root)
  if (!HELPER_FOLDER_RE.test(path.basename(version)) || !HELPER_ROOT_NAMES.includes(path.basename(root))) return false
  if (!above || above === root) return false
  if (!samePath(path.resolve(store), path.join(root, HELPER_STORE_NAME), plat)) return false
  let realExe
  let realAbove
  try {
    realExe = io.realpathSync.native(exe)
    realAbove = io.realpathSync.native(above)
  } catch {
    return false
  }
  if (!samePath(realExe, path.join(realAbove, path.basename(root), path.basename(version), path.basename(exe)), plat)) return false
  let st
  try { st = io.lstatSync(exe, { bigint: true }) } catch { return false }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n) return false
  return { exe }
}

/** Run the hook mode, `<exe> hook` (the store and the session from the
 *  environment it inherits), with `body` on its standard input and nothing
 *  read from its output; `done` is called once, when it exits or fails, or
 *  after HELPER_TIMEOUT_MS. `spawnFn` stands in for child_process.spawn in tests. */
function runHook(helper, body, done, spawnFn) {
  let finished = false
  let child = null
  let timer = null
  const end = () => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    done()
  }
  timer = setTimeout(() => {
    try { if (child) child.kill() } catch { /* gone */ }
    end()
  }, HELPER_TIMEOUT_MS)
  try {
    child = (spawnFn || spawn)(helper.exe, ['hook'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, shell: false })
  } catch {
    end()
    return
  }
  child.on('error', end)
  child.on('exit', end)
  if (child.stdin) {
    child.stdin.on('error', () => { /* the hook mode stopped reading: its own rule */ })
    child.stdin.end(body)
  }
}

/** Where this event goes: `{ hook }` (the held session's hook mode), `{ post }`
 *  (the gateway, by the hook file), or null (nowhere). A held session's event
 *  never goes to the gateway. */
function chooseRoute(env, platform, fsx) {
  const helper = readHelper(env, platform, fsx)
  if (helper === false) return null
  if (helper) return { hook: helper }
  const cfg = readHookFile(env, platform)
  return cfg ? { post: cfg } : null
}

/** The request's options: 127.0.0.1 itself, and no agent (`agent: false`
 *  takes a fresh connection outside the shared agent, which is where Node's
 *  environment proxy support lives). */
function requestOptions(cfg, body) {
  return {
    host: '127.0.0.1',
    port: cfg.port,
    path: `/hook/${cfg.sid}`,
    method: 'POST',
    agent: false,
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
      'x-ccc-hook-token': cfg.token,
      connection: 'close',
    },
    timeout: POST_TIMEOUT_MS,
  }
}

/** Post `body` to the gateway for `cfg`; `done` is called once, whatever happens. */
function forward(cfg, body, done, request) {
  let finished = false
  const end = () => { if (!finished) { finished = true; done() } }
  try {
    const req = (request || http.request)(requestOptions(cfg, body), (res) => {
      res.on('error', end)
      res.on('end', end)
      res.resume()
    })
    req.on('error', end)
    req.on('timeout', () => { try { req.destroy() } catch { /* gone */ } end() })
    req.end(body)
  } catch {
    end()
  }
}

/** Read stdin to its end, at most MAX_BODY_BYTES; `onBody` gets the bytes, or
 *  null when there were more. */
function readBody(stream, onBody) {
  const chunks = []
  let total = 0
  let over = false
  let settled = false
  const settle = (v) => { if (!settled) { settled = true; onBody(v) } }
  stream.on('data', (c) => {
    if (over) return
    total += c.length
    if (total > MAX_BODY_BYTES) { over = true; settle(null); return }
    chunks.push(c)
  })
  stream.on('end', () => settle(over ? null : Buffer.concat(chunks)))
  stream.on('error', () => settle(null))
}

function main() {
  const quit = () => process.exit(0)
  process.on('uncaughtException', quit)
  setTimeout(quit, DEADLINE_MS)
  const route = chooseRoute(process.env)
  if (!route) return quit()
  readBody(process.stdin, (body) => {
    if (!body || body.length === 0) return quit()
    if (route.hook) runHook(route.hook, body, quit)
    else forward(route.post, body, quit)
  })
}

if (require.main === module) main()

module.exports = { readHookFile, forward, readBody, requestOptions, readHelper, runHook, chooseRoute, MAX_BODY_BYTES, MAX_FILE_BYTES, ROOT_NAME, HELPER_ENV, HELPER_TIMEOUT_MS }
