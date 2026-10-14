// The resources folder's scripts folders' rule (owner-only-folders.ts
// secureScriptFoldersRule, which script-folders.ts runs at start): on Windows
// the owner-only rule with what is directly inside each folder read and put
// right too, as for the sign-in folders, so a script inside that another
// account owns, or that gives anyone else rights, refuses the folder; on
// macOS and Linux each folder's own rule (each script is held to its own
// owner and mode at its launch).
//
// Host-safe: the Windows PowerShell call is a stand-in runner that records
// what it was asked and answers as the script prints its read; no process
// starts and nothing on this machine is read or changed. The POSIX branch is
// given a folder it refuses before touching anything (not absolute).
import { describe, it, expect } from 'vitest'
import {
  secureScriptFoldersRule, OWNER_ONLY_DIRS_ENV, OWNER_ONLY_INSIDE_ENV, OWNER_ONLY_SHARED_ENV, OWNER_ONLY_SYSTEM_SID,
} from '../../../src/main/owner-only-folders'
import type { PowerShellRunner } from '../../../src/main/owner-only-folders'

const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1005'
const SCRIPTS = 'C:\\res\\scripts'
const LIB = 'C:\\res\\scripts\\lib'
const FULL = 0x1f01ff
const own = (sid: string) => ({ sid, rights: FULL, allow: true, inherited: false, flags: 3 })
/** A folder's read as the script prints it: owner-only, with `inside` entries. */
const folderRead = (dir: string, inside: unknown[]) => ({ dir, owner: USER, protected: true, rules: [own(USER), own(OWNER_ONLY_SYSTEM_SID)], inside })
const script = (name: string, owner: string, extra: unknown[] = []) => ({ name, link: false, folder: false, owner, rules: [own(USER), own(OWNER_ONLY_SYSTEM_SID), ...extra] })

/** A stand-in runner: records each call's variables, answers `answer`. */
function runner(answer: unknown): PowerShellRunner & { asked: Array<Record<string, string>> } {
  const asked: Array<Record<string, string>> = []
  const run = (async (_script: string, extraEnv: Record<string, string>) => {
    asked.push({ ...extraEnv })
    return JSON.stringify(answer)
  }) as PowerShellRunner & { asked: Array<Record<string, string>> }
  run.asked = asked
  return run
}

describe('the scripts folders\' rule on Windows', () => {
  // Mutation to prove this can fail: ask the folders' own rights only (inside off).
  it('asks the owner-only rule with what is inside each folder read too, both folders in order, nothing left out as shared', async () => {
    const run = runner({ user: USER, folders: [folderRead(SCRIPTS, [script('resume-picker.js', USER)]), folderRead(LIB, [])] })
    const out = await secureScriptFoldersRule([SCRIPTS, LIB], run, 'win32')
    expect(run.asked).toHaveLength(1)
    expect(run.asked[0][OWNER_ONLY_INSIDE_ENV]).toBe('1')
    expect(run.asked[0][OWNER_ONLY_DIRS_ENV]).toBe(`${SCRIPTS}\n${LIB}`)
    expect(run.asked[0][OWNER_ONLY_SHARED_ENV]).toBe('')
    expect(out.map((r) => [r.dir, r.ok])).toEqual([[SCRIPTS, true], [LIB, true]])
  })

  it('a script inside that another account owns refuses the folder', async () => {
    const run = runner({ user: USER, folders: [folderRead(SCRIPTS, [script('claude-multi-statusline.js', OTHER)]), folderRead(LIB, [])] })
    const out = await secureScriptFoldersRule([SCRIPTS, LIB], run, 'win32')
    expect(out[0]).toMatchObject({ dir: SCRIPTS, ok: false, detail: "an entry inside it is another account's" })
  })

  it('a script inside that gives anyone else rights (and could not be put right) refuses the folder', async () => {
    const everyone = { sid: 'S-1-1-0', rights: 0x1301bf, allow: true, inherited: true, flags: 0 }
    const run = runner({ user: USER, folders: [folderRead(SCRIPTS, [script('resume-picker.js', USER, [everyone])]), folderRead(LIB, [])] })
    const out = await secureScriptFoldersRule([SCRIPTS, LIB], run, 'win32')
    expect(out[0]).toMatchObject({ dir: SCRIPTS, ok: false, detail: 'an entry inside it is not owner-only' })
  })

  it('a call that fails gives no read of either folder (refused, unread), never a pass', async () => {
    const run = (async () => { throw new Error('refused') }) as PowerShellRunner
    const out = await secureScriptFoldersRule([SCRIPTS, LIB], run, 'win32')
    expect(out.map((r) => [r.ok, r.unread])).toEqual([[false, true], [false, true]])
  })
})

describe('the scripts folders\' rule on macOS and Linux', () => {
  it('is each folder\'s own rule, never the Windows call', async () => {
    const run = runner({})
    const out = await secureScriptFoldersRule(['relative/scripts'], run, 'linux')
    expect(run.asked).toEqual([])
    expect(out).toEqual([{ dir: 'relative/scripts', ok: false, detail: 'the folder cannot be named safely' }])
  })
})
