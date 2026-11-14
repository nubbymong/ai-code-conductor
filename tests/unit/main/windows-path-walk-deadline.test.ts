// A walk of PATH that something waits for (a launch on Windows) keeps PATH's
// order: it names a folder's program only when every folder before it has
// answered. A folder on a share that does not answer can hold one file test
// for tens of seconds, and the walk waits for it; what is bounded is how long
// a caller WAITS for the walk as a whole (windows-programs.ts
// withPathWalkDeadline), never one file test. And a folder has one file test
// outstanding at a time, across every walk (folderFileTest), so a share that
// is down holds one of the few threads file tests share, not one per walk.
//
// Host-safe: every file test is a stand-in answered here. No file of this
// computer is read, nothing is started, and the timers are stand-ins.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  folderFileTest, findOnWindowsPathAsync, withPathWalkDeadline, WINDOWS_PATH_WALK_WAIT_MS, _resetFolderFileTestForTest,
} from '../../../src/main/windows-programs'

const GONE = 'S:\\gone'
const TOOLS = 'C:\\Tools'
const NAMES = ['claude.exe', 'claude.cmd', 'claude.bat']

/** The file tests asked, and how each folder answers. */
const asked: string[] = []
/** Files that are there, lower-cased. */
let present = new Set<string>()
/** Folders whose tests do not answer until released (lower-cased), and the
 *  tests held: `release()` answers them all, as a share coming back would;
 *  `fail()` ends them all as a share that is down ends a file test at last. */
let hung = new Set<string>()
let held: Array<{ answer: () => void; fail: () => void }> = []
const release = (): void => { for (const t of held.splice(0)) t.answer() }
const fail = (): void => { for (const t of held.splice(0)) t.fail() }
/** The stand-in file test. */
const stat = (p: string): Promise<boolean> => {
  asked.push(p)
  const folder = p.slice(0, p.lastIndexOf('\\')).toLowerCase()
  if (!hung.has(folder)) return Promise.resolve(present.has(p.toLowerCase()))
  return new Promise<boolean>((resolve, reject) => {
    held.push({ answer: () => resolve(present.has(p.toLowerCase())), fail: () => reject(new Error('the network path was not found')) })
  })
}
/** Let every promise that has nothing to wait for settle. */
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0) }
/** What a promise has come to by now. */
const state = async <T>(p: Promise<T>): Promise<string> => {
  let s = 'pending'
  p.then((v) => { s = `resolved: ${String(v)}` }, (e: unknown) => { s = `rejected: ${(e as Error).message}` })
  await flush()
  return s
}

beforeEach(() => {
  asked.length = 0
  present = new Set()
  hung = new Set()
  held = []
  _resetFolderFileTestForTest()
  vi.useFakeTimers()
})
afterEach(async () => {
  release()
  await flush()
  vi.useRealTimers()
  _resetFolderFileTestForTest()
})

describe('one file test at a time in a folder (folderFileTest)', () => {
  it('a test that answers gives its own answer, found or not; one that fails, its own reason; and no timer is set', async () => {
    present = new Set([`${TOOLS}\\claude.exe`.toLowerCase()])
    const test = folderFileTest(stat)
    expect(await state(test(`${TOOLS}\\claude.exe`))).toBe('resolved: true')
    expect(await state(test(`${TOOLS}\\claude.cmd`))).toBe('resolved: false')
    expect(await state(folderFileTest(() => Promise.reject(new Error('access denied')))(`${TOOLS}\\claude.exe`))).toBe('rejected: access denied')
    expect(await state(folderFileTest(() => { throw new Error('no such drive') })(`${TOOLS}\\claude.exe`))).toBe('rejected: no such drive')
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: give one file test a time limit of its
  // own (a healthy folder waiting its turn for a thread is then read as one
  // that is down).
  it('never gives a folder up: a test that has not answered is still waited for, however long, and its late answer is the folder\'s answer', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${GONE}\\claude.exe`.toLowerCase()])
    const answer = folderFileTest(stat)(`${GONE}\\claude.exe`)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(await state(answer)).toBe('pending')
    release()
    expect(await state(answer)).toBe('resolved: true')
  })

  // Mutation to prove this can fail: start a test for every walk that asks.
  it('a walk that asks for the same file while its test is outstanding gets that test\'s answer: one test, for any number of walks, in any letter case', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${GONE}\\claude.exe`.toLowerCase()])
    const first = folderFileTest(stat)(`${GONE}\\claude.exe`)
    const second = folderFileTest(stat)(`${GONE.toUpperCase()}\\CLAUDE.EXE`)
    await flush()
    expect(asked).toEqual([`${GONE}\\claude.exe`])
    release()
    expect(await state(first)).toBe('resolved: true')
    expect(await state(second)).toBe('resolved: true')
    expect(asked).toHaveLength(1)
  })

  // Mutation to prove this can fail: start the second test at once (two
  // threads held by one folder that is down).
  it('another file in a folder with a test outstanding is not asked until that test has ended; another folder is asked at once', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${TOOLS}\\node.exe`.toLowerCase(), `${GONE}\\node.exe`.toLowerCase()])
    const test = folderFileTest(stat)
    const claude = test(`${GONE}\\claude.exe`)
    const node = folderFileTest(stat)(`${GONE}\\node.exe`)
    expect(await state(test(`${TOOLS}\\node.exe`))).toBe('resolved: true')
    expect(asked, 'one test in the folder that has not answered').toEqual([`${GONE}\\claude.exe`, `${TOOLS}\\node.exe`])
    expect(await state(node)).toBe('pending')
    // The share is back: the first test ends, and only then is the second made.
    hung = new Set()
    release()
    expect(await state(claude)).toBe('resolved: false')
    expect(await state(node)).toBe('resolved: true')
    expect(asked).toEqual([`${GONE}\\claude.exe`, `${TOOLS}\\node.exe`, `${GONE}\\node.exe`])
  })

  // A file test on a share that is down ends by FAILING. Mutation to prove
  // this can fail: free the folder only when its test ends with an answer
  // (it is then never asked again for the life of the process).
  it('a test that ends by failing, however late, frees the folder: the test that waited behind it gets that answer without being made, and the next one is made', async () => {
    hung = new Set([GONE.toLowerCase()])
    const test = folderFileTest(stat)
    const claude = test(`${GONE}\\claude.exe`)
    const node = test(`${GONE}\\node.exe`)
    void claude.catch(() => {})
    void node.catch(() => {})
    await vi.advanceTimersByTimeAsync(45_000)
    fail()
    expect(await state(claude)).toBe('rejected: the network path was not found')
    expect(await state(node), 'the folder has just said it cannot be reached').toBe('rejected: the network path was not found')
    expect(asked, 'no second test was started there').toEqual([`${GONE}\\claude.exe`])
    // The share is back.
    hung = new Set()
    present = new Set([`${GONE}\\claude.exe`.toLowerCase()])
    expect(await state(test(`${GONE}\\claude.exe`))).toBe('resolved: true')
    expect(asked).toEqual([`${GONE}\\claude.exe`, `${GONE}\\claude.exe`])
  })

  it('tests made with another underlying file test are not joined', async () => {
    hung = new Set([GONE.toLowerCase()])
    void folderFileTest(stat)(`${GONE}\\claude.exe`)
    const other = folderFileTest(() => Promise.resolve(true))
    expect(await state(other(`${GONE}\\claude.exe`))).toBe('resolved: true')
  })
})

describe('the deadline of a wait for a walk (withPathWalkDeadline)', () => {
  it('is twenty seconds', () => {
    expect(WINDOWS_PATH_WALK_WAIT_MS).toBe(20_000)
  })

  it('a walk that ends in time: answered, not overdue, and its timer is cleared', async () => {
    let end = (_v: string): void => {}
    const walk = withPathWalkDeadline(new Promise<string>((r) => { end = r }), 500)
    expect(vi.getTimerCount()).toBe(1)
    end('found')
    expect(await state(walk.answered)).toBe('resolved: true')
    expect(walk.overdue).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutations to prove this can fail: no deadline (the wait never ends);
  // end the walk itself at the deadline, or make up an answer for it.
  it('a walk that has not ended at the deadline: the wait ends then, not before, with no answer; the walk goes on, and its own answer is its answer when it ends', async () => {
    let end = (_v: string): void => {}
    const walk = withPathWalkDeadline(new Promise<string>((r) => { end = r }), 500)
    await vi.advanceTimersByTimeAsync(499)
    expect(await state(walk.answered)).toBe('pending')
    expect(walk.overdue).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await state(walk.answered)).toBe('resolved: false')
    expect(walk.overdue).toBe(true)
    expect(await state(walk.run), 'the walk is not ended by the deadline').toBe('pending')
    end('found at last')
    expect(await state(walk.run)).toBe('resolved: found at last')
    expect(walk.overdue, 'it has answered now').toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a walk that fails has ended: the wait ends, and never rejects', async () => {
    const walk = withPathWalkDeadline(Promise.reject(new Error('the walk failed')), 500)
    void walk.run.catch(() => {})
    expect(await state(walk.answered)).toBe('resolved: true')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the walk of PATH with that file test (findOnWindowsPathAsync)', () => {
  const walk = (pathValue: string, names: readonly string[] = NAMES): Promise<string | null> =>
    findOnWindowsPathAsync(names, { PATH: pathValue }, folderFileTest(stat), 'name')

  // Mutations to prove this can fail: give the folder up after a time and go
  // on to the next (the later folder's program is then named); read a test
  // still outstanding as "not here".
  it('PATH\'s order holds: a folder that has not answered is never passed over, and the later folder is not even asked', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${GONE}\\claude.exe`.toLowerCase(), `${TOOLS}\\claude.exe`.toLowerCase()])
    const found = walk(`${GONE};${TOOLS}`)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(await state(found)).toBe('pending')
    expect(asked, 'the later folder is not asked before the earlier one has answered').toEqual([`${GONE}\\claude.exe`])
    release()
    expect(await state(found), 'the earlier folder\'s program, as a walk in place names it').toBe(`resolved: ${GONE}\\claude.exe`)
    expect(vi.getTimerCount()).toBe(0)
  })

  // The launch's order: claude.exe in any folder before claude.cmd in any.
  it('a slow folder that holds claude.exe is named before a later folder\'s claude.cmd, never the other way round', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${GONE}\\claude.exe`.toLowerCase(), `${TOOLS}\\claude.cmd`.toLowerCase()])
    const found = walk(`${GONE};${TOOLS}`)
    await vi.advanceTimersByTimeAsync(30_000)
    release()
    expect(await state(found)).toBe(`resolved: ${GONE}\\claude.exe`)
  })

  it('a folder that says it cannot be reached is passed, as a walk in place passes it, and is not asked for another name', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${TOOLS}\\claude.cmd`.toLowerCase()])
    const found = walk(`${GONE};${TOOLS}`)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await state(found)).toBe('pending')
    fail()
    expect(await state(found)).toBe(`resolved: ${TOOLS}\\claude.cmd`)
    expect(asked).toEqual([`${GONE}\\claude.exe`, `${TOOLS}\\claude.exe`, `${TOOLS}\\claude.cmd`])
  })

  it('a folder that answers is not waited for: the program is found with no timer at all', async () => {
    present = new Set([`${TOOLS}\\claude.exe`.toLowerCase()])
    expect(await state(walk(`${TOOLS};${GONE}`))).toBe(`resolved: ${TOOLS}\\claude.exe`)
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: one test per walk in a folder.
  it('two walks over one folder that does not answer (for Claude Code and for node.exe) hold one file test there between them', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${TOOLS}\\claude.exe`.toLowerCase(), `${TOOLS}\\node.exe`.toLowerCase()])
    const claude = walk(`${GONE};${TOOLS}`)
    const node = walk(`${GONE};${TOOLS}`, ['node.exe'])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(asked.filter((p) => p.startsWith(GONE))).toEqual([`${GONE}\\claude.exe`])
    fail()
    expect(await state(claude)).toBe(`resolved: ${TOOLS}\\claude.exe`)
    expect(await state(node)).toBe(`resolved: ${TOOLS}\\node.exe`)
    expect(asked.filter((p) => p.startsWith(GONE)), 'the folder was asked once in all').toEqual([`${GONE}\\claude.exe`])
  })
})
