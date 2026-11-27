// [host] PR 4 VM checkpoint (F4): codex-cli-compat.test.ts runs the PATH
// `codex` (CI and the VM; its file is never run on the owner's workstation).
// On the VM it ran with no CODEX_HOME, so Codex wrote its scratch folder into
// the VM user's own ~/.codex. Every run there now gets a fresh, empty Codex
// folder of its own, under the app's own allowlisted Codex environment
// (codexCliEnv: no CODEX_* or OPENAI_* variable of the caller's reaches it),
// removed after the run by its own temp-folder prefix. Checked here without
// starting anything: the environment it builds, the folder's life, and the
// file's one spawn of codex (read as text, never imported or run).
//
// 2.1.3-beta.19 fix round: in CI run 45756034358 the pinned Windows
// conformance leg passed its flag-drift step with the suite skipped (6
// skipped), though codex was on PATH two steps before: the suite's
// `where codex`, under a 3 s limit, read as none (its import took 6.13 s,
// the other two Windows legs' 2.86 s and 2.92 s), and every error read as
// "skip". The suite now finds codex from the PATH folders, with no process and
// no time limit, and fails, never skips, without one on a conformance leg.
// Checked here: the look-up, the fail-or-skip rule, and the file's use of both.
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { compatProbeEnv, withCompatHome, removeCompatHome, COMPAT_HOME_PREFIX, findCodexOnPath, noCodexFailure, CONFORMANCE_KIND_VAR } from './codex-cli-compat-env'

const REAL = path.join('/home', 'someone', '.codex')

describe('the environment the compat probe runs codex under', () => {
  it.each(['linux', 'win32', 'darwin'] as NodeJS.Platform[])('%s: CODEX_HOME is the fresh folder, and no other Codex or OpenAI variable of the caller reaches it', (platform) => {
    const fresh = path.join(os.tmpdir(), `${COMPAT_HOME_PREFIX}abc`)
    const env = compatProbeEnv({
      PATH: platform === 'win32' ? 'C:\\nodejs;C:\\npm' : '/usr/bin:/bin',
      CODEX_HOME: REAL, codex_home: REAL, CODEX_SQLITE_HOME: REAL, OPENAI_API_KEY: 'sk-test', CODEX_API_KEY: 'k', HOME: '/home/someone',
    }, fresh, platform)
    expect(env.CODEX_HOME).toBe(fresh)
    const codexOrOpenAi = Object.keys(env).filter((k) => /^(CODEX|OPENAI)_/i.test(k))
    expect(codexOrOpenAi).toEqual(['CODEX_HOME'])
    expect(Object.values(env)).not.toContain(REAL)
    expect(env.PATH ?? env.Path).toBeTruthy()
  })

  it('refuses to build one without a folder', () => {
    expect(() => compatProbeEnv({ PATH: '/usr/bin' }, '', 'linux')).toThrow()
  })
})

describe('the fresh Codex folder of one run', () => {
  it('is an empty folder of its own prefix directly in the temp folder, removed after the run', () => {
    let seen = ''
    withCompatHome((home) => {
      seen = home
      expect(path.dirname(home)).toBe(os.tmpdir())
      expect(path.basename(home).startsWith(COMPAT_HOME_PREFIX)).toBe(true)
      expect(fs.readdirSync(home)).toEqual([])
      fs.mkdirSync(path.join(home, 'tmp', 'arg0'), { recursive: true })
    })
    expect(seen).not.toBe('')
    expect(fs.existsSync(seen)).toBe(false)
  })

  it('is removed when the run throws too', () => {
    let seen = ''
    expect(() => withCompatHome((home) => { seen = home; throw new Error('the run failed') })).toThrow(/the run failed/)
    expect(fs.existsSync(seen)).toBe(false)
  })

  it('removes only a folder of its own prefix directly in the temp folder', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-cli-compat-other-'))
    try {
      expect(removeCompatHome(other)).toBe(false)
      expect(fs.existsSync(other)).toBe(true)
      expect(removeCompatHome(path.join(other, `${COMPAT_HOME_PREFIX}x`))).toBe(false)
      // A home-like folder outside its own prefix (a decoy: the real home is
      // never handed to the remover, even to be refused).
      const decoyHome = path.join(other, '.codex')
      fs.mkdirSync(decoyHome)
      expect(removeCompatHome(decoyHome)).toBe(false)
      expect(fs.existsSync(decoyHome)).toBe(true)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('codex-cli-compat.test.ts starts codex only through it (source wiring)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'codex-cli-compat.test.ts'), 'utf8')

  it('its one spawn of codex runs inside a fresh folder, with the probe environment', () => {
    expect(src.match(/spawnSync\(/g)).toHaveLength(1)
    expect(src).toMatch(/withCompatHome\(\(home\)(: HelpResult)? => \{[\s\S]*?spawnSync\('codex', \['exec', '--help'\], \{[^}]*\benv: compatProbeEnv\(process\.env, home\)/)
    expect(src).not.toMatch(/\bspawn\(|\bexec\(|execSync\(|execFileSync\(\s*'codex'/)
  })

  it('finds codex through findCodexOnPath, and on a conformance leg without one fails through noCodexFailure: no timed look-up whose error reads as a skip', () => {
    expect(src).toMatch(/const codexFound = findCodexOnPath\(process\.env\.PATH\)/)
    expect(src).toMatch(/const mustNotSkip = noCodexFailure\(codexFound, process\.env\)/)
    expect(src).toMatch(/if \(mustNotSkip\) \{\s*it\('[^']+', \(\) => \{ expect\.fail\(mustNotSkip\) \}\)\s*\} else if \(!haveCodex\) \{\s*it\.skip\(/)
    expect(src).not.toMatch(/execFileSync|'where'|'which'/)
  })
})

describe('how the flag-drift suite finds codex on PATH', () => {
  const holds = (...files: string[]) => (file: string): boolean => files.includes(file)

  it('Windows: the first PATH folder, in order, holding codex with an extension PATHEXT names (npm\'s codex.cmd); a quoted folder counts', () => {
    const pathValue = 'C:\\nodejs;"D:\\a\\_temp\\codex-pinned";C:\\npm'
    expect(findCodexOnPath(pathValue, 'win32', '.COM;.EXE;.BAT;.CMD', holds('C:\\npm\\codex.cmd', 'D:\\a\\_temp\\codex-pinned\\codex.cmd'))).toBe('D:\\a\\_temp\\codex-pinned\\codex.cmd')
    // A file named codex with no extension is not one a Windows shell starts.
    expect(findCodexOnPath('C:\\x', 'win32', '.EXE;.CMD', holds('C:\\x\\codex'))).toBeNull()
    // No PATHEXT: the Windows shell's own list.
    expect(findCodexOnPath('C:\\x', 'win32', undefined, holds('C:\\x\\codex.exe'))).toBe('C:\\x\\codex.exe')
  })

  it('macOS and Linux: codex itself, in PATH order; none there, or no PATH, is none', () => {
    expect(findCodexOnPath('/usr/bin::/opt/codex/bin', 'linux', undefined, holds('/opt/codex/bin/codex'))).toBe('/opt/codex/bin/codex')
    expect(findCodexOnPath('/usr/bin:/bin', 'darwin', undefined, holds('/opt/codex/bin/codex'))).toBeNull()
    expect(findCodexOnPath(undefined, 'linux', undefined, () => true)).toBeNull()
    expect(findCodexOnPath('', 'win32', '.CMD', () => true)).toBeNull()
  })

  it('on this system: a real codex file in a real folder is found, a folder named codex is not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-cli-compat-path-'))
    try {
      const name = process.platform === 'win32' ? 'codex.cmd' : 'codex'
      fs.mkdirSync(path.join(dir, 'a', name), { recursive: true })
      fs.mkdirSync(path.join(dir, 'b'))
      fs.writeFileSync(path.join(dir, 'b', name), process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 })
      const sep = process.platform === 'win32' ? ';' : ':'
      expect(findCodexOnPath([path.join(dir, 'a'), path.join(dir, 'b')].join(sep), process.platform, '.EXE;.CMD')).toBe(path.join(dir, 'b', name))
      expect(findCodexOnPath(path.join(dir, 'a'), process.platform, '.EXE;.CMD')).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('when the flag-drift suite may skip without codex', () => {
  it('on a CI conformance leg (CCC_CODEX_CONFORMANCE_KIND set: minimum, pinned or rc) no codex is a failure, never a skip', () => {
    expect(CONFORMANCE_KIND_VAR).toBe('CCC_CODEX_CONFORMANCE_KIND')
    for (const kind of ['minimum', 'pinned', 'rc']) {
      expect(noCodexFailure(null, { [CONFORMANCE_KIND_VAR]: kind }), kind).toMatch(new RegExp(`^no codex was found on PATH on this ${kind} conformance leg`))
    }
  })

  it('with the variable not set (a developer machine, the unit legs) it may skip; a codex found never fails', () => {
    expect(noCodexFailure(null, {})).toBeNull()
    expect(noCodexFailure(null, { [CONFORMANCE_KIND_VAR]: ' ' })).toBeNull()
    expect(noCodexFailure('/opt/codex/bin/codex', { [CONFORMANCE_KIND_VAR]: 'rc' })).toBeNull()
  })

  it('every leg that sets the variable installs codex and proves it on PATH before the flag-drift step (ci.yml)', () => {
    const ci = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n')
    // Set in one place only: the codex-conformance job's own env.
    expect(ci.match(/CCC_CODEX_CONFORMANCE_KIND:/g)).toHaveLength(1)
    const start = ci.indexOf('\n  codex-conformance:\n')
    expect(start).toBeGreaterThan(0)
    const job = ci.slice(start + 1)
    const next = job.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/)
    const body = next < 0 ? job : job.slice(0, next + 1)
    const at = (s: string): number => { const i = body.indexOf(s); expect(i, s).toBeGreaterThan(0); return i }
    expect(at('CCC_CODEX_CONFORMANCE_KIND: ${{ matrix.cli }}')).toBeLessThan(at('    steps:\n'))
    expect(at('- name: Install Codex')).toBeLessThan(at('- name: The installed CLI is the one on PATH'))
    expect(at('- name: The installed CLI is the one on PATH')).toBeLessThan(at('- name: Flag-drift suite against this install'))
  })
})
