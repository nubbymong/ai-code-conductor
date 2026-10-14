// The startup migration (migrateRegistryKeys) copies the values of the
// original pre-rename key, HKCU\Software\Claude Conductor, forward into the
// current key and then deletes the original. A value that was not copied
// forward (the registry refused it before reg.exe started, or reg.exe failed)
// would be lost from both keys if the original were deleted anyway: the data
// folder pointer would be gone, first-run setup would show, and the user's
// data would look lost. So the original key is kept whenever any copy was not
// saved, and the log names the value (never the value itself).
//
// reg.exe is never started: child_process is replaced by a fake that keeps
// its keys in memory and answers query, add and delete the way reg.exe does,
// and the platform is forced to Windows so the registry branch runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  keys: new Map<string, Map<string, string>>(),
  calls: [] as string[][],
  /** Names whose `add` reg.exe itself fails. */
  addFails: new Set<string>(),
}))

vi.mock('child_process', () => ({
  execFileSync: (_file: string, args: string[]) => {
    h.calls.push([...args])
    const [verb, key] = args
    const values = h.keys.get(key)
    if (verb === 'query') {
      if (!values || values.size === 0) throw new Error('ERROR: The system was unable to find the specified registry key or value.')
      if (args[2] === '/v') {
        const v = values.get(args[3])
        if (v === undefined) throw new Error('ERROR: The system was unable to find the specified registry key or value.')
        return `\r\n${key}\r\n    ${args[3]}    REG_SZ    ${v}\r\n\r\n`
      }
      return `\r\n${key}\r\n${[...values].map(([n, v]) => `    ${n}    REG_SZ    ${v}\r\n`).join('')}\r\n`
    }
    if (verb === 'add') {
      const name = args[args.indexOf('/v') + 1]
      if (h.addFails.has(name)) throw new Error('ERROR: Access is denied.')
      if (!values) h.keys.set(key, new Map())
      h.keys.get(key)!.set(name, args[args.indexOf('/d') + 1])
      return 'The operation completed successfully.\r\n'
    }
    if (verb === 'delete') {
      if (!values) throw new Error('ERROR: The system was unable to find the specified registry key or value.')
      h.keys.delete(key)
      return 'The operation completed successfully.\r\n'
    }
    throw new Error(`unexpected reg.exe call: ${args.join(' ')}`)
  },
}))
vi.mock('../../../src/main/windows-programs', () => ({ systemTool: (rel: string) => `C:\\Windows\\System32\\${rel}` }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))

const { readRegistry, migrateRegistryKeys } = await import('../../../src/main/registry')
const { logWarn } = await import('../../../src/main/debug-logger')

const ORIGINAL = 'HKCU\\Software\\Claude Conductor'
const INTERMEDIATE = 'HKCU\\Software\\Claude Command Center'
const BRAND = 'HKCU\\Software\\AI Code Conductor'
const LS = String.fromCharCode(0x2028)
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function seed(key: string, values: Record<string, string>): void {
  h.keys.set(key, new Map(Object.entries(values)))
}
const deletes = () => h.calls.filter((c) => c[0] === 'delete')
const warned = () => vi.mocked(logWarn).mock.calls.map((c) => String(c[0]))

beforeEach(() => {
  h.keys.clear()
  h.calls.length = 0
  h.addFails.clear()
  vi.mocked(logWarn).mockClear()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
})

describe('the original registry key is kept while any of its values was not copied forward', () => {
  // Mutation to prove this can fail: delete the original key whatever the copies answered.
  it('a value the registry refuses (U+2028 in a folder name): the original key and that value are kept, the others are copied', async () => {
    const data = `C:\\Users\\me\\data${LS}x`
    seed(ORIGINAL, { DataDirectory: data, InstallPath: 'C:\\Program Files\\Claude Conductor' })

    migrateRegistryKeys()

    expect(deletes()).toEqual([])
    expect(h.keys.get(ORIGINAL)?.get('DataDirectory')).toBe(data)
    expect(h.keys.get(BRAND)?.get('InstallPath')).toBe('C:\\Program Files\\Claude Conductor')
    expect(h.keys.get(BRAND)?.has('DataDirectory')).toBe(false)
    // The data folder pointer is still found on the next read.
    expect(readRegistry('DataDirectory')).toBe(data)
  })

  // Mutation to prove this can fail: decide on the value's text instead of
  // the write's answer (a reg.exe failure would then delete the original).
  it('a value reg.exe fails to save: the original key and that value are kept', async () => {
    h.addFails.add('DataDirectory')
    seed(ORIGINAL, { DataDirectory: 'C:\\Users\\me\\data', InstallPath: 'C:\\Program Files\\Claude Conductor' })

    migrateRegistryKeys()

    expect(deletes()).toEqual([])
    expect(h.keys.get(ORIGINAL)?.get('DataDirectory')).toBe('C:\\Users\\me\\data')
    expect(h.keys.get(BRAND)?.get('InstallPath')).toBe('C:\\Program Files\\Claude Conductor')
    expect(readRegistry('DataDirectory')).toBe('C:\\Users\\me\\data')
  })

  // Mutation to prove this can fail: drop the warning, or put the value in it.
  it('the log names the value that was not copied and says the original key is kept, never the value itself', async () => {
    const data = `C:\\Users\\me\\private-folder${LS}x`
    seed(ORIGINAL, { DataDirectory: data })

    migrateRegistryKeys()

    const kept = warned().filter((w) => w.includes('DataDirectory') && w.includes('kept'))
    expect(kept).toHaveLength(1)
    for (const w of warned()) expect(w).not.toContain('private-folder')
  })

  it('every value copied: the original key is deleted, as before', async () => {
    seed(ORIGINAL, { DataDirectory: 'C:\\Users\\me\\data', InstallPath: 'C:\\Program Files\\Claude Conductor' })

    migrateRegistryKeys()

    expect(deletes()).toEqual([['delete', ORIGINAL, '/f']])
    expect(h.keys.has(ORIGINAL)).toBe(false)
    expect(h.keys.get(BRAND)?.get('DataDirectory')).toBe('C:\\Users\\me\\data')
    expect(readRegistry('DataDirectory')).toBe('C:\\Users\\me\\data')
    expect(warned()).toEqual([])
  })

  it('a value the current key already holds is not copied, and the original key is deleted', async () => {
    seed(BRAND, { DataDirectory: 'D:\\current' })
    seed(ORIGINAL, { DataDirectory: `C:\\old${LS}x` })

    migrateRegistryKeys()

    expect(h.calls.filter((c) => c[0] === 'add')).toEqual([])
    expect(deletes()).toEqual([['delete', ORIGINAL, '/f']])
    expect(readRegistry('DataDirectory')).toBe('D:\\current')
  })
})

describe('an older value never stands in for a newer one that could not be copied', () => {
  // An install that went through both renames: the intermediate key holds the
  // newer data folder and the original key an older one. The newer one is
  // refused, so the current key is still missing it when the original key is
  // reached; copying the older one then would make it win on every read.
  // Mutation to prove this can fail: copy a name from an older key after the
  // newer key's copy of it was refused.
  it('the newer folder is refused: the older one is not copied, and the newer one is still what is read', async () => {
    const newer = `C:\\Users\\me\\newer${LS}x`
    seed(INTERMEDIATE, { DataDirectory: newer })
    seed(ORIGINAL, { DataDirectory: 'C:\\Users\\me\\older', InstallPath: 'C:\\Program Files\\Claude Conductor' })

    migrateRegistryKeys()

    expect(h.keys.get(BRAND)?.has('DataDirectory')).toBe(false)
    expect(h.keys.get(BRAND)?.get('InstallPath')).toBe('C:\\Program Files\\Claude Conductor')
    // Both legacy keys are kept, each with its own value.
    expect(deletes()).toEqual([])
    expect(h.keys.get(INTERMEDIATE)?.get('DataDirectory')).toBe(newer)
    expect(h.keys.get(ORIGINAL)?.get('DataDirectory')).toBe('C:\\Users\\me\\older')
    expect(readRegistry('DataDirectory')).toBe(newer)
  })

  it('the newer folder is copied: the older one is not, and the original key is deleted, as before', async () => {
    seed(INTERMEDIATE, { DataDirectory: 'C:\\Users\\me\\newer' })
    seed(ORIGINAL, { DataDirectory: 'C:\\Users\\me\\older' })

    migrateRegistryKeys()

    expect(h.keys.get(BRAND)?.get('DataDirectory')).toBe('C:\\Users\\me\\newer')
    expect(deletes()).toEqual([['delete', ORIGINAL, '/f']])
    expect(readRegistry('DataDirectory')).toBe('C:\\Users\\me\\newer')
  })
})
