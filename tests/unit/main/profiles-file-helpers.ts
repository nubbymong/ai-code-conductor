// Shared by the accounts-list suites: put text in a profiles.json of the
// test's own, and make reads of it fail the way a file another program holds
// does. Nothing here starts a program, makes a link or touches an access list.
import fs from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'

const realRead = fs.readFileSync

/** `file` with `text` in it, and those bytes. */
export function seedProfiles(file: string, text: string): Buffer {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return realRead(file)
}

/**
 * Reads of `file` fail with `code`; every other read is the real one.
 * 'now': every read from here on. 'after-one-read': the first read succeeds
 * and switches the failure on, so a caller that reads the list once is served
 * and one that reads it again is not.
 */
export function failProfileReads(file: string, code: string, from: 'now' | 'after-one-read' = 'now'): void {
  let failing = from === 'now'
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(file)) {
      if (failing) throw Object.assign(new Error(`${code}: simulated, open '${p}'`), { code })
      failing = true
    }
    return (realRead as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof fs.readFileSync)
}
