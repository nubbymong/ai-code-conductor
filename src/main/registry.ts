/**
 * Centralized config/registry helper with cross-platform support.
 *
 * On Windows: Uses the Windows Registry with dual-key fallback.
 * During the rename from "Claude Conductor" → "Claude Command Center",
 * existing installations still have values under the old key. This module
 * reads from the new key first, falls back to the old key, and auto-migrates
 * values it finds in the old key to the new key.
 *
 * On macOS/Linux: Uses a JSON file at ~/.claude-conductor/platform-config.json
 * as a cross-platform fallback store.
 *
 * The startup function `migrateRegistryKeys()` copies ALL values from the
 * old key to the new key (if the old key still exists) and then deletes it,
 * unless a value could not be copied, in which case the old key is kept.
 * On non-Windows platforms it is a no-op.
 */
import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { logInfo, logWarn } from './debug-logger'
import { systemTool } from './windows-programs'

// Read order: current brand first, then each legacy key in reverse age. Writes
// always go to BRAND_KEY, so a FRESH install only ever creates the new-brand key
// and leaves no legacy name in the registry. An upgraded install keeps its
// existing key (harmless, and it is what a downgrade would still read) while the
// new key becomes authoritative from the first write.
const BRAND_KEY = 'Software\\AI Code Conductor'
const LEGACY_KEYS = ['Software\\Claude Command Center', 'Software\\Claude Conductor']
// The oldest key is the only one migrateRegistryKeys() deletes (unchanged
// behaviour); the intermediate key is deliberately left in place so a downgrade
// to a build that does not know BRAND_KEY still resolves the user's data dir.
const OLD_KEY = 'Software\\Claude Conductor'
const NEW_KEY = BRAND_KEY

// --- Cross-platform JSON fallback (macOS / Linux) ---

// macOS/Linux stand-in for the Windows registry. Same rule as the data
// directory: a fresh install writes under the current brand, an install that
// already has a config file keeps using it (moving it would strand the pointer
// to the user's data directory).
const BRAND_FALLBACK_DIR = join(homedir(), '.ai-code-conductor')
const LEGACY_FALLBACK_DIRS = [join(homedir(), '.claude-conductor')]

function fallbackConfigPaths(): { dir: string; file: string } {
  const brandFile = join(BRAND_FALLBACK_DIR, 'platform-config.json')
  if (existsSync(brandFile)) return { dir: BRAND_FALLBACK_DIR, file: brandFile }
  for (const dir of LEGACY_FALLBACK_DIRS) {
    const file = join(dir, 'platform-config.json')
    if (existsSync(file)) return { dir, file }
  }
  return { dir: BRAND_FALLBACK_DIR, file: brandFile }
}

function readFallbackConfig(): Record<string, string> {
  try {
    const { file } = fallbackConfigPaths()
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf-8'))
    }
  } catch {}
  return {}
}

/** Save the config file; true once it is written. False when its folder
 *  could not be created or the file could not be written (a read-only or
 *  full home folder), so the caller can say the value was not saved. */
function writeFallbackConfig(config: Record<string, string>): boolean {
  try {
    const { dir, file } = fallbackConfigPaths()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(config, null, 2))
    return true
  } catch (err) {
    logWarn(`[registry] Could not save the platform config file: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// --- Public API ---

/**
 * Read a registry value (Windows) or JSON config value (macOS/Linux).
 * On Windows, tries the new key first then falls back to the old key.
 * If found under the old key, auto-migrates the value to the new key.
 */
export function readRegistry(valueName: string): string | null {
  if (process.platform !== 'win32') {
    // Cross-platform fallback: read from JSON file
    const config = readFallbackConfig()
    return config[valueName] ?? null
  }

  // Current brand key wins.
  const newVal = readRegValue(BRAND_KEY, valueName)
  if (newVal !== null) return newVal

  // Then each legacy key, newest first. A hit is copied forward so the brand key
  // becomes authoritative, but the legacy key itself is left alone.
  for (const legacy of LEGACY_KEYS) {
    const oldVal = readRegValue(legacy, valueName)
    if (oldVal !== null) {
      writeRegValue(BRAND_KEY, valueName, oldVal)
      logInfo(`[registry] Adopted ${valueName} from "${legacy}" into the current key`)
      return oldVal
    }
  }

  return null
}

/**
 * Write a registry value (Windows) or JSON config value (macOS/Linux).
 * True only once the value is saved: on macOS and Linux a config file that
 * could not be written answers false, as a value reg.exe did not save does
 * on Windows.
 */
export function writeRegistry(valueName: string, value: string): boolean {
  if (process.platform !== 'win32') {
    // Cross-platform fallback: write to JSON file
    try {
      const config = readFallbackConfig()
      config[valueName] = value
      return writeFallbackConfig(config)
    } catch {
      return false
    }
  }
  return writeRegValue(NEW_KEY, valueName, value)
}

/**
 * Startup migration: copy all values from old key to new key, then delete old key.
 * The old key is kept while any of the copies was not saved.
 * Safe to call multiple times — no-ops if old key doesn't exist.
 * No-op on non-Windows platforms.
 */
export function migrateRegistryKeys(): void {
  if (process.platform !== 'win32') return

  // Copy anything the brand key is missing forward from the legacy keys, newest
  // first so a newer value is never overwritten by an older one. A copy that
  // was not saved (writeRegValue refused the value before reg.exe started, or
  // reg.exe failed) is noted, by the value's name only, and that name is not
  // copied from an older key either: the current key would then hold the
  // older value, which wins over the newer one on every read. Left out of the
  // current key, the name is read from the legacy keys, newest first.
  let notCopied = false
  const refused = new Set<string>()
  for (const legacy of LEGACY_KEYS) {
    const values = readAllRegValues(legacy)
    if (values === null) continue
    for (const [name, value] of Object.entries(values)) {
      if (refused.has(name)) continue
      if (readRegValue(BRAND_KEY, name) === null) {
        if (writeRegValue(BRAND_KEY, name, value)) {
          logInfo(`[registry] Adopted from "${legacy}": ${name} = ${value}`)
        } else {
          notCopied = true
          refused.add(name)
          logWarn(`[registry] Could not copy ${name} forward from "${legacy}"; it is left where it is and the original key is kept`)
        }
      }
    }
  }

  // Only the ORIGINAL key is deleted (unchanged from before). The intermediate
  // "Claude Command Center" key stays: an upgraded install may be rolled back to
  // a build that only knows that key, and deleting it would strand that build's
  // data-directory pointer. Fresh installs never create it in the first place.
  // The original is kept while any value, from either legacy key, was not
  // copied forward. For one of its own values, deleting it would lose that
  // value from every key (for the data directory, the next start would show
  // first-run setup as if the data were gone). For a value of the
  // intermediate key, keeping it is only more cautious than needed.
  if (notCopied) return
  if (readAllRegValues(OLD_KEY) !== null) {
    try {
      runReg(['delete', `HKCU\\${OLD_KEY}`, '/f'])
      logInfo('[registry] Deleted the original (pre-rename) registry key')
    } catch {
      // May fail if key is already gone
    }
  }
}

// --- Internal helpers ---

/** Run reg.exe by its full path in the system folder, with its arguments as
 *  an argument list (no shell), and answer what it printed. Its error output
 *  is captured and dropped. Throws when reg.exe fails or the system folder
 *  cannot be named (systemTool), which every caller reads as "not there".
 *  With no shell in between, each key, name and value reaches reg.exe as one
 *  argument exactly as given: a drive root (D:\) or a folder name holding %,
 *  !, a quote or a backtick is saved as it is, and nothing is taken out of
 *  it first (S6). */
function runReg(args: string[]): string {
  return execFileSync(systemTool('reg.exe'), args, {
    encoding: 'utf-8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** A value's text in reg.exe's answer: everything after REG_SZ up to the end
 *  of its line, which ends only at a carriage return or a line feed. Not
 *  `.`, which also stops at U+2028 and U+2029, so a value holding either
 *  would be read back cut short. */
const REG_SZ_VALUE = '([^\\r\\n]+)'

function readRegValue(key: string, valueName: string): string | null {
  try {
    const result = runReg(['query', `HKCU\\${key}`, '/v', valueName])
    const match = result.match(new RegExp(`${valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_SZ\\s+${REG_SZ_VALUE}`))
    if (match && match[1].trim()) {
      return match[1].trim()
    }
  } catch { /* key/value doesn't exist */ }
  return null
}

/** What a value saved through reg.exe may not hold: a control character
 *  (a carriage return, a line feed, a tab, a NUL, and the rest of \p{Cc}),
 *  or a line or paragraph separator (U+2028, U+2029). reg.exe would take a
 *  line break, and the read-back (readRegValue, which reads reg.exe's answer
 *  line by line) would return only the part before it; a NUL cannot be
 *  handed to a program at all; and no folder or setting the app saves holds
 *  any of them. */
const REG_VALUE_UNSAFE_RE = /[\p{Cc}\u2028\u2029]/u

/** Save one value under `key`, or refuse it before reg.exe starts: a value
 *  holding a control character or a line or paragraph separator
 *  (REG_VALUE_UNSAFE_RE), or starting with `/`, which reg.exe reads as one of
 *  its own options wherever it stands (`/?` shows its help and saves
 *  nothing), is not saved (false), and the log says which value and why,
 *  never the value itself. A share is saved by its backslash spelling
 *  (\\server\share). */
function writeRegValue(key: string, valueName: string, value: string): boolean {
  if (REG_VALUE_UNSAFE_RE.test(value)) {
    logWarn(`[registry] Not saving ${valueName}: the value holds a control character or a line or paragraph separator, which the registry would not give back whole`)
    return false
  }
  if (value.startsWith('/')) {
    logWarn(`[registry] Not saving ${valueName}: the value starts with /, which reg.exe would read as one of its own options`)
    return false
  }
  try {
    runReg(['add', `HKCU\\${key}`, '/v', valueName, '/t', 'REG_SZ', '/d', value, '/f'])
    return true
  } catch {
    return false
  }
}

function readAllRegValues(key: string): Record<string, string> | null {
  try {
    const result = runReg(['query', `HKCU\\${key}`])
    const values: Record<string, string> = {}
    const lines = result.split('\n')
    for (const line of lines) {
      const match = line.match(new RegExp(`^\\s+(\\S+)\\s+REG_SZ\\s+${REG_SZ_VALUE}`))
      if (match) {
        values[match[1].trim()] = match[2].trim()
      }
    }
    return Object.keys(values).length > 0 ? values : null
  } catch {
    return null // Key doesn't exist
  }
}
