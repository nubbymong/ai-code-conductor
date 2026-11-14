// A walk of PATH that something waits for (a launch on Windows) keeps PATH's
// order: it names a folder's program only when every folder before it has
// answered. A folder on a share that does not answer can hold one file test
// for tens of seconds, and the walk waits for it; what is bounded is how long
// a caller WAITS for the walk as a whole (windows-programs.ts
// withPathWalkDeadline), never one file test. And a folder has one file test
// outstanding at a time, across every walk (folderFileTest), so a share that
// is down holds one of the few threads file tests share, not one per walk.
//
// What one walk's test hands to another's: its answer for the same file,
// always; for another file only a failure that says the folder itself cannot
// be reached (the network, the host, a timeout). A failure that may be about
// the one file (access denied, in use) is not handed on: the walk that
// waited makes its own test, so it never passes a folder that holds its
// program. And a walk waits behind another walk's test until its own
// deadline, no longer: then it asks the folder itself, at most two tests
// outstanding there.
//
// Host-safe: every file test is a stand-in answered here. No file of this
// computer is read, nothing is started, and the timers are stand-ins.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  folderFileTest, findOnWindowsPathAsync, pathWalkDeadline, withPathWalkDeadline, WINDOWS_PATH_WALK_WAIT_MS, _resetFolderFileTestForTest,
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
 *  `fail()` ends them all as a share that is down ends a file test at last
 *  (the host did not answer in time), or with the error code given (null:
 *  an error with no code). */
let hung = new Set<string>()
let held: Array<{ answer: () => void; fail: (code: string | null) => void }> = []
const release = (): void => { for (const t of held.splice(0)) t.answer() }
const fail = (code: string | null = 'ETIMEDOUT'): void => { for (const t of held.splice(0)) t.fail(code) }
/** The reasons that say a folder cannot be reached, whatever file was asked for. */
const FOLDER_DOWN = ['ETIMEDOUT', 'ENETDOWN', 'ENETUNREACH', 'ENONET', 'EHOSTDOWN', 'EHOSTUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTCONN']
/** Reasons that may be about the one file asked for (null: no code at all). */
const ONE_FILE = ['EPERM', 'EACCES', 'EBUSY', 'ELOOP', 'EINVAL', 'EIO', 'UNKNOWN', 'ENOENT', null]
/** The stand-in file test. */
const stat = (p: string): Promise<boolean> => {
  asked.push(p)
  const folder = p.slice(0, p.lastIndexOf('\\')).toLowerCase()
  if (!hung.has(folder)) return Promise.resolve(present.has(p.toLowerCase()))
  return new Promise<boolean>((resolve, reject) => {
    held.push({
      answer: () => resolve(present.has(p.toLowerCase())),
      fail: (code) => reject(Object.assign(new Error('the file test failed'), code === null ? {} : { code })),
    })
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
  it('a test that ends by failing because the folder cannot be reached, however late, frees the folder: the test that waited behind it gets that answer without being made, and the next one is made', async () => {
    hung = new Set([GONE.toLowerCase()])
    const test = folderFileTest(stat)
    const claude = test(`${GONE}\\claude.exe`)
    const node = test(`${GONE}\\node.exe`)
    void claude.catch(() => {})
    void node.catch(() => {})
    await vi.advanceTimersByTimeAsync(45_000)
    fail()
    expect(await state(claude)).toBe('rejected: the file test failed')
    expect(await state(node), 'the folder has just said it cannot be reached').toBe('rejected: the file test failed')
    expect(asked, 'no second test was started there').toEqual([`${GONE}\\claude.exe`])
    // The share is back.
    hung = new Set()
    present = new Set([`${GONE}\\claude.exe`.toLowerCase()])
    expect(await state(test(`${GONE}\\claude.exe`))).toBe('resolved: true')
    expect(asked).toEqual([`${GONE}\\claude.exe`, `${GONE}\\claude.exe`])
  })

  // Mutation to prove this can fail: hand on only some of these reasons (a
  // share that is down then costs one more wait for each file asked there).
  it.each(FOLDER_DOWN)('a failure that says the folder cannot be reached (%s) is the answer for another file that waited there too: that test is not made', async (code) => {
    hung = new Set([GONE.toLowerCase()])
    const claude = folderFileTest(stat)(`${GONE}\\claude.exe`)
    const node = folderFileTest(stat)(`${GONE}\\node.exe`)
    void claude.catch(() => {})
    void node.catch(() => {})
    await flush()
    fail(code)
    expect(await state(claude)).toBe('rejected: the file test failed')
    expect(await state(node)).toBe('rejected: the file test failed')
    expect(asked).toEqual([`${GONE}\\claude.exe`])
  })

  // The folder answers; one file in it cannot be read (access denied on it,
  // a file in use, a broken link). Mutation to prove this can fail: hand any
  // failure on to the test that waited (it then never asks for its own file,
  // and its walk passes a folder that holds its program).
  it.each(ONE_FILE)('a failure that may be about the one file (%s) says nothing about another file: the test that waited is made, and gives its own answer', async (code) => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${GONE}\\claude.exe`.toLowerCase()])
    const node = folderFileTest(stat)(`${GONE}\\node.exe`)
    const claude = folderFileTest(stat)(`${GONE}\\claude.exe`)
    void node.catch(() => {})
    await flush()
    expect(asked, 'one test at a time').toEqual([`${GONE}\\node.exe`])
    hung = new Set()
    fail(code)
    expect(await state(node), 'its own failure is its own answer').toBe('rejected: the file test failed')
    expect(await state(claude)).toBe('resolved: true')
    expect(asked).toEqual([`${GONE}\\node.exe`, `${GONE}\\claude.exe`])
  })

  it('a walk that asked for the same file takes that test\'s failure, whatever it is: its own test would have failed the same way, and it is not made', async () => {
    hung = new Set([GONE.toLowerCase()])
    const first = folderFileTest(stat)(`${GONE}\\claude.exe`)
    const second = folderFileTest(stat)(`${GONE}\\claude.exe`)
    void first.catch(() => {})
    void second.catch(() => {})
    await flush()
    fail('EPERM')
    expect(await state(first)).toBe('rejected: the file test failed')
    expect(await state(second)).toBe('rejected: the file test failed')
    expect(asked).toEqual([`${GONE}\\claude.exe`])
  })

  // Mutation to prove this can fail: start every test that waited at once
  // when the one before it failed.
  it('after a failure about one file, the tests that waited are still made one at a time', async () => {
    hung = new Set([GONE.toLowerCase()])
    const node = folderFileTest(stat)(`${GONE}\\node.exe`)
    const exe = folderFileTest(stat)(`${GONE}\\claude.exe`)
    const cmd = folderFileTest(stat)(`${GONE}\\claude.cmd`)
    void node.catch(() => {})
    await flush()
    fail('EACCES')
    await flush()
    expect(asked, 'the first that waited is made; the second waits for it').toEqual([`${GONE}\\node.exe`, `${GONE}\\claude.exe`])
    expect(await state(cmd)).toBe('pending')
    release()
    expect(await state(exe)).toBe('resolved: false')
    await flush()
    expect(asked).toEqual([`${GONE}\\node.exe`, `${GONE}\\claude.exe`, `${GONE}\\claude.cmd`])
    release()
    expect(await state(cmd)).toBe('resolved: false')
  })

  it('tests made with another underlying file test are not joined', async () => {
    hung = new Set([GONE.toLowerCase()])
    void folderFileTest(stat)(`${GONE}\\claude.exe`)
    const other = folderFileTest(() => Promise.resolve(true))
    expect(await state(other(`${GONE}\\claude.exe`))).toBe('resolved: true')
  })
})

// A file test begun while a share was down can stay outstanding long after
// the share is back. A walk that began later waits behind it until its own
// deadline, and then asks the folder itself: it is not held for as long as
// the old test takes, and the folder is not passed over.
describe('a walk waits behind another walk\'s file test until its own deadline, and no longer (folderFileTest with the walk\'s deadline)', () => {
  // Mutations to prove this can fail: wait behind the other walk's test
  // however long it takes; make the walk's own test before its deadline.
  it('the same file: not before the deadline; then the walk makes its own test of the folder, beside the one outstanding, and that test\'s answer is its answer', async () => {
    hung = new Set([GONE.toLowerCase()])
    const old = folderFileTest(stat)(`${GONE}\\claude.exe`)
    await vi.advanceTimersByTimeAsync(60_000)
    // The share is back: a test made now answers. The old one is still outstanding.
    hung = new Set()
    present = new Set([`${GONE}\\claude.exe`.toLowerCase()])
    const deadline = pathWalkDeadline(500)
    const mine = folderFileTest(stat, deadline)(`${GONE}\\claude.exe`)
    await vi.advanceTimersByTimeAsync(499)
    expect(await state(mine), 'not before its deadline').toBe('pending')
    expect(asked, 'no second test before the deadline').toEqual([`${GONE}\\claude.exe`])
    await vi.advanceTimersByTimeAsync(1)
    expect(await state(mine)).toBe('resolved: true')
    expect(asked, 'the folder was asked again, not passed over').toEqual([`${GONE}\\claude.exe`, `${GONE}\\claude.exe`])
    expect(await state(old), 'the old test is not ended by it').toBe('pending')
    deadline.clear()
  })

  it('another file: the same, and a failure of the walk\'s own test is its own answer', async () => {
    hung = new Set([GONE.toLowerCase()])
    void folderFileTest(stat)(`${GONE}\\claude.exe`)
    await flush()
    const deadline = pathWalkDeadline(500)
    const node = folderFileTest(stat, deadline)(`${GONE}\\node.exe`)
    void node.catch(() => {})
    await vi.advanceTimersByTimeAsync(499)
    expect(asked).toEqual([`${GONE}\\claude.exe`])
    await vi.advanceTimersByTimeAsync(1)
    expect(asked).toEqual([`${GONE}\\claude.exe`, `${GONE}\\node.exe`])
    expect(await state(node), 'the share is still down: its own test has not answered either').toBe('pending')
    // Only the walk's own test ends, by failing.
    held.splice(1, 1)[0].fail('ETIMEDOUT')
    expect(await state(node)).toBe('rejected: the file test failed')
    deadline.clear()
  })

  // Mutation to prove this can fail: no limit on the tests outstanding in a
  // folder (every walk past its deadline then holds one more thread there).
  it('at most two tests are outstanding in a folder: a third walk past its deadline waits for the one begun last, and is made when that has ended', async () => {
    hung = new Set([GONE.toLowerCase()])
    void folderFileTest(stat)(`${GONE}\\claude.exe`)
    const second = pathWalkDeadline(500)
    const node = folderFileTest(stat, second)(`${GONE}\\node.exe`)
    const third = pathWalkDeadline(500)
    const cmd = folderFileTest(stat, third)(`${GONE}\\claude.cmd`)
    await vi.advanceTimersByTimeAsync(500)
    expect(asked, 'the second walk made its own test; the third did not').toEqual([`${GONE}\\claude.exe`, `${GONE}\\node.exe`])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(asked, 'however long').toEqual([`${GONE}\\claude.exe`, `${GONE}\\node.exe`])
    expect(await state(cmd)).toBe('pending')
    // The test begun last ends (no node.exe there): the third walk's is made now.
    held.splice(1, 1)[0].answer()
    expect(await state(node)).toBe('resolved: false')
    expect(asked).toEqual([`${GONE}\\claude.exe`, `${GONE}\\node.exe`, `${GONE}\\claude.cmd`])
    second.clear()
    third.clear()
  })

  it('a walk already past its deadline does not wait behind another walk\'s test: it makes its own at once', async () => {
    hung = new Set([GONE.toLowerCase()])
    void folderFileTest(stat)(`${GONE}\\claude.exe`)
    const deadline = pathWalkDeadline(500)
    const test = folderFileTest(stat, deadline)
    await vi.advanceTimersByTimeAsync(500)
    expect(deadline.passed).toBe(true)
    void test(`${GONE}\\node.exe`)
    await flush()
    expect(asked).toEqual([`${GONE}\\claude.exe`, `${GONE}\\node.exe`])
  })

  // Mutation to prove this can fail: make the walk's own test at the
  // deadline whether or not the test it waited for has ended.
  it('a test that ends before the deadline is waited for as before: its answer is taken, nothing more is asked at the deadline, and nothing is left with the deadline', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${GONE}\\claude.exe`.toLowerCase()])
    void folderFileTest(stat)(`${GONE}\\claude.exe`)
    const deadline = pathWalkDeadline(500)
    const test = folderFileTest(stat, deadline)
    const same = test(`${GONE}\\claude.exe`)
    await vi.advanceTimersByTimeAsync(100)
    hung = new Set()
    release()
    expect(await state(same)).toBe('resolved: true')
    expect(await state(test(`${GONE}\\node.exe`))).toBe('resolved: false')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(asked).toEqual([`${GONE}\\claude.exe`, `${GONE}\\node.exe`])
  })

  it('a walk\'s own test is waited for however long: the deadline starts no second test for the walk that made it', async () => {
    hung = new Set([GONE.toLowerCase()])
    const deadline = pathWalkDeadline(500)
    const mine = folderFileTest(stat, deadline)(`${GONE}\\claude.exe`)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(await state(mine)).toBe('pending')
    expect(asked).toEqual([`${GONE}\\claude.exe`])
  })
})

describe('the deadline of one walk (pathWalkDeadline)', () => {
  it('passes once, when its time is up: what waits for it is run then, once, and not what was withdrawn', async () => {
    const deadline = pathWalkDeadline(500)
    const ran: string[] = []
    deadline.onPassed(() => ran.push('first'))
    const withdraw = deadline.onPassed(() => ran.push('withdrawn'))
    deadline.onPassed(() => ran.push('second'))
    withdraw()
    await vi.advanceTimersByTimeAsync(499)
    expect(deadline.passed).toBe(false)
    expect(ran).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(deadline.passed).toBe(true)
    expect(ran).toEqual(['first', 'second'])
    // Asked for after it has passed: not run (the caller reads `passed`).
    deadline.onPassed(() => ran.push('late'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ran).toEqual(['first', 'second'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleared (the walk ended): its timer is dropped, it never passes, and nothing that waited for it runs', async () => {
    const deadline = pathWalkDeadline(500)
    let ran = false
    deadline.onPassed(() => { ran = true })
    expect(vi.getTimerCount()).toBe(1)
    deadline.clear()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deadline.passed).toBe(false)
    expect(ran).toBe(false)
  })

  it('is twenty seconds when no time is given', async () => {
    const deadline = pathWalkDeadline()
    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS - 1)
    expect(deadline.passed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(deadline.passed).toBe(true)
  })

  // One timer for the walk: its file tests and whoever waits for it read the same deadline.
  it('given to the wait for a walk (withPathWalkDeadline): one timer for both, overdue when it passes, and dropped when the walk ends', async () => {
    let end = (_v: string): void => {}
    const deadline = pathWalkDeadline(500)
    const walk = withPathWalkDeadline(new Promise<string>((r) => { end = r }), deadline)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(walk.overdue).toBe(true)
    expect(await state(walk.answered)).toBe('resolved: false')
    end('found at last')
    expect(await state(walk.run)).toBe('resolved: found at last')
    expect(walk.overdue).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
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

  // PATH's order, with two walks in one folder (the look for node.exe and
  // the walk for Claude Code, in the CLI check's order). The folder answers;
  // node.exe in it cannot be read. Mutation to prove this can fail: hand the
  // failure of the node.exe test to the walk for Claude Code (it then passes
  // the folder and names the later folder's Claude Code).
  it.each(['EPERM', 'EACCES', 'ENOENT'])('a file test that fails for one file only (%s) does not make another walk pass the folder: its program is found there, ahead of a later folder\'s', async (code) => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${GONE}\\claude.exe`.toLowerCase(), `${TOOLS}\\claude.exe`.toLowerCase(), `${TOOLS}\\node.exe`.toLowerCase()])
    const node = walk(`${GONE};${TOOLS}`, ['node.exe'])
    const claude = walk(`${GONE};${TOOLS}`)
    await flush()
    expect(asked).toEqual([`${GONE}\\node.exe`])
    hung = new Set()
    fail(code)
    // The look whose own test failed passes the folder, as a walk in place does.
    expect(await state(node)).toBe(`resolved: ${TOOLS}\\node.exe`)
    // The other walk asks the folder for its own file, and finds it there.
    expect(await state(claude), 'what a walk in place names').toBe(`resolved: ${GONE}\\claude.exe`)
    expect(asked.filter((p) => p.endsWith('claude.exe'))).toEqual([`${GONE}\\claude.exe`])
  })

  // The mirror: the claude.exe test fails for that file alone, and the look for node.exe waited.
  it('the other way round: claude.exe cannot be read, and the look for node.exe still finds the node.exe of that folder', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${GONE}\\node.exe`.toLowerCase(), `${TOOLS}\\claude.exe`.toLowerCase(), `${TOOLS}\\node.exe`.toLowerCase()])
    const claude = walk(`${GONE};${TOOLS}`)
    const node = walk(`${GONE};${TOOLS}`, ['node.exe'])
    await flush()
    expect(asked).toEqual([`${GONE}\\claude.exe`])
    hung = new Set()
    fail('EBUSY')
    expect(await state(claude)).toBe(`resolved: ${TOOLS}\\claude.exe`)
    expect(await state(node)).toBe(`resolved: ${GONE}\\node.exe`)
  })

  // Mutations to prove this can fail: wait behind the old test however long
  // it takes; pass the folder over at the deadline.
  it('a walk that began after another walk\'s test of a folder waits for it until its own deadline, then asks the folder itself: never the later folder before that one has answered', async () => {
    hung = new Set([GONE.toLowerCase()])
    // An earlier walk's test, begun while the share was down, that does not end.
    void folderFileTest(stat)(`${GONE}\\claude.exe`)
    await vi.advanceTimersByTimeAsync(60_000)
    present = new Set([`${TOOLS}\\claude.exe`.toLowerCase()])
    const deadline = pathWalkDeadline()
    const found = findOnWindowsPathAsync(NAMES, { PATH: `${GONE};${TOOLS}` }, folderFileTest(stat, deadline), 'name')
    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS - 1)
    expect(await state(found)).toBe('pending')
    expect(asked, 'the later folder is not asked').toEqual([`${GONE}\\claude.exe`])
    await vi.advanceTimersByTimeAsync(1)
    expect(asked, 'the folder is asked by this walk itself').toEqual([`${GONE}\\claude.exe`, `${GONE}\\claude.exe`])
    expect(await state(found), 'still not passed over: its own test has not answered').toBe('pending')
    // The share is back: the walk's own test answers (no Claude Code there), and the walk goes on.
    hung = new Set()
    held.splice(1, 1)[0].answer()
    expect(await state(found)).toBe(`resolved: ${TOOLS}\\claude.exe`)
    deadline.clear()
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
