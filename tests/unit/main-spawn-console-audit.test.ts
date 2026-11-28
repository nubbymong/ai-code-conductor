import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/**
 * #379, item 3 — the spawn-site audit, made executable.
 *
 * The finding from the inventory was that main is ALREADY the console-less
 * parent the issue asks for: Electron's main process has no console, so every
 * `child_process.spawn` from it is fix A by construction, and every site that
 * wants output already pipes it. Nothing needed changing.
 *
 * What needed adding is something that NOTICES if that stops being true. The
 * dangerous combination the issue names is `detached: true` (DETACHED_PROCESS)
 * on a spawn whose output someone expects to capture: the child gets no console
 * of its own, goes looking for its parent's, and — measured, matrix row 2 —
 * still bleeds while the pipe collects 0 bytes. Every `detached: true` in main
 * today is paired with `stdio: 'ignore'`, i.e. "we deliberately want no output
 * from this one" (a browser, an installer), which is fine and stays fine.
 *
 * So: if you add `detached: true`, you must also say `stdio: 'ignore'`. If you
 * want the output, drop `detached` — main already has no console.
 */

const MAIN_DIR = path.resolve(__dirname, '../../src/main')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** The `{ ... }` object literal that contains `index`, by brace matching. */
function enclosingObject(src: string, index: number): string {
  let start = index
  let depth = 0
  while (start > 0) {
    const ch = src[start]
    if (ch === '}') depth++
    else if (ch === '{') { if (depth === 0) break; depth-- }
    start--
  }
  let end = index
  depth = 0
  while (end < src.length) {
    const ch = src[end]
    if (ch === '{') depth++
    else if (ch === '}') { if (depth === 0) break; depth-- }
    end++
  }
  return src.slice(start, end + 1)
}

/** Sites in `src` that pair DETACHED_PROCESS with anything but a discarded stdio. */
function detachedWithoutIgnore(src: string, label: string): string[] {
  const offenders: string[] = []
  const re = /detached:\s*true/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    // Skip prose: the runner's header explains why it never does this.
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    const nl = src.indexOf('\n', m.index)
    const line = src.slice(lineStart, nl === -1 ? undefined : nl)
    if (/^\s*(\*|\/\/)/.test(line)) continue

    const obj = enclosingObject(src, m.index)
    if (!/stdio:\s*'ignore'/.test(obj)) offenders.push(`${label}: ${line.trim()}`)
  }
  return offenders
}

/** A main source's label: its path under src/main, with forward slashes on
 *  every OS, so the exception below names the same file everywhere. */
function auditLabel(file: string): string {
  return path.relative(MAIN_DIR, file).split(path.sep).join('/')
}

/**
 * The one spawn allowed to pair `detached: true` with a pipe, named by its
 * file and its exact line. It is POSIX only: it is reached through the
 * Linux clipboard tool check alone, and that check returns false off Linux
 * before it asks anything (createClaudeClipboardToolCheck and
 * claudeClipboardToolMissing), with process.platform from its only caller,
 * the paste module's press (tests/unit/main/paste-linux-clipboard-tool.test.ts
 * pins "never missing on Windows or macOS, and nothing asked"). So it never
 * runs on Windows, where `detached` is DETACHED_PROCESS and the #379 hazard
 * lives. On POSIX `detached` is setsid: the login shell gets a session and a
 * process group of its own, so the question's deadline can SIGKILL the whole
 * group (killGroup, process.kill(-pgid)), and stdout is piped because the
 * answer is read from it. The test "the one exception still finds its
 * spawn" keeps it narrow and live.
 */
const POSIX_OWN_SESSION_SPAWN = {
  file: 'providers/claude/linux-clipboard-tools.ts',
  spawn: "const child = deps.spawn(file, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: opts.windowsHide })",
} as const
const POSIX_OWN_SESSION_OFFENDER = `${POSIX_OWN_SESSION_SPAWN.file}: ${POSIX_OWN_SESSION_SPAWN.spawn}`

/** `offenders` with the one exception taken out, once. */
function besideTheException(offenders: string[]): string[] {
  const at = offenders.indexOf(POSIX_OWN_SESSION_OFFENDER)
  return at === -1 ? offenders : [...offenders.slice(0, at), ...offenders.slice(at + 1)]
}

describe('main-process spawn options (#379 fix A audit)', () => {
  const files = walk(MAIN_DIR)

  it('finds the main sources to audit', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('the audit can actually fail', () => {
    // Prove the check bites before trusting a green result from it.
    const bad = "const c = spawn(exe, [], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })\n"
    expect(detachedWithoutIgnore(bad, 'synthetic')).toHaveLength(1)

    const good = "const c = spawn(exe, [], { detached: true, stdio: 'ignore' })\n"
    expect(detachedWithoutIgnore(good, 'synthetic')).toEqual([])

    // And that prose is not mistaken for code.
    expect(detachedWithoutIgnore(' * - `detached: true` is never a fix.\n', 'synthetic')).toEqual([])
  })

  it('every `detached: true` spawn in main discards its output', () => {
    const offenders = files.flatMap((file) =>
      detachedWithoutIgnore(fs.readFileSync(file, 'utf8'), auditLabel(file)),
    )
    // A failure here means someone paired DETACHED_PROCESS with a pipe. On
    // Windows that child will still write over whatever console its parent had,
    // and the pipe will collect nothing (#379, measured matrix row 2). Either
    // drop `detached` (main has no console — that is already the fix), or say
    // `stdio: 'ignore'` and mean it.
    // The one named POSIX-only exception (POSIX_OWN_SESSION_SPAWN) is taken
    // out, once; the next test keeps it narrow and live.
    expect(besideTheException(offenders)).toEqual([])
  })

  it('the one exception still finds its spawn, and the same line anywhere else is an offender', () => {
    // It cannot outlive the code: the audit run on that file finds exactly
    // that spawn, so a change to the spawn, or its removal, turns this red.
    const own = files.find((file) => auditLabel(file) === POSIX_OWN_SESSION_SPAWN.file)
    expect(own, 'the excepted file is still in main').toBeDefined()
    const ownSrc = own ? fs.readFileSync(own, 'utf8') : ''
    const found = detachedWithoutIgnore(ownSrc, POSIX_OWN_SESSION_SPAWN.file)
    expect(found).toEqual([POSIX_OWN_SESSION_OFFENDER])
    expect(besideTheException(found)).toEqual([])

    // The same line pasted into any other main file, or into a new file whose
    // name starts with the excepted one, is still an offender.
    const pasted = `  ${POSIX_OWN_SESSION_SPAWN.spawn}\n`
    const others = [
      ...files.map(auditLabel).filter((label) => label !== POSIX_OWN_SESSION_SPAWN.file),
      'providers/claude/linux-clipboard-tools-copy.ts',
    ]
    expect(others.length).toBeGreaterThan(20)
    for (const label of others) {
      expect(besideTheException(detachedWithoutIgnore(pasted, label)), label).toEqual([`${label}: ${POSIX_OWN_SESSION_SPAWN.spawn}`])
    }

    // And a second copy in the excepted file itself is an offender too.
    expect(besideTheException(detachedWithoutIgnore(ownSrc + pasted, POSIX_OWN_SESSION_SPAWN.file))).toEqual([POSIX_OWN_SESSION_OFFENDER])
  })

  it('the captured runner never acquires a shell or a detached child', () => {
    const src = fs.readFileSync(path.join(MAIN_DIR, 'gui-exe-runner.ts'), 'utf8')
    // Just the options object of THAT call. Slicing to end-of-file would let a
    // comment anywhere below satisfy `toContain` (review MINOR-6).
    const at = src.indexOf('child = spawn(')
    expect(at).toBeGreaterThan(-1)
    const opts = enclosingObject(src, src.indexOf('stdio:', at))

    expect(opts).toContain('shell: false')
    expect(opts).toContain('detached: false')
    expect(opts).toContain("stdio: ['ignore', 'pipe', 'pipe']")
    expect(opts).not.toContain('shell: true')
  })

  it('the captured runner never sets windowsHide (#379 BLOCKER-1)', () => {
    // CREATE_NO_WINDOW is matrix row 3: the child gets its OWN invisible
    // console, freopen("CONOUT$") lands there, and the pipes capture 0 bytes.
    // The runner's unit test asserts the absence at the call; this asserts it in
    // the source, because "belt and braces" in a review comment is how it got
    // there the first time.
    const src = fs.readFileSync(path.join(MAIN_DIR, 'gui-exe-runner.ts'), 'utf8')
    const at = src.indexOf('child = spawn(')
    const opts = enclosingObject(src, src.indexOf('stdio:', at))
    // Allowed in a comment (the file explains at length why it is absent);
    // never as a property.
    expect(opts).not.toMatch(/^\s*windowsHide\s*:/m)
  })
})
