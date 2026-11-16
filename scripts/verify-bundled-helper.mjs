// 2.1.3-beta.6 (plan section B): the installer ships the session helper as
// resources/helper/aicc-helper (aicc-helper.exe on Windows), built from
// helper/ by the release workflow before packaging, and nothing else of
// helper/. This fails the package when the helper is missing, is not a
// program for this OS, says another version than helper/Cargo.toml, or has
// other files beside it.
//
// Run after `npm run verify:package` in every release packaging job
// (`npm run verify:helper`). The check itself (bundledHelperProblems) is pure
// apart from what it is handed, so the unit test drives it.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const helperExeName = (platform = process.platform) => (platform === 'win32' ? 'aicc-helper.exe' : 'aicc-helper')

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

/**
 * What is wrong with the helper in one packaged resources folder: an empty
 * list when it is right. `fs` gives the folder's entries and a file's first
 * bytes and size; `version` runs the packaged helper's `version` command.
 */
export function bundledHelperProblems(resourcesDir, opts) {
  const { platform, expectedVersion, fs, version } = opts
  const exe = helperExeName(platform)
  const folder = join(resourcesDir, 'helper')
  const problems = []
  const entries = fs.list(folder)
  if (entries === null) return [`${folder} is missing`]
  const others = entries.filter((n) => n !== exe)
  if (others.length > 0) problems.push(`${folder} holds more than the helper: ${others.join(', ')}`)
  if (!entries.includes(exe)) return [...problems, `${join(folder, exe)} is missing`]
  const file = join(folder, exe)
  const size = fs.size(file)
  if (!size) return [...problems, `${file} is empty or not a file`]
  const head = fs.head(file, 4)
  const magic = MAGIC[platform] ?? []
  if (!magic.some((m) => head.subarray(0, m.length).equals(m))) problems.push(`${file} is not a program for ${platform}`)
  if (problems.length > 0) return problems
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
    if (problems.length === 0) console.log(`[verify-bundled-helper] ${join(dir, 'helper', helperExeName())}: OK (aicc-helper ${expectedVersion})`)
    for (const p of problems) {
      ok = false
      console.log(`[verify-bundled-helper] MISSING OR WRONG: ${p}`)
    }
  }
  if (!ok) {
    console.error('[verify-bundled-helper] FAIL: the installer must ship the session helper. Build it first: cargo build --release --locked in helper/.')
    process.exit(1)
  }
  console.log('[verify-bundled-helper] PASS: the session helper is packaged.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
