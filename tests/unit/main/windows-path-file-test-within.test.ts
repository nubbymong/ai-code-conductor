// A walk of PATH that something waits for (a launch on Windows) gives each
// folder a bounded time to answer a file test (windows-programs.ts
// fileTestWithin). A folder on a share that does not answer can hold one test
// for tens of seconds; past the bound it counts as holding no such program,
// and the walk goes on to the next folder. Never a guess.
//
// Host-safe: every file test is a stand-in answered here. No file of this
// computer is read, nothing is started, and the timers are stand-ins.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fileTestWithin, findOnWindowsPathAsync, WINDOWS_PATH_FILE_TEST_WAIT_MS, _resetFileTestWithinForTest,
} from '../../../src/main/windows-programs'

const GONE = 'S:\\gone'
const TOOLS = 'C:\\Tools'
const NAMES = ['claude.exe', 'claude.cmd', 'claude.bat']

/** The file tests asked, and how each folder answers. */
const asked: string[] = []
/** Files that are there, lower-cased. */
let present = new Set<string>()
/** Folders whose tests do not answer until released (lower-cased), and the
 *  tests held: `release()` answers them all, as a share coming back would. */
let hung = new Set<string>()
let held: Array<() => void> = []
const release = (): void => { for (const answer of held.splice(0)) answer() }
/** The stand-in file test. */
const stat = (p: string): Promise<boolean> => {
  asked.push(p)
  const folder = p.slice(0, p.lastIndexOf('\\')).toLowerCase()
  if (!hung.has(folder)) return Promise.resolve(present.has(p.toLowerCase()))
  return new Promise<boolean>((resolve) => { held.push(() => resolve(present.has(p.toLowerCase()))) })
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
  _resetFileTestWithinForTest()
  vi.useFakeTimers()
})
afterEach(() => {
  release()
  vi.useRealTimers()
  _resetFileTestWithinForTest()
})

describe('a file test with a bound (fileTestWithin)', () => {
  it('the bound a launch gives one folder is two seconds', () => {
    expect(WINDOWS_PATH_FILE_TEST_WAIT_MS).toBe(2000)
  })

  it('a test that answers in time gives its own answer, found or not, and leaves no timer', async () => {
    present = new Set([`${TOOLS}\\claude.exe`.toLowerCase()])
    const test = fileTestWithin(500, stat)
    expect(await state(test(`${TOOLS}\\claude.exe`))).toBe('resolved: true')
    expect(await state(test(`${TOOLS}\\claude.cmd`))).toBe('resolved: false')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a test that fails in time fails with its own reason, and leaves no timer', async () => {
    const test = fileTestWithin(500, () => Promise.reject(new Error('access denied')))
    expect(await state(test(`${TOOLS}\\claude.exe`))).toBe('rejected: access denied')
    const throws = fileTestWithin(500, () => { throw new Error('no such drive') })
    expect(await state(throws(`${TOOLS}\\claude.exe`))).toBe('rejected: no such drive')
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutations to prove this can fail: wait without a bound; settle the wait
  // as "not there" (false) instead of rejecting.
  it('a test that does not answer is given up at the bound, not before, as a folder that cannot be reached', async () => {
    hung = new Set([GONE.toLowerCase()])
    const answer = fileTestWithin(500, stat)(`${GONE}\\claude.exe`)
    await vi.advanceTimersByTimeAsync(499)
    expect(await state(answer)).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(await state(answer)).toBe('rejected: the folder did not answer a file test within 500 ms')
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: take the answer whenever it comes.
  it('an answer that comes after the bound is not used: found there is still not found', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${GONE}\\claude.exe`.toLowerCase()])
    const answer = fileTestWithin(500, stat)(`${GONE}\\claude.exe`)
    void answer.catch(() => {})
    await vi.advanceTimersByTimeAsync(500)
    release()
    expect(await state(answer)).toBe('rejected: the folder did not answer a file test within 500 ms')
  })

  // Mutation to prove this can fail: ask a folder again while its test is
  // still held (each launch would then hold one more file test).
  it('while its test is still unanswered the folder is not asked again, by this test or another, for any name; other folders are', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${TOOLS}\\node.exe`.toLowerCase()])
    const first = fileTestWithin(500, stat)
    void first(`${GONE}\\claude.exe`).catch(() => {})
    await vi.advanceTimersByTimeAsync(500)
    expect(asked).toEqual([`${GONE}\\claude.exe`])
    // The same test, another name; and another test (another walk), in other letters.
    expect(await state(first(`${GONE}\\claude.cmd`))).toBe('rejected: the folder has not answered an earlier file test')
    expect(await state(fileTestWithin(500, stat)(`${GONE.toUpperCase()}\\node.exe`))).toBe('rejected: the folder has not answered an earlier file test')
    expect(asked, 'no further test was started there').toEqual([`${GONE}\\claude.exe`])
    expect(await state(fileTestWithin(500, stat)(`${TOOLS}\\node.exe`))).toBe('resolved: true')
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: never forget a folder that did not answer.
  it('once the test left unanswered has ended, the folder is asked again', async () => {
    hung = new Set([GONE.toLowerCase()])
    const test = fileTestWithin(500, stat)
    void test(`${GONE}\\claude.exe`).catch(() => {})
    await vi.advanceTimersByTimeAsync(500)
    // The share is back: the old test ends, and the folder answers from now on.
    hung = new Set()
    present = new Set([`${GONE}\\claude.exe`.toLowerCase()])
    release()
    await flush()
    expect(await state(test(`${GONE}\\claude.exe`))).toBe('resolved: true')
    expect(asked).toEqual([`${GONE}\\claude.exe`, `${GONE}\\claude.exe`])
  })

  it('two tests left unanswered in one folder: it is asked again only when both have ended', async () => {
    hung = new Set([GONE.toLowerCase()])
    const answers: Array<() => void> = []
    const slow = (): Promise<boolean> => new Promise<boolean>((resolve) => { answers.push(() => resolve(false)) })
    const test = fileTestWithin(500, slow)
    // Two walks ask the folder at the same moment, before either has waited.
    void test(`${GONE}\\claude.exe`).catch(() => {})
    void test(`${GONE}\\node.exe`).catch(() => {})
    await vi.advanceTimersByTimeAsync(500)
    answers[0]()
    await flush()
    expect(await state(test(`${GONE}\\claude.cmd`))).toBe('rejected: the folder has not answered an earlier file test')
    answers[1]()
    await flush()
    void test(`${GONE}\\claude.cmd`).catch(() => {})
    await flush()
    expect(answers, 'asked again').toHaveLength(3)
  })
})

describe('the walk of PATH with that file test (findOnWindowsPathAsync)', () => {
  const walk = (pathValue: string, waitMs = 500): Promise<string | null> =>
    findOnWindowsPathAsync(NAMES, { PATH: pathValue }, fileTestWithin(waitMs, stat), 'name')

  // Mutations to prove this can fail: no bound on the test (the walk never
  // ends); answer the program's bare name when a folder gave no answer.
  it('a folder that does not answer costs one bound, once, and the program in the next folder is found by its full path', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${TOOLS}\\claude.cmd`.toLowerCase()])
    const found = walk(`${GONE};${TOOLS}`)
    await vi.advanceTimersByTimeAsync(499)
    expect(await state(found)).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(await state(found)).toBe(`resolved: ${TOOLS}\\claude.cmd`)
    // The folder that did not answer was asked for one name only: the walk
    // did not wait for it again for claude.cmd and claude.bat.
    expect(asked.filter((p) => p.startsWith(GONE))).toEqual([`${GONE}\\claude.exe`])
    expect(asked).toEqual([`${GONE}\\claude.exe`, `${TOOLS}\\claude.exe`, `${TOOLS}\\claude.cmd`])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a folder that answers is not waited for: the program is found with no bound passing', async () => {
    present = new Set([`${TOOLS}\\claude.exe`.toLowerCase()])
    expect(await state(walk(`${TOOLS};${GONE}`))).toBe(`resolved: ${TOOLS}\\claude.exe`)
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: read a folder that did not answer as
  // one that holds the program.
  it('with the program only in the folder that does not answer, the walk finds none: null, never a name', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${GONE}\\claude.exe`.toLowerCase()])
    const found = walk(`${GONE};${TOOLS}`)
    await vi.advanceTimersByTimeAsync(500)
    expect(await state(found)).toBe('resolved: null')
  })

  it('several folders that do not answer cost one bound each, and no more', async () => {
    const also = 'T:\\also-gone'
    hung = new Set([GONE.toLowerCase(), also.toLowerCase()])
    present = new Set([`${TOOLS}\\claude.bat`.toLowerCase()])
    const found = walk(`${GONE};${also};${TOOLS}`)
    await vi.advanceTimersByTimeAsync(999)
    expect(await state(found)).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(await state(found)).toBe(`resolved: ${TOOLS}\\claude.bat`)
  })

  it('a walk made while the folder\'s earlier test is still held does not wait for that folder at all', async () => {
    hung = new Set([GONE.toLowerCase()])
    present = new Set([`${TOOLS}\\claude.cmd`.toLowerCase()])
    const first = walk(`${GONE};${TOOLS}`)
    await vi.advanceTimersByTimeAsync(500)
    expect(await state(first)).toBe(`resolved: ${TOOLS}\\claude.cmd`)
    asked.length = 0
    // The next launch's walk: no bound passes.
    expect(await state(walk(`${GONE};${TOOLS}`))).toBe(`resolved: ${TOOLS}\\claude.cmd`)
    expect(asked.filter((p) => p.startsWith(GONE)), 'the folder was not asked again').toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
