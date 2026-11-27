// With no owner-only rule on (macOS and Linux; this file loads the module as
// on Linux), the start's profile steps still run after the start call has
// returned, never inside it: a caller that asks at once sees them pending,
// and a step that throws at once settles the wait only after the call has
// returned. So it was while the start awaited checkEveryProfileCredentialFolders;
// the ready-home order change once ran them inside the call there, and the
// owner-only credentials suite's pending test went red on Linux (CI run
// 46044250727).
//
// Mutation to prove this can fail: in startOwnerOnlyCredentialFolders, run
// the checks only when a rule is on, so nothing is awaited before the steps
// without one (`const active = credentialFolderRule(); if (active) readyAfterSteps
// = await checkFoldersBeforeSteps()`).
import { describe, it, expect, vi } from 'vitest'

function fakeChildProcess(real: Record<string, unknown>) {
  const execFileSync = vi.fn((file: string) => { throw new Error(`no process in this test: ${file}`) })
  const execFile = vi.fn((file: string, _a: unknown, _o: unknown, cb: (e: Error | null, o: string, eo: string) => void) => { cb(new Error(`no process in this test: ${file}`), '', '') })
  return { ...real, execFileSync, execFile, default: { ...real, execFileSync, execFile } }
}
vi.mock('node:child_process', async (importOriginal) => fakeChildProcess(await importOriginal()))
vi.mock('child_process', async (importOriginal) => fakeChildProcess(await importOriginal()))

// The module reads the platform once, when it loads.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
const ap = await import('../../../src/main/account-profiles')
Object.defineProperty(process, 'platform', realPlatform)

describe('with no owner-only rule on, the start\'s profile steps run after the start call has returned', () => {
  it('steps that run at once: pending, and not run, when the call returns; run, and not pending, once it settles', async () => {
    let ran = false
    const start = ap.startOwnerOnlyCredentialFolders(() => { ran = true })
    expect(ran).toBe(false)
    expect(ap.startProfileStepsPending()).toBe(true)
    await start
    expect(ran).toBe(true)
    expect(ap.startProfileStepsPending()).toBe(false)
  })

  it('a step that throws at once: still pending when the call returns, then the start rejects and the wait settles', async () => {
    const failing = ap.startOwnerOnlyCredentialFolders(() => { throw new Error('a step failed') })
    expect(ap.startProfileStepsPending()).toBe(true)
    const waiter = ap.startProfileStepsSettled()
    await expect(failing).rejects.toThrow('a step failed')
    await expect(waiter).resolves.toBeUndefined()
    expect(ap.startProfileStepsPending()).toBe(false)
  })
})
