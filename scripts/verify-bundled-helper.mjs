// 2.1.3-beta.6 (plan section B): the installer ships the session helper as
// resources/helper/aicc-helper (aicc-helper.exe on Windows), built from
// helper/ by the release workflow before packaging, and nothing else of
// helper/. This fails the package when the helper is missing, is not a
// program for this OS, says another version than helper/Cargo.toml, or has
// other files beside it. On Windows it also fails when the packaged helper
// does not carry its own C runtime, is not x64, names no imported DLL
// (2.1.3-beta.8 section C4), or imports a window-manager DLL at load time
// rather than delay-loading it (2.1.3-beta.14 C6): the rules of
// scripts/check-pe-imports.mjs. This is the packaged, signed copy that ships,
// whatever built it.
//
// From 2.1.3-beta.17 (A1, remote step 1) the Windows package also carries the
// static Linux helper the app uploads to a Linux machine, and a manifest beside
// the Windows helper, resources/helper/manifest.json. From 2.1.3-beta.19
// (section 1.3) it carries two, one per machine architecture (LINUX_HELPERS):
// resources/helper/linux-x64/aicc-helper (x86-64) and
// resources/helper/linux-arm64/aicc-helper (arm64, which Linux reports as
// aarch64), and the manifest lists both, in that order:
//
//   {"v":1,"files":[{"path":"linux-x64/aicc-helper","version":"<helper/Cargo.toml>","sha256":"<64 lower-case hex>"},
//                   {"path":"linux-arm64/aicc-helper","version":"<helper/Cargo.toml>","sha256":"<64 lower-case hex>"}]}
//
// `path` is relative to resources/helper/. scripts/write-helper-manifest.mjs
// writes it BEFORE packaging, so it lists the Linux helpers only: it never
// lists aicc-helper.exe, which electron-builder signs in the packaged folder
// (release.yml's build-windows), changing its bytes after any hash written
// earlier. On Windows this then fails the package when either Linux helper is
// missing or not alone in its folder, is not a static ELF program for its own
// machine (x86-64 or AArch64; the Helper job's rule: no program interpreter,
// no shared library), or when the manifest is missing, is not exactly that
// shape, names the Windows helper, says another version, or holds another
// hash than a packaged Linux file's. The Linux helpers cannot run here, so
// their version is the manifest's, checked against helper/Cargo.toml.
//
// Run after `npm run verify:package` in every release packaging job, and at
// the end of every package script (`npm run verify:helper`). The checks
// themselves (bundledHelperProblems, elfStaticProblems, manifestProblems) are
// pure apart from what they are handed, so the unit test drives them.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importProblems, isEntryPoint, readImports } from './check-pe-imports.mjs'

export const helperExeName = (platform = process.platform) => (platform === 'win32' ? 'aicc-helper.exe' : 'aicc-helper')

/** The x86-64 static Linux helper in the Windows package, relative to resources/helper/. */
export const LINUX_HELPER = 'linux-x64/aicc-helper'
/** The arm64 (AArch64) static Linux helper in the Windows package, relative to resources/helper/ (2.1.3-beta.19). */
export const LINUX_ARM64_HELPER = 'linux-arm64/aicc-helper'
/** The manifest in the Windows package, relative to resources/helper/. */
export const MANIFEST = 'manifest.json'
/** Where the release job puts the x86-64 static Linux helper before packaging (the Helper job's artifact, helper-linux-musl). */
export const LINUX_HELPER_SOURCE = 'helper/target/helper-linux-musl/aicc-helper'
/** Where the release job puts the arm64 static Linux helper before packaging (the arm64 job's artifact, helper-linux-musl-arm64). */
export const LINUX_ARM64_HELPER_SOURCE = 'helper/target/helper-linux-musl-arm64/aicc-helper'
/** Where scripts/write-helper-manifest.mjs writes the manifest before packaging. */
export const MANIFEST_SOURCE = 'helper/target/helper-manifest/manifest.json'

const EM_X86_64 = 62
const EM_AARCH64 = 183
/** Each ELF machine a Linux helper is built for, by the name readelf gives it. */
const MACHINE_NAMES = { [EM_X86_64]: 'x86-64', [EM_AARCH64]: 'AArch64' }

/**
 * The static Linux helpers the Windows package carries, one per machine
 * architecture, in the manifest's order: each one's path under
 * resources/helper/, where the release job puts it before packaging, and the
 * ELF machine it must be built for. src/main/remote-helper/manifest.ts
 * (LINUX_HELPER_ROWS) holds the app's side of the same table.
 */
export const LINUX_HELPERS = Object.freeze([
  Object.freeze({ path: LINUX_HELPER, source: LINUX_HELPER_SOURCE, machine: EM_X86_64 }),
  Object.freeze({ path: LINUX_ARM64_HELPER, source: LINUX_ARM64_HELPER_SOURCE, machine: EM_AARCH64 }),
])

/** What each OS's resources/helper/ holds, and nothing else. */
export function expectedEntries(platform) {
  return platform === 'win32' ? [helperExeName(platform), ...LINUX_HELPERS.map((h) => h.path.split('/')[0]), MANIFEST] : [helperExeName(platform)]
}

/** The first bytes a program for each OS starts with. */
const MAGIC = {
  win32: [Buffer.from('MZ')],
  linux: [Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
  // Mach-O 64-bit (either byte order) and a universal binary.
  darwin: [Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), Buffer.from([0xca, 0xfe, 0xba, 0xbe])],
}

/** helper/Cargo.toml's package version. */
export function cargoVersion(cargoToml) {
  const pkg = /\[package\]([\s\S]*?)(?:\n\[|$)/.exec(cargoToml)
  const m = pkg && /^version\s*=\s*"([^"]+)"/m.exec(pkg[1])
  return m ? m[1] : null
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

const PT_DYNAMIC = 2
const PT_INTERP = 3
const DT_NEEDED = 1n

/**
 * Why `bytes` is not a static ELF program for `machine` (x86-64 unless
 * another is named; AArch64 for the arm64 helper): an empty list when it is
 * one. The Helper job's rule (ci.yml, "Check the Linux helper is static", and
 * the arm64 job's "Check the arm64 Linux helper is static"), read from the
 * file itself: a 64-bit little-endian ELF file for that machine that names no
 * program interpreter (no INTERP header) and no shared library (no NEEDED
 * entry in its dynamic section).
 */
export function elfStaticProblems(bytes, machine = EM_X86_64) {
  const b = Buffer.from(bytes)
  if (b.length < 64 || !b.subarray(0, 4).equals(MAGIC.linux[0])) return ['is not an ELF file']
  if (b[4] !== 2) return ['is not a 64-bit ELF file']
  if (b[5] !== 1) return ['is not a little-endian ELF file']
  const built = b.readUInt16LE(18)
  if (built !== machine) return [`is built for ELF machine ${built}, not ${MACHINE_NAMES[machine] ?? 'that machine'} (${machine})`]
  const phoff = Number(b.readBigUInt64LE(32))
  const phentsize = b.readUInt16LE(54)
  const phnum = b.readUInt16LE(56)
  if (phnum === 0 || phentsize < 56 || phoff + phnum * phentsize > b.length) return ['has no program headers that can be read']
  const problems = []
  let needed = false
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize
    const type = b.readUInt32LE(at)
    if (type === PT_INTERP) problems.push('names a program interpreter (an INTERP header), so it is not static')
    if (type !== PT_DYNAMIC) continue
    const offset = Number(b.readBigUInt64LE(at + 8))
    const size = Number(b.readBigUInt64LE(at + 32))
    if (offset + size > b.length) {
      problems.push('has a dynamic section that cannot be read')
      continue
    }
    for (let e = offset; e + 16 <= offset + size; e += 16) {
      const tag = b.readBigInt64LE(e)
      if (tag === 0n) break
      if (tag === DT_NEEDED) needed = true
    }
  }
  if (needed) problems.push('names a shared library (a NEEDED entry), so it is not static')
  return problems
}

/** The manifest for the Linux helpers of this version: `sha256` gives each
 *  one's SHA-256 by its path, and the entries keep LINUX_HELPERS' order (a
 *  path that is not in the table is never listed). */
export function makeManifest({ version, sha256 }) {
  return { v: 1, files: LINUX_HELPERS.filter((h) => typeof sha256[h.path] === 'string').map((h) => ({ path: h.path, version, sha256: sha256[h.path] })) }
}

/** The manifest as written: two-space JSON and a line end. */
export const manifestText = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`

const isWindowsHelper = (p) => typeof p === 'string' && /(^|[\\/])aicc-helper\.exe$/i.test(p)

/**
 * What is wrong with a manifest's text, against the version helper/Cargo.toml
 * names and the SHA-256 of each packaged Linux helper (`sha256`, by its
 * path): an empty list when it is right. Exactly
 * `{v: 1, files: [{path, version, sha256}, {path, version, sha256}]}`, one
 * entry per Linux helper in LINUX_HELPERS' order; one that names the Windows
 * helper is refused.
 */
export function manifestProblems(text, { expectedVersion, sha256 }) {
  let m
  try {
    m = JSON.parse(text)
  } catch {
    return ['is not JSON']
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['is not a JSON object']
  const keys = Object.keys(m).sort()
  if (keys.join(',') !== 'files,v') return [`has the fields ${keys.join(', ') || '(none)'}, not exactly v and files`]
  if (m.v !== 1) return [`is version ${JSON.stringify(m.v)}, not 1`]
  if (!Array.isArray(m.files)) return ['files is not a list']
  if (m.files.some((f) => isWindowsHelper(f?.path))) return ['lists the Windows helper, which electron-builder signs in the package after the manifest is written, so its hash could never hold: only the Linux helpers are listed']
  if (m.files.length !== LINUX_HELPERS.length) return [`lists ${m.files.length} files, not exactly ${LINUX_HELPERS.length} (the Linux helpers ${LINUX_HELPERS.map((h) => h.path).join(' and ')})`]
  const problems = []
  m.files.forEach((f, i) => {
    const want = LINUX_HELPERS[i]
    const at = `its entry ${i + 1}`
    const fields = f && typeof f === 'object' && !Array.isArray(f) ? Object.keys(f).sort() : []
    if (fields.join(',') !== 'path,sha256,version') {
      problems.push(`${at} has the fields ${fields.join(', ') || '(none)'}, not exactly path, version and sha256`)
      return
    }
    if (f.path !== want.path) problems.push(`${at} names ${JSON.stringify(f.path)}, not ${want.path}`)
    if (f.version !== expectedVersion) problems.push(`${at} says version ${JSON.stringify(f.version)}, not ${expectedVersion}`)
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) problems.push(`${at} has a sha256 that is not 64 lower-case hex characters`)
    else if (f.path === want.path && f.sha256 !== sha256[want.path]) problems.push(`${at} says sha256 ${f.sha256}, but the packaged ${want.path}'s is ${sha256[want.path]}`)
  })
  return problems
}

/**
 * What is wrong with one static Linux helper (`want`, a row of LINUX_HELPERS)
 * in a Windows package's resources/helper/ (`folder`): its problems, and its
 * bytes once it is there to read.
 */
function oneLinuxHelper(folder, want, fs) {
  const [sub, name] = want.path.split('/')
  const subFolder = join(folder, sub)
  const file = join(folder, sub, name)
  const entries = fs.list(subFolder)
  if (entries === null) return { problems: [`${subFolder} is missing: the Windows package carries the static ${MACHINE_NAMES[want.machine]} Linux helper there`] }
  const problems = []
  const others = entries.filter((n) => n !== name)
  if (others.length > 0) problems.push(`${subFolder} holds more than the Linux helper: ${others.join(', ')}`)
  if (!entries.includes(name)) return { problems: [...problems, `${file} is missing`] }
  if (!fs.size(file)) return { problems: [...problems, `${file} is empty or not a file`] }
  const bytes = fs.read(file)
  for (const p of elfStaticProblems(bytes, want.machine)) problems.push(`${file} ${p}`)
  return { problems, bytes }
}

/**
 * What is wrong with the static Linux helpers and the manifest in a Windows
 * package's resources/helper/ (`folder`): an empty list when all are right.
 * Each helper is checked for its own machine, and a package without either
 * fails.
 */
function linuxHelperProblems(folder, { expectedVersion, fs }) {
  const problems = []
  const sha256 = {}
  for (const want of LINUX_HELPERS) {
    const one = oneLinuxHelper(folder, want, fs)
    problems.push(...one.problems)
    if (one.bytes) sha256[want.path] = sha256Hex(one.bytes)
  }
  if (problems.length > 0) return problems
  const manifestFile = join(folder, MANIFEST)
  if (!fs.size(manifestFile)) return [`${manifestFile} is missing or empty`]
  for (const p of manifestProblems(fs.read(manifestFile).toString('utf8'), { expectedVersion, sha256 })) problems.push(`${manifestFile} ${p}`)
  return problems
}

/**
 * What is wrong with the helper in one packaged resources folder: an empty
 * list when it is right. `fs` gives the folder's entries, a file's first
 * bytes and size, and a file's whole bytes (the Windows helper's imports, the
 * Linux helper and the manifest); `version` runs the packaged helper's
 * `version` command, only once everything else is right.
 */
export function bundledHelperProblems(resourcesDir, opts) {
  const { platform, expectedVersion, fs, version } = opts
  const exe = helperExeName(platform)
  const folder = join(resourcesDir, 'helper')
  const problems = []
  const entries = fs.list(folder)
  if (entries === null) return [`${folder} is missing`]
  const allowed = expectedEntries(platform)
  const others = entries.filter((n) => !allowed.includes(n))
  if (others.length > 0) problems.push(`${folder} holds more than the helper: ${others.join(', ')}`)
  if (!entries.includes(exe)) return [...problems, `${join(folder, exe)} is missing`]
  const file = join(folder, exe)
  const size = fs.size(file)
  if (!size) return [...problems, `${file} is empty or not a file`]
  const head = fs.head(file, 4)
  const magic = MAGIC[platform] ?? []
  if (!magic.some((m) => head.subarray(0, m.length).equals(m))) problems.push(`${file} is not a program for ${platform}`)
  if (problems.length > 0) return problems
  if (platform === 'win32') {
    let found
    try {
      found = readImports(fs.read(file))
    } catch (err) {
      return [`${file} cannot be read as a Windows program: ${err?.message ?? err}`]
    }
    const wrong = importProblems(found)
    if (wrong.length > 0) return wrong.map((p) => `${file} ${p}`)
    const linux = linuxHelperProblems(folder, { expectedVersion, fs })
    if (linux.length > 0) return linux
  }
  let said = ''
  try {
    said = String(version(file)).trim()
  } catch (err) {
    return [`${file} version did not run: ${err?.message ?? err}`]
  }
  if (said !== `aicc-helper ${expectedVersion}`) problems.push(`${file} says "${said}", not "aicc-helper ${expectedVersion}"`)
  return problems
}

/** Every packaged resources folder under dist/: the parent of each app.asar.unpacked. */
export function findResourcesDirs(root) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 8 || !existsSync(dir)) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = join(dir, e.name)
      if (e.name === 'app.asar.unpacked') { found.push(dir); continue }
      walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

const diskFs = {
  list: (dir) => {
    try { return statSync(dir).isDirectory() ? readdirSync(dir) : null } catch { return null }
  },
  size: (file) => {
    try { const st = statSync(file); return st.isFile() ? st.size : 0 } catch { return 0 }
  },
  head: (file, n) => readFileSync(file).subarray(0, n),
  read: (file) => readFileSync(file),
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const dist = join(root, 'dist')
  const expectedVersion = cargoVersion(readFileSync(join(root, 'helper', 'Cargo.toml'), 'utf8'))
  if (!expectedVersion) {
    console.error('[verify-bundled-helper] helper/Cargo.toml names no package version')
    process.exit(1)
  }
  const dirs = findResourcesDirs(dist)
  if (dirs.length === 0) {
    console.error('[verify-bundled-helper] no packaged app under dist/: run the packaging first')
    process.exit(1)
  }
  let ok = true
  for (const dir of dirs) {
    const problems = bundledHelperProblems(dir, {
      platform: process.platform,
      expectedVersion,
      fs: diskFs,
      version: (file) => execFileSync(file, ['version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true }),
    })
    if (problems.length === 0) {
      const extra = process.platform === 'win32' ? `, with ${LINUX_HELPERS.map((h) => h.path).join(', ')} and ${MANIFEST}` : ''
      console.log(`[verify-bundled-helper] ${join(dir, 'helper', helperExeName())}: OK (aicc-helper ${expectedVersion}${extra})`)
    }
    for (const p of problems) {
      ok = false
      console.log(`[verify-bundled-helper] MISSING OR WRONG: ${p}`)
    }
  }
  if (!ok) {
    const linux = process.platform === 'win32'
      ? ` The Windows package also carries the two static Linux helpers: put the helper-linux-musl artifact of a Helper run on this commit (or release.yml's) at ${LINUX_HELPER_SOURCE} and the helper-linux-musl-arm64 artifact of the arm64 job's run at ${LINUX_ARM64_HELPER_SOURCE}, then run node scripts/write-helper-manifest.mjs before packaging.`
      : ''
    console.error(`[verify-bundled-helper] FAIL: the installer must ship the session helper, and on Windows one that carries its own C runtime. Build it first: cargo build --release --locked, run in helper/ (so it reads helper/.cargo/config.toml).${linux}`)
    process.exit(1)
  }
  console.log('[verify-bundled-helper] PASS: the session helper is packaged.')
}

// Through a junction or symlink too: a missed run would exit 0 having checked nothing.
if (isEntryPoint(process.argv[1], import.meta.url)) main()
