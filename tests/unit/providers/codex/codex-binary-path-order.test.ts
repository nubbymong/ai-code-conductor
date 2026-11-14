// [host] WP2 PR 4 (owner answers, 2026-10-04): the Codex executable on Windows
// is found as a terminal finds it, PATH order first: the first PATH entry
// holding codex.exe or codex.cmd wins, and within one entry the PATHEXT order
// decides (src/main/providers/codex/spawn.ts resolveCodexBinary). A form
// PATHEXT does not list is looked for only after no entry held a listed one,
// so it never wins over a listed form later in PATH, and nothing found before
// is lost. The lookup reads only fully qualified folders (a drive or a share,
// as a terminal does), names each folder as Windows does when it runs a
// program, asks a folder that could not be read nothing more, and starts no
// process and no shell. The file system is a fixed set of paths, so nothing
// on this machine is looked up.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: vi.fn(() => 'win32') }
})
// The earlier lookup asked `where codex.exe`, then `where codex.cmd`: this
// stands in for it, answering with the codex.exe of the LATER entry.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn((cmd: string) => (String(cmd).includes('codex.exe') ? 'C:\\later\\codex.exe\r\n' : 'C:\\earlier\\codex.cmd\r\n')) }
})
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '', getDataDirectory: () => '' }))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 0, issueMcpSessionToken: () => 'tok' }))
// The disk, for the cases at the end that use the lookup's OWN file test: a
// file under the made-up folder `madeUp.root` answers from `madeUp.files`
// (`true`: a regular file; a string: the error code its test fails with; not
// listed: not there). Any other path is the real call.
const madeUp = vi.hoisted(() => ({
  root: 'C:\\ccc-test-locked-file-5b1f\\',
  files: new Map<string, true | string>(),
  asked: [] as string[],
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const statSync = (p: unknown, o?: unknown): unknown => {
    if (typeof p !== 'string' || !p.startsWith(madeUp.root)) return (actual.statSync as (p: unknown, o?: unknown) => unknown)(p, o)
    madeUp.asked.push(p)
    const answer = madeUp.files.get(p)
    if (answer === true) return { isFile: () => true }
    throw Object.assign(new Error('the file test failed'), { code: answer ?? 'ENOENT' })
  }
  const patched = { ...actual, statSync }
  return { ...patched, default: patched }
})

const { execSync } = await import('child_process')
const { resolveCodexBinary } = await import('../../../../src/main/providers/codex/spawn')

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
let asked: string[]

/** The files that exist, case-insensitively, as on NTFS. */
function onDisk(...files: string[]): (p: string) => boolean {
  const set = new Set(files.map((f) => f.toLowerCase()))
  return (p: string) => { asked.push(p); return set.has(p.toLowerCase()) }
}
const resolve = (env: Record<string, string>, ...files: string[]) =>
  resolveCodexBinary({ platform: 'win32', env, isFile: onDisk(...files) })
/** The same, with folders that cannot be read (a drive that does not answer). */
const resolveWith = (env: Record<string, string>, unreachable: string[], ...files: string[]) => {
  const has = onDisk(...files)
  const dead = unreachable.map((d) => d.toLowerCase())
  return resolveCodexBinary({
    platform: 'win32',
    env,
    statFile: (p: string) => {
      if (dead.some((d) => p.toLowerCase().startsWith(`${d}\\`))) { asked.push(p); return 'unreachable' }
      return has(p) ? 'file' : 'none'
    },
  })
}

beforeEach(() => {
  asked = []
  vi.mocked(execSync).mockClear()
})

describe('PATH order wins (owner, 2026-10-04)', () => {
  it('[host] a codex.cmd in an earlier PATH entry wins over a codex.exe in a later one', () => {
    expect(resolve({ PATH: 'C:\\earlier;C:\\later', PATHEXT: DEFAULT_PATHEXT }, 'C:\\earlier\\codex.cmd', 'C:\\later\\codex.exe')).toEqual({ cmd: 'C:\\earlier\\codex.cmd', args: [] })
  })

  it('[host] a codex.exe in an earlier PATH entry wins over a codex.cmd in a later one', () => {
    expect(resolve({ PATH: 'C:\\earlier;C:\\later', PATHEXT: DEFAULT_PATHEXT }, 'C:\\earlier\\codex.exe', 'C:\\later\\codex.cmd')).toEqual({ cmd: 'C:\\earlier\\codex.exe', args: [] })
  })

  it.each([
    ['the default PATHEXT (.EXE before .CMD)', DEFAULT_PATHEXT, 'codex.exe'],
    ['a PATHEXT listing .CMD before .EXE', '.COM;.CMD;.EXE', 'codex.cmd'],
    ['no PATHEXT at all (Windows\' own default)', undefined, 'codex.exe'],
    ['a PATHEXT in lower case', '.cmd;.exe', 'codex.cmd'],
  ])('[host] both in one entry: the PATHEXT order decides (%s)', (_name, pathExt, want) => {
    const env: Record<string, string> = { PATH: 'C:\\npm' }
    if (pathExt !== undefined) env.PATHEXT = pathExt
    expect(resolve(env, 'C:\\npm\\codex.exe', 'C:\\npm\\codex.cmd')?.cmd).toBe(`C:\\npm\\${want}`)
  })

  it('[host] a form PATHEXT does not list still counts, after the ones it lists: nothing found before is lost', () => {
    expect(resolve({ PATH: 'C:\\npm', PATHEXT: '.CMD' }, 'C:\\npm\\codex.exe', 'C:\\npm\\codex.cmd')?.cmd).toBe('C:\\npm\\codex.cmd')
    expect(resolve({ PATH: 'C:\\bin', PATHEXT: '.CMD' }, 'C:\\bin\\codex.exe')?.cmd).toBe('C:\\bin\\codex.exe')
  })

  it('[host] a form PATHEXT does not list never wins over a listed form in a later entry (review B-S2): it is looked for only after every entry', () => {
    expect(resolve({ PATH: 'C:\\earlier;C:\\later', PATHEXT: '.EXE' }, 'C:\\earlier\\codex.cmd', 'C:\\later\\codex.exe')?.cmd).toBe('C:\\later\\codex.exe')
    expect(resolve({ PATH: 'C:\\earlier;C:\\later', PATHEXT: '.CMD' }, 'C:\\earlier\\codex.exe', 'C:\\later\\codex.cmd')?.cmd).toBe('C:\\later\\codex.cmd')
    // Only when no entry holds a listed form: the first entry holding an unlisted one.
    expect(resolve({ PATH: 'C:\\earlier;C:\\later', PATHEXT: '.EXE' }, 'C:\\earlier\\codex.cmd', 'C:\\later\\codex.cmd')?.cmd).toBe('C:\\earlier\\codex.cmd')
    expect(resolve({ PATH: 'C:\\earlier;C:\\later', PATHEXT: '' }, 'C:\\later\\codex.exe')?.cmd).toBe('C:\\later\\codex.exe')
  })

  it('[host] the variable\'s name is matched as Windows matches it (Path)', () => {
    expect(resolve({ Path: 'C:\\earlier;C:\\later', PathExt: DEFAULT_PATHEXT }, 'C:\\later\\codex.exe')?.cmd).toBe('C:\\later\\codex.exe')
  })

  it('[host] a quoted entry is read without its quotes, and a trailing separator is harmless', () => {
    expect(resolve({ PATH: '"C:\\Program Files\\codex cli";C:\\later\\', PATHEXT: DEFAULT_PATHEXT }, 'C:\\Program Files\\codex cli\\codex.cmd', 'C:\\later\\codex.exe')?.cmd).toBe('C:\\Program Files\\codex cli\\codex.cmd')
  })

  it('[host] a network share folder is read as a terminal reads it (review B-S10): npm\'s folder on a redirected profile', () => {
    expect(resolve({ PATH: '\\\\fs01\\profiles\\riley\\AppData\\Roaming\\npm;C:\\later', PATHEXT: DEFAULT_PATHEXT }, '\\\\fs01\\profiles\\riley\\AppData\\Roaming\\npm\\codex.cmd', 'C:\\later\\codex.exe')?.cmd).toBe('\\\\fs01\\profiles\\riley\\AppData\\Roaming\\npm\\codex.cmd')
    expect(resolve({ PATH: '//fs01/tools;C:\\later', PATHEXT: DEFAULT_PATHEXT }, '\\\\fs01\\tools\\codex.exe', 'C:\\later\\codex.exe')?.cmd).toBe('\\\\fs01\\tools\\codex.exe')
  })

  it('[host] a device path is never a PATH folder the lookup reads (\\\\?\\ and \\\\.\\, either slash)', () => {
    asked = []
    expect(resolve({ PATH: '\\\\?\\C:\\dev;\\\\.\\C:\\dev;//?/C:/dev;C:\\later', PATHEXT: DEFAULT_PATHEXT }, '\\\\?\\C:\\dev\\codex.exe', '\\\\.\\C:\\dev\\codex.exe', 'C:\\later\\codex.cmd')?.cmd).toBe('C:\\later\\codex.cmd')
    expect(asked.map((p) => p.toLowerCase())).toEqual(['c:\\later\\codex.exe', 'c:\\later\\codex.cmd'])
  })

  it('[host] a share that does not answer is asked once in a lookup, then passed over (the same memo as any folder)', () => {
    expect(resolveWith({ PATH: '\\\\dead\\share;C:\\later', PATHEXT: '.EXE' }, ['\\\\dead\\share'], 'C:\\later\\codex.cmd')?.cmd).toBe('C:\\later\\codex.cmd')
    expect(asked).toEqual(['\\\\dead\\share\\codex.exe', 'C:\\later\\codex.exe', 'C:\\later\\codex.cmd'])
  })

  it('[host] a folder that could not be read is asked nothing more in that lookup (review B-S3): neither its other form nor in the second pass', () => {
    expect(resolveWith({ PATH: 'C:\\dead;C:\\later', PATHEXT: '.EXE' }, ['C:\\dead'], 'C:\\dead\\codex.cmd', 'C:\\later\\codex.cmd')?.cmd).toBe('C:\\later\\codex.cmd')
    expect(asked).toEqual(['C:\\dead\\codex.exe', 'C:\\later\\codex.exe', 'C:\\later\\codex.cmd'])
    asked = []
    expect(resolveWith({ PATH: 'C:\\dead;C:\\later', PATHEXT: DEFAULT_PATHEXT }, ['C:\\dead'], 'C:\\later\\codex.cmd')?.cmd).toBe('C:\\later\\codex.cmd')
    expect(asked.filter((p) => p.startsWith('C:\\dead'))).toEqual(['C:\\dead\\codex.exe'])
  })

  it('[host] nothing found anywhere: null', () => {
    expect(resolve({ PATH: 'C:\\a;C:\\b', PATHEXT: DEFAULT_PATHEXT })).toBeNull()
    expect(resolve({ PATHEXT: DEFAULT_PATHEXT })).toBeNull()
  })
})

describe('the protections the lookup keeps', () => {
  it('[host] only fully qualified PATH folders (a drive or a share) are read', () => {
    const out = resolve({ PATH: ';.;bin;.\\tools;\\rooted;C:relative;C:\\later', PATHEXT: DEFAULT_PATHEXT }, 'codex.cmd', '.\\codex.cmd', 'bin\\codex.cmd', '\\rooted\\codex.cmd', 'C:relative\\codex.cmd', 'C:\\later\\codex.exe')
    expect(out?.cmd).toBe('C:\\later\\codex.exe')
    expect(asked.every((p) => /^[A-Za-z]:\\/.test(p))).toBe(true)
  })

  // Final nits (L3): the same rule as the Claude walk, from the shared module:
  // a drive, or a share spelled with two leading slashes. [host]
  it('[host] reads a drive or a share spelled with two leading slashes, by the shared PATH-folder rule', () => {
    const out = resolve({ PATH: '\\\\\\srv\\share\\bin;///srv/share/bin;C:\\later', PATHEXT: DEFAULT_PATHEXT }, '\\\\\\srv\\share\\bin\\codex.exe', '///srv/share/bin/codex.exe', 'C:\\later\\codex.exe')
    expect(out?.cmd).toBe('C:\\later\\codex.exe')
    expect(asked.every((p) => /^[A-Za-z]:\\/.test(p))).toBe(true)
    expect(resolve({ PATH: '\\\\srv\\share\\bin', PATHEXT: DEFAULT_PATHEXT }, '\\\\srv\\share\\bin\\codex.exe')?.cmd).toBe('\\\\srv\\share\\bin\\codex.exe')
  })

  it.each([
    ['a folder name ending in one dot loses it', 'C:\\T.', 'C:\\T\\codex.exe'],
    ['a folder name ending in one dot, mid-path', 'C:\\x.\\bin', 'C:\\x\\bin\\codex.exe'],
    ['a space before that dot stays', 'C:\\t .', 'C:\\t \\codex.exe'],
    ['two dots stay', 'C:\\t..', 'C:\\t..\\codex.exe'],
    ['a trailing space mid-path stays', 'C:\\tools \\bin', 'C:\\tools \\bin\\codex.exe'],
    ['a "." step is folded', 'C:\\a\\.\\b', 'C:\\a\\b\\codex.exe'],
    ['a ".." step is folded', 'C:\\a\\..\\b', 'C:\\b\\codex.exe'],
    ['a quoted entry with a trailing dot', '"C:\\q."', 'C:\\q\\codex.exe'],
    ['a share\'s own name keeps its dot', '\\\\srv\\share.\\npm', '\\\\srv\\share.\\npm\\codex.exe'],
    ['a folder below a share loses its dot', '\\\\srv\\share\\npm.', '\\\\srv\\share\\npm\\codex.exe'],
  ])('[host] a PATH folder is named as Windows names it when it runs a program (review B-S11): %s', (_name, entry, want) => {
    expect(resolve({ PATH: entry, PATHEXT: DEFAULT_PATHEXT }, want)?.cmd).toBe(want)
  })

  it('[host] the folder Windows would not run from is never read in its place: a literal "T." folder\'s codex is not taken for "C:\\T."', () => {
    expect(resolve({ PATH: 'C:\\T.;C:\\later', PATHEXT: DEFAULT_PATHEXT }, 'C:\\T.\\codex.exe', 'C:\\later\\codex.cmd')?.cmd).toBe('C:\\later\\codex.cmd')
    expect(asked.some((p) => p.includes('T.'))).toBe(false)
  })

  it('[host] no shell and no process: nothing is started to look Codex up on Windows', () => {
    resolve({ PATH: 'C:\\earlier;C:\\later', PATHEXT: DEFAULT_PATHEXT }, 'C:\\later\\codex.exe')
    resolve({ PATH: 'C:\\a', PATHEXT: DEFAULT_PATHEXT })
    expect(execSync).not.toHaveBeenCalled()
  })

  it('[host] only codex.exe and codex.cmd are looked for: no other PATHEXT form, and no extensionless file', () => {
    expect(resolve({ PATH: 'C:\\npm', PATHEXT: DEFAULT_PATHEXT }, 'C:\\npm\\codex', 'C:\\npm\\codex.bat', 'C:\\npm\\codex.com', 'C:\\npm\\codex.ps1')).toBeNull()
    expect(asked.map((p) => p.toLowerCase()).sort()).toEqual(['c:\\npm\\codex.cmd', 'c:\\npm\\codex.exe'])
  })
})

// The lookup's own file test (no stand-in passed in). One program file that
// cannot be read (access to it is denied, or it is in use while an update
// replaces it) says nothing about the file beside it: a failure known to be
// about the one file passes that file only. Every other failure still passes
// the folder, so a share that is down is asked once in a lookup, whatever
// reason its file test ends with. The same short list as the Claude walk
// (windows-programs.ts oneFileCannotBeRead).
describe('one program file that cannot be read does not hide the one beside it', () => {
  const FIRST = `${madeUp.root}first`
  const LATER = `${madeUp.root}later`
  const lookUp = (pathValue: string = `${FIRST};${LATER}`) => resolveCodexBinary({ platform: 'win32', env: { PATH: pathValue, PATHEXT: DEFAULT_PATHEXT } })

  beforeEach(() => {
    madeUp.files.clear()
    madeUp.asked.length = 0
  })

  // Mutation to prove this can fail: answer `unreachable` for every failed
  // file test (the folder is then passed, and the later folder's is found).
  it.each(['EPERM', 'EACCES', 'EBUSY'])('[host] the .exe cannot be read (%s): the .cmd beside it is found, not a later folder\'s .exe', (code) => {
    madeUp.files.set(`${FIRST}\\codex.exe`, code).set(`${FIRST}\\codex.cmd`, true).set(`${LATER}\\codex.exe`, true)
    expect(lookUp()?.cmd).toBe(`${FIRST}\\codex.cmd`)
    expect(madeUp.asked).toEqual([`${FIRST}\\codex.exe`, `${FIRST}\\codex.cmd`])
  })

  it('[host] with no later copy the .cmd beside it is found too, where the lookup found none', () => {
    madeUp.files.set(`${FIRST}\\codex.exe`, 'EPERM').set(`${FIRST}\\codex.cmd`, true)
    expect(lookUp(FIRST)?.cmd).toBe(`${FIRST}\\codex.cmd`)
  })

  it('[host] the file that cannot be read is never the answer itself', () => {
    madeUp.files.set(`${FIRST}\\codex.exe`, 'EBUSY')
    expect(lookUp(FIRST)).toBeNull()
  })

  // This lookup runs in place, on the main thread, with no time limit of its
  // own: each file asked in a folder that is down is one wait of tens of
  // seconds. Mutation to prove this can fail: read no failure as the folder's,
  // or only the ones that name the network (a share that is down, and says so
  // with a reason Node.js has no code for, is then waited for once for every
  // form).
  it.each(['EHOSTUNREACH', 'ETIMEDOUT', 'ENETUNREACH', 'UNKNOWN', 'EIO', 'ELOOP', 'EISDIR'])('[host] a folder whose file test fails for any other reason (%s) is still passed once: it is asked for no other form', (code) => {
    madeUp.files.set(`${FIRST}\\codex.exe`, code).set(`${FIRST}\\codex.cmd`, true).set(`${LATER}\\codex.exe`, true)
    expect(lookUp()?.cmd).toBe(`${LATER}\\codex.exe`)
    expect(madeUp.asked.filter((p) => p.startsWith(FIRST))).toEqual([`${FIRST}\\codex.exe`])
  })

  it('[host] such a folder is not asked again in the second pass either, for a form PATHEXT does not list', () => {
    madeUp.files.set(`${FIRST}\\codex.exe`, 'UNKNOWN').set(`${FIRST}\\codex.cmd`, true).set(`${LATER}\\codex.cmd`, true)
    expect(resolveCodexBinary({ platform: 'win32', env: { PATH: `${FIRST};${LATER}`, PATHEXT: '.COM;.EXE' } })?.cmd).toBe(`${LATER}\\codex.cmd`)
    expect(madeUp.asked.filter((p) => p.startsWith(FIRST))).toEqual([`${FIRST}\\codex.exe`])
  })

  it.each(['ENOENT', 'ENOTDIR'])('[host] a file that is not there (%s) is "no such file", as before: its folder is still asked for the other form', (code) => {
    madeUp.files.set(`${FIRST}\\codex.exe`, code).set(`${FIRST}\\codex.cmd`, true).set(`${LATER}\\codex.exe`, true)
    expect(lookUp()?.cmd).toBe(`${FIRST}\\codex.cmd`)
  })
})
