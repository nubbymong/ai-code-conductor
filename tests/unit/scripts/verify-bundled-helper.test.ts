import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
// Plain ESM with main() behind an argv[1] check: importing it runs nothing.
import { bundledHelperProblems, cargoVersion, findResourcesDirs, helperExeName } from '../../../scripts/verify-bundled-helper.mjs'

// The packaging check that the installer carries the session helper
// (2.1.3-beta.6, plan section B). It is handed a fake folder and a fake
// `version` run, so nothing starts here.

const ROOT = resolve(__dirname, '../../..')
const RES = join('dist', 'win-unpacked', 'resources')
const MZ = Buffer.from('MZ\x90\x00')
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe])

function fakeFs(files: Record<string, Buffer>) {
  return {
    list: (dir: string) => {
      const inside = Object.keys(files).filter((f) => f.startsWith(`${dir}${dir.includes('\\') ? '\\' : '/'}`))
      return inside.length === 0 && !(dir in files) ? null : inside.map((f) => f.slice(dir.length + 1))
    },
    size: (file: string) => files[file]?.length ?? 0,
    head: (file: string, n: number) => (files[file] ?? Buffer.alloc(0)).subarray(0, n),
  }
}

function check(platform: 'win32' | 'darwin' | 'linux', files: Record<string, Buffer>, said: string | (() => string) = 'aicc-helper 0.1.0\n') {
  const version = vi.fn(typeof said === 'function' ? said : () => said)
  const problems = bundledHelperProblems(RES, { platform, expectedVersion: '0.1.0', fs: fakeFs(files), version })
  return { problems, version }
}

const exe = (platform: 'win32' | 'darwin' | 'linux') => join(RES, 'helper', helperExeName(platform))

describe('verify-bundled-helper: the installer carries the session helper', () => {
  it('the right program for each OS, saying the version helper/Cargo.toml names, passes', () => {
    for (const [platform, magic] of [['win32', MZ], ['linux', ELF], ['darwin', MACHO]] as const) {
      const { problems, version } = check(platform, { [exe(platform)]: Buffer.concat([magic, Buffer.alloc(100)]) })
      expect(problems, platform).toEqual([])
      expect(version).toHaveBeenCalledWith(exe(platform))
    }
    expect(helperExeName('win32')).toBe('aicc-helper.exe')
    expect(helperExeName('linux')).toBe('aicc-helper')
  })

  it('no helper folder, or no helper in it, fails', () => {
    expect(check('win32', {}).problems).toEqual([`${join(RES, 'helper')} is missing`])
    const { problems, version } = check('win32', { [join(RES, 'helper', 'something.txt')]: Buffer.from('x') })
    expect(problems).toEqual([
      `${join(RES, 'helper')} holds more than the helper: something.txt`,
      `${exe('win32')} is missing`,
    ])
    expect(version).not.toHaveBeenCalled()
  })

  it('anything else in the folder fails, the program is not run', () => {
    const { problems, version } = check('win32', { [exe('win32')]: MZ, [join(RES, 'helper', 'aicc-fake-cli.exe')]: MZ })
    expect(problems).toEqual([`${join(RES, 'helper')} holds more than the helper: aicc-fake-cli.exe`])
    expect(version).not.toHaveBeenCalled()
  })

  it('an empty file, or a program for another OS, fails before it is run', () => {
    expect(check('win32', { [exe('win32')]: Buffer.alloc(0) }).problems).toEqual([`${exe('win32')} is empty or not a file`])
    for (const [platform, wrong] of [['win32', ELF], ['linux', MZ], ['darwin', ELF]] as const) {
      const { problems, version } = check(platform, { [exe(platform)]: wrong })
      expect(problems, platform).toEqual([`${exe(platform)} is not a program for ${platform}`])
      expect(version).not.toHaveBeenCalled()
    }
  })

  it('another version, or a version run that fails, fails', () => {
    expect(check('linux', { [exe('linux')]: ELF }, 'aicc-helper 0.0.9\n').problems).toEqual([`${exe('linux')} says "aicc-helper 0.0.9", not "aicc-helper 0.1.0"`])
    expect(check('linux', { [exe('linux')]: ELF }, () => { throw new Error('exit 1') }).problems).toEqual([`${exe('linux')} version did not run: exit 1`])
  })

  it('reads the version from helper/Cargo.toml\'s package section', () => {
    expect(cargoVersion('[package]\nname = "aicc-helper"\nversion = "1.2.3"\n\n[dependencies]\nx = "=0.1.0"\n')).toBe('1.2.3')
    expect(cargoVersion('[dependencies]\nversion = "9.9.9"\n')).toBeNull()
    expect(cargoVersion(readFileSync(join(ROOT, 'helper', 'Cargo.toml'), 'utf8'))).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('finds every packaged resources folder: the parent of each app.asar.unpacked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aicc-verify-helper-'))
    try {
      mkdirSync(join(dir, 'win-unpacked', 'resources', 'app.asar.unpacked'), { recursive: true })
      mkdirSync(join(dir, 'mac-arm64', 'App.app', 'Contents', 'Resources', 'app.asar.unpacked'), { recursive: true })
      writeFileSync(join(dir, 'latest.yml'), 'x')
      expect(findResourcesDirs(dir).sort()).toEqual([
        join(dir, 'mac-arm64', 'App.app', 'Contents', 'Resources'),
        join(dir, 'win-unpacked', 'resources'),
      ].sort())
      expect(findResourcesDirs(join(dir, 'nothing-here'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
