// 2.1.3-beta.17 (A1, remote step 1): write the session helper's manifest
// BEFORE the Windows package is made. The Windows installer carries the
// static Linux helpers the app uploads to a Linux machine, and this manifest
// beside them; the app checks the file it uploaded against the manifest's hash.
// From 2.1.3-beta.19 (section 1.3) there are two, one per machine architecture
// (verify-bundled-helper.mjs LINUX_HELPERS):
//
//   helper/target/helper-linux-musl/aicc-helper         (the Helper job's helper-linux-musl artifact, x86-64)
//   helper/target/helper-linux-musl-arm64/aicc-helper   (the arm64 job's helper-linux-musl-arm64 artifact)
//     -> helper/target/helper-manifest/manifest.json
//
// package.json's build.win.extraResources copies them to
// resources/helper/linux-x64/aicc-helper, resources/helper/linux-arm64/aicc-helper
// and resources/helper/manifest.json. The manifest lists the Linux helpers
// only: electron-builder signs aicc-helper.exe in the packaged folder, which
// changes its bytes after any hash written here (scripts/verify-bundled-helper.mjs
// has the shape, and checks the packaged copies). It refuses a Linux helper
// that is not a static ELF program for its own machine (x86-64 or AArch64),
// before anything is packaged.
//
// A package needs both, so by default both must be there. A dev run of the
// app and the remote helper device check (remote-helper-e2e, x86-64 only)
// list what they have: with --only-present the manifest lists each helper
// that is there, and at least one must be.
//
//   node scripts/write-helper-manifest.mjs [--only-present]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntryPoint } from './check-pe-imports.mjs'
import { cargoVersion, elfStaticProblems, LINUX_HELPERS, MANIFEST_SOURCE, makeManifest, manifestText, sha256Hex } from './verify-bundled-helper.mjs'

/**
 * The manifest's text for the Linux helpers' bytes (`files`, by each one's
 * source path in LINUX_HELPERS; null or empty: not there) and
 * helper/Cargo.toml's text, or the problems that stop it. Every helper must be
 * there unless `onlyPresent`, and then at least one. Pure, so the unit test
 * drives it.
 */
export function helperManifest(files, cargoToml, { onlyPresent = false } = {}) {
  const version = cargoVersion(cargoToml)
  if (!version) return { problems: ['helper/Cargo.toml names no package version'] }
  const problems = []
  const sha256 = {}
  for (const h of LINUX_HELPERS) {
    const bytes = files?.[h.source]
    if (!bytes || bytes.length === 0) {
      if (!onlyPresent) problems.push(`${h.source} is missing or empty`)
      continue
    }
    const wrong = elfStaticProblems(bytes, h.machine)
    if (wrong.length > 0) problems.push(...wrong.map((p) => `${h.source} ${p}`))
    else sha256[h.path] = sha256Hex(bytes)
  }
  if (problems.length > 0) return { problems }
  if (Object.keys(sha256).length === 0) return { problems: [`no Linux helper is there: ${LINUX_HELPERS.map((h) => h.source).join(', ')}`] }
  return { problems: [], text: manifestText(makeManifest({ version, sha256 })) }
}

function main(argv = process.argv) {
  const flags = argv.slice(2)
  const unknown = flags.filter((f) => f !== '--only-present')
  if (unknown.length > 0) {
    console.error(`[write-helper-manifest] FAIL: it takes only --only-present, not ${unknown.join(' ')}`)
    return 2
  }
  const onlyPresent = flags.includes('--only-present')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const files = {}
  for (const h of LINUX_HELPERS) {
    try {
      files[h.source] = readFileSync(join(root, h.source))
    } catch {
      files[h.source] = null
    }
  }
  const { problems, text } = helperManifest(files, readFileSync(join(root, 'helper', 'Cargo.toml'), 'utf8'), { onlyPresent })
  if (problems.length > 0) {
    for (const p of problems) console.error(`[write-helper-manifest] ${p}`)
    console.error(`[write-helper-manifest] FAIL: the Windows package carries both static Linux helpers. Put the helper-linux-musl artifact of a Helper run on this commit (ci.yml, or release.yml's Linux helper job) at ${LINUX_HELPERS[0].source} and the helper-linux-musl-arm64 artifact of the arm64 job's run at ${LINUX_HELPERS[1].source}, then run this again (a dev run that has only one of them: --only-present).`)
    return 1
  }
  const out = join(root, MANIFEST_SOURCE)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
  console.log(`[write-helper-manifest] ${MANIFEST_SOURCE}: ${text.trim().replace(/\s+/g, ' ')}`)
  return 0
}

if (isEntryPoint(process.argv[1], import.meta.url)) process.exitCode = main()
