// aicc_planning#368: the small steps of ci.yml's claude-conformance job, kept
// out of the workflow so no expression is ever spliced into a shell line (as
// codex-conformance-ci.mjs does for the Codex job).
//
//   node tests/integration/claude-conformance-ci.mjs version <minimum|rc>
//     The version this leg installs: the floor is read from the app's own code
//     (CLAUDE_MIN_MANAGED_CLI_VERSION in src/main/providers/claude/
//     managed-launch.ts), never restated in the workflow; the release
//     candidate is the dispatched input, from the RC_VERSION environment
//     variable, and must be a plain semver (it becomes an npm package spec).
//     Writes `version=` to GITHUB_OUTPUT.
//   node tests/integration/claude-conformance-ci.mjs package
//     The npm package that holds the native binary for this runner
//     (`@anthropic-ai/claude-code-<os>-<arch>`). It has no install script and
//     no bin, so it is installed with --ignore-scripts and nothing of Anthropic's
//     or anyone's runs at install time. Writes `package=`.
//   node tests/integration/claude-conformance-ci.mjs bin <prefix> <package>
//     Where `npm install --global --prefix <prefix> <package>` put the binary.
//     Fails unless it exists; makes it executable. Writes `bin=` and `dir=`.
//   node tests/integration/claude-conformance-ci.mjs config
//     A fresh, empty folder to use as CLAUDE_CONFIG_DIR for every run of the
//     CLI, so nothing reads or writes the runner's own Claude folder. Writes
//     `config=`.
//
// The suite checks the installed version against the same contract again
// (claude-cli-conformance.test.ts), so the two cannot drift.
import { readFileSync, appendFileSync, existsSync, mkdtempSync, chmodSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expectedVersion, platformPackage, packageBinPath } from './claude-conformance-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fail = (msg) => { console.error(`claude-conformance: ${msg}`); process.exit(1) }
const output = (pairs) => {
  const lines = Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join('')
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines)
  process.stdout.write(lines)
}

const [what, arg, arg2] = process.argv.slice(2)
if (what === 'version') {
  const src = readFileSync(join(ROOT, 'src/main/providers/claude/managed-launch.ts'), 'utf8')
  const floor = /^export const CLAUDE_MIN_MANAGED_CLI_VERSION = '([^']+)'/m.exec(src)
  const want = expectedVersion(arg, process.env.RC_VERSION, { minimum: floor ? floor[1] : null })
  if ('problem' in want) fail(want.problem)
  output({ version: want.version })
} else if (what === 'package') {
  const pkg = platformPackage(process.platform, process.arch)
  if (!pkg) fail(`no Claude Code package for ${process.platform}-${process.arch}`)
  output({ package: pkg })
} else if (what === 'bin') {
  if (!arg || !arg2) fail('bin needs the install prefix and the package name')
  const named = /^@anthropic-ai\/claude-code-(win32|darwin|linux)-(x64|arm64)$/.exec(arg2)
  if (!named || platformPackage(named[1], named[2]) !== arg2) fail(`${JSON.stringify(arg2)} is not a Claude Code platform package`)
  const bin = packageBinPath(resolve(arg), arg2, process.platform)
  if (!existsSync(bin)) fail(`npm put no CLI at ${bin}`)
  // npm keeps the mode the tarball has for a file that is not a bin entry; make
  // sure it runs.
  if (process.platform !== 'win32') chmodSync(bin, 0o755)
  output({ bin, dir: dirname(bin) })
} else if (what === 'config') {
  output({ config: mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'claude-config-')) })
} else {
  fail(`usage: version <minimum|rc> | package | bin <prefix> <package> | config (got ${JSON.stringify(what ?? '')})`)
}
