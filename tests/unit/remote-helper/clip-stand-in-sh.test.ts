// HOST QUARANTINE: starts real processes (/bin/sh running the files script, the -c wrapper and a login shell) and sets file modes in a temporary home. [CI] [VM] only -- never run on the owner's machine.
/**
 * The clipboard stand-in's two shell layers on a real /bin/sh (plan
 * 2.1.3-beta.21 phase 5, 5.1 and 5.3; ADR-032; docs/remote/helper-protocol.md
 * section 15), as the host runs them:
 *
 * - the `files` fixed script, asked for the stand-in, writes the two scripts
 *   into the session's bin/ folder, the folder and each script 0700, each in
 *   the protocol's two-line form: the helper and the store by absolute path
 *   from $HOME, the session, the tool's name, and the real tool that
 *   `command -v` finds outside bin/. A written script passes its arguments to
 *   the helper exactly. Asked for none, it writes no bin/; with a home that
 *   holds a single quote, or a folder in a script's place, it writes no
 *   script and the session's files are still written;
 * - CLIP_STAND_IN_WRAPPER puts the folder first on PATH after what the rc
 *   files set (a login shell's own ~/.profile here), and an empty PATH gets
 *   the folder alone.
 *
 * Each run has only HOME and PATH (and nothing of this process's own
 * environment). The scripts refuse a home under a folder its group or others
 * may write (scripts.ts CHECKS, `home-open-to-others`), so the test homes are
 * new folders in the CI runner's own temp folder (RUNNER_TEMP, `<work>/_temp`,
 * which the home guard allows), whose folders up to / no other user may
 * write. Not os.homedir() or os.tmpdir(): under vitest's home isolation both
 * are inside the shared temp folder (/tmp on Linux, mode 1777), which every
 * run would be refused for. A `none` run in beforeAll must answer
 * `end ok` exactly, so a refusal from a folder on the way is named, not
 * hidden behind every test's own expectation. The files script's tests need
 * RUNNER_TEMP: on CI without it the file fails, never skips; elsewhere
 * without it they are skipped. All of it is skipped where there is no
 * /bin/sh (Windows).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { scriptText } from '../../../src/main/remote-helper/scripts'
import { CLIP_STAND_IN_WRAPPER } from '../../../src/main/remote-helper/session'

const POSIX = process.platform !== 'win32' && fs.existsSync('/bin/sh')
/** Where the files script's test homes go: the CI runner's own temp folder. */
const BASE = process.env.RUNNER_TEMP || ''
if (POSIX && process.env.CI && !BASE) throw new Error('RUNNER_TEMP is needed on CI: the files script\'s tests make their homes there and would otherwise be skipped')

const D = '0123456789abcdef0123456789abcdef'
const I = 'fedcba9876543210fedcba9876543210'
const N = '00112233445566778899aabbccddeeff'
const G = '0.1.0-aaaaaaaaaaaa'
const SID = 'rm0123456789abcdef0123456789abcd'

/** Runs `/bin/sh <args>` with exactly `env`, `input` on standard input, given up after 20 s. */
function sh(args: string[], env: Record<string, string>, input = ''): { code: number | null; out: string; err: string } {
  const r = spawnSync('/bin/sh', args, { env, input, encoding: 'utf8', timeout: 20_000 })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

const mode = (p: string): number => fs.statSync(p).mode & 0o777

describe.skipIf(!POSIX || !BASE)('the files script writes the stand-in on a real sh', () => {
  let root = ''
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(BASE, 'aicc-clip-sh-'))
    // Every folder from a test home up to / passes the script's home checks:
    // a run that asks for no stand-in answers `end ok` and nothing else.
    const r = home('base').run(SID, 'none')
    if (r.out !== `AICC-RESULT ${N} end ok\n`) throw new Error(`the test homes under ${root} do not pass the files script's checks: ${JSON.stringify(r.out)} ${JSON.stringify(r.err)}`)
  })
  afterAll(() => { if (BASE && root.startsWith(path.join(BASE, 'aicc-clip-sh-'))) fs.rmSync(root, { recursive: true, force: true }) })

  /** A home laid out as Add leaves it: the device folder, its marker, this
   *  build's helper (a stand-in that prints its arguments), and a real
   *  `xclip` and `wl-paste` on the exec's PATH. */
  function home(name: string): { home: string; tools: string; helper: string; store: string; session: (sid: string) => string; run: (sid: string, word: string) => ReturnType<typeof sh> } {
    const h = path.join(root, name)
    const device = path.join(h, '.aicc', D)
    fs.mkdirSync(path.join(device, 'helper', G), { recursive: true, mode: 0o700 })
    for (const f of [h, path.join(h, '.aicc'), device, path.join(device, 'helper'), path.join(device, 'helper', G)]) fs.chmodSync(f, 0o700)
    fs.writeFileSync(path.join(device, 'owner'), `aicc-owner 1 ${D} ${I}\n`)
    const helper = path.join(device, 'helper', G, 'aicc-helper')
    fs.writeFileSync(helper, '#!/bin/sh\nfor a in "$@"; do printf "arg[%s]\\n" "$a"; done\n', { mode: 0o700 })
    const tools = path.join(h, 'tools')
    fs.mkdirSync(tools, { mode: 0o700 })
    for (const t of ['xclip', 'wl-paste']) fs.writeFileSync(path.join(tools, t), '#!/bin/sh\necho real\n', { mode: 0o700 })
    return {
      home: h, tools, helper, store: path.join(device, 'store'),
      session: (sid) => path.join(device, 'sessions', sid),
      run: (sid, word) => sh(['-c', scriptText('files'), 'aicc', N, D, I, sid, 'settings.json:2', G, word], { HOME: h, PATH: `${tools}:/usr/bin:/bin` }, '{}'),
    }
  }

  it('asked: bin/ and each script 0700, in the two-line form, and a script passes its arguments to the helper exactly', () => {
    const h = home('clip')
    const r = h.run(SID, 'clip')
    expect(r.out, r.err).toContain(`AICC-RESULT ${N} clip ok\nAICC-RESULT ${N} end ok\n`)
    const q = h.session(SID)
    expect(fs.readFileSync(path.join(q, 'settings.json'), 'utf8')).toBe('{}')
    const bin = path.join(q, 'bin')
    expect(fs.statSync(bin).isDirectory()).toBe(true)
    expect(mode(bin)).toBe(0o700)
    expect(fs.readdirSync(bin).sort()).toEqual(['wl-paste', 'xclip'])
    for (const t of ['xclip', 'wl-paste']) {
      expect(mode(path.join(bin, t)), t).toBe(0o700)
      expect(fs.readFileSync(path.join(bin, t), 'utf8'), t).toBe(`#!/bin/sh\nexec '${h.helper}' clip --store '${h.store}' --session '${SID}' --as ${t} --real '${path.join(h.tools, t)}' -- "$@"\n`)
    }
    const odd = `a b'c"d $HOME`
    const ran = spawnSync(path.join(bin, 'xclip'), ['-selection', 'clipboard', '-o', '-t', 'TARGETS', odd, ''], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 20_000 })
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.stdout.split('\n').filter((l) => l !== '')).toEqual(
      ['clip', '--store', h.store, '--session', SID, '--as', 'xclip', '--real', path.join(h.tools, 'xclip'), '--', '-selection', 'clipboard', '-o', '-t', 'TARGETS', odd, ''].map((a) => `arg[${a}]`),
    )
  })

  it('asked again over scripts that are there: each is replaced, never written through, and no staging file is left', () => {
    const h = home('again')
    expect(h.run(SID, 'clip').out).toContain(`AICC-RESULT ${N} clip ok`)
    const bin = path.join(h.session(SID), 'bin')
    fs.rmSync(path.join(h.tools, 'wl-paste'))
    const target = path.join(h.home, 'target')
    fs.writeFileSync(target, 'kept\n')
    fs.rmSync(path.join(bin, 'xclip'))
    fs.symlinkSync(target, path.join(bin, 'xclip'))
    expect(h.run(SID, 'clip').out).toContain(`AICC-RESULT ${N} clip ok`)
    expect(fs.readFileSync(target, 'utf8')).toBe('kept\n')
    expect(fs.lstatSync(path.join(bin, 'xclip')).isSymbolicLink()).toBe(false)
    // The test's wl-paste is gone from the exec's PATH: --real names what
    // `command -v` finds there now (the runner's own, if it has one), or is left out.
    const found = sh(['-c', 'command -v wl-paste || true'], { PATH: `${h.tools}:/usr/bin:/bin` }).out.trim()
    const real = found.startsWith('/') ? ` --real '${found}'` : ''
    expect(fs.readFileSync(path.join(bin, 'wl-paste'), 'utf8')).toBe(`#!/bin/sh\nexec '${h.helper}' clip --store '${h.store}' --session '${SID}' --as wl-paste${real} -- "$@"\n`)
    expect(fs.readdirSync(bin).sort()).toEqual(['wl-paste', 'xclip'])
  })

  it('asked for none: no bin/, and the session\'s files are written as before', () => {
    const h = home('none')
    const r = h.run(SID, 'none')
    expect(r.out, r.err).toBe(`AICC-RESULT ${N} end ok\n`)
    expect(fs.readdirSync(h.session(SID))).toEqual(['settings.json'])
  })

  it('a folder in a script\'s place: no script, said, and the session\'s files are still written', () => {
    const h = home('folder')
    fs.mkdirSync(path.join(h.session(SID), 'bin', 'xclip'), { recursive: true })
    for (const f of [path.join(h.home, '.aicc', D, 'sessions'), h.session(SID), path.join(h.session(SID), 'bin')]) fs.chmodSync(f, 0o700)
    const r = h.run(SID, 'clip')
    expect(r.out, r.err).toContain(`AICC-RESULT ${N} clip bin-file-is-a-folder\nAICC-RESULT ${N} end ok\n`)
    expect(fs.readFileSync(path.join(h.session(SID), 'settings.json'), 'utf8')).toBe('{}')
  })

  it('a home that holds a single quote: no script is written, said, and the session\'s files are still written', () => {
    const h = home("o'brien")
    const r = h.run(SID, 'clip')
    expect(r.out, r.err).toContain(`AICC-RESULT ${N} clip bad-path\nAICC-RESULT ${N} end ok\n`)
    expect(fs.readdirSync(h.session(SID))).toEqual(['settings.json'])
  })
})

describe.skipIf(!POSIX)('the -c wrapper puts bin/ first on PATH, after the rc files', () => {
  const BIN = '/home/u/.aicc/d/sessions/s/bin'
  const PRINT = ['-c', 'printf "%s" "$PATH"']

  it('in front of the PATH it is given, and alone for an empty one; the program gets its own arguments', () => {
    const r = sh(['-c', CLIP_STAND_IN_WRAPPER, '/bin/sh', BIN, ...PRINT], { PATH: '/from/rc:/usr/bin:/bin' })
    expect(r.out, r.err).toBe(`${BIN}:/from/rc:/usr/bin:/bin`)
    expect(sh(['-c', CLIP_STAND_IN_WRAPPER, '/bin/sh', BIN, ...PRINT], { PATH: '' }).out).toBe(BIN)
    const args = sh(['-c', CLIP_STAND_IN_WRAPPER, '/bin/sh', BIN, '-c', 'for a in "$@"; do printf "[%s]" "$a"; done', 'x', 'a b', ''], { PATH: '/usr/bin:/bin' })
    expect(args.out).toBe('[a b][]')
  })

  it('a login shell: after its ~/.profile has set PATH', () => {
    const h = fs.mkdtempSync(path.join(os.homedir(), '.aicc-clip-rc-'))
    try {
      fs.writeFileSync(path.join(h, '.profile'), 'PATH=/from/profile:$PATH; export PATH\n')
      const r = sh(['-il', '-c', CLIP_STAND_IN_WRAPPER, '/bin/sh', BIN, ...PRINT], { HOME: h, PATH: '/usr/bin:/bin' })
      expect(r.out.startsWith(`${BIN}:/from/profile:`), `${r.out} / ${r.err}`).toBe(true)
    } finally {
      fs.rmSync(h, { recursive: true, force: true })
    }
  })
})
