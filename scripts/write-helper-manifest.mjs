// 2.1.3-beta.17 (A1, remote step 1): write the session helper's manifest
// BEFORE the Windows package is made. The Windows installer carries the
// static Linux helper the app uploads to a Linux machine, and this manifest
// beside it; the app checks the file it uploaded against the manifest's hash.
//
//   helper/target/helper-linux-musl/aicc-helper   (the Helper job's helper-linux-musl artifact)
//     -> helper/target/helper-manifest/manifest.json
//
// package.json's build.win.extraResources copies the two to
// resources/helper/linux-x64/aicc-helper and resources/helper/manifest.json.
// The manifest lists the Linux helper only: electron-builder signs
// aicc-helper.exe in the packaged folder, which changes its bytes after any
// hash written here (scripts/verify-bundled-helper.mjs has the shape, and
// checks the packaged copy). It refuses a Linux helper that is not a static
// x86-64 ELF program, before anything is packaged.
//
//   node scripts/write-helper-manifest.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntryPoint } from './check-pe-imports.mjs'
import { cargoVersion, elfStaticProblems, LINUX_HELPER_SOURCE, MANIFEST_SOURCE, makeManifest, manifestText, sha256Hex } from './verify-bundled-helper.mjs'

/**
 * The manifest's text for the Linux helper's `bytes` and helper/Cargo.toml's
 * text, or the problems that stop it. Pure, so the unit test drives it.
 */
export function helperManifest(bytes, cargoToml) {
  const version = cargoVersion(cargoToml)
  if (!version) return { problems: ['helper/Cargo.toml names no package version'] }
  if (!bytes || bytes.length === 0) return { problems: [`${LINUX_HELPER_SOURCE} is missing or empty`] }
  const wrong = elfStaticProblems(bytes)
  if (wrong.length > 0) return { problems: wrong.map((p) => `${LINUX_HELPER_SOURCE} ${p}`) }
  return { problems: [], text: manifestText(makeManifest({ version, sha256: sha256Hex(bytes) })) }
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  let bytes = null
  try {
    bytes = readFileSync(join(root, LINUX_HELPER_SOURCE))
  } catch {
    bytes = null
  }
  const { problems, text } = helperManifest(bytes, readFileSync(join(root, 'helper', 'Cargo.toml'), 'utf8'))
  if (problems.length > 0) {
    for (const p of problems) console.error(`[write-helper-manifest] ${p}`)
    console.error(`[write-helper-manifest] FAIL: the Windows package carries the static Linux helper. Put the helper-linux-musl artifact of a Helper run on this commit (ci.yml, or release.yml's Linux helper job) at ${LINUX_HELPER_SOURCE}, then run this again.`)
    return 1
  }
  const out = join(root, MANIFEST_SOURCE)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
  console.log(`[write-helper-manifest] ${MANIFEST_SOURCE}: ${text.trim().replace(/\s+/g, ' ')}`)
  return 0
}

if (isEntryPoint(process.argv[1], import.meta.url)) process.exitCode = main()
