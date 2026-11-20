import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * A test run makes its folders inside the worker's own temp folder, so it leaves
 * nothing of ours in the machine temp folder (aicc_planning #332). Two rules, read
 * from the source with comments removed:
 *
 *   configs  every vitest config at the repo root loads tests/helpers/home-isolation.ts
 *            as its first setup file (with tests/helpers/test-tmp.ts it points TEMP,
 *            TMP and TMPDIR at the worker's temp folder, and fails a test that leaves
 *            one elsewhere), or is the live config, vitest.live.config.ts, which runs
 *            real ssh with the user's own keys and so stays outside that guard. There
 *            every folder a file under tests/live makes with mkdtemp is kept in a
 *            variable whose name is passed to rm or rmSync in the same file, and
 *            os.tmpdir() is named only inside a mkdtemp call: a file written straight
 *            into the machine temp folder stays there (evidence goes to a path the
 *            user names, as CCC_LIVE_DUMP and CCC_REPRO_EVIDENCE do).
 *   roots    no file under tests/ hands mkdtemp or mkdir a hard-coded temp root: a
 *            string that starts with /tmp, a Windows temp path (AppData\Local\Temp,
 *            C:\Temp, C:\Windows\Temp), %TEMP% or %TMP%, or TEMP, TMP or TMPDIR read
 *            straight from the environment. Use os.tmpdir(): under these configs it
 *            is the worker's temp folder.
 *
 * Not checked here (a normal refactor would not write these; add a line when a review
 * finds one):
 *   - a temp root reached through a variable or a helper (const base = '/tmp', then
 *     mkdirSync(base)), or a call made through a renamed or destructured alias
 *   - folders made by the code under test, by a child process or by a native addon
 *   - in tests/live: a removal that is written but never called, one done in a loop or
 *     through a helper, and folders made with mkdir rather than mkdtemp
 *   - outside tests/live, a file (not a folder) written straight into a hard-coded temp
 *     root (writeFileSync('/tmp/x')); in tests/live, the temp folder reached other than
 *     by a tmpdir() call
 *   - vitest configs outside the repo root, workspaces and projects, and Playwright
 *
 * It only reads files.
 */

const ROOT = resolve(__dirname, '..', '..', '..')
const SELF = 'tests/unit/meta/test-temp-folders.test.ts'
const SETUP = 'tests/helpers/home-isolation.ts'
const LIVE_CONFIG = 'vitest.live.config.ts'
const CONFIG_NAME = /^vitest(?:\.[\w-]+)?\.config\.(?:ts|mts|cts|js|mjs|cjs)$/
const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

/** Files that may hand mkdtemp or mkdir a hard-coded temp root, each with its reason. */
const ALLOWED: Record<string, string> = {}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(p, out) }
    else if (CODE_FILE.test(entry.name)) out.push(p)
  }
  return out
}

/** The source without comments, so prose about a call is not taken for the call. */
function stripComments(src: string): string {
  return src.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** The argument text of every call to one of `names`, by paren matching. */
function callArgs(code: string, names: string): string[] {
  const out: string[] = []
  const re = new RegExp(`(?<![\\w$])(?:${names})\\s*\\(`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    let depth = 0
    let end = m.index + m[0].length
    for (; end < code.length; end++) {
      if (code[end] === '(') depth++
      else if (code[end] === ')') { if (depth === 0) break; depth-- }
    }
    out.push(code.slice(m.index + m[0].length, end))
  }
  return out
}

const SLASH = String.raw`(?:\\{1,2}|/)`
const TEMP_ROOTS: Array<[string, RegExp]> = [
  ['a /tmp path', /['"`]\/tmp(?=[/'"`])/],
  ['a Windows temp path', new RegExp(`AppData${SLASH}Local${SLASH}Temp\\b|['"\`][A-Za-z]:${SLASH}(?:Windows${SLASH})?Te?mp\\b`, 'i')],
  ['%TEMP% or %TMP%', /%TE?MP%/i],
  ['a temp variable read from the environment', /\benv\s*(?:\.\s*(?:TEMP|TMP|TMPDIR)\b|\[\s*['"`](?:TEMP|TMP|TMPDIR)['"`]\s*\])/],
]

/** The hard-coded temp roots handed to mkdtemp or mkdir in `src`, one phrase each. */
function hardCodedTempRoots(src: string): string[] {
  const found: string[] = []
  for (const args of callArgs(stripComments(src), 'mkdtemp|mkdtempSync|mkdir|mkdirSync')) {
    for (const [what, re] of TEMP_ROOTS) if (re.test(args)) found.push(`${what} in mk...(${args.trim().slice(0, 80)})`)
  }
  return found
}

/** What is wrong with a vitest config at the repo root, or null. The live config is held to the live rule instead. */
function configProblem(name: string, src: string): string | null {
  if (name === LIVE_CONFIG) return null
  const first = /\bsetupFiles\s*:\s*\[\s*['"`]([^'"`]+)['"`]/.exec(stripComments(src))?.[1]?.replace(/^\.\//, '')
  return first === SETUP ? null : `${name}: its first setupFiles entry is ${first ?? 'missing'}, not ${SETUP}`
}

/** Each folder made with mkdtemp in a tests/live file that is not kept in a variable removed in the same file. */
function liveProblems(file: string, src: string): string[] {
  const code = stripComments(src)
  const problems: string[] = []
  const re = /(?<![\w$])mkdtemp(?:Sync)?\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const kept = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:[\w$]+\.)*$/.exec(code.slice(0, m.index))
    if (!kept) { problems.push(`${file}: a folder made with mkdtemp is not kept in a variable`); continue }
    const name = kept[1]
    if (!new RegExp(`(?<![\\w$])rm(?:Sync)?\\s*\\(\\s*${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(code)) {
      problems.push(`${file}: ${name} is made with mkdtemp and never removed (no rmSync(${name}, ...) in the file)`)
    }
  }
  return problems
}

/** Whether a tests/live file names os.tmpdir() outside a mkdtemp call: what it makes there is never removed. */
function liveTempWrites(file: string, src: string): string[] {
  let code = stripComments(src)
  for (const args of callArgs(code, 'mkdtemp|mkdtempSync')) if (args.trim()) code = code.split(args).join('')
  const n = code.match(/(?<![\w$])tmpdir\s*\(\s*\)/g)?.length ?? 0
  return n === 0 ? [] : [`${file}: names os.tmpdir() outside a mkdtemp call ${n} time(s); a file made straight in the machine temp folder is never removed`]
}

const rel = (abs: string): string => relative(ROOT, abs).split(sep).join('/')
const files = walk(join(ROOT, 'tests')).map(rel).filter((p) => p !== SELF).sort()
const sources = new Map(files.map((p) => [p, readFileSync(join(ROOT, p), 'utf8')]))
const configs = readdirSync(ROOT).filter((n) => CONFIG_NAME.test(n)).sort()
const liveFiles = files.filter((p) => p.startsWith('tests/live/'))

describe('a test run leaves nothing in the machine temp folder', () => {
  it('reads a real tree (a wrong root or a broken rule would make every check below vacuous)', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(configs).toEqual(expect.arrayContaining(['vitest.config.ts', 'vitest.native.config.ts', LIVE_CONFIG]))
    const made = liveFiles.reduce((n, p) => n + (stripComments(sources.get(p)!).match(/(?<![\w$])mkdtemp(?:Sync)?\s*\(/g)?.length ?? 0), 0)
    expect(made, 'no mkdtemp call found under tests/live').toBeGreaterThan(0)
    const calls = files.reduce((n, p) => n + callArgs(stripComments(sources.get(p)!), 'mkdtemp|mkdtempSync|mkdir|mkdirSync').length, 0)
    expect(calls, 'too few mkdtemp / mkdir calls found under tests/').toBeGreaterThan(500)
  })

  it('every vitest config loads the home guard first, or is the live config', () => {
    const problems = configs.map((n) => configProblem(n, readFileSync(join(ROOT, n), 'utf8'))).filter((p): p is string => p !== null)
    expect(problems).toEqual([])
  })

  it('every folder the live pack makes with mkdtemp is removed in the same file', () => {
    expect(liveFiles.flatMap((p) => liveProblems(p, sources.get(p)!))).toEqual([])
  })

  it('the live pack names os.tmpdir() only as the parent of a folder it makes with mkdtemp', () => {
    expect(liveFiles.some((p) => /(?<![\w$])tmpdir\s*\(\s*\)/.test(stripComments(sources.get(p)!))), 'no tmpdir() call found under tests/live').toBe(true)
    expect(liveFiles.flatMap((p) => liveTempWrites(p, sources.get(p)!))).toEqual([])
  })

  it('no file under tests/ hands mkdtemp or mkdir a hard-coded temp root (use os.tmpdir())', () => {
    const hits = files
      .filter((p) => !(p in ALLOWED))
      .flatMap((p) => hardCodedTempRoots(sources.get(p)!).map((h) => `${p}: ${h}`))
    expect(hits).toEqual([])
  })

  it('the allow-list is current: each entry gives a reason and still needs the exception', () => {
    const problems = Object.entries(ALLOWED).flatMap(([p, reason]) => [
      ...(reason.trim().length < 20 ? [`${p}: no reason given`] : []),
      ...(!sources.has(p) ? [`${p}: no such file`] : hardCodedTempRoots(sources.get(p)!).length === 0 ? [`${p}: no longer needs it`] : []),
    ])
    expect(problems).toEqual([])
  })
})

describe('the temp folder rules (verify the verifier)', () => {
  it('flags a config without the home guard first, and passes one with it', () => {
    expect(configProblem('vitest.x.config.ts', `test: { setupFiles: ['tests/unit/setup.ts'] }`)).toMatch(/first setupFiles entry is tests\/unit\/setup\.ts/)
    expect(configProblem('vitest.x.config.ts', `test: { setupFiles: ['tests/unit/setup.ts', '${SETUP}'] }`)).not.toBeNull()
    expect(configProblem('vitest.x.config.ts', `test: { include: ['x'] }`)).toMatch(/is missing/)
    expect(configProblem('vitest.x.config.ts', `// setupFiles: ['${SETUP}']\ntest: {}`)).toMatch(/is missing/)
    expect(configProblem('vitest.x.config.ts', `test: { setupFiles: [\n  '${SETUP}',\n  'tests/unit/setup.ts'] }`)).toBeNull()
    expect(configProblem('vitest.x.config.ts', `test: { setupFiles: ['./${SETUP}'] }`)).toBeNull()
    expect(configProblem(LIVE_CONFIG, `test: { include: ['tests/live/**/*.live.ts'] }`)).toBeNull()
  })

  it('flags a live folder that is not removed, and passes one that is', () => {
    const made = `const scratch = mkdtempSync(join(tmpdir(), 'ccc-live-'))\n`
    expect(liveProblems('x.ts', made)).toEqual([`x.ts: scratch is made with mkdtemp and never removed (no rmSync(scratch, ...) in the file)`])
    expect(liveProblems('x.ts', `${made}afterAll(() => rmSync(scratch, { recursive: true, force: true }))`)).toEqual([])
    expect(liveProblems('x.ts', `const d = await fsp.mkdtemp(p)\nawait fsp.rm(d, { recursive: true })`)).toEqual([])
    expect(liveProblems('x.ts', `const scratchDir = fs.mkdtempSync(p)\nrmSync(scratch, o)`)).toHaveLength(1)
    expect(liveProblems('x.ts', `const file = join(mkdtempSync(p), 'payload.json')\nrmSync(file)`)).toEqual(['x.ts: a folder made with mkdtemp is not kept in a variable'])
    expect(liveProblems('x.ts', `${made}// rmSync(scratch)`)).toHaveLength(1)
  })

  it('flags a live file that writes straight into os.tmpdir(), and passes one that only makes folders there', () => {
    for (const planted of [
      `const EV = process.env.X ?? join(tmpdir(), 'ccc-repro-evidence.txt')`,
      `writeFileSync(path.join(os.tmpdir(), 'x.txt'), s)`,
      `const scratch = mkdtempSync(join(tmpdir(), 'a-'))\nappendFileSync(join(tmpdir(), 'log.txt'), s)`,
    ]) {
      expect(liveTempWrites('x.ts', planted), planted).toHaveLength(1)
    }
    for (const fine of [
      `import { tmpdir } from 'node:os'\nconst scratch = mkdtempSync(join(tmpdir(), 'ccc-live-'))`,
      `const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'x-'))`,
      `// appendFileSync(join(tmpdir(), 'x.txt'), s)`,
      `const EV = process.env.CCC_REPRO_EVIDENCE\nif (EV) appendFileSync(EV, s)`,
    ]) {
      expect(liveTempWrites('x.ts', fine), fine).toEqual([])
    }
  })

  it('flags a hard-coded temp root handed to mkdtemp or mkdir, and passes os.tmpdir()', () => {
    for (const planted of [
      `fs.mkdirSync('/tmp/ccc-x', { recursive: true })`,
      `mkdtempSync(path.join('/tmp', 'ccc-'))`,
      'mkdtempSync(`/tmp/ccc-${id}-`)',
      `mkdtempSync(join(process.env.TEMP!, 'ccc-'))`,
      `await fsp.mkdtemp(join(process.env['TMPDIR'] ?? '', 'x'))`,
      `mkdirSync('C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Temp\\\\ccc-x')`,
      `mkdirSync(String.raw\`C:\\Windows\\Temp\\x\`)`,
      `mkdirSync('C:/Temp/x')`,
      `mkdirSync(\n  path.join(\n    '/tmp',\n    'x'))`,
      `mkdirSync('%TEMP%\\\\x')`,
    ]) {
      expect(hardCodedTempRoots(planted), planted).toHaveLength(1)
    }
    for (const fine of [
      `mkdtempSync(path.join(os.tmpdir(), 'ccc-'))`,
      `mkdirSync(join(root, 'tmp', 'x'), { recursive: true })`,
      `mkdirSync('/tmpfoo')`,
      `const p = '/tmp/x'; fake.exists(p)`,
      `// mkdirSync('/tmp/x')`,
      `mkdirSync(join(TEST_TMP_ROOT, 'Temp'))`,
    ]) {
      expect(hardCodedTempRoots(fine), fine).toEqual([])
    }
  })
})
