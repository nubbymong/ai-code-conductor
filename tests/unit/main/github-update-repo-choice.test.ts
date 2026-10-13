// Which GitHub repository the updater reads releases from.
//
// The GitHubRepo setting (the registry on Windows, platform-config.json
// elsewhere) chooses between the project's own two repositories, DEFAULT_REPO
// and RENAMED_REPO, and nothing else. Any other value is ignored, a log line
// names it, and the updater behaves as if the setting were absent. The startup
// probe for the renamed repository reads its newest releases and adopts it only
// when at least one of them has a tag the updater understands, and keeps it for
// the session even when the setting cannot be written.
//
// Nothing here reaches the real registry, the network or gh: the registry
// module, https and child_process are replaced, and gh is started by name. The
// fake https answers a list with at most per_page entries, as GitHub does.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AdoptRenamedDeps } from '../../../src/main/github-update'

const h = vi.hoisted(() => ({
  setting: null as string | null,
  writes: [] as Array<[string, string]>,
  urls: [] as string[],
  answer: (_url: string): { status: number; body?: unknown } | Error => new Error('connect EACCES'),
  gh: [] as string[][],
  logs: [] as string[],
}))

vi.mock('../../../src/main/registry', () => ({
  readRegistry: (name: string) => (name === 'GitHubRepo' ? h.setting : null),
  writeRegistry: (name: string, value: string) => { h.writes.push([name, value]); return true },
}))

vi.mock('https', async () => {
  const { EventEmitter } = await import('node:events')
  const get = (url: string, _opts: unknown, cb?: (res: unknown) => void): unknown => {
    h.urls.push(String(url))
    const req = new EventEmitter() as InstanceType<typeof EventEmitter> & { destroy: (e?: Error) => void }
    req.destroy = (e?: Error) => { if (e) queueMicrotask(() => req.emit('error', e)) }
    const a = h.answer(String(url))
    queueMicrotask(() => {
      if (a instanceof Error) { req.emit('error', a); return }
      const res = new EventEmitter() as InstanceType<typeof EventEmitter> & { statusCode: number; headers: Record<string, string> }
      res.statusCode = a.status
      res.headers = {}
      cb?.(res)
      // GitHub returns at most per_page entries of a list.
      const perPage = Number(new URL(String(url)).searchParams.get('per_page') ?? 30)
      const body = Array.isArray(a.body) ? a.body.slice(0, perPage) : a.body
      if (body !== undefined) res.emit('data', Buffer.from(JSON.stringify(body)))
      res.emit('end')
    })
    return req
  }
  return { default: { get }, get }
})

vi.mock('child_process', () => {
  const execFile = (_file: string, args: string[], _opts: unknown, cb?: (e: unknown, out: unknown) => void): unknown => {
    h.gh.push(args)
    // No token, and an empty release list: the check walks every leg.
    cb?.(null, { stdout: args[0] === 'release' && args[1] === 'list' ? '[]' : '', stderr: '' })
    return { pid: 1 }
  }
  return { execFile, default: { execFile } }
})
vi.mock('../../../src/main/github/gh-program', () => ({
  ghStartCommand: async (args: readonly string[]) => ({ file: 'gh', args: [...args], windowsVerbatimArguments: false }),
}))
vi.mock('electron', () => ({ app: { getVersion: () => '2.1.0', getPath: () => '/mock/userData' } }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => ({ updateChannel: 'beta' }) }))
vi.mock('../../../src/main/data-paths', () => ({ getDataDirectory: () => '/mock/dataDir' }))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (m: unknown) => { h.logs.push(String(m)) },
  logError: (m: unknown) => { h.logs.push(String(m)) },
  logWarn: () => {},
  logDebug: () => {},
}))

const { activeRepo, adoptRenamedRepoIfLive, checkGitHubRelease, RENAMED_REPO, _resetActiveRepoForTest } = await import('../../../src/main/github-update')
type Deps = AdoptRenamedDeps

const DEFAULT_REPO = 'nubbymong/claude-command-center'
const OTHER = 'someorg/custom-fork'
const RENAMED_RELEASES = `https://api.github.com/repos/${RENAMED_REPO}/releases`
const RENAMED_RELEASES_URL = `${RENAMED_RELEASES}?per_page=30`
/** A request for the renamed repository's release list, whatever page size it asks for. */
const isRenamedProbe = (url: string): boolean => url.split('?')[0] === RENAMED_RELEASES

function deps(over: Partial<Deps> = {}): Deps & { writes: string[]; probed: string[] } {
  const writes: string[] = []
  const probed: string[] = []
  return {
    readOverride: over.readOverride ?? (() => null),
    writeOverride: over.writeOverride ?? ((s) => { writes.push(s); return true }),
    probe: over.probe ?? (async (s) => { probed.push(s); return false }),
    writes,
    probed,
  }
}

beforeEach(() => {
  _resetActiveRepoForTest()
  h.setting = null
  h.writes.length = 0
  h.urls.length = 0
  h.gh.length = 0
  h.logs.length = 0
  h.answer = () => new Error('connect EACCES')
})

describe('the GitHubRepo setting chooses between the project\'s own repositories only', () => {
  it('no setting: the default repository, as before', () => {
    expect(activeRepo()).toBe(DEFAULT_REPO)
    expect(h.logs).toEqual([])
  })

  it.each([
    ['the default repository', DEFAULT_REPO],
    ['the renamed repository', 'nubbymong/ai-code-conductor'],
  ])('a setting naming %s is used', (_label, value) => {
    h.setting = value
    expect(activeRepo()).toBe(value)
    expect(h.logs).toEqual([])
  })

  it.each([
    ['another well-formed repository', OTHER],
    ['the default repository in other letter case', 'Nubbymong/Claude-Command-Center'],
    ['the renamed repository under another owner', 'someorg/ai-code-conductor'],
    ['a value that is not a repository at all', 'not a valid slug!!'],
  ])('a setting naming %s is ignored, logged, and the default repository is used', (_label, value) => {
    h.setting = value
    expect(activeRepo()).toBe(DEFAULT_REPO)
    expect(h.logs.some((l) => l.includes('GitHubRepo') && l.includes(JSON.stringify(value)))).toBe(true)
  })

  it('an ignored setting changes nothing about where the update check looks: the API request and every gh call name the default repository', async () => {
    h.setting = OTHER
    h.answer = () => ({ status: 404 })
    expect(await checkGitHubRelease()).toBeNull()
    expect(h.urls).toEqual([`https://api.github.com/repos/${DEFAULT_REPO}/releases?per_page=100`])
    const list = h.gh.find((a) => a[0] === 'release' && a[1] === 'list')
    expect(list).toBeDefined()
    expect(list![list!.indexOf('--repo') + 1]).toBe(DEFAULT_REPO)
    for (const args of h.gh) expect(args.join(' ')).not.toContain(OTHER)
  })
})

describe('adoptRenamedRepoIfLive and the setting', () => {
  it.each([DEFAULT_REPO, 'nubbymong/ai-code-conductor'])('a setting of %s is kept and nothing is probed', async (value) => {
    const d = deps({ readOverride: () => value })
    expect(await adoptRenamedRepoIfLive(d)).toBe(value)
    expect(d.probed).toEqual([])
    expect(d.writes).toEqual([])
    expect(activeRepo()).toBe(value)
  })

  it('a setting outside the project\'s repositories is ignored: the probe runs, and a live renamed repository is adopted and written over it', async () => {
    const d = deps({ readOverride: () => OTHER, probe: async (s) => { d.probed.push(s); return s === RENAMED_REPO } })
    expect(await adoptRenamedRepoIfLive(d)).toBe(RENAMED_REPO)
    expect(d.probed).toEqual([RENAMED_REPO])
    expect(d.writes).toEqual([RENAMED_REPO])
    expect(activeRepo()).toBe(RENAMED_REPO)
    expect(h.logs.some((l) => l.includes(JSON.stringify(OTHER)))).toBe(true)
  })

  it('a setting outside the project\'s repositories, renamed repository not live: the default repository, nothing written', async () => {
    h.setting = OTHER
    const d = deps({ readOverride: () => OTHER })
    expect(await adoptRenamedRepoIfLive(d)).toBe(DEFAULT_REPO)
    expect(d.probed).toEqual([RENAMED_REPO])
    expect(d.writes).toEqual([])
    expect(activeRepo()).toBe(DEFAULT_REPO)
  })

  it('no setting, renamed repository not live: the default repository, as before', async () => {
    const d = deps()
    expect(await adoptRenamedRepoIfLive(d)).toBe(DEFAULT_REPO)
    expect(d.probed).toEqual([RENAMED_REPO])
    expect(activeRepo()).toBe(DEFAULT_REPO)
  })

  it('a live renamed repository is used for the session even when writing the setting throws', async () => {
    const d = deps({ probe: async () => true, writeOverride: () => { throw new Error('write failed') } })
    expect(await adoptRenamedRepoIfLive(d)).toBe(RENAMED_REPO)
    expect(activeRepo()).toBe(RENAMED_REPO)
    expect(h.logs.some((l) => l.includes('persist failed; this session only'))).toBe(true)
  })
})

describe('the startup probe of the renamed repository (the app\'s own registry and request code)', () => {
  it('adopts it when it answers with a release whose tag the updater understands, and writes the setting', async () => {
    h.answer = (url) => (isRenamedProbe(url) ? { status: 200, body: [{ tag_name: 'v2.2.0' }] } : { status: 404 })
    expect(await adoptRenamedRepoIfLive()).toBe(RENAMED_REPO)
    expect(h.urls).toEqual([RENAMED_RELEASES_URL])
    expect(h.writes).toEqual([['GitHubRepo', RENAMED_REPO]])
    expect(activeRepo()).toBe(RENAMED_REPO)
  })

  it.each([
    ['a -dev build', [{ tag_name: 'v2.2.0-dev' }, { tag_name: 'v2.1.2' }]],
    ['a tag the updater does not understand', [{ tag_name: 'nightly' }, { tag_name: 'v2.2.0-dev.3' }, { tag_name: 'v2.2.0-beta.1' }]],
  ])('adopts it when its newest release is %s and an older one in the page has a tag the updater understands', async (_label, body) => {
    h.answer = (url) => (isRenamedProbe(url) ? { status: 200, body } : { status: 404 })
    expect(await adoptRenamedRepoIfLive()).toBe(RENAMED_REPO)
    expect(h.writes).toEqual([['GitHubRepo', RENAMED_REPO]])
    expect(activeRepo()).toBe(RENAMED_REPO)
  })

  it.each([
    ['no releases', []],
    ['only a release whose tag the updater does not understand', [{ tag_name: 'nightly' }]],
    ['entries with no tag', [{}, null]],
    ['something that is not a list', { message: 'ok' }],
  ])('stays on the default repository when it answers 200 with %s, and writes nothing', async (_label, body) => {
    h.answer = (url) => (isRenamedProbe(url) ? { status: 200, body } : { status: 404 })
    expect(await adoptRenamedRepoIfLive()).toBe(DEFAULT_REPO)
    expect(h.writes).toEqual([])
    expect(activeRepo()).toBe(DEFAULT_REPO)
  })

  it('stays on the default repository when it answers 404 or the request fails', async () => {
    h.answer = () => ({ status: 404 })
    expect(await adoptRenamedRepoIfLive()).toBe(DEFAULT_REPO)
    _resetActiveRepoForTest()
    h.answer = () => new Error('ENOTFOUND')
    expect(await adoptRenamedRepoIfLive()).toBe(DEFAULT_REPO)
    expect(h.writes).toEqual([])
  })

  it('a setting outside the project\'s repositories is ignored and the probe still runs', async () => {
    h.setting = OTHER
    h.answer = (url) => (isRenamedProbe(url) ? { status: 200, body: [{ tag_name: 'v2.2.0-beta.1' }] } : { status: 404 })
    expect(await adoptRenamedRepoIfLive()).toBe(RENAMED_REPO)
    expect(h.writes).toEqual([['GitHubRepo', RENAMED_REPO]])
  })
})
