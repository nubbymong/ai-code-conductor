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
// (vcruntime*, msvcp*, msvcr*, concrt*, vccorlib*, vcomp*, debug builds
// included) are what a fresh Windows lacks. The Universal C runtime ones
// (ucrtbase.dll, api-ms-win-crt-*) are part of Windows 10 and later, but a
// static build imports none of them either, so seeing one means the build was
// not static. It only reads the file; it never runs it, so it is safe on any
// OS and on any copy.
//
//   node scripts/check-pe-imports.mjs <program.exe> [<program.exe> ...]
//
// Exit 0: every file is a PE image that names at least one imported DLL and no
//         C runtime DLL.
// Exit 1: a file imports a C runtime DLL, names no DLL at all (the check would
//         prove nothing), or cannot be read as a PE image.
// Exit 2: no file was given.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** A C runtime DLL: shipped by the Visual C++ runtime, or the Universal C runtime. */
export const CRT_DLL = /^(?:(?:vcruntime|msvcp|msvcr|concrt|vccorlib|vcomp)\d+(?:_\w+)?d?|ucrtbased?|api-ms-win-crt-[\w-]+)\.dll$/i

export function isCrtDll(name) {
  return typeof name === 'string' && CRT_DLL.test(name)
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
    const all = [...found.imports, ...found.delayImports.map((d) => `${d} (delay-load)`)]
    if (all.length === 0) {
      error(`[check-pe-imports] FAIL: ${file} names no imported DLL, so this check would prove nothing about it.`)
      failed++
      continue
    }
    const crt = [...found.imports, ...found.delayImports].filter(isCrtDll)
    if (crt.length > 0) {
      error(`[check-pe-imports] FAIL: ${file} (${found.format}) does not carry its own C runtime: it imports ${crt.join(', ')}. A PC without Microsoft's Visual C++ runtime cannot start a program that imports VCRUNTIME140.dll. All its imports: ${all.join(', ')}.`)
      error(`[check-pe-imports] ${HINT}`)
      failed++
      continue
    }
    log(`[check-pe-imports] ${file} (${found.format}): OK, no C runtime DLL. It imports: ${all.join(', ')}.`)
  }
  return failed > 0 ? 1 : 0
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = main()
