// What the app saves in the registry reaches reg.exe exactly as given (S6).
// reg.exe is started with an argument list and no shell in between, so a
// value needs nothing taken out of it: a drive root picked as the data folder
// (D:\, its trailing backslash included) and a folder name holding spaces,
// quotes, %, !, or a backtick are each one argument, unchanged, and a value
// copied forward from an earlier key keeps every character too. A value
// holding a line break or a NUL, which the registry would not give back
// whole, is refused before reg.exe starts. reg.exe is
// never started here: child_process is replaced outright, and the platform
// is forced to Windows so the registry branch runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>,
  /** What reg.exe prints for a call, by its arguments; a throw for a key or value that is not there. */
  answer: (_args: string[]): string => { throw new Error('not there') },
}))

vi.mock('child_process', () => ({
  execFileSync: (file: string, args: string[], opts: Record<string, unknown>) => {
    h.calls.push({ file, args: [...args], opts })
    return h.answer(args)
  },
}))
vi.mock('../../../src/main/windows-programs', () => ({ systemTool: (rel: string) => `C:\\Windows\\System32\\${rel}` }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))

const { readRegistry, writeRegistry, migrateRegistryKeys } = await import('../../../src/main/registry')
const { logWarn } = await import('../../../src/main/debug-logger')

const REG = 'C:\\Windows\\System32\\reg.exe'
const BRAND = 'HKCU\\Software\\AI Code Conductor'
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

/** The value an `add` call hands reg.exe after /d, and how many arguments it took. */
function added(): { value: string; argc: number } {
  const c = h.calls.find((x) => x.args[0] === 'add')
  if (!c) throw new Error('no add call')
  return { value: c.args[c.args.indexOf('/d') + 1], argc: c.args.length }
}

beforeEach(() => {
  h.calls.length = 0
  h.answer = () => { throw new Error('not there') }
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
})

describe('a value reaches reg.exe as one argument, unchanged', () => {
  it('a drive root chosen as the data folder, its trailing backslash included', () => {
    h.answer = () => ''
    expect(writeRegistry('DataDirectory', 'D:\\')).toBe(true)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].file).toBe(REG)
    expect(h.calls[0].opts).not.toHaveProperty('shell')
    expect(h.calls[0].args).toEqual(['add', BRAND, '/v', 'DataDirectory', '/t', 'REG_SZ', '/d', 'D:\\', '/f'])
  })

  // Mutation to prove this can fail: take ", `, %, ! out of the value again (beta.2's sanitizeShellArg).
  it('a folder name with spaces, quotes, %VAR%, ! and a backtick', () => {
    h.answer = () => ''
    const value = 'D:\\My "Data" 100% %USERPROFILE% wow! `x` \\'
    expect(writeRegistry('DataDirectory', value)).toBe(true)
    expect(added()).toEqual({ value, argc: 9 })
  })

  it('a value read back keeps every character', () => {
    const value = 'E:\\Work 100% %TEMP% now!'
    h.answer = (args) => (args[1] === BRAND ? `\r\n${BRAND}\r\n    DataDirectory    REG_SZ    ${value}\r\n\r\n` : (() => { throw new Error('not there') })())
    expect(readRegistry('DataDirectory')).toBe(value)
    expect(h.calls[0].args).toEqual(['query', BRAND, '/v', 'DataDirectory'])
  })

  // Mutation to prove this can fail: sanitize the value copied forward from an earlier key.
  it('a value copied forward from an earlier key keeps every character', () => {
    const legacy = 'HKCU\\Software\\Claude Command Center'
    const value = 'F:\\Data 100% %APPDATA% done!'
    h.answer = (args) => {
      if (args[0] === 'add') return ''
      if (args[0] === 'query' && args[1] === legacy && args.length === 2) return `\r\n${legacy}\r\n    DataDirectory    REG_SZ    ${value}\r\n\r\n`
      throw new Error('not there')
    }
    migrateRegistryKeys()
    expect(added()).toEqual({ value, argc: 9 })
  })

  it('a reg.exe failure still reads as "not there" and a refused write as false', () => {
    h.answer = () => { throw new Error('reg.exe failed') }
    expect(readRegistry('DataDirectory')).toBeNull()
    expect(writeRegistry('DataDirectory', 'D:\\')).toBe(false)
  })
})

// reg.exe would take a line break in a value, and the read-back reads its
// answer line by line, so it would give back only the part before the break:
// a different value than was saved. A NUL cannot be handed to a program at
// all. Every other control character (\p{Cc}: a tab, ESC, DEL, U+0085) and
// the line and paragraph separators U+2028 and U+2029 are refused with them
// too: no folder or setting the app saves holds one. Such a
// value is refused before reg.exe starts, and the log says which value and
// why.
const CONTROL_REFUSAL = '[registry] Not saving SourcePath: the value holds a control character or a line or paragraph separator, which the registry would not give back whole'
const SLASH_REFUSAL = '[registry] Not saving SourcePath: the value starts with /, which reg.exe would read as one of its own options'

/** writeRegistry('SourcePath', value) is refused before reg.exe starts, with `said` logged once. */
function expectRefused(value: string, said: string): void {
  h.calls.length = 0
  vi.mocked(logWarn).mockClear()
  expect(writeRegistry('SourcePath', value), JSON.stringify(value)).toBe(false)
  expect(h.calls, JSON.stringify(value)).toEqual([])
  expect(vi.mocked(logWarn), JSON.stringify(value)).toHaveBeenCalledTimes(1)
  expect(String(vi.mocked(logWarn).mock.calls[0][0])).toBe(said)
}

describe('a value holding a control character or a line or paragraph separator is refused before reg.exe starts', () => {
  // Mutation to prove this can fail: drop the check (the value reaches reg.exe and the write reads as saved).
  it('CR, LF, CRLF or NUL anywhere in it: not saved, reg.exe never started, the reason logged without the value', () => {
    h.answer = () => ''
    const values = ['D:\\data\nx', 'D:\\data\rx', 'D:\\a\r\nD:\\b', 'D:\\data' + String.fromCharCode(0) + 'x', '\nD:\\', 'D:\\data\n']
    for (const value of values) expectRefused(value, CONTROL_REFUSAL)
  })

  // Mutation to prove this can fail: narrow the check back to CR, LF and NUL.
  it('U+2028, U+2029, a tab and every other control character: not saved, the reason logged without the value', () => {
    h.answer = () => ''
    const marks = [0x2028, 0x2029, 0x09, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f]
    for (const c of marks) {
      expectRefused(`D:\\src${String.fromCharCode(c)}more`, CONTROL_REFUSAL)
      expectRefused(`D:\\src${String.fromCharCode(c)}`, CONTROL_REFUSAL)
    }
  })

  it('a value without one is saved as before: spaces, a non-ASCII name, a slash after the first character and a trailing backslash', () => {
    h.answer = () => ''
    vi.mocked(logWarn).mockClear()
    const value = 'D:\\src 1\\caf\u00e9 \u4e2d\u6587\\a/b\u00a0c\\'
    expect(writeRegistry('SourcePath', value)).toBe(true)
    expect(added()).toEqual({ value, argc: 9 })
    expect(vi.mocked(logWarn)).not.toHaveBeenCalled()
  })
})

// reg.exe reads an argument that starts with `/` as one of its own options,
// wherever it stands: `/?` after /d shows its help, ends without an error and
// saves nothing, so the write would read as saved. No folder the app saves
// starts with one (a share is saved as \\server\share), so such a value is
// refused before reg.exe starts.
describe('a value starting with / is refused before reg.exe starts', () => {
  // Mutation to prove this can fail: drop the check.
  it('/?, /f, a share spelled with forward slashes, /d x: not saved, the reason logged without the value', () => {
    h.answer = () => ''
    for (const value of ['/?', '/f', '//server/share/src', '/d x', '/']) expectRefused(value, SLASH_REFUSAL)
  })

  it('a share spelled with backslashes and a slash later in the value are saved', () => {
    h.answer = () => ''
    for (const value of ['\\\\server\\share\\src', 'D:/src/app']) {
      h.calls.length = 0
      expect(writeRegistry('SourcePath', value), value).toBe(true)
      expect(added()).toEqual({ value, argc: 9 })
    }
  })
})

// The read-back takes a value's text up to the end of its line, which ends
// only at a carriage return or a line feed. Matching `.`
// stopped at U+2028 and U+2029 too, so a value holding one (written by an
// earlier build, or by hand) was read back cut short, and copied forward cut
// short.
describe('a value read back is its whole line', () => {
  const LS = String.fromCharCode(0x2028)
  const PS = String.fromCharCode(0x2029)

  // Mutation to prove this can fail: read the value with (.+) again.
  it('a value holding U+2028 or U+2029 is read back whole', () => {
    for (const sep of [LS, PS]) {
      const value = `D:\\src${sep}more`
      h.calls.length = 0
      h.answer = (args) => (args[1] === BRAND ? `\r\n${BRAND}\r\n    SourcePath    REG_SZ    ${value}\r\n\r\n` : (() => { throw new Error('not there') })())
      expect(readRegistry('SourcePath')).toBe(value)
    }
  })

  // Mutation to prove this can fail: read the values of a whole key with (.+) again.
  it('an earlier key\'s value holding U+2028 is never copied forward cut short', () => {
    const legacy = 'HKCU\\Software\\Claude Command Center'
    const value = `D:\\src${LS}more`
    h.calls.length = 0
    vi.mocked(logWarn).mockClear()
    h.answer = (args) => {
      if (args[0] === 'add') return ''
      if (args[0] === 'query' && args[1] === legacy && args.length === 2) return `\r\n${legacy}\r\n    SourcePath    REG_SZ    ${value}\r\n\r\n`
      throw new Error('not there')
    }
    migrateRegistryKeys()
    expect(h.calls.filter((c) => c.args[0] === 'add')).toEqual([])
    expect(vi.mocked(logWarn)).toHaveBeenCalledWith(CONTROL_REFUSAL)
  })
})
