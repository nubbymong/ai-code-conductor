// 2.1.3-beta.17 (plan section B1.2, S16 step 5, aicc_planning#412): the hook
// file of a Codex session an app update kept running, written again for the
// run that takes it over. Codex runs the app's forwarder at every hook event,
// and the forwarder reads `hook.json` (the gateway's port, the session id and
// its token) from the folder the launch named in CCC_CODEX_HOOK_FILE, at every
// event (hooks.ts). The CLI keeps that path for its life, and the last run's
// token is refused by this run's gateway, so the take-over writes the file
// again in place, in that same folder, with this run's port and a token minted
// for it. The folder is the release's record's, and is taken only where a
// launch makes one: directly in this install's own hook root, prepared this
// run, with the per-launch prefix, every folder in its chain a real folder
// (never a link or junction). Nothing else is written, and nothing is started.
// 2.1.3-beta.18 (ADR-030 S12): only for a kept session whose hook events went
// to the gateway (its record has no `hooks: 'holder'` mark: one 2.1.3-beta.17
// or earlier kept, or one whose launch did not send them through its holder);
// a session whose forwarder runs the session helper's hook mode needs no file
// (lifecycle.ts codexTakeOver).
import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteFileSync } from '../../atomic-write'
import { CODEX_HOOK_DIR_PREFIX, CODEX_HOOK_FILE_NAME, preparedCodexHookRoot, realFolderChainBelow } from './hooks'

/** A session id as the gateway routes it (hooks.ts's rule). */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** A gateway token as the gateway mints it (hooks.ts's rule; the forwarder checks the same). */
const TOKEN_RE = /^[A-Za-z0-9-]{16,256}$/
const CONTROL_RE = /[\x00-\x1f\x7f]/
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin'

const folded = (p: string): string => {
  const abs = path.resolve(p)
  return FOLD_CASE ? abs.toLowerCase() : abs
}

/**
 * Write `hook.json` again in `dir`, the per-launch hook folder of a session an
 * update kept running, with this run's `port` and the token minted for the
 * take-over (`secret`), whole and owner-only, as writeCodexHookFile writes it.
 * The path of the file written, or null when `dir` is not a per-launch folder
 * of this install's prepared hook root (`<dataDir>/codex-hooks`), a value is
 * not what the gateway would route, or the write fails.
 */
export function rewriteKeptCodexHookFile(dir: string, sessionId: string, port: number, secret: string, dataDir: string | null): string | null {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (typeof secret !== 'string' || !TOKEN_RE.test(secret)) return null
  if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir) || CONTROL_RE.test(dir)) return null
  if (typeof dataDir !== 'string' || !dataDir || !path.isAbsolute(dataDir)) return null
  const root = preparedCodexHookRoot(dataDir)
  if (!root || folded(path.dirname(dir)) !== folded(root)) return null
  if (!path.basename(dir).startsWith(CODEX_HOOK_DIR_PREFIX)) return null
  if (!realFolderChainBelow(dataDir, dir)) return null
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null
  } catch {
    return null
  }
  const file = path.join(dir, CODEX_HOOK_FILE_NAME)
  try {
    atomicWriteFileSync(file, JSON.stringify({ v: 1, port, sid: sessionId, token: secret }), { mode: 0o600 })
  } catch {
    return null
  }
  return file
}
