// [host] aicc_planning#347: discovery reads the version of a Codex installed
// with npm, whose `codex` is the Node launcher bin/codex.js, when that
// launcher replaces itself with the native program (process.execve), as
// @openai/codex 0.170.0 does on a Node that offers it, outside Windows.
//
// CI run 44530368458 (macOS, the rc leg): the app's PATH discovery found
// .../@openai/codex/bin/codex.js and read no version (state invalid, "the
// Codex CLI did not report a version this app recognises"). The scratch
// measurement, CI run 44543504445, gave the cause: the first node on the login
// shell's PATH is Homebrew's Node 24.22.3, which offers process.execve; the
// launcher called it, and the home guard every node child of a test loads
// refused it (exit 1, TEST_ISOLATION_VIOLATION on stderr). Under the job's
// Node 20.20.2 there is no process.execve, so the launcher started the program
// as a child and the version was read. The app's discovery was not at fault;
// the guard now checks the call as it checks a spawn
// (tests/helpers/home-guard-core.mjs).
//
// The launcher here is the real one's last step: replace this process with
// the program when Node offers process.execve, otherwise start it as a child
// with the same output and exit with its code. One difference, so a Windows
// machine runs the guard's decision too: the real launcher does not try
// execve on Windows; this one tries it and, when Node answers that it is not
// available there, starts the child, as the real one does on Windows. The
// native program is a node script that prints the version line.
//
// Starts node children in a temp folder of its own, through the guard; no
// real CLI. The replacement itself happens only on a POSIX Node 22.15 or
// later, which no CI test job runs (they run Node 20). On CI the first case
// takes the child route and the second is skipped (Node 20 has no
// process.execve); on Windows the first takes the child route and the guard
// refuses the second's execve before Node is asked. The conformance job's
// macOS rc leg runs the real launcher through the guard.
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverCodex, runCodexCli, classifyCodexVersion } from '../../../../src/main/providers/codex'
import type { CodexDiscoveryDeps, CodexFileStat } from '../../../../src/main/providers/codex'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-codex-launcher-'))
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }) })

const HAS_EXECVE = typeof (process as unknown as { execve?: unknown }).execve === 'function'

const LAUNCHER = [
  '#!/usr/bin/env node',
  "import { spawn } from 'node:child_process'",
  "import { fileURLToPath } from 'node:url'",
  'const program = process.execPath',
  "const args = [fileURLToPath(new URL('./native.cjs', import.meta.url)), ...process.argv.slice(2)]",
  "const env = { ...process.env, CODEX_MANAGED_BY_NPM: '1', ...JSON.parse(process.env.CCC_TEST_LAUNCHER_ENV || '{}') }",
  "if (typeof process.execve === 'function') {",
  '  try { process.execve(program, [program, ...args], env) }',
  "  catch (e) { if (!e || e.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw e }",
  '}',
  "const child = spawn(program, args, { stdio: 'inherit', env })",
  "child.on('exit', (code) => process.exit(code ?? 1))",
].join('\n')

/** An npm global install's layout: lib/node_modules/@openai/codex/{package.json,bin/codex.js}. */
function install(name: string): string {
  const pkg = path.join(ROOT, name, 'lib', 'node_modules', '@openai', 'codex')
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.170.0', type: 'module', bin: { codex: 'bin/codex.js' } }))
  fs.writeFileSync(path.join(pkg, 'bin', 'native.cjs'), "process.stdout.write('codex-cli 0.170.0\\n')\n")
  const launcher = path.join(pkg, 'bin', 'codex.js')
  fs.writeFileSync(launcher, LAUNCHER)
  return launcher
}

const realStat = (p: string): CodexFileStat => {
  const s = fs.statSync(p, { bigint: true })
  return { size: Number(s.size), mtimeMs: Number(s.mtimeMs), ctimeMs: Number(s.ctimeMs), dev: String(s.dev), ino: String(s.ino), isFile: s.isFile() }
}

/** Discovery as the app runs it, with the real runner. `#!/usr/bin/env node`
 *  is the node running these tests: the run starts it with the launcher. The
 *  run gets homes and a temp folder of its own, in a folder named like a temp
 *  folder: a guarded child trusts its parent's temp folder only when it is
 *  named like one, and this test does not depend on what a runner calls it. */
function deps(launcher: string, launcherEnv: Record<string, string> = {}): CodexDiscoveryDeps {
  const tmp = path.join(fs.mkdtempSync(path.join(ROOT, 'own-')), 'tmp')
  const home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', TEMP: tmp, TMP: tmp, TMPDIR: tmp }
  for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) env[k] = home
  if (process.platform === 'win32') Object.assign(env, { HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2) })
  for (const k of ['SystemRoot', 'ComSpec']) if (process.env[k]) env[k] = process.env[k]!
  return {
    resolve: () => launcher,
    realpath: (p) => fs.realpathSync.native(p),
    stat: realStat,
    run: (cmd, runEnv) => runCodexCli(
      { ...cmd, file: process.execPath, args: [cmd.file, ...cmd.args], verbatim: false },
      { env: { ...runEnv, CCC_TEST_LAUNCHER_ENV: JSON.stringify(launcherEnv) }, timeoutMs: 30_000 },
    ),
    env,
    platform: process.platform,
    versionHome: () => {
      const codexHome = fs.mkdtempSync(path.join(tmp, 'codex-home-'))
      return { home: codexHome, dispose: () => fs.rmSync(codexHome, { recursive: true, force: true }) }
    },
    now: () => Date.now(),
  }
}

describe('discovery reads a Node launcher that replaces itself with its program (aicc_planning#347)', () => {
  it('finds bin/codex.js and reads its version', async () => {
    const launcher = install('clean')
    const r = await discoverCodex(deps(launcher))
    expect(r, JSON.stringify(r)).toMatchObject({ state: 'found', version: '0.170.0', compatibility: classifyCodexVersion('0.170.0') })
    expect(path.basename(r.executable ?? '')).toBe('codex.js')
  }, 60_000)

  // The CI run's shape, kept as a characterization: a launcher whose
  // replacement the guard refuses reads as no version, never as found. It is
  // green on the base by construction (the base refuses every execve), and on
  // Windows the launcher's fallback spawn is refused for the same CODEX_HOME,
  // so it can catch a guard that skips the execve check only on a POSIX Node
  // 22.15 or later; home-guard.test.ts's env and argv case pins that check.
  it.runIf(HAS_EXECVE)('a replacement the guard refuses reads as the CI run read it: invalid, no version', async () => {
    const launcher = install('refused')
    const real = path.join(os.userInfo().homedir, `.ccc-iso-canary-${process.pid}-${Date.now()}`)
    const r = await discoverCodex(deps(launcher, { CODEX_HOME: real }))
    expect(r, JSON.stringify(r)).toMatchObject({ state: 'invalid', detail: 'the Codex CLI did not report a version this app recognises' })
    expect(r.version).toBeUndefined()
  }, 60_000)
})
