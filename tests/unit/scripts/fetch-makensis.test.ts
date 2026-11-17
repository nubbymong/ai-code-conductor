import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { envLines, main, nsisSettings } from '../../../scripts/ci/fetch-makensis.mjs'

/**
 * scripts/ci/fetch-makensis.mjs: electron-builder's own NSIS compiler for the
 * makensis probes on ci.yml's Windows test parts. No network here: the
 * compiler lookup, the file check and the writes are all stand-ins.
 */

const EXE = 'C:\\cache\\nsis-3.0.4.1\\nsis-3.0.4.1-abc\\Bin\\makensis.exe'
const DIR = 'C:\\cache\\nsis-3.0.4.1\\nsis-3.0.4.1-abc'

function harness(result: unknown, exists = true) {
  const calls: unknown[][] = []
  const logs: string[] = []
  const errors: string[] = []
  const writes: Array<[string, string]> = []
  const io = {
    platform: 'win32',
    log: (s: string) => logs.push(s),
    error: (s: string) => errors.push(s),
    write: (file: string, text: string) => writes.push([file, text]),
    exists: () => exists,
    getMakeNsisPath: async (...args: unknown[]) => {
      calls.push(args)
      if (result instanceof Error) throw result
      return result
    },
  }
  return { io, calls, logs, errors, writes }
}

describe('fetch-makensis: electron-builder\'s NSIS compiler for the CI probes', () => {
  it('names the compiler, and the NSIS folder when electron-builder sets one', () => {
    expect(envLines({ path: EXE, env: { NSISDIR: DIR } }, () => true)).toEqual([`MAKENSIS=${EXE}`, `NSISDIR=${DIR}`])
    expect(envLines({ path: EXE }, () => true)).toEqual([`MAKENSIS=${EXE}`])
    expect(envLines({ path: EXE, env: { NSISDIR: '' } }, () => true)).toEqual([`MAKENSIS=${EXE}`])
  })

  it('refuses a compiler that is not there, none at all, or a value that would break GITHUB_ENV', () => {
    expect(() => envLines({ path: EXE }, () => false)).toThrow(/not there/)
    expect(() => envLines({ path: '' }, () => true)).toThrow(/no makensis/)
    expect(() => envLines(null, () => true)).toThrow(/no makensis/)
    expect(() => envLines({ path: `${EXE}\nEVIL=1` }, () => true)).toThrow(/line break/)
    expect(() => envLines({ path: EXE, env: { NSISDIR: `${DIR}\r\nEVIL=1` } }, () => true)).toThrow(/line break/)
  })

  it('asks for the compiler with the settings a release build passes, from package.json', () => {
    expect(nsisSettings({ build: { toolsets: { nsis: '1.2.1' }, nsis: { customNsisBinary: { url: 'u' } } } })).toEqual(['1.2.1', { url: 'u' }])
    expect(nsisSettings({ build: {} })).toEqual([undefined, undefined])
    expect(nsisSettings({})).toEqual([undefined, undefined])
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf-8'))
    expect(nsisSettings(pkg)).toEqual([pkg.build?.toolsets?.nsis, pkg.build?.nsis?.customNsisBinary])
  })

  it('appends MAKENSIS (and NSISDIR) to GITHUB_ENV for the later steps', async () => {
    const h = harness({ path: EXE, env: { NSISDIR: DIR } })
    expect(await main({ GITHUB_ENV: 'D:\\a\\_temp\\env' }, h.io)).toBe(0)
    expect(h.calls).toHaveLength(1)
    expect(h.writes).toEqual([['D:\\a\\_temp\\env', `MAKENSIS=${EXE}\nNSISDIR=${DIR}\n`]])
    expect(h.errors).toEqual([])
  })

  it('fails the step when electron-builder cannot provide it', async () => {
    const down = harness(new Error('download failed'))
    expect(await main({ GITHUB_ENV: 'x' }, down.io)).toBe(1)
    expect(down.errors.join('\n')).toMatch(/download failed/)
    expect(down.writes).toEqual([])

    const missing = harness({ path: EXE }, false)
    expect(await main({ GITHUB_ENV: 'x' }, missing.io)).toBe(1)
    expect(missing.writes).toEqual([])
  })

  it('does nothing anywhere but Windows', async () => {
    const h = harness({ path: EXE })
    expect(await main({ GITHUB_ENV: 'x' }, { ...h.io, platform: 'linux' })).toBe(0)
    expect(h.calls).toEqual([])
    expect(h.writes).toEqual([])
  })
})
