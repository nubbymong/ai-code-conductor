// The update check's last fallback, the GitHub CLI, asks each gh command only
// for the JSON fields that command supports. `gh release list` has no assets
// field (its fields: createdAt, isDraft, isImmutable, isLatest, isPrerelease,
// name, publishedAt, tagName), so the check lists tags, picks the newest
// release it could offer (on macOS up to three), and reads the downloads with
// `gh release view <tag> --json ...assets`. Any gh failure, or an answer it
// cannot use, means no update is offered, and every gh call names the
// repository the updater uses.
//
// gh is emulated: child_process is replaced by a fake that answers as gh does,
// including its refusal of a field the command does not have. No process
// starts and nothing reaches the network.
import { describe, it, expect, beforeEach, vi } from 'vitest'

/** `gh release list --json` fields (cli.github.com/manual/gh_release_list). */
const LIST_FIELDS = ['createdAt', 'isDraft', 'isImmutable', 'isLatest', 'isPrerelease', 'name', 'publishedAt', 'tagName']
/** `gh release view --json` fields (cli.github.com/manual/gh_release_view). */
const VIEW_FIELDS = ['apiUrl', 'assets', 'author', 'body', 'createdAt', 'databaseId', 'id', 'isDraft', 'isImmutable', 'isPrerelease', 'name', 'publishedAt', 'tagName', 'tarballUrl', 'targetCommitish', 'uploadUrl', 'url', 'zipballUrl']

type Rel = Record<string, unknown> & { tagName: string }

const h = vi.hoisted(() => ({
  releases: [] as Rel[],
  channel: 'stable',
  calls: [] as string[][],
  listOut: null as string | null,
  listFails: false,
  viewFails: new Set<string>(),
  viewTagOverride: null as string | null,
  logs: [] as string[],
}))

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function project(rel: Rel, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f, rel[f]]))
}

/** What gh prints, or the error it exits with. */
function gh(args: string[]): { stdout: string } | Error {
  if (args[0] === 'auth' && args[1] === 'token') return { stdout: '' }   // not signed in
  if (args[0] !== 'release') return new Error(`unexpected gh command: ${args.join(' ')}`)
  const fields = (flag(args, '--json') ?? '').split(',')
  if (args[1] === 'list') {
    const unknown = fields.find((f) => !LIST_FIELDS.includes(f))
    if (unknown) return new Error(`Command failed: gh ${args.join(' ')}\nUnknown JSON field: "${unknown}"`)
    if (h.listFails) return new Error(`Command failed: gh ${args.join(' ')}\nHTTP 502`)
    if (h.listOut !== null) return { stdout: h.listOut }
    const limit = Number(flag(args, '--limit') ?? 30)
    return { stdout: JSON.stringify(h.releases.slice(0, limit).map((r) => project(r, fields))) }
  }
  if (args[1] === 'view') {
    const unknown = fields.find((f) => !VIEW_FIELDS.includes(f))
    if (unknown) return new Error(`Command failed: gh ${args.join(' ')}\nUnknown JSON field: "${unknown}"`)
    const tag = args[2]
    if (h.viewFails.has(tag)) return new Error(`Command failed: gh ${args.join(' ')}\nHTTP 502`)
    const rel = h.releases.find((r) => r.tagName === tag)
    if (!rel) return new Error('release not found')
    const out = project(rel, fields)
    if (h.viewTagOverride) out.tagName = h.viewTagOverride
    return { stdout: JSON.stringify(out) }
  }
  return new Error(`unexpected gh command: ${args.join(' ')}`)
}

vi.mock('child_process', () => {
  const execFile = (_file: string, args: string[], _opts: unknown, cb?: (e: unknown, out?: unknown) => void): unknown => {
    h.calls.push(args)
    const r = gh(args)
    if (r instanceof Error) cb?.(r)
    else cb?.(null, { stdout: r.stdout, stderr: '' })
    return { pid: 1 }
  }
  return { execFile, default: { execFile } }
})
vi.mock('../../../src/main/github/gh-program', () => ({
  ghStartCommand: async (args: readonly string[]) => ({ file: 'gh', args: [...args], windowsVerbatimArguments: false }),
}))
// The public and token requests fail, as with no network, so every check
// reaches the gh fallback.
vi.mock('https', async () => {
  const { EventEmitter } = await import('node:events')
  const get = (): unknown => {
    const req = new EventEmitter() as InstanceType<typeof EventEmitter> & { destroy: () => void }
    req.destroy = () => {}
    queueMicrotask(() => req.emit('error', new Error('connect EACCES')))
    return req
  }
  return { default: { get }, get }
})
vi.mock('electron', () => ({ app: { getVersion: () => '1.2.120', getPath: () => '/mock/userData' } }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => ({ updateChannel: h.channel }) }))
vi.mock('../../../src/main/registry', () => ({ readRegistry: () => null, writeRegistry: () => true }))
vi.mock('../../../src/main/data-paths', () => ({ getDataDirectory: () => '/mock/dataDir' }))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (m: unknown) => { h.logs.push(String(m)) },
  logError: (m: unknown) => { h.logs.push(String(m)) },
  logWarn: () => {},
  logDebug: () => {},
}))

const { checkGitHubRelease, activeRepo, _resetActiveRepoForTest } = await import('../../../src/main/github-update')

const REPO = 'nubbymong/claude-command-center'

/** A release as gh knows it, with an installer for every platform. */
function release(tag: string, over: Partial<Rel> = {}): Rel {
  const v = tag.replace(/^v/, '')
  const asset = (name: string) => ({
    name,
    url: `https://github.com/${REPO}/releases/download/${tag}/${name}`,
    apiUrl: `https://api.github.com/repos/${REPO}/releases/assets/1`,
    size: 100,
    contentType: 'application/octet-stream',
  })
  return {
    tagName: tag,
    name: tag,
    isDraft: false,
    isPrerelease: /-/.test(v),
    isLatest: false,
    isImmutable: false,
    createdAt: '2026-01-01T00:00:00Z',
    publishedAt: '2026-01-01T00:00:00Z',
    assets: [
      asset(`ClaudeCommandCenter-Beta-${v}.exe`),
      asset(`ClaudeCommandCenter-Beta-${v}-mac.dmg`),
      asset(`ClaudeCommandCenter-Beta-${v}-linux-x86_64.AppImage`),
      asset('CHECKSUMS.txt'),
    ],
    ...over,
  }
}

function installerFor(tag: string): string {
  const v = tag.replace(/^v/, '')
  if (process.platform === 'darwin') return `ClaudeCommandCenter-Beta-${v}-mac.dmg`
  if (process.platform === 'linux') return `ClaudeCommandCenter-Beta-${v}-linux-x86_64.AppImage`
  return `ClaudeCommandCenter-Beta-${v}.exe`
}

const lists = (): string[][] => h.calls.filter((a) => a[0] === 'release' && a[1] === 'list')
const views = (): string[][] => h.calls.filter((a) => a[0] === 'release' && a[1] === 'view')

/** Run `fn` with process.platform reading `platform`, then put the real one back. */
async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
}

/** Eight releases: five the stable check could offer (1.2.125 to 1.2.128 and
 *  1.2.126), a draft, a beta and two at or below the running 1.2.120. */
function mixedReleases(): Rel[] {
  return [
    release('v1.2.126'),
    release('v1.2.130-beta.1'),
    release('v1.2.129', { isDraft: true }),
    release('v1.2.120'),
    release('v1.2.128'),
    release('v1.2.119'),
    release('v1.2.125'),
    release('v1.2.127'),
  ]
}

beforeEach(() => {
  _resetActiveRepoForTest()
  h.releases = []
  h.channel = 'stable'
  h.calls.length = 0
  h.listOut = null
  h.listFails = false
  h.viewFails = new Set()
  h.viewTagOverride = null
  h.logs.length = 0
})

describe('the gh fallback of the update check', () => {
  it('finds the newest release it can offer, with the installer for this platform', async () => {
    h.releases = [release('v1.2.124'), release('v1.2.125'), release('v1.2.119')]
    const got = await checkGitHubRelease()
    expect(got).not.toBeNull()
    expect(got!.tagName).toBe('v1.2.125')
    expect(got!.version).toBe('1.2.125')
    expect(got!.installerName).toBe(installerFor('v1.2.125'))
    expect(got!.installerUrl).toBe(`https://github.com/${REPO}/releases/download/v1.2.125/${installerFor('v1.2.125')}`)
  })

  it('asks gh release list only for fields it supports, and gh release view for the downloads of the release it picks', async () => {
    h.releases = [release('v1.2.125')]
    await checkGitHubRelease()
    expect(lists()).toHaveLength(1)
    const listFields = flag(lists()[0], '--json')!.split(',')
    for (const f of listFields) expect(LIST_FIELDS, f).toContain(f)
    expect(listFields).not.toContain('assets')
    expect(views()).toEqual([['release', 'view', 'v1.2.125', '--repo', activeRepo(), '--json', 'tagName,isPrerelease,isDraft,assets']])
    for (const f of flag(views()[0], '--json')!.split(',')) expect(VIEW_FIELDS, f).toContain(f)
  })

  it('every gh call names the repository the updater uses', async () => {
    h.releases = [release('v1.2.125'), release('v1.2.124')]
    await checkGitHubRelease()
    const releaseCalls = h.calls.filter((a) => a[0] === 'release')
    expect(releaseCalls.length).toBeGreaterThan(1)
    for (const a of releaseCalls) expect(flag(a, '--repo')).toBe(REPO)
    expect(activeRepo()).toBe(REPO)
  })

  it.each(['win32', 'linux'] as const)('on %s it reads downloads only for the newest release the check could offer: not a draft, not another channel, not this version or older', async (platform) => {
    h.releases = mixedReleases()
    const got = await onPlatform(platform, () => checkGitHubRelease())
    expect(views().map((a) => a[2])).toEqual(['v1.2.128'])
    expect(got!.tagName).toBe('v1.2.128')
  })

  it('on macOS it reads downloads for up to three of the newest releases the check could offer, newest first', async () => {
    h.releases = mixedReleases()
    await onPlatform('darwin', () => checkGitHubRelease())
    expect(views().map((a) => a[2])).toEqual(['v1.2.128', 'v1.2.127', 'v1.2.126'])
  })

  it('on the beta channel a newer prerelease is read and offered', async () => {
    h.channel = 'beta'
    h.releases = [release('v1.2.125'), release('v1.2.126-beta.2'), release('v1.2.126-beta.1')]
    const got = await checkGitHubRelease()
    expect(views()[0][2]).toBe('v1.2.126-beta.2')
    expect(got!.tagName).toBe('v1.2.126-beta.2')
  })

  it('up to date: gh release view never starts, and the log says the fallback found nothing newer', async () => {
    h.releases = [release('v1.2.120'), release('v1.2.119')]
    expect(await checkGitHubRelease()).toBeNull()
    expect(lists()).toHaveLength(1)
    expect(views()).toEqual([])
    expect(h.logs.some((l) => /gh fallback: no release newer than v\S+ on the stable channel/.test(l))).toBe(true)
  })
})

describe('the gh fallback offers nothing when gh does not answer as expected', () => {
  it('on macOS a failed gh release view: no update, even when another release could be read', async () => {
    h.releases = [release('v1.2.125'), release('v1.2.124')]
    h.viewFails = new Set(['v1.2.124'])
    expect(await onPlatform('darwin', () => checkGitHubRelease())).toBeNull()
    expect(views().map((a) => a[2])).toEqual(['v1.2.125', 'v1.2.124'])
  })

  it('off macOS a failed gh release view of the newest release: no update', async () => {
    h.releases = [release('v1.2.125'), release('v1.2.124')]
    h.viewFails = new Set(['v1.2.125'])
    expect(await onPlatform('win32', () => checkGitHubRelease())).toBeNull()
  })

  it('off macOS an older release gh cannot read does not stop the update: only the newest is read', async () => {
    h.releases = [release('v1.2.125'), release('v1.2.124')]
    h.viewFails = new Set(['v1.2.124'])
    const got = await onPlatform('win32', () => checkGitHubRelease())
    expect(got!.tagName).toBe('v1.2.125')
    expect(views().map((a) => a[2])).toEqual(['v1.2.125'])
  })

  it('a view that answers for another tag: no update', async () => {
    h.releases = [release('v1.2.125')]
    h.viewTagOverride = 'v1.2.199'
    expect(await checkGitHubRelease()).toBeNull()
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['JSON that is not a list', '{"tagName":"v1.2.125"}'],
  ])('a release list that is %s: no update, and no view', async (_label, out) => {
    h.releases = [release('v1.2.125')]
    h.listOut = out
    expect(await checkGitHubRelease()).toBeNull()
    expect(views()).toEqual([])
  })

  it('a failed gh release list: no update, and no view', async () => {
    h.releases = [release('v1.2.125')]
    h.listFails = true
    expect(await checkGitHubRelease()).toBeNull()
    expect(lists()).toHaveLength(1)
    expect(views()).toEqual([])
  })
})
