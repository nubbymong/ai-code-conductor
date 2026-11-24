// 2.1.3-beta.17, plan section C4 (aicc_planning#407): the resume list's pick
// folders a run left in the temp folder when it ended without its sessions'
// own end (a kill, a crash, a quiet uninstall). A start removes one only when
// it is a real folder named as a launch names it, a day old or more, and
// empty or holding only the pick file and its staging files: each file by
// name, never recursively; anything else keeps the folder whole. A running
// session's watcher sets its folder's time to now every hour, so a running
// session's folder is never a day old, in this copy of the app or another
// one sharing the temp folder.
//
// Real folders inside a folder of this file's own, passed to the sweep as the
// temp folder. No link, junction or hard link is planted here (the host-safe
// file): a real folder the fs stand-in below reads as a link (lstat says a
// symbolic link, not a directory, as Node reads a junction) stands in for
// one; a planted link is pick-folder-sweep-links.test.ts, quarantined from
// the host. Not checked here: a real folder of another user's (needs a second
// account); the owner check runs against a stand-in for this process's user
// id.
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** Names of folders the fs stand-in reads as links. */
const asLink = vi.hoisted(() => ({ names: new Set<string>() }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const lstatSync = ((p: unknown, o?: unknown) => {
    const st = (actual.lstatSync as (a: unknown, b?: unknown) => import('fs').Stats | undefined)(p, o)
    const name = String(p).split(/[\\/]/).pop() ?? ''
    if (!st || !asLink.names.has(name)) return st
    return { ...st, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true }
  }) as typeof actual.lstatSync
  return { ...actual, lstatSync, default: { ...actual, lstatSync } }
})

vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '', getDataDirectory: () => '' }))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))
vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: () => ({}),
  readConfigChecked: () => ({ outcome: 'absent', value: null }),
  getConfigDir: () => '/cfg',
}))
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { sweepStaleCodexPickFolders, CODEX_PICK_DIR_PREFIX, CODEX_PICK_FILE_NAME, CODEX_PICK_STALE_MS } = await import('../../../../src/main/providers/codex/spawn')
const { watchAndClaimRollout, PICK_FOLDER_TOUCH_MS } = await import('../../../../src/main/providers/codex/telemetry')
const { codexFolderIdentity } = await import('../../../../src/main/providers/codex/rollout-lookup')

const TEST_PREFIX = 'c4-pick-sweep-test-'
const HOUR = 3_600_000
const STAGING = `${CODEX_PICK_FILE_NAME}.0123456789abcdef.tmp`
const CONVERSATION = '019dd000-0001-7000-8000-00000000000a'
const made: string[] = []

/** A folder of this test's own, standing in for the temp folder. */
function root(): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), TEST_PREFIX)))
  made.push(d)
  return d
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  // TEST CLEANUP GUARD: only the folders this test made, by their own prefix, directly in the temp folder.
  for (const d of made.splice(0)) {
    if (!path.basename(d).startsWith(TEST_PREFIX) || path.dirname(d) !== fs.realpathSync.native(os.tmpdir())) continue
    fs.rmSync(d, { recursive: true, force: true })
  }
})

/** Set a path's times to `ageMs` before `now`. */
function age(p: string, ageMs: number, now = Date.now()): void {
  const t = new Date(now - ageMs)
  fs.utimesSync(p, t, t)
}

/** A folder named `name` in `tmp`, holding `files`, its time `ageMs` ago. */
function folder(tmp: string, name: string, ageMs: number, files: string[] = [], now = Date.now()): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir)
  for (const f of files) fs.writeFileSync(path.join(dir, f), '{"fresh":true}')
  age(dir, ageMs, now)
  return dir
}

describe('the start-up sweep of left-behind pick folders (aicc_planning#407)', () => {
  it('removes a pick folder a day old that is empty, or holds only the pick file and its staging files', () => {
    const tmp = root()
    const empty = folder(tmp, `${CODEX_PICK_DIR_PREFIX}aaaaaa`, 25 * HOUR)
    const held = folder(tmp, `${CODEX_PICK_DIR_PREFIX}bbbbbb`, 25 * HOUR, [CODEX_PICK_FILE_NAME, STAGING])
    expect(sweepStaleCodexPickFolders(tmp)).toBe(2)
    expect(fs.existsSync(empty)).toBe(false)
    expect(fs.existsSync(held)).toBe(false)
    expect(fs.readdirSync(tmp)).toEqual([])
  })

  it('leaves a pick folder younger than a day, and takes it once it is a day old', () => {
    const tmp = root()
    const now = Date.now()
    const young = folder(tmp, `${CODEX_PICK_DIR_PREFIX}cccccc`, CODEX_PICK_STALE_MS - 60_000, [CODEX_PICK_FILE_NAME], now)
    expect(sweepStaleCodexPickFolders(tmp, now)).toBe(0)
    expect(fs.readdirSync(young)).toEqual([CODEX_PICK_FILE_NAME])
    expect(sweepStaleCodexPickFolders(tmp, now + 120_000)).toBe(1)
    expect(fs.existsSync(young)).toBe(false)
  })

  it('leaves a folder of another name, and a file with a pick folder\'s name', () => {
    const tmp = root()
    const others = ['ccc-codex-hook-aaaaaa', 'ccc-codex-pickaaaaaa', `x-${CODEX_PICK_DIR_PREFIX}aaaaaa`].map((n) => folder(tmp, n, 25 * HOUR, [CODEX_PICK_FILE_NAME]))
    const file = path.join(tmp, `${CODEX_PICK_DIR_PREFIX}file`)
    fs.writeFileSync(file, 'x')
    age(file, 25 * HOUR)
    expect(sweepStaleCodexPickFolders(tmp)).toBe(0)
    for (const d of others) expect(fs.readdirSync(d)).toEqual([CODEX_PICK_FILE_NAME])
    expect(fs.readFileSync(file, 'utf8')).toBe('x')
  })

  it('leaves a pick folder whole, its pick file included, when anything else is in it', () => {
    const tmp = root()
    const withFile = folder(tmp, `${CODEX_PICK_DIR_PREFIX}dddddd`, 25 * HOUR, [CODEX_PICK_FILE_NAME, 'notes.txt'])
    const oddStaging = folder(tmp, `${CODEX_PICK_DIR_PREFIX}eeeeee`, 25 * HOUR, [CODEX_PICK_FILE_NAME, `${CODEX_PICK_FILE_NAME}.zz.tmp`])
    const withFolder = folder(tmp, `${CODEX_PICK_DIR_PREFIX}ffffff`, 25 * HOUR, [CODEX_PICK_FILE_NAME])
    fs.mkdirSync(path.join(withFolder, 'inner'))
    age(withFolder, 25 * HOUR)
    const pickIsFolder = folder(tmp, `${CODEX_PICK_DIR_PREFIX}gggggg`, 25 * HOUR)
    fs.mkdirSync(path.join(pickIsFolder, CODEX_PICK_FILE_NAME))
    age(pickIsFolder, 25 * HOUR)
    expect(sweepStaleCodexPickFolders(tmp)).toBe(0)
    expect(fs.readdirSync(withFile).sort()).toEqual(['notes.txt', CODEX_PICK_FILE_NAME])
    expect(fs.readdirSync(oddStaging).sort()).toEqual([CODEX_PICK_FILE_NAME, `${CODEX_PICK_FILE_NAME}.zz.tmp`])
    expect(fs.readdirSync(withFolder).sort()).toEqual(['inner', CODEX_PICK_FILE_NAME])
    expect(fs.readdirSync(pickIsFolder)).toEqual([CODEX_PICK_FILE_NAME])
  })

  it('leaves a pick folder that reads as a link or junction, and everything in it', () => {
    const tmp = root()
    const name = `${CODEX_PICK_DIR_PREFIX}link01`
    const dir = folder(tmp, name, 25 * HOUR, [CODEX_PICK_FILE_NAME])
    asLink.names.add(name)
    try {
      expect(codexFolderIdentity(dir)).toBeNull()
      expect(sweepStaleCodexPickFolders(tmp)).toBe(0)
    } finally {
      asLink.names.delete(name)
    }
    expect(fs.readdirSync(dir)).toEqual([CODEX_PICK_FILE_NAME])
  })

  it('leaves a pick folder another user owns, where the platform keeps owners, and takes it once it reads as this user\'s', () => {
    const tmp = root()
    const dir = folder(tmp, `${CODEX_PICK_DIR_PREFIX}other1`, 25 * HOUR, [CODEX_PICK_FILE_NAME])
    const owner = fs.lstatSync(dir).uid
    const had = Object.getOwnPropertyDescriptor(process, 'getuid')
    Object.defineProperty(process, 'getuid', { value: () => owner + 1, configurable: true, writable: true })
    try {
      expect(sweepStaleCodexPickFolders(tmp)).toBe(0)
    } finally {
      if (had) Object.defineProperty(process, 'getuid', had)
      else delete (process as { getuid?: unknown }).getuid
    }
    expect(fs.readdirSync(dir)).toEqual([CODEX_PICK_FILE_NAME])
    expect(sweepStaleCodexPickFolders(tmp)).toBe(1)
  })

  it('looks nowhere but the folder it is given, and answers 0 for one that is not there or not absolute', () => {
    const tmp = root()
    const inner = folder(tmp, 'deeper', 25 * HOUR)
    const nested = folder(inner, `${CODEX_PICK_DIR_PREFIX}hhhhhh`, 25 * HOUR)
    age(inner, 25 * HOUR)
    expect(sweepStaleCodexPickFolders(tmp)).toBe(0)
    expect(fs.existsSync(nested)).toBe(true)
    expect(sweepStaleCodexPickFolders(path.join(tmp, 'missing'))).toBe(0)
    expect(sweepStaleCodexPickFolders('relative-folder')).toBe(0)
  })

  it('leaves a running session\'s pick folder: its watcher sets the folder\'s time to now every hour', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tmp = root()
    const sessions = path.join(tmp, 'sessions')
    fs.mkdirSync(sessions)
    // A session started more than a day ago, still running.
    const dir = folder(tmp, `${CODEX_PICK_DIR_PREFIX}live01`, 25 * HOUR)
    const pickFolder = codexFolderIdentity(dir)
    expect(pickFolder).toBeTruthy()
    const src = watchAndClaimRollout('sid-live', '/p/demo', Date.now(), () => {}, sessions, undefined, {
      resumeId: CONVERSATION,
      pickFile: path.join(dir, CODEX_PICK_FILE_NAME),
      pickFolder: pickFolder!,
    })
    try {
      await vi.advanceTimersByTimeAsync(PICK_FOLDER_TOUCH_MS)
      expect(sweepStaleCodexPickFolders(tmp, Date.now())).toBe(0)
      expect(fs.existsSync(dir)).toBe(true)
      // A day on, still running: still kept.
      await vi.advanceTimersByTimeAsync(CODEX_PICK_STALE_MS)
      expect(sweepStaleCodexPickFolders(tmp, Date.now())).toBe(0)
      expect(fs.existsSync(dir)).toBe(true)
    } finally {
      src.stop()
    }
    // The watch's own end removes it, as before.
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('a stopped watch marks its folder no more', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tmp = root()
    const sessions = path.join(tmp, 'sessions')
    fs.mkdirSync(sessions)
    const dir = folder(tmp, `${CODEX_PICK_DIR_PREFIX}live02`, 25 * HOUR)
    // Something the watcher does not remove keeps the folder after its end.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    const src = watchAndClaimRollout('sid-gone', '/p/demo', Date.now(), () => {}, sessions, undefined, {
      resumeId: CONVERSATION,
      pickFile: path.join(dir, CODEX_PICK_FILE_NAME),
      pickFolder: codexFolderIdentity(dir)!,
    })
    src.stop()
    age(dir, 25 * HOUR)
    const stoppedAt = fs.statSync(dir).mtimeMs
    await vi.advanceTimersByTimeAsync(2 * PICK_FOLDER_TOUCH_MS)
    expect(fs.statSync(dir).mtimeMs).toBe(stoppedAt)
  })
})
