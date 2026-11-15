import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// node's fs, with faults that can be switched on for github-config.json only.
// Off, every call is the real one.
//   - replaceFault / stageFault: the step that puts new bytes in place of the
//     file fails, or the staged copy beside it cannot be written;
//   - readTexts: the next reads of the file answer these texts, in order,
//     whatever is on disk;
//   - readCodes: the reads after those fail with these errno codes, in order;
//   - reads: every read of the file that was tried;
//   - lstat: looking at the file (not reading it) fails with this errno code;
//   - backupFault: the copy kept of an unknown-schema file cannot be written;
//   - renameCodes: the next renames onto the file fail with these codes, in
//     order, and `renames` counts every rename that was tried;
//   - staged / backups: the options each staged copy and each backup copy was
//     made with.
const h = vi.hoisted(() => {
  const state = {
    replaceFault: false,
    stageFault: false,
    readTexts: [] as string[],
    readCodes: [] as string[],
    reads: 0,
    lstat: null as string | null,
    backupFault: false,
    renameCodes: [] as string[],
    renames: 0,
    staged: [] as Array<{ mode?: number; flag?: string } | undefined>,
    backups: [] as Array<{ mode?: number; flag?: string } | string | undefined>,
  }
  const isConfig = (p: unknown): boolean => typeof p === 'string' && p.endsWith('github-config.json')
  const isStaged = (p: unknown): boolean => typeof p === 'string' && /github-config\.json\..*\.tmp$/.test(p)
  const isBackup = (p: unknown): boolean => typeof p === 'string' && /github-config\.json\.v.*\.bak$/.test(p)
  // As node words them: the code, then the call and the full path.
  const errno = (code: string, p: unknown = ''): Error =>
    Object.assign(new Error(`${code}: simulated, open '${String(p)}'`), { code })
  const faultyFs = async (importOriginal: () => Promise<unknown>) => {
    const real = (await importOriginal()) as typeof import('node:fs')
    const promises = {
      ...real.promises,
      readFile: async (p: unknown, o: unknown) => {
        if (isConfig(p)) {
          state.reads++
          if (state.readTexts.length > 0) return state.readTexts.shift()!
          if (state.readCodes.length > 0) throw errno(state.readCodes.shift()!, p)
        }
        return real.promises.readFile(p as string, o as BufferEncoding)
      },
      lstat: async (p: unknown) => {
        if (isConfig(p) && state.lstat) throw errno(state.lstat, p)
        return real.promises.lstat(p as string)
      },
      // An overwrite in place: half of the new bytes land, then it fails.
      copyFile: async (from: unknown, to: unknown) => {
        if (state.replaceFault && isConfig(to)) {
          const bytes = real.readFileSync(from as string)
          real.writeFileSync(to as string, bytes.subarray(0, Math.floor(bytes.length / 2)))
          throw errno('EIO', to)
        }
        return real.promises.copyFile(from as string, to as string)
      },
      rename: async (from: unknown, to: unknown) => {
        if (state.replaceFault && isConfig(to)) throw errno('EIO', to)
        return real.promises.rename(from as string, to as string)
      },
      writeFile: async (p: unknown, d: unknown, o: unknown) => {
        if (isBackup(p)) state.backups.push(o as { mode?: number; flag?: string } | string | undefined)
        if (state.backupFault && isBackup(p)) throw errno('EACCES', p)
        if (state.stageFault && isStaged(p)) throw errno('ENOSPC', p)
        return real.promises.writeFile(p as string, d as string, o as BufferEncoding)
      },
    }
    const patched = {
      ...real,
      promises,
      renameSync: (from: unknown, to: unknown) => {
        if (isConfig(to)) {
          state.renames++
          if (state.renameCodes.length > 0) throw errno(state.renameCodes.shift()!, to)
          if (state.replaceFault) throw errno('EIO', to)
        }
        return real.renameSync(from as string, to as string)
      },
      writeFileSync: (p: unknown, d: unknown, o: unknown) => {
        if (isStaged(p)) state.staged.push(o as { mode?: number; flag?: string } | undefined)
        if (state.stageFault && isStaged(p)) throw errno('ENOSPC', p)
        return real.writeFileSync(p as string, d as string, o as BufferEncoding)
      },
    }
    return { ...patched, default: patched }
  }
  return { state, faultyFs }
})
vi.mock('fs', h.faultyFs)
vi.mock('node:fs', h.faultyFs)

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  GitHubConfigStore,
  GitHubConfigUnreadableError,
  GitHubConfigWriteError,
  GITHUB_CONFIG_UNREADABLE,
  GITHUB_CONFIG_NOT_SAVED,
  FAILED_READ_HOLD_MS,
} from '../../../src/main/github/github-config-store'
import {
  GITHUB_CONFIG_SCHEMA_VERSION,
  DEFAULT_SYNC_INTERVALS,
  DEFAULT_FEATURE_TOGGLES,
} from '../../../src/shared/github-constants'

function sample() {
  return {
    schemaVersion: GITHUB_CONFIG_SCHEMA_VERSION,
    authProfiles: {},
    featureToggles: { ...DEFAULT_FEATURE_TOGGLES },
    syncIntervals: { ...DEFAULT_SYNC_INTERVALS },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

/** Every fault off, every count back to nothing. */
function resetFaults(): void {
  h.state.replaceFault = false
  h.state.stageFault = false
  h.state.readTexts = []
  h.state.readCodes = []
  h.state.reads = 0
  h.state.lstat = null
  h.state.backupFault = false
  h.state.renameCodes = []
  h.state.renames = 0
  h.state.staged = []
  h.state.backups = []
}

/** Each thing console.warn was given, as one line. */
const warnLines = (): string[] =>
  (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((args) => args.map(String).join(' '))
/** Everything console.warn was given, as one text. */
const warned = (): string => warnLines().join(' | ')

describe('GitHubConfigStore', () => {
  let tmp: string
  let store: GitHubConfigStore

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ghcfg-'))
    store = new GitHubConfigStore(tmp)
    resetFaults()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    resetFaults()
    vi.restoreAllMocks()
  })

  it('read returns null when missing', async () => {
    expect(await store.read()).toBeNull()
  })

  it('round-trips', async () => {
    await store.write(sample())
    expect(await store.read()).toEqual(sample())
  })

  it('atomic write leaves only final file', async () => {
    await store.write(sample())
    const entries = await fs.readdir(tmp)
    expect(entries).toEqual(['github-config.json'])
  })

  it('corrupt JSON → null', async () => {
    await fs.writeFile(path.join(tmp, 'github-config.json'), 'not json', 'utf8')
    expect(await store.read()).toBeNull()
  })

  it('unknown schemaVersion → null AND backs up file before any write clobbers it', async () => {
    const payload = JSON.stringify({ schemaVersion: 9999, mine: 'data' })
    const configPath = path.join(tmp, 'github-config.json')
    await fs.writeFile(configPath, payload, 'utf8')
    expect(await store.read()).toBeNull()
    // Backup must exist with original contents preserved. Filename prefix is
    // deterministic but includes a uniqueness suffix (see retention test below).
    const entries = await fs.readdir(tmp)
    const backup = entries.find((e) => e.startsWith('github-config.json.v9999.'))
    expect(backup).toBeDefined()
    expect(backup!.endsWith('.bak')).toBe(true)
    expect(await fs.readFile(path.join(tmp, backup!), 'utf8')).toBe(payload)
  })

  it('serializes concurrent writes without truncation or lost tmp files', async () => {
    const writes = Array.from({ length: 10 }, (_, i) => {
      const c = sample()
      c.enabledByDefault = i % 2 === 0
      return store.write(c)
    })
    await Promise.all(writes)
    // Only the final config file should remain — no leaked `.tmp` files.
    const entries = await fs.readdir(tmp)
    expect(entries).toEqual(['github-config.json'])
    // File must be valid JSON (not a half-written / interleaved blob).
    const raw = await fs.readFile(path.join(tmp, 'github-config.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('write succeeds when destination file already exists (Windows cross-platform)', async () => {
    // fs.rename(tmp, dest) fails on Windows when dest exists. Repeated writes
    // must overwrite reliably — regression guard so the store never breaks
    // on the second save.
    await store.write(sample())
    const a = sample()
    a.enabledByDefault = true
    await store.write(a)
    const b = sample()
    b.enabledByDefault = false
    await store.write(b)
    const raw = await fs.readFile(path.join(tmp, 'github-config.json'), 'utf8')
    expect(JSON.parse(raw).enabledByDefault).toBe(false)
    // No leaked tmp files.
    const entries = await fs.readdir(tmp)
    expect(entries).toEqual(['github-config.json'])
  })

  it('backup filename is NOT influenced by attacker-controlled schemaVersion (path traversal)', async () => {
    // Attacker writes a config with schemaVersion containing path separators.
    // Must NOT land outside the store's directory. The store lives two levels
    // inside a dedicated sandbox so a successful `../../` traversal would land
    // INSIDE the sandbox — never scan the shared OS temp dir, where unrelated
    // random-suffix filenames can collide with the probe string.
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'ghcfg-trav-'))
    const storeDir = path.join(sandbox, 'a', 'b')
    await fs.mkdir(storeDir, { recursive: true })
    const trapStore = new GitHubConfigStore(storeDir)
    // Three `..` needed for a real escape: the filename template prefixes the
    // value with `github-config.json.v`, so the FIRST `..` merges into that
    // segment and only the rest traverse. With two, an unsanitized name would
    // normalize to a file INSIDE storeDir and the escape assertion proves nothing.
    const hostile = JSON.stringify({ schemaVersion: '../../../pwn', data: 'x' })
    await fs.writeFile(path.join(storeDir, 'github-config.json'), hostile, 'utf8')
    expect(await trapStore.read()).toBeNull()
    // Outside the store dir, the sandbox must contain exactly the directory
    // skeleton we created — nothing escaped.
    const outside = (await fs.readdir(sandbox, { recursive: true }))
      .map(String)
      .filter((e) => !e.startsWith(path.join('a', 'b') + path.sep))
    expect(outside.sort()).toEqual(['a', path.join('a', 'b')])
    // Inside the store dir the backup name must be the SANITIZED form — a
    // non-integer schemaVersion maps to 'unknown', never to attacker text.
    const entries = await fs.readdir(storeDir)
    const backup = entries.find((e) => e.includes('.bak'))
    expect(backup).toBeDefined()
    expect(backup!.startsWith('github-config.json.vunknown.')).toBe(true)
    expect(backup).not.toMatch(/\.\./)
    expect(backup).not.toMatch(/[\\/]/)
  })

  it('backup writes do not overwrite previous backups of the same schema version', async () => {
    // Multiple reads against an unknown schema must keep each backup, not
    // overwrite the first one (data preservation on corruption).
    const payload1 = JSON.stringify({ schemaVersion: 9999, gen: 1 })
    await fs.writeFile(path.join(tmp, 'github-config.json'), payload1, 'utf8')
    await store.read()
    // Simulate a second unknown-schema file a moment later.
    await new Promise((r) => setTimeout(r, 5))
    const payload2 = JSON.stringify({ schemaVersion: 9999, gen: 2 })
    await fs.writeFile(path.join(tmp, 'github-config.json'), payload2, 'utf8')
    await store.read()
    const entries = await fs.readdir(tmp)
    const backups = entries.filter((e) => e.includes('.bak'))
    expect(backups.length).toBeGreaterThanOrEqual(2)
  })

  // A writer reads the file to change it and save it back. "No file" and "the
  // file did not read" look the same to read() (null); readForWrite() tells
  // them apart, so a writer never starts from defaults in place of a file it
  // could not read.
  describe('readForWrite: what a writer starts from', () => {
    const configPath = () => path.join(tmp, 'github-config.json')

    it('no file is null: the first write makes it', async () => {
      expect(await store.readForWrite()).toBeNull()
    })

    it('a file that reads is the config, as read() gives it', async () => {
      await store.write(sample())
      expect(await store.readForWrite()).toEqual(sample())
      expect(await store.readForWrite()).toEqual(await store.read())
    })

    it.each([
      ['text that is not JSON', 'not json'],
      ['a file cut short', JSON.stringify(sample(), null, 2).slice(0, 60)],
      ['NUL characters, then a file cut short', '\0\0\0' + JSON.stringify(sample(), null, 2).slice(0, 60)],
      ['JSON that is not a config (null)', 'null'],
      ['JSON that is not a config (a list)', '[]'],
      ['JSON that is not a config (a number)', '42'],
      ['a config from a version this build does not know', JSON.stringify({ ...sample(), schemaVersion: 9999 })],
      ['a config with no version', JSON.stringify({ authProfiles: {} })],
    ])('%s is GitHubConfigUnreadableError, where read() is null, and the file is not touched', async (_what, text) => {
      await fs.writeFile(configPath(), text, 'utf8')
      await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
      expect(await store.read()).toBeNull()
      expect(await store.readState()).toEqual({ config: null, readFailed: true })
      expect(await fs.readFile(configPath(), 'utf8')).toBe(text)
    })

    it('something that cannot be opened as a file is GitHubConfigUnreadableError, where read() is null', async () => {
      // A folder where the file should be: a real read error that is not "no file".
      await fs.mkdir(configPath())
      await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
      expect(await store.read()).toBeNull()
    })

    it('a byte-order mark an editor put before the text is passed over', async () => {
      await fs.writeFile(configPath(), String.fromCharCode(0xfeff) + JSON.stringify(sample(), null, 2), 'utf8')
      expect(await store.readForWrite()).toEqual(sample())
      expect(await store.read()).toEqual(sample())
    })

    it('the error says which file and what to do next, never which folder', async () => {
      await fs.writeFile(configPath(), 'not json', 'utf8')
      const err = await store.readForWrite().then(() => null, (e: Error) => e)
      expect(err).toBeInstanceOf(GitHubConfigUnreadableError)
      expect(err!.message).toBe(GITHUB_CONFIG_UNREADABLE)
      expect(GITHUB_CONFIG_UNREADABLE).toBe(
        'The GitHub settings file (github-config.json) could not be read, so nothing was changed. '
          + 'Close other programs that may be using it, or move github-config.json out of the CONFIG folder '
          + 'in the AI Code Conductor resources folder and sign in to GitHub again.',
      )
      expect(err!.message).not.toContain(path.basename(tmp))
      expect(err!.message).not.toMatch(/[\\/]/)
    })
  })

  // A file with nothing in it holds no account, so there is nothing a refusal
  // would protect, and a write cut off by a power loss can leave one. It is
  // taken as no file: the first write replaces it.
  describe('a file with nothing in it is taken as no file', () => {
    const configPath = () => path.join(tmp, 'github-config.json')
    const BOM = String.fromCharCode(0xfeff)

    it.each([
      ['no bytes at all', ''],
      ['only white space', ' \t\r\n\n  '],
      ['only NUL characters', '\0'.repeat(512)],
      ['only a byte-order mark', BOM],
      ['a byte-order mark, NUL characters and white space', BOM + '\0\0\0 \r\n\0'],
    ])('%s: readers and writers get null, and the first write replaces it', async (_what, text) => {
      await fs.writeFile(configPath(), text, 'utf8')
      expect(await store.read()).toBeNull()
      expect(await store.readForWrite()).toBeNull()
      expect(await store.readState()).toEqual({ config: null, readFailed: false })
      // Reading it changed nothing and made no backup.
      expect(await fs.readFile(configPath(), 'utf8')).toBe(text)
      expect(await fs.readdir(tmp)).toEqual(['github-config.json'])

      await store.write(sample())
      expect(await store.read()).toEqual(sample())
      expect(await fs.readdir(tmp)).toEqual(['github-config.json'])
    })
  })

  // What a page that shows the settings asks: the config, and whether the
  // file read. "No file" and "did not read" are both `config: null` and differ
  // in `readFailed`.
  describe('readState: the config and whether the file read', () => {
    it('no file: no config, and nothing failed', async () => {
      expect(await store.readState()).toEqual({ config: null, readFailed: false })
    })

    it('a file that reads: the config', async () => {
      await store.write(sample())
      expect(await store.readState()).toEqual({ config: sample(), readFailed: false })
    })

    it('a file that did not read: no config, and readFailed', async () => {
      await fs.writeFile(path.join(tmp, 'github-config.json'), 'not json', 'utf8')
      expect(await store.readState()).toEqual({ config: null, readFailed: true })
    })
  })

  // One "no such file" answer is not taken as proof that there is no file:
  // the path is looked at once more, and a file that is there after all means
  // the read failed.
  describe('a read that says there is no file', () => {
    it('while the file is there: the read failed, it is not "no file"', async () => {
      await store.write(sample())
      h.state.readCodes = ['ENOENT']
      await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
      h.state.readCodes = ['ENOENT']
      expect(await store.readState()).toEqual({ config: null, readFailed: true })
      h.state.readCodes = ['ENOENT']
      expect(await store.read()).toBeNull()
      // The file was not touched, and reads again once the fault is gone.
      expect(await store.readForWrite()).toEqual(sample())
    })

    it('and no file is there: it is "no file"', async () => {
      expect(await store.readForWrite()).toBeNull()
      expect(await store.readState()).toEqual({ config: null, readFailed: false })
    })

    it('and the path cannot be looked at either: the read failed', async () => {
      h.state.lstat = 'EACCES'
      await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
      expect(await store.readState()).toEqual({ config: null, readFailed: true })
      expect(await fs.readdir(tmp)).toEqual([])
    })
  })

  // One read that gives nothing is not taken as proof that the file has
  // nothing in it either (another program can be part way through writing
  // it): the file is read once more, and only the same nothing a second time
  // is "no file".
  describe('a read that says the file has nothing in it', () => {
    const configPath = () => path.join(tmp, 'github-config.json')
    const UNCONFIRMED = '[github-config] read failed: the file read as empty, and a second look did not confirm it'

    it.each([
      ['no bytes', ''],
      ['NUL characters', '\0\0\0\0'],
    ])('and says the same again (%s): it is "no file", from two reads', async (_what, nothing) => {
      await store.write(sample())
      h.state.reads = 0
      h.state.readTexts = [nothing, nothing]
      expect(await store.readState()).toEqual({ config: null, readFailed: false })
      expect(h.state.reads).toBe(2)
      h.state.readTexts = [nothing, nothing]
      expect(await store.readForWrite()).toBeNull()
      expect(warned()).toBe('')
    })

    it.each([
      ['the text is there after all', '', () => JSON.stringify(sample(), null, 2)],
      ['there is text that is not JSON', '', () => 'not json'],
      ['the nothing has grown', '', () => ' '],
      ['the nothing has shrunk', '\0\0\0\0', () => '\0\0'],
    ] as Array<[string, string, () => string]>)(
      'and on the second look %s: the read failed, it is not "no file"',
      async (_what, first, second) => {
        await store.write(sample())
        h.state.readTexts = [first, second()]
        await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
        h.state.readTexts = [first, second()]
        expect(await store.readState()).toEqual({ config: null, readFailed: true })
        h.state.readTexts = [first, second()]
        expect(await store.read()).toBeNull()
        expect(h.state.readTexts).toEqual([])
        expect(warned()).toBe(UNCONFIRMED)
        // The file was not touched, and reads again once the fault is gone.
        expect(await store.readForWrite()).toEqual(sample())
      },
    )

    it.each(['EBUSY', 'ENOENT'])('and the second read fails (%s): the read failed', async (code) => {
      await store.write(sample())
      h.state.readTexts = ['']
      h.state.readCodes = [code]
      await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
      h.state.readTexts = ['']
      h.state.readCodes = [code]
      expect(await store.readState()).toEqual({ config: null, readFailed: true })
      expect(h.state.readCodes).toEqual([])
      expect(warned()).toBe(UNCONFIRMED)
      expect(await fs.readdir(tmp)).toEqual(['github-config.json'])
      expect(await store.readForWrite()).toEqual(sample())
    })
  })

  // The timers of the sync, the notifications and the AI-usage meter ask with
  // lookupState. After a read that failed, the failed answer stands in for
  // FAILED_READ_HOLD_MS, so a file that stays unreadable is read once per
  // hold for all of them and not once per lookup. It is never kept longer,
  // and any read that succeeds ends the hold at once.
  describe('lookupState: a read that failed is held for a short while', () => {
    const configPath = () => path.join(tmp, 'github-config.json')
    const FAILED = { config: null, readFailed: true }
    const READ = { config: sample(), readFailed: false }
    let now: number

    beforeEach(async () => {
      now = 1_700_000_000_000
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      await store.write(sample())
      h.state.reads = 0
    })

    /** From here on the file does not read. */
    const unreadable = (code = 'EBUSY'): void => {
      h.state.readCodes = Array.from({ length: 200 }, () => code)
    }
    /** From here on it reads again. */
    const readable = (): void => {
      h.state.readCodes = []
    }
    const many = (n: number) => Promise.all(Array.from({ length: n }, () => store.lookupState()))

    it('the hold is half a minute', () => {
      expect(FAILED_READ_HOLD_MS).toBe(30_000)
    })

    it('a file that reads is read at every lookup: nothing is held', async () => {
      for (let i = 0; i < 3; i++) expect(await store.lookupState()).toEqual(READ)
      expect(h.state.reads).toBe(3)
    })

    it('many lookups inside the hold, one after another and at once, read the file once', async () => {
      unreadable()
      for (let i = 0; i < 10; i++) expect(await store.lookupState()).toEqual(FAILED)
      expect(await many(10)).toEqual(Array.from({ length: 10 }, () => FAILED))
      now += FAILED_READ_HOLD_MS - 1
      expect(await store.lookupState()).toEqual(FAILED)
      expect(h.state.reads).toBe(1)
    })

    it('lookups that arrive together, before anything was read, wait for the one read', async () => {
      unreadable()
      expect(await many(10)).toEqual(Array.from({ length: 10 }, () => FAILED))
      expect(h.state.reads).toBe(1)
    })

    it('after the hold the file is read again, once per hold', async () => {
      unreadable()
      await store.lookupState()
      now += FAILED_READ_HOLD_MS
      for (let i = 0; i < 5; i++) expect(await store.lookupState()).toEqual(FAILED)
      expect(await many(5)).toEqual(Array.from({ length: 5 }, () => FAILED))
      expect(h.state.reads).toBe(2)
      now += FAILED_READ_HOLD_MS
      expect(await store.lookupState()).toEqual(FAILED)
      expect(h.state.reads).toBe(3)
    })

    it('a file that reads again is answered at the first lookup after the hold, and nothing is held', async () => {
      unreadable()
      await store.lookupState()
      readable()
      // Inside the hold the failed answer still stands in: the file is not read.
      expect(await store.lookupState()).toEqual(FAILED)
      expect(h.state.reads).toBe(1)
      now += FAILED_READ_HOLD_MS
      expect(await store.lookupState()).toEqual(READ)
      expect(await store.lookupState()).toEqual(READ)
      expect(h.state.reads).toBe(3)
    })

    it.each([
      ['a settings page reads it (readState)', () => store.readState()],
      ['a writer reads it (readForWrite)', () => store.readForWrite()],
      ['a reader reads it (read)', () => store.read()],
    ] as Array<[string, () => Promise<unknown>]>)(
      'a read that succeeds inside the hold ends it at once: %s',
      async (_what, readIt) => {
        unreadable()
        expect(await store.lookupState()).toEqual(FAILED)
        readable()
        expect(await store.lookupState()).toEqual(FAILED)
        await readIt()
        expect(await store.lookupState()).toEqual(READ)
      },
    )

    it('a read that failed for any caller starts the hold', async () => {
      unreadable()
      await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
      expect(await store.lookupState()).toEqual(FAILED)
      expect(h.state.reads).toBe(1)
    })

    it('readState, read and readForWrite are never held: each one reads the file', async () => {
      unreadable()
      await store.lookupState()
      expect(await store.readState()).toEqual(FAILED)
      expect(await store.read()).toBeNull()
      await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
      expect(h.state.reads).toBe(4)
      readable()
      expect(await store.readState()).toEqual(READ)
    })

    it('"no file" is an answer that was read, never one that is held', async () => {
      await fs.rm(configPath())
      h.state.reads = 0
      for (let i = 0; i < 3; i++) expect(await store.lookupState()).toEqual({ config: null, readFailed: false })
      expect(h.state.reads).toBe(3)
      await store.write(sample())
      expect(await store.lookupState()).toEqual(READ)
    })

    it('endFailedReadHold: the next lookup reads the file now', async () => {
      unreadable()
      await store.lookupState()
      readable()
      expect(await store.lookupState()).toEqual(FAILED)
      store.endFailedReadHold()
      expect(await store.lookupState()).toEqual(READ)
      expect(h.state.reads).toBe(2)
    })

    it('endFailedReadHold on a file that still does not read: one more read, and the hold starts again', async () => {
      unreadable()
      await store.lookupState()
      store.endFailedReadHold()
      for (let i = 0; i < 5; i++) expect(await store.lookupState()).toEqual(FAILED)
      expect(h.state.reads).toBe(2)
    })

    it('a clock that was set back does not lengthen the hold: the file is read', async () => {
      unreadable()
      await store.lookupState()
      now -= 60 * 60 * 1000
      expect(await store.lookupState()).toEqual(FAILED)
      expect(h.state.reads).toBe(2)
    })
  })

  // A file that stays unreadable is read again and again: after each hold,
  // at each save the user tries, at each token lookup. The log says so once
  // per kind of failure, and starts over when a read succeeds.
  describe('a read that keeps failing is logged once per kind of failure, until a read succeeds', () => {
    const configPath = () => path.join(tmp, 'github-config.json')
    const readFailedLines = (): string[] => warnLines().filter((l) => l.includes('read failed'))
    /** One read of each sort, each of which fails. */
    async function readEachWay(): Promise<void> {
      expect(await store.read()).toBeNull()
      expect(await store.readState()).toEqual({ config: null, readFailed: true })
      await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
    }

    it('the same failure, however often and by whichever read: one line', async () => {
      await store.write(sample())
      h.state.readCodes = Array.from({ length: 6 }, () => 'EBUSY')
      await readEachWay()
      await readEachWay()
      expect(h.state.readCodes).toEqual([])
      expect(readFailedLines()).toEqual(['[github-config] read failed: Error EBUSY'])
    })

    it('each kind of failure has its own line, once', async () => {
      await store.write(sample())
      h.state.readCodes = ['EBUSY', 'EPERM', 'EBUSY', 'EPERM', 'ENOENT', 'ENOENT', 'EBUSY']
      for (let i = 0; i < 7; i++) expect(await store.read()).toBeNull()
      await fs.writeFile(configPath(), 'not json', 'utf8')
      for (let i = 0; i < 3; i++) expect(await store.read()).toBeNull()
      expect(readFailedLines()).toEqual([
        '[github-config] read failed: Error EBUSY',
        '[github-config] read failed: Error EPERM',
        '[github-config] read failed: the file was reported missing, and a second look did not confirm it',
        '[github-config] read failed: not valid JSON',
      ])
    })

    it.each([
      ['the config', async () => {}],
      ['"no file"', async () => { await fs.rm(configPath()) }],
    ] as Array<[string, () => Promise<void>]>)(
      'a read that succeeds (%s) starts over: the same failure after it is logged again',
      async (_what, arrange) => {
        await store.write(sample())
        h.state.readCodes = ['EBUSY', 'EBUSY']
        for (let i = 0; i < 2; i++) expect(await store.read()).toBeNull()
        await arrange()
        await store.readState()
        await store.write(sample())
        h.state.readCodes = ['EBUSY', 'EBUSY']
        for (let i = 0; i < 2; i++) expect(await store.read()).toBeNull()
        expect(readFailedLines()).toEqual([
          '[github-config] read failed: Error EBUSY',
          '[github-config] read failed: Error EBUSY',
        ])
      },
    )

    it('lookups inside the hold add no line', async () => {
      await store.write(sample())
      h.state.readCodes = Array.from({ length: 50 }, () => 'EBUSY')
      for (let i = 0; i < 20; i++) await store.lookupState()
      expect(readFailedLines()).toEqual(['[github-config] read failed: Error EBUSY'])
    })

    it('a copy of an unknown-schema file that cannot be made is logged once, and made once it can be', async () => {
      await fs.writeFile(configPath(), JSON.stringify({ schemaVersion: 9999, mine: 'data' }), 'utf8')
      h.state.backupFault = true
      for (let i = 0; i < 4; i++) expect(await store.read()).toBeNull()
      // Tried at every read, said once.
      expect(h.state.backups).toHaveLength(4)
      const lines = warnLines().filter((l) => l.includes('backup failed'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('[github-config] backup failed: Error: EACCES')
      expect((await fs.readdir(tmp)).filter((e) => e.endsWith('.bak'))).toEqual([])

      h.state.backupFault = false
      for (let i = 0; i < 2; i++) expect(await store.read()).toBeNull()
      expect((await fs.readdir(tmp)).filter((e) => e.endsWith('.bak'))).toHaveLength(1)
    })
  })

  // The log line for a read that failed names the kind of failure. It never
  // carries the error's own text: a JSON error quotes the characters around
  // the place it stopped, and those can be a saved token's ciphertext.
  describe('what the log says about a read that failed', () => {
    const configPath = () => path.join(tmp, 'github-config.json')
    // Stands in for a token's ciphertext, unquoted so the parse stops on it.
    const RUN = 'djEwQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY'

    it('text that is not JSON: "not valid JSON", and no part of the file', async () => {
      const text = `{"schemaVersion":1,"authProfiles":{"p":{"tokenCiphertext":${RUN}}}}`
      await fs.writeFile(configPath(), text, 'utf8')
      await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
      const log = warned()
      expect(log).toContain('[github-config] read failed: not valid JSON')
      for (let i = 0; i + 4 <= RUN.length; i++) expect(log).not.toContain(RUN.slice(i, i + 4))
      expect(log).not.toContain('tokenCiphertext')
    })

    it('a file that could not be opened: the name and code of the error, never its text or the path', async () => {
      await store.write(sample())
      h.state.readCodes = ['EBUSY']
      await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
      const log = warned()
      expect(log).toContain('[github-config] read failed: Error EBUSY')
      expect(log).not.toContain('simulated')
      expect(log).not.toContain(path.basename(tmp))
    })
  })

  // No writer replaces a file from a newer build, so that file stays and is
  // read again and again. One copy of it is enough.
  it('an unknown-schema file that stays is backed up once, however often it is read', async () => {
    await fs.writeFile(
      path.join(tmp, 'github-config.json'),
      JSON.stringify({ schemaVersion: 9999, mine: 'data' }),
      'utf8',
    )
    for (let i = 0; i < 3; i++) expect(await store.read()).toBeNull()
    for (let i = 0; i < 2; i++) {
      await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
    }
    const backups = (await fs.readdir(tmp)).filter((e) => e.endsWith('.bak'))
    expect(backups.length).toBe(1)
  })

  // A write that fails is raised as one fixed sentence (it can reach the
  // settings page); what failed, with its path, goes to the log.
  describe('a write that fails part way', () => {
    const configPath = () => path.join(tmp, 'github-config.json')

    /** The write is refused with the fixed sentence, and the cause is kept on it. */
    async function expectNotSaved(write: Promise<void>, code: string): Promise<void> {
      const err = await write.then(() => null, (e: Error) => e)
      expect(err).toBeInstanceOf(GitHubConfigWriteError)
      expect(err!.message).toBe(GITHUB_CONFIG_NOT_SAVED)
      expect(err!.message).not.toContain(path.basename(tmp))
      expect(err!.message).not.toMatch(/[\\/]/)
      expect((err!.cause as NodeJS.ErrnoException).code).toBe(code)
      // The detail is in the log.
      expect(warned()).toContain(`[github-config] write failed: Error: ${code}`)
    }

    it('the sentence names the file and what to do, never a folder', () => {
      expect(GITHUB_CONFIG_NOT_SAVED).toBe(
        'The GitHub settings file (github-config.json) could not be saved, so nothing was changed. '
          + 'Close other programs that may be using it and try again.',
      )
    })

    it('at the step that replaces the file: the old file stays whole, nothing staged is left', async () => {
      await store.write(sample())
      const before = await fs.readFile(configPath(), 'utf8')
      const next = sample()
      next.enabledByDefault = true
      h.state.replaceFault = true
      await expectNotSaved(store.write(next), 'EIO')
      expect(await fs.readFile(configPath(), 'utf8')).toBe(before)
      expect(await fs.readdir(tmp)).toEqual(['github-config.json'])
      // ...and it still reads, so the next writer starts from it.
      expect(await store.read()).toEqual(sample())
    })

    it('while the new bytes are being staged: the old file stays whole, nothing staged is left', async () => {
      await store.write(sample())
      const before = await fs.readFile(configPath(), 'utf8')
      const next = sample()
      next.enabledByDefault = true
      h.state.stageFault = true
      await expectNotSaved(store.write(next), 'ENOSPC')
      expect(await fs.readFile(configPath(), 'utf8')).toBe(before)
      expect(await fs.readdir(tmp)).toEqual(['github-config.json'])
    })

    it('the first write of all failing leaves no file and nothing staged', async () => {
      h.state.replaceFault = true
      await expectNotSaved(store.write(sample()), 'EIO')
      expect(await fs.readdir(tmp)).toEqual([])
      expect(await store.read()).toBeNull()
    })

    it('a write after the fault is gone goes through', async () => {
      await store.write(sample())
      h.state.replaceFault = true
      await expectNotSaved(store.write(sample()), 'EIO')
      h.state.replaceFault = false
      const next = sample()
      next.enabledByDefault = true
      await store.write(next)
      expect(await store.read()).toEqual(next)
      expect(await fs.readdir(tmp)).toEqual(['github-config.json'])
    })
  })

  // Another program (a scanner, an indexer) can hold the file for a moment, and
  // the rename onto it is refused until it lets go. The shared atomic write
  // waits and tries again; a save is not lost to that moment.
  describe('a rename onto the file that is refused for a moment', () => {
    const configPath = () => path.join(tmp, 'github-config.json')

    async function refusedTwiceThenThrough(code: string): Promise<void> {
      await store.write(sample())
      const next = sample()
      next.enabledByDefault = true
      h.state.renames = 0
      h.state.renameCodes = [code, code]
      await store.write(next)
      expect(h.state.renames).toBe(3)
      expect(JSON.parse(await fs.readFile(configPath(), 'utf8'))).toEqual(next)
      expect(await fs.readdir(tmp)).toEqual(['github-config.json'])
    }

    it('EBUSY twice, then through: the file holds the new bytes after three tries', async () => {
      await refusedTwiceThenThrough('EBUSY')
    })

    it.skipIf(process.platform !== 'win32')(
      'EPERM twice, then through (Windows): the file holds the new bytes after three tries',
      async () => {
        await refusedTwiceThenThrough('EPERM')
      },
    )

    it('refused every time: the write gives up, and the old file stays whole', async () => {
      await store.write(sample())
      const before = await fs.readFile(configPath(), 'utf8')
      const next = sample()
      next.enabledByDefault = true
      h.state.renames = 0
      h.state.renameCodes = Array.from({ length: 20 }, () => 'EBUSY')
      await expect(store.write(next)).rejects.toBeInstanceOf(GitHubConfigWriteError)
      // One try and the five waits the shared write allows.
      expect(h.state.renames).toBe(6)
      expect(await fs.readFile(configPath(), 'utf8')).toBe(before)
      expect(await fs.readdir(tmp)).toEqual(['github-config.json'])
    })
  })

  // The file holds each account's token ciphertext, so it is written the way
  // the app's other secret files are: the staged copy is created for the
  // owner alone and renamed into place, whatever mode the old file had.
  describe('the file is written for the owner alone', () => {
    const configPath = () => path.join(tmp, 'github-config.json')
    const OWNER_ONLY = 0o600

    it('the staged copy is created owner-only and exclusively, with or without a file there', async () => {
      await store.write(sample())
      await store.write(sample())
      expect(h.state.staged).toHaveLength(2)
      for (const made of h.state.staged) {
        expect(made?.mode).toBe(OWNER_ONLY)
        expect(made?.flag).toBe('wx')
      }
    })

    it('the copy kept of an unknown-schema file is created owner-only and exclusively', async () => {
      await fs.writeFile(configPath(), JSON.stringify({ schemaVersion: 9999, mine: 'data' }), 'utf8')
      expect(await store.read()).toBeNull()
      expect(h.state.backups).toHaveLength(1)
      expect(h.state.backups[0]).toMatchObject({ mode: OWNER_ONLY, flag: 'wx' })
    })

    it.skipIf(process.platform === 'win32')(
      'on disk (macOS, Linux): the first write makes the file 0600',
      async () => {
        await store.write(sample())
        expect((await fs.stat(configPath())).mode & 0o777).toBe(OWNER_ONLY)
      },
    )

    it.skipIf(process.platform === 'win32')(
      'on disk (macOS, Linux): a file that was readable by others is 0600 after the next write',
      async () => {
        await fs.writeFile(configPath(), JSON.stringify(sample(), null, 2), 'utf8')
        await fs.chmod(configPath(), 0o644)
        const next = sample()
        next.enabledByDefault = true
        await store.write(next)
        expect((await fs.stat(configPath())).mode & 0o777).toBe(OWNER_ONLY)
        expect(await store.read()).toEqual(next)
      },
    )

    it.skipIf(process.platform === 'win32')(
      'on disk (macOS, Linux): the copy kept of an unknown-schema file is 0600',
      async () => {
        await fs.writeFile(configPath(), JSON.stringify({ schemaVersion: 9999, mine: 'data' }), 'utf8')
        await fs.chmod(configPath(), 0o644)
        expect(await store.read()).toBeNull()
        const backup = (await fs.readdir(tmp)).find((e) => e.endsWith('.bak'))
        expect(backup).toBeDefined()
        expect((await fs.stat(path.join(tmp, backup!))).mode & 0o777).toBe(OWNER_ONLY)
      },
    )
  })
})
