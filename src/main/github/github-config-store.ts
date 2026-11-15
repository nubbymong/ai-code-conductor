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
import { failureKind } from '../failure-kind'

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
 * How long a read that failed stands in for the lookups that follow it
 * (`lookupState`). Long enough that a file which stays unreadable is not read
 * on every tick of every timer, short enough that the saved accounts are back
 * within half a minute of the file reading again without anyone asking.
 */
export const FAILED_READ_HOLD_MS = 30_000

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

// What the log says about a read that failed is the kind of failure
// (failure-kind.ts), never the error's own text: a JSON error's text quotes
// the characters around the place the parse stopped, which in this file can
// be a token's ciphertext, and a file error's text carries the full path.
// The kind is also what tells one failure from the next for the
// once-per-kind log (warnOnce).

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
  /** When the last read failed, or null once a read has succeeded since (see
   *  lookupState). */
  private failedAt: number | null = null
  /** The kinds of failure logged since the file last read (see warnOnce). */
  private warned = new Set<string>()

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
   *
   * Neither "no file" nor "nothing in it" is taken from one look: each is
   * asked once more (reallyMissing, reallyEmpty), and an answer the second
   * look does not confirm is a read that failed.
   */
  private async load(): Promise<GitHubConfig | 'missing' | 'unreadable'> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (await this.reallyMissing()) return this.didRead('missing')
        return this.didNotRead('the file was reported missing, and a second look did not confirm it')
      }
      return this.didNotRead(failureKind(err))
    }
    if (NOTHING_IN_IT.test(raw)) {
      if (await this.reallyEmpty(raw)) return this.didRead('missing')
      return this.didNotRead('the file read as empty, and a second look did not confirm it')
    }
    try {
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
      if (parsed.schemaVersion !== GITHUB_CONFIG_SCHEMA_VERSION) {
        // What the log says about this one is the backup's line.
        await this.backupUnknownSchemaFile(raw, parsed.schemaVersion)
        return this.didNotRead(null)
      }
      return this.didRead(parsed as GitHubConfig)
    } catch (err) {
      return this.didNotRead(failureKind(err))
    }
  }

  /** A read gave an answer (the config, or "no file"): no failed read is held
   *  any longer, and the next failure of any kind is logged again. */
  private didRead<T>(answer: T): T {
    this.failedAt = null
    this.warned.clear()
    return answer
  }

  /** A read failed. `kind` is what the log says about it (null: the caller
   *  logged it), once per kind until a read succeeds. */
  private didNotRead(kind: string | null): 'unreadable' {
    this.failedAt = Date.now()
    if (kind) this.warnOnce(`read failed: ${kind}`, '[github-config] read failed:', kind)
    return 'unreadable'
  }

  /**
   * One log line per kind of failure until a read succeeds. A file that stays
   * unreadable is read again and again (after each hold, at each save the
   * user tries, at each token lookup), and the first line of a kind says all
   * the later ones would.
   */
  private warnOnce(kind: string, ...line: unknown[]): void {
    if (this.warned.has(kind)) return
    this.warned.add(kind)
    console.warn(...line)
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
   * Whether the file has nothing in it, asked once more after a read gave
   * `first`, as reallyMissing asks again about "no such file". One empty read
   * is not taken as proof (a file another program is part way through writing
   * can read as nothing for a moment): the file is read again, and only the
   * same nothing a second time is "nothing in it". Text that is there after
   * all, a different length, or a second read that fails, is a read that
   * failed.
   */
  private async reallyEmpty(first: string): Promise<boolean> {
    try {
      return (await fs.readFile(this.filePath, 'utf8')) === first
    } catch {
      return false
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
   * accounts"; its timers ask with `lookupState()`). This one always reads
   * the file.
   */
  async readState(): Promise<GitHubConfigReadState> {
    // On the same mutex as write(), so reads and writes take turns.
    // AsyncMutex is exclusive (no reader/writer split), so reads also
    // serialize against other reads. That's acceptable here: a read is
    // made O(1)-ish per feature event (app start, profile list, after a
    // push), not on a hot path.
    return this.mutex.run(() => this.loadState())
  }

  /**
   * readState for a caller that asks often and can wait: the timers of the
   * sync, the notifications and the AI-usage meter. After a read that failed
   * (this one's or any other caller's), the file is not read again for
   * FAILED_READ_HOLD_MS: the failed answer stands in until then, so a file
   * that stays unreadable costs one read per hold and not one per lookup.
   *
   * The failed answer is never kept past the hold, and never as "no file".
   * Any read that succeeds in the meantime (a settings page, a writer, the
   * next lookup after the hold) ends the hold at once, and so does
   * endFailedReadHold().
   */
  async lookupState(): Promise<GitHubConfigReadState> {
    // Asked under the lock, so lookups that arrive together wait for the one
    // read and then see what it found.
    return this.mutex.run(async () => {
      if (this.holdingFailedRead()) return { config: null, readFailed: true }
      return this.loadState()
    })
  }

  /**
   * Ends the hold a failed read left, so the next lookup reads the file now.
   * For something the user asked for by pressing a button, which does not
   * wait out a hold that is there for the timers.
   */
  endFailedReadHold(): void {
    this.failedAt = null
  }

  private holdingFailedRead(): boolean {
    if (this.failedAt === null) return false
    // A clock that was set back gives a negative age: read, do not wait.
    const age = Date.now() - this.failedAt
    return age >= 0 && age < FAILED_READ_HOLD_MS
  }

  private async loadState(): Promise<GitHubConfigReadState> {
    const got = await this.load()
    return typeof got === 'string'
      ? { config: null, readFailed: got === 'unreadable' }
      : { config: got, readFailed: false }
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
      // Tried again at every read while the file stays, so one line per kind
      // of failure (the text itself names a new backup file each time).
      this.warnOnce(
        `backup failed: ${failureKind(err)}`,
        '[github-config] backup failed:',
        redactTokens(String(err)),
      )
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
