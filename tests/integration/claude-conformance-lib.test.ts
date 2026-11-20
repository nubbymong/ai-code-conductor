import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { evalIf, evalValue } from '../helpers/gha-expr'
import { CLAUDE_REVIEW_ARGS } from '../../src/main/providers/claude/review'
import { CLAUDE_MIN_MANAGED_CLI_VERSION } from '../../src/main/providers/claude/managed-launch'
import { CLI_AUTH_METHODS } from '../../src/shared/account-web-session'
import { PERMISSION_MODES } from '../../src/renderer/lib/claude-cli-options'
import {
  isPlainSemver, platformPackage, packageBinPath, expectedVersion, flagListed, optionBlock, choicesOf, commandsOf, declaredSwitches, linesNaming,
  reviewerFlagProblems, choiceProblems, authProblems, flagsOfArgs, withProveRed, PROVE_RED_FLAG, PROVE_RED_WORD,
} from './claude-conformance-lib.mjs'

/**
 * Claude Code real-CLI conformance (aicc_planning#368), the part that needs no
 * CLI: how the help of `claude` is read, what is expected of it, and how the CI
 * job finds the install. The suite that starts the real CLI is
 * claude-cli-conformance.test.ts, which runs only in CI's claude-conformance
 * job; its checks are these functions, so they are tried here on help text
 * shaped like the real thing, including the cases a careless reader gets wrong
 * (a switch only named in another switch's description).
 */

const ROOT = resolve(__dirname, '../..')
const readRepo = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n')

// Commander's layout, as `claude --help` prints it: two spaces, the switch (a
// short alias first), the description from a fixed column, and wrapped lines
// indented to that column.
const MAIN_HELP = [
  'Usage: claude [options] [command] [prompt]',
  '',
  'Claude Code - starts an interactive session by default, use -p/--print for',
  'non-interactive output',
  '',
  'Options:',
  '  --model <model>                       Model for the current session.',
  '  --no-session-persistence              Don\'t save sessions to disk; they can\'t',
  '                                        be resumed (only works with --print)',
  '  --output-format <format>              Output format (only works with --print):',
  '                                        "text" (default), "json" (single',
  '                                        result), or "stream-json" (realtime',
  '                                        streaming) (choices: "text", "json",',
  '                                        "stream-json")',
  '  --permission-mode <mode>              Permission mode to use for the session',
  '                                        (choices: "acceptEdits", "auto",',
  '                                        "bypassPermissions", "manual",',
  '                                        "dontAsk", "plan")',
  '  -p, --print                           Print response and exit (useful for',
  '                                        pipes).',
  '  --restricted                          Restricted mode: removes the built-in',
  '                                        tools that run commands; pair it with',
  '                                        --strict-mcp-config to skip MCP servers',
  '  --strict-mcp-config                   Only use MCP servers from --mcp-config,',
  '                                        ignoring all other MCP configurations',
  '  --tools <tools...>                    Built-in tools to make available: "" for',
  '                                        none, "default" for all',
  '  -h, --help                            Display help for command',
  '',
  'Commands:',
  '  auth                                  Manage authentication',
  '  doctor                                Check the health of your install',
  '  help [command]                        display help for command',
  '',
].join('\n')

const AUTH_HELP = [
  'Usage: claude auth [options] [command]',
  '',
  'Manage authentication',
  '',
  'Options:',
  '  -h, --help        Display help for command',
  '',
  'Commands:',
  '  help [command]    display help for command',
  '  login [options]   Sign in to your Anthropic account',
  '  logout            Log out from your Anthropic account',
  '  status [options]  Show authentication status',
  '',
].join('\n')

const LOGIN_HELP = [
  'Usage: claude auth login [options]',
  '',
  'Sign in to your Anthropic account',
  '',
  'Options:',
  '  --claudeai       Use Claude subscription (default)',
  '  --console        Use Anthropic Console (API usage billing) instead of Claude',
  '                   subscription',
  '  --email <email>  Fill in the email address on the login page',
  '  -h, --help       Display help for command',
  '  --sso            Log in with SSO',
  '',
].join('\n')

describe('reading the help of claude', () => {
  it('lists a switch only where it is declared, never where another switch names it', () => {
    for (const f of ['--model', '--no-session-persistence', '--output-format', '--permission-mode', '-p', '--print', '--restricted', '--strict-mcp-config', '--tools', '--help']) expect(flagListed(MAIN_HELP, f), f).toBe(true)
    // --mcp-config is named in --strict-mcp-config's description, and `-p/--print` in the intro: neither is declared as a line of its own.
    expect(flagListed(MAIN_HELP, '--mcp-config')).toBe(false)
    expect(flagListed(MAIN_HELP, '--ccc-no-such-flag')).toBe(false)
    // A longer switch is not the shorter one.
    expect(flagListed(MAIN_HELP, '--output')).toBe(false)
    expect(flagListed(MAIN_HELP, '--no-session')).toBe(false)
    expect(flagListed(MAIN_HELP, '--print-x')).toBe(false)
    // A switch named only inside another switch's description is not listed: --strict-mcp-config is
    // named in --restricted's text, at the start of a wrapped line, and still must have its own line.
    const own = ['  --strict-mcp-config                   Only use MCP servers from --mcp-config,', '                                        ignoring all other MCP configurations', ''].join('\n')
    expect(MAIN_HELP).toContain(own)
    const noOwnLine = MAIN_HELP.replace(own, '')
    expect(noOwnLine).toContain('--strict-mcp-config to skip MCP servers')
    expect(flagListed(noOwnLine, '--strict-mcp-config')).toBe(false)
  })

  it('reads the choices of a switch across its wrapped lines, and only that switch\'s', () => {
    expect(choicesOf(MAIN_HELP, '--output-format')).toEqual(['text', 'json', 'stream-json'])
    expect(choicesOf(MAIN_HELP, '--permission-mode')).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
    expect(choicesOf(MAIN_HELP, '--model')).toEqual([])
    expect(choicesOf(MAIN_HELP, '--ccc-no-such-flag')).toEqual([])
    expect(optionBlock(MAIN_HELP, '--model')).toBe('Model for the current session.')
    expect(optionBlock(MAIN_HELP, '--permission-mode')).not.toContain('Print response')
  })

  it('lists the switches a help declares, and the lines that name a word, for the log of a run that goes red', () => {
    expect(declaredSwitches(MAIN_HELP)).toEqual(['--model', '--no-session-persistence', '--output-format', '--permission-mode', '-p', '--print', '--restricted', '--strict-mcp-config', '--tools', '-h', '--help'])
    expect(declaredSwitches(LOGIN_HELP)).toEqual(['--claudeai', '--console', '--email', '-h', '--help', '--sso'])
    expect(declaredSwitches('')).toEqual([])
    // The lines that name a word, case aside, trimmed with runs of spaces made one, and bounded.
    expect(linesNaming(MAIN_HELP, 'TOOLS')).toEqual(['tools that run commands; pair it with', '--tools <tools...> Built-in tools to make available: "" for'])
    expect(linesNaming(MAIN_HELP, 'no-such-word')).toEqual([])
    expect(linesNaming(MAIN_HELP, 'a', 2)).toHaveLength(2)
  })

  it('lists the commands under Commands, and not the words of a description', () => {
    expect(commandsOf(MAIN_HELP)).toEqual(['auth', 'doctor', 'help'])
    expect(commandsOf(AUTH_HELP)).toEqual(['help', 'login', 'logout', 'status'])
    expect(commandsOf(LOGIN_HELP)).toEqual([])
    expect(commandsOf('')).toEqual([])
  })
})

describe('what is expected of claude, from the app', () => {
  const flags = flagsOfArgs(CLAUDE_REVIEW_ARGS)

  it('takes the switches of the reviewer\'s constant command line, and not the values it hands them', () => {
    expect(flags).toEqual(['-p', '--restricted', '--strict-mcp-config', '--tools', '--output-format', '--no-session-persistence'])
    expect(flagsOfArgs(['-p', '--tools', 'Read,Grep', '--x=1', 'json'])).toEqual(['-p', '--tools', '--x'])
  })

  it('finds no problem in a help that lists everything the app uses', () => {
    expect(reviewerFlagProblems(MAIN_HELP, CLAUDE_REVIEW_ARGS)).toEqual([])
    expect(choiceProblems(MAIN_HELP, '--permission-mode', PERMISSION_MODES.map((m) => m.value).filter((v) => v !== 'default'))).toEqual([])
    expect(authProblems(AUTH_HELP, LOGIN_HELP, CLI_AUTH_METHODS)).toEqual([])
  })

  it('names each switch the help no longer lists, and the json choice of --output-format when it goes', () => {
    const gone = MAIN_HELP.replace('  --restricted                          Restricted mode: removes the built-in', '  --unrestricted                        Removes the built-in')
    expect(reviewerFlagProblems(gone, CLAUDE_REVIEW_ARGS)).toEqual(['claude --help no longer lists --restricted'])
    const noJson = MAIN_HELP.replace('(choices: "text", "json",', '(choices: "text",')
    expect(reviewerFlagProblems(noJson, CLAUDE_REVIEW_ARGS)).toEqual(['claude --help lists --output-format, but json is no longer one of its choices (text, stream-json)'])
    expect(reviewerFlagProblems('', CLAUDE_REVIEW_ARGS)).toHaveLength(flags.length)
  })

  it('names each choice a switch no longer offers', () => {
    expect(choiceProblems(MAIN_HELP, '--permission-mode', ['plan', 'default', 'acceptEdits'])).toEqual(['claude --help lists --permission-mode, but default is no longer one of its choices (acceptEdits, auto, bypassPermissions, manual, dontAsk, plan)'])
    expect(choiceProblems(MAIN_HELP.replace('--permission-mode', '--perm-mode'), '--permission-mode', ['plan'])).toEqual(['claude --help no longer lists --permission-mode'])
  })

  it('names each sign-in command and method the help no longer lists', () => {
    expect(authProblems(AUTH_HELP.replace('  logout            Log out from your Anthropic account\n', ''), LOGIN_HELP, CLI_AUTH_METHODS)).toEqual(['claude auth --help no longer lists the command logout'])
    expect(authProblems(AUTH_HELP, LOGIN_HELP.replace('  --sso            Log in with SSO\n', ''), CLI_AUTH_METHODS)).toEqual(['claude auth login --help no longer lists --sso'])
    expect(authProblems(AUTH_HELP, LOGIN_HELP.replace('  --email <email>  Fill in the email address on the login page\n', ''), CLI_AUTH_METHODS)).toEqual(['claude auth login --help no longer lists --email'])
  })

  it('has the three sign-in methods and the modes the app offers', () => {
    expect([...CLI_AUTH_METHODS].sort()).toEqual(['claudeai', 'console', 'sso'])
    expect(PERMISSION_MODES.map((m) => m.value)).toContain('plan')
  })

  it('the prove-red run adds an expectation no CLI can meet, so every check goes red', () => {
    const wrong = withProveRed({ flags: CLAUDE_REVIEW_ARGS, modes: ['plan'], commands: ['login'], methods: ['sso'], version: '2.1.329' })
    expect(wrong.flags).toContain(PROVE_RED_FLAG)
    expect(wrong.modes).toContain(PROVE_RED_WORD)
    expect(wrong.commands).toContain(PROVE_RED_WORD)
    expect(wrong.methods).toContain(PROVE_RED_WORD)
    expect(wrong.version).not.toBe('2.1.329')
    expect(reviewerFlagProblems(MAIN_HELP, wrong.flags)).toHaveLength(1)
    expect(choiceProblems(MAIN_HELP, '--permission-mode', wrong.modes)).toHaveLength(1)
    expect(authProblems(AUTH_HELP, LOGIN_HELP, wrong.methods, wrong.commands)).toHaveLength(2)
  })
})

describe('which version a run installs, and where it lands', () => {
  it('knows the floor from the app, and a release candidate from the dispatch input', () => {
    expect(expectedVersion('minimum', undefined, { minimum: '2.1.278' })).toEqual({ kind: 'minimum', version: '2.1.278' })
    expect(expectedVersion('rc', '2.1.329', { minimum: '2.1.278' })).toEqual({ kind: 'rc', version: '2.1.329' })
    expect(expectedVersion('minimum', '2.1.329', { minimum: '2.1.278' })).toEqual({ kind: 'minimum', version: '2.1.278' })
    for (const bad of [undefined, '', 'latest', '2.1', '2.1.329; id', ' 2.1.329']) expect(expectedVersion('rc', bad, { minimum: '2.1.278' }), String(bad)).toHaveProperty('problem')
    expect(expectedVersion('pinned', '1.2.3', { minimum: '2.1.278' })).toHaveProperty('problem')
    expect(expectedVersion(undefined, undefined, { minimum: '2.1.278' })).toHaveProperty('problem')
    expect(isPlainSemver(CLAUDE_MIN_MANAGED_CLI_VERSION)).toBe(true)
  })

  it('maps each runner to the platform package that holds the native binary, and refuses one it does not know', () => {
    expect(platformPackage('win32', 'x64')).toBe('@anthropic-ai/claude-code-win32-x64')
    expect(platformPackage('darwin', 'arm64')).toBe('@anthropic-ai/claude-code-darwin-arm64')
    expect(platformPackage('darwin', 'x64')).toBe('@anthropic-ai/claude-code-darwin-x64')
    expect(platformPackage('linux', 'x64')).toBe('@anthropic-ai/claude-code-linux-x64')
    expect(platformPackage('linux', 'arm64')).toBe('@anthropic-ai/claude-code-linux-arm64')
    for (const [p, a] of [['freebsd', 'x64'], ['linux', 'ia32'], ['win32', 'arm'], ['', ''], ['linux; id', 'x64']]) expect(platformPackage(p, a), `${p} ${a}`).toBeNull()
  })

  it('finds the binary the global install leaves, per operating system', () => {
    expect(packageBinPath('C:\\t\\claude-rc', '@anthropic-ai/claude-code-win32-x64', 'win32')).toBe('C:\\t\\claude-rc\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\claude.exe')
    expect(packageBinPath('/tmp/claude-rc', '@anthropic-ai/claude-code-linux-x64', 'linux')).toBe('/tmp/claude-rc/lib/node_modules/@anthropic-ai/claude-code-linux-x64/claude')
    expect(packageBinPath('/tmp/claude-rc', '@anthropic-ai/claude-code-darwin-arm64', 'darwin')).toBe('/tmp/claude-rc/lib/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude')
  })
})

describe('ci.yml: the claude-conformance job', () => {
  type Step = { name?: string; id?: string; if?: unknown; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; shell?: string }
  type Job = { name: string; if?: unknown; steps: Step[]; permissions?: Record<string, string>; strategy: { 'fail-fast'?: boolean; matrix: { os: string[]; cli: string[] } }; 'runs-on': string; 'timeout-minutes'?: number; env?: Record<string, string> }
  const ci = yaml.load(readRepo('.github/workflows/ci.yml')) as { on: { workflow_dispatch: { inputs: Record<string, { type: string; default: string; required: boolean; description: string }> } }; jobs: Record<string, Job> }
  const job = ci.jobs['claude-conformance']
  const dispatch = (claude: string) => ({ github: { event_name: 'workflow_dispatch', event: {} }, inputs: { codex_rc_version: '', claude_rc_version: claude, conformance_prove_red: false } })
  const other = (event: string) => ({ github: { event_name: event, event: { action: 'labeled', label: { name: 'ci-run' }, pull_request: { labels: [{ name: 'ci-run' }] } } }, inputs: {} })

  it('takes one plain-text input, empty by default', () => {
    const input = ci.on.workflow_dispatch.inputs.claude_rc_version
    expect(input).toMatchObject({ type: 'string', default: '', required: false })
    expect(input.description).toMatch(/Claude Code/)
  })

  it('runs on a dispatch that gave a version, and on no other event', () => {
    expect(job, 'ci.yml has no claude-conformance job').toBeDefined()
    expect(evalIf(job.if, dispatch('2.1.329'))).toBe(true)
    expect(evalIf(job.if, dispatch(''))).toBe(false)
    expect(evalIf(job.if, other('pull_request'))).toBe(false)
    expect(evalIf(job.if, other('push'))).toBe(false)
  })

  it('checks the floor and the dispatched version on the three operating systems, one leg each, none cancelling another', () => {
    expect(job.strategy.matrix.os).toEqual(['windows-2025', 'macos-latest', 'ubuntu-latest'])
    expect(job.strategy.matrix.cli).toEqual(['minimum', 'rc'])
    expect(job.strategy['fail-fast']).toBe(false)
    expect(job['runs-on']).toBe('${{ matrix.os }}')
    expect(String(evalValue(job.name, { matrix: { os: 'ubuntu-latest', cli: 'rc' } }))).toBe('Claude Code CLI rc (ubuntu-latest)')
    // Not one of the required checks, and not read by the release gate.
    expect(String(evalValue(job.name, { matrix: { os: 'windows-2025', cli: 'minimum' } })).startsWith('Test (')).toBe(false)
    expect(job['timeout-minutes']).toBeLessThanOrEqual(30)
  })

  it('holds no secret and can write nothing: contents read only, no secret named', () => {
    expect(job.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(job)).not.toMatch(/secrets\./)
  })

  it('never puts the input in a shell line, and pins its actions by commit', () => {
    for (const s of job.steps) {
      if (s.run !== undefined) expect(s.run, s.name).not.toContain('inputs.')
      if (s.uses) expect(s.uses, s.name).toMatch(/@[0-9a-f]{40}$/)
    }
    const env = job.steps.find((s) => s.id === 'ver')!.env!
    expect(env.RC_VERSION).toBe('${{ inputs.claude_rc_version }}')
  })

  it('runs every step that expands an environment variable under bash: on Windows the default shell is PowerShell, where $NAME is not one', () => {
    const expanding = job.steps.filter((s) => s.run !== undefined && /\$[A-Za-z_]/.test(s.run))
    expect(expanding.length, 'no step expands a variable: the check would be vacuous').toBeGreaterThan(0)
    for (const s of expanding) expect(s.shell, s.name).toBe('bash')
  })

  it('installs the platform package with no install script, into its own prefix, and runs the one suite', () => {
    const install = job.steps.find((s) => /^Install Claude Code/.test(s.name ?? ''))!
    expect(install.run).toMatch(/npm install --global --prefix "\$PREFIX" --ignore-scripts /)
    const suite = job.steps.find((s) => s.run?.includes('claude-cli-conformance.test.ts'))!
    expect(suite.run).toBe('npx vitest run tests/integration/claude-cli-conformance.test.ts')
    expect(suite.env).toMatchObject({ CCC_CLAUDE_CONFORMANCE_BIN: '${{ steps.bin.outputs.bin }}', CCC_CLAUDE_CONFORMANCE_VERSION: '${{ steps.ver.outputs.version }}' })
    expect(job.env).toMatchObject({ CCC_CLAUDE_CONFORMANCE_KIND: '${{ matrix.cli }}' })
  })

  it('honours the prove-red input the way the Codex job does', () => {
    expect(job.env!.CCC_CLAUDE_CONFORMANCE_PROVE_RED).toBe("${{ inputs.conformance_prove_red && '1' || '0' }}")
  })
})
