import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createRequire } from 'module'

/**
 * Probes P3 and P6 (helper/probes/p3-p6-linux.cjs; plan 2.1.3-beta.13 C2,
 * aicc_planning#377) run from the test PC against remote Linux hosts, so CI
 * cannot run them. What is checked here: the verdicts follow the decision
 * lines written before measuring; only the two key slots' host and user are
 * read from the hosts file; only ssh and scp are started; the host is left as
 * found by deleting each thing by name.
 *
 * Not checked here: what the probe measures (only a run on a real host does),
 * how a remote shell reads the scripts, ssh error wording other than the
 * samples below.
 */

const ROOT = resolve(__dirname, '../../..')
const FILE = resolve(ROOT, 'helper/probes/p3-p6-linux.cjs')
const src = readFileSync(FILE, 'utf-8').replace(/\r\n/g, '\n')
type Run = { form: string; started: boolean; alive?: Record<number, boolean | null> }
type Side = { path: string; found: Record<string, string> } | null
const probe = createRequire(import.meta.url)(FILE) as {
  SLOTS: string[]
  SSH_OPTS: string[]
  readSlots: (json: unknown) => Array<Record<string, string>>
  classifyFailure: (r: { status: number | null; stderr?: string; timedOut?: boolean }) => string
  parseMarked: (text: string) => Record<string, string | string[]> | null
  redact: (text: string, home: string, user: string) => string
  pathEntries: (p: string) => string[]
  p3Verdict: (runs: Run[]) => { verdict: string; why: string }
  p6Verdict: (exec: Side, login: Side) => { verdict: string; why: string }
  isProbeDir: (p: string) => boolean
  isEndpoint: (p: string, uid: string, sid: string) => boolean
  holdCommand: (dir: string, sid: string) => string
  checkScript: (dir: string, holders: Array<{ pid: number; sid: string }>) => string
  cleanScript: (dir: string, holders: Array<{ pid: number; sid: string }>, endpoints: string[], uid: string, rundirBefore: string) => string
}

const alive = (form: string, at10: boolean | null, at60: boolean | null): Run => ({ form, started: true, alive: { 10: at10, 60: at60 } })
const six = (at60: boolean | null = true) => ['tty', 'exec'].flatMap((f) => [alive(f, true, true), alive(f, true, true), alive(f, true, at60)])

describe('probe P3/P6: the hosts file', () => {
  it('reads the linuxKey and linuxRockyKey slots by name, and of each only host and username', () => {
    expect(probe.SLOTS).toEqual(['linuxKey', 'linuxRockyKey'])
    const json = {
      linuxKey: { host: '192.0.2.10', username: 'you', password: 'not-this-one' },
      linuxRockyKey: { host: 'rocky.example', username: 'me2' },
      linuxPassword: { host: '192.0.2.11', username: 'pw', password: 'nor-this' },
      linuxRocky: { host: '192.0.2.14', username: 'pw2', password: 'nor-that' },
    }
    const slots = probe.readSlots(json)
    expect(slots).toEqual([
      { slot: 'linuxKey', host: '192.0.2.10', username: 'you' },
      { slot: 'linuxRockyKey', host: 'rocky.example', username: 'me2' },
    ])
    expect(JSON.stringify(slots)).not.toMatch(/not-this-one|nor-this|nor-that|192\.0\.2\.1[14]/)
  })

  it('a missing slot, or one whose host or user ssh would read as an option, is not run', () => {
    const [key, rocky] = probe.readSlots({ linuxKey: { host: '-oProxyCommand=x', username: 'you' } })
    expect(key.missing).toMatch(/host/)
    expect(rocky.missing).toMatch(/no such slot/)
    expect(probe.readSlots({ linuxKey: { host: 'a b', username: 'you' } })[0].missing).toBeDefined()
    expect(probe.readSlots({ linuxKey: { host: '192.0.2.10', username: '-l' } })[0].missing).toMatch(/username/)
    expect(probe.readSlots(null).every((s) => s.missing)).toBe(true)
  })

  it('the script reads no password field and starts no program but ssh and scp', () => {
    expect(src).not.toMatch(/\.password\b|\['password'\]|\["password"\]/)
    expect(src).not.toMatch(/sshpass|plink|SSH_ASKPASS/)
    const started = new Set([...src.matchAll(/spawnSync\(\s*'([^']+)'/g)].map((m) => m[1]))
    expect([...started].sort()).toEqual(['scp', 'ssh'])
    // child_process is taken once, for spawnSync alone.
    expect(src.match(/child_process/g)).toHaveLength(1)
    expect(src).toContain("const { spawnSync } = require('node:child_process');")
    for (const opt of ['BatchMode=yes', 'ConnectTimeout=8', 'ControlMaster=no', 'ControlPath=none']) expect(probe.SSH_OPTS).toContain(opt)
  })
})

describe('probe P3: the verdict follows the decision lines', () => {
  it('HOLDS when every holder is alive at 60 s in 3 of 3 runs of each form', () => {
    expect(probe.p3Verdict(six()).verdict).toBe('HOLDS')
  })

  it('DOES NOT HOLD when any holder is gone at 60 s, whatever else is missing', () => {
    expect(probe.p3Verdict(six(false)).verdict).toBe('DOES NOT HOLD')
    expect(probe.p3Verdict([alive('exec', true, false)]).verdict).toBe('DOES NOT HOLD')
  })

  it('CANNOT MEASURE with fewer than 3 started runs in a form, or a check that was not read', () => {
    const two = six().filter((r, i) => i !== 0)
    expect(probe.p3Verdict(two)).toMatchObject({ verdict: 'CANNOT MEASURE', why: expect.stringContaining('2 of 3 tty') })
    const notStarted = six().map((r, i) => (i === 3 ? { ...r, started: false } : r))
    expect(probe.p3Verdict(notStarted).verdict).toBe('CANNOT MEASURE')
    expect(probe.p3Verdict(six(null)).verdict).toBe('CANNOT MEASURE')
    expect(probe.p3Verdict([]).verdict).toBe('CANNOT MEASURE')
  })

  it('alive at 10 s alone is not enough', () => {
    const runs = six().map((r, i) => (i === 5 ? alive('exec', true, false) : r))
    expect(probe.p3Verdict(runs).verdict).toBe('DOES NOT HOLD')
  })
})

describe('probe P6: the verdict follows the decision lines', () => {
  const side = (path: string, found: Record<string, string> = {}): Side => ({ path, found: { claude: '', codex: '', node: '', ...found } })

  it('SAME when the entries are the same in order once repeats and empty entries are dropped, and every lookup agrees', () => {
    const v = probe.p6Verdict(side('/usr/bin:/bin:/usr/bin', { node: '/usr/bin/node' }), side('/usr/bin::/bin', { node: '/usr/bin/node' }))
    expect(v.verdict).toBe('SAME')
    expect(probe.pathEntries('/a::/b:/a:')).toEqual(['/a', '/b'])
  })

  it('DIFFERS on an entry only one side has, on another order, and on a lookup that differs', () => {
    expect(probe.p6Verdict(side('/usr/bin'), side('~/.local/bin:/usr/bin'))).toMatchObject({ verdict: 'DIFFERS', why: expect.stringContaining('only in the login PATH: ~/.local/bin') })
    expect(probe.p6Verdict(side('/usr/bin:/bin'), side('/bin:/usr/bin')).why).toContain('another order')
    expect(probe.p6Verdict(side('/usr/bin'), side('/usr/bin', { claude: '~/.local/bin/claude' })).why).toContain('claude: exec finds nothing, login finds ~/.local/bin/claude')
  })

  it('CANNOT MEASURE when either PATH was not read', () => {
    expect(probe.p6Verdict(side('/usr/bin'), null).verdict).toBe('CANNOT MEASURE')
    expect(probe.p6Verdict(null, side('/usr/bin')).verdict).toBe('CANNOT MEASURE')
  })
})

describe('probe P3/P6: reading and recording', () => {
  it('reads only the marked lines between the markers, with or without carriage returns', () => {
    expect(probe.parseMarked('motd\r\n@@begin\r\n@@uid 1000\r\nnoise\r\n@@run a alive\r\n@@run b gone\r\n@@empty\r\n@@end\r\n@@uid 0\r\n')).toEqual({ uid: '1000', run: ['a alive', 'b gone'], empty: '' })
    expect(probe.parseMarked('@@begin\n@@uid 1000\n')).toBeNull()
  })

  it('writes the home folder as ~ and the user name as <user>, only where it is the whole name', () => {
    expect(probe.redact('/home/pi/.local/bin:/usr/bin/pipe', '/home/pi', 'pi')).toBe('~/.local/bin:/usr/bin/pipe')
    expect(probe.redact('user-1000.slice owner pi; pi', '/home/pi', 'pi')).toBe('user-1000.slice owner <user>; <user>')
    expect(probe.redact('spi pi.local pi-2', '/home/pi', 'pi')).toBe('spi pi.local pi-2')
  })

  it('names why a connection failed: host off, a refused key, or an unknown host key', () => {
    expect(probe.classifyFailure({ status: null, timedOut: true })).toMatch(/^host off/)
    expect(probe.classifyFailure({ status: 255, stderr: 'ssh: connect to host 192.0.2.10 port 22: Connection timed out' })).toBe('host off')
    expect(probe.classifyFailure({ status: 255, stderr: 'you@192.0.2.10: Permission denied (publickey,password).' })).toBe('key sign-in refused')
    expect(probe.classifyFailure({ status: 255, stderr: 'Host key verification failed.' })).toMatch(/host key/)
    expect(probe.classifyFailure({ status: 1, stderr: '' })).toBe('failed (exit 1)')
  })
})

describe('probe P3/P6: the host is left as found', () => {
  const dir = '/tmp/aicc-p3p6.AbCd1234'

  it('works only in a folder it made, and on sockets named the helper way', () => {
    expect(probe.isProbeDir(dir)).toBe(true)
    for (const bad of ['/tmp', '/tmp/aicc-p3p6.AbCd1234/..', '/tmp/aicc-p3p6.Ab d1234', "/tmp/aicc-p3p6.AbCd123'", '/home/x', 'tmp/aicc-p3p6.AbCd1234']) expect(probe.isProbeDir(bad), bad).toBe(false)
    expect(probe.isEndpoint('/tmp/aicc-1000/p3-tty-1-0123456789abcdef.sock', '1000', 'p3-tty-1')).toBe(true)
    for (const bad of ['/tmp/aicc-1000/p3-tty-2-0123456789abcdef.sock', '/tmp/aicc-1001/p3-tty-1-0123456789abcdef.sock', '/tmp/aicc-1000/../p3-tty-1-0123456789abcdef.sock', '/tmp/aicc-1000/p3-tty-1-0123456789abcdeg.sock']) expect(probe.isEndpoint(bad, '1000', 'p3-tty-1'), bad).toBe(false)
  })

  it('a holder is told apart by its own command line, never by its pid alone', () => {
    expect(probe.holdCommand(dir, 'p3-tty-1')).toBe(`${dir}/aicc-helper hold --store ${dir}/store --session p3-tty-1 --away 300 --detach`)
    expect(probe.checkScript(dir, [{ pid: 4242, sid: 'p3-tty-1' }])).toContain('grep -qF -- "--store $d/store --session $s "')
    const clean = probe.cleanScript(dir, [{ pid: 4242, sid: 'p3-tty-1' }], [], '1000', 'present')
    for (const kill of clean.split('\n').filter((l) => /\bkill\b/.test(l))) expect(kill.trim(), kill).toMatch(/^own "\$p" "\$s" && kill -(TERM|KILL) "\$p"/)
  })

  it('deletes each thing by name, never recursively, and the socket folder only when it was not there before', () => {
    const clean = probe.cleanScript(dir, [{ pid: 4242, sid: 'p3-tty-1' }], ['/tmp/aicc-1000/p3-tty-1-0123456789abcdef.sock'], '1000', 'absent')
    expect(clean).not.toMatch(/rm\s+-[a-zA-Z]*[rR]|--recursive|find\s/)
    for (const rm of clean.split('\n').filter((l) => /\brm\b/.test(l))) expect(rm, rm).toMatch(/rm -f -- /)
    expect(clean).toContain('rm -f -- "${d:?}/aicc-helper" "${d:?}/store/.lock" "${d:?}/store/"*.json')
    expect(clean).toContain('rmdir -- /tmp/aicc-1000 2>/dev/null')
    expect(probe.cleanScript(dir, [], [], '1000', 'present')).not.toMatch(/rmdir -- \/tmp\/aicc-1000/)
    expect(clean).toMatch(/@@left \$\(pgrep -f -- "\$d\/" \| wc -l\)/)
  })
})
