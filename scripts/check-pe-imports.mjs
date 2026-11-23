#!/usr/bin/env node
// Fails when a Windows program does not carry its own C runtime (imports a C
// runtime DLL). The session helper (helper/, aicc-helper.exe) must start on a PC
// without Microsoft's Visual C++ runtime: a program that imports
// VCRUNTIME140.dll is stopped by the Windows loader before main (0xC0000135)
// on a PC that lacks it, and every helper feature quietly stays off there.
// helper/.cargo/config.toml links the C runtime into the program instead
// (`-C target-feature=+crt-static`); this script proves the built file has no
// such import left.
//
// It reads the file's PE headers, its import table and its delay-load import
// table, and fails on any C runtime DLL. The Visual C++ runtime ones
// (vcruntime*, msvcp*, msvcr*, concrt*, vccorlib*, vcomp*, debug builds and
// their suffixed names included) are what a fresh Windows lacks. The Universal
// C runtime ones (ucrtbase.dll, api-ms-win-crt-*) are part of Windows 10 and
// later, but a static build imports none of them either, so seeing one means
// the build was not static. A name without `.dll` counts too: Windows adds the
// extension to a module name that has none. It also fails a program that is
// not x64, the only Windows build the installer ships (package.json
// build.win.target). It only reads the file; it never runs it, so it is safe
// on any OS and on any copy.
//
// It also fails a program whose import table (not its delay-load table) names
// a window-manager DLL (user32, gdi32, shcore; WINDOW_MANAGER_DLL): only the
// helper's capture mode calls them, and helper/.cargo/config.toml delay-loads
// them so that no other mode loads them at its start (2.1.3-beta.14 C6).
//
// scripts/verify-bundled-helper.mjs applies the same rules (importProblems) to
// the packaged, signed copy of the helper.
//
//   node scripts/check-pe-imports.mjs <program.exe> [<program.exe> ...]
//
// Exit 0: every file is an x64 PE image that names at least one imported DLL,
//         no C runtime DLL, and no window-manager DLL in its import table.
// Exit 1: a file imports a C runtime DLL, imports a window-manager DLL at load
//         time, names no DLL at all (the check would prove nothing), is not
//         x64, or cannot be read as a PE image.
// Exit 2: no file was given.

import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A window-manager DLL: user32, gdi32 or shcore, by its own name or an API set
 * name that leads to it (api-ms-win-shcore-*, and the ntuser and gdi sets that
 * lead to user32 and gdi32). Only the helper's capture mode calls them, so
 * helper/.cargo/config.toml delay-loads them: imported at load time, they would
 * load before main in every mode and make each helper process a
 * window-manager client at its start (2.1.3-beta.14 section C6).
 */
export const WINDOW_MANAGER_DLL = /^(?:user32|gdi32|shcore|(?:api|ext)-ms-win-(?:shcore|ntuser|gdi)-[\w-]+)(?:\.dll)?$/i

export function isWindowManagerDll(name) {
  return typeof name === 'string' && WINDOW_MANAGER_DLL.test(name)
}

/** A C runtime DLL: shipped by the Visual C++ runtime, or the Universal C runtime. */
export const CRT_DLL = /^(?:(?:vcruntime|msvcp|msvcr|concrt|vccorlib|vcomp)\d+\w*|ucrtbased?|api-ms-win-crt-[\w-]+)(?:\.dll)?$/i
/** The Universal C runtime part of CRT_DLL: part of Windows 10 and later. */
const UNIVERSAL_CRT = /^(?:ucrtbase|api-ms-win-crt-)/i

export function isCrtDll(name) {
  return typeof name === 'string' && CRT_DLL.test(name)
}

/** A Visual C++ runtime DLL: the kind a fresh Windows does not have. */
export function isVcRuntimeDll(name) {
  return isCrtDll(name) && !UNIVERSAL_CRT.test(name)
}

/** The only machine type the Windows installer ships (package.json build.win.target arch x64). */
const X64 = 0x8664
const MACHINES = { 0x8664: 'x64', 0x14c: 'x86', 0xaa64: 'arm64', 0x1c4: 'arm' }

/** A COFF machine type, as a name. */
export function machineName(machine) {
  return MACHINES[machine] ?? `machine 0x${Number(machine).toString(16)}`
}

/** At most this many entries in one import table: a table with no end marker fails instead of running on. */
const MAX_DESCRIPTORS = 4096
/** A DLL name longer than this is not one. */
const MAX_NAME = 260

const IMPORT_DIRECTORY = 1
const DELAY_IMPORT_DIRECTORY = 13

/**
 * The DLLs a PE image (an .exe or .dll) imports, read from its bytes.
 * Throws an Error that says what is wrong when the bytes are not a PE image
 * or a table points outside the file.
 * @param {Uint8Array} bytes
 * @returns {{ format: 'PE32' | 'PE32+', machine: number, imports: string[], delayImports: string[] }}
 */
export function readImports(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('not a byte buffer')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const need = (offset, size, what) => {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > bytes.length) throw new Error(`${what} is outside the file (offset ${offset}, ${size} bytes, file ${bytes.length} bytes)`)
  }
  const u16 = (offset, what) => (need(offset, 2, what), view.getUint16(offset, true))
  const u32 = (offset, what) => (need(offset, 4, what), view.getUint32(offset, true))

  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('no MZ header: not a Windows program')
  const pe = u32(0x3c, 'the PE header offset')
  if (u32(pe, 'the PE signature') !== 0x00004550) throw new Error(`no PE signature at offset ${pe}`)
  const coff = pe + 4
  const machine = u16(coff, 'the machine type')
  const sectionCount = u16(coff + 2, 'the section count')
  const optionalSize = u16(coff + 16, 'the optional header size')
  const opt = coff + 20
  const magic = u16(opt, 'the optional header magic')
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`unknown optional header magic 0x${magic.toString(16)}`)
  const plus = magic === 0x20b
  const format = plus ? 'PE32+' : 'PE32'
  if (optionalSize < (plus ? 112 : 96)) throw new Error(`the optional header is too short (${optionalSize} bytes)`)
  need(opt, optionalSize, 'the optional header')
  const imageBase = plus ? Number(view.getBigUint64(opt + 24, true)) : view.getUint32(opt + 28, true)
  const headersSize = view.getUint32(opt + 60, true)
  const dirCount = view.getUint32(opt + (plus ? 108 : 92), true)
  const dirs = opt + (plus ? 112 : 96)
  const directory = (index) => {
    if (index >= dirCount || dirs + index * 8 + 8 > opt + optionalSize) return { rva: 0, size: 0 }
    return { rva: view.getUint32(dirs + index * 8, true), size: view.getUint32(dirs + index * 8 + 4, true) }
  }

  const sectionTable = opt + optionalSize
  need(sectionTable, sectionCount * 40, 'the section table')
  const sections = []
  for (let i = 0; i < sectionCount; i++) {
    const s = sectionTable + i * 40
    sections.push({ virtualSize: view.getUint32(s + 8, true), rva: view.getUint32(s + 12, true), rawSize: view.getUint32(s + 16, true), rawOffset: view.getUint32(s + 20, true) })
  }
  // An address in the loaded image, as an offset in the file.
  const toOffset = (rva, what) => {
    if (!Number.isInteger(rva) || rva <= 0) throw new Error(`${what} has no valid address (${rva})`)
    if (rva < headersSize && rva < bytes.length) return rva
    for (const s of sections) {
      const span = Math.max(s.virtualSize, s.rawSize)
      if (rva >= s.rva && rva < s.rva + span) {
        if (rva - s.rva >= s.rawSize) throw new Error(`${what} (address 0x${rva.toString(16)}) is past the section's data in the file`)
        return s.rawOffset + (rva - s.rva)
      }
    }
    throw new Error(`${what} (address 0x${rva.toString(16)}) is in no section`)
  }
  const nameAt = (rva, what) => {
    const start = toOffset(rva, what)
    let end = start
    while (end < bytes.length && bytes[end] !== 0) {
      const c = bytes[end]
      if (c < 0x20 || c > 0x7e) throw new Error(`${what} at offset ${start} is not printable ASCII`)
      if (end - start >= MAX_NAME) throw new Error(`${what} at offset ${start} is longer than ${MAX_NAME} characters`)
      end++
    }
    if (end >= bytes.length) throw new Error(`${what} at offset ${start} has no end`)
    if (end === start) throw new Error(`${what} at offset ${start} is empty`)
    return String.fromCharCode(...bytes.subarray(start, end))
  }
  const readTable = (index, entrySize, nameRvaOf, what) => {
    const { rva } = directory(index)
    if (rva === 0) return []
    const names = []
    for (let i = 0; ; i++) {
      if (i >= MAX_DESCRIPTORS) throw new Error(`the ${what} has no end marker within ${MAX_DESCRIPTORS} entries`)
      const at = toOffset(rva + i * entrySize, `entry ${i} of the ${what}`)
      need(at, entrySize, `entry ${i} of the ${what}`)
      if (bytes.subarray(at, at + entrySize).every((b) => b === 0)) return names
      names.push(nameAt(nameRvaOf(at), `the DLL name of entry ${i} of the ${what}`))
    }
  }

  // IMAGE_IMPORT_DESCRIPTOR: 20 bytes, the name's address at +12.
  const imports = readTable(IMPORT_DIRECTORY, 20, (at) => view.getUint32(at + 12, true), 'import table')
  // ImgDelayDescr: 32 bytes, attributes at +0, the name at +4. Attribute bit 0
  // set means the fields are addresses in the image; clear (old linkers) means
  // they are full virtual addresses, so the image base comes off first.
  const delayImports = readTable(DELAY_IMPORT_DIRECTORY, 32, (at) => {
    const name = view.getUint32(at + 4, true)
    return view.getUint32(at, true) & 1 ? name : name - imageBase
  }, 'delay-load import table')
  return { format, machine, imports, delayImports }
}

const HINT = 'Link the C runtime into the program: helper/.cargo/config.toml sets "-C target-feature=+crt-static" for Windows MSVC, and cargo must run from helper/ to read it. A RUSTFLAGS or CARGO_ENCODED_RUSTFLAGS environment variable replaces that setting.'

/** Every DLL a program imports, each delay-loaded one marked. */
const allImports = (found) => [...found.imports, ...found.delayImports.map((d) => `${d} (delay-load)`)]

/**
 * What is wrong with one program's imports, as sentences that follow its name;
 * an empty list when it passes: an x64 program that names at least one
 * imported DLL, no C runtime DLL, and no window-manager DLL in its import
 * table (delay-loaded is right).
 * @param {{ machine: number, imports: string[], delayImports: string[] }} found what readImports returned
 * @returns {string[]}
 */
export function importProblems(found) {
  const names = [...found.imports, ...found.delayImports]
  const all = allImports(found)
  const problems = []
  const crt = names.filter(isCrtDll)
  if (crt.length > 0) {
    const why = crt.some(isVcRuntimeDll)
      ? "Windows cannot start it on a PC without Microsoft's Visual C++ runtime."
      : 'Those are the Universal C runtime, part of Windows 10 and later, but a program that carries its own C runtime imports none of them.'
    problems.push(`does not carry its own C runtime: it imports ${crt.join(', ')}. ${why} All its imports: ${all.join(', ')}.`)
  }
  // The import table only: a delay-loaded window-manager DLL is the fix.
  const windowManager = found.imports.filter(isWindowManagerDll)
  if (windowManager.length > 0) {
    problems.push(`loads ${windowManager.join(', ')} before main, in every mode: only the capture mode calls the window-manager DLLs, so they must be delay-loaded (helper/.cargo/config.toml, /DELAYLOAD) and load only when that mode runs. All its imports: ${all.join(', ')}.`)
  }
  if (names.length === 0) problems.push('names no imported DLL, so this check would prove nothing about it.')
  if (found.machine !== X64) problems.push(`is built for ${machineName(found.machine)}, not x64: the Windows installer ships an x64 helper only (package.json build.win.target).`)
  return problems
}

/**
 * @param {string[]} argv the files to check
 * @param {{ readFile?: (file: string) => Uint8Array, log?: (s: string) => void, error?: (s: string) => void }} io
 * @returns {number} the exit code
 */
export function main(argv = process.argv.slice(2), io = {}) {
  const readFile = io.readFile || ((file) => readFileSync(file))
  const log = io.log || ((s) => console.log(s))
  const error = io.error || ((s) => console.error(s))
  if (argv.length === 0) {
    error('usage: node scripts/check-pe-imports.mjs <program.exe> [<program.exe> ...]')
    return 2
  }
  let failed = 0
  for (const file of argv) {
    let found
    try {
      found = readImports(readFile(file))
    } catch (err) {
      error(`[check-pe-imports] FAIL: ${file} cannot be read as a Windows program: ${err && err.message ? err.message : err}`)
      failed++
      continue
    }
    const named = `${file} (${found.format}, ${machineName(found.machine)})`
    const problems = importProblems(found)
    if (problems.length > 0) {
      for (const p of problems) error(`[check-pe-imports] FAIL: ${named} ${p}`)
      if ([...found.imports, ...found.delayImports].some(isCrtDll)) error(`[check-pe-imports] ${HINT}`)
      failed++
      continue
    }
    log(`[check-pe-imports] ${named}: OK, no C runtime DLL and no window-manager DLL loaded at start. It imports: ${allImports(found).join(', ')}.`)
  }
  return failed > 0 ? 1 : 0
}

/**
 * True when `metaUrl` is the script node was started with (`argv1`, as typed).
 * node makes the main module's import.meta.url from its REAL path, junctions
 * and symlinks resolved, while argv[1] keeps the path as typed, so the two are
 * compared as given and then after realpath. A plain comparison misses a run
 * through a junction: main() never runs and the check exits 0 having checked
 * nothing. When realpath throws, the comparison as typed is the answer.
 * @param {string | undefined} argv1 process.argv[1]
 * @param {string} metaUrl import.meta.url of the script
 * @param {(p: string) => string} [realpath]
 */
export function isEntryPoint(argv1, metaUrl, realpath = realpathSync) {
  if (typeof argv1 !== 'string' || argv1 === '') return false
  const typed = path.resolve(argv1)
  const self = fileURLToPath(metaUrl)
  if (typed === self) return true
  try {
    return realpath(typed) === realpath(self)
  } catch {
    return false
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) process.exitCode = main()
