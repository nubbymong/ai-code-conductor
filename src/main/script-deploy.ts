import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteFileSync, isRenameStageFailure } from './atomic-write'
import { logWarn } from './debug-logger'

/**
 * Put one of the app's own script files in place (the status line script,
 * the resume pickers, their helper lib, the hook forwarder and its Windows
 * wrapper) in the resources folder's scripts folder. The status line
 * script's bytes are made by the app (deployScriptBytes); every other
 * script's are read from the source beside the app (deployScriptFile).
 *
 * In a packaged build these scripts ship inside app.asar. Electron serves
 * fs.copyFileSync from inside the archive by first copying the file out to a
 * new temporary file, and removes that file only when the archive is closed,
 * which on Windows does not happen before the process ends. So every start
 * left one temporary file per script in the temp folder (five files, about
 * 114 KB, each start). fs.readFileSync reads the bytes straight from the
 * archive, with no temporary file, so the source is only ever read with it,
 * never with copyFileSync (nor openSync, which Electron serves the same way).
 *
 * The destination is read without following a link (lstat) before anything
 * else is done with it. Its bytes are read only when that shows a plain file,
 * through a handle opened without following a link and without waiting (on
 * macOS and Linux a FIFO put there meanwhile is never waited on), and only
 * while that handle is a plain file of the shipped bytes' size; a plain file
 * of another size, and anything else there (a link, a directory, a FIFO, a
 * socket or a device), is replaced as a copy whose bytes differ, unread. The
 * shipped bytes are compared with a plain file's and written only when they
 * differ: a start with nothing new writes nothing, and a changed or tampered
 * copy is still put back to the shipped bytes on every start.
 *
 * Before a write, a link of any kind at the destination (a symbolic link,
 * and on Windows also a junction) is removed as a link, never what it names.
 * A directory there is removed only when it is empty: what a directory holds
 * is never deleted, so one that is not empty fails the deploy. On Windows a
 * plain file with one name there that has the read-only attribute is made
 * writable first, so that the rename (or the in-place write, below) can
 * replace it.
 *
 * The bytes go to a new file in the same folder, made with mode 0600 (on
 * macOS and Linux readable and writable by this user only), which is then
 * renamed over the destination (atomicWriteFileSync, as writePlainCopies
 * writes the hook copies). On macOS and Linux that rename is the only write,
 * and it never opens the destination: a handle someone opened on the old copy
 * then reaches a file nothing uses any more. On Windows it is the write tried
 * first, and Windows refuses it while another process has the old copy open
 * (a sync, backup or antivirus client, say). There, when the old copy is a
 * plain file with one name, its bytes are written in place instead, through a
 * handle opened on the destination and checked to be that same file before
 * anything is written: the shipped bytes still land, and the handle the other
 * process holds still reaches the copy in use. An in-place write that fails
 * partway can leave a copy that is partly the shipped bytes; its bytes then
 * differ, so the next start replaces it.
 *
 * A copy with the shipped bytes is replaced the same way when it is not a
 * plain file with one name (a link, or a hard link: a file with another name,
 * through which it can be changed), and on macOS and Linux also when another
 * user owns it or group or others have any permission bit on it (a restore or
 * a sync tool loosened it, say): the copy in use is a plain file with one
 * name again, on macOS and Linux this user's only, and what held the old one
 * no longer reaches it. (On Windows who owns a copy and who may change it are
 * read by the owner-only folder rule the scripts folders go through at each
 * start, script-folders.ts.) Such a copy is never written in place, on any
 * platform. That is best effort: a failure logs one warning a run, by the
 * file's name and the error code only, and the copy is left there. On macOS
 * and Linux a folder that cannot keep the mode at all (a network share
 * mounted without permission support, a FAT drive) has its copies replaced
 * at every start. Windows keeps no such mode, so there a plain file with one
 * name and the shipped bytes is left as it is.
 *
 * A missing source does nothing (an unpackaged run with no scripts beside it).
 * A failure to read the source throws. A failure to put in place a copy whose
 * bytes differ, or anything at the destination that is not a plain file,
 * logs a warning by the file's name and the error code, and throws, as
 * copyFileSync did, so callers keep their contract. What was at the
 * destination is then left there, unless it was a link or an empty directory
 * that was removed before the write that failed (a launch then finds no copy
 * and runs without it), or a Windows in-place write failed partway (above); a
 * link whose removal failed stays.
 *
 * A launch runs a deployed script only through the checks in
 * script-folders.ts (checkDeployedScript): the script a plain file with one
 * name (isPlainScriptFile), in a scripts folder made this user's alone in this
 * run, and not one whose deploy failed in this run (deployFailedThisRun: the
 * source could not be read, or the shipped bytes could not be put in place,
 * so what is there is not known to be the app's copy).
 */
export type ScriptDeployResult = 'no-source' | 'unchanged' | 'written'

/** The mode every copy is made with. */
export const SCRIPT_DEPLOY_NEW_FILE_MODE = 0o600

/** Whether this run has logged its one warning about a copy it could not
 *  replace. */
let healWarningLogged = false

/** Tests only: the next failure logs its warning again, and no destination
 *  is recorded as failed this run (deployFailedThisRun). */
export function _resetScriptDeployWarningForTest(): void {
  healWarningLogged = false
  deployFailed.clear()
}

/** macOS and Linux: whether `st` is this user's (its owner the user this
 *  process runs as) and no one else may write to it (no group or other write
 *  bit). Windows keeps no such owner or mode in what lstat reads (and its
 *  processes have no POSIX user id): there the owner-only folder rule reads
 *  who owns a script and who may change it (script-folders.ts), and this
 *  holds. */
function ownedAndClosed(st: fs.Stats, platform: NodeJS.Platform): boolean {
  if (platform === 'win32' || typeof process.getuid !== 'function') return true
  return st.uid === process.getuid() && (st.mode & 0o022) === 0
}

/** Whether the user this process runs as owns `st` (where the process can
 *  say who that is: everywhere but Windows). */
function ownedByThisUser(st: fs.Stats): boolean {
  return typeof process.getuid !== 'function' || st.uid === process.getuid()
}

/** Whether `p`, read without following a link, is a plain file with one name:
 *  not a link or a junction, not a directory, and no hard link (another name
 *  for the same file, through which it can be changed); on macOS and Linux
 *  also this user's, and no one else may write to it. The check a launch
 *  makes on a deployed script before it runs it (with the folder check in
 *  script-folders.ts). `platform` is for tests. */
export function isPlainScriptFile(p: string, platform: NodeJS.Platform = process.platform): boolean {
  let st: fs.Stats
  try {
    st = fs.lstatSync(p)
  } catch {
    return false
  }
  return st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && ownedAndClosed(st, platform)
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? 'unknown error'
}

/** Whether a copy that already has the shipped bytes is still to be replaced:
 *  it is not a plain file with one name (a link, or a hard link), or, on macOS
 *  and Linux, another user owns it or group or others have a permission bit
 *  on it (Windows keeps no such owner or mode in what lstat reads). */
function needsReplacing(st: fs.Stats, platform: NodeJS.Platform): boolean {
  if (!st.isFile() || st.nlink !== 1) return true
  return platform !== 'win32' && ((st.mode & 0o077) !== 0 || !ownedByThisUser(st))
}

/** Remove what `st` shows at `dest` when it is a link or a directory: a link
 *  as a link, never what it names (a directory link or a junction that
 *  Windows will not unlink is removed as a directory, which takes the link
 *  only; when that fails too, the unlink's own error is what throws); a
 *  directory only when empty, never what it holds (one that is not empty
 *  throws). A file is left for the rename to replace. */
function clearForWrite(dest: string, st: fs.Stats | null, platform: NodeJS.Platform): void {
  if (!st) return
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(dest)
    } catch (err) {
      if (platform !== 'win32') throw err
      try {
        fs.rmdirSync(dest)
      } catch {
        throw err
      }
    }
    return
  }
  if (st.isDirectory()) fs.rmdirSync(dest)
}

/** Whether `p` is a real folder: read without following a link (lstat), a
 *  directory that is not a link, AND the system's own resolved path for it
 *  (fs.realpathSync.native) is its own name in its parent's resolved path,
 *  compared without case on Windows and macOS; on macOS and Linux also this
 *  user's, and no one else may write to it. A path that cannot be resolved
 *  is not one (fails closed). The check a launch makes on the folders a
 *  deployed script runs from (with the folder check in script-folders.ts).
 *  `platform` is for tests. */
export function isRealScriptFolder(p: string, platform: NodeJS.Platform = process.platform): boolean {
  const st = lstatOrNull(p)
  return st !== null && isRealFolderShape(p, st, platform) && ownedAndClosed(st, platform)
}

/** The shape half of isRealScriptFolder: `st` (read a moment ago without
 *  following a link) a directory that is not a link, whose resolved path is
 *  its own place. */
function isRealFolderShape(p: string, st: fs.Stats, platform: NodeJS.Platform): boolean {
  if (!st.isDirectory() || st.isSymbolicLink()) return false
  let resolved: string
  let expected: string
  try {
    resolved = fs.realpathSync.native(p)
    expected = path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p))
  } catch {
    return false
  }
  if (platform === 'win32' || platform === 'darwin') return resolved.toLowerCase() === expected.toLowerCase()
  return resolved === expected
}

/** Make `dir` a real folder (isRealScriptFolder) before scripts are deployed
 *  into it. A real folder there is kept, with what it holds; on macOS and
 *  Linux one of this user's that others may write to is made 0700 again.
 *  Anything else there that is a link or a directory is removed by the rule a
 *  script's destination is cleared by (clearForWrite: a link as a link, never
 *  what it names; a directory only when empty; never recursive), and a real
 *  folder is made in its place with mode 0700, without making any folder
 *  above it. A file there is left, and making the folder then throws. The
 *  folder made is checked again, and one that is not a real folder throws. A
 *  failure is logged by the folder's name and the error code, and throws.
 *  `platform` is for tests. */
export function prepareScriptFolder(dir: string, platform: NodeJS.Platform = process.platform): void {
  if (isRealScriptFolder(dir, platform)) return
  try {
    const st = lstatOrNull(dir)
    if (st && platform !== 'win32' && isRealFolderShape(dir, st, platform) && ownedByThisUser(st)) {
      fs.chmodSync(dir, 0o700)
    } else {
      clearForWrite(dir, st, platform)
      fs.mkdirSync(dir, { mode: 0o700 })
    }
    if (!isRealScriptFolder(dir, platform)) {
      throw Object.assign(new Error('the folder made is not a real folder'), { code: 'ENOTREALDIR' })
    }
  } catch (err) {
    logWarn(`[scripts] the ${path.basename(dir)} folder could not be made a real folder (${errorCode(err)})`)
    throw err
  }
}

/** What Windows answers a rename over a file another process has open. */
const HELD_OPEN_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Windows: write `bytes` into `dest` in place, only when it is a plain file
 *  with one name and the handle opened for the write is that same file (so
 *  nothing put there meanwhile is written through). False when it is not. */
function writeInPlace(dest: string, bytes: Buffer): boolean {
  let before: fs.BigIntStats
  try {
    before = fs.lstatSync(dest, { bigint: true })
  } catch {
    return false
  }
  if (!before.isFile() || before.isSymbolicLink() || Number(before.nlink) !== 1) return false
  const fd = fs.openSync(dest, 'r+')
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    if (!opened.isFile() || Number(opened.nlink) !== 1 || opened.ino !== before.ino || opened.dev !== before.dev) return false
    fs.writeFileSync(fd, bytes)
    fs.ftruncateSync(fd, bytes.length)
    return true
  } finally {
    fs.closeSync(fd)
  }
}

/** A new file with `bytes`, made with mode 0600, renamed over `dest` once what
 *  `st` shows there is cleared (clearForWrite). On Windows a plain file with
 *  one name there that has the read-only attribute (its mode has no write
 *  bit) is made writable first: Windows refuses a rename over a read-only
 *  file, and the write in place too. (Never one with another name: the
 *  attribute belongs to the file, so that would change it for its other name
 *  as well.) On Windows, when the rename is refused as for a file another
 *  process has open, the bytes are written in place instead where
 *  writeInPlace allows it. */
function replaceWith(dest: string, bytes: Buffer, st: fs.Stats | null, platform: NodeJS.Platform): void {
  clearForWrite(dest, st, platform)
  if (platform === 'win32' && st && st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && (st.mode & 0o200) === 0) {
    try { fs.chmodSync(dest, 0o666) } catch { /* the rename then says why it failed */ }
  }
  try {
    atomicWriteFileSync(dest, bytes, { mode: SCRIPT_DEPLOY_NEW_FILE_MODE })
  } catch (err) {
    // Only a refused rename: a failure to write the new file says nothing
    // about the destination, which is then left untouched.
    if (platform !== 'win32' || !isRenameStageFailure(err) || !HELD_OPEN_CODES.has(errorCode(err))) throw err
    if (!writeInPlace(dest, bytes)) throw err
  }
}

/** The bytes of `p`, which lstat showed a moment ago to be a plain file:
 *  read through a handle opened without following a link and without
 *  waiting (O_NOFOLLOW and O_NONBLOCK where the system has them: on macOS and
 *  Linux a link or a FIFO put there meanwhile is never read through or waited
 *  on), and only while that handle is a plain file of `size` bytes (the
 *  shipped bytes' size: a file of another size has other bytes, so it is
 *  never read, and a large one put there is not read in full; a plain file is
 *  read up to the size its handle gave). Null otherwise. */
function readPlainFile(p: string, size: number): Buffer | null {
  const c = fs.constants as { O_RDONLY: number; O_NOFOLLOW?: number; O_NONBLOCK?: number }
  let fd: number
  try {
    fd = fs.openSync(p, c.O_RDONLY | (c.O_NOFOLLOW ?? 0) | (c.O_NONBLOCK ?? 0))
  } catch {
    return null
  }
  try {
    const st = fs.fstatSync(fd)
    return st.isFile() && st.size === size ? fs.readFileSync(fd) : null
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/** The destinations whose deploy failed in this run (the source could not be
 *  read, or the shipped bytes could not be put in place there), by their
 *  resolved path, until a later deploy in this run finds or puts the shipped
 *  bytes there. A launch does not run what is at one of them
 *  (script-folders.ts checkDeployedScript, and the launch's hook check). */
const deployFailed = new Set<string>()

/** Whether this run's deploy of `dest` failed, with no deploy since that
 *  found or put the shipped bytes there. */
export function deployFailedThisRun(dest: string): boolean {
  return deployFailed.has(path.resolve(dest))
}

/** Put the script at `src` (read with readFileSync, see above) in place at
 *  `dest` (deployScriptBytes). A source that is there but cannot be read
 *  throws, and `dest` is recorded as failed (deployFailedThisRun). `platform`
 *  is for tests. */
export function deployScriptFile(src: string, dest: string, platform: NodeJS.Platform = process.platform): ScriptDeployResult {
  if (!fs.existsSync(src)) return 'no-source'
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(src)
  } catch (err) {
    deployFailed.add(path.resolve(dest))
    throw err
  }
  return deployScriptBytes(bytes, dest, platform)
}

/** Put a script whose bytes are `bytes` in place at `dest`, by the rules in
 *  the header: what is there is read with lstat first, and its bytes only when
 *  that shows a plain file. A failure to put the shipped bytes in place
 *  records `dest` as failed this run (deployFailedThisRun); finding them
 *  there, or putting them there, clears that. `platform` is for tests. */
export function deployScriptBytes(bytes: Buffer, dest: string, platform: NodeJS.Platform = process.platform): Exclude<ScriptDeployResult, 'no-source'> {
  const key = path.resolve(dest)
  const st = lstatOrNull(dest)
  const current = st && st.isFile() && !st.isSymbolicLink() ? readPlainFile(dest, bytes.length) : null
  if (st && current !== null && current.equals(bytes)) {
    // The shipped bytes are there, whether or not the copy is replaced below.
    deployFailed.delete(key)
    if (!needsReplacing(st, platform)) return 'unchanged'
    try {
      replaceWith(dest, bytes, st, platform)
      return 'written'
    } catch (err) {
      if (!healWarningLogged) {
        healWarningLogged = true
        logWarn(`[scripts] ${path.basename(dest)} could not be replaced with a new plain copy (${errorCode(err)}); it is left as it is. Further such failures this run are not logged`)
      }
      return 'unchanged'
    }
  }
  try {
    replaceWith(dest, bytes, st, platform)
  } catch (err) {
    deployFailed.add(key)
    logWarn(`[scripts] ${path.basename(dest)} could not be put in place with the shipped bytes (${errorCode(err)})`)
    throw err
  }
  deployFailed.delete(key)
  return 'written'
}
