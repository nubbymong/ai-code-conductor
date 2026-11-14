import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GitHubConfig } from '../../shared/github-types'
import {
  GITHUB_CONFIG_SCHEMA_VERSION,
  CACHE_CORRUPT_BACKUPS_KEEP,
} from '../../shared/github-constants'
import { redactTokens } from './security/token-redactor'
import { AsyncMutex } from './async-mutex'
import { atomicWriteFileSync } from '../atomic-write'

const FILENAME = 'github-config.json'

/** What the user is told when the GitHub settings file did not read: the
 *  file's name, never its path. */
export const GITHUB_CONFIG_UNREADABLE =
  'The GitHub settings file (github-config.json) could not be read, so nothing was changed.'

/**
 * github-config.json is there but did not read (it could not be opened, is
 * not JSON, or is from a version this build does not know), so nothing was
 * written.
 *
 * `read()` answers such a file with null, the same as no file at all, and the
 * writers used to start from an empty config whenever they got null: one read
 * that failed while another program held the file, and the next change saved
 * defaults plus that one change over every saved account. A writer now reads
 * with `readForWrite()`, which raises this instead.
 */
export class GitHubConfigUnreadableError extends Error {
  constructor() {
    super(GITHUB_CONFIG_UNREADABLE)
  }
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
   * The one read of the file, which both reads below go through: the config,
   * 'missing' when there is no file, or 'unreadable' for everything else (it
   * could not be opened, is not JSON, or is from a version this build does
   * not know). A byte-order mark an editor put before the text is passed over.
   */
  private async load(): Promise<GitHubConfig | 'missing' | 'unreadable'> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
      if (parsed.schemaVersion !== GITHUB_CONFIG_SCHEMA_VERSION) {
        await this.backupUnknownSchemaFile(raw, parsed.schemaVersion)
        return 'unreadable'
      }
      return parsed as GitHubConfig
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      console.warn('[github-config] read failed:', redactTokens(String(err)))
      return 'unreadable'
    }
  }

  /**
   * The config for a caller that only READS it: null when there is no file,
   * and null when the file did not read, so the panel still renders. Never
   * save a config built from this null: a writer reads with `readForWrite()`.
   */
  async read(): Promise<GitHubConfig | null> {
    // On the same mutex as write(), so reads and writes take turns.
    // AsyncMutex is exclusive (no reader/writer split), so reads also
    // serialize against other reads. That's acceptable here: read() is
    // called O(1)-ish per feature event (app start, profile list, after a
    // push), not on a hot path.
    return this.mutex.run(async () => {
      const got = await this.load()
      return typeof got === 'string' ? null : got
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

  async write(config: GitHubConfig): Promise<void> {
    await this.mutex.run(async () => {
      // The shared atomic write (atomic-write.ts): the new bytes are staged
      // beside the file under a random name and renamed over it, with the
      // short retry Windows needs while a scanner holds the file. A write that
      // fails part way removes its staging file and leaves the old file whole;
      // it never leaves a half-written one. (This used to copy over the file
      // in place, which could.)
      atomicWriteFileSync(this.filePath, JSON.stringify(config, null, 2), await this.modeToKeep())
    })
  }

  /**
   * macOS and Linux: the mode github-config.json has now, for the file that
   * replaces it. Copying over the file in place kept its mode; a staged copy
   * renamed over it is a new file and would take the default, which is wider
   * than a mode the user tightened by hand. Nothing on Windows, which has no
   * such modes, and nothing when there is no file yet (the first write takes
   * the default, as it always did).
   */
  private async modeToKeep(): Promise<{ mode: number } | undefined> {
    if (process.platform === 'win32') return undefined
    try {
      return { mode: (await fs.stat(this.filePath)).mode & 0o777 }
    } catch {
      return undefined
    }
  }

  private async backupUnknownSchemaFile(raw: string, schemaVersion: unknown): Promise<void> {
    // Unknown schema → likely written by a newer app version. Keep a copy of
    // the original file beside it. No writer replaces such a file any more
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
      await fs.writeFile(backup, raw, 'utf8')
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
