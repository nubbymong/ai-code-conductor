// The resume picker's other worktrees are gated each
// on its own. Only a clean one joins the set the picker may relaunch the CLI in
// (CCC_GATED_DIRS); a refused or unchecked one is left out (the picker then
// refuses a retarget into it unless isGatedDir finds it to be a folder of the
// set) and never decides the launch, and the log names the folder and why.
// The scan itself is injected: no file is read here, apart from the cases
// on this machine's own disk (a path with no folder at it, and the gate a
// launch uses), which use the test's own temp folders.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ProjectGateResult } from '../../../src/shared/providers'

const h = vi.hoisted(() => ({ warned: [] as string[] }))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: () => {}, logError: () => {}, logDebug: () => {},
  logWarn: (...a: unknown[]) => { h.warned.push(a.map(String).join(' ')) },
}))
vi.mock('../../../src/main/claude-cli-version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/claude-cli-version')>()),
  ensureClaudeCliVersion: () => {},
}))

const {
  gatePickerSiblingDirs, gateManagedLaunch, gateManagedLaunchDirs, peekGateVerdict,
  _resetProjectScanStateForTest, _projectScanStateForTest,
} = await import('../../../src/main/managed-launch-diagnostics')

/** The launch's own gate answered clean in time for every launch folder. */
const answeredClean = (): ProjectGateResult => ({ status: 'clean' })

/** The sibling gate with a folder at every sibling's path; the cases on a path
 *  with no folder are in their own block below. */
const siblings = (
  launchDirs: readonly string[],
  candidates: readonly string[],
  gate: (cwd: string) => Promise<ProjectGateResult>,
  platform?: NodeJS.Platform,
  realpath?: (p: string) => Promise<string | null>,
) => gatePickerSiblingDirs(launchDirs, candidates, gate, platform, realpath, async () => true)

const CONFIGURED = '/repo/main'
const RESUME = '/repo/wt-resume'
const verdicts: Record<string, ProjectGateResult> = {
  '/repo/wt-clean': { status: 'clean' },
  '/repo/wt-refused': { status: 'refused', keys: ['settings.local.json: apiKeyHelper'] },
  '/repo/wt-unc': { status: 'not-scanned', reason: 'timed-out' },
}

beforeEach(() => {
  h.warned.length = 0
  _resetProjectScanStateForTest()
})

describe('gatePickerSiblingDirs', () => {
  // Mutation to prove this can fail: push every sibling into `clean` whatever
  // its verdict.
  it('only a clean sibling joins the picker\'s set; a refused or unchecked one is left out with its verdict', async () => {
    const asked: string[] = []
    const gate = async (dir: string): Promise<ProjectGateResult> => { asked.push(dir); return verdicts[dir] ?? { status: 'clean' } }
    const r = await siblings([CONFIGURED, RESUME], [CONFIGURED, '/repo/wt-clean', '/repo/wt-refused', RESUME, '/repo/wt-unc', '/repo/wt-clean'], gate)
    expect(r.clean).toEqual(['/repo/wt-clean'])
    expect(r.leftOut).toEqual([
      { dir: '/repo/wt-refused', result: verdicts['/repo/wt-refused'] },
      { dir: '/repo/wt-unc', result: verdicts['/repo/wt-unc'] },
    ])
    // The launch's own folders are not gated again here, and each sibling once.
    expect(asked).toEqual(['/repo/wt-clean', '/repo/wt-refused', '/repo/wt-unc'])
  })

  it('names each folder left out, and why, in the log', async () => {
    await siblings([CONFIGURED], ['/repo/wt-refused', '/repo/wt-unc'], async (d) => verdicts[d])
    expect(h.warned).toHaveLength(2)
    expect(h.warned[0]).toContain('/repo/wt-refused')
    expect(h.warned[0]).toContain('apiKeyHelper')
    expect(h.warned[1]).toContain('/repo/wt-unc')
    expect(h.warned[1]).toContain('timed-out')
  })

  it('gates one sibling at a time (one scan slot per launch, as the launch gate does)', async () => {
    let inFlight = 0
    let peak = 0
    const gate = async (): Promise<ProjectGateResult> => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { status: 'clean' }
    }
    const r = await siblings([CONFIGURED], ['/a', '/b', '/c'], gate)
    expect(r.clean).toEqual(['/a', '/b', '/c'])
    expect(peak).toBe(1)
  })

  // The configured folder arrives in whatever case the user typed and git
  // lists it in the case on disk: in another case it is still the launch's own
  // folder, so it is not gated again as a sibling nor logged as left out.
  // Mutation to prove this can fail: make `fold` the identity.
  it('on Windows, the launch\'s own folder in another case is not a sibling, and a sibling listed twice in two cases is gated once', async () => {
    const asked: string[] = []
    const gate = async (dir: string): Promise<ProjectGateResult> => {
      asked.push(dir)
      return dir === 'C:\\Repo\\WT' ? { status: 'clean' } : { status: 'not-scanned', reason: 'timed-out' }
    }
    // A case-insensitive folder, as NTFS folders are by default: the disk
    // resolves every spelling to one real path.
    const caseInsensitiveDisk = async (p: string) => p.toLowerCase()
    const r = await siblings(['C:\\Repo\\Main'], ['c:\\repo\\main', 'C:\\Repo\\WT', 'c:\\repo\\wt'], gate, 'win32', caseInsensitiveDisk)
    expect(asked).toEqual(['C:\\Repo\\WT'])
    expect(r).toEqual({ launch: ['C:\\Repo\\Main'], clean: ['C:\\Repo\\WT'], leftOut: [] })
    expect(h.warned).toEqual([])
  })

  // A folder made case-sensitive (fsutil, or one WSL created) can hold two
  // worktrees whose names differ only in case. A path that differs only in
  // case from one already known is skipped only when the disk resolves both
  // to the same real path. Mutation to prove this can fail: skip on the case
  // fold alone.
  it('on Windows, a case-sensitive folder\'s case-variant worktree is a sibling of its own, and is gated', async () => {
    const asked: string[] = []
    const gate = async (dir: string): Promise<ProjectGateResult> => {
      asked.push(dir)
      return dir === 'C:\\R\\REPO' ? { status: 'refused', keys: ['settings.json: apiKeyHelper'] } : { status: 'clean' }
    }
    // Each spelling is a folder of its own on this disk.
    const caseSensitiveDisk = async (p: string) => p
    const r = await siblings(['C:\\R\\repo'], ['C:\\R\\REPO', 'C:\\R\\other', 'C:\\R\\Other'], gate, 'win32', caseSensitiveDisk)
    expect(asked).toEqual(['C:\\R\\REPO', 'C:\\R\\other', 'C:\\R\\Other'])
    expect(r.clean).toEqual(['C:\\R\\other', 'C:\\R\\Other'])
    expect(r.leftOut).toEqual([{ dir: 'C:\\R\\REPO', result: { status: 'refused', keys: ['settings.json: apiKeyHelper'] } }])
    expect(h.warned).toHaveLength(1)
    expect(h.warned[0]).toContain('REPO')
  })

  it('on Windows, a case variant whose real path cannot be read is gated, not taken for a folder already gated', async () => {
    const asked: string[] = []
    const r = await siblings(['C:\\R\\repo'], ['C:\\R\\REPO'], async (d) => { asked.push(d); return { status: 'clean' } }, 'win32', async () => null)
    expect(asked).toEqual(['C:\\R\\REPO'])
    expect(r.clean).toEqual(['C:\\R\\REPO'])
  })

  // A folder left out here whose name differs only in case from a folder the
  // picker is given is one the disk did not resolve to that folder, and the
  // picker matches such a name only by real path (isGatedDir,
  // resume-picker.js), so it refuses it too, unless the disk resolves it to a
  // folder of the set when the picker asks, and the log says so, as for any
  // folder left out. Mutation to prove this can fail: log a folder whose name
  // differs only in case from a given one with any other line.
  it('on Windows, a folder left out is logged as kept out of the picker, also when its name differs only in case from a folder the picker is given', async () => {
    const caseSensitiveDisk = async (p: string) => p
    // A folder whose name differs only in case from the launch folder; a
    // sibling with a clean folder of the same name in another case found only
    // after it; and a folder with no such name.
    await siblings(
      ['C:\\R\\repo'],
      ['C:\\R\\REPO', 'C:\\R\\WT', 'C:\\R\\wt', 'C:\\R\\lone'],
      async (d) => (d === 'C:\\R\\wt' ? { status: 'clean' } : { status: 'refused', keys: ['settings.json: apiKeyHelper'] }),
      'win32', caseSensitiveDisk)
    expect(h.warned).toHaveLength(4)
    expect(h.warned[0]).toContain('will not open conversations in C:\\R\\REPO for this launch')
    expect(h.warned[0]).toContain('apiKeyHelper')
    expect(h.warned[0]).not.toContain('may still open')
    expect(h.warned.filter((w) => w.includes('may still open'))).toEqual([])
    // The sibling's clean folder in another case is not given to the picker, so it is kept out.
    expect(h.warned[1]).toContain('will not open conversations in C:\\R\\WT')
    expect(h.warned[1]).not.toContain('may still open')
    expect(h.warned[2]).toContain('will not open conversations in C:\\R\\lone')
    expect(h.warned[2]).not.toContain('may still open')
    expect(h.warned[3]).toContain('will not open conversations in C:\\R\\wt')
    expect(h.warned[3]).toContain('C:\\R\\WT, whose name differs from it only in case, was left out')
  })

  // On Windows a clean sibling whose name differs only in case from one left
  // out is left out too, wherever it comes in the list. Mutation to prove this
  // can fail: hand every clean sibling over (`return { clean, leftOut }`).
  it.each([
    ['after the refused one', ['C:\\R\\WT', 'C:\\R\\wt', 'C:\\R\\lone']],
    ['before the refused one', ['C:\\R\\wt', 'C:\\R\\WT', 'C:\\R\\lone']],
  ])('on Windows, a clean sibling whose name differs only in case from a refused one is not handed to the picker (%s)', async (_label, candidates) => {
    const caseSensitiveDisk = async (p: string) => p
    const r = await siblings(
      ['C:\\R\\repo'], candidates,
      async (d) => (d === 'C:\\R\\WT' ? { status: 'refused', keys: ['settings.json: apiKeyHelper'] } : { status: 'clean' }),
      'win32', caseSensitiveDisk)
    expect(r.clean).toEqual(['C:\\R\\lone'])
    expect(r.leftOut).toEqual([{ dir: 'C:\\R\\WT', result: { status: 'refused', keys: ['settings.json: apiKeyHelper'] } }])
    expect(h.warned.some((w) => w.includes('will not open conversations in C:\\R\\wt'))).toBe(true)
  })

  it('on Windows, an unchecked sibling keeps out a clean one whose name differs from it only in case', async () => {
    const r = await siblings(
      ['C:\\R\\repo'], ['C:\\R\\Net', 'C:\\R\\net'],
      async (d) => (d === 'C:\\R\\Net' ? { status: 'not-scanned', reason: 'timed-out' } : { status: 'clean' }),
      'win32', async (p) => p)
    expect(r.clean).toEqual([])
  })

  it('elsewhere, a clean sibling whose name differs only in case from a refused one is a different folder, and is handed over', async () => {
    const r = await siblings(
      ['/R/repo'], ['/R/WT', '/R/wt'],
      async (d) => (d === '/R/WT' ? { status: 'refused', keys: ['settings.json: apiKeyHelper'] } : { status: 'clean' }),
      'linux', async (p) => p)
    expect(r.clean).toEqual(['/R/wt'])
  })

  it('elsewhere, a folder left out is logged as kept out, also when another differs from it only in case', async () => {
    await siblings(['/R/repo'], ['/R/REPO'], async () => ({ status: 'refused', keys: ['settings.json: apiKeyHelper'] }), 'linux', async (p) => p)
    expect(h.warned).toHaveLength(1)
    expect(h.warned[0]).toContain('will not open conversations in /R/REPO')
  })

  it('the real path is asked only for paths that differ in case alone', async () => {
    const looked: string[] = []
    const realpath = async (p: string) => { looked.push(p); return p.toLowerCase() }
    await siblings(['C:\\R\\repo'], ['C:\\R\\repo', 'C:\\R\\wt'], async () => ({ status: 'clean' }), 'win32', realpath)
    expect(looked).toEqual([])
    await siblings(['/R/repo'], ['/R/REPO'], async () => ({ status: 'clean' }), 'linux', realpath)
    expect(looked).toEqual([])
  })

  it('elsewhere, folders that differ only in case are different folders and each is gated', async () => {
    const asked: string[] = []
    const r = await siblings(['/Repo/main'], ['/repo/main', '/Repo/main'], async (d) => { asked.push(d); return { status: 'clean' } }, 'linux')
    expect(asked).toEqual(['/repo/main'])
    expect(r.clean).toEqual(['/repo/main'])
  })

  // The scan already bounds its keys (20 names and its own "and N more"), and
  // the log keeps that list as it is: bounding it again would count the "and N
  // more" as one more key. Mutation to prove this can fail: log
  // boundNames(result.keys) again.
  it('logs the scan\'s own bounded key list as it is (its "and N more" kept)', async () => {
    const keys = [...Array.from({ length: 20 }, (_, i) => `settings.json: key${i}`), 'and 7 more']
    await siblings([CONFIGURED], ['/repo/wt-many'], async () => ({ status: 'refused', keys }))
    expect(h.warned).toHaveLength(1)
    expect(h.warned[0]).toContain('key19, and 7 more)')
    expect(h.warned[0]).not.toContain('and 1 more')
  })

  it('no siblings: nothing gated, nothing logged', async () => {
    const r = await siblings([CONFIGURED], [CONFIGURED, ''], async () => { throw new Error('not asked') })
    expect(r).toEqual({ launch: [CONFIGURED], clean: [], leftOut: [] })
    expect(h.warned).toEqual([])
  })
})

// git keeps listing a worktree whose folder was deleted (a prunable record).
// With nothing at its path the gate reads nothing there and finds it clean,
// and a folder made there later was never checked, so it is left out of the
// picker's set all the same and logged with the same kept-out line.
describe('a sibling with no folder at its path', () => {
  // Mutations to prove this can fail: hand over every sibling the gate finds
  // clean without asking for its folder; ask for the folder before the gate,
  // or for a sibling the gate did not find clean.
  it('is left out and logged as kept out; the folder is asked for only after the gate finds a sibling clean', async () => {
    const order: string[] = []
    const gate = async (d: string): Promise<ProjectGateResult> => { order.push(`gate ${d}`); return verdicts[d] ?? { status: 'clean' } }
    const isFolder = async (d: string): Promise<boolean> => { order.push(`folder ${d}`); return d !== '/repo/wt-gone' }
    const r = await gatePickerSiblingDirs([CONFIGURED], ['/repo/wt-gone', '/repo/wt-refused', '/repo/wt-clean'], gate, 'linux', async (p) => p, isFolder)
    expect(r.clean).toEqual(['/repo/wt-clean'])
    expect(r.leftOut).toEqual([{ dir: '/repo/wt-refused', result: verdicts['/repo/wt-refused'] }])
    expect(order).toEqual(['gate /repo/wt-gone', 'folder /repo/wt-gone', 'gate /repo/wt-refused', 'gate /repo/wt-clean', 'folder /repo/wt-clean'])
    expect(h.warned).toHaveLength(2)
    expect(h.warned[0]).toBe('[managed-launch] the resume picker will not open conversations in /repo/wt-gone for this launch: there was no folder there when the session started')
    expect(h.warned[1]).toContain('will not open conversations in /repo/wt-refused for this launch')
  })

  it('on this machine\'s own disk, with the gate and the folder check a launch uses: only a folder is handed over', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-siblings-gone-'))
    try {
      const main = path.join(root, 'main')
      const here = path.join(root, 'wt-here')
      const gone = path.join(root, 'wt-gone')
      const file = path.join(root, 'wt-file')
      fs.mkdirSync(main)
      fs.mkdirSync(here)
      fs.writeFileSync(file, '')
      expect(fs.existsSync(gone)).toBe(false)
      const r = await gatePickerSiblingDirs([main], [main, here, gone, file])
      expect(r).toEqual({ launch: [main], clean: [here], leftOut: [] })
      // The log may shorten the home folder: the names are what is asserted.
      expect(h.warned).toHaveLength(2)
      expect(h.warned[0]).toContain(path.basename(root))
      expect(h.warned[0]).toContain('wt-gone for this launch: there was no folder there when the session started')
      expect(h.warned[1]).toContain('wt-file for this launch: there was no folder there when the session started')
    } finally {
      // TEST CLEANUP GUARD: only this case's own folder, by its prefix and parent.
      if (path.basename(root).startsWith('ccc-siblings-gone-') && path.dirname(root) === path.resolve(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // Mutation to prove this can fail: ask for the folder without a time limit.
  it('a folder check that does not answer within the gate\'s own deadline counts as no folder', async () => {
    vi.useFakeTimers()
    try {
      const never = (): Promise<boolean> => new Promise<boolean>(() => {})
      let settled = false
      const pending = gatePickerSiblingDirs([CONFIGURED, RESUME], ['/repo/wt-hung'], async () => ({ status: 'clean' }), 'linux', async (p) => p, never, answeredClean)
        .then((r) => { settled = true; return r })
      await vi.advanceTimersByTimeAsync(2000)
      expect(settled).toBe(false)
      // The gate's deadline (3 s) for the resume target's folder, then for the sibling's.
      await vi.advanceTimersByTimeAsync(10_000)
      const r = await pending
      expect(r).toEqual({ launch: [CONFIGURED], clean: [], leftOut: [] })
      expect(h.warned).toHaveLength(2)
      expect(h.warned[0]).toContain(`${RESUME} for this launch: there was no folder there when the session started`)
      expect(h.warned[1]).toContain('/repo/wt-hung for this launch: there was no folder there when the session started')
    } finally {
      vi.useRealTimers()
    }
  })
})

// The launch's own folders travel to the picker with the clean siblings
// (`launch`). The configured folder, where the session itself starts, always
// does; the resume target's folder only when a folder is there once the
// launch's own gate has answered clean in time: an absent one is clean to that
// gate (it reads nothing there), the launch then starts in the configured
// folder, and a folder made there later was never checked.
describe('the launch\'s own folders handed to the picker', () => {
  // Mutations to prove this can fail: hand over every launch folder; ask for
  // the configured folder's folder too.
  it('an absent resume target is left out, also when the picker lists it, and logged as kept out', async () => {
    const asked: string[] = []
    const gated: string[] = []
    const isFolder = async (d: string): Promise<boolean> => { asked.push(d); return d === '/repo/wt-clean' }
    const r = await gatePickerSiblingDirs([CONFIGURED, RESUME], [CONFIGURED, RESUME, '/repo/wt-clean'],
      async (d) => { gated.push(d); return { status: 'clean' } }, 'linux', async (p) => p, isFolder, answeredClean)
    expect(r.launch).toEqual([CONFIGURED])
    expect(r.clean).toEqual(['/repo/wt-clean'])
    // The set the picker is handed: the launch's own folders and the clean siblings.
    expect([...new Set([...r.launch, ...r.clean])]).not.toContain(RESUME)
    // Not gated again as a sibling; the configured folder is not asked for.
    expect(gated).toEqual(['/repo/wt-clean'])
    expect(asked).toEqual([RESUME, '/repo/wt-clean'])
    expect(h.warned).toEqual([`[managed-launch] the resume picker will not open conversations in ${RESUME} for this launch: there was no folder there when the session started`])
  })

  it('a resume target with a folder there is handed over, as is the configured folder', async () => {
    const asked: string[] = []
    const r = await gatePickerSiblingDirs([CONFIGURED, RESUME], [CONFIGURED, RESUME], async () => ({ status: 'clean' }), 'linux', async (p) => p,
      async (d) => { asked.push(d); return true }, answeredClean)
    expect(r).toEqual({ launch: [CONFIGURED, RESUME], clean: [], leftOut: [] })
    expect(asked).toEqual([RESUME])
    expect(h.warned).toEqual([])
  })

  // With the gate and the folder check a launch uses, gated first as
  // pty-manager gates them (gateManagedLaunchDirs, then this).
  it('on this machine\'s own disk, with the gate and the folder check a launch uses', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-siblings-target-'))
    try {
      const main = path.join(root, 'main')
      const here = path.join(root, 'wt-here')
      const gone = path.join(root, 'wt-gone')
      fs.mkdirSync(main)
      fs.mkdirSync(here)
      expect(fs.existsSync(gone)).toBe(false)
      expect(await gateManagedLaunchDirs([main, gone])).toEqual({ status: 'clean' })
      expect((await gatePickerSiblingDirs([main, gone], [main, gone])).launch).toEqual([main])
      expect(await gateManagedLaunchDirs([main, here])).toEqual({ status: 'clean' })
      expect((await gatePickerSiblingDirs([main, here], [main, here])).launch).toEqual([main, here])
    } finally {
      // TEST CLEANUP GUARD: only this case's own folder, by its prefix and parent.
      if (path.basename(root).startsWith('ccc-siblings-target-') && path.dirname(root) === path.resolve(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// The disk is asked whether a launch folder is there only when the gate's
// latest answer for that folder, within the reuse window, is clean. A network
// path, and a folder the gate refused, did not check, could not check in time,
// or has no answer on record for, is handed over as the gate left it, with no
// further read: a read of an
// unreachable share holds a filesystem thread for the system's own timeout,
// which the gate's thread ceiling does not count.
describe('which launch folders the disk is asked about', () => {
  const UNC_TARGET = '\\\\ccc-gate-test-host.invalid\\share\\wt-resume'

  // Mutation to prove this can fail: ask for every launch folder after the
  // first, whatever its gate answered (the loop before this change).
  it.each<[string, ProjectGateResult | undefined]>([
    ['timed out', { status: 'not-scanned', reason: 'timed-out' }],
    ['a network path', { status: 'not-scanned', reason: 'network-path' }],
    ['the thread ceiling', { status: 'not-scanned', reason: 'thread-ceiling' }],
    ['refused', { status: 'refused', keys: ['settings.json: apiKeyHelper'] }],
    ['none on record', undefined],
  ])('a resume target whose gate answer is %s is handed over, and the disk is not asked', async (_label, verdict) => {
    const asked: string[] = []
    const r = await gatePickerSiblingDirs([CONFIGURED, RESUME], [], async () => { throw new Error('not asked') }, 'linux', async (p) => p,
      async (d) => { asked.push(d); return false }, () => verdict)
    expect(asked).toEqual([])
    expect(r).toEqual({ launch: [CONFIGURED, RESUME], clean: [], leftOut: [] })
    expect(h.warned).toEqual([])
  })

  // Mutation to prove this can fail: drop the network-path check and go by the
  // gate's answer alone.
  it.each([
    ['backslashes', UNC_TARGET],
    ['forward slashes', '//ccc-gate-test-host.invalid/share/wt-resume'],
  ])('a resume target on a network path is never asked of the disk, even with a clean answer on record (%s)', async (_label, target) => {
    const asked: string[] = []
    const r = await gatePickerSiblingDirs([CONFIGURED, target], [], async () => { throw new Error('not asked') }, 'win32', async (p) => p,
      async (d) => { asked.push(d); return false }, answeredClean)
    expect(asked).toEqual([])
    expect(r.launch).toEqual([CONFIGURED, target])
    expect(h.warned).toEqual([])
  })

  // With the gate a launch uses, and its record of what it answered.
  it('a resume target on a network path: the gate reads nothing there, and neither does the folder check', async () => {
    expect(await gateManagedLaunch(UNC_TARGET)).toEqual({ status: 'not-scanned', reason: 'network-path' })
    const asked: string[] = []
    const r = await gatePickerSiblingDirs([CONFIGURED, UNC_TARGET], [], undefined, undefined, undefined, async (d) => { asked.push(d); return false })
    expect(asked).toEqual([])
    expect(r.launch).toEqual([CONFIGURED, UNC_TARGET])
  })

  // The scan of a folder whose gate gave up on it goes on, and when it
  // settles it records what it found for peekGateVerdict; the launch was still
  // told `timed-out`, and that is what decides here. Mutation to prove this
  // can fail: decide by peekGateVerdict(dir)?.status === 'clean'.
  it('a resume target whose scan did not answer in time is not asked, though the scan found it clean afterwards', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-siblings-late-'))
    try {
      const main = path.join(root, 'main')
      const late = path.join(root, 'wt-late')
      fs.mkdirSync(main)
      fs.mkdirSync(late)
      let answer: ProjectGateResult | undefined
      vi.useFakeTimers()
      try {
        const pending = gateManagedLaunch(late)
        // The gate's deadline (3 s) passes before the scan's first read can
        // return: that read needs a turn of the event loop, which this does
        // not give it.
        vi.advanceTimersByTime(3000)
        answer = await pending
      } finally {
        vi.useRealTimers()
      }
      expect(answer).toEqual({ status: 'not-scanned', reason: 'timed-out' })
      await vi.waitFor(() => expect(_projectScanStateForTest().outstanding).toBe(0), { timeout: 5000 })
      expect(peekGateVerdict(late)).toEqual({ status: 'clean' })
      const asked: string[] = []
      const r = await gatePickerSiblingDirs([main, late], [], undefined, undefined, undefined, async (d) => { asked.push(d); return true })
      expect(asked).toEqual([])
      expect(r.launch).toEqual([main, late])
    } finally {
      // TEST CLEANUP GUARD: only this case's own folder, by its prefix and parent.
      if (path.basename(root).startsWith('ccc-siblings-late-') && path.dirname(root) === path.resolve(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // The record is the gate's latest answer for the folder, and only for the
  // reuse window (5 s). Mutation to prove this can fail: keep an answer past
  // the window (drop the age check in lastGateAnswer).
  it('a clean answer older than the reuse window is not used: the disk is not asked', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-siblings-stale-'))
    try {
      const main = path.join(root, 'main')
      const gone = path.join(root, 'wt-gone')
      fs.mkdirSync(main)
      expect(await gateManagedLaunch(gone)).toEqual({ status: 'clean' })
      const asked: string[] = []
      const isFolder = async (d: string): Promise<boolean> => { asked.push(d); return fs.existsSync(d) }
      // Within the window the clean answer decides: the absent folder is asked about and left out.
      expect((await gatePickerSiblingDirs([main, gone], [], undefined, undefined, undefined, isFolder)).launch).toEqual([main])
      expect(asked).toEqual([gone])
      asked.length = 0
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.now() + 5001)
        const r = await gatePickerSiblingDirs([main, gone], [], undefined, undefined, undefined, isFolder)
        expect(asked).toEqual([])
        expect(r.launch).toEqual([main, gone])
      } finally {
        vi.useRealTimers()
      }
    } finally {
      // TEST CLEANUP GUARD: only this case's own folder, by its prefix and parent.
      if (path.basename(root).startsWith('ccc-siblings-stale-') && path.dirname(root) === path.resolve(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // Mutation to prove this can fail: record only a clean answer, so a later
  // timed-out answer for the folder leaves the earlier clean one in place.
  it('a timed-out answer replaces an earlier clean one for the same folder: the disk is not asked', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-siblings-relate-'))
    try {
      const main = path.join(root, 'main')
      const late = path.join(root, 'wt-late')
      fs.mkdirSync(main)
      fs.mkdirSync(late)
      expect(await gateManagedLaunch(late)).toEqual({ status: 'clean' })
      let answer: ProjectGateResult | undefined
      vi.useFakeTimers()
      try {
        const pending = gateManagedLaunch(late)
        // As above: the deadline passes before the scan's first read returns.
        vi.advanceTimersByTime(3000)
        answer = await pending
      } finally {
        vi.useRealTimers()
      }
      expect(answer).toEqual({ status: 'not-scanned', reason: 'timed-out' })
      await vi.waitFor(() => expect(_projectScanStateForTest().outstanding).toBe(0), { timeout: 5000 })
      const asked: string[] = []
      const r = await gatePickerSiblingDirs([main, late], [], undefined, undefined, undefined, async (d) => { asked.push(d); return true })
      expect(asked).toEqual([])
      expect(r.launch).toEqual([main, late])
    } finally {
      // TEST CLEANUP GUARD: only this case's own folder, by its prefix and parent.
      if (path.basename(root).startsWith('ccc-siblings-relate-') && path.dirname(root) === path.resolve(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // The answers are read when the function is called, before its first
  // await, which is where the caller's own gate has just left them. Mutation
  // to prove this can fail: read each folder's answer only when the loop
  // reaches it, after the folder check of the one before has awaited.
  it('every launch folder\'s gate answer is read before the disk is asked about any of them', async () => {
    const order: string[] = []
    await gatePickerSiblingDirs([CONFIGURED, RESUME, '/repo/wt-second'], [], async () => { throw new Error('not asked') }, 'linux', async (p) => p,
      async (d) => { order.push(`folder ${d}`); return true }, (d) => { order.push(`answer ${d}`); return { status: 'clean' } })
    expect(order).toEqual([`answer ${RESUME}`, 'answer /repo/wt-second', `folder ${RESUME}`, 'folder /repo/wt-second'])
  })
})

// A sibling whose name differs only in case from a folder already known is
// compared by real path, and that comparison reads no more than the gate
// would: never a network path, and never longer than the gate's own deadline.
describe('comparing a sibling with the folders already known', () => {
  const UNC_TARGET = '\\\\ccc-gate-test-host.invalid\\share\\wt-resume'

  // Mutation to prove this can fail: ask the disk for the real paths of a
  // network path too (drop the network-path check in sameFolder).
  it('on Windows, a sibling whose name differs only in case from a resume target on a network path: no real path is asked, and the sibling is gated on its own', async () => {
    const looked: string[] = []
    const asked: string[] = []
    const gated: string[] = []
    const twin = UNC_TARGET.toUpperCase()
    const r = await gatePickerSiblingDirs(['C:\\Repo\\Main', UNC_TARGET], [twin],
      async (d) => { gated.push(d); return { status: 'not-scanned', reason: 'network-path' } }, 'win32',
      async (p) => { looked.push(p); return p.toLowerCase() },
      async (d) => { asked.push(d); return true }, answeredClean)
    expect(looked).toEqual([])
    expect(asked).toEqual([])
    expect(gated).toEqual([twin])
    expect(r).toEqual({
      launch: ['C:\\Repo\\Main', UNC_TARGET],
      clean: [],
      leftOut: [{ dir: twin, result: { status: 'not-scanned', reason: 'network-path' } }],
    })
  })

  // Mutation to prove this can fail: ask for the real paths without a time limit.
  it('on Windows, real paths that do not answer within the gate\'s own deadline are not the same folder: the sibling is gated on its own', async () => {
    vi.useFakeTimers()
    try {
      const gated: string[] = []
      let settled = false
      const pending = gatePickerSiblingDirs(['C:\\R\\repo'], ['C:\\R\\REPO'],
        async (d) => { gated.push(d); return { status: 'clean' } }, 'win32',
        () => new Promise<string | null>(() => {}), async () => true, answeredClean)
        .then((r) => { settled = true; return r })
      await vi.advanceTimersByTimeAsync(2000)
      expect(settled).toBe(false)
      // The gate's deadline (3 s).
      await vi.advanceTimersByTimeAsync(2000)
      expect(settled).toBe(true)
      expect(gated).toEqual(['C:\\R\\REPO'])
      expect((await pending).clean).toEqual(['C:\\R\\REPO'])
    } finally {
      vi.useRealTimers()
    }
  })
})
