// [host] WP2 PR 4 (ADR-009 delta, review L3): on Windows the Codex executable
// discovery proves, and the one the pre-use check accepts, is never at a path
// with a folder or file name ending in a dot or a space. Node reads such a
// name as it is spelled, while Windows' own path handling, which starts the
// program, drops the dot or space and reaches another file, so the proof
// would be of a different file from the one that runs. The resources folder
// follows the same rule (realm-folders.ts). Ports only: no file is read and
// no process is started.
import { describe, it, expect } from 'vitest'
import { discoverCodex, verifyCodexExecutable, windowsPathHasTrailingDotOrSpace } from '../../../../src/main/providers/codex/discovery'
import type { CodexDiscoveryDeps, CodexExecutableIdentity } from '../../../../src/main/providers/codex/discovery'

function deps(canonical: string, platform: NodeJS.Platform = 'win32') {
  const runs: unknown[] = []
  const d: CodexDiscoveryDeps = {
    resolve: () => 'C:\\npm\\codex.exe',
    realpath: () => canonical,
    stat: () => ({ size: 100, mtimeMs: 5, ctimeMs: 6, dev: '1', ino: '2', isFile: true }),
    run: async (cmd) => { runs.push(cmd); return { exitCode: 0, stdout: 'codex-cli 0.155.1\n', stderr: '', timedOut: false, truncated: false } },
    env: { PATH: 'C:\\npm', SystemRoot: 'C:\\Windows' },
    platform,
    versionHome: () => ({ home: 'C:\\tmp\\ccc-codex-version-0', dispose: () => {} }),
    now: () => 1,
  }
  return { d, runs }
}
const recorded = (p: string): CodexExecutableIdentity => ({ path: p, size: 100, mtimeMs: 5, ctimeMs: 6, dev: '1', ino: '2' })

describe('a Windows path Node and Windows read differently', () => {
  it.each([
    ['a folder ending in a dot', 'C:\\T.\\codex.exe'],
    ['a folder ending in a space', 'C:\\tools \\codex.exe'],
    ['a file ending in a dot', 'C:\\npm\\codex.exe.'],
    ['a share path with such a folder', '\\\\server\\share\\T.\\codex.exe'],
  ])('[host] discovery refuses it and runs nothing: %s', async (_name, canonical) => {
    const { d, runs } = deps(canonical)
    const out = await discoverCodex(d)
    expect(out.state).toBe('invalid')
    expect(out).not.toHaveProperty('version')
    expect(runs).toEqual([])
  })

  it.each([
    ['a folder ending in a dot', 'C:\\T.\\codex.exe'],
    ['a file ending in a dot', 'C:\\npm\\codex.exe.'],
  ])('[host] the pre-use check refuses it, even when it is the path recorded: %s', async (_name, canonical) => {
    const { d } = deps(canonical)
    const check = await verifyCodexExecutable(recorded(canonical), d)
    expect(check.ok).toBe(false)
  })

  it('[host] a plain path is proved and accepted as before', async () => {
    const { d, runs } = deps('C:\\npm\\codex.exe')
    expect(await discoverCodex(d)).toMatchObject({ state: 'found', executable: 'C:\\npm\\codex.exe', version: '0.155.1' })
    expect(runs).toHaveLength(1)
    expect(await verifyCodexExecutable(recorded('C:\\npm\\codex.exe'), d)).toEqual({ ok: true, executable: 'C:\\npm\\codex.exe' })
  })

  it('[host] off Windows such a name is an ordinary name: unchanged', async () => {
    const { d } = deps('/opt/T./codex', 'linux')
    expect(await verifyCodexExecutable(recorded('/opt/T./codex'), d)).toEqual({ ok: true, executable: '/opt/T./codex' })
  })

  it.each([
    ['C:\\T.\\codex.exe', true],
    ['C:\\a \\b', true],
    ['C:\\a\\.\\b', true],
    ['C:\\a\\..\\b', true],
    ['C:\\npm\\codex.exe.', true],
    ['C:\\npm\\codex.cmd', false],
    ['C:\\Program Files\\codex', false],
    ['C:\\npm\\', false],
    ['\\\\server\\share\\npm\\codex.exe', false],
  ])('[host] the rule: %s -> %s', (p, want) => {
    expect(windowsPathHasTrailingDotOrSpace(p)).toBe(want)
  })
})

// The check itself (discoverCodex) and the pre-use check
// (verifyCodexExecutable) ask the lookup made off the main thread when they
// are given one, and wait for it: a PATH folder that does not answer, or a
// slow login shell, then holds the check and not the main process. The
// pre-use check reads the file straight after the lookup has answered.
describe('the check asks the lookup made off the main thread', () => {
  it('[host] discovery waits for it, and does not ask the lookup in place as well', async () => {
    const { d, runs } = deps('C:\\npm\\codex.exe')
    const asked: string[] = []
    let answer: (found: string | null) => void = () => {}
    d.resolve = () => { asked.push('in place'); return 'C:\\elsewhere\\codex.exe' }
    d.lookUp = () => { asked.push('off the main thread'); return new Promise((resolve) => { answer = resolve }) }
    let done = false
    const out = discoverCodex(d).finally(() => { done = true })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    // Nothing is proved, and nothing runs, until the lookup has answered.
    expect(done).toBe(false)
    expect(runs).toEqual([])
    answer('C:\\npm\\codex.exe')
    expect(await out).toMatchObject({ state: 'found', executable: 'C:\\npm\\codex.exe' })
    expect(asked).toEqual(['off the main thread'])
  })

  it.each([
    ['it finds none', async () => null],
    ['it fails', async () => { throw new Error('the lookup failed') }],
    ['it answers something that is not a path', async () => ({ cmd: 'C:\\npm\\codex.exe' }) as unknown as string],
  ])('[host] %s: the CLI is not found, and nothing runs', async (_what, lookUp) => {
    const { d, runs } = deps('C:\\npm\\codex.exe')
    d.lookUp = lookUp
    expect(await discoverCodex(d)).toMatchObject({ state: 'missing' })
    expect(runs).toEqual([])
  })

  // Mutation to prove this can fail: ask the lookup in place in the pre-use check.
  it('[host] the pre-use check waits for it too, does not ask the lookup in place as well, and reads the file only once it has answered', async () => {
    const { d } = deps('C:\\npm\\codex.exe')
    const asked: string[] = []
    let answer: (found: string | null) => void = () => {}
    d.resolve = () => { asked.push('in place'); return 'C:\\elsewhere\\codex.exe' }
    d.lookUp = () => { asked.push('off the main thread'); return new Promise((resolve) => { answer = resolve }) }
    const realpath = d.realpath
    d.realpath = (p) => { asked.push(`the file is read: ${p}`); return realpath(p) }
    let done = false
    const check = verifyCodexExecutable(recorded('C:\\npm\\codex.exe'), d).finally(() => { done = true })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    // Nothing is read, and no answer is given, until the lookup has answered.
    expect(done).toBe(false)
    expect(asked).toEqual(['off the main thread'])
    answer('C:\\found\\codex.exe')
    // The file the lookup named is read straight after: no timer and no
    // other wait stands between the lookup's answer and the identity check.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(asked).toEqual(['off the main thread', 'the file is read: C:\\found\\codex.exe'])
    expect(await check).toEqual({ ok: true, executable: 'C:\\npm\\codex.exe' })
  })

  it.each([
    ['it finds none', async () => null],
    ['it fails', async () => { throw new Error('the lookup failed') }],
    ['it answers something that is not a path', async () => ({ cmd: 'C:\\npm\\codex.exe' }) as unknown as string],
  ])('[host] the pre-use check, when %s: the CLI is no longer on PATH, and no file is read', async (_what, lookUp) => {
    const { d } = deps('C:\\npm\\codex.exe')
    let read = 0
    d.lookUp = lookUp
    d.realpath = () => { read++; return 'C:\\npm\\codex.exe' }
    expect(await verifyCodexExecutable(recorded('C:\\npm\\codex.exe'), d)).toMatchObject({ ok: false, reason: 'missing' })
    expect(read).toBe(0)
  })

  it('[host] the pre-use check with no lookup off the main thread given asks the one in place', async () => {
    const { d } = deps('C:\\npm\\codex.exe')
    const asked: string[] = []
    d.resolve = () => { asked.push('in place'); return 'C:\\npm\\codex.exe' }
    expect(await verifyCodexExecutable(recorded('C:\\npm\\codex.exe'), d)).toEqual({ ok: true, executable: 'C:\\npm\\codex.exe' })
    expect(asked).toEqual(['in place'])
  })
})
