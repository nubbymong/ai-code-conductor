// Claude Code real-CLI conformance (aicc_planning#368): the parts that need no
// CLI. How `claude --help` is read, what the app expects to find in it, and
// how CI's claude-conformance job names the package it installs and finds the
// binary. Plain ESM with no dependency, so the CI helper script
// (claude-conformance-ci.mjs), the suite that starts the real CLI
// (claude-cli-conformance.test.ts) and the unit test that tries it all on help
// text (claude-conformance-lib.test.ts) share one copy.
//
// What is read is Commander's help layout, which `claude --help` uses: a
// switch is DECLARED on a line of its own that starts two spaces in (with a
// short alias first, `-p, --print`); its description follows, wrapped onto
// lines indented to a fixed column. A switch that another switch's description
// merely NAMES sits on such a wrapped line, far more than six spaces in, so
// only a line indented one to six spaces counts as a declaration.
import path from 'node:path'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/

/** A plain semver and nothing else: it becomes an npm package spec. */
export const isPlainSemver = (v) => typeof v === 'string' && v.length <= 64 && SEMVER.test(v)

const SCOPE = '@anthropic-ai/claude-code'
const PLATFORMS = { win32: ['x64', 'arm64'], darwin: ['x64', 'arm64'], linux: ['x64', 'arm64'] }

/** The package that holds the native binary for a runner, or null. The main
 *  package only wraps it behind an install script; the platform package has
 *  no script and no bin, just the file, so it can be installed with
 *  --ignore-scripts and run as it is. (glibc Linux only: the musl packages
 *  are not used on the runners.) */
export function platformPackage(platform, arch) {
  if (typeof platform !== 'string' || typeof arch !== 'string') return null
  return Object.prototype.hasOwnProperty.call(PLATFORMS, platform) && PLATFORMS[platform].includes(arch) ? `${SCOPE}-${platform}-${arch}` : null
}

/** Where `npm install --global --prefix <prefix> <package>` leaves the binary:
 *  `<prefix>\node_modules\<package>\claude.exe` on Windows,
 *  `<prefix>/lib/node_modules/<package>/claude` elsewhere. */
export function packageBinPath(prefix, pkg, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const parts = String(pkg).split('/')
  return platform === 'win32' ? p.join(prefix, 'node_modules', ...parts, 'claude.exe') : p.join(prefix, 'lib', 'node_modules', ...parts, 'claude')
}

/** The version a leg installs and expects: the floor (from the app's
 *  contract, never restated in the workflow) or the dispatched release
 *  candidate, which must be a plain semver. */
export function expectedVersion(kind, rcVersion, contract) {
  if (kind === 'minimum') return isPlainSemver(contract.minimum) ? { kind, version: contract.minimum } : { problem: `the app's own floor (${JSON.stringify(contract.minimum)}) is not a plain semver` }
  if (kind === 'rc') return isPlainSemver(rcVersion) ? { kind, version: rcVersion } : { problem: `the release-candidate version ${JSON.stringify(rcVersion ?? '')} is not a plain semver` }
  return { problem: `unknown version class ${JSON.stringify(kind ?? '')} (minimum or rc)` }
}

// ---------------------------------------------------------------------------
// Reading the help
// ---------------------------------------------------------------------------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const lines = (help) => String(help ?? '').replace(/\r/g, '').split('\n')
const DECLARATION = /^ {1,6}-/

/** True when `flag` is declared on a line of its own (see the header). */
export function flagListed(help, flag) {
  if (typeof flag !== 'string' || !/^-{1,2}[A-Za-z][\w-]*$/.test(flag)) return false
  return new RegExp(`^ {1,6}(?:-[A-Za-z], )?${esc(flag)}(?![\\w-])`, 'm').test(String(help ?? '').replace(/\r/g, ''))
}

/** The description of a declared switch, its wrapped lines joined: from its
 *  line to the next declaration, a blank line or a heading. Empty when the
 *  switch is not declared. */
export function optionBlock(help, flag) {
  const all = lines(help)
  const at = all.findIndex((l) => flagListed(l, flag))
  if (at < 0) return ''
  const first = /^ {1,6}(?:-[A-Za-z], )?\S+(?: (?:<[^>]*>|\[[^\]]*\]))*\s{2,}(.*)$/.exec(all[at])
  const out = first ? [first[1].trim()] : []
  for (let i = at + 1; i < all.length; i += 1) {
    const l = all[i]
    if (l.trim() === '' || DECLARATION.test(l) || /^\S/.test(l)) break
    out.push(l.trim())
  }
  return out.join(' ').trim()
}

/** The values a switch says it accepts: `(choices: "a", "b")` at the end of its
 *  description. [] when it lists none or is not declared. */
export function choicesOf(help, flag) {
  const m = /choices:\s*((?:"[^"]*"(?:,\s*)?)+)/.exec(optionBlock(help, flag))
  return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : []
}

/** Every switch declared on a line of its own, short alias first, in the order
 *  printed. For the log of a run, so a red one says what the CLI did list. */
export function declaredSwitches(help) {
  const out = []
  for (const l of lines(help)) {
    const m = /^ {1,6}(-[A-Za-z](?![\w-]))?(?:,\s+)?(--[A-Za-z][\w-]*)?/.exec(l)
    if (m && (m[1] || m[2]) && l.trimStart().startsWith('-')) out.push(...[m[1], m[2]].filter(Boolean))
  }
  return out
}

/** The lines of the help that name a word (case aside), runs of spaces made
 *  one, at most `max`: what to read when a switch is not declared. */
export function linesNaming(help, word, max = 8) {
  if (typeof word !== 'string' || word === '') return []
  const w = word.toLowerCase()
  return lines(help).map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l.toLowerCase().includes(w)).slice(0, max)
}

/** The command names under `Commands:`, in the order printed. */
export function commandsOf(help) {
  const all = lines(help)
  const at = all.findIndex((l) => l.trim() === 'Commands:')
  if (at < 0) return []
  const out = []
  for (let i = at + 1; i < all.length && all[i].trim() !== ''; i += 1) {
    const m = /^ {1,6}([a-z][\w-]*)(?:\s|$)/.exec(all[i])
    if (m) out.push(m[1])
  }
  return out
}

// ---------------------------------------------------------------------------
// What the app expects
// ---------------------------------------------------------------------------
/** The switches of a constant argv, without the values handed to them. */
export function flagsOfArgs(args) {
  return [...args].filter((a) => typeof a === 'string' && /^-{1,2}[A-Za-z]/.test(a)).map((a) => a.split('=')[0])
}

/** Each of the reviewer's switches (src/main/providers/claude/review.ts,
 *  CLAUDE_REVIEW_ARGS) that `claude --help` does not list, and the
 *  `--output-format` value it is run with, when that switch no longer offers it. */
export function reviewerFlagProblems(help, args) {
  const out = []
  for (const flag of flagsOfArgs(args)) if (!flagListed(help, flag)) out.push(`claude --help no longer lists ${flag}`)
  const at = [...args].indexOf('--output-format')
  if (at >= 0 && typeof args[at + 1] === 'string' && flagListed(help, '--output-format')) out.push(...choiceProblems(help, '--output-format', [args[at + 1]]))
  return out
}

/** Each wanted value that a switch no longer lists among its choices. */
export function choiceProblems(help, flag, wanted) {
  if (!flagListed(help, flag)) return [`claude --help no longer lists ${flag}`]
  const choices = choicesOf(help, flag)
  return [...wanted].filter((w) => !choices.includes(w)).map((w) => `claude --help lists ${flag}, but ${w} is no longer one of its choices (${choices.join(', ')})`)
}

/** The sign-in commands the app runs (`claude auth login|logout|status`) and
 *  the flags of `claude auth login` it writes (one per sign-in method, and
 *  --email). */
export function authProblems(authHelp, loginHelp, methods, commands = ['login', 'logout', 'status']) {
  const out = []
  const listed = commandsOf(authHelp)
  for (const c of commands) if (!listed.includes(c)) out.push(`claude auth --help no longer lists the command ${c}`)
  for (const m of methods) if (!flagListed(loginHelp, `--${m}`)) out.push(`claude auth login --help no longer lists --${m}`)
  if (!flagListed(loginHelp, '--email')) out.push('claude auth login --help no longer lists --email')
  return out
}

// ---------------------------------------------------------------------------
// The prove-red run (the dispatch input conformance_prove_red)
// ---------------------------------------------------------------------------
export const PROVE_RED_FLAG = '--ccc-no-such-flag'
export const PROVE_RED_WORD = 'ccc-no-such-word'

/** The same expectations with one nobody can meet added to each, so every
 *  check of the suite must go red once, each named. */
export function withProveRed({ flags, modes, commands, methods, version }) {
  return {
    flags: [...flags, PROVE_RED_FLAG],
    modes: [...modes, PROVE_RED_WORD],
    commands: [...commands, PROVE_RED_WORD],
    methods: [...methods, PROVE_RED_WORD],
    version: version === '0.0.0' ? '0.0.1' : '0.0.0',
  }
}
