import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
// Plain ESM with main() behind an entry-point check: importing it runs nothing.
import {
  bundledHelperProblems,
  cargoVersion,
  elfStaticProblems,
  expectedEntries,
  findResourcesDirs,
  helperExeName,
  LINUX_HELPER,
  LINUX_HELPER_SOURCE,
  makeManifest,
  MANIFEST,
  MANIFEST_SOURCE,
  manifestProblems,
  manifestText,
  sha256Hex,
} from '../../../scripts/verify-bundled-helper.mjs'
import { helperManifest } from '../../../scripts/write-helper-manifest.mjs'
import { buildPe, STATIC_HELPER, TODAYS_HELPER } from './pe-image'
import { buildElf } from './elf-image'
import { escapeRegExp } from '../../helpers/escape-regexp'

// The packaging check that the installer carries the session helper
// (2.1.3-beta.6, plan section B), and on Windows that the packaged copy
// carries its own C runtime (2.1.3-beta.8 section C4). From 2.1.3-beta.17
// (A1, remote step 1) the Windows package also carries the static Linux
// helper and its manifest. It is handed a fake folder and a fake `version`
// run, so nothing starts here.

const ROOT = resolve(__dirname, '../../..')
const RES = join('dist', 'win-unpacked', 'resources')
const MZ = Buffer.from('MZ\x90\x00')
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
/** A Windows helper that carries its own C runtime, and today's that does not (pe-image.ts). */
const WIN_STATIC = Buffer.from(buildPe({ imports: STATIC_HELPER }).bytes)
const WIN_TODAY = Buffer.from(buildPe({ imports: TODAYS_HELPER }).bytes)
/** A static-pie x86-64 program, as Rust's musl target links it (elf-image.ts). */
const LINUX_STATIC = buildElf({ body: [1, 2, 3, 4] })

function fakeFs(files: Record<string, Buffer>) {
  return {
    list: (dir: string) => {
      const prefix = `${dir}${dir.includes('\\') ? '\\' : '/'}`
      const inside = Object.keys(files).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split(/[\\/]/)[0])
      return inside.length === 0 && !(dir in files) ? null : [...new Set(inside)]
    },
    size: (file: string) => files[file]?.length ?? 0,
    head: (file: string, n: number) => (files[file] ?? Buffer.alloc(0)).subarray(0, n),
    read: vi.fn((file: string) => files[file] ?? Buffer.alloc(0)),
  }
}

function check(platform: 'win32' | 'darwin' | 'linux', files: Record<string, Buffer>, said: string | (() => string) = 'aicc-helper 0.1.0\n') {
  const version = vi.fn(typeof said === 'function' ? said : () => said)
  const fs = fakeFs(files)
  const problems = bundledHelperProblems(RES, { platform, expectedVersion: '0.1.0', fs, version })
  return { problems, version, read: fs.read }
}

const exe = (platform: 'win32' | 'darwin' | 'linux') => join(RES, 'helper', helperExeName(platform))
const linuxHelper = join(RES, 'helper', 'linux-x64', 'aicc-helper')
const linuxFolder = join(RES, 'helper', 'linux-x64')
const manifestFile = join(RES, 'helper', 'manifest.json')

/** The manifest for `bytes`, as the writer writes it. */
const manifestFor = (bytes: Buffer, version = '0.1.0') => Buffer.from(manifestText(makeManifest({ version, sha256: sha256Hex(bytes) })))

/** A whole Windows package: the helper, the static Linux helper and its manifest, each as given. */
function windowsPackage(over: { exe?: Buffer; linux?: Buffer | null; manifest?: Buffer | null; more?: Record<string, Buffer> } = {}) {
  const linux = over.linux === undefined ? LINUX_STATIC : over.linux
  const files: Record<string, Buffer> = { [exe('win32')]: over.exe ?? WIN_STATIC }
  if (linux !== null) files[linuxHelper] = linux
  const manifest = over.manifest === undefined ? manifestFor(linux ?? LINUX_STATIC) : over.manifest
  if (manifest !== null) files[manifestFile] = manifest
  return { ...files, ...(over.more ?? {}) }
}

describe('verify-bundled-helper: the installer carries the session helper', () => {
  it('the right program for each OS, saying the version helper/Cargo.toml names, passes (Windows with the Linux helper and its manifest)', () => {
    for (const [platform, files] of [
      ['win32', windowsPackage()],
      ['linux', { [exe('linux')]: Buffer.concat([ELF, Buffer.alloc(100)]) }],
      ['darwin', { [exe('darwin')]: Buffer.concat([MACHO, Buffer.alloc(100)]) }],
    ] as const) {
      const { problems, version, read } = check(platform, files)
      expect(problems, platform).toEqual([])
      expect(version).toHaveBeenCalledWith(exe(platform))
      // Only the Windows package's files are read whole: its helper's imports,
      // the Linux helper and the manifest. The others are not PE images.
      if (platform === 'win32') expect(read.mock.calls.map((c) => c[0]).sort()).toEqual([exe('win32'), linuxHelper, manifestFile].sort())
      else expect(read).not.toHaveBeenCalled()
    }
    expect(helperExeName('win32')).toBe('aicc-helper.exe')
    expect(helperExeName('linux')).toBe('aicc-helper')
    expect(expectedEntries('win32')).toEqual(['aicc-helper.exe', 'linux-x64', 'manifest.json'])
    expect(expectedEntries('linux')).toEqual(['aicc-helper'])
    expect(expectedEntries('darwin')).toEqual(['aicc-helper'])
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
    const { problems, version } = check('win32', windowsPackage({ more: { [join(RES, 'helper', 'aicc-fake-cli.exe')]: MZ } }))
    expect(problems).toEqual([`${join(RES, 'helper')} holds more than the helper: aicc-fake-cli.exe`])
    expect(version).not.toHaveBeenCalled()
    // The Linux helper's folder and the manifest belong only to the Windows package.
    for (const platform of ['linux', 'darwin'] as const) {
      const more = check(platform, { [exe(platform)]: platform === 'linux' ? ELF : MACHO, [join(RES, 'helper', 'linux-x64', 'aicc-helper')]: LINUX_STATIC, [join(RES, 'helper', 'manifest.json')]: Buffer.from('{}') })
      expect(more.problems, platform).toEqual([`${join(RES, 'helper')} holds more than the helper: linux-x64, manifest.json`])
    }
  })

  it('an empty file, or a program for another OS, fails before it is run', () => {
    expect(check('win32', windowsPackage({ exe: Buffer.alloc(0) })).problems).toEqual([`${exe('win32')} is empty or not a file`])
    for (const [platform, wrong] of [['win32', ELF], ['linux', MZ], ['darwin', ELF]] as const) {
      const { problems, version } = check(platform, platform === 'win32' ? windowsPackage({ exe: wrong }) : { [exe(platform)]: wrong })
      expect(problems, platform).toEqual([`${exe(platform)} is not a program for ${platform}`])
      expect(version).not.toHaveBeenCalled()
    }
  })

  it('another version, or a version run that fails, fails', () => {
    expect(check('linux', { [exe('linux')]: ELF }, 'aicc-helper 0.0.9\n').problems).toEqual([`${exe('linux')} says "aicc-helper 0.0.9", not "aicc-helper 0.1.0"`])
    expect(check('linux', { [exe('linux')]: ELF }, () => { throw new Error('exit 1') }).problems).toEqual([`${exe('linux')} version did not run: exit 1`])
  })

  it('a packaged Windows helper that imports a C runtime DLL fails before it is run (the signed copy that ships is checked)', () => {
    const { problems, version } = check('win32', windowsPackage({ exe: WIN_TODAY }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(new RegExp(`^${escapeRegExp(exe('win32'))} does not carry its own C runtime: it imports VCRUNTIME140\\.dll, api-ms-win-crt-runtime-l1-1-0\\.dll, `))
    expect(problems[0]).toContain("Windows cannot start it on a PC without Microsoft's Visual C++ runtime.")
    expect(version).not.toHaveBeenCalled()
    const one = check('win32', windowsPackage({ exe: Buffer.from(buildPe({ imports: ['kernel32.dll', 'VCRUNTIME140.dll'] }).bytes) }))
    expect(one.problems).toEqual([`${exe('win32')} does not carry its own C runtime: it imports VCRUNTIME140.dll. Windows cannot start it on a PC without Microsoft's Visual C++ runtime. All its imports: kernel32.dll, VCRUNTIME140.dll.`])
  })

  it('a packaged Windows helper that names no DLL, is not x64, or cannot be read as a program fails before it is run', () => {
    const none = check('win32', windowsPackage({ exe: Buffer.from(buildPe().bytes) }))
    expect(none.problems).toEqual([`${exe('win32')} names no imported DLL, so this check would prove nothing about it.`])
    expect(none.version).not.toHaveBeenCalled()
    const x86 = check('win32', windowsPackage({ exe: Buffer.from(buildPe({ plus: false, imports: STATIC_HELPER }).bytes) }))
    expect(x86.problems).toEqual([`${exe('win32')} is built for x86, not x64: the Windows installer ships an x64 helper only (package.json build.win.target).`])
    expect(x86.version).not.toHaveBeenCalled()
    // MZ and nothing behind it: the magic check passes, the import table cannot be read.
    const bare = check('win32', windowsPackage({ exe: Buffer.concat([MZ, Buffer.alloc(100)]) }))
    expect(bare.problems).toEqual([`${exe('win32')} cannot be read as a Windows program: no PE signature at offset 0`])
    expect(bare.version).not.toHaveBeenCalled()
  })

  it('runs main() whenever node is started with it, by any path (a junction included)', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'verify-bundled-helper.mjs'), 'utf8').replace(/\r\n/g, '\n')
    expect(src).toMatch(/\nif \(isEntryPoint\(process\.argv\[1\], import\.meta\.url\)\) main\(\)\n?$/)
    expect(src).not.toContain('resolve(process.argv[1]) === fileURLToPath(import.meta.url)')
    const writer = readFileSync(join(ROOT, 'scripts', 'write-helper-manifest.mjs'), 'utf8').replace(/\r\n/g, '\n')
    expect(writer).toMatch(/\nif \(isEntryPoint\(process\.argv\[1\], import\.meta\.url\)\) process\.exitCode = main\(\)\n?$/)
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

describe('verify-bundled-helper: the Windows package carries the static Linux helper and its manifest (2.1.3-beta.17)', () => {
  it('the paths are the ones the app reads and the release job writes', () => {
    expect(LINUX_HELPER).toBe('linux-x64/aicc-helper')
    expect(MANIFEST).toBe('manifest.json')
    expect(LINUX_HELPER_SOURCE).toBe('helper/target/helper-linux-musl/aicc-helper')
    expect(MANIFEST_SOURCE).toBe('helper/target/helper-manifest/manifest.json')
  })

  it('no Linux helper, or more beside it, fails, and the Windows helper is not run', () => {
    const missing = check('win32', windowsPackage({ linux: null, manifest: manifestFor(LINUX_STATIC) }))
    expect(missing.problems).toEqual([`${linuxFolder} is missing: the Windows package carries the static Linux helper there`])
    expect(missing.version).not.toHaveBeenCalled()
    const crowded = check('win32', windowsPackage({ more: { [join(linuxFolder, 'aicc-fake-cli')]: LINUX_STATIC } }))
    expect(crowded.problems).toEqual([`${linuxFolder} holds more than the Linux helper: aicc-fake-cli`])
    expect(crowded.version).not.toHaveBeenCalled()
    const empty = check('win32', windowsPackage({ linux: Buffer.alloc(0) }))
    expect(empty.problems).toEqual([`${linuxHelper} is empty or not a file`])
  })

  it('a Linux helper that is not a static x86-64 program fails, and the Windows helper is not run', () => {
    for (const [wrong, why] of [
      [buildElf({ needed: true }), 'names a shared library (a NEEDED entry), so it is not static'],
      [buildElf({ interp: true }), 'names a program interpreter (an INTERP header), so it is not static'],
      [buildElf({ machine: 183 }), 'is built for ELF machine 183, not x86-64 (62)'],
      [Buffer.concat([MZ, Buffer.alloc(100)]), 'is not an ELF file'],
    ] as const) {
      const { problems, version } = check('win32', windowsPackage({ linux: wrong }))
      expect(problems, why).toEqual([`${linuxHelper} ${why}`])
      expect(version).not.toHaveBeenCalled()
    }
  })

  it('a manifest that is missing, holds another hash, or names the Windows helper fails, and the Windows helper is not run', () => {
    const none = check('win32', windowsPackage({ manifest: null }))
    expect(none.problems).toEqual([`${manifestFile} is missing or empty`])
    expect(none.version).not.toHaveBeenCalled()
    // The hash of another Linux helper: the packaged one is not the one the manifest names.
    const other = buildElf({ body: [9, 9, 9, 9] })
    const wrongHash = check('win32', windowsPackage({ manifest: manifestFor(other) }))
    expect(wrongHash.problems).toEqual([`${manifestFile} says sha256 ${sha256Hex(other)}, but the packaged Linux helper's is ${sha256Hex(LINUX_STATIC)}`])
    expect(wrongHash.version).not.toHaveBeenCalled()
    const winListed = { v: 1, files: [{ path: 'aicc-helper.exe', version: '0.1.0', sha256: sha256Hex(WIN_STATIC) }] }
    const named = check('win32', windowsPackage({ manifest: Buffer.from(JSON.stringify(winListed)) }))
    expect(named.problems).toHaveLength(1)
    expect(named.problems[0]).toMatch(/lists the Windows helper, which electron-builder signs in the package after the manifest is written/)
    expect(named.version).not.toHaveBeenCalled()
  })

  it('reads a static-pie program, a fully static one and a dynamic one as the Helper job\'s readelf check does', () => {
    expect(elfStaticProblems(buildElf())).toEqual([])
    expect(elfStaticProblems(buildElf({ dynamic: false }))).toEqual([])
    expect(elfStaticProblems(buildElf({ needed: true }))).toEqual(['names a shared library (a NEEDED entry), so it is not static'])
    expect(elfStaticProblems(buildElf({ interp: true, needed: true }))).toEqual(['names a program interpreter (an INTERP header), so it is not static', 'names a shared library (a NEEDED entry), so it is not static'])
    expect(elfStaticProblems(buildElf({ cls: 1 }))).toEqual(['is not a 64-bit ELF file'])
    expect(elfStaticProblems(buildElf({ machine: 183 }))).toEqual(['is built for ELF machine 183, not x86-64 (62)'])
    expect(elfStaticProblems(Buffer.from('not a program at all, but long enough to read a header from it............'))).toEqual(['is not an ELF file'])
    // Program headers that run past the end of the file.
    expect(elfStaticProblems(buildElf().subarray(0, 100))).toEqual(['has no program headers that can be read'])
  })

  it('the manifest is exactly {v: 1, files: [{path, version, sha256}]}, its one entry the Linux helper', () => {
    const sha256 = sha256Hex(LINUX_STATIC)
    const good = { v: 1, files: [{ path: 'linux-x64/aicc-helper', version: '0.1.0', sha256 }] }
    const problems = (m: unknown) => manifestProblems(typeof m === 'string' ? m : JSON.stringify(m), { expectedVersion: '0.1.0', sha256 })
    expect(problems(good)).toEqual([])
    expect(makeManifest({ version: '0.1.0', sha256 })).toEqual(good)
    expect(manifestText(good)).toBe(`${JSON.stringify(good, null, 2)}\n`)
    expect(problems('not json')).toEqual(['is not JSON'])
    expect(problems([good])).toEqual(['is not a JSON object'])
    expect(problems({ ...good, extra: 1 })).toEqual(['has the fields extra, files, v, not exactly v and files'])
    expect(problems({ ...good, v: 2 })).toEqual(['is version 2, not 1'])
    expect(problems({ v: 1, files: {} })).toEqual(['files is not a list'])
    expect(problems({ v: 1, files: [] })).toEqual(['lists 0 files, not exactly one (the Linux helper)'])
    expect(problems({ v: 1, files: [good.files[0], { ...good.files[0], path: 'darwin-arm64/aicc-helper' }] })).toEqual(['lists 2 files, not exactly one (the Linux helper)'])
    expect(problems({ v: 1, files: [{ path: 'linux-x64/aicc-helper', version: '0.1.0' }] })).toEqual(['its entry has the fields path, version, not exactly path, version and sha256'])
    expect(problems({ v: 1, files: [{ ...good.files[0], path: 'aicc-helper' }] })).toEqual(['names "aicc-helper", not linux-x64/aicc-helper'])
    expect(problems({ v: 1, files: [{ ...good.files[0], version: '0.0.9' }] })).toEqual(['says version "0.0.9", not 0.1.0'])
    expect(problems({ v: 1, files: [{ ...good.files[0], sha256: sha256.toUpperCase() }] })).toEqual(['has a sha256 that is not 64 lower-case hex characters'])
    expect(problems({ v: 1, files: [{ ...good.files[0], sha256: '0'.repeat(64) }] })).toEqual([`says sha256 ${'0'.repeat(64)}, but the packaged Linux helper's is ${sha256}`])
    // The Windows helper is refused wherever it is listed, beside the Linux helper too.
    for (const path of ['aicc-helper.exe', 'resources/helper/aicc-helper.exe', 'AICC-HELPER.EXE']) {
      expect(problems({ v: 1, files: [good.files[0], { ...good.files[0], path }] })[0], path).toMatch(/^lists the Windows helper/)
    }
  })

  it('the writer makes the manifest the check accepts, and refuses a Linux helper that is not static before anything is packaged', () => {
    const cargo = '[package]\nname = "aicc-helper"\nversion = "0.1.0"\n'
    const made = helperManifest(LINUX_STATIC, cargo)
    expect(made.problems).toEqual([])
    expect(made.text).toBe(manifestText(makeManifest({ version: '0.1.0', sha256: sha256Hex(LINUX_STATIC) })))
    expect(manifestProblems(made.text!, { expectedVersion: '0.1.0', sha256: sha256Hex(LINUX_STATIC) })).toEqual([])
    // And the whole package with it passes.
    expect(check('win32', windowsPackage({ manifest: Buffer.from(made.text!) })).problems).toEqual([])
    expect(helperManifest(buildElf({ needed: true }), cargo)).toEqual({ problems: [`${LINUX_HELPER_SOURCE} names a shared library (a NEEDED entry), so it is not static`] })
    expect(helperManifest(null, cargo)).toEqual({ problems: [`${LINUX_HELPER_SOURCE} is missing or empty`] })
    expect(helperManifest(Buffer.alloc(0), cargo)).toEqual({ problems: [`${LINUX_HELPER_SOURCE} is missing or empty`] })
    expect(helperManifest(LINUX_STATIC, '[dependencies]\n')).toEqual({ problems: ['helper/Cargo.toml names no package version'] })
  })
})
