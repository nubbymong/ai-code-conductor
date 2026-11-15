// macOS and Linux have no registry: the app's folders and a few other
// settings are saved in platform-config.json under the home folder
// (src/main/platform-config-store.ts, behind readRegistry and writeRegistry).
//
// A file that was there but did not read (it could not be opened, it was not
// JSON, it held something other than one object of text values) was read as
// an empty set of settings. The next write started from that empty set and
// saved it over the file, in place: one change replaced every saved setting
// with that one change, and a write cut short left a part of a file.
//
// The store follows the rule github-config.json follows. No file starts
// empty. A file that is there but did not read is refused and left byte for
// byte. While it does not read, a reader is answered from the values last
// read or written in this run. A write stages a copy beside the file and
// renames it over it.
//
// Nothing is written to disk: fs is replaced by an in-memory stand-in for
// the calls registry.ts, platform-config-store.ts, atomic-write.ts and
// data-paths.ts make, and the platform is forced to Linux. The folders are
// literals that read the same on every host.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  /** Every file opened for writing, with the flag it was opened with. */
  opened: [] as { path: string; flag: string | undefined }[],
  renames: [] as [string, string][],
  removed: [] as string[],
  /** The error code a read of a file throws, by path. */
  readFails: new Map<string, string>(),
  /** Texts the next reads of a file give, by path, before its real text. */
  readsFirst: new Map<string, string[]>(),
  /** An error code a write of a staging file throws, or null. */
  writeFails: null as string | null,
  /** An error code the rename over the file throws, or null. */
  renameFails: null as string | null,
  /** The permission mode of a file, by path (a file not listed: 0o644). */
  modes: new Map<string, number>(),
  /** The mode each staged copy was created with (undefined: none given). */
  stagedModes: [] as (number | undefined)[],
}))

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  // As Node.js words a file error: the code, what was done, and the full path.
  const fail = (code: string, file?: string) => Object.assign(new Error(file ? `${code}: operation refused, open '${file}'` : `${code}: operation refused`), { code })
  const stub = {
    existsSync: vi.fn((p: import('fs').PathLike) => h.files.has(String(p)) || h.dirs.has(String(p))),
    readFileSync: vi.fn((p: import('fs').PathOrFileDescriptor) => {
      const file = String(p)
      const code = h.readFails.get(file)
      if (code) throw fail(code)
      const first = h.readsFirst.get(file)
      if (first && first.length > 0) return first.shift() as string
      const text = h.files.get(file)
      if (text === undefined) throw fail('ENOENT')
      return text
    }),
    lstatSync: vi.fn((p: import('fs').PathLike) => {
      if (!h.files.has(String(p)) && !h.dirs.has(String(p))) throw fail('ENOENT')
      return { isSymbolicLink: () => false, isFile: () => h.files.has(String(p)), mtimeMs: Date.now() }
    }),
    statSync: vi.fn((p: import('fs').PathLike) => {
      const file = String(p)
      if (!h.files.has(file)) throw fail('ENOENT', file)
      // A regular file's type bits, then its permission bits.
      return { isFile: () => true, mode: 0o100000 | (h.modes.get(file) ?? 0o644) }
    }),
    readdirSync: vi.fn((p: import('fs').PathLike) => {
      const dir = String(p)
      return [...h.files.keys()].filter((f) => path.dirname(f) === dir).map((f) => path.basename(f))
    }),
    writeFileSync: vi.fn((p: import('fs').PathOrFileDescriptor, data: unknown, opts?: unknown) => {
      const file = String(p)
      const flag = opts && typeof opts === 'object' ? (opts as { flag?: string }).flag : undefined
      h.opened.push({ path: file, flag })
      h.stagedModes.push(opts && typeof opts === 'object' ? (opts as { mode?: number }).mode : undefined)
      if (h.writeFails) throw fail(h.writeFails, file)
      if (flag === 'wx' && h.files.has(file)) throw fail('EEXIST')
      h.files.set(file, String(data))
    }),
    renameSync: vi.fn((from: import('fs').PathLike, to: import('fs').PathLike) => {
      h.renames.push([String(from), String(to)])
      if (h.renameFails) throw fail(h.renameFails, String(to))
      const text = h.files.get(String(from))
      if (text === undefined) throw fail('ENOENT')
      h.files.set(String(to), text)
      h.files.delete(String(from))
    }),
    unlinkSync: vi.fn((p: import('fs').PathLike) => {
      h.removed.push(String(p))
      h.files.delete(String(p))
    }),
    mkdirSync: vi.fn((p: import('fs').PathLike) => {
      h.dirs.add(String(p))
      return undefined
    }),
  }
  return { ...real, ...stub, default: { ...real, ...stub } }
})
vi.mock('child_process', () => ({ execFileSync: () => { throw new Error('reg.exe is not started on Linux') } }))
vi.mock('../../../src/main/windows-programs', () => ({ systemTool: (rel: string) => `C:\\Windows\\System32\\${rel}` }))
vi.unmock('../../../src/main/data-paths')

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

// Where the store looks, in its order: the current name, then the older one.
const BRAND = path.join(os.homedir(), '.ai-code-conductor', 'platform-config.json')
const LEGACY = path.join(os.homedir(), '.claude-conductor', 'platform-config.json')
/** A staged copy of `file`: its name, a random id, `.tmp`. */
const stagedFor = (file: string): RegExp =>
  new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`)

const SAVED = { DataDirectory: '/ccc-test/data', ResourcesDirectory: '/ccc-test/res', GitHubRepo: 'someone/somewhere' }
const SAVED_TEXT = JSON.stringify(SAVED, null, 2)

async function load() {
  vi.resetModules()
  const registry = await import('../../../src/main/registry')
  const paths = await import('../../../src/main/data-paths')
  const { logWarn } = await import('../../../src/main/debug-logger')
  vi.mocked(logWarn).mockClear()
  const warned = () => vi.mocked(logWarn).mock.calls.map((c) => String(c[0]))
  return { registry, paths, warned }
}

/** Nothing was saved: no file was opened for writing, renamed or removed,
 *  and every file holds what it held. */
function expectNothingSaved(before: Map<string, string>, label = ''): void {
  expect(h.opened, label).toEqual([])
  expect(h.renames, label).toEqual([])
  expect(h.removed, label).toEqual([])
  expect([...h.files.entries()], label).toEqual([...before.entries()])
}

beforeEach(() => {
  h.files.clear()
  h.dirs.clear()
  h.opened.length = 0
  h.renames.length = 0
  h.removed.length = 0
  h.readFails.clear()
  h.readsFirst.clear()
  h.writeFails = null
  h.renameFails = null
  h.modes.clear()
  h.stagedModes.length = 0
  // Every file call must be the in-memory stand-in.
  for (const fn of [fs.readFileSync, fs.writeFileSync, fs.renameSync, fs.lstatSync, fs.statSync, fs.mkdirSync, fs.unlinkSync, fs.readdirSync]) {
    expect(vi.isMockFunction(fn)).toBe(true)
  }
  expect(process.env.CCC_E2E_DATA_DIR).toBeTruthy()
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
  vi.resetModules()
})

describe('macOS/Linux: a platform-config.json that is there but did not read is refused and kept', () => {
  it.each([
    ['text that is not JSON (a file cut short)', '{\n  "DataDirectory": "/ccc-test/da', 'DataDirectory'],
    ['a JSON array (planning #258)', '[]', 'DataDirectory'],
    ['JSON null (planning #258)', 'null', 'DataDirectory'],
    ['a JSON number', '7', 'DataDirectory'],
    ['a JSON text', '"/ccc-test/data"', 'DataDirectory'],
    ['an object with a value that is not text (a shape a later version might write)', '{"DataDirectory":"/ccc-test/data","schemaVersion":2}', 'schemaVersion'],
    ['an object with a nested value', '{"ResourcesDirectory":{"path":"/ccc-test/res"}}', 'ResourcesDirectory'],
  ])('%s: a read answers no value, and a write saves nothing over it', async (_what, text, name) => {
    h.files.set(BRAND, text)
    const before = new Map(h.files)
    const { registry, warned } = await load()
    let read: unknown = 'not read'
    expect(() => { read = registry.readRegistry(name) }).not.toThrow()
    expect(read).toBeNull()
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(false)
    expectNothingSaved(before)
    // Said once, by the kind of fault: never the file's text or its path.
    expect(warned()).toHaveLength(1)
    expect(warned()[0]).toMatch(/^\[platform-config\] platform-config\.json is there but did not read \((not valid JSON|not one JSON object|a value that is not text)\)\./)
    expect(warned()[0]).not.toContain('ccc-test')
    expect(warned()[0]).not.toContain(os.homedir())
  })

  it.each(['EACCES', 'EPERM', 'EIO', 'EBUSY', 'EISDIR', 'ELOOP'])('a read that fails with %s: a write saves nothing, and the file is not replaced', async (code) => {
    h.files.set(BRAND, SAVED_TEXT)
    h.readFails.set(BRAND, code)
    const before = new Map(h.files)
    const { registry, warned } = await load()
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(false)
    expectNothingSaved(before, code)
    expect(warned()).toEqual([`[platform-config] platform-config.json is there but did not read (Error ${code}). It is left as it is, and nothing is saved over it until it reads again.`])
  })

  it('the older location\'s file did not read: no new file is started under the current name beside it', async () => {
    h.files.set(LEGACY, SAVED_TEXT)
    h.readFails.set(LEGACY, 'EACCES')
    const before = new Map(h.files)
    const { registry } = await load()
    expect(registry.readRegistry('DataDirectory')).toBeNull()
    expect(registry.writeRegistry('DataDirectory', '/ccc-test/other')).toBe(false)
    expectNothingSaved(before)
    expect(h.files.has(BRAND)).toBe(false)
  })

  it('a read that says "no such file" for a file a second look finds: refused, not taken for no file', async () => {
    h.files.set(BRAND, SAVED_TEXT)
    h.readFails.set(BRAND, 'ENOENT')
    const before = new Map(h.files)
    const { registry } = await load()
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(false)
    expectNothingSaved(before)
  })

  it('a read that gives nothing for a file that has text a moment later: refused, not taken for an empty file', async () => {
    h.files.set(BRAND, SAVED_TEXT)
    h.readsFirst.set(BRAND, [''])
    const before = new Map(h.files)
    const { registry } = await load()
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(false)
    expectNothingSaved(before)
    // The next look reads it, and the write goes through with every value kept.
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(true)
    expect(JSON.parse(h.files.get(BRAND)!)).toEqual({ ...SAVED, SourcePath: '/ccc-test/src' })
  })

  // Mutation to prove this can fail: ignore writeRegistry's answer in data-paths.
  it('setDataDirectory and setResourcesDirectory answer false and set nothing', async () => {
    h.files.set(BRAND, '{ not json')
    const before = new Map(h.files)
    const { paths } = await load()
    const heard: string[] = []
    paths.onResourcesDirectoryChanged((dir) => heard.push(dir))
    expect(paths.setDataDirectory('/ccc-test/data')).toBe(false)
    expect(paths.isDataDirFromRegistry()).toBe(false)
    expect(paths.getDataDirectory()).not.toBe('/ccc-test/data')
    expect(paths.setResourcesDirectory('/ccc-test/res')).toBe(false)
    expect(heard).toEqual([])
    expectNothingSaved(before)
  })
})

describe('macOS/Linux: no file, or a file with nothing in it, starts empty', () => {
  it('no file: the first write makes it, under the current name', async () => {
    const { registry, warned } = await load()
    expect(registry.readRegistry('DataDirectory')).toBeNull()
    expect(registry.writeRegistry('DataDirectory', '/ccc-test/data')).toBe(true)
    expect(h.dirs.has(path.dirname(BRAND))).toBe(true)
    expect(JSON.parse(h.files.get(BRAND)!)).toEqual({ DataDirectory: '/ccc-test/data' })
    expect(registry.readRegistry('DataDirectory')).toBe('/ccc-test/data')
    expect(warned()).toEqual([])
  })

  it.each([
    ['no characters', ''],
    ['white space', ' \n\t\r\n'],
    ['only a byte-order mark', '\ufeff'],
    ['NUL characters (a write cut off by a power loss)', '\0\0\0\0'],
  ])('a file with %s holds no setting: the first write replaces it', async (_what, text) => {
    h.files.set(BRAND, text)
    const { registry, warned } = await load()
    expect(registry.readRegistry('DataDirectory')).toBeNull()
    expect(registry.writeRegistry('DataDirectory', '/ccc-test/data')).toBe(true)
    expect(JSON.parse(h.files.get(BRAND)!)).toEqual({ DataDirectory: '/ccc-test/data' })
    expect(warned()).toEqual([])
  })

  it('an install that has its file in the older location keeps using it', async () => {
    h.files.set(LEGACY, SAVED_TEXT)
    const { registry } = await load()
    expect(registry.readRegistry('GitHubRepo')).toBe('someone/somewhere')
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(true)
    expect(JSON.parse(h.files.get(LEGACY)!)).toEqual({ ...SAVED, SourcePath: '/ccc-test/src' })
    expect(h.files.has(BRAND)).toBe(false)
  })
})

describe('macOS/Linux: a write keeps what the file holds and replaces the file whole', () => {
  it('every other value is kept, also in a file an editor saved with a byte-order mark', async () => {
    h.files.set(BRAND, `\ufeff${SAVED_TEXT}`)
    const { registry } = await load()
    expect(registry.readRegistry('ResourcesDirectory')).toBe('/ccc-test/res')
    expect(registry.writeRegistry('DataDirectory', '/ccc-test/moved')).toBe(true)
    expect(JSON.parse(h.files.get(BRAND)!)).toEqual({ ...SAVED, DataDirectory: '/ccc-test/moved' })
  })

  it('the new text is staged beside the file and renamed over it: the file is never opened for writing in place', async () => {
    h.files.set(BRAND, SAVED_TEXT)
    const { registry } = await load()
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(true)
    expect(h.opened).toHaveLength(1)
    expect(h.opened[0].path).toMatch(stagedFor(BRAND))
    // Created new: a file or a link already at the staging name is refused.
    expect(h.opened[0].flag).toBe('wx')
    expect(h.renames).toEqual([[h.opened[0].path, BRAND]])
    expect([...h.files.keys()]).toEqual([BRAND])
  })

  it.each([
    ['the staged copy cannot be written (a full home folder)', 'ENOSPC', null],
    ['the staged copy cannot be written (a read-only home folder)', 'EROFS', null],
    ['the rename over the file is refused', null, 'EACCES'],
  ])('%s: the write answers false and the old file is whole', async (_what, writeFails, renameFails) => {
    h.files.set(BRAND, SAVED_TEXT)
    h.writeFails = writeFails
    h.renameFails = renameFails
    const { registry } = await load()
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(false)
    expect(h.opened.every((o) => o.path !== BRAND)).toBe(true)
    // The old file is as it was, and no staged copy is left beside it.
    expect([...h.files.entries()]).toEqual([[BRAND, SAVED_TEXT]])
    expect(registry.readRegistry('SourcePath')).toBeNull()
    expect(registry.readRegistry('DataDirectory')).toBe('/ccc-test/data')
  })

  // Mutation to prove this can fail: put the error's own text in the line.
  it.each([
    ['the staged copy cannot be written', 'EROFS', null],
    ['the rename over the file is refused', null, 'EACCES'],
  ])('%s: the log says the kind of failure, never its own text or a path', async (_what, writeFails, renameFails) => {
    h.files.set(BRAND, SAVED_TEXT)
    h.writeFails = writeFails
    h.renameFails = renameFails
    const { registry, warned } = await load()
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(false)
    expect(warned()).toEqual([`[platform-config] platform-config.json could not be saved (Error ${writeFails ?? renameFails})`])
    expect(warned()[0]).not.toContain(os.homedir())
    expect(warned()[0]).not.toContain('ccc-test')
    expect(warned()[0]).not.toContain('.tmp')
  })

  // Mutation to prove this can fail: create the staged copy with no mode.
  it.each([
    ['a file the user made readable by its owner alone', 0o600],
    ['a file the user made readable by its group too', 0o640],
    ['a file with the usual mode', 0o644],
  ])('the staged copy is created with the mode the file has (%s)', async (_what, mode) => {
    h.files.set(BRAND, SAVED_TEXT)
    h.modes.set(BRAND, mode)
    const { registry } = await load()
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(true)
    expect(h.stagedModes).toEqual([mode])
  })

  it('a file with nothing in it keeps its mode too, and the first write of a new file names none', async () => {
    h.files.set(BRAND, '')
    h.modes.set(BRAND, 0o600)
    const { registry } = await load()
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(true)
    expect(h.stagedModes).toEqual([0o600])
    h.files.clear()
    h.stagedModes.length = 0
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(true)
    expect(h.stagedModes).toEqual([undefined])
  })
})

describe('macOS/Linux: the settings in memory are kept while the file does not read', () => {
  it('a file that read and then does not: a reader is still answered, a write is refused, and the file is read again once it can be', async () => {
    h.files.set(BRAND, SAVED_TEXT)
    const { registry } = await load()
    expect(registry.readRegistry('GitHubRepo')).toBe('someone/somewhere')
    h.readFails.set(BRAND, 'EIO')
    const before = new Map(h.files)
    expect(registry.readRegistry('GitHubRepo')).toBe('someone/somewhere')
    expect(registry.readRegistry('DataDirectory')).toBe('/ccc-test/data')
    expect(registry.readRegistry('SourcePath')).toBeNull()
    expect(registry.writeRegistry('GitHubRepo', 'other/place')).toBe(false)
    expectNothingSaved(before)
    expect(registry.readRegistry('GitHubRepo')).toBe('someone/somewhere')
    // It reads again, with a value changed outside the app meanwhile.
    h.readFails.clear()
    h.files.set(BRAND, JSON.stringify({ ...SAVED, GitHubRepo: 'changed/outside' }))
    expect(registry.readRegistry('GitHubRepo')).toBe('changed/outside')
  })

  it('a value written in this run is the one kept', async () => {
    const { registry } = await load()
    expect(registry.writeRegistry('DataDirectory', '/ccc-test/data')).toBe(true)
    h.files.set(BRAND, '{ damaged')
    expect(registry.readRegistry('DataDirectory')).toBe('/ccc-test/data')
  })

  it('a file that is gone is no file: nothing is kept for it', async () => {
    h.files.set(BRAND, SAVED_TEXT)
    const { registry } = await load()
    expect(registry.readRegistry('DataDirectory')).toBe('/ccc-test/data')
    h.files.delete(BRAND)
    expect(registry.readRegistry('DataDirectory')).toBeNull()
    // And a file that does not read after that has no earlier values to answer with.
    h.files.set(BRAND, '{ damaged')
    expect(registry.readRegistry('DataDirectory')).toBeNull()
  })

  it('a failure is logged once per kind until the file reads again', async () => {
    h.files.set(BRAND, '{ damaged')
    const { registry, warned } = await load()
    for (let i = 0; i < 3; i++) expect(registry.readRegistry('DataDirectory')).toBeNull()
    expect(registry.writeRegistry('DataDirectory', '/ccc-test/data')).toBe(false)
    expect(warned()).toHaveLength(1)
    h.readFails.set(BRAND, 'EACCES')
    expect(registry.readRegistry('DataDirectory')).toBeNull()
    expect(warned()).toHaveLength(2)
    // It reads, then fails the first way again: said again.
    h.readFails.clear()
    h.files.set(BRAND, SAVED_TEXT)
    expect(registry.readRegistry('DataDirectory')).toBe('/ccc-test/data')
    h.files.set(BRAND, '{ damaged')
    expect(registry.readRegistry('DataDirectory')).toBe('/ccc-test/data')
    expect(warned()).toHaveLength(3)
  })
})

describe('macOS/Linux: whether the file is there and does not read, for a caller that has to say why a save was refused', () => {
  const unreadable = async () => {
    vi.resetModules()
    return (await import('../../../src/main/platform-config-store')).platformConfigUnreadable()
  }

  it('no file, a file with nothing in it and a file that reads: no', async () => {
    expect(await unreadable()).toBe(false)
    h.files.set(BRAND, '')
    expect(await unreadable()).toBe(false)
    h.files.set(BRAND, SAVED_TEXT)
    expect(await unreadable()).toBe(false)
    expectNothingSaved(new Map(h.files))
  })

  it.each([
    ['text that is not JSON', '{ damaged', null],
    ['a shape this version does not know', '[]', null],
    ['a file that cannot be opened', SAVED_TEXT, 'EACCES'],
  ])('%s: yes, and the look saves nothing', async (_what, text, readFails) => {
    h.files.set(BRAND, text)
    if (readFails) h.readFails.set(BRAND, readFails)
    const before = new Map(h.files)
    expect(await unreadable()).toBe(true)
    expectNothingSaved(before)
  })
})

describe('macOS/Linux: a setting is a name the file holds, with a text value', () => {
  it('a name every object has by inheritance is not a setting', async () => {
    h.files.set(BRAND, SAVED_TEXT)
    const { registry } = await load()
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(registry.readRegistry(name), name).toBeNull()
    }
  })

  it('a file that holds such a name as a setting keeps it through a write', async () => {
    h.files.set(BRAND, '{"__proto__":"kept","constructor":"kept too","DataDirectory":"/ccc-test/data"}')
    const { registry } = await load()
    expect(registry.readRegistry('__proto__')).toBe('kept')
    expect(registry.readRegistry('constructor')).toBe('kept too')
    expect(registry.writeRegistry('SourcePath', '/ccc-test/src')).toBe(true)
    const saved = h.files.get(BRAND)!
    expect(saved).toContain('"__proto__": "kept"')
    expect(JSON.parse(saved)).toMatchObject({ constructor: 'kept too', DataDirectory: '/ccc-test/data', SourcePath: '/ccc-test/src' })
  })
})
