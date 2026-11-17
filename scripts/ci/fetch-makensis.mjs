#!/usr/bin/env node
// electron-builder's own NSIS compiler, for the makensis probes in
// tests/unit/main/installer-nsis-behaviour.test.ts on ci.yml's Windows test
// parts. Those probes compile the real installer macros and run them over a
// fixture tree. Without a compiler they skip, and before this step CI had
// none, so CI skipped every one of them and stayed green.
//
// It asks electron-builder for the compiler the way a release build does
// (app-builder-lib's getMakeNsisPath, with package.json's build.toolsets.nsis
// and build.nsis.customNsisBinary): the same version, fetched by its own
// downloader into its own cache and checked against its own checksum. Then it
// appends MAKENSIS=<path>, and NSISDIR when electron-builder sets one, to
// $GITHUB_ENV for the steps after it. A compiler that cannot be had fails the
// step: the test file's tripwire would fail the part anyway, later and less
// clearly. Anywhere but Windows it does nothing.
//
//   node scripts/ci/fetch-makensis.mjs        # env: GITHUB_ENV

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The $GITHUB_ENV lines for what getMakeNsisPath returned: MAKENSIS, then
 * NSISDIR when it names one. Throws when the compiler is not there, or when a
 * value would break the file's one-line-per-variable format.
 *
 * @param {{ path?: unknown, env?: Record<string, unknown> } | null | undefined} result
 * @param {(p: string) => boolean} [exists]
 * @returns {string[]}
 */
export function envLines(result, exists = existsSync) {
  const exe = result && typeof result.path === 'string' ? result.path : ''
  if (exe === '') throw new Error('electron-builder named no makensis')
  if (!exists(exe)) throw new Error(`electron-builder named ${exe}, which is not there`)
  const out = [`MAKENSIS=${exe}`]
  const dir = result.env && typeof result.env.NSISDIR === 'string' ? result.env.NSISDIR : ''
  if (dir !== '') out.push(`NSISDIR=${dir}`)
  for (const line of out) {
    if (/[\r\n]/.test(line)) throw new Error(`a line break cannot go into GITHUB_ENV: ${JSON.stringify(line)}`)
  }
  return out
}

/** The two settings a release build passes to getMakeNsisPath, from package.json's build section. */
export function nsisSettings(pkg) {
  const build = pkg && typeof pkg.build === 'object' && pkg.build !== null ? pkg.build : {}
  return [build.toolsets?.nsis, build.nsis?.customNsisBinary]
}

export async function main(env = process.env, io = {}) {
  const log = io.log || ((s) => console.log(s))
  const fail = io.error || ((s) => console.error(s))
  const platform = io.platform || process.platform
  if (platform !== 'win32') {
    log('Not Windows: the makensis probes do not run here, so there is no compiler to fetch.')
    return 0
  }
  try {
    const read = io.read || ((file) => readFileSync(file, 'utf8'))
    const getMakeNsisPath =
      io.getMakeNsisPath || createRequire(path.join(ROOT, 'package.json'))('app-builder-lib/out/toolsets/windows').getMakeNsisPath
    const result = await getMakeNsisPath(...nsisSettings(JSON.parse(read(path.join(ROOT, 'package.json')))))
    const lines = envLines(result, io.exists)
    for (const line of lines) log(line)
    if (env.GITHUB_ENV) (io.write || ((file, text) => appendFileSync(file, text)))(env.GITHUB_ENV, `${lines.join('\n')}\n`)
    return 0
  } catch (err) {
    fail(`Could not get electron-builder's NSIS compiler: ${err && err.message ? err.message : err}`)
    return 1
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = await main()
