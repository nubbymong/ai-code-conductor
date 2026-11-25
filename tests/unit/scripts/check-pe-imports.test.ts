import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
// Plain ESM with main() behind an entry-point check: importing it runs nothing.
import { CRT_DLL, WINDOW_MANAGER_DLL, isCrtDll, isVcRuntimeDll, isWindowManagerDll, readImports, importProblems, isEntryPoint, machineName, main } from '../../../scripts/check-pe-imports.mjs'
import { buildPe, SECTION_RVA, TODAYS_HELPER, STATIC_HELPER, WINDOW_MANAGER_DLLS, CAPTURE_HELPER_LOAD_TIME } from './pe-image'

/**
 * The session helper carries its own C runtime on Windows (2.1.3-beta.8
 * section C4): scripts/check-pe-imports.mjs reads a program's import tables and
 * fails on a C runtime DLL, and every Windows build of the shipped helper runs
 * it. The images here are built in memory (pe-image.ts); no program is read
 * from disk or run.
 */

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')

function run(files: Record<string, Uint8Array | Error>, argv = Object.keys(files)) {
  const out: string[] = []
  const err: string[] = []
  const code = main(argv, {
    readFile: (f: string) => {
      const got = files[f]
      if (got instanceof Error) throw got
      if (!got) throw new Error(`ENOENT: ${f}`)
      return got
    },
    log: (s: string) => out.push(s),
    error: (s: string) => err.push(s),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

// ---------------------------------------------------------------- which DLLs count

describe('isCrtDll: the Visual C++ runtime and the Universal C runtime, nothing else', () => {
  it('names every C runtime DLL, in any letter case, debug builds included, with or without .dll', () => {
    for (const n of [
      'VCRUNTIME140.dll', 'vcruntime140.dll', 'VCRUNTIME140_1.dll', 'vcruntime140d.dll', 'vcruntime140_1d.dll',
      'MSVCP140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll', 'msvcp140d.dll',
      'msvcp140d_atomic_wait.dll', 'msvcp140d_codecvt_ids.dll',
      'MSVCR120.dll', 'msvcr100.dll', 'concrt140.dll', 'vccorlib140.dll', 'vcomp140.dll',
      'ucrtbase.dll', 'ucrtbased.dll',
      'api-ms-win-crt-runtime-l1-1-0.dll', 'API-MS-WIN-CRT-HEAP-L1-1-0.DLL', 'api-ms-win-crt-stdio-l1-1-0.dll', 'api-ms-win-crt-private-l1-1-0.dll',
      // Windows adds .dll to a module name that has none, so these load the same DLLs.
      'VCRUNTIME140', 'msvcp140d_atomic_wait', 'ucrtbase', 'api-ms-win-crt-heap-l1-1-0',
    ]) expect(isCrtDll(n), n).toBe(true)
  })

  it('leaves Windows itself alone: kernel32, ntdll, the core API sets and the OS copy of msvcrt.dll', () => {
    for (const n of [
      'kernel32.dll', 'KERNEL32.dll', 'kernel32', 'ntdll.dll', 'advapi32.dll', 'bcrypt.dll', 'bcryptprimitives.dll', 'user32.dll', 'ws2_32.dll',
      'api-ms-win-core-synch-l1-2-0.dll', 'api-ms-win-core-libraryloader-l1-2-0.dll', 'msvcrt.dll', 'msvcrt',
      'vcruntime140.dll.bak', 'myvcruntime140.dll', 'api-ms-win-crt-.dll', 'api-ms-win-crt-', '', 'vcruntime.dll',
    ]) expect(isCrtDll(n), n).toBe(false)
    expect(isCrtDll(undefined as unknown as string)).toBe(false)
    expect(CRT_DLL.flags).toContain('i')
  })

  it('tells the Visual C++ runtime (missing on a fresh Windows) from the Universal C runtime (part of Windows 10 and later)', () => {
    for (const n of ['VCRUNTIME140.dll', 'vcruntime140_1d.dll', 'MSVCP140.dll', 'msvcp140d_atomic_wait.dll', 'concrt140.dll', 'VCRUNTIME140']) expect(isVcRuntimeDll(n), n).toBe(true)
    for (const n of ['ucrtbase.dll', 'ucrtbased.dll', 'api-ms-win-crt-heap-l1-1-0.dll', 'kernel32.dll', 'msvcrt.dll', '']) expect(isVcRuntimeDll(n), n).toBe(false)
  })
})

describe('isWindowManagerDll: user32, gdi32 and shcore, by name or API set, nothing else', () => {
  it('names each, in any letter case, with or without .dll, and the API set names that lead to them', () => {
    for (const n of [
      ...WINDOW_MANAGER_DLLS, 'USER32.dll', 'user32', 'GDI32.DLL', 'gdi32', 'shcore.dll', 'SHCORE',
      'api-ms-win-shcore-scaling-l1-1-1.dll', 'API-MS-WIN-SHCORE-SCALING-L1-1-1.DLL', 'api-ms-win-shcore-scaling-l1-1-0',
      'ext-ms-win-ntuser-window-l1-1-0.dll', 'api-ms-win-ntuser-sysparams-l1-1-0.dll', 'ext-ms-win-gdi-dc-l1-2-0.dll',
    ]) expect(isWindowManagerDll(n), n).toBe(true)
  })

  it("leaves the base helper's DLLs alone, and names that only look like one", () => {
    for (const n of [
      ...STATIC_HELPER, 'msvcrt.dll', 'ws2_32.dll', 'user32.dll.bak', 'myuser32.dll', 'user.dll', 'gdi32full.dll', 'shcore32.dll',
      'api-ms-win-shcore-.dll', 'api-ms-win-core-libraryloader-l1-2-0.dll', '',
    ]) expect(isWindowManagerDll(n), n).toBe(false)
    expect(isWindowManagerDll(undefined as unknown as string)).toBe(false)
    expect(WINDOW_MANAGER_DLL.flags).toContain('i')
  })
})

// ---------------------------------------------------------------- reading the tables

describe('readImports: the import and delay-load tables of a PE image', () => {
  it('reads a PE32+ image: every imported DLL, in file order', () => {
    const { bytes } = buildPe({ imports: TODAYS_HELPER })
    expect(readImports(bytes)).toEqual({ format: 'PE32+', machine: 0x8664, imports: TODAYS_HELPER, delayImports: [] })
  })

  it('reads a PE32 image the same way', () => {
    const { bytes } = buildPe({ plus: false, imports: ['KERNEL32.dll', 'VCRUNTIME140.dll'] })
    expect(readImports(bytes)).toEqual({ format: 'PE32', machine: 0x14c, imports: ['KERNEL32.dll', 'VCRUNTIME140.dll'], delayImports: [] })
  })

  it('reads the delay-load table, with addresses in the image (attribute bit 0 set)', () => {
    const { bytes } = buildPe({ imports: ['kernel32.dll'], delay: ['VCRUNTIME140.dll', 'user32.dll'] })
    expect(readImports(bytes).delayImports).toEqual(['VCRUNTIME140.dll', 'user32.dll'])
  })

  it('reads an old delay-load table that holds full virtual addresses (attribute bit 0 clear), taking the image base off', () => {
    const { bytes } = buildPe({ plus: false, imports: ['kernel32.dll'], delay: ['MSVCP140.dll'], delayAttributes: 0, imageBase: 0x400000 })
    expect(readImports(bytes).delayImports).toEqual(['MSVCP140.dll'])
  })

  it('an image with no import table lists nothing', () => {
    expect(readImports(buildPe().bytes)).toEqual({ format: 'PE32+', machine: 0x8664, imports: [], delayImports: [] })
  })

  it('reads only the data directories the optional header says it has', () => {
    // Two directories: the import table (1) is read, the delay-load table (13) is
    // not, even though its bytes are there.
    const two = buildPe({ imports: ['kernel32.dll'], delay: ['VCRUNTIME140.dll'], dirCount: 2 })
    expect(readImports(two.bytes)).toEqual({ format: 'PE32+', machine: 0x8664, imports: ['kernel32.dll'], delayImports: [] })
    const one = buildPe({ imports: ['kernel32.dll'], dirCount: 1 })
    expect(readImports(one.bytes).imports).toEqual([])
  })

  it('a DLL name inside the headers is read from there (an address below SizeOfHeaders is a file offset)', () => {
    const b = buildPe({ imports: ['kernel32.dll'] })
    const at = b.sectionAt + 40 + 8 // after the section table, still inside the headers (they end at 0x200)
    const name = 'user32.dll'
    for (let k = 0; k < name.length; k++) b.bytes[at + k] = name.charCodeAt(k)
    new DataView(b.bytes.buffer).setUint32(b.importAt + 12, at, true)
    expect(readImports(b.bytes).imports).toEqual(['user32.dll'])
  })

  it('reads a Buffer as well as a Uint8Array, at any offset in its memory', () => {
    const { bytes } = buildPe({ imports: ['kernel32.dll'] })
    const padded = new Uint8Array(bytes.length + 7)
    padded.set(bytes, 7)
    expect(readImports(padded.subarray(7)).imports).toEqual(['kernel32.dll'])
    expect(readImports(Buffer.from(bytes)).imports).toEqual(['kernel32.dll'])
  })
})

describe('readImports: anything that is not a well-formed PE image fails with the reason, never a guess', () => {
  const good = () => buildPe({ imports: ['kernel32.dll', 'VCRUNTIME140.dll'] })

  it('not a byte buffer, too short, or no MZ header', () => {
    expect(() => readImports('MZ' as unknown as Uint8Array)).toThrow(/not a byte buffer/)
    expect(() => readImports(new Uint8Array(0))).toThrow(/no MZ header/)
    expect(() => readImports(new Uint8Array(32).fill(0x4d))).toThrow(/no MZ header/)
    const text = new TextEncoder().encode('#!/bin/sh\necho this is a shell script, not a program for Windows\n')
    expect(() => readImports(text)).toThrow(/no MZ header/)
  })

  it('a PE header offset past the end, or no PE signature there', () => {
    const far = good().bytes
    new DataView(far.buffer).setUint32(0x3c, far.length + 100, true)
    expect(() => readImports(far)).toThrow(/^the PE signature is outside the file \(offset \d+, 4 bytes, file \d+ bytes\)$/)
    const nosig = good().bytes
    nosig[0x40] = 0x4e
    expect(() => readImports(nosig)).toThrow('no PE signature at offset 64')
  })

  it('a file cut short inside the headers or the section table', () => {
    expect(() => readImports(good().bytes.subarray(0, 0x50))).toThrow('the optional header size is outside the file (offset 84, 2 bytes, file 80 bytes)')
    expect(() => readImports(good().bytes.subarray(0, 0x150))).toThrow('the section table is outside the file (offset 328, 40 bytes, file 336 bytes)')
  })

  it('an unknown optional header', () => {
    const b = good().bytes
    new DataView(b.buffer).setUint16(0x58, 0x107, true)
    expect(() => readImports(b)).toThrow('unknown optional header magic 0x107')
  })

  it('an optional header too short to hold the fields the check reads', () => {
    const b = good().bytes
    // SizeOfOptionalHeader (the u16 at 0x54) says 100; a PE32+ image needs at least 112.
    new DataView(b.buffer).setUint16(0x54, 100, true)
    expect(() => readImports(b)).toThrow('the optional header is too short (100 bytes)')
  })

  it('an optional header cut off by the end of the file', () => {
    // The file ends at 0x100, inside the 240-byte optional header that starts at 88.
    expect(() => readImports(good().bytes.subarray(0, 0x100))).toThrow('the optional header is outside the file (offset 88, 240 bytes, file 256 bytes)')
  })

  it('a DLL name whose address is in no section', () => {
    const b = good()
    new DataView(b.bytes.buffer).setUint32(b.importAt + 12, 0x9000, true)
    expect(() => readImports(b.bytes)).toThrow('the DLL name of entry 0 of the import table (address 0x9000) is in no section')
  })

  it('an import table entry cut off by the end of the file', () => {
    const cut = good()
    // The file ends 10 bytes into entry 0: the entry itself is outside the file.
    expect(() => readImports(cut.bytes.subarray(0, cut.importAt + 10))).toThrow(`entry 0 of the import table is outside the file (offset ${cut.importAt}, 20 bytes, file ${cut.importAt + 10} bytes)`)
  })

  it("a DLL name in the part of a section that has no data in the file (VirtualSize past SizeOfRawData)", () => {
    const b = good()
    const v = new DataView(b.bytes.buffer)
    v.setUint32(b.sectionAt + 8, b.rawSize + 0x1000, true)
    const rva = SECTION_RVA + b.rawSize + 0x10
    v.setUint32(b.importAt + 12, rva, true)
    expect(() => readImports(b.bytes)).toThrow(`the DLL name of entry 0 of the import table (address 0x${rva.toString(16)}) is past the section's data in the file`)
  })

  it('a DLL name that is not printable text, is empty, is too long, or has no end', () => {
    const odd = good()
    odd.bytes[odd.namesAt[1] + 2] = 0x01
    expect(() => readImports(odd.bytes)).toThrow(`the DLL name of entry 1 of the import table at offset ${odd.namesAt[1]} is not printable ASCII`)
    const empty = good()
    empty.bytes[empty.namesAt[0]] = 0
    expect(() => readImports(empty.bytes)).toThrow(`the DLL name of entry 0 of the import table at offset ${empty.namesAt[0]} is empty`)
    const long = good()
    long.bytes.fill(0x41, long.namesAt[1], long.namesAt[1] + 300)
    expect(() => readImports(long.bytes)).toThrow(`the DLL name of entry 1 of the import table at offset ${long.namesAt[1]} is longer than 260 characters`)
    const endless = good()
    const last = endless.bytes.length - 5
    endless.bytes.fill(0x41, last)
    new DataView(endless.bytes.buffer).setUint32(endless.importAt + 20 + 12, SECTION_RVA + (last - endless.importAt), true)
    expect(() => readImports(endless.bytes)).toThrow(`the DLL name of entry 1 of the import table at offset ${last} has no end`)
  })

  it('an import table whose end marker is overwritten reads on into the name text, and fails there', () => {
    const b = good()
    // A copy of entry 0 over the all-zero end marker: entry 3 is then read from
    // the name text after the table, and its name address points nowhere.
    b.bytes.copyWithin(b.importAt + 2 * 20, b.importAt, b.importAt + 20)
    expect(() => readImports(b.bytes)).toThrow(/^the DLL name of entry 3 of the import table \(address 0x[0-9a-f]+\) is in no section$/)
  })

  it('an import table with no end marker within 4096 entries fails instead of reading on', () => {
    // 4097 entries that each name a real DLL, and no all-zero end marker.
    const b = buildPe({ imports: Array.from({ length: 4097 }, () => 'kernel32.dll') })
    b.bytes.copyWithin(b.importAt + 4097 * 20, b.importAt, b.importAt + 20)
    expect(() => readImports(b.bytes)).toThrow('the import table has no end marker within 4096 entries')
  })

  it('a delay-load entry with a zero name address', () => {
    const b = buildPe({ imports: ['kernel32.dll'], delay: ['VCRUNTIME140.dll'] })
    new DataView(b.bytes.buffer).setUint32(b.delayAt + 4, 0, true)
    expect(() => readImports(b.bytes)).toThrow('the DLL name of entry 0 of the delay-load import table has no valid address (0)')
  })
})

// ---------------------------------------------------------------- what fails

describe('importProblems: an x64 program that names its DLLs and no C runtime DLL passes', () => {
  it("names the machine, x64 or not", () => {
    expect(machineName(0x8664)).toBe('x64')
    expect(machineName(0x14c)).toBe('x86')
    expect(machineName(0xaa64)).toBe('arm64')
    expect(machineName(0x1234)).toBe('machine 0x1234')
  })

  it('passes the static helper and fails each wrong kind, one sentence each', () => {
    expect(importProblems(readImports(buildPe({ imports: STATIC_HELPER }).bytes))).toEqual([])
    expect(importProblems(readImports(buildPe().bytes))).toEqual(['names no imported DLL, so this check would prove nothing about it.'])
    expect(importProblems(readImports(buildPe({ plus: false, imports: ['kernel32.dll'] }).bytes))).toEqual([
      'is built for x86, not x64: the Windows installer ships an x64 helper only (package.json build.win.target).',
    ])
    expect(importProblems(readImports(buildPe({ imports: ['kernel32.dll', 'VCRUNTIME140.dll'], machine: 0xaa64 }).bytes))).toEqual([
      "does not carry its own C runtime: it imports VCRUNTIME140.dll. Windows cannot start it on a PC without Microsoft's Visual C++ runtime. All its imports: kernel32.dll, VCRUNTIME140.dll.",
      'is built for arm64, not x64: the Windows installer ships an x64 helper only (package.json build.win.target).',
    ])
  })

  it('fails a window-manager DLL in the import table, and passes the same DLLs delay-loaded (2.1.3-beta.14 C6)', () => {
    // As CI built the capture mode at first: every mode loaded the three at start.
    expect(importProblems(readImports(buildPe({ imports: CAPTURE_HELPER_LOAD_TIME }).bytes))).toEqual([
      `loads ${WINDOW_MANAGER_DLLS.join(', ')} before main, in every mode: only the capture mode calls the window-manager DLLs, so they must be delay-loaded (helper/.cargo/config.toml, /DELAYLOAD) and load only when that mode runs. All its imports: ${CAPTURE_HELPER_LOAD_TIME.join(', ')}.`,
    ])
    // Delay-loaded, as helper/.cargo/config.toml now links them: the fix.
    expect(importProblems(readImports(buildPe({ imports: STATIC_HELPER, delay: WINDOW_MANAGER_DLLS }).bytes))).toEqual([])
    // Each one alone in the import table is enough, and only the import table counts.
    for (const dll of WINDOW_MANAGER_DLLS) {
      expect(importProblems(readImports(buildPe({ imports: [...STATIC_HELPER, dll] }).bytes)), dll).toHaveLength(1)
      expect(importProblems(readImports(buildPe({ imports: STATIC_HELPER, delay: [dll] }).bytes)), `${dll} delay-loaded`).toEqual([])
    }
  })

  it('x64 is what the Windows installer is built for, and nothing else', () => {
    const win = (JSON.parse(read('package.json')) as { build: { win: { target: Array<{ arch: string[] }> } } }).build.win
    expect(win.target.flatMap((t) => t.arch)).toEqual(['x64'])
  })
})

// ---------------------------------------------------------------- the command

describe('main: the exit code CI acts on', () => {
  it("today's helper (it imports VCRUNTIME140.dll and the api-ms-win-crt DLLs) fails, naming each one", () => {
    const r = run({ 'aicc-helper.exe': buildPe({ imports: TODAYS_HELPER }).bytes })
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toContain("FAIL: aicc-helper.exe (PE32+, x64) does not carry its own C runtime: it imports VCRUNTIME140.dll, api-ms-win-crt-runtime-l1-1-0.dll, api-ms-win-crt-math-l1-1-0.dll, api-ms-win-crt-stdio-l1-1-0.dll, api-ms-win-crt-locale-l1-1-0.dll, api-ms-win-crt-heap-l1-1-0.dll. Windows cannot start it on a PC without Microsoft's Visual C++ runtime.")
    expect(r.err).toContain('+crt-static')
    expect(r.err).toContain('cargo must run from helper/')
  })

  it('only Universal C runtime imports fail too, saying they ship with Windows but show the build was not static', () => {
    const r = run({ 'u.exe': buildPe({ imports: ['kernel32.dll', 'ucrtbase.dll', 'api-ms-win-crt-heap-l1-1-0.dll'] }).bytes })
    expect(r.code).toBe(1)
    expect(r.err).toContain('FAIL: u.exe (PE32+, x64) does not carry its own C runtime: it imports ucrtbase.dll, api-ms-win-crt-heap-l1-1-0.dll. Those are the Universal C runtime, part of Windows 10 and later, but a program that carries its own C runtime imports none of them.')
    expect(r.err).not.toContain('Visual C++')
    expect(r.err).toContain('+crt-static')
  })

  it('the same program built with the C runtime linked in passes, and lists what it imports', () => {
    const r = run({ 'aicc-helper.exe': buildPe({ imports: STATIC_HELPER }).bytes })
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(r.out).toBe(`[check-pe-imports] aicc-helper.exe (PE32+, x64): OK, no C runtime DLL and no window-manager DLL loaded at start. It imports: ${STATIC_HELPER.join(', ')}.`)
  })

  it('the helper with the capture mode fails while every mode loads the window-manager DLLs, and passes with them delay-loaded, each marked', () => {
    const loaded = run({ 'aicc-helper.exe': buildPe({ imports: CAPTURE_HELPER_LOAD_TIME }).bytes })
    expect(loaded.code).toBe(1)
    expect(loaded.out).toBe('')
    expect(loaded.err).toBe(`[check-pe-imports] FAIL: aicc-helper.exe (PE32+, x64) loads ${WINDOW_MANAGER_DLLS.join(', ')} before main, in every mode: only the capture mode calls the window-manager DLLs, so they must be delay-loaded (helper/.cargo/config.toml, /DELAYLOAD) and load only when that mode runs. All its imports: ${CAPTURE_HELPER_LOAD_TIME.join(', ')}.`)
    const delayed = run({ 'aicc-helper.exe': buildPe({ imports: STATIC_HELPER, delay: WINDOW_MANAGER_DLLS }).bytes })
    expect(delayed.code).toBe(0)
    expect(delayed.err).toBe('')
    expect(delayed.out).toBe(`[check-pe-imports] aicc-helper.exe (PE32+, x64): OK, no C runtime DLL and no window-manager DLL loaded at start. It imports: ${[...STATIC_HELPER, ...WINDOW_MANAGER_DLLS.map((d) => `${d} (delay-load)`)].join(', ')}.`)
  })

  it('each C runtime DLL alone is enough to fail, in the import table or the delay-load table', () => {
    for (const dll of ['VCRUNTIME140.dll', 'VCRUNTIME140_1.dll', 'MSVCP140.dll', 'api-ms-win-crt-heap-l1-1-0.dll', 'ucrtbase.dll']) {
      expect(run({ 'a.exe': buildPe({ imports: ['kernel32.dll', dll] }).bytes }).code, dll).toBe(1)
      const delayed = run({ 'b.exe': buildPe({ imports: ['kernel32.dll'], delay: [dll] }).bytes })
      expect(delayed.code, `${dll} delay-loaded`).toBe(1)
      expect(delayed.err).toContain(`${dll} (delay-load)`)
    }
  })

  it('a program that imports nothing fails: the check would prove nothing about it', () => {
    const r = run({ 'empty.exe': buildPe().bytes })
    expect(r.code).toBe(1)
    expect(r.err).toBe('[check-pe-imports] FAIL: empty.exe (PE32+, x64) names no imported DLL, so this check would prove nothing about it.')
  })

  it('a program that is not x64 fails, even with no C runtime DLL', () => {
    const r = run({ 'x86.exe': buildPe({ plus: false, imports: STATIC_HELPER }).bytes })
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toBe('[check-pe-imports] FAIL: x86.exe (PE32, x86) is built for x86, not x64: the Windows installer ships an x64 helper only (package.json build.win.target).')
  })

  it('a file that is missing or not a program fails, and does not stop the other files being checked', () => {
    const r = run({ 'gone.exe': new Error('ENOENT: no such file'), 'notes.txt': new TextEncoder().encode('just some text, long enough to read the header of it.......'), 'ok.exe': buildPe({ imports: STATIC_HELPER }).bytes })
    expect(r.code).toBe(1)
    expect(r.err).toContain('FAIL: gone.exe cannot be read as a Windows program: ENOENT')
    expect(r.err).toContain('FAIL: notes.txt cannot be read as a Windows program: no MZ header')
    expect(r.out).toContain('ok.exe (PE32+, x64): OK')
  })

  it('one bad file among good ones fails the whole run', () => {
    const r = run({ 'ok.exe': buildPe({ imports: STATIC_HELPER }).bytes, 'bad.exe': buildPe({ imports: TODAYS_HELPER }).bytes })
    expect(r.code).toBe(1)
    expect(r.out).toContain('ok.exe')
    expect(r.err).toContain('FAIL: bad.exe')
  })

  it('no file given is a usage error (2), not a pass', () => {
    const r = run({}, [])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/^usage: node scripts\/check-pe-imports\.mjs/)
  })
})

describe('isEntryPoint: the check runs whenever node is started with it, by any path', () => {
  // node makes the main module's import.meta.url from its REAL path (a junction
  // or symlink resolved), while process.argv[1] keeps the path as typed. A plain
  // comparison of the two missed a run through a junction: main() never ran and
  // the run exited 0 having checked nothing.
  const real = resolve(ROOT, 'real-root', 'scripts', 'check-pe-imports.mjs')
  const linkRoot = resolve(ROOT, 'link-root')
  const link = resolve(linkRoot, 'scripts', 'check-pe-imports.mjs')
  const url = pathToFileURL(real).href
  const realpath = (p: string) => (p.startsWith(linkRoot) ? resolve(ROOT, 'real-root') + p.slice(linkRoot.length) : p)

  it('the script itself, typed as it is or reached through a junction or symlink', () => {
    expect(isEntryPoint(real, url, realpath)).toBe(true)
    expect(isEntryPoint(link, url, realpath)).toBe(true)
  })

  it('anything else is not: another script, no argv[1], or a path that cannot be resolved', () => {
    expect(isEntryPoint(resolve(ROOT, 'real-root', 'scripts', 'other.mjs'), url, realpath)).toBe(false)
    expect(isEntryPoint(undefined, url, realpath)).toBe(false)
    expect(isEntryPoint('', url, realpath)).toBe(false)
    const throws = () => { throw new Error('ENOENT') }
    expect(isEntryPoint(link, url, throws)).toBe(false)
    // The same path typed needs no resolving.
    expect(isEntryPoint(real, url, throws)).toBe(true)
  })

  it('is what the script runs main() on', () => {
    const src = read('scripts/check-pe-imports.mjs')
    expect(src).toMatch(/\nif \(isEntryPoint\(process\.argv\[1\], import\.meta\.url\)\) process\.exitCode = main\(\)\n?$/)
    expect(src).not.toContain('pathToFileURL(path.resolve(process.argv[1]))')
  })
})

// ---------------------------------------------------------------- where it runs

type Step = { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, unknown>; 'working-directory'?: string }
type Job = { 'runs-on'?: unknown; env?: Record<string, unknown>; steps?: Step[] }
type Workflow = { env?: Record<string, unknown>; jobs: Record<string, Job> }
/** Every workflow file, so one added later is read too. */
const WORKFLOWS = readdirSync(resolve(ROOT, '.github/workflows'))
  .filter((n) => /\.ya?ml$/.test(n))
  .sort()
  .map((n) => `.github/workflows/${n}`)
const wf: Record<string, Workflow> = Object.fromEntries(WORKFLOWS.map((f) => [f, yaml.load(read(f)) as Workflow]))
const stepsOf = (job: Job) => job.steps ?? []
const CHECK = 'node scripts/check-pe-imports.mjs helper/target/release/aicc-helper.exe'
const isCheck = (s: Step) => s.run?.trim() === CHECK
/** A cargo build in any spelling: `cargo build`, `cargo b`, `cargo rustc`, with or without a `+toolchain`. */
const CARGO_BUILD = /\bcargo(?:\s+\+\S+)?\s+(?:build|b|rustc)\b/
/** A release build: the profile the installers ship. */
const RELEASE = /--release\b|--profile[\s=]+release\b|\s-r\b/
/** Any cargo command at all. */
const CARGO_ANY = /(?:^|[\s;&|(])cargo\s/m
const runsCargoBuild = (s: Step) => CARGO_BUILD.test(s.run ?? '')
/** A build that makes no Windows program, so has no PE to check: a job named
 *  for macOS or Linux, a step limited to those runners, or (2.1.3-beta.17, the
 *  dispatch-only remote-helper-e2e job) a job pinned to an ubuntu or macOS
 *  runner. Never a build that names a Windows target: a cross build on such a
 *  runner still makes a PE. */
const buildsNoWindowsProgram = (name: string, job: Job, s: Step): boolean => {
  if (/--target[\s=]+\S*windows/i.test(s.run ?? '')) return false
  const runsOn = typeof job['runs-on'] === 'string' ? job['runs-on'] : ''
  return /mac|linux/i.test(name) || /runner\.os == '(macOS|Linux)'/.test(s.if ?? '') || /^(ubuntu|macos)-/i.test(runsOn)
}

describe('the workflow files are all read', () => {
  it('ci.yml and release.yml among them, each with jobs', () => {
    expect(WORKFLOWS).toContain('.github/workflows/ci.yml')
    expect(WORKFLOWS).toContain('.github/workflows/release.yml')
    for (const f of WORKFLOWS) expect(Object.keys(wf[f]?.jobs ?? {}).length, f).toBeGreaterThan(0)
  })

  it('the build patterns catch every spelling they are for, and nothing else', () => {
    for (const s of ['cargo build --release --locked', 'cargo b -r', 'cargo +1.90.0 build --release', 'cargo rustc --release', '  cargo build --locked --release']) expect(CARGO_BUILD.test(s), s).toBe(true)
    for (const s of ['cargo bench', 'cargo test --locked', 'cargo --version', 'echo helper-cargo-lock']) expect(CARGO_BUILD.test(s), s).toBe(false)
    for (const s of ['cargo build --release', 'cargo b -r', 'cargo build --profile release', 'cargo build --profile=release']) expect(RELEASE.test(s), s).toBe(true)
    for (const s of ['cargo build --locked --all-targets', 'cargo build -rf']) expect(RELEASE.test(s), s).toBe(false)
    for (const s of ['cargo --version', 'cd x && cargo test', 'rustup run stable cargo build']) expect(CARGO_ANY.test(s), s).toBe(true)
    expect(CARGO_ANY.test('Download the helper-cargo-lock artifact')).toBe(false)
  })
})

describe('every Windows build of the shipped helper is checked right after it is built', () => {
  it('ci.yml Helper job: after the Windows release build, under the same condition, before the upload', () => {
    const steps = stepsOf(wf['.github/workflows/ci.yml'].jobs.helper)
    const build = steps.findIndex((s) => s.name === 'Build the Windows release binaries')
    expect(build).toBeGreaterThan(0)
    const check = steps[build + 1]
    expect(isCheck(check), JSON.stringify(check)).toBe(true)
    expect(check.if).toBe(steps[build].if)
    expect(check.if).toContain("runner.os == 'Windows'")
    expect(steps.findIndex((s) => s.name === 'Upload the Windows helper')).toBeGreaterThan(build + 1)
  })

  it('ci.yml release/* test installer: after the build, under the same condition, before it is packaged', () => {
    // Its own job from 2.1.3-beta.17 (it needs the static Linux helper's job).
    const steps = stepsOf(wf['.github/workflows/ci.yml'].jobs['release-windows-installer'])
    const build = steps.findIndex(runsCargoBuild)
    expect(build).toBeGreaterThan(0)
    const check = steps[build + 1]
    expect(isCheck(check), JSON.stringify(check)).toBe(true)
    expect(check.if).toBe(steps[build].if)
    expect(steps.findIndex((s) => /npx electron-builder --win/.test(s.run ?? ''))).toBeGreaterThan(build + 1)
  })

  it('release.yml build-windows: after the build, with no condition, before anything is signed or packaged', () => {
    const steps = stepsOf(wf['.github/workflows/release.yml'].jobs['build-windows'])
    const build = steps.findIndex((s) => s.name === 'Build the session helper')
    expect(build).toBeGreaterThan(0)
    const check = steps[build + 1]
    expect(isCheck(check), JSON.stringify(check)).toBe(true)
    expect(check.if).toBeUndefined()
    const signing = steps.findIndex((s) => /eSigner|code signing/i.test(s.name ?? ''))
    const pack = steps.findIndex((s) => /npx electron-builder --win/.test(s.run ?? ''))
    expect(signing).toBeGreaterThan(build + 1)
    expect(pack).toBeGreaterThan(build + 1)
  })

  it('no Windows helper build in any workflow goes unchecked', () => {
    const builds: Record<string, number> = {}
    for (const f of WORKFLOWS) {
      for (const [name, job] of Object.entries(wf[f].jobs)) {
        stepsOf(job).forEach((s, i) => {
          if (!runsCargoBuild(s) || !RELEASE.test(s.run ?? '')) return
          // The macOS and Linux jobs build a Mach-O or ELF program: nothing to check here.
          if (buildsNoWindowsProgram(name, job, s)) return
          builds[f] = (builds[f] ?? 0) + 1
          expect(stepsOf(job).slice(i + 1).some(isCheck), `${f} ${name}: "${s.name}" is not followed by the check`).toBe(true)
        })
      }
    }
    // The two files that build the shipped helper, and no other. ci.yml builds it
    // four times on Windows: the Helper job, the release/* test installer, the
    // dispatch-only Probe P21 job, which measures the program it builds, and the
    // dispatch-only Snap e2e job, whose app runs the program it builds.
    expect(builds).toEqual({ '.github/workflows/ci.yml': 4, '.github/workflows/release.yml': 1 })
  })

  it('a build on an ubuntu or macOS runner has no PE to check, unless it names a Windows target', () => {
    const at = (run: string, cond?: string): Step => ({ run, if: cond })
    const linuxMusl = 'cargo build --locked --release --target x86_64-unknown-linux-musl'
    expect(buildsNoWindowsProgram('remote-helper-e2e', { 'runs-on': 'ubuntu-latest' }, at(linuxMusl))).toBe(true)
    expect(buildsNoWindowsProgram('build', { 'runs-on': 'macos-15' }, at('cargo build --release'))).toBe(true)
    expect(buildsNoWindowsProgram('build', { 'runs-on': 'ubuntu-latest' }, at('cargo build --release --target x86_64-pc-windows-gnu'))).toBe(false)
    expect(buildsNoWindowsProgram('helper-linux', { 'runs-on': 'ubuntu-latest' }, at('cargo build --release --target=x86_64-pc-windows-msvc'))).toBe(false)
    expect(buildsNoWindowsProgram('build', { 'runs-on': 'windows-2025' }, at('cargo build --release'))).toBe(false)
    expect(buildsNoWindowsProgram('build', { 'runs-on': '${{ matrix.os }}' }, at('cargo build --release'))).toBe(false)
    expect(buildsNoWindowsProgram('build', { 'runs-on': '${{ matrix.os }}' }, at('cargo build --release', "runner.os == 'Linux'"))).toBe(true)
  })

  it('ci.yml Snap e2e: after the release build, before the app is built and run', () => {
    const steps = stepsOf(wf['.github/workflows/ci.yml'].jobs['snap-e2e'])
    const build = steps.findIndex((s) => s.name === 'Build the helper (release)')
    expect(build).toBeGreaterThan(0)
    const check = steps[build + 1]
    expect(isCheck(check), JSON.stringify(check)).toBe(true)
    expect(check.if).toBe(steps[build].if)
    expect(steps.findIndex((s) => s.name === 'Run the Snap end-to-end check')).toBeGreaterThan(build + 1)
  })

  it('ci.yml Probe P21: after the release build, before the probe measures it', () => {
    const steps = stepsOf(wf['.github/workflows/ci.yml'].jobs['probe-p21'])
    const build = steps.findIndex((s) => s.name === 'Build the helper (release)')
    expect(build).toBeGreaterThan(0)
    const check = steps[build + 1]
    expect(isCheck(check), JSON.stringify(check)).toBe(true)
    expect(check.if).toBe(steps[build].if)
    expect(steps.findIndex((s) => s.name === 'Run probe P21')).toBeGreaterThan(build + 1)
  })
})

describe('helper/.cargo/config.toml links the C runtime in and delay-loads the window-manager DLLs, for Windows MSVC builds only', () => {
  const config = () => read('helper/.cargo/config.toml')
  // CI reads the committed tree, so a file that was never committed fails here too.
  it('says exactly that and nothing else', () => {
    const settings = config()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
    expect(settings).toEqual([
      `[target.'cfg(all(windows, target_env = "msvc"))']`,
      'rustflags = [',
      '"-C", "target-feature=+crt-static",',
      '"-C", "link-arg=/DELAYLOAD:user32.dll",',
      '"-C", "link-arg=/DELAYLOAD:gdi32.dll",',
      '"-C", "link-arg=/DELAYLOAD:api-ms-win-shcore-scaling-l1-1-1.dll",',
      '"-C", "link-arg=delayimp.lib",',
      ']',
    ])
  })

  it('delay-loads exactly the window-manager DLLs the capture mode imports, each one the check names', () => {
    const delayed = [...config().matchAll(/^\s*"-C", "link-arg=\/DELAYLOAD:([^"]+)",$/gm)].map((m) => m[1])
    expect(delayed).toEqual(WINDOW_MANAGER_DLLS)
    for (const dll of delayed) expect(isWindowManagerDll(dll), dll).toBe(true)
  })
})

describe('every cargo command runs in helper/, so cargo reads helper/.cargo/config.toml', () => {
  it('in every workflow, with no --manifest-path from elsewhere', () => {
    const counts: Record<string, number> = {}
    for (const f of WORKFLOWS) {
      for (const [name, job] of Object.entries(wf[f].jobs)) {
        for (const s of stepsOf(job)) {
          if (!CARGO_ANY.test(s.run ?? '')) continue
          counts[f] = (counts[f] ?? 0) + 1
          expect(s['working-directory'], `${f} ${name}: "${s.name}"`).toBe('helper')
          expect(s.run, `${f} ${name}: "${s.name}"`).not.toContain('--manifest-path')
        }
      }
    }
    // A pass that saw no cargo command would prove nothing.
    for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) expect(counts[f] ?? 0, `${f} runs no cargo command`).toBeGreaterThan(2)
  })

  it('and no package.json script builds the helper some other way', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    for (const [name, cmd] of Object.entries(scripts)) expect(cmd, name).not.toMatch(/\bcargo\b/)
  })

  it("no workflow sets RUSTFLAGS or CARGO_ENCODED_RUSTFLAGS, which would replace the config file's flags", () => {
    const replaces = /^(CARGO_ENCODED_)?RUSTFLAGS$/
    for (const f of WORKFLOWS) {
      const w = wf[f]
      const envs = [w.env, ...Object.values(w.jobs).flatMap((j) => [j.env, ...stepsOf(j).map((s) => s.env)])]
      for (const env of envs) for (const key of Object.keys(env ?? {})) expect(key, f).not.toMatch(replaces)
      for (const job of Object.values(w.jobs)) {
        for (const s of stepsOf(job)) {
          const what = `${f}: "${s.name ?? s.uses}"`
          expect(s.run ?? '', what).not.toMatch(/\b(CARGO_ENCODED_)?RUSTFLAGS\s*=|RUSTFLAGS[^\n]*GITHUB_ENV/)
          // A toolchain action can export RUSTFLAGS too: actions-rust-lang/setup-rust-toolchain
          // sets "-D warnings" unless told otherwise, and any action's `rustflags` input sets it.
          expect(s.uses ?? '', what).not.toMatch(/setup-rust-toolchain/i)
          for (const key of Object.keys(s.with ?? {})) expect(key, what).not.toMatch(/rustflags/i)
        }
      }
    }
  })
})
