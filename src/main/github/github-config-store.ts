import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GitHubConfig, GitHubConfigReadState } from '../../shared/github-types'
import {
  GITHUB_CONFIG_SCHEMA_VERSION,
  CACHE_CORRUPT_BACKUPS_KEEP,
  GITHUB_CONFIG_UNREADABLE,
  GITHUB_CONFIG_NOT_SAVED,
} from '../../shared/github-constants'
import { redactTokens } from './security/token-redactor'
import { AsyncMutex } from './async-mutex'
import { atomicWriteSecure } from '../account-profiles'

const FILENAME = 'github-config.json'

// The two sentences a refused change is answered with. They live in
// shared/github-constants.ts, the one copy main and the settings pages share.
export { GITHUB_CONFIG_UNREADABLE, GITHUB_CONFIG_NOT_SAVED }

/**
 * The file holds each account's token ciphertext (encrypted with the OS
 * keychain), so it and every copy of it are made for the owner alone, as the
 * app's other secret files are (config-manager's secret keys, the credential
 * files in account-profiles). A mode is honoured only when a file is created,
 * and both the staged copy and the backup copy are created fresh, so the mode
 * holds whatever mode the file being replaced has. Windows has no such modes
 * and ignores it.
 */
const OWNER_ONLY_MODE = 0o600

/** A text with nothing in it: no characters, or only a byte-order mark, white
 *  space and NUL characters (`\s` covers the byte-order mark). */
const NOTHING_IN_IT = /^[\s\0]*$/

/**
 * github-config.json is there but did not read (it could not be opened, is
 * not JSON, or is from a version this build does not know), so nothing was
 * written.
 *
 * `read()` answers such a file with null, the same as no file at all, which is
 * right for a caller that only shows what is there. A caller that will save
 * something back reads with `readForWrite()`, which raises this, so it never
 * takes "did not read" for "no file" and starts from the defaults.
 */
export class GitHubConfigUnreadableError extends Error {
  constructor() {
    super(GITHUB_CONFIG_UNREADABLE)
  }
}

/**
 * The file read, and the save of the change then failed. The save stages a
 * copy and renames it over the file, so the file is as it was. The message is
 * the fixed sentence (it can reach the settings page, which must not be handed
 * a filesystem path); what failed is kept as `cause` and written to the log.
 */
export class GitHubConfigWriteError extends Error {
  constructor(cause: unknown) {
    super(GITHUB_CONFIG_NOT_SAVED, { cause })
  }
}

/**
 * What the log says about a read that failed: the kind of failure, never the
 * error's own text. A JSON error's text quotes the characters around the place
 * the parse stopped, which in this file can be a token's ciphertext, and a
 * file error's text carries the full path.
 */
function readFailure(err: unknown): string {
  if (err instanceof SyntaxError) return 'not valid JSON'
  const e = err as { name?: unknown; code?: unknown } | null
  // An error's name and errno code are short words (Error, EBUSY); anything
  // else in their place is left out.
  const word = (v: unknown): string | null =>
    typeof v === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(v) ? v : null
  const name = word(e?.name) ?? 'Error'
  const code = word(e?.code)
  return code ? `${name} ${code}` : name
}

/**
 * Sanitizes an untrusted schemaVersion value for use in a backup filename.
 * Accepts non-negative integer values; anything else becomes 'unknown'.
 * Prevents path traversal via attacker-controlled JSON that sets schemaVersion
 * to '../../etc' or similar.
 */
function sanitizeSchemaVersionForFilename(raw: unknown): string {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return String(raw)
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) return raw
  return 'unknown'
}

export class GitHubConfigStore {
  private mutex = new AsyncMutex()
  /** The unknown-schema file text this store last backed up (see
   *  backupUnknownSchemaFile). */
  private backedUp: string | null = null

  constructor(private dir: string) {}
  private get filePath() {
    return path.join(this.dir, FILENAME)
  }

  /**
   * The one read of the file, which every read below goes through: the
   * config, 'missing' when there is no file, or 'unreadable' for everything
   * else (it could not be opened, is not JSON, or is from a version this
   * build does not know). A byte-order mark an editor put before the text is
   * passed over.
   *
   * A file with nothing in it is 'missing' too. It holds no account, so there
   * is nothing a refusal would protect, and a write cut off by a power loss
   * can leave one: the first write replaces it. A file with text in it that is
   * cut short stays 'unreadable'.
   */
  private async load(): Promise<GitHubConfig | 'missing' | 'unreadable'> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (await this.reallyMissing()) return 'missing'
        console.warn('[github-config] read failed: the file was reported missing, and a second look did not confirm it')
        return 'unreadable'
      }
      console.warn('[github-config] read failed:', readFailure(err))
      return 'unreadable'
    }
    if (NOTHING_IN_IT.test(raw)) return 'missing'
    try {
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
      if (parsed.schemaVersion !== GITHUB_CONFIG_SCHEMA_VERSION) {
        await this.backupUnknownSchemaFile(raw, parsed.schemaVersion)
        return 'unreadable'
      }
      return parsed as GitHubConfig
    } catch (err) {
      console.warn('[github-config] read failed:', readFailure(err))
      return 'unreadable'
    }
  }

  /**
   * Whether there is no file, asked once more after a read said so. One "no
   * such file" answer is not taken as proof (a file being replaced, or held by
   * another program, can answer that for a moment): the path is looked at
   * again, and only a second "no such file" is "no file". A file that is there
   * after all, or a path that cannot be looked at, is a read that failed.
   */
  private async reallyMissing(): Promise<boolean> {
    try {
      await fs.lstat(this.filePath)
      return false
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }

  /**
   * The config for a caller that only READS it: null when there is no file,
   * and null when the file did not read, so the panel still renders. Never
   * save a config built from this null: a writer reads with `readForWrite()`.
   */
  async read(): Promise<GitHubConfig | null> {
    return (await this.readState()).config
  }

  /**
   * The config, and whether the file is there but did not read. For a caller
   * that has to tell "no file yet" from "could not read it": the settings
   * pages (which must not offer defaults as if they were the saved settings)
   * and the sync's cache (which must not remember a failed read as "no
   * accounts").
   */
  async readState(): Promise<GitHubConfigReadState> {
    // On the same mutex as write(), so reads and writes take turns.
    // AsyncMutex is exclusive (no reader/writer split), so reads also
    // serialize against other reads. That's acceptable here: a read is
    // made O(1)-ish per feature event (app start, profile list, after a
    // push), not on a hot path.
    return this.mutex.run(async () => {
      const got = await this.load()
      return typeof got === 'string'
        ? { config: null, readFailed: got === 'unreadable' }
        : { config: got, readFailed: false }
    })
  }

  /**
   * The config as a write would start from it: null ONLY when there is no
   * file yet (first run; the first write makes it). A file that is there but
   * did not read is GitHubConfigUnreadableError, never null, so a writer
   * cannot take it for "no file", start from defaults and save them over the
   * saved accounts.
   */
  async readForWrite(): Promise<GitHubConfig | null> {
    return this.mutex.run(async () => {
      const got = await this.load()
      if (got === 'unreadable') throw new GitHubConfigUnreadableError()
      return got === 'missing' ? null : got
    })
  }

  /**
   * Save the config. A failure is raised as GitHubConfigWriteError (the fixed
   * sentence), with the file left as it was.
   */
  async write(config: GitHubConfig): Promise<void> {
    await this.mutex.run(async () => {
      try {
        // The owner-only secure write the app's other account and secret files
        // use (atomicWriteSecure, over atomic-write.ts): the new bytes are
        // staged beside the file under a random name, created exclusively and
        // for the owner alone, then renamed over it, with the short retry
        // Windows needs while a scanner holds the file. A write that fails
        // part way removes its staging file and leaves the old file whole; it
        // never leaves a half-written one. The file that results always has
        // the owner-only mode, so the mode of the file it replaces is not
        // read or carried over.
        atomicWriteSecure(this.filePath, JSON.stringify(config, null, 2), OWNER_ONLY_MODE)
      } catch (err) {
        console.warn('[github-config] write failed:', redactTokens(String(err)))
        throw new GitHubConfigWriteError(err)
      }
    })
  }

  private async backupUnknownSchemaFile(raw: string, schemaVersion: unknown): Promise<void> {
    // Unknown schema → likely written by a newer app version. Keep a copy of
    // the original file beside it. No writer replaces such a file
    // (readForWrite refuses it), so the copy is a second line of defence.
    //
    // The file therefore stays, and is read again and again: one copy of the
    // same text per run is enough, and more would push older, different
    // backups out of the few that pruneBackups keeps.
    if (raw === this.backedUp) return

    // `schemaVersion` comes from untrusted file content, so NEVER interpolate
    // it raw into a filename. sanitizeSchemaVersionForFilename limits the
    // value to integers or 'unknown'.
    try {
      const safeVersion = sanitizeSchemaVersionForFilename(schemaVersion)
      // Uniqueness suffix: if the store reads an unknown-schema file multiple
      // times (downgrade → upgrade → downgrade), each backup is preserved
      // independently. Without a suffix, a second read with the same schema
      // would overwrite the first backup, silently destroying recoverable data.
      const suffix = Date.now().toString(36) + '.' + randomUUID().slice(0, 8)
      const backup = path.join(
        this.dir,
        `${FILENAME}.v${safeVersion}.${suffix}.bak`,
      )
      // Created fresh (`wx`: the name is new, and a file or link already at it
      // is refused) and for the owner alone, as the file itself is written.
      await fs.writeFile(backup, raw, { encoding: 'utf8', mode: OWNER_ONLY_MODE, flag: 'wx' })
      this.backedUp = raw
      console.warn(
        `[github-config] unknown schemaVersion ${safeVersion}; backed up to ${path.basename(backup)}`,
      )
      await this.pruneBackups()
    } catch (err) {
      console.warn('[github-config] backup failed:', redactTokens(String(err)))
    }
  }

  private async pruneBackups(): Promise<void> {
    // Keep the most-recent CACHE_CORRUPT_BACKUPS_KEEP backups; delete older
    // ones so the dir doesn't grow unbounded. Fully async — don't block the
    // event loop with statSync.
    try {
      const entries = await fs.readdir(this.dir)
      const candidates = entries.filter(
        (e) => e.startsWith(`${FILENAME}.v`) && e.endsWith('.bak'),
      )
      // Stat all candidates in parallel. Tolerate races where a file
      // disappears between readdir and stat (another process or retention
      // pass could have removed it).
      const stats = await Promise.all(
        candidates.map(async (name) => {
          const full = path.join(this.dir, name)
          try {
            const s = await fs.stat(full)
            return { full, mtimeMs: s.mtimeMs }
          } catch {
            return null
          }
        }),
      )
      const backups = stats
        .filter((s): s is { full: string; mtimeMs: number } => s !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)

      await Promise.all(
        backups.slice(CACHE_CORRUPT_BACKUPS_KEEP).map(async (old) => {
          try {
            await fs.unlink(old.full)
          } catch {
            /* ignore single-file prune failures */
          }
        }),
      )
    } catch {
      /* best-effort */
    }
  }
}
