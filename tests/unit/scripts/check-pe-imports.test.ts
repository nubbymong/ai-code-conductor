import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
// Plain ESM with main() behind an argv[1] check: importing it runs nothing.
import { CRT_DLL, isCrtDll, readImports, main } from '../../../scripts/check-pe-imports.mjs'

/**
 * The session helper carries its own C runtime on Windows (2.1.3-beta.8
 * section C4): scripts/check-pe-imports.mjs reads a program's import tables and
 * fails on a C runtime DLL, and every Windows build of the shipped helper runs
 * it. The images here are built in memory; no program is read from disk or run.
 */

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')

// ---------------------------------------------------------------- a tiny PE image

type PeSpec = { plus?: boolean; imports?: string[]; delay?: string[]; delayAttributes?: number; imageBase?: number }
type Built = { bytes: Uint8Array; importAt: number; delayAt: number; namesAt: number[] }

const SECTION_RVA = 0x1000
const SECTION_FILE = 0x200

/**
 * One .rdata section holding an import table, a delay-load table and the DLL
 * names, behind real DOS, PE, COFF and optional headers (PE32+ or PE32).
 */
function buildPe({ plus = true, imports = [], delay = [], delayAttributes = 1, imageBase = plus ? 0x140000000 : 0x400000 }: PeSpec = {}): Built {
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
  v.setUint16(coff, plus ? 0x8664 : 0x14c, true)
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
  v.setUint32(opt + (plus ? 108 : 92), 16, true)
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
  return { bytes, importAt: SECTION_FILE, delayAt: SECTION_FILE + delayOff, namesAt: nameOffs.map((o) => SECTION_FILE + o) }
}

/** The imports of aicc-helper.exe as CI built it on beta before this change
 *  (run 44279423407, artifact helper-windows), in the order the file lists them. */
const TODAYS_HELPER = [
  'api-ms-win-core-synch-l1-2-0.dll', 'bcryptprimitives.dll', 'kernel32.dll', 'bcrypt.dll', 'advapi32.dll', 'ntdll.dll',
  'VCRUNTIME140.dll', 'api-ms-win-crt-runtime-l1-1-0.dll', 'api-ms-win-crt-math-l1-1-0.dll', 'api-ms-win-crt-stdio-l1-1-0.dll',
  'api-ms-win-crt-locale-l1-1-0.dll', 'api-ms-win-crt-heap-l1-1-0.dll',
]
const STATIC_HELPER = TODAYS_HELPER.filter((n) => !/^(vcruntime|api-ms-win-crt-)/i.test(n))

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
  it('names every C runtime DLL, in any letter case, debug builds included', () => {
    for (const n of [
      'VCRUNTIME140.dll', 'vcruntime140.dll', 'VCRUNTIME140_1.dll', 'vcruntime140d.dll', 'vcruntime140_1d.dll',
      'MSVCP140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll', 'msvcp140d.dll',
      'MSVCR120.dll', 'msvcr100.dll', 'concrt140.dll', 'vccorlib140.dll', 'vcomp140.dll',
      'ucrtbase.dll', 'ucrtbased.dll',
      'api-ms-win-crt-runtime-l1-1-0.dll', 'API-MS-WIN-CRT-HEAP-L1-1-0.DLL', 'api-ms-win-crt-stdio-l1-1-0.dll', 'api-ms-win-crt-private-l1-1-0.dll',
    ]) expect(isCrtDll(n), n).toBe(true)
  })

  it('leaves Windows itself alone: kernel32, ntdll, the core API sets and the OS copy of msvcrt.dll', () => {
    for (const n of [
      'kernel32.dll', 'KERNEL32.dll', 'ntdll.dll', 'advapi32.dll', 'bcrypt.dll', 'bcryptprimitives.dll', 'user32.dll', 'ws2_32.dll',
      'api-ms-win-core-synch-l1-2-0.dll', 'api-ms-win-core-libraryloader-l1-2-0.dll', 'msvcrt.dll',
      'vcruntime140.dll.bak', 'myvcruntime140.dll', 'api-ms-win-crt-.dll', '', 'VCRUNTIME140',
    ]) expect(isCrtDll(n), n).toBe(false)
    expect(isCrtDll(undefined as unknown as string)).toBe(false)
    expect(CRT_DLL.flags).toContain('i')
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
    expect(() => readImports(far)).toThrow(/outside the file/)
    const nosig = good().bytes
    nosig[0x40] = 0x4e
    expect(() => readImports(nosig)).toThrow(/no PE signature/)
  })

  it('a file cut short inside the headers or the section table', () => {
    expect(() => readImports(good().bytes.subarray(0, 0x50))).toThrow(/outside the file/)
    expect(() => readImports(good().bytes.subarray(0, 0x150))).toThrow(/section table is outside the file/)
  })

  it('an unknown optional header', () => {
    const b = good().bytes
    new DataView(b.buffer).setUint16(0x58, 0x107, true)
    expect(() => readImports(b)).toThrow(/unknown optional header magic 0x107/)
  })

  it('a DLL name whose address is in no section, or a table cut off by the end of the file', () => {
    const b = good()
    new DataView(b.bytes.buffer).setUint32(b.importAt + 12, 0x9000, true)
    expect(() => readImports(b.bytes)).toThrow(/DLL name of entry 0 of the import table \(address 0x9000\) is in no section/)
    const cut = good()
    expect(() => readImports(cut.bytes.subarray(0, cut.importAt + 30))).toThrow(/import table/)
  })

  it('a DLL name that is not printable text, is empty, or has no end', () => {
    const odd = good()
    odd.bytes[odd.namesAt[1] + 2] = 0x01
    expect(() => readImports(odd.bytes)).toThrow(/entry 1 of the import table at offset \d+ is not printable ASCII/)
    const empty = good()
    empty.bytes[empty.namesAt[0]] = 0
    expect(() => readImports(empty.bytes)).toThrow(/entry 0 of the import table at offset \d+ is empty/)
    const endless = good()
    endless.bytes.fill(0x41, endless.namesAt[1])
    expect(() => readImports(endless.bytes)).toThrow(/has no end|longer than 260/)
  })

  it('an import table with no end marker fails instead of reading on', () => {
    const b = good()
    // Overwrite the all-zero end marker with a copy of the first entry: the next
    // entry read is then the name text after the table, which points nowhere.
    b.bytes.copyWithin(b.importAt + 2 * 20, b.importAt, b.importAt + 20)
    expect(() => readImports(b.bytes)).toThrow(/import table/)
  })

  it('a delay-load entry with a zero name address', () => {
    const b = buildPe({ imports: ['kernel32.dll'], delay: ['VCRUNTIME140.dll'] })
    new DataView(b.bytes.buffer).setUint32(b.delayAt + 4, 0, true)
    expect(() => readImports(b.bytes)).toThrow(/delay-load import table has no valid address/)
  })
})

// ---------------------------------------------------------------- the command

describe('main: the exit code CI acts on', () => {
  it("today's helper (it imports VCRUNTIME140.dll and the api-ms-win-crt DLLs) fails, naming each one", () => {
    const r = run({ 'aicc-helper.exe': buildPe({ imports: TODAYS_HELPER }).bytes })
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toContain('FAIL: aicc-helper.exe (PE32+) does not carry its own C runtime: it imports VCRUNTIME140.dll, api-ms-win-crt-runtime-l1-1-0.dll, api-ms-win-crt-math-l1-1-0.dll, api-ms-win-crt-stdio-l1-1-0.dll, api-ms-win-crt-locale-l1-1-0.dll, api-ms-win-crt-heap-l1-1-0.dll.')
    expect(r.err).toContain('+crt-static')
    expect(r.err).toContain('cargo must run from helper/')
  })

  it('the same program built with the C runtime linked in passes, and lists what it imports', () => {
    const r = run({ 'aicc-helper.exe': buildPe({ imports: STATIC_HELPER }).bytes })
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(r.out).toBe(`[check-pe-imports] aicc-helper.exe (PE32+): OK, no C runtime DLL. It imports: ${STATIC_HELPER.join(', ')}.`)
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
    expect(r.err).toContain('names no imported DLL')
  })

  it('a file that is missing or not a program fails, and does not stop the other files being checked', () => {
    const r = run({ 'gone.exe': new Error('ENOENT: no such file'), 'notes.txt': new TextEncoder().encode('just some text, long enough to read the header of it.......'), 'ok.exe': buildPe({ imports: STATIC_HELPER }).bytes })
    expect(r.code).toBe(1)
    expect(r.err).toContain('FAIL: gone.exe cannot be read as a Windows program: ENOENT')
    expect(r.err).toContain('FAIL: notes.txt cannot be read as a Windows program: no MZ header')
    expect(r.out).toContain('ok.exe (PE32+): OK')
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

// ---------------------------------------------------------------- where it runs

type Step = { name?: string; if?: string; run?: string; env?: Record<string, unknown>; 'working-directory'?: string }
type Job = { env?: Record<string, unknown>; steps: Step[] }
type Workflow = { env?: Record<string, unknown>; jobs: Record<string, Job> }
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/release.yml'] as const
const wf = Object.fromEntries(WORKFLOWS.map((f) => [f, yaml.load(read(f)) as Workflow])) as Record<(typeof WORKFLOWS)[number], Workflow>
const CHECK = 'node scripts/check-pe-imports.mjs helper/target/release/aicc-helper.exe'
const isCheck = (s: Step) => s.run?.trim() === CHECK
const runsCargoBuild = (s: Step) => /^\s*cargo build\b/m.test(s.run ?? '')

describe('every Windows build of the shipped helper is checked right after it is built', () => {
  it('ci.yml Helper job: after the Windows release build, under the same condition, before the upload', () => {
    const steps = wf['.github/workflows/ci.yml'].jobs.helper.steps
    const build = steps.findIndex((s) => s.name === 'Build the Windows release binaries')
    expect(build).toBeGreaterThan(0)
    const check = steps[build + 1]
    expect(isCheck(check), JSON.stringify(check)).toBe(true)
    expect(check.if).toBe(steps[build].if)
    expect(check.if).toContain("runner.os == 'Windows'")
    expect(steps.findIndex((s) => s.name === 'Upload the Windows helper')).toBeGreaterThan(build + 1)
  })

  it('ci.yml release/* test installer: after the build, under the same condition, before it is packaged', () => {
    const steps = wf['.github/workflows/ci.yml'].jobs['test-windows-build'].steps
    const build = steps.findIndex(runsCargoBuild)
    expect(build).toBeGreaterThan(0)
    const check = steps[build + 1]
    expect(isCheck(check), JSON.stringify(check)).toBe(true)
    expect(check.if).toBe(steps[build].if)
    expect(steps.findIndex((s) => /npx electron-builder --win/.test(s.run ?? ''))).toBeGreaterThan(build + 1)
  })

  it('release.yml build-windows: after the build, with no condition, before anything is signed or packaged', () => {
    const steps = wf['.github/workflows/release.yml'].jobs['build-windows'].steps
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

  it('no Windows helper build anywhere goes unchecked', () => {
    let builds = 0
    for (const f of WORKFLOWS) {
      for (const [name, job] of Object.entries(wf[f].jobs)) {
        job.steps.forEach((s, i) => {
          if (!runsCargoBuild(s) || !/--release/.test(s.run ?? '')) return
          // The macOS and Linux jobs build a Mach-O or ELF program: nothing to check here.
          if (/mac|linux/i.test(name) || /runner\.os == '(macOS|Linux)'/.test(s.if ?? '')) return
          builds++
          expect(job.steps.slice(i + 1).some(isCheck), `${f} ${name}: "${s.name}" is not followed by the check`).toBe(true)
        })
      }
    }
    expect(builds).toBe(3)
  })
})

describe('every cargo command runs in helper/, so cargo reads helper/.cargo/config.toml', () => {
  it('in ci.yml and release.yml, with no --manifest-path from elsewhere', () => {
    for (const f of WORKFLOWS) {
      let cargo = 0
      for (const [name, job] of Object.entries(wf[f].jobs)) {
        for (const s of job.steps) {
          if (!/^\s*cargo\s/m.test(s.run ?? '')) continue
          cargo++
          expect(s['working-directory'], `${f} ${name}: "${s.name}"`).toBe('helper')
          expect(s.run, `${f} ${name}: "${s.name}"`).not.toContain('--manifest-path')
        }
      }
      expect(cargo, `${f} runs no cargo command; this check would prove nothing`).toBeGreaterThan(2)
    }
  })

  it('and no package.json script builds the helper some other way', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    for (const [name, cmd] of Object.entries(scripts)) expect(cmd, name).not.toMatch(/\bcargo\b/)
  })

  it('no workflow sets RUSTFLAGS or CARGO_ENCODED_RUSTFLAGS, which would replace the config file\'s flags', () => {
    const replaces = /^(CARGO_ENCODED_)?RUSTFLAGS$/
    for (const f of WORKFLOWS) {
      const w = wf[f]
      const envs = [w.env, ...Object.values(w.jobs).flatMap((j) => [j.env, ...j.steps.map((s) => s.env)])]
      for (const env of envs) for (const key of Object.keys(env ?? {})) expect(key, f).not.toMatch(replaces)
      for (const job of Object.values(w.jobs)) {
        for (const s of job.steps) {
          expect(s.run ?? '', `${f}: "${s.name}"`).not.toMatch(/\b(CARGO_ENCODED_)?RUSTFLAGS\s*=|RUSTFLAGS[^\n]*GITHUB_ENV/)
        }
      }
    }
  })
})
