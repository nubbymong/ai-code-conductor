/**
 * A tiny Windows program (PE image) built in memory, for the tests of
 * scripts/check-pe-imports.mjs and scripts/verify-bundled-helper.mjs. It is
 * never written to disk or run.
 *
 * One .rdata section holds an import table, a delay-load table and the DLL
 * names, behind real DOS, PE, COFF and optional headers (PE32+ or PE32).
 */

export type PeSpec = {
  plus?: boolean
  imports?: string[]
  delay?: string[]
  delayAttributes?: number
  imageBase?: number
  /** The COFF machine type; x64 (0x8664) for PE32+ and x86 (0x14c) for PE32 unless given. */
  machine?: number
  /** NumberOfRvaAndSizes: how many data directories the optional header says it has. */
  dirCount?: number
}

export type Built = {
  bytes: Uint8Array
  /** File offset of the import table, of the delay-load table and of each DLL name. */
  importAt: number
  delayAt: number
  namesAt: number[]
  /** File offset of the one section header, and the section's size in the file. */
  sectionAt: number
  rawSize: number
}

export const SECTION_RVA = 0x1000
export const SECTION_FILE = 0x200

export function buildPe({
  plus = true,
  imports = [],
  delay = [],
  delayAttributes = 1,
  imageBase = plus ? 0x140000000 : 0x400000,
  machine = plus ? 0x8664 : 0x14c,
  dirCount = 16,
}: PeSpec = {}): Built {
  const importLen = imports.length ? (imports.length + 1) * 20 : 0
  const delayOff = importLen
  const delayLen = delay.length ? (delay.length + 1) * 32 : 0
  const names = [...imports, ...delay]
  const nameOffs: number[] = []
  let at = delayOff + delayLen
  for (const n of names) {
    nameOffs.push(at)
    at += n.length + 1
  }
  const rawSize = Math.max(0x200, Math.ceil(at / 0x200) * 0x200)
  const bytes = new Uint8Array(SECTION_FILE + rawSize)
  const v = new DataView(bytes.buffer)
  bytes[0] = 0x4d
  bytes[1] = 0x5a
  v.setUint32(0x3c, 0x40, true)
  bytes.set([0x50, 0x45, 0, 0], 0x40)
  const coff = 0x44
  const optSize = plus ? 240 : 224
  v.setUint16(coff, machine, true)
  v.setUint16(coff + 2, 1, true)
  v.setUint16(coff + 16, optSize, true)
  v.setUint16(coff + 18, 0x22, true)
  const opt = coff + 20
  v.setUint16(opt, plus ? 0x20b : 0x10b, true)
  if (plus) v.setBigUint64(opt + 24, BigInt(imageBase), true)
  else v.setUint32(opt + 28, imageBase, true)
  v.setUint32(opt + 32, 0x1000, true)
  v.setUint32(opt + 36, 0x200, true)
  v.setUint32(opt + 56, SECTION_RVA + rawSize, true)
  v.setUint32(opt + 60, SECTION_FILE, true)
  v.setUint32(opt + (plus ? 108 : 92), dirCount, true)
  const dirs = opt + (plus ? 112 : 96)
  if (imports.length) {
    v.setUint32(dirs + 1 * 8, SECTION_RVA, true)
    v.setUint32(dirs + 1 * 8 + 4, importLen, true)
  }
  if (delay.length) {
    v.setUint32(dirs + 13 * 8, SECTION_RVA + delayOff, true)
    v.setUint32(dirs + 13 * 8 + 4, delayLen, true)
  }
  const sec = opt + optSize
  bytes.set([0x2e, 0x72, 0x64, 0x61, 0x74, 0x61], sec) // .rdata
  v.setUint32(sec + 8, rawSize, true)
  v.setUint32(sec + 12, SECTION_RVA, true)
  v.setUint32(sec + 16, rawSize, true)
  v.setUint32(sec + 20, SECTION_FILE, true)
  imports.forEach((_, i) => {
    const d = SECTION_FILE + i * 20
    v.setUint32(d, SECTION_RVA, true) // OriginalFirstThunk: any non-zero address
    v.setUint32(d + 12, SECTION_RVA + nameOffs[i], true)
    v.setUint32(d + 16, SECTION_RVA, true) // FirstThunk
  })
  delay.forEach((_, i) => {
    const d = SECTION_FILE + delayOff + i * 32
    const rva = SECTION_RVA + nameOffs[imports.length + i]
    v.setUint32(d, delayAttributes, true)
    v.setUint32(d + 4, delayAttributes & 1 ? rva : imageBase + rva, true)
  })
  names.forEach((n, i) => {
    for (let k = 0; k < n.length; k++) bytes[SECTION_FILE + nameOffs[i] + k] = n.charCodeAt(k)
  })
  return { bytes, importAt: SECTION_FILE, delayAt: SECTION_FILE + delayOff, namesAt: nameOffs.map((o) => SECTION_FILE + o), sectionAt: sec, rawSize }
}

/** The imports of aicc-helper.exe as CI built it on beta before 2.1.3-beta.8
 *  section C4 (run 44279423407, artifact helper-windows), in file order. */
export const TODAYS_HELPER = [
  'api-ms-win-core-synch-l1-2-0.dll', 'bcryptprimitives.dll', 'kernel32.dll', 'bcrypt.dll', 'advapi32.dll', 'ntdll.dll',
  'VCRUNTIME140.dll', 'api-ms-win-crt-runtime-l1-1-0.dll', 'api-ms-win-crt-math-l1-1-0.dll', 'api-ms-win-crt-stdio-l1-1-0.dll',
  'api-ms-win-crt-locale-l1-1-0.dll', 'api-ms-win-crt-heap-l1-1-0.dll',
]

/** The same program with the C runtime linked in (CI run 44287817207). */
export const STATIC_HELPER = TODAYS_HELPER.filter((n) => !/^(vcruntime|api-ms-win-crt-)/i.test(n))

/** The window-manager DLLs the capture mode (2.1.3-beta.14 C6) calls, as the
 *  import table of Helper run 45034284744 (windows-2025) named them. */
export const WINDOW_MANAGER_DLLS = ['user32.dll', 'gdi32.dll', 'api-ms-win-shcore-scaling-l1-1-1.dll']

/** The helper with the capture mode, before its window-manager DLLs were
 *  delay-loaded: every mode loaded them at start (Helper run 45034284744). */
export const CAPTURE_HELPER_LOAD_TIME = [...STATIC_HELPER, ...WINDOW_MANAGER_DLLS]
