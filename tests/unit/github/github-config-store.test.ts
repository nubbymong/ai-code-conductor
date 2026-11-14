import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// node's fs, with faults that can be switched on for github-config.json only.
// Off, every call is the real one.
//   - replaceFault / stageFault: the step that puts new bytes in place of the
//     file fails, or the staged copy beside it cannot be written;
//   - readCodes: the next reads of the file fail with these errno codes, in order;
//   - lstat: looking at the file (not reading it) fails with this errno code;
//   - renameCodes: the next renames onto the file fail with these codes, in
//     order, and `renames` counts every rename that was tried;
//   - staged / backups: the options each staged copy and each backup copy was
//     made with.
const h = vi.hoisted(() => {
  const state = {
    replaceFault: false,
    stageFault: false,
    readCodes: [] as string[],
    lstat: null as string | null,
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
        if (isConfig(p) && state.readCodes.length > 0) throw errno(state.readCodes.shift()!, p)
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
  h.state.readCodes = []
  h.state.lstat = null
  h.state.renameCodes = []
  h.state.renames = 0
  h.state.staged = []
  h.state.backups = []
}

/** Everything console.warn was given, as one text. */
const warned = (): string =>
  (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((args) => args.map(String).join(' '))
    .join(' | ')

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
