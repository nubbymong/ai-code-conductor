import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// node's fs, with two faults that can be switched on for github-config.json
// only: the step that puts new bytes in place of the file fails part way, or
// the staged copy beside it cannot be written. Off, every call is the real one.
const h = vi.hoisted(() => {
  const state = { replaceFault: false, stageFault: false }
  const isConfig = (p: unknown): boolean => typeof p === 'string' && p.endsWith('github-config.json')
  const isStaged = (p: unknown): boolean => typeof p === 'string' && /github-config\.json\..*\.tmp$/.test(p)
  const errno = (code: string): Error => Object.assign(new Error(`${code}: simulated`), { code })
  const faultyFs = async (importOriginal: () => Promise<unknown>) => {
    const real = (await importOriginal()) as typeof import('node:fs')
    const promises = {
      ...real.promises,
      // An overwrite in place: half of the new bytes land, then it fails.
      copyFile: async (from: unknown, to: unknown) => {
        if (state.replaceFault && isConfig(to)) {
          const bytes = real.readFileSync(from as string)
          real.writeFileSync(to as string, bytes.subarray(0, Math.floor(bytes.length / 2)))
          throw errno('EIO')
        }
        return real.promises.copyFile(from as string, to as string)
      },
      rename: async (from: unknown, to: unknown) => {
        if (state.replaceFault && isConfig(to)) throw errno('EIO')
        return real.promises.rename(from as string, to as string)
      },
      writeFile: async (p: unknown, d: unknown, o: unknown) => {
        if (state.stageFault && isStaged(p)) throw errno('ENOSPC')
        return real.promises.writeFile(p as string, d as string, o as BufferEncoding)
      },
    }
    const patched = {
      ...real,
      promises,
      renameSync: (from: unknown, to: unknown) => {
        if (state.replaceFault && isConfig(to)) throw errno('EIO')
        return real.renameSync(from as string, to as string)
      },
      writeFileSync: (p: unknown, d: unknown, o: unknown) => {
        if (state.stageFault && isStaged(p)) throw errno('ENOSPC')
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
  GITHUB_CONFIG_UNREADABLE,
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

describe('GitHubConfigStore', () => {
  let tmp: string
  let store: GitHubConfigStore

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ghcfg-'))
    store = new GitHubConfigStore(tmp)
    h.state.replaceFault = false
    h.state.stageFault = false
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    h.state.replaceFault = false
    h.state.stageFault = false
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
  // file did not read" look the same to read() (null), and a writer that took
  // the second for the first saved defaults over every saved account.
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
      ['an empty file', ''],
      ['JSON that is not a config (null)', 'null'],
      ['JSON that is not a config (a list)', '[]'],
      ['JSON that is not a config (a number)', '42'],
      ['a config from a version this build does not know', JSON.stringify({ ...sample(), schemaVersion: 9999 })],
      ['a config with no version', JSON.stringify({ authProfiles: {} })],
    ])('%s is GitHubConfigUnreadableError, where read() is null, and the file is not touched', async (_what, text) => {
      await fs.writeFile(configPath(), text, 'utf8')
      await expect(store.readForWrite()).rejects.toBeInstanceOf(GitHubConfigUnreadableError)
      expect(await store.read()).toBeNull()
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

    it('the error says which file, never which folder', async () => {
      await fs.writeFile(configPath(), 'not json', 'utf8')
      const err = await store.readForWrite().then(() => null, (e: Error) => e)
      expect(err).toBeInstanceOf(GitHubConfigUnreadableError)
      expect(err!.message).toBe(GITHUB_CONFIG_UNREADABLE)
      expect(GITHUB_CONFIG_UNREADABLE).toBe(
        'The GitHub settings file (github-config.json) could not be read, so nothing was changed.',
      )
      expect(err!.message).not.toContain(path.basename(tmp))
    })
  })

  // No writer replaces a file from a newer build any more, so that file stays
  // and is read again and again. One copy of it is enough.
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

  describe('a write that fails part way', () => {
    const configPath = () => path.join(tmp, 'github-config.json')

    it('at the step that replaces the file: the old file stays whole, nothing staged is left', async () => {
      await store.write(sample())
      const before = await fs.readFile(configPath(), 'utf8')
      const next = sample()
      next.enabledByDefault = true
      h.state.replaceFault = true
      await expect(store.write(next)).rejects.toThrow(/EIO/)
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
      await expect(store.write(next)).rejects.toThrow(/ENOSPC/)
      expect(await fs.readFile(configPath(), 'utf8')).toBe(before)
      expect(await fs.readdir(tmp)).toEqual(['github-config.json'])
    })

    it('the first write of all failing leaves no file and nothing staged', async () => {
      h.state.replaceFault = true
      await expect(store.write(sample())).rejects.toThrow(/EIO/)
      expect(await fs.readdir(tmp)).toEqual([])
      expect(await store.read()).toBeNull()
    })

    it('a write after the fault is gone goes through', async () => {
      await store.write(sample())
      h.state.replaceFault = true
      await expect(store.write(sample())).rejects.toThrow(/EIO/)
      h.state.replaceFault = false
      const next = sample()
      next.enabledByDefault = true
      await store.write(next)
      expect(await store.read()).toEqual(next)
      expect(await fs.readdir(tmp)).toEqual(['github-config.json'])
    })
  })
})
