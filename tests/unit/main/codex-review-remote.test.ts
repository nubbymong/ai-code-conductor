/**
 * nubbymong/aicc_planning#446 (2.1.3-beta.21, plan block 6): a codex_review
 * from a Claude Code tab through the session helper runs on that tab's
 * machine, never on this computer. Against fakes of the machine's record, the
 * host read of the change and the run there (remote-helper/review.ts covers
 * those against a fake ssh: tests/unit/remote-helper/remote-review.test.ts):
 *
 * - the argv the machine runs is ADR-031's, byte for byte the one a review
 *   here gets for the same choice, with the machine's Codex as argv[0], in
 *   the tab's folder there, on the machine's own environment;
 * - the allow-lists are the machine's own Codex list, never this computer's;
 *   with no list read there a model may not be named;
 * - hostile values, an old or missing Codex there, a version that did not
 *   read, and a machine where the probes PV1 and PV2 have not passed for its
 *   Codex and git, are refused before anything is read or run there;
 * - the material is the host's and its refusals are said; nothing to review
 *   runs nothing; nothing is written on this computer;
 * - the footer names the machine and its own Codex sign-in, the model and the
 *   effort and their sources;
 * - one review per session; a cancel stops the run there.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
const recordReview = vi.fn()
vi.mock('../../../src/main/codex-review-usage', () => ({
  recordReview: (sessionId: string, payload: unknown) => recordReview(sessionId, payload),
}))
import fs from 'fs'
import {
  runRemoteCodexReview, runCodexReview, chooseRemoteCodexReview, registerRemoteCodexReviewTool, remoteCodexReviewOffered, abortSessionReviews, setRemoteReviewDeps,
  type RemoteReviewDeps, type ReviewToolDeps,
} from '../../../src/main/codex-review-mcp-tool'
import type { RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
import type { HostMaterial, HostReadInput, HostRunResult, HostRunSpec } from '../../../src/main/remote-helper/review'
import { codexReviewCommandLine } from '../../../src/main/providers/codex/cli-runner'
import { mergeRegistry, withInstalledCodexModels, type ModelRegistry } from '../../../src/shared/model-registry'
import registryJson from '../../../resources/model-registry.json'

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: 'C.UTF-8', helper: { path: 'linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
  codex: { path: '/home/nick/.npm-global/bin/codex', version: '0.157.1', models: { version: '0.157.1', models: [{ id: 'gpt-host-1', label: 'GPT Host 1', efforts: ['low', 'medium', 'high'] }, { id: 'gpt-host-2', label: 'GPT Host 2' }] } },
  git: '2.47.1',
  reviewProbes: { codex: '0.157.1', git: '2.47.1' },
}
const NAME = 'Rocky (nick@rocky.lan:22)'
const TARGET = { did: MACHINE.did, cwd: '/home/nick/proj' }
const SID = 'rr-sess-1'
const DIFF = 'diff --git a/x.ts b/x.ts\n+const x = 1\n'
const EVENTS = [
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '1. A finding on the machine.' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 80 } }),
].join('\n') + '\n'
const FOOT = ' -- 1 message used -- 1200 input tokens (200 cached), 80 output tokens.'

const BUNDLED = mergeRegistry(registryJson as unknown as ModelRegistry, null)
/** This computer's own Codex list, which a review on a machine never takes. */
const LOCAL = withInstalledCodexModels(BUNDLED, { version: '0.170.0', models: [{ id: 'gpt-7-nova', label: 'GPT-7 Nova', efforts: ['low', 'medium', 'high'] }] })

interface Fake { deps: RemoteReviewDeps; read: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; machine: { value: RemoteMachineRecord | null } }
function fake(over: Partial<RemoteReviewDeps> = {}): Fake {
  const machine = { value: MACHINE as RemoteMachineRecord | null }
  const read = vi.fn(async (_m: RemoteMachineRecord, _i: HostReadInput): Promise<HostMaterial> => ({ ok: true, kind: 'diff', diff: DIFF }))
  const run = vi.fn(async (_m: RemoteMachineRecord, _s: HostRunSpec, _input: string, _t: number, _signal?: AbortSignal): Promise<HostRunResult> => ({ outcome: { code: 0, signal: null, timeout: false, cut: false }, stdout: EVENTS, stderr: '', timedOut: false, cancelled: false }))
  const deps: RemoteReviewDeps = {
    machine: () => machine.value,
    read: read as never,
    run: run as never,
    env: (m) => ({ HOME: m.home, PATH: m.path, LANG: 'C.UTF-8' }),
    registry: () => LOCAL,
    launchRefusal: () => null,
    ...over,
  }
  return { deps, read, run, machine }
}

const review = (f: Fake, args: Record<string, unknown> = {}, target = TARGET) => runRemoteCodexReview({ cccSessionId: SID, mode: 'working', ...args }, target, f.deps)
const nothingRan = (f: Fake) => {
  expect(f.read).not.toHaveBeenCalled()
  expect(f.run).not.toHaveBeenCalled()
}
const spec = (f: Fake, i = 0) => f.run.mock.calls[i][1] as HostRunSpec

beforeEach(() => { recordReview.mockReset() })
afterEach(() => { abortSessionReviews(SID) })

describe('a review on the machine runs ADR-031\'s argv there, never here', () => {
  for (const choice of [{}, { effort: 'high' }, { model: 'gpt-host-1' }, { model: 'gpt-host-1', effort: 'low' }, { model: 'gpt-host-2', effort: 'xhigh' }] as Array<{ model?: string; effort?: string }>) {
    it(`the host argv is the local one for ${JSON.stringify(choice)}, after the machine's Codex`, async () => {
      const f = fake()
      const r = await review(f, choice)
      expect(r.isError, r.text).toBe(false)
      const local = codexReviewCommandLine('/x/codex', { effort: 'medium', ...choice }, 'linux', {})
      if ('refused' in local) throw new Error(local.refused)
      expect(spec(f).argv).toEqual([MACHINE.codex!.path, ...local.args])
      // In the tab's folder there, on the machine's own environment, the prompt on its standard input.
      expect(spec(f).cwd).toBe('/home/nick/proj')
      expect(spec(f).env).toEqual({ HOME: '/home/nick', PATH: MACHINE.path, LANG: 'C.UTF-8' })
      expect(f.run.mock.calls[0][2]).toContain(DIFF)
      expect(f.run.mock.calls[0][3]).toBe(300_000)
    })
  }

  it('the host read gets the tab\'s folder, the mode, the range and the names inside the folder', async () => {
    const f = fake()
    await review(f, { mode: 'range', range: 'HEAD~1..HEAD' })
    expect(f.read.mock.calls[0][1]).toMatchObject({ cwd: '/home/nick/proj', mode: 'range', range: 'HEAD~1..HEAD' })
    f.read.mockResolvedValueOnce({ ok: true, kind: 'files', files: [{ path: 'src/a.ts', text: 'const a = 1\n' }] })
    const r = await review(f, { mode: 'paths', paths: ['src/a.ts', '/home/nick/proj/src/a.ts', './src/../src/a.ts'] })
    expect(r.isError, r.text).toBe(false)
    expect(f.read.mock.calls[1][1]).toMatchObject({ mode: 'paths', paths: ['src/a.ts', 'src/a.ts', 'src/a.ts'] })
    expect(f.run.mock.calls[1][2]).toContain('const a = 1')
  })

  it('a name outside the folder there is refused, and nothing runs', async () => {
    for (const p of ['../other/x.ts', '/home/nick/.ssh/id_rsa', '/etc/passwd', 'a\nb']) {
      const f = fake()
      const r = await review(f, { mode: 'paths', paths: [p] })
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/^Paths must be inside the session cwd\. Rejected:/)
      nothingRan(f)
    }
  })

  it('nothing written on this computer: no file, no folder', async () => {
    const calls: string[] = []
    const spies = (['writeFileSync', 'mkdirSync', 'mkdtempSync', 'openSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'rmSync', 'unlinkSync'] as const).map((k) => vi.spyOn(fs, k).mockImplementation(((...a: unknown[]) => { calls.push(`${k} ${String(a[0])}`); throw new Error(`${k} on this computer`) }) as never))
    try {
      const f = fake()
      const r = await review(f)
      expect(r.isError, r.text).toBe(false)
    } finally {
      for (const s of spies) s.mockRestore()
    }
    expect(calls).toEqual([])
  })

  it('the review a remote tab asks for is never the local one: the local tool refuses its session, the remote one runs on the machine', async () => {
    // A local review of the same session (what a fall-back to this computer
    // would run) has no registration for it, so it is refused.
    const local: ReviewToolDeps = { accounts: () => { throw new Error('a local account was asked for') }, reviewer: () => { throw new Error('a local reviewer was asked for') } }
    const l = await runCodexReview({ cccSessionId: SID, mode: 'working' }, new Set(), TARGET.cwd, local)
    expect(l.isError).toBe(true)
    const f = fake()
    const r = await review(f)
    expect(r.isError, r.text).toBe(false)
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(r.text.startsWith('1. A finding on the machine.')).toBe(true)
  })
})

describe('the footer names the machine and its own sign-in, the model, the effort and their sources', () => {
  it('a model and an effort the caller chose; the usage goes to the deps\' record', async () => {
    const onUsage = vi.fn()
    const f = fake({ onUsage })
    const r = await review(f, { model: 'gpt-host-1', effort: 'high' })
    expect(r.text).toBe(`1. A finding on the machine.\n\n---\nCodex review on ${NAME}, with ${NAME}'s own Codex sign-in, on gpt-host-1 (caller), effort high (caller)${FOOT}`)
    expect(onUsage).toHaveBeenCalledWith(SID, { inputTokens: 1200, cachedInputTokens: 200, outputTokens: 80 })
  })

  it('in the running app, the usage goes to this app\'s review record, as a review here does', async () => {
    const f = fake()
    const host = { machine: f.deps.machine, read: f.deps.read, run: f.deps.run, env: f.deps.env }
    setRemoteReviewDeps(host)
    try {
      let handler: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) | null = null
      const server = { tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => { handler = h } }
      registerRemoteCodexReviewTool(server, (await import('zod')).z, () => SID, (sid) => (sid === SID ? TARGET : null))
      const r = await handler!({ mode: 'working' })
      expect(r.isError, r.content[0].text).toBeFalsy()
      expect(recordReview).toHaveBeenCalledWith(SID, { inputTokens: 1200, outputTokens: 80, rateLimit: null })
    } finally {
      setRemoteReviewDeps(null)
    }
  })

  it('the defaults', async () => {
    const f = fake()
    const r = await review(f)
    expect(r.text).toBe(`1. A finding on the machine.\n\n---\nCodex review on ${NAME}, with ${NAME}'s own Codex sign-in, on the reviewer account's default model, not named (default), effort medium (default; requested, not confirmed)${FOOT}`)
  })
})

describe('the allow-lists are the machine\'s own Codex list, never this computer\'s', () => {
  it('a model only this computer\'s Codex lists is refused, with the machine\'s list; nothing is read or run there', async () => {
    const f = fake()
    const r = await review(f, { model: 'gpt-7-nova' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('gpt-host-1')
    expect(r.text).toContain('gpt-host-2')
    expect(r.text).not.toContain('gpt-7-nova,')
    nothingRan(f)
  })

  it('the machine\'s model takes the machine\'s own levels for it', () => {
    expect(chooseRemoteCodexReview({ model: 'gpt-host-1', effort: 'high' }, LOCAL, MACHINE.codex!.models, NAME)).toMatchObject({ argv: { model: 'gpt-host-1', effort: 'high' } })
    const refused = chooseRemoteCodexReview({ model: 'gpt-host-1', effort: 'xhigh' }, LOCAL, MACHINE.codex!.models, NAME)
    expect('refused' in refused && refused.refused).toMatch(/Choose one of: low, medium, high/)
    expect('refused' in chooseRemoteCodexReview({ model: 'gpt-7-nova' }, LOCAL, MACHINE.codex!.models, NAME)).toBe(true)
  })

  it('with no list read on the machine, a model may not be named; an effort Codex takes may', async () => {
    const noList: RemoteMachineRecord = { ...MACHINE, codex: { path: MACHINE.codex!.path, version: '0.157.1' } }
    const f = fake()
    f.machine.value = noList
    const named = await review(f, { model: 'gpt-host-1' })
    expect(named.isError).toBe(true)
    expect(named.text).toMatch(/were not read at its last Check/)
    nothingRan(f)
    const effort = await review(f, { effort: 'high' })
    expect(effort.isError, effort.text).toBe(false)
    expect(spec(f).argv).toContain('model_reasoning_effort=high')
    expect(spec(f).argv).not.toContain('-m')
  })

  it('hostile values are refused before anything is read or run there', async () => {
    const HOSTILE = ['-m', '--profile=x', '-c', 'gpt-host-1 --yolo', 'gpt host', 'gpt"1', '"', 'gpt%PATH%', 'a&b', '&calc', 'gpt|x', 'gpt-host-1\n-c', '\n', 'gpt-host-1\n', 'unknown-model', '', 'GPT-HOST-1', ' gpt-host-1']
    const HOSTILE_EFFORT = ['none', 'minimal', 'turbo', '-c', '--effort', 'high ', 'high\n', 'high&x', '%high%', '"high"', 'HIGH', '']
    for (const model of HOSTILE) {
      const f = fake()
      const r = await review(f, { model })
      expect(r.isError, JSON.stringify(model)).toBe(true)
      nothingRan(f)
    }
    for (const effort of HOSTILE_EFFORT) {
      const f = fake()
      const r = await review(f, { model: 'gpt-host-1', effort })
      expect(r.isError, JSON.stringify(effort)).toBe(true)
      nothingRan(f)
    }
  })
})

describe('refused before anything is read or run there, and never run here instead', () => {
  const cases: Array<[string, Partial<RemoteMachineRecord> | null, RegExp]> = [
    ['no Codex there', { codex: undefined }, /Codex was not found on Rocky/],
    ['a Codex older than the oldest this app runs', { codex: { ...MACHINE.codex!, version: '0.150.0' } }, /has Codex 0\.150\.0, older than 0\.153\.4/],
    ['a Codex version that did not read', { codex: { ...MACHINE.codex!, version: null } }, /did not read at its last Check/],
    ['the probes not passed there', { reviewProbes: undefined }, /have not been proven there yet for its Codex 0\.157\.1 and git 2\.47\.1/],
    ['the probes passed with another Codex', { reviewProbes: { codex: '0.155.1', git: '2.47.1' } }, /have not been proven there yet/],
    ['the probes passed with another git', { reviewProbes: { codex: '0.157.1', git: '2.39.5' } }, /have not been proven there yet/],
    ['no git read there', { git: undefined }, /have not been proven there yet for its Codex 0\.157\.1 and its git/],
    ['a machine no longer on the list', null, /no longer on this computer's list/],
  ]
  for (const [what, change, words] of cases) {
    it(what, async () => {
      const f = fake()
      f.machine.value = change === null ? null : ({ ...MACHINE, ...change } as RemoteMachineRecord)
      if (change && 'codex' in change && change.codex === undefined) delete (f.machine.value as Partial<RemoteMachineRecord>).codex
      if (change && 'git' in change && change.git === undefined) delete (f.machine.value as Partial<RemoteMachineRecord>).git
      if (change && 'reviewProbes' in change && change.reviewProbes === undefined) delete (f.machine.value as Partial<RemoteMachineRecord>).reviewProbes
      const r = await review(f)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(words)
      expect(r.text).toMatch(/Nothing ran there or on this computer\.$/)
      nothingRan(f)
    })
  }

  it('Codex switched off in this app (main\'s one launch rule): refused, and nothing is read or run there', async () => {
    const f = fake({ launchRefusal: () => ({ code: 'disabled', message: 'Codex is switched off (Settings, Accounts).' }) as never })
    const r = await review(f)
    expect(r).toEqual({ isError: true, text: 'Codex review is unavailable. Codex is switched off (Settings, Accounts).' })
    nothingRan(f)
  })

  it('a session that is not a registered remote tab, or no remote wiring, runs nothing', async () => {
    const f = fake()
    expect((await review(f, {}, null as never)).text).toMatch(/^Codex review is not enabled for this session/)
    expect((await runRemoteCodexReview({ cccSessionId: SID, mode: 'working' }, TARGET, null)).isError).toBe(true)
    nothingRan(f)
  })
})

describe('the material is the host\'s', () => {
  it('a read the host refuses is said, and nothing runs', async () => {
    const f = fake()
    f.read.mockResolvedValueOnce({ ok: false, message: 'the change is larger than 512 KB; review a narrower range, or name files with mode "paths"' })
    const r = await review(f)
    expect(r.isError).toBe(true)
    expect(r.text).toBe(`Codex review could not read the change on ${NAME}: the change is larger than 512 KB; review a narrower range, or name files with mode "paths". Nothing ran there or on this computer.`)
    expect(f.run).not.toHaveBeenCalled()
  })

  it('nothing to review runs nothing', async () => {
    const f = fake()
    f.read.mockResolvedValueOnce({ ok: true, kind: 'diff', diff: '  \n' })
    const r = await review(f)
    expect(r).toEqual({ isError: false, text: 'Codex review: nothing to review -- there are no uncommitted changes to tracked files.' })
    expect(f.run).not.toHaveBeenCalled()
  })
})

describe('how a run there ends', () => {
  const ending = async (result: Partial<HostRunResult>, args: Record<string, unknown> = {}) => {
    const f = fake()
    f.run.mockResolvedValueOnce({ outcome: { code: 0, signal: null, timeout: false, cut: false }, stdout: '', stderr: '', timedOut: false, cancelled: false, ...result })
    return review(f, args)
  }
  const ended = (more: Partial<NonNullable<HostRunResult['outcome']>>) => ({ outcome: { code: 0, signal: null, timeout: false, cut: false, ...more } })
  it('timed out there, by the run mode\'s own timeout or the exec\'s', async () => {
    const r = await ending(ended({ code: null, signal: 1, timeout: true }), { timeoutSeconds: 900 })
    expect(r.text).toMatch(/^Codex review timed out on Rocky \(nick@rocky\.lan:22\) after 15 minutes \(on /)
    const exec = await ending({ outcome: null, timedOut: true }, { timeoutSeconds: 900 })
    expect(exec.text).toMatch(/^Codex review timed out on Rocky \(nick@rocky\.lan:22\) after 15 minutes\. /)
  })
  it('not started there: nothing ran, so no model is named in its footer', async () => {
    const r = await ending({ outcome: null, failure: 'the session helper started nothing there: the program /home/nick/.npm-global/bin/codex is not a file there, so nothing was started', stderr: 'aicc-helper: run: the program /home/nick/.npm-global/bin/codex is not a file there, so nothing was started\n' })
    expect(r.text).toMatch(/^Codex review did not run on Rocky \(nick@rocky\.lan:22\): the session helper started nothing there: the program /)
    expect(r.text).toMatch(/own Codex sign-in -- 1 message used\. Usage data unavailable\.$/)
    expect(r.text).not.toMatch(/effort/)
  })
  it('Codex failing there, by its own error event', async () => {
    const r = await ending({ ...ended({ code: 1 }), stdout: `${JSON.stringify({ type: 'error', message: 'stream error: 401 Unauthorized' })}\n` })
    expect(r.text).toMatch(/^Codex review failed on Rocky \(nick@rocky\.lan:22\): Codex exited with code 1: stream error: 401 Unauthorized\./)
  })
  it('Codex ended by a signal there, with its last error line', async () => {
    const r = await ending({ ...ended({ code: null, signal: 9 }), stderr: 'thread main panicked\nkilled\n' })
    expect(r.text).toMatch(/^Codex review failed on Rocky \(nick@rocky\.lan:22\): Codex was ended by signal 9: thread main panicked killed\./)
  })
  it('the machine not reached', async () => {
    const r = await ending({ outcome: null, failure: 'rocky.lan could not be reached: it did not answer' })
    expect(r.text).toMatch(/^Codex review did not run on Rocky \(nick@rocky\.lan:22\): rocky\.lan could not be reached: it did not answer\./)
  })
  it('the output cap there', async () => {
    expect((await ending(ended({ code: null, signal: 13, cut: true }))).text).toMatch(/^Codex review failed on Rocky \(nick@rocky\.lan:22\): Codex printed more than 4 MiB, more than this app reads, so it was ended\./)
  })
  it('no review in what it printed', async () => {
    expect((await ending({ ...ended({}), stdout: '' })).text).toMatch(/^Codex review failed on Rocky \(nick@rocky\.lan:22\): Codex returned no review\./)
  })
})

describe('one review per session, and a cancel stops the run there', () => {
  it('a second review while one runs is refused; the session\'s end stops the first, and its signal reaches the run', async () => {
    const f = fake()
    let seen: AbortSignal | undefined
    let release: () => void = () => {}
    f.run.mockImplementationOnce(async (_m: RemoteMachineRecord, _s: HostRunSpec, _i: string, _t: number, signal?: AbortSignal) => {
      seen = signal
      await new Promise<void>((r) => { release = r; signal?.addEventListener('abort', () => r(), { once: true }) })
      return { outcome: null, stdout: '', stderr: '', timedOut: false, cancelled: true }
    })
    const first = review(f)
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1))
    const second = await review(f)
    expect(second.text).toMatch(/a review is already running for this session/)
    abortSessionReviews(SID)
    expect(seen?.aborted).toBe(true)
    release()
    expect((await first).text).toBe('Codex review was cancelled.')
  })
})

describe('the tool on a remote tab\'s connection', () => {
  it('is offered only while the machine\'s record names Codex', () => {
    const f = fake()
    expect(remoteCodexReviewOffered(TARGET, f.deps)).toBe(true)
    f.machine.value = { ...MACHINE }
    delete (f.machine.value as Partial<RemoteMachineRecord>).codex
    expect(remoteCodexReviewOffered(TARGET, f.deps)).toBe(false)
    expect(remoteCodexReviewOffered(null, f.deps)).toBe(false)
    expect(remoteCodexReviewOffered(TARGET, null)).toBe(false)
  })

  it('takes the session from the connection only, lists the machine\'s models, and runs the review there', async () => {
    const f = fake()
    let handler: ((args: Record<string, unknown>, extra?: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) | null = null
    let description = ''
    let shape: Record<string, { description?: string }> = {}
    const server = { tool: (_name: string, desc: string, s: Record<string, { description?: string }>, h: typeof handler) => { description = desc; shape = s; handler = h } }
    const z = (await import('zod')).z
    registerRemoteCodexReviewTool(server, z, () => SID, (sid) => (sid === SID ? TARGET : null), f.deps)
    expect(description).toContain(NAME)
    expect(shape.model.description).toContain('gpt-host-1')
    expect(shape.model.description).not.toContain('gpt-7-nova')
    // An id the agent names is ignored: the connection's is used.
    const r = await handler!({ mode: 'working', cccSessionId: 'another-session' })
    expect(r.isError).toBeFalsy()
    expect(r.content[0].text).toContain(`Codex review on ${NAME}`)
    expect(f.run).toHaveBeenCalledTimes(1)
  })
})
