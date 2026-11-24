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
// static Linux helper the app uploads to a Linux machine, as
// resources/helper/linux-x64/aicc-helper, and a manifest beside the Windows
// helper, resources/helper/manifest.json:
//
//   {"v":1,"files":[{"path":"linux-x64/aicc-helper","version":"<helper/Cargo.toml>","sha256":"<64 lower-case hex>"}]}
//
// `path` is relative to resources/helper/. scripts/write-helper-manifest.mjs
// writes it BEFORE packaging, so it lists the Linux helper only: it never
// lists aicc-helper.exe, which electron-builder signs in the packaged folder
// (release.yml's build-windows), changing its bytes after any hash written
// earlier. On Windows this then fails the package when the Linux helper is
// missing or not alone in its folder, is not a static x86-64 ELF program (the
// Helper job's rule: no program interpreter, no shared library), or when the
// manifest is missing, is not exactly that shape, names the Windows helper,
// says another version, or holds another hash than the packaged Linux file's.
// The Linux helper cannot run here, so its version is the manifest's, checked
// against helper/Cargo.toml.
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

/** The static Linux helper in the Windows package, relative to resources/helper/. */
export const LINUX_HELPER = 'linux-x64/aicc-helper'
/** The manifest in the Windows package, relative to resources/helper/. */
export const MANIFEST = 'manifest.json'
/** Where the release job puts the static Linux helper before packaging (the Helper job's artifact, helper-linux-musl). */
export const LINUX_HELPER_SOURCE = 'helper/target/helper-linux-musl/aicc-helper'
/** Where scripts/write-helper-manifest.mjs writes the manifest before packaging. */
export const MANIFEST_SOURCE = 'helper/target/helper-manifest/manifest.json'

/** What each OS's resources/helper/ holds, and nothing else. */
export function expectedEntries(platform) {
  return platform === 'win32' ? [helperExeName(platform), LINUX_HELPER.split('/')[0], MANIFEST] : [helperExeName(platform)]
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
const EM_X86_64 = 62

/**
 * Why `bytes` is not a static x86-64 ELF program: an empty list when it is
 * one. The Helper job's rule (ci.yml, "Check the Linux helper is static"),
 * read from the file itself: a 64-bit little-endian ELF file for x86-64 that
 * names no program interpreter (no INTERP header) and no shared library (no
 * NEEDED entry in its dynamic section).
 */
export function elfStaticProblems(bytes) {
  const b = Buffer.from(bytes)
  if (b.length < 64 || !b.subarray(0, 4).equals(MAGIC.linux[0])) return ['is not an ELF file']
  if (b[4] !== 2) return ['is not a 64-bit ELF file']
  if (b[5] !== 1) return ['is not a little-endian ELF file']
  const machine = b.readUInt16LE(18)
  if (machine !== EM_X86_64) return [`is built for ELF machine ${machine}, not x86-64 (${EM_X86_64})`]
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

/** The manifest for a Linux helper of this version and SHA-256. */
export function makeManifest({ version, sha256 }) {
  return { v: 1, files: [{ path: LINUX_HELPER, version, sha256 }] }
}

/** The manifest as written: two-space JSON and a line end. */
export const manifestText = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`

const isWindowsHelper = (p) => typeof p === 'string' && /(^|[\\/])aicc-helper\.exe$/i.test(p)

/**
 * What is wrong with a manifest's text, against the version helper/Cargo.toml
 * names and the SHA-256 of the packaged Linux helper: an empty list when it
 * is right. Exactly `{v: 1, files: [{path, version, sha256}]}`, its one entry
 * the Linux helper; one that names the Windows helper is refused.
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
  if (m.files.some((f) => isWindowsHelper(f?.path))) return ['lists the Windows helper, which electron-builder signs in the package after the manifest is written, so its hash could never hold: only the Linux helper is listed']
  if (m.files.length !== 1) return [`lists ${m.files.length} files, not exactly one (the Linux helper)`]
  const f = m.files[0]
  const fields = f && typeof f === 'object' && !Array.isArray(f) ? Object.keys(f).sort() : []
  if (fields.join(',') !== 'path,sha256,version') return [`its entry has the fields ${fields.join(', ') || '(none)'}, not exactly path, version and sha256`]
  const problems = []
  if (f.path !== LINUX_HELPER) problems.push(`names ${JSON.stringify(f.path)}, not ${LINUX_HELPER}`)
  if (f.version !== expectedVersion) problems.push(`says version ${JSON.stringify(f.version)}, not ${expectedVersion}`)
  if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) problems.push('has a sha256 that is not 64 lower-case hex characters')
  else if (f.sha256 !== sha256) problems.push(`says sha256 ${f.sha256}, but the packaged Linux helper's is ${sha256}`)
  return problems
}

/**
 * What is wrong with the static Linux helper and the manifest in a Windows
 * package's resources/helper/ (`folder`): an empty list when both are right.
 */
function linuxHelperProblems(folder, { expectedVersion, fs }) {
  const [sub, name] = LINUX_HELPER.split('/')
  const subFolder = join(folder, sub)
  const file = join(folder, sub, name)
  const entries = fs.list(subFolder)
  if (entries === null) return [`${subFolder} is missing: the Windows package carries the static Linux helper there`]
  const problems = []
  const others = entries.filter((n) => n !== name)
  if (others.length > 0) problems.push(`${subFolder} holds more than the Linux helper: ${others.join(', ')}`)
  if (!entries.includes(name)) return [...problems, `${file} is missing`]
  if (!fs.size(file)) return [...problems, `${file} is empty or not a file`]
  const bytes = fs.read(file)
  for (const p of elfStaticProblems(bytes)) problems.push(`${file} ${p}`)
  const manifestFile = join(folder, MANIFEST)
  if (!fs.size(manifestFile)) return [...problems, `${manifestFile} is missing or empty`]
  for (const p of manifestProblems(fs.read(manifestFile).toString('utf8'), { expectedVersion, sha256: sha256Hex(bytes) })) problems.push(`${manifestFile} ${p}`)
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
      const extra = process.platform === 'win32' ? `, with ${LINUX_HELPER} and ${MANIFEST}` : ''
      console.log(`[verify-bundled-helper] ${join(dir, 'helper', helperExeName())}: OK (aicc-helper ${expectedVersion}${extra})`)
    }
    for (const p of problems) {
      ok = false
      console.log(`[verify-bundled-helper] MISSING OR WRONG: ${p}`)
    }
  }
  if (!ok) {
    const linux = process.platform === 'win32'
      ? ` The Windows package also carries the static Linux helper: put the helper-linux-musl artifact of a Helper run on this commit (or release.yml's) at ${LINUX_HELPER_SOURCE}, then run node scripts/write-helper-manifest.mjs before packaging.`
      : ''
    console.error(`[verify-bundled-helper] FAIL: the installer must ship the session helper, and on Windows one that carries its own C runtime. Build it first: cargo build --release --locked, run in helper/ (so it reads helper/.cargo/config.toml).${linux}`)
    process.exit(1)
  }
  console.log('[verify-bundled-helper] PASS: the session helper is packaged.')
}

// Through a junction or symlink too: a missed run would exit 0 having checked nothing.
if (isEntryPoint(process.argv[1], import.meta.url)) main()
