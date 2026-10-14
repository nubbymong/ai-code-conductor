// The resources folder's scripts folders, <resources>/scripts and its lib
// folder: where the app deploys the scripts its sessions run (the status
// line script, both resume pickers and a picker's helper lib, the hook
// forwarder and its Windows wrapper).
//
// Once a run, before those scripts are deployed, both folders go through the
// app's owner-only folder rule (owner-only-folders.ts secureScriptFoldersRule:
// each made this user's and owner-only and read back; on Windows what is
// directly inside each is read and put right too, as for the sign-in
// folders), asynchronously, never on the main thread's path, the way the
// sign-in folders ask it (account-profiles.ts askRule and passed): each
// folder's identity is read before the rule is asked, and a folder passes
// only when it is still that same folder after the answer (one the rule made,
// not there before, passes as the folder there after it). A folder the rule
// gave no read of at all (a call that could not run or end, as a cold Windows
// PowerShell can once) is asked once more, as the sign-in folders' are
// (checkHomesAnswering). The lib folder passes only inside a scripts folder
// that passed, and is not said again when the scripts folder was not. The
// deploys follow (index.ts), and only once they ran (scriptFoldersDeployed)
// may a launch take a script from a folder that passed. checkDeployedScript holds
// only while the script is a plain file with one name (and on macOS and
// Linux this user's, with no write for others: isPlainScriptFile) whose
// deploy did not fail in this run (deployFailedThisRun), in a folder that
// passed in this run, is still that same folder (its volume and
// file id) and is still a real folder (isRealScriptFolder). Otherwise the
// feature that needs the script is skipped for that launch (no status line
// of the app's, no resume list, no hook scripts: the session starts without
// it), said in one warning, and nothing of the folder's runs.
//
// A local session launch waits for this, bounded
// (awaitScriptFolders, from pty-handlers), so a tab restored at start has its
// scripts; past the bound it starts without them. A folder the rule cannot
// make owner-only (a network share, a FAT drive) is said once at start, and
// the features its scripts serve are skipped for the run; the sessions still
// start.
import * as fs from 'fs'
import * as path from 'path'
import { logWarn } from './debug-logger'
import { isPlainScriptFile, isRealScriptFolder, deployFailedThisRun } from './script-deploy'

/** One folder's answer from the rule (owner-only-folders.ts
 *  OwnerOnlyFolderResult). `unread`: the call gave no read of this folder at
 *  all (it could not run or end), as against a folder read and refused. */
export interface ScriptFolderAnswer { dir: string; ok: boolean; detail?: string; unread?: true }

/** The owner-only rule, injected (owner-only-folders.ts secureScriptFoldersRule):
 *  given folders in order, says per folder whether it is now this user's and
 *  owner-only. Asynchronous; never on the main thread's path. */
export type SecureScriptFolders = (dirs: readonly string[]) => Promise<ReadonlyArray<ScriptFolderAnswer>>

/** A folder as asked: its identity read just before the rule was asked (null:
 *  not there, the rule was to make it), the rule's answer for it, and why the
 *  call failed when it rejected. */
interface Asked { before: string | null; answer: ScriptFolderAnswer | undefined; failure?: string }

/** The rule asked about `dirs` (one call, in order), each folder's identity
 *  read first; the answers go into `asked`, replacing any earlier ones. A call
 *  that rejects gives no answer, said by its reason. Never rejects. */
async function askRule(secure: SecureScriptFolders, dirs: readonly string[], asked: Map<string, Asked>): Promise<void> {
  const before = dirs.map((dir) => identity(dir))
  let results: unknown
  let failure: string | undefined
  try {
    results = await secure(dirs)
  } catch (err) {
    failure = String((err as Error)?.message ?? err)
  }
  dirs.forEach((dir, i) => {
    const answer = Array.isArray(results) ? (results as Array<ScriptFolderAnswer | undefined>).find((x) => !!x && x.dir === dir) : undefined
    asked.set(dir, { before: before[i], answer, failure })
  })
}

/** The rule gave no read of this folder: no answer for it, or one that says
 *  `unread`. Never a refusal. */
function noRead(a: Asked | undefined): boolean {
  return !a?.answer || a.answer.unread === true
}

/** How long a local launch waits for this run's check and deploys. */
export const SCRIPT_FOLDERS_LAUNCH_WAIT_MS = 5000
/** How much of the rule's reason a warning carries. */
const DETAIL_MAX = 300

/** A path's last name. */
function lastName(p: string): string {
  return p.split(/[\\/]+/).filter(Boolean).pop() ?? ''
}

/** An unquoted path and the text after it (up to a quote, ')', ',', ';' or
 *  the end), with the path put as its last name only. A folder's name can
 *  hold a space, so where the path ends cannot be told: everything up to the
 *  last separator goes ("C:\Users\Jo Smith\x is denied" reads "x is denied"),
 *  and a path that ends with a separator keeps the name before it. */
function afterLastSeparator(p: string): string {
  const t = p.replace(/[\\/]+(\s*)$/, '$1')
  return t.slice(Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/')) + 1)
}

/** The rule's reason as a warning carries it: never a path. Node's fs
 *  messages quote the full path ("EACCES: permission denied, chmod '<path>'"),
 *  and a call's own reason can name one too. The resources folder's path
 *  reads as "the resources folder", a quoted path by its last name only, and
 *  an unquoted one (one that starts at a drive, a share or the root) by its
 *  last name only too, spaces in its folders' names included
 *  (afterLastSeparator). */
function withoutPaths(why: string, resourcesDir: unknown): string {
  let out = typeof resourcesDir === 'string' && resourcesDir ? why.split(resourcesDir).join('the resources folder') : why
  out = out.replace(/(['"])([^'"]*[\\/][^'"]*)\1/g, (_m, q: string, p: string) => q + lastName(p) + q)
  return out.replace(/(^|[\s(=:,])((?:[A-Za-z]:[\\/]|\\\\|\/)[^'"(),;]*)/g, (_m, pre: string, p: string) => pre + afterLastSeparator(p))
}

/** idle: nothing started this run (a launch then finds no folder checked);
 *  securing: the rule is running; deploying: the deploys are running; ready:
 *  both ran. */
type Phase = 'idle' | 'securing' | 'deploying' | 'ready'
let phase: Phase = 'idle'
/** The folders the rule passed this run, each with its identity then. */
let passed = new Map<string, string>()
/** Launches waiting for the deploys to have run. */
let waiters: Array<() => void> = []

/** A folder's identity (its volume and file id), or null when the file system
 *  gives none. */
function identity(dir: string): string | null {
  try {
    const st = fs.lstatSync(dir, { bigint: true })
    return st.ino ? `${st.dev}:${st.ino}` : null
  } catch {
    return null
  }
}

/** The two folders, in the order the rule takes them (a missing one is made
 *  inside its parent, which must have passed first). */
function scriptFolders(resourcesDir: string): [string, string] {
  const scripts = path.join(resourcesDir, 'scripts')
  return [scripts, path.join(scripts, 'lib')]
}

/** At start, before the deploys: the scripts folders through the owner-only
 *  rule (`secure`), once this run, and once more, as one call in the same
 *  order, for those it gave no read of (noRead). The resources folder itself
 *  is made first when it is not there yet (a first start; the deploys made it
 *  before), as the rule makes a missing folder only inside a parent that is
 *  there. A folder passes when the rule says so for it and it is the same
 *  folder after the answer as before the ask (askRule); the lib folder only
 *  when the scripts folder passed too. A folder refused, or the rule failing,
 *  is said in one warning per folder (by its name and the rule's reason, any
 *  path in that reason put as its last name only; none for the lib folder
 *  when the scripts folder's covers it), and what its
 *  scripts serve is skipped for the run. Never throws. */
export async function secureScriptFolders(resourcesDir: string, secure: SecureScriptFolders): Promise<void> {
  phase = 'securing'
  passed = new Map()
  const refused: Array<{ name: string; why: string }> = []
  try {
    if (typeof resourcesDir !== 'string' || !resourcesDir || !path.isAbsolute(resourcesDir)) throw new Error('the resources folder is not an absolute path')
    try {
      fs.mkdirSync(resourcesDir, { recursive: true })
    } catch { /* the rule then says why the scripts folder could not be made */ }
    const dirs = scriptFolders(resourcesDir)
    const asked = new Map<string, Asked>()
    await askRule(secure, dirs, asked)
    const again = dirs.filter((dir) => noRead(asked.get(dir)))
    if (again.length > 0) await askRule(secure, again, asked)
    const [scripts] = dirs
    for (const dir of dirs) {
      // The lib folder is only as safe as the scripts folder it is in; the
      // scripts folder's warning already says what is not used.
      if (dir !== scripts && !passed.has(scripts)) continue
      const { before, answer, failure }: Asked = asked.get(dir) ?? { before: null, answer: undefined }
      const now = identity(dir)
      if (answer?.ok === true && answer.unread !== true && now !== null && (before === null || before === now)) {
        passed.set(dir, now)
        continue
      }
      const why = !answer
        ? failure ?? 'no answer'
        : answer.ok !== true || answer.unread === true
          ? String(answer.detail ?? 'refused')
          : now === null ? 'it has no file id' : 'another folder took its place while it was checked'
      refused.push({ name: path.basename(dir), why })
    }
  } catch (err) {
    refused.push({ name: 'scripts', why: String((err as Error)?.message ?? err) })
  }
  for (const { name, why } of refused) {
    const skipped = name === 'lib' ? 'the resume list that loads its helper is not used' : "the app's status line, the resume lists and the hook scripts deployed there are not used"
    logWarn(`[scripts] the ${name} folder in the resources folder could not be made this user's alone (${withoutPaths(why, resourcesDir).slice(0, DETAIL_MAX)}), so ${skipped} this run; sessions still start`)
  }
  phase = 'deploying'
}

/** At start, once this run's deploys into the scripts folders ran (each step
 *  done or failed): launches may take scripts from the folders that passed,
 *  and every launch waiting goes on. */
export function scriptFoldersDeployed(): void {
  phase = 'ready'
  const w = waiters
  waiters = []
  for (const f of w) {
    try { f() } catch { /* one launch never stops another */ }
  }
}

/** Whether this run's check and deploys are still running (a launch that
 *  starts now waits for them, awaitScriptFolders). */
export function scriptFoldersPending(): boolean {
  return phase === 'securing' || phase === 'deploying'
}

/** A local launch: wait, at most `waitMs`, for this run's check and deploys.
 *  At once when they ran, or when nothing started them. Never rejects. */
export function awaitScriptFolders(waitMs: number = SCRIPT_FOLDERS_LAUNCH_WAIT_MS): Promise<void> {
  if (!scriptFoldersPending()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, waitMs)
    ;(timer as { unref?: () => void }).unref?.()
    waiters.push(finish)
  })
}

/** Why a launch may not take a script from `dir`, in words for the log
 *  (never a path), or null when it may: `dir` passed the rule in this run,
 *  this run's deploys ran, and it is still that same folder and a real one. */
export function scriptFolderRefusal(dir: string): string | null {
  if (phase === 'securing' || phase === 'deploying') return 'is still being checked'
  const id = phase === 'ready' ? passed.get(dir) : undefined
  if (id === undefined) return "was not made this user's alone in this run"
  if (identity(dir) !== id || !isRealScriptFolder(dir)) return 'is not the folder made this user\'s alone in this run'
  return null
}

/** What a launch may do with a deployed script (checkDeployedScript). */
export type DeployedScriptCheck =
  | { ok: true }
  | { ok: false; absent: true }
  | { ok: false; absent: false; why: string }

/** Whether a launch may run the deployed script `file`: a plain file with one
 *  name (and on macOS and Linux this user's, with no write for others;
 *  isPlainScriptFile) whose deploy did not fail in this run
 *  (deployFailedThisRun), in a scripts folder made this user's alone in this
 *  run (scriptFolderRefusal). `absent` when nothing is there (not deployed yet;
 *  the caller says nothing more). Otherwise `why`, naming the file or its
 *  folder by name only, for the caller's one warning. */
export function checkDeployedScript(file: string): DeployedScriptCheck {
  try {
    fs.lstatSync(file)
  } catch {
    return { ok: false, absent: true }
  }
  if (!isPlainScriptFile(file)) return { ok: false, absent: false, why: `${path.basename(file)} in the resources folder is not a plain file with one name that only this user can change` }
  if (deployFailedThisRun(file)) return { ok: false, absent: false, why: `${path.basename(file)} in the resources folder could not be brought up to date this run` }
  const dir = path.dirname(file)
  const folder = scriptFolderRefusal(dir)
  if (folder) return { ok: false, absent: false, why: `the ${path.basename(dir)} folder in the resources folder ${folder}` }
  return { ok: true }
}

/** Tests only: the scripts folders of `resourcesDir` as if the rule passed
 *  both and this run's deploys ran (each by its identity now; one missing is
 *  not passed). */
export function __markScriptFoldersCheckedForTests(resourcesDir: string): void {
  passed = new Map()
  for (const dir of scriptFolders(resourcesDir)) {
    const id = identity(dir)
    if (id !== null) passed.set(dir, id)
  }
  phase = 'ready'
}

/** Tests only: back to nothing started this run. */
export function __resetScriptFoldersForTests(): void {
  phase = 'idle'
  passed = new Map()
  waiters = []
}
