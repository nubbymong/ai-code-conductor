import * as nodeFs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { openTkDb, TK_REBUILD_PAGE, type TkDb, type TkFileCursor } from './tk-db'
import { parseClaudeUsageLine, extractCwdFromLine, codexEventsFromRollout, type CodexRolloutSeed } from './tk-parse'
import { findConfigForCwd, isJunkCwd } from './tk-config-match'
import type { TkConfigDim, TkEvent, TkPricing, TkSessionsRoot, TkAccountReread, TkWalkCount, TkWalkStats } from './tk-types'
import { tkAccountKeyOk, tkSessionUuidOk, tkClaudeAccountKeyOk, TK_CODEX_EXTERNAL } from './tk-types'
import type { ToTkWorker, FromTkWorker, TkWorkerHostTransport } from './tk-worker-transport'

export interface TkWorkerDeps { fs?: typeof nodeFs; watchDebounceMs?: number; configs?: TkConfigDim[]; maxTickBytes?: number }
export interface TokenomicsWorker { tickNow(): void; healthNow(): void; stop(): void }

const READ_BUF = 256 * 1024
/**
 * How much of a Codex rollout's head to scan for its identity lines.
 *
 * 64 KB was too small twice over on a real tree: `session_meta` alone reached
 * 47 KB, and the first `turn_context` (the line that names the model, and so
 * decides what every turn costs) was measured at 36-116 KB into the file, past
 * the window in 12 of 14 sampled rollouts. This is read at most once per file -
 * the identity is persisted on the cursor afterwards - so the window can afford
 * to be generous.
 */
const CODEX_HEAD_BYTES = 1024 * 1024
const CODEX_MARK_TOKEN = Buffer.from('"token_count"')
const CODEX_MARK_META = Buffer.from('"session_meta"')
const CODEX_MARK_TURN = Buffer.from('"turn_context"')
/**
 * The longest line the Codex parser can possibly want. Everything past this is
 * tool output, and skipping it undecoded is the whole point of the pre-filter.
 *
 * This was 64 KB, which was not a safety margin at all: a rollout's
 * `session_meta` line carries the instruction blob AND the serialised tool
 * schemas, so it grows with the user's AGENTS.md and with every MCP server
 * they add. Measured across a real 320-rollout tree it reached 47 KB — 72 % of
 * that bound, and climbing every month. Crossing it did not degrade
 * gracefully: without `session_meta` the parser has no session id and returns
 * NOTHING, while the cursor still advanced, so the rollout's entire spend
 * disappeared silently and permanently. 1 MB is ~21x the observed maximum; a
 * `token_count` line is under 1 KB.
 */
const CODEX_MAX_LINE = 1024 * 1024
const MAX_TICK_BYTES = 16 * 1024 * 1024
/** Codex rollouts get a bigger tick: nearly every byte is skipped by the
 *  byte-level pre-filter without being decoded, so a tick is I/O, not CPU.
 *  16 MB on a 2.5 GB rollout meant ~160 sweeps to finish one file; 64 MB is
 *  ~40, and a sweep over an 80 GB tree stays under a minute. */
const CODEX_TICK_BYTES = 64 * 1024 * 1024
const YIELD_EVERY = 16 // files between event-loop yields during a sweep
/** #302: the longest between two full walks of the transcript folders; the
 *  watcher's reports are read every 5 s in between. */
export const TK_FULL_SWEEP_MS = 5 * 60_000
/** #302: how many Claude transcripts the 5 s timer asks the size of at most:
 *  the ones modified last, of those a sweep looked at. */
export const TK_ACTIVE_MAX = 200
/** How many of a file's first bytes, and how many of the bytes before the
 *  offset, its cursor keeps a mark of. */
const MARK_BYTES = 256
/** The longest run of bytes a cursor's mark is trusted to name. */
const MARK_BYTES_MAX = 4096

/** What one bounded pass over a file's byte range saw. */
export interface StreamResult {
  /** Byte position reached (== `to`, or less on a short read). */
  pos: number
  /** Bytes of a trailing line that never got its newline in this range. */
  pendingLen: number
  /** That trailing run is already too long to be a line anyone wants, so its
   *  bytes were counted but never retained — the caller can safely skip it
   *  rather than re-reading it on every future sweep. */
  pendingDropped: boolean
}

/**
 * Read `[from, to)` from an open fd and hand back COMPLETE lines, each with the
 * exact number of bytes it consumed (its own length plus its newline) so the
 * caller's cursor stays byte-exact.
 *
 * Why this exists rather than the obvious `Buffer.concat([carry, chunk])` per
 * read: that rebuilds the entire accumulated run on EVERY 256 KB read, which is
 * quadratic in the length of a single line. Real Codex rollouts hold tool-output
 * lines of 34 MB, and at a 64 MB tick that measured 5.5 s of pure memcpy per
 * line — freezing this worker's event loop, and in aggregate accounting for
 * essentially all of a sweep's wall clock. Here every byte is scanned once and
 * copied at most once, and only for lines short enough to want.
 *
 * A run longer than `maxLineBytes` cannot be wanted by any caller, so its bytes
 * are counted but never retained. Peak memory is therefore about
 * READ_BUF + maxLineBytes however long the file's longest line is.
 *
 * NOTE: the Buffer handed to `onLine` may be a view into a reused read buffer.
 * Decode or test it inside the callback; do not retain it.
 */
export function streamLines(
  fsx: typeof nodeFs,
  fd: number,
  from: number,
  to: number,
  maxLineBytes: number,
  onLine: (line: Buffer | null, byteLen: number) => void,
): StreamResult {
  const buf = Buffer.alloc(READ_BUF)
  let pos = from
  let parts: Buffer[] = []  // pieces of the line currently being assembled
  let runLen = 0            // its length so far, INCLUDING any dropped pieces
  let dropped = false       // run passed maxLineBytes -> stop retaining it
  while (pos < to) {
    const n = fsx.readSync(fd, buf, 0, Math.min(READ_BUF, to - pos), pos)
    if (n <= 0) break
    pos += n
    let ls = 0
    for (;;) {
      const nl = buf.indexOf(0x0a, ls)
      if (nl === -1 || nl >= n) break
      const seg = buf.subarray(ls, nl)
      const byteLen = runLen + seg.length + 1
      if (dropped) onLine(null, byteLen)
      else if (parts.length === 0) onLine(seg, byteLen)
      else { parts.push(Buffer.from(seg)); onLine(Buffer.concat(parts), byteLen) }
      parts = []; runLen = 0; dropped = false
      ls = nl + 1
    }
    const tail = n - ls
    if (tail > 0) {
      runLen += tail
      if (dropped) { /* already counting only */ }
      else if (runLen > maxLineBytes) { parts = []; dropped = true }
      else parts.push(Buffer.from(buf.subarray(ls, n)))
    }
  }
  return { pos, pendingLen: runLen, pendingDropped: dropped }
}

/**
 * A mark of an open file as it was read up to `at`: a hash of its first bytes
 * and of the bytes that end at `at`, with where and how many, as
 * `<at>:<first>:<last>:<hash>`. '' when nothing was read (`at` is 0) or the
 * file ends before `at`.
 *
 * A file's cursor keeps the mark of where reading stopped, and the next read
 * checks it before it reads on from there. The offset alone cannot tell a
 * file from another made at its path: only one shorter than the offset was
 * read again from its first byte, so a file deleted and made again LONGER was
 * read on from the old offset, its first lines skipped or the first of them
 * read from its middle, and their usage never counted.
 *
 * Both runs are needed. The first bytes say whose file it is (a transcript's
 * first line, a rollout's header: each carries its own ids), and the bytes
 * before the offset are the end of the last line read, so they say that
 * reading can go on from exactly there. A writer that appends rewrites
 * neither. A file put back with the same bytes (a copy, a sync) is the same
 * file here, and is read on.
 *
 * It is the file's own bytes and nothing the file system says of it, so it
 * tells the same on every platform. Measured on Windows 11 (NTFS, Node 24):
 * a file deleted and made again at once at the same path has the creation
 * time of the one deleted, and only its file id differs. Not measured
 * elsewhere: a file id may be given again to the next file made, and Node
 * documents that the creation time may hold the change time where the file
 * system keeps none, which moves with every write.
 *
 * The hash is kept, not the bytes: they are part of a conversation, and the
 * index holds none of it.
 */
function readMarkAt(fsx: typeof nodeFs, fd: number, at: number, first: number = Math.min(MARK_BYTES, at), last: number = Math.min(MARK_BYTES, at)): string {
  if (!(at > 0)) return ''
  const hash = createHash('sha256')
  for (const [from, bytes] of [[0, first], [at - last, last]]) {
    const buf = Buffer.alloc(bytes)
    let got = 0
    while (got < bytes) {
      const n = fsx.readSync(fd, buf, got, bytes - got, from + got)
      if (n <= 0) return '' // the file ends before `at`
      got += n
    }
    hash.update(buf)
  }
  return `${at}:${first}:${last}:${hash.digest('hex').slice(0, 32)}`
}

/**
 * Whether an open file is no longer the one its cursor was written for: the
 * bytes the cursor's mark names are not there now.
 *
 * The mark says where its bytes end, so it is checked there and not at the
 * cursor's offset. After a downgrade an older build reads on, moves the
 * offset and leaves the mark alone: the mark is then of an earlier offset in
 * the same file, and still tells it from another. A file that ends before the
 * mark is another file too (that build read one made again shorter).
 *
 * False for a cursor with no mark, or one that is not a mark this build
 * writes: a database from before the mark was kept, or nothing read yet. Such
 * a file is read on from its offset, as it always was, and marked then.
 */
function replacedSince(fsx: typeof nodeFs, fd: number, cursor: TkFileCursor): boolean {
  const m = /^(\d{1,15}):(\d{1,4}):(\d{1,4}):[0-9a-f]{32}$/.exec(cursor.readMark ?? '')
  if (!m) return false
  const [at, first, last] = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (const bytes of [first, last]) if (bytes < 1 || bytes > MARK_BYTES_MAX || bytes > at) return false
  return readMarkAt(fsx, fd, at, first, last) !== cursor.readMark
}

/**
 * Nothing new to look at: the file has not changed since the last tick, and we
 * already scanned to its end.
 *
 * Asking this of `lastOffset` instead of `scannedTo` is wrong for any file
 * whose final line has no newline — the cursor legitimately parks in front of
 * that partial line, so `lastOffset < size` forever, and the file is re-read in
 * full on every five-second sweep for the life of the process.
 */
function unchangedAndFullyScanned(cursor: TkFileCursor | null, st: nodeFs.Stats, offset: number): boolean {
  if (!cursor) return false
  if (st.size !== cursor.size || st.mtimeMs !== cursor.mtime) return false
  if (offset !== cursor.lastOffset) return false // we reset the offset (truncation) -> re-read
  return (cursor.scannedTo ?? cursor.lastOffset) >= st.size
}

export function createTokenomicsWorker(host: TkWorkerHostTransport, deps: TkWorkerDeps = {}): TokenomicsWorker {
  const fs = deps.fs ?? nodeFs
  const maxTickBytes = deps.maxTickBytes ?? MAX_TICK_BYTES
  const watchDebounceMs = deps.watchDebounceMs ?? 750
  let db: TkDb | undefined
  let pricing: Record<string, TkPricing> = {}
  let priceKeys: string[] = []
  let configs: TkConfigDim[] = deps.configs ?? []
  let claudeDir = ''
  /** The user's own Codex home's sessions folder, then (WP2, plan A13) those
   *  of the app's Codex accounts: every realm a Codex session can write to.
   *  Each with whose sessions it holds (usage track MP9): the user's own is
   *  `codex:external`, an account's is its key. */
  let codexDirs: TkSessionsRoot[] = []
  /** MP9 round 1 (Q-4): whether the app has named its Codex account folders
   *  yet. Until it has, the one-off attribution is not settled: a folder
   *  named after the first drained sweep would otherwise be re-read after
   *  the re-read was declared done, and the rollups rebuilt twice. */
  let realmDirsKnown = false
  /** How often the app has named its account folders (VM final pass, defect
   *  4): a sweep that listed its files before the latest naming read with an
   *  older list, so it neither settles the re-read nor counts as drained. */
  let realmDirsSeq = 0
  /** The folders were named during a sweep: another follows it. */
  let sweepAfter = false
  let sweeping = false
  /** MP9: the one-off account attribution, while it runs (index status). */
  let rereadProgress: TkAccountReread | null = null
  let rebuildProgress: TkAccountReread | null = null
  // Stage 1 not counted yet says so (counting), so the page can say it.
  const accountReread = (): TkAccountReread | null => rebuildProgress ?? (db?.accountRereadPending() ? (rereadProgress ?? { stage: 'reread', done: 0, total: 0, counting: true }) : null)
  /**
   * Did anything in THIS sweep leave work behind — a file not read to its end,
   * or one that could not be read at all?
   *
   * Deliberately in memory and per-sweep, rather than a query over the cursor
   * table. `tk_files` accumulated rows for files that no longer exist (it is
   * pruned now, after a complete walk, but a row can wait for the next one) —
   * 92% of the rows in a real 221 MB database, nine of them
   * parked mid-file. Asking the TABLE "is anything unscanned" lets a rollout
   * deleted years ago veto completion forever, which is the same "Indexing
   * usage data" wedge this code exists to remove, only now persisted. Asking
   * the SWEEP counts only files that still exist and were actually visited.
   */
  let sweepPending = false
  /**
   * Files that could not be opened or read at all when last tried.
   *
   * Counted SEPARATELY from `sweepPending`, and deliberately not allowed to
   * block completion. Those are two different states: "there are more bytes to
   * read, come back" is temporary and will resolve on its own, while "this file
   * cannot be read" may never resolve — and blocking on it meant a single
   * unreadable transcript left a first index unfinished for the life of the
   * install, showing a spinner with no error and no way out. Reading everything
   * that CAN be read is the honest definition of done; what could not be read
   * is reported alongside it rather than hidden behind a spinner.
   *
   * Kept by path (#302): a changed-files sweep takes a file out when it tries
   * it again and leaves the rest as the last full walk found them. A plain
   * count, reset by every sweep, read none after any reported change, and the
   * page's note about files that could not be read came and went.
   */
  const sweepFailed = new Set<string>()
  /**
   * A file this sweep left with bytes to read did not move its cursor: the
   * read came back short (the file shrank while it was read). A pass repeated
   * at once would read the same nothing, so it waits for the 5 s timer.
   */
  let sweepStalled = false
  /** Note how far a file was read, so the sweep knows whether work remains;
   *  `moved` is whether the file's cursor went forward in this read. */
  const noteScanned = (scannedTo: number, size: number, moved: boolean): void => {
    if (scannedTo >= size) return
    sweepPending = true
    if (!moved) sweepStalled = true
  }
  let firstSweepDone = false
  /**
   * aicc_planning#302: Claude transcripts the watcher reported as written
   * since the last sweep. Every change event and a 5 s timer used to re-walk
   * all of ~/.claude/projects (thousands of files) and re-check each one;
   * with many working sessions that kept a core busy. An incremental sweep
   * now reads just these, and a full walk runs when it is due: at start, on
   * an explicit re-index, on an event only a walk can answer (no file name, a
   * name that is gone, a folder made or moved, any event in a Codex folder),
   * when a file still has bytes to read, and every TK_FULL_SWEEP_MS as the
   * safety net for anything the watcher missed.
   */
  const dirtyClaude = new Set<string>()
  /**
   * #302: the Claude transcripts the 5 s timer asks the size of, each with
   * the time it was last modified as the sweep that looked at it last found
   * it. The watcher does not report every write: on Windows one made through
   * a handle that stays open raises no event for the file until the handle
   * closes (measured: five writes 500 ms apart reported nothing, then one
   * 'change' at the close). The 5 s walk used to find those. The 5 s timer
   * now asks the size of just these and reads the ones that moved, as if the
   * watcher had reported them: one size check each and no folder listed.
   *
   * Every transcript a sweep looks at is noted: one it read, and one it
   * found as the index has it (review round 3). A worker that starts, in an
   * app started again or started again by the supervisor, finds most
   * transcripts like that; as first written only a transcript that was read
   * was noted, so a session that then wrote through the handle it kept was
   * found only by the next timed walk.
   *
   * At most TK_ACTIVE_MAX are kept: the ones modified last, so a walk over
   * thousands of old transcripts leaves the timer that many to ask about,
   * not thousands, and the ones being written are among them wherever the
   * walk finds them. As first written the ones found last were kept, and a
   * walk finds them in the order the folders list them. A write through a
   * handle that stays open moves the time as it is asked from outside
   * (measured on Windows 11, NTFS, Node 24: each write, at once).
   *
   * None is dropped for how long ago it was modified. A session that pauses
   * and then writes again through the handle it kept has no other report
   * (the folder reported as changed, at most, which names no file), so one
   * dropped after ten minutes, as first written, was then found only by the
   * next timed walk.
   */
  const activeClaude = new Map<string, number>()
  const noteActive = (file: string, modifiedAt: number): void => {
    activeClaude.delete(file) // back in at the end: of two modified at the same time, the one noted longer ago goes first
    activeClaude.set(file, modifiedAt)
    if (activeClaude.size <= TK_ACTIVE_MAX) return
    let drop = file
    let oldest = Infinity
    for (const [f, at] of activeClaude) if (at < oldest) { oldest = at; drop = f }
    activeClaude.delete(drop)
  }
  /** The mark of where reading stopped, for the file's cursor. None when it
   *  cannot be read: the next read then has nothing to check, as with a
   *  cursor from before the mark was kept. */
  const markOf = (fd: number, at: number): string => {
    try { return readMarkAt(fs, fd, at) } catch { return '' }
  }
  let fullSweepDue = true
  let lastFullSweepAt = 0
  /** 2.1.3-beta.4: what the two walks of the full pass under way have
   *  touched, and how many files the pass opened to read. A finished pass's
   *  figures go to the app with its `index-complete`, where the Services
   *  panel can show them. Each walk starts at a folder the app named and
   *  lists nothing outside it; a test holds the walks to that, and fails
   *  when one lists a folder outside the transcript roots or touches more
   *  than the tree under them. */
  const noWalk = (): TkWalkCount => ({ dirs: 0, entries: 0, files: 0 })
  let walkCounts = { transcripts: noWalk(), rollouts: noWalk() }
  let passFilesRead = 0
  /** How often the page asked for a Rescan: a pass that began before the
   *  latest one read some files with the progress since reset, so it is not
   *  drained and another follows. */
  let rescanSeq = 0
  /** A Rescan was asked for and no pass since has read every file to its
   *  end and settled the accounts. Asking again meanwhile changes nothing,
   *  so one re-read is never started over by a second ask. */
  let rescanPending = false
  let lastProgress = { filesDone: 0, filesTotal: 0, eventsIngested: 0 }
  /** The folder watchers, by folder: the Claude projects folder, this
   *  computer's own Codex sessions folder and the Codex accounts' (that set
   *  changes). A named folder with no watcher is tried again by the 5 s
   *  timer (#302). */
  const watchers = new Map<string, { close(): void }>()
  /** Folders whose watcher failed and the log said so: once, not at every try. */
  const watchWarned = new Set<string>()
  let watchTimer: ReturnType<typeof setTimeout> | null = null
  let tailTimer: ReturnType<typeof setInterval> | null = null

  const post = (m: FromTkWorker): void => host.post(m)
  const logw = (level: 'info' | 'warn' | 'error', message: string): void => post({ type: 'log', entry: { level, message } })
  const setPricing = (p: Record<string, TkPricing>): void => { pricing = p; priceKeys = Object.keys(p) }

  /** What a walk of the Claude projects folder found (2.1.3-beta.5): the
   *  transcripts to read, every transcript known to be there (those plus the
   *  ones in a subagent folder that was not listed because it had not changed),
   *  and whether the walk listed the whole tree. */
  interface ClaudeWalk { files: string[]; present: Set<string>; complete: boolean }
  /** 2.1.3-beta.5: a subagent folder as the last walk read it: its state then,
   *  and what it held. */
  interface SubagentFolder { key: string; files: string[]; dirs: string[] }
  /** The subagent folders the last walk read, by path. In memory only: the
   *  first walk after the worker starts, and the first after a Rescan or a
   *  re-index, reads every folder. */
  let subagentFolders = new Map<string, SubagentFolder>()
  /** A folder written to less than this long ago is not remembered: a file
   *  made a moment after it was listed could leave the same time on it. */
  const SUBAGENT_SETTLE_MS = 2000
  /** A folder's state for the memo above: its modified time, its id and its
   *  size, and whether it has been left alone long enough to trust. None
   *  when it cannot be read. */
  const folderState = (dir: string): { key: string; settled: boolean } | null => {
    try {
      const st = fs.statSync(dir)
      return { key: `${st.mtimeMs}:${st.ino}:${st.size}`, settled: Date.now() - st.mtimeMs >= SUBAGENT_SETTLE_MS }
    } catch { return null }
  }

  function enumerateClaude(): ClaudeWalk {
    // Recurse the whole tree (spec: `~/.claude/projects/**`). Session transcripts
    // live one level deep (`<proj>/<sid>.jsonl`) but subagent/sidechain transcripts
    // are nested (`<proj>/<sid>/subagents/agent-*.jsonl`) and carry real billed
    // usage — a one-level scan silently undercounts cost. Skip symlinks/junctions
    // so account-isolation reparse points can't introduce traversal cycles.
    //
    // 2.1.3-beta.5: a folder named subagents, and the folders below it, that has
    // not changed since the walk that last read it (its modified time, id and
    // size are the same, and it was left alone for a moment before that) is not
    // listed again, and its transcripts are not asked about: the watcher and
    // the sizes the 5 s timer asks of the ones written last cover them. A
    // transcript added to it changes the folder, so it is read. A transcript
    // that only grew in place does not change the folder; the watcher reports
    // it, and a Rescan reads every folder. The folders below it are asked
    // about again each walk, so a change deeper down is found.
    const out: string[] = []
    const present = new Set<string>()
    const next = new Map<string, SubagentFolder>()
    let complete = true
    const walk = (dir: string, depth: number, inSubagents: boolean): void => {
      if (depth > 12) return
      const state = inSubagents ? folderState(dir) : null
      const before = state ? subagentFolders.get(dir) : undefined
      if (state && before && before.key === state.key) {
        next.set(dir, before)
        for (const f of before.files) present.add(f)
        for (const d of before.dirs) walk(d, depth + 1, true)
        return
      }
      let entries: nodeFs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { complete = false; return }
      walkCounts.transcripts.dirs++
      walkCounts.transcripts.entries += entries.length
      const heldFiles: string[] = []
      const heldDirs: string[] = []
      for (const e of entries) {
        if (e.isSymbolicLink()) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { heldDirs.push(full); walk(full, depth + 1, inSubagents || e.name === 'subagents') }
        else if (e.isFile() && e.name.endsWith('.jsonl')) { walkCounts.transcripts.files++; out.push(full); present.add(full); heldFiles.push(full) }
      }
      if (state?.settled) next.set(dir, { key: state.key, files: heldFiles, dirs: heldDirs })
    }
    try {
      if (claudeDir && fs.existsSync(claudeDir)) walk(claudeDir, 0, false)
      else complete = false
    } catch (err) { complete = false; logw('warn', `enumerateClaude failed: ${String(err)}`) }
    subagentFolders = next
    return { files: out, present, complete }
  }

  /** A file or folder's identity: its volume and file id, or its path where
   *  the file system gives no id (MP9 round 1, B-F1). */
  const fileIdOf = (st: { dev: bigint | number; ino: bigint | number }, p: string): string =>
    BigInt(st.ino) !== 0n ? `${st.dev}:${st.ino}` : `path:${p}`
  /** A folder's real path (its own when it cannot be resolved). */
  const realOf = (dir: string): string => {
    try { return fs.realpathSync.native(dir) } catch { return path.resolve(dir) }
  }
  /** How deep the deepest link (a symlink or junction) on a folder's path
   *  leads: the segments of the real path it resolves to, 0 with no link on
   *  the path. An alias that is not a link, a Windows 8.3 short name, is no
   *  link. */
  const linkDepth = (dir: string): number => {
    for (let p = path.resolve(dir); ; ) {
      let isLink = false
      try { isLink = fs.lstatSync(p).isSymbolicLink() } catch { isLink = false }
      if (isLink) return realOf(p).split(/[\\/]+/).filter(Boolean).length
      const up = path.dirname(p)
      if (up === p) return 0
      p = up
    }
  }
  /** One real path at or below another. */
  const atOrBelow = (child: string, parent: string): boolean => {
    const rel = path.relative(parent, child)
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
  }

  /** Every rollout with whose sessions it holds. One folder is walked once,
   *  and one file listed once, however many paths reach it (MP9 round 1,
   *  B-F1): a folder reached by its own path is walked before one reached
   *  through a link (a junction from one account's folder, or the user's own,
   *  into another's never takes that account's files), then in order (the
   *  user's own home first).
   *
   *  "Through a link" is decided between the folders that overlap (one's
   *  real path at or below the other's): the one whose deepest link leads
   *  deeper is the linked one, and with no difference the order decides.
   *  Comparing a folder's real path with the path it was given read every
   *  folder as linked wherever an alias sits above them all (a Windows 8.3
   *  short name, as on the CI runners, or macOS's /var link), and the order
   *  then let a linked folder take another account's sessions. */
  function enumerateCodex(): Array<{ file: string; accountKey: string }> {
    const out: Array<{ file: string; accountKey: string }> = []
    const seen = new Set<string>()
    let accountKey = ''
    // Same guards as enumerateClaude, which this had been missing: `statSync`
    // follows links, so a reparse point or symlink inside the tree could yield
    // the SAME rollout under two paths. Two paths to one rollout means two
    // independent cursors over one session's ordinals, and that double-counts
    // the user's spend.
    const walk = (dir: string, depth: number): void => {
      if (depth > 12) return
      let entries: nodeFs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      walkCounts.rollouts.dirs++
      walkCounts.rollouts.entries += entries.length
      for (const e of entries) {
        if (e.isSymbolicLink()) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { walk(full, depth + 1); continue }
        if (!e.isFile() || !e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue
        let st: nodeFs.BigIntStats
        try { st = fs.statSync(full, { bigint: true }) } catch { continue }
        // One rollout, one cursor: never the same file twice, by any path.
        const id = fileIdOf(st, full)
        if (BigInt(st.size) > 0n && !seen.has(id)) { seen.add(id); walkCounts.rollouts.files++; out.push({ file: full, accountKey }) }
      }
    }
    const roots: Array<{ root: TkSessionsRoot; order: number; id: string; real: string; link: number; direct: boolean }> = []
    codexDirs.forEach((root, order) => {
      try {
        if (!fs.existsSync(root.dir)) return
        roots.push({
          root, order, id: fileIdOf(fs.statSync(root.dir, { bigint: true }), root.dir),
          real: realOf(root.dir), link: linkDepth(root.dir), direct: true,
        })
      } catch (err) { logw('warn', `enumerateCodex failed: ${String(err)}`) }
    })
    for (const r of roots) {
      r.direct = !roots.some((s) => s !== r && s.link < r.link && (atOrBelow(r.real, s.real) || atOrBelow(s.real, r.real)))
    }
    roots.sort((a, b) => Number(b.direct) - Number(a.direct) || a.order - b.order)
    const walked = new Set<string>()
    for (const r of roots) {
      if (walked.has(r.id)) continue
      walked.add(r.id)
      accountKey = r.root.accountKey
      try { walk(r.root.dir, 0) } catch (err) { logw('warn', `enumerateCodex failed: ${String(err)}`) }
    }
    return out
  }

  function resolveConfigId(cwd: string): string | null {
    if (!cwd || isJunkCwd(cwd)) return null
    const c = findConfigForCwd(cwd, configs)
    return c ? c.configId : null
  }

  function ingestClaudeFile(file: string): number {
    let st: nodeFs.Stats
    try { st = fs.statSync(file) } catch { return 0 }
    const cursor = db!.getFileCursor(file)
    let offset = cursor ? cursor.lastOffset : 0
    if (cursor && st.size < cursor.lastOffset) offset = 0 // truncated/rotated -> re-read
    // #302 (review round 3): as the index has it, so not read, and asked
    // about all the same: it may be written next with no report.
    if (unchangedAndFullyScanned(cursor, st, offset)) { noteActive(file, st.mtimeMs); return 0 }
    // What was read can be checked: something was, and its cursor has a
    // mark (one from before the mark was kept has none).
    const marked = offset > 0 && !!cursor?.readMark
    // #302: changed with nothing to read yet (a transcript just made is
    // empty) is written lately too: its first lines may come with no report.
    const nothingToRead = (): number => {
      db!.setFileCursor({ path: file, size: st.size, mtime: st.mtimeMs, lastOffset: offset, lastIngestedAt: Date.now(), scannedTo: st.size, readMark: offset > 0 ? cursor?.readMark : '' })
      noteActive(file, st.mtimeMs)
      return 0
    }
    if (st.size <= offset && !marked) return nothingToRead()

    let fd: number
    // A file we could not read is work still outstanding, not work done. It
    // writes no cursor row, so nothing else can notice it — and an index that
    // declares itself complete while a file's spend is missing is worse than
    // one that admits it is still going.
    try { fd = fs.openSync(file, 'r') } catch (err) { sweepFailed.add(file); logw('warn', `open failed for ${file}: ${String(err)}`); return 0 }
    passFilesRead++
    let inserted = 0
    let fileCwd = ''
    try {
      // Another file than the one read, made at its path: read from its
      // first byte, whatever its size (see readMarkAt). Its lines are new
      // rows; any it shares with the file that was read are stored already
      // and are not stored twice.
      if (marked) {
        try { if (replacedSince(fs, fd, cursor!)) offset = 0 } catch (err) {
          sweepFailed.add(file)
          logw('warn', `read failed for ${file}: ${String(err)}`)
          return 0
        }
      }
      if (st.size <= offset) return nothingToRead()
      const end = Math.min(st.size, offset + maxTickBytes)
      let batch: Array<TkEvent & { configId?: string | null }> = []
      let consumed = offset
      const flush = (): void => { if (batch.length) { inserted += db!.insertEvents(batch); batch = [] } }
      let res: StreamResult
      try {
        // A line that cannot fit in one tick can never be assembled, so it is
        // capped rather than carried: without that the cursor parks in front of
        // it and the same bytes are re-read on every sweep, forever.
        res = streamLines(fs, fd, offset, end, maxTickBytes, (lb, byteLen) => {
          consumed += byteLen
          if (!lb || !lb.length) return
          const trimmed = lb[lb.length - 1] === 0x0d ? lb.subarray(0, lb.length - 1) : lb
          const line = trimmed.toString('utf8')
          if (!line) return
          const lineCwd = extractCwdFromLine(line)
          if (lineCwd) fileCwd = lineCwd
          const ev = parseClaudeUsageLine(line, priceKeys)
          if (!ev) return
          const cwd = ev.cwd || fileCwd || db!.getSessionCwd(ev.sessionId) || ''
          batch.push({ ...ev, cwd, configId: resolveConfigId(cwd) })
          if (batch.length >= 500) flush()
        })
      } catch (err) {
        // Per-FILE containment. Letting this escape aborts the whole sweep, so
        // one locked or flaky transcript stops every later file from being read
        // and leaves the index reporting itself incomplete forever.
        sweepFailed.add(file)
        logw('warn', `read failed for ${file}: ${String(err)}`)
        flush()
        return inserted
      }
      // As on the Codex path: a run at least a whole tick long can never be
      // assembled, so skip it. Merely reaching the end of the file does not
      // qualify — that is a file being appended to, and its partial last line
      // must survive until the writer finishes it.
      if (res.pendingDropped) consumed += res.pendingLen
      else if (res.pendingLen > 0 && consumed === offset && res.pos - offset >= maxTickBytes) consumed = res.pos
      flush()
      noteScanned(res.pos, st.size, consumed > offset)
      db!.setFileCursor({ path: file, size: st.size, mtime: st.mtimeMs, lastOffset: consumed, lastIngestedAt: Date.now(), scannedTo: res.pos, readMark: markOf(fd, consumed) })
      // #302: read, so asked about from now on. One that could not be read
      // is not noted: it waits for its next report or the next walk.
      noteActive(file, st.mtimeMs)
    } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
    return inserted
  }

  /**
   * Codex rollouts are STREAMED, exactly like Claude transcripts, and for the
   * same reason the Claude path never read a whole file: they can be enormous.
   * A real ~/.codex/sessions held 80 GB across 320 files, several of them
   * 1.8-2.5 GB each. The old `readFileSync(file, 'utf8')` on those either took
   * tens of seconds and hundreds of MB per file, or threw Node's hard string
   * ceiling ("Cannot create a string longer than 0x1fffffe8 characters") -
   * which the catch swallowed WITHOUT writing a cursor, so every sweep re-read
   * the same unreadable file and never got past the Codex tail. On the user's
   * machine that showed as Tokenomics stuck at "Indexing 1700/1997" for hours,
   * with a database that had in fact been complete since July.
   *
   * The parser only wants three event types (session_meta, turn_context,
   * token_count) - a tiny slice of a rollout's bytes - and it is line-oriented,
   * so it can be fed a chunk at a time. Each tick reads at most one tick budget;
   * the cursor advances to the last complete line consumed and the next sweep
   * carries on.
   *
   * The ordinal behind the dedup key (`x:<session>:<n>`) is the position of a
   * token_count line within THIS FILE, and its base is stored on the file's own
   * cursor, in the SAME transaction as the rows. It was previously derived from
   * a live count of the session's stored rows, which is not the same number:
   * replay a byte range (the worker is hard-killed on app quit, mid-sweep) and
   * that count has moved, so the same turns are re-inserted under fresh keys and
   * the user's spend inflates permanently.
   *
   * The rollout's identity (session id, cwd, model) is likewise carried on the
   * cursor rather than re-derived from a bounded read of the file's head. The
   * head read stays as the way to LEARN it, but a tick that cannot find it there
   * used to produce zero events while still advancing the cursor - silently
   * losing every turn in that range - and to price whatever it did produce as
   * 'unknown', which matches no pricing row and therefore costs nothing.
   */
  function ingestCodexFile(file: string, accountKey: string): number {
    let st: nodeFs.Stats
    try { st = fs.statSync(file) } catch { return 0 }
    const cursor = db!.getFileCursor(file)
    let offset = cursor ? cursor.lastOffset : 0
    let turnBase = cursor?.codexTurns ?? 0
    let seed: CodexRolloutSeed = { sessionId: cursor?.codexSessionId || undefined, cwd: cursor?.codexCwd || undefined, model: cursor?.codexModel || undefined }
    // The file we counted is not this one. Re-read from the top with the
    // ordinal base back at zero, so the stored rows dedup against their own
    // keys instead of being re-inserted beside them.
    const fromTheTop = (): void => {
      offset = 0
      turnBase = 0
      seed = { sessionId: undefined, cwd: undefined, model: undefined }
    }
    // Truncated or rotated: shorter than what was read of it.
    if (cursor && st.size < cursor.lastOffset) fromTheTop()
    if (unchangedAndFullyScanned(cursor, st, offset)) return 0
    // As for a Claude transcript: what was read can be checked.
    const marked = offset > 0 && !!cursor?.readMark
    const nothingToRead = (): number => {
      db!.setFileCursor({ path: file, size: st.size, mtime: st.mtimeMs, lastOffset: offset, lastIngestedAt: Date.now(), scannedTo: st.size, codexSessionId: seed.sessionId ?? '', codexModel: seed.model ?? '', codexCwd: seed.cwd ?? '', codexTurns: turnBase, accountKey, readMark: offset > 0 ? cursor?.readMark : '' })
      return 0
    }
    if (st.size <= offset && !marked) return nothingToRead()

    // `!== undefined`, not truthiness: a caller asking for a 0-byte tick meant
    // it, and silently handing back 64 MB instead is not a kindness.
    const tickBytes = deps.maxTickBytes !== undefined ? maxTickBytes : CODEX_TICK_BYTES
    let fd: number
    try { fd = fs.openSync(file, 'r') } catch (err) { sweepFailed.add(file); logw('warn', `open failed for ${file}: ${String(err)}`); return 0 }
    passFilesRead++
    let inserted = 0
    try {
      // Deleted and made again at this path, as long as what was read of the
      // old one or longer (see readMarkAt): from the top, as one that is
      // shorter. Read on from the old offset, its first turns were never
      // counted and the rest were stored as the old session's.
      if (marked) {
        try { if (replacedSince(fs, fd, cursor!)) fromTheTop() } catch (err) {
          sweepFailed.add(file)
          logw('warn', `read failed for ${file}: ${String(err)}`)
          return 0
        }
      }
      if (st.size <= offset) return nothingToRead()
      const end = Math.min(st.size, offset + tickBytes)
      let consumed = offset
      // The rollout header sits at the top of the file. On a resumed read we
      // start past it, so re-read the head for those lines - bounded and cheap.
      // Unlike before, this is a fallback rather than the only source: what it
      // finds is persisted on the cursor, so a head that does not hold the
      // identity is no longer silently fatal to the whole tick.
      const head = offset > 0 && !seed.sessionId ? codexHeadLines(fd) : null
      const kept: string[] = []
      let res: StreamResult
      try {
        res = streamLines(fs, fd, offset, end, CODEX_MAX_LINE, (lb, byteLen) => {
          consumed += byteLen
          // Cheap pre-filter: only lines that can carry what the parser wants
          // are decoded at all. A tool-output line of a few MB is skipped by a
          // byte scan instead of a UTF-8 decode plus JSON.parse. `null` is a
          // line already rejected for length by the reader.
          if (!lb || !lb.length || !codexLineOfInterest(lb)) return
          kept.push(lb.toString('utf8'))
        })
      } catch (err) {
        // Per-FILE containment, as the pre-streaming code had. Letting this
        // escape aborts the entire sweep: every later rollout goes unread, the
        // first index never reports complete, and the five-second retry hits the
        // same file forever - the exact "Indexing 1700/1997" wedge this ingester
        // was written to remove, reached through a different door.
        sweepFailed.add(file)
        logw('warn', `read failed for ${file}: ${String(err)}`)
        return 0
      }
      // Skip past a run that can never become a line we want, rather than
      // re-reading it forever. Two ways to know that: it passed the largest line
      // any caller wants, or a WHOLE tick's worth of bytes went by without one
      // complete line, so the run is at least a tick long.
      //
      // The second test is on bytes actually read, NOT on reaching the end of
      // the file. A file that simply ends mid-line is the normal shape of one
      // being appended to right now, and its partial last line has to be left
      // alone until the writer finishes it. What stops THAT from being re-read
      // on every sweep is `scannedTo`, not skipping it.
      if (res.pendingDropped) consumed += res.pendingLen
      else if (res.pendingLen > 0 && consumed === offset && res.pos - offset >= tickBytes) consumed = res.pos
      noteScanned(res.pos, st.size, consumed > offset)

      let nextSeed = seed
      if (kept.length) {
        const headLines = head ? head.split('\n') : []
        const text = (head ? head + '\n' : '') + kept.join('\n')
        // Learn the identity from ANY line that carries it, and carry it forward
        // whether or not this tick also found turns. A tick holding only the
        // header used to teach the next tick nothing, so the identity had to be
        // rediscovered from the file's head every time — the thing that silently
        // produced no events when the head did not hold it.
        nextSeed = codexIdentityFrom([...headLines, ...kept], seed)
        // Parse with the identity carried IN, not the one just derived. What
        // `codexIdentityFrom` returns is the LAST model named anywhere in this
        // slice; seeding the parse with it stamps that model onto every turn
        // before the slice's first `turn_context` — which on a resumed tick is
        // the leading turns, and silently reprices them. The cursor's own seed
        // is the model actually in effect where this slice begins.
        const probe = codexEventsFromRollout(text, priceKeys, 0, seed)
        if (probe.length) {
          const sessionId = probe[0].sessionId
          const last = probe[probe.length - 1]
          // Persist what the identity scan found — it also sees a trailing
          // `turn_context` that no turn in this slice followed.
          nextSeed = {
            sessionId: nextSeed.sessionId || sessionId,
            cwd: nextSeed.cwd || last.cwd,
            model: nextSeed.model || (last.model && last.model !== 'unknown' ? last.model : undefined),
          }
          // A fresh read from the top re-derives ordinals the stored rows
          // already own, so their own keys dedup them; a resumed read holds only
          // turns after the cursor, so they continue from the file's base.
          const keyed = (offset === 0
            ? probe.map((ev, i) => ({ ...ev, dedupKey: `x:${sessionId}:${i}` }))
            : probe.map((ev, i) => ({ ...ev, dedupKey: `x:${sessionId}:${turnBase + i}` })))
            // MP9: whose turns: the account of the folder the rollout is in.
            .map((ev) => ({ ...ev, configId: resolveConfigId(ev.cwd), accountKey }))
          // A turn with no usable timestamp cannot be stored: the column is NOT
          // NULL, and `INSERT OR IGNORE` reports the rejection as changes === 0
          // — identical to a dedup hit. That is the mechanism that makes a LOST
          // turn look exactly like an already-counted one, so drop it here and
          // say so. Keys are already assigned, so the survivors keep theirs.
          const fresh = keyed.filter((ev) => Number.isFinite(ev.ts))
          if (fresh.length !== keyed.length) {
            logw('warn', `codex rollout ${file}: dropped ${keyed.length - fresh.length} turn(s) with an unusable timestamp`)
          }
          turnBase = offset === 0 ? Math.max(turnBase, probe.length) : turnBase + probe.length
          inserted = db!.insertEventsWithCursor(fresh, { path: file, size: st.size, mtime: st.mtimeMs, lastOffset: consumed, lastIngestedAt: Date.now(), scannedTo: res.pos, codexSessionId: nextSeed.sessionId ?? '', codexModel: nextSeed.model ?? '', codexCwd: nextSeed.cwd ?? '', codexTurns: turnBase, accountKey, readMark: markOf(fd, consumed) })
          return inserted
        }
        if (offset > 0 && !nextSeed.sessionId) {
          // Lines we wanted, but nothing to attribute them to. Advancing the
          // cursor here is how a rollout's whole spend used to vanish without a
          // trace, so say so.
          logw('warn', `codex rollout ${file}: no session identity for ${kept.length} line(s) at offset ${offset}`)
        }
      }
      db!.setFileCursor({ path: file, size: st.size, mtime: st.mtimeMs, lastOffset: consumed, lastIngestedAt: Date.now(), scannedTo: res.pos, codexSessionId: nextSeed.sessionId ?? '', codexModel: nextSeed.model ?? '', codexCwd: nextSeed.cwd ?? '', codexTurns: turnBase, accountKey, readMark: markOf(fd, consumed) })
    } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
    return inserted
  }

  /**
   * What a rollout's header lines say about it, learned from whatever lines are
   * to hand. Kept separate from event parsing on purpose: a tick can hold the
   * header and no turns at all, and it still has to teach the next tick who
   * this file belongs to and what model it is billing.
   */
  function codexIdentityFrom(lines: string[], seed: CodexRolloutSeed): CodexRolloutSeed {
    let { sessionId, cwd, model } = seed
    // #307: first session_meta is the file's identity; a subagent rollout's
    // SECOND session_meta names its parent and must not steal the id (that
    // collapsed subagent turns onto the parent and dropped ~half of them). The
    // seed IS the header a prior read already learned, so a set seed id locks it.
    // Model still tracks the last one named (turn_context updates continue).
    let idLocked = !!sessionId
    for (const line of lines) {
      if (!line) continue
      let evt: { type?: string; payload?: Record<string, unknown> }
      try { evt = JSON.parse(line) } catch { continue }
      const p = evt?.payload ?? {}
      if (evt?.type === 'session_meta') {
        if (idLocked) continue
        if (p.id) { sessionId = String(p.id); idLocked = true }
        if (p.cwd) cwd = String(p.cwd)
        if (p.model) model = String(p.model)
      } else if (evt?.type === 'turn_context' && p.model) model = String(p.model)
    }
    return { sessionId, cwd, model }
  }

  /** Byte-level "could this line matter" test, run before any decode. */
  function codexLineOfInterest(lb: Buffer): boolean {
    // The giant lines are tool output. The bound has to clear the largest line
    // we actually WANT, which is `session_meta` - it carries the instruction
    // blob and the serialised tool schemas, so it grows with the user's setup.
    if (lb.length > CODEX_MAX_LINE) return false
    return lb.includes(CODEX_MARK_TOKEN) || lb.includes(CODEX_MARK_META) || lb.includes(CODEX_MARK_TURN)
  }

  /**
   * The identity lines of a rollout, read from the top of an open file. Used
   * only to LEARN the identity once; it is then carried on the file's cursor.
   * Returns them joined, or null when the head holds none.
   *
   * The window has to clear a whole `session_meta` line plus the first
   * `turn_context`, and `session_meta` was measured at 47 KB on a real tree and
   * growing - a 64 KB window left no margin, and running out of it produced
   * zero events rather than a degraded result.
   */
  function codexHeadLines(fd: number): string | null {
    const buf = Buffer.alloc(CODEX_HEAD_BYTES)
    let n = 0
    try { n = fs.readSync(fd, buf, 0, CODEX_HEAD_BYTES, 0) } catch { return null }
    if (n <= 0) return null
    // Look for the two DISTINCT things the head can tell us, not simply for the
    // first few matching lines: taking "the first 4 markers" meant a rollout
    // whose turn_context lines precede its session_meta yielded four models and
    // no session id at all - and without a session id the parser returns
    // nothing, so the whole tick was discarded.
    const lines: string[] = []
    let haveMeta = false
    let turns = 0
    let ls = 0
    for (;;) {
      const nl = buf.indexOf(0x0a, ls)
      if (nl === -1 || nl >= n) break
      const lb = buf.subarray(ls, nl)
      ls = nl + 1
      if (!haveMeta && lb.includes(CODEX_MARK_META)) { lines.push(lb.toString('utf8')); haveMeta = true }
      else if (turns < 3 && lb.includes(CODEX_MARK_TURN)) { lines.push(lb.toString('utf8')); turns++ }
      if (haveMeta && turns > 0) break
    }
    return lines.length ? lines.join(String.fromCharCode(10)) : null
  }

  /** How many progress rows are looked at, and dropped, between two yields
   *  to the event loop. */
  const PRUNE_BATCH = 500
  /** Is this path gone for certain (not found, as opposed to not readable)? */
  const isGone = (p: string): boolean => {
    try { fs.lstatSync(p); return false } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      return code === 'ENOENT' || code === 'ENOTDIR'
    }
  }
  /**
   * 2.1.3-beta.5: drop the file-progress rows of transcripts that no longer
   * exist (aicc_planning#306, item 2). The table is otherwise never pruned, so
   * a real history held tens of thousands of rows for deleted files and for
   * the same files under a second path (the profile folder's link), all of
   * which a health figure counted.
   *
   * Only the progress rows go. A stored usage event is never touched, and a
   * file that comes back is read from its first byte, its turns stored once
   * (they are keyed by turn), so the worst a wrong drop costs is a read again,
   * never a total.
   *
   * Only after a walk that listed the whole projects folder: it exists, it
   * was listed, no folder in it failed to list and it held a transcript. A
   * walk that failed or fell short proves nothing is gone, and a folder
   * that lists empty is as likely a drive not mounted as a history deleted.
   * A Claude row goes when its path is not among the transcripts the walk
   * found (the ones it did not list because their folder had not changed
   * count as found). A rollout row goes only when its file is not found at
   * all, as the rollout walk's own lists vary with the account folders named.
   * A Claude row written since the pass began (by the watcher, for a
   * transcript made after the walk listed its folder) is kept.
   * In batches, with the event loop given back between them. The first batch
   * is dropped in the turn that called this (a pass with nothing to drop,
   * the usual one, is over then); the rest is returned to be waited for.
   */
  function pruneGoneFiles(walk: ClaudeWalk, rolloutsFound: ReadonlySet<string>, passStart: number): Promise<void> | undefined {
    if (!db || !walk.complete || walk.present.size === 0) return undefined
    let paths: string[] = []
    let dropped = 0
    const dropBatch = (from: number): void => {
      const gone: string[] = []
      for (const p of paths.slice(from, from + PRUNE_BATCH)) {
        if (path.basename(p).includes('rollout-')) { if (!rolloutsFound.has(p) && isGone(p)) gone.push(p) }
        // A row the watcher wrote while this pass ran is for a transcript
        // made after the walk listed the folders: not gone.
        else if (!walk.present.has(p) && !((db!.getFileCursor(p)?.lastIngestedAt ?? 0) >= passStart)) gone.push(p)
      }
      if (gone.length) dropped += db!.deleteFileRows(gone)
    }
    const done = (): void => { if (dropped > 0) logw('info', `dropped the progress of ${dropped} transcripts that are gone`) }
    const failed = (err: unknown): void => logw('warn', `dropping the progress of gone transcripts failed: ${String(err)}`)
    try {
      paths = db.listFilePaths()
      dropBatch(0)
    } catch (err) { failed(err); return undefined }
    if (paths.length <= PRUNE_BATCH) { done(); return undefined }
    return (async () => {
      try {
        for (let i = PRUNE_BATCH; i < paths.length; i += PRUNE_BATCH) {
          await new Promise<void>((r) => setImmediate(r))
          if (!db) return
          dropBatch(i)
        }
        done()
      } catch (err) { failed(err) }
    })()
  }

  async function ingestAll(phase: 'initial' | 'incremental'): Promise<void> {
    if (!db || sweeping) return
    if (phase === 'incremental' && !fullSweepDue) { await ingestDirty(); return }
    sweeping = true
    sweepPending = false
    sweepStalled = false
    sweepFailed.clear()
    // #302: this walk covers every file, the reported ones included.
    fullSweepDue = false
    lastFullSweepAt = Date.now()
    // 2.1.3-beta.4: this pass's own counts, and the Rescan it began after.
    walkCounts = { transcripts: noWalk(), rollouts: noWalk() }
    passFilesRead = 0
    const passStart = lastFullSweepAt
    const scanSeq = rescanSeq
    dirtyClaude.clear()
    // #302: whether the next full walk follows this one at once.
    let again = false
    try {
      // What this sweep's list was made with (defect 4): the account folders
      // as named when it began, and whether they had been named at all.
      const dirsKnown = realmDirsKnown
      const dirsSeq = realmDirsSeq
      const claudeWalk = enumerateClaude()
      const claude = claudeWalk.files
      const codex = enumerateCodex()
      const total = claude.length + codex.length
      let done = 0
      let events = 0
      // Yield to the worker event loop periodically so pending queries (summary /
      // index-status) are answered DURING a large first index instead of stalling
      // behind a synchronous multi-thousand-file sweep.
      const tick = (): void => {
        if (done % 50 === 0) { lastProgress = { filesDone: done, filesTotal: total, eventsIngested: events }; post({ type: 'index-progress', filesDone: done, filesTotal: total, eventsIngested: events, phase, accountReread: accountReread() }) }
      }
      // MP9: while the Codex history is re-read for its accounts, how many of
      // the rollouts still here have been (their cursors say, 1 then 2). Only
      // counted once the account folders are named, so the count covers every
      // folder the re-read will read (defect 4); until then it has none.
      const rereadFlag = (file: string): number => db!.getFileCursor(file)?.accountReread ?? 0
      const reread = db.accountRereadPending() && dirsKnown ? { done: 0, total: 0 } : null
      if (reread) {
        for (const f of codex) { const flag = rereadFlag(f.file); if (flag >= 1) { reread.total++; if (flag === 2) reread.done++ } }
        rereadProgress = { stage: 'reread', ...reread }
      }
      // After each yield, bail if stop() closed the db while we were suspended
      // (the resumed continuation would otherwise deref a now-undefined db).
      for (const f of claude) { events += ingestClaudeFile(f); done++; tick(); if (done % YIELD_EVERY === 0) { await new Promise<void>((r) => setImmediate(r)); if (!db) return } }
      for (const f of codex) {
        const before = reread ? rereadFlag(f.file) : 0
        events += ingestCodexFile(f.file, f.accountKey)
        if (reread && before === 1 && rereadFlag(f.file) === 2) { reread.done++; rereadProgress = { stage: 'reread', ...reread } }
        done++; tick(); if (done % YIELD_EVERY === 0) { await new Promise<void>((r) => setImmediate(r)); if (!db) return }
      }
      if (!db) return
      lastProgress = { filesDone: done, filesTotal: total, eventsIngested: events }
      post({ type: 'index-progress', filesDone: done, filesTotal: total, eventsIngested: events, phase, accountReread: accountReread() })
      db.setMeta('lastIndexAt', String(Date.now()))
      // "Complete" has to mean every tracked file has been read to its end, not
      // merely that one pass over the file LIST finished. A per-tick byte budget
      // means a multi-GB rollout needs tens of sweeps, and claiming completion
      // after the first one puts a confidently wrong spend figure in front of
      // the user with no indication it is still climbing.
      //
      // It is also no longer tied to the 'initial' phase: that phase runs once
      // per process, so a single failed first sweep left the flag unreachable
      // for the life of the process however many healthy sweeps followed.
      //
      // Files that could not be READ deliberately do not hold this back. A file
      // that is unreadable now may be unreadable forever, and gating on it left
      // a first index permanently unfinished — a spinner, no error, no way out.
      // "Everything we can read has been read" is the honest bar; `filesFailed`
      // rides alongside so the count that is missing can be shown rather than
      // hidden.
      // A sweep whose list predates the latest naming of the account folders
      // has not read them: not drained, and another sweep follows (defect 4).
      // Nor has one that began before the latest Rescan read every file
      // from its start (2.1.3-beta.4).
      const drained = !sweepPending && realmDirsSeq === dirsSeq && rescanSeq === scanSeq
      // #302: a walk that left work behind is still due. A file is read one
      // budget per pass, so a large first index or the Codex account re-read
      // takes many passes, and with the next walk up to TK_FULL_SWEEP_MS away
      // that was one budget every five minutes. The next pass follows at once
      // while every file left with bytes moved its cursor: each pass then
      // reads further, and the passes end when the bytes do. Otherwise the
      // 5 s timer runs it.
      if (!drained) { fullSweepDue = true; again = !sweepStalled }
      // MP9: a drained sweep has re-read every rollout it could reach, so the
      // re-read is done; then the rollups are rebuilt if they need it. Inside
      // the sweep, so nothing is ingested while they are rebuilt; queries are
      // answered between its steps. Only a sweep whose list had the account
      // folders in it: none settles before they are named, and one listed
      // before the latest naming is not drained. One made before they were
      // named marked their rows done unread, and the notice cleared before
      // they were read (defect 4).
      if (drained && realmDirsKnown) await settleAccounts(phase)
      if (!db) return
      // 2.1.3-beta.4: what this pass's two walks touched.
      const now = Date.now()
      const walk: TkWalkStats = { at: now, ms: Math.max(0, now - passStart), transcripts: walkCounts.transcripts, rollouts: walkCounts.rollouts, filesRead: passFilesRead }
      // A Rescan first asked while the accounts were settled (the worker
      // yields there) put every file back to its start after this pass had
      // read them: what it says now is as a pass that began before the Rescan,
      // not drained, and the pass that reads them again follows it (the
      // Rescan made one due).
      const drainedNow = drained && rescanSeq === scanSeq
      // A Rescan is over only here, once the accounts are settled too: one
      // asked again while they were is the same Rescan, still under way,
      // and is not started over (2.1.3-beta.4).
      if (drainedNow) rescanPending = false
      if (drainedNow && !firstSweepDone) {
        firstSweepDone = true
        db.setMeta('firstIndexComplete', '1')
        post({ type: 'index-complete', firstIndex: true, drained: drainedNow, filesFailed: sweepFailed.size, eventsTotal: db.eventCount(), walk })
      } else {
        post({ type: 'index-complete', firstIndex: false, drained: drainedNow, filesFailed: sweepFailed.size, eventsTotal: db.eventCount(), walk })
      }
      // 2.1.3-beta.5: a subagent folder is remembered when it is listed, before
      // its transcripts are read. A pass that left work behind (a transcript
      // longer than one budget, one that could not be opened or read) must not
      // let the next walk skip that folder, or the file would never be read
      // again. So nothing is remembered until a pass has read everything.
      if (!drained || sweepPending || sweepFailed.size > 0) subagentFolders = new Map()
      // 2.1.3-beta.5: after the pass has said it is complete, the progress
      // rows of transcripts that are gone are dropped (only after a walk that
      // listed the whole tree, and never any stored usage).
      const rest = pruneGoneFiles(claudeWalk, new Set(codex.map((c) => c.file)), passStart)
      if (rest) await rest
    } catch (err) {
      // #302: a walk that failed did not reach every file, so it is still
      // due; the 5 s timer retries it, never at once.
      fullSweepDue = true
      again = false
      subagentFolders = new Map() // the files it did not reach are listed again
      logw('error', `ingestAll failed: ${String(err)}`)
    }
    finally {
      sweeping = false
      if ((sweepAfter || again) && db) { sweepAfter = false; scheduleIncremental() }
    }
  }

  /** #302: read just the Claude transcripts the watcher reported. A file
   *  left with bytes to read makes the next sweep a full one (the per-tick
   *  byte budget is tracked per sweep, not per file). Says it is complete,
   *  as a full sweep does, so the Usage page refreshes.
   *
   *  It then settles the accounts when the last walk left that to do
   *  (settleDue), and runs for that alone with nothing reported. Inside the
   *  sweep, as a walk does it, so nothing is ingested while the rollups are
   *  rebuilt. */
  async function ingestDirty(): Promise<void> {
    if (!db || sweeping) return
    if (dirtyClaude.size === 0 && !settleDue()) return
    sweeping = true
    sweepPending = false
    try {
      const files = [...dirtyClaude]
      dirtyClaude.clear()
      let done = 0
      for (const f of files) {
        sweepFailed.delete(f) // tried again now; it goes back in if it fails
        ingestClaudeFile(f)
        if (++done % YIELD_EVERY === 0) { await new Promise<void>((r) => setImmediate(r)); if (!db) return }
      }
      if (!db) return
      if (sweepPending) fullSweepDue = true
      if (settleDue()) await settleAccounts('incremental')
      if (!db) return
      // Not drained while a Rescan waits for its pass (2.1.3-beta.4): this
      // one read only the reported transcripts, not every file from its
      // start, whether the Rescan came before it or while it ran.
      post({ type: 'index-complete', firstIndex: false, drained: firstSweepDone && !sweepPending && !rescanPending, filesFailed: sweepFailed.size, eventsTotal: db.eventCount() })
    } catch (err) {
      // The reported files were taken out of the set before the sweep failed,
      // so the ones it did not reach would wait for their next report or the
      // next timed walk. A full walk is due instead; the 5 s timer runs it,
      // never at once.
      fullSweepDue = true
      logw('error', `ingestDirty failed: ${String(err)}`)
    }
    finally {
      sweeping = false
      if (sweepAfter && db) { sweepAfter = false; scheduleIncremental() }
    }
  }

  /**
   * #302: the rollups are dirty and no walk is due, so the next sweep
   * settles the accounts. A walk settles them itself once it has read every
   * file (it is due again until it has), and only when the app has named its
   * account folders; with none due, the last one did both and still left the
   * rollups dirty. That happens three ways: a session attribution arrived
   * between two pages of the rebuild (the database leaves them dirty for
   * another one), the rebuild failed, or an attribution that the rollups
   * could not follow came at any other time. The 5 s walk used to settle
   * those. A walk made due for it would list every folder to change no
   * file's reading, so the sweep of the reported files does it instead: one
   * indexed read of a row per tick while the rollups are clean, and the
   * rebuild alone when they are not.
   *
   * The one-off Codex re-read needs no check of its own: it is pending only
   * while the rollups are dirty (the upgrade sets both, and they are rebuilt
   * only after the re-read is finished), and settleAccounts finishes it
   * first. Never throws (it runs on the timer): a state that cannot be read
   * is handed to the sweep, which says so in the log.
   */
  function settleDue(): boolean {
    if (!db || fullSweepDue || !realmDirsKnown) return false
    try { return db.rollupsDirty() } catch { return true }
  }

  /** Usage track MP9: finish the Codex re-read, then rebuild the rollups
   *  when they are dirty, in steps with progress. Never throws: a failed
   *  rebuild leaves them dirty, and the next 5 s tick tries again
   *  (settleDue). */
  async function settleAccounts(phase: 'initial' | 'incremental'): Promise<void> {
    if (!db) return
    try {
      if (db.accountRereadPending()) db.finishAccountReread()
      rereadProgress = null
      if (!db.rollupsDirty()) return
      db.beginRollupRebuild()
      for (;;) {
        const step = db.stepRollupRebuild(TK_REBUILD_PAGE)
        rebuildProgress = { stage: 'rebuild', done: step.done, total: step.total }
        post({ type: 'index-progress', ...lastProgress, phase, accountReread: rebuildProgress })
        if (step.finished) break
        await new Promise<void>((r) => setImmediate(r))
        if (!db) return
      }
    } catch (err) {
      logw('error', `account attribution failed: ${String(err)}`)
    } finally {
      rebuildProgress = null
    }
    if (db) post({ type: 'index-progress', ...lastProgress, phase, accountReread: accountReread() })
  }

  function indexStatus(): unknown {
    const lastAt = db!.getMeta('lastIndexAt')
    return {
      firstIndexComplete: db!.getMeta('firstIndexComplete') === '1',
      indexing: sweeping,
      filesDone: lastProgress.filesDone,
      filesTotal: lastProgress.filesTotal,
      eventsTotal: db!.eventCount(),
      filesFailed: sweepFailed.size,
      lastIndexAt: lastAt ? Number(lastAt) : null,
      accountReread: accountReread(),
    }
  }

  function handleQuery(id: number, kind: string, args: Record<string, unknown>): void {
    try {
      let rows: unknown[]
      switch (kind) {
        case 'summary': rows = [db!.querySummary(pricing, args as any)]; break
        case 'sessions': rows = [db!.querySessions(pricing, args as any)]; break
        // 2.1.3-beta.4: main adds the accounts Settings leaves out; the
        // summary and the sessions list take them with their filter.
        case 'session-detail': rows = [db!.querySessionDetail(pricing, String((args as any).sessionId), (args as any).excludeAccountKeys)]; break
        case 'index-status': rows = [indexStatus()]; break
        // MP9: the providers and accounts the stored usage has.
        case 'accounts': rows = [db!.queryAccounts((args as any).excludeAccountKeys)]; break
        default: post({ type: 'error', id, message: `unknown query kind: ${kind}` }); return
      }
      post({ type: 'query-result', id, rows })
    } catch (err) { post({ type: 'error', id, message: `query ${kind} failed: ${err instanceof Error ? err.message : String(err)}` }) }
  }

  function scheduleIncremental(): void {
    if (watchTimer) clearTimeout(watchTimer)
    watchTimer = setTimeout(() => { watchTimer = null; void ingestAll('incremental') }, watchDebounceMs)
    ;(watchTimer as unknown as { unref?: () => void }).unref?.()
  }

  /**
   * #302: what a watcher event means for the next sweep, and whether there
   * is anything to sweep for. `perFile` is the Claude projects folder, where
   * the name is looked at (one lstat, never a listing) before deciding:
   *
   * - a transcript that exists, written or just made, is read on its own;
   * - on Windows a folder reported as changed starts nothing. Windows
   *   reports the folder beside every write to a file in it (measured: an
   *   append to proj\a.jsonl gives 'change proj' and then
   *   'change proj\a.jsonl', a nested one 'change proj\sid\subagents' and
   *   then the file), and the file reports its own event. Taken as an event
   *   that names no transcript, it walked the whole tree at every write;
   * - a file that is not a transcript (a tool result, a memory file, a
   *   subagent's .meta.json) and a link start nothing: the walk skips them
   *   too;
   * - a full walk is due for the rest: no file name, a name that is gone
   *   (deleted, or renamed away) or cannot be looked at, a folder reported
   *   as renamed (made, or moved here: what it holds may have been written
   *   before the watcher reached it), and anywhere but Windows a folder
   *   reported as changed. That report was measured on Windows only.
   *   Elsewhere it is not known to come beside a file's own event, and may
   *   be all the watcher says of what happened below the folder (macOS
   *   reports a folder when it has dropped the events under it), so the
   *   walk it always started there stays.
   *
   * Any event in a Codex folder makes the next sweep a full one, as every
   * event did before.
   */
  function noteWatchEvent(dir: string, perFile: boolean, event: unknown, filename: unknown): boolean {
    if (!perFile || typeof filename !== 'string' || filename.length === 0) { fullSweepDue = true; return true }
    const full = path.join(dir, filename)
    // lstat, not stat: stat follows a link, and a linked transcript would
    // then be read here although the full walk skips it.
    let st: nodeFs.Stats | null = null
    try { st = fs.lstatSync(full) } catch { st = null }
    if (!st) { fullSweepDue = true; return true }
    if (st.isDirectory()) {
      if (event === 'change' && process.platform === 'win32') return false
      fullSweepDue = true
      return true
    }
    if (st.isFile() && filename.endsWith('.jsonl')) { dirtyClaude.add(full); return true }
    // A link, or a file that is not a transcript: nothing to read, no walk.
    return false
  }

  function watchDir(dir: string, perFile: boolean): { close(): void } | null {
    const warnOnce = (message: string): void => { if (!watchWarned.has(dir)) { watchWarned.add(dir); logw('warn', message) } }
    try {
      if (!fs.existsSync(dir)) return null
      // An event that starts nothing schedules nothing, so it cannot put off
      // the sweep a reported transcript is waiting for.
      const wch = fs.watch(dir, { recursive: true }, (event: unknown, filename: unknown) => { if (noteWatchEvent(dir, perFile, event, filename)) scheduleIncremental() })
      // An FSWatcher 'error' with no listener throws -> uncaughtException -> the
      // worker dies and burns a restart toward permanent degrade. Log + close the
      // broken watcher and forget it: the 5 s timer then walks the folders, as it
      // did for every folder before #302, and tries the watcher again.
      ;(wch as { on?: (ev: string, cb: (e: unknown) => void) => void }).on?.('error', (err) => {
        warnOnce(`fs.watch error for ${dir}; relying on periodic sweep: ${String(err)}`)
        try { wch.close() } catch { /* already closed */ }
        if (watchers.get(dir) === wch) watchers.delete(dir)
      })
      return wch
    } catch (err) { warnOnce(`fs.watch failed for ${dir}: ${String(err)}`); return null }
  }

  /** #302: stop watching the folders no longer named, and watch each named
   *  folder that has no watcher: it did not exist when it was named (a first
   *  session makes it), or its watcher failed. Returns whether a full walk is
   *  due for one of them. A folder watched just now may hold what was written
   *  before its watcher started, and one that exists and cannot be watched is
   *  walked by the 5 s timer, as every folder was before the changed-files
   *  sweep. A folder that does not exist costs one check and no walk. */
  function syncWatchers(): boolean {
    const named = new Map<string, boolean>()
    if (claudeDir) named.set(claudeDir, true)
    for (const root of codexDirs) if (root.dir && !named.has(root.dir)) named.set(root.dir, false)
    for (const [dir, wch] of watchers) {
      if (named.has(dir)) continue
      try { wch.close() } catch { /* ignore */ }
      watchers.delete(dir)
    }
    let due = false
    for (const [dir, perFile] of named) {
      if (watchers.has(dir) || !fs.existsSync(dir)) continue
      const wch = watchDir(dir, perFile)
      if (wch) watchers.set(dir, wch)
      due = true
    }
    return due
  }

  /**
   * #302: ask the size of each transcript noted (activeClaude) and
   * hand the ones that moved to the next sweep, as if the watcher had
   * reported them. One lstat each, no folder listed. Skipped: a transcript
   * already reported, and one that could not be read when last tried (it
   * waits for its next report or the next walk, not for every tick). Never
   * throws: it runs on the timer.
   *
   * A transcript is forgotten when it is gone (ENOENT, or ENOTDIR when a
   * folder on its path is no longer one) or is no longer a plain file: its
   * report, if any, says so. A size check that fails any other way (a file
   * in use, a drive that does not answer) may pass, so the transcript is
   * kept and asked about again at the next tick; forgotten, its later
   * writes would wait for the next walk.
   *
   * On Windows the size check itself makes the watcher report a file that
   * was written through an open handle, so a read found here is followed by
   * a reported one, which finds nothing new or the bytes written since.
   */
  function noteActiveGrowth(): void {
    if (!db) return
    for (const file of activeClaude.keys()) {
      if (dirtyClaude.has(file) || sweepFailed.has(file)) continue
      let st: nodeFs.Stats
      try { st = fs.lstatSync(file) } catch (err) {
        const code = (err as { code?: unknown } | null)?.code
        if (code === 'ENOENT' || code === 'ENOTDIR') activeClaude.delete(file)
        continue
      }
      if (!st.isFile()) { activeClaude.delete(file); continue }
      try {
        const cursor = db.getFileCursor(file)
        if (!cursor || st.size !== cursor.size) dirtyClaude.add(file)
      } catch {
        // How far it was read cannot be told: the sweep reads it, and says
        // so if the index fails there too.
        dirtyClaude.add(file)
      }
    }
  }

  /** The Codex accounts' folders now (plan A13): watch the new ones, stop
   *  watching the gone ones. A folder that does not exist yet (an account
   *  that has run no session) is watched by the 5 s timer once it does. */
  function setCodexRealmDirs(dirs: readonly unknown[]): void {
    const base = codexDirs[0]
    // MP9: each a folder and whose sessions it holds; anything else is
    // dropped, and a folder listed twice (or the user's own again) keeps its
    // first entry.
    const next: TkSessionsRoot[] = []
    for (const d of dirs) {
      if (!d || typeof d !== 'object') continue
      const { dir, accountKey } = d as { dir?: unknown; accountKey?: unknown }
      if (typeof dir !== 'string' || dir.length === 0 || !tkAccountKeyOk(accountKey)) continue
      if (dir === base?.dir || next.some((n) => n.dir === dir)) continue
      next.push({ dir, accountKey })
    }
    codexDirs = base === undefined ? next : [base, ...next]
    syncWatchers()
  }

  /** Usage track MP10: record the account a Claude session runs under now
   *  (from then on) and attribute what the index holds of it with none yet.
   *  Anything not well formed is ignored; a failure is logged, never
   *  thrown. */
  function setSessionAccount(msg: { sessionId?: unknown; accountKey?: unknown }): void {
    const { sessionId, accountKey } = msg
    if (!tkSessionUuidOk(sessionId) || !tkClaudeAccountKeyOk(accountKey)) { logw('warn', 'a session attribution that was not well formed was ignored'); return }
    try { db!.setSessionAccount(sessionId, accountKey, Date.now()) } catch (err) { logw('error', `session attribution failed: ${String(err)}`) }
  }

  function startWatching(): void {
    syncWatchers()
    // Safety tail: recursive watch can miss newly-created nested session files on
    // some platforms. Every 5 s it reads what the watcher reported, and runs a
    // full walk when one is due: the last one left work behind or failed, a
    // named folder was watched just now or cannot be watched, or
    // TK_FULL_SWEEP_MS has passed since the last walk (#302). With no walk
    // due it asks the size of the transcripts found written, for the writes
    // the watcher does not report (a walk asks every file anyway), and
    // starts a sweep for the accounts alone when they are still to be
    // settled.
    tailTimer = setInterval(() => {
      if (sweeping) return
      if (syncWatchers()) fullSweepDue = true
      if (Date.now() - lastFullSweepAt >= TK_FULL_SWEEP_MS) fullSweepDue = true
      if (!fullSweepDue) noteActiveGrowth()
      if (fullSweepDue || dirtyClaude.size > 0 || settleDue()) void ingestAll('incremental')
    }, 5000)
    ;(tailTimer as unknown as { unref?: () => void }).unref?.()
  }

  function open(msg: Extract<ToTkWorker, { type: 'open' }>): void {
    db = openTkDb(msg.dbPath, { log: (m) => logw('warn', m) })
    setPricing(msg.pricing)
    configs = msg.configs
    if (configs.length) db.upsertConfigs(configs)
    // 2.1.3-beta.5: the folder's real path, once: a folder that is itself a
    // link (the profile's) was kept under the link's path, and its files again
    // under the real one. The path as given when it cannot be resolved.
    claudeDir = msg.claudeProjectsDir
    try { claudeDir = fs.realpathSync.native(msg.claudeProjectsDir) } catch { /* kept as given */ }
    subagentFolders = new Map()
    // The user's own Codex home: this computer's sign-in (MP9).
    codexDirs = [{ dir: msg.codexSessionsDir, accountKey: TK_CODEX_EXTERNAL }]
    // A caller that does not say (one predating the flag) has named them.
    realmDirsKnown = msg.codexRealmDirsKnown !== false
    firstSweepDone = db.getMeta('firstIndexComplete') === '1'
    // Ready BEFORE the sweep so queries work during indexing - and it carries
    // what the DB already knows, so an index completed on a previous run reads
    // as complete now rather than after this run's sweep (or never, when the
    // sweep does not finish).
    post({ type: 'ready', firstIndexComplete: firstSweepDone, eventsTotal: db.eventCount() })
    setTimeout(() => { void ingestAll('initial') }, 0)
    startWatching()
    setCodexRealmDirs(msg.codexRealmSessionsDirs ?? [])
  }

  function handle(msg: ToTkWorker): void {
    switch (msg.type) {
      case 'open': open(msg); return
      case 'shutdown': stop(); return
    }
    if (!db) { post({ type: 'error', id: msg.type === 'query' ? msg.id : undefined, message: `worker received ${msg.type} before open` }); return }
    switch (msg.type) {
      case 'set-pricing': setPricing(msg.pricing); return
      case 'set-configs': configs = msg.configs; db.upsertConfigs(configs); return
      case 'set-codex-realm-dirs':
        setCodexRealmDirs(Array.isArray(msg.dirs) ? msg.dirs : [])
        realmDirsKnown = true
        realmDirsSeq++
        // A sweep running now listed its files without these: one follows it.
        fullSweepDue = true
        if (sweeping) sweepAfter = true
        scheduleIncremental()
        return
      case 'set-session-account': setSessionAccount(msg); return
      case 'reindex': subagentFolders = new Map(); fullSweepDue = true; void ingestAll('incremental'); return
      case 'rescan':
        // The page's Rescan (2.1.3-beta.4): every file starts again from its
        // first byte. What is stored stays, and a turn read again is stored
        // once (its key is the same), so the figures can only fill in.
        if (rescanPending) return
        db.resetFileProgress()
        subagentFolders = new Map() // every folder is read again
        rescanPending = true
        rescanSeq++
        // A pass running now read some files before this: one follows it.
        fullSweepDue = true
        if (sweeping) sweepAfter = true
        scheduleIncremental()
        return
      case 'query': handleQuery(msg.id, msg.kind, msg.args); return
      default: { const _x: never = msg; void _x }
    }
  }

  host.onMessage((msg) => {
    const qid = msg?.type === 'query' ? msg.id : undefined
    try { handle(msg) } catch (err) {
      try { post({ type: 'error', id: qid, message: `worker handling failed: ${err instanceof Error ? err.message : String(err)}` }) } catch { /* ignore */ }
    }
  })

  function tickNow(): void { fullSweepDue = true; void ingestAll('incremental') }
  function healthNow(): void {
    if (!db) return
    const filesTracked = (db.raw.prepare('SELECT COUNT(*) AS n FROM tk_files').get() as { n: number }).n
    post({ type: 'health', eventsTotal: db.eventCount(), filesTracked, dbBytes: 0 })
  }
  function stop(): void {
    for (const wch of watchers.values()) { try { wch.close() } catch { /* ignore */ } }
    watchers.clear()
    if (watchTimer) { clearTimeout(watchTimer); watchTimer = null }
    if (tailTimer) { clearInterval(tailTimer); tailTimer = null }
    try { db?.close() } catch { /* ignore */ }
    db = undefined
  }

  return { tickNow, healthNow, stop }
}

// utilityProcess bootstrap (only defined inside a forked utilityProcess; undefined in tests)
const parentPort = (process as unknown as { parentPort?: { on(ev: 'message', h: (e: { data: unknown }) => void): void; postMessage(m: FromTkWorker): void } }).parentPort
if (parentPort) {
  const host: TkWorkerHostTransport = {
    post: (m) => parentPort.postMessage(m),
    onMessage: (h) => parentPort.on('message', (e) => h(e.data as ToTkWorker)),
  }
  createTokenomicsWorker(host)
}
