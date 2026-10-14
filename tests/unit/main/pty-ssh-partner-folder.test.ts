// #86: the partner shell of an SSH session opens in the config's remote folder.
//
// The partner is a plain connection (shell-only, no post-connect command, no
// persistence), so the session's setup line and its `cd` never run for it.
// Once it reaches its first shell prompt (zsh's `%` included, on a window of
// any width), the SSH flow types one line, `cd -- <folder>`, and only then:
// never for a terminal-only
// SSH session (unchanged: it opens at home), never for home itself, a Windows
// host or a folder the session's own `cd` would refuse, never into a waiting
// sign-in prompt (a password, a verification code, a key passphrase) whatever
// character it ends in, split across reads or with its words on the line
// above, never when the idle fallback, not a prompt match, carries the
// partner to its shell, and never once the user has typed into the partner.
// The real spawnPty SSH branch and the real Claude provider; node-pty and
// Electron faked; nothing is dialled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))
const h = vi.hoisted(() => ({ dataCbs: [] as Array<(d: string) => void>, writes: [] as string[] }))
vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 5353, process: 'ssh',
    onData: (cb: (d: string) => void) => { h.dataCbs.push(cb); return { dispose: () => {} } },
    onExit: () => ({ dispose: () => {} }),
    write: (d: string) => { h.writes.push(String(d)) }, resize: () => {}, kill: () => {},
  }),
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({ getWatchdogManager: () => null }))

const { spawnPty, getSshFlow, killPty, writePty } = await import('../../../src/main/pty-manager')
const { registerProvider } = await import('../../../src/main/providers')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')
const { partnerFolderLine, partnerPromptTail, isPartnerShellPrompt, partnerRecentOutput, partnerRecentText, isPartnerUserInput } = await import('../../../src/main/ssh-partner-folder')
registerProvider(new ClaudeProvider())

const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false } as never
/** The partner's block as main binds it: the saved host, plain (no post-connect command, persistence off). */
const PLAIN = { username: 'dev', host: 'box.example.com', port: 2222, detachable: false }
const feed = (d: string): void => { for (const cb of h.dataCbs) cb(d) }
const cdWrites = (): string[] => h.writes.filter((w) => w.includes('cd --'))
/** What zsh prints before each prompt by default (PROMPT_SP): its end-of-line
 *  mark, a bold reverse `%`, then a window width of spaces less one, then
 *  `\r \r`, with no line break, so the prompt that follows shares its line. */
const zshFiller = (cols: number): string => '\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m' + ' '.repeat(cols - 1) + '\r \r'
let seq = 0
let BASE = ''
let SID = ''

beforeEach(() => {
  vi.useFakeTimers()
  BASE = `sshpfold${String(++seq).padStart(16, '0')}`
  SID = ''
  h.dataCbs = []; h.writes = []
})
afterEach(() => {
  try { if (SID) killPty(SID) } catch { /* gone */ }
  vi.useRealTimers()
})

/** Start a shell-only SSH spawn under `id` and bring it to its first prompt. */
const toPrompt = (id: string, ssh: Record<string, unknown>, prompt = 'dev@box:~$ '): void => {
  SID = id
  spawnPty(fakeWin, id, { ssh, shellOnly: true } as never)
  feed(`Welcome to box\r\n${prompt}`)
}

describe('the partner shell of an SSH session', () => {
  // Mutation to prove this can fail: partnerFolderLine returns null for every
  // session (the code before this change: the partner opened at home).
  it('opens in the config\'s remote folder: one cd line at its first prompt', () => {
    toPrompt(`${BASE}-partner`, { ...PLAIN, remotePath: '/srv/app' })
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(cdWrites()).toEqual(['cd -- /srv/app\r'])
    feed('\r\ndev@box:/srv/app$ ')
    vi.advanceTimersByTime(3000)
    expect(cdWrites()).toHaveLength(1) // once only
  })

  it('a folder under home keeps its ~ for the remote shell to expand', () => {
    toPrompt(`${BASE}-partner`, { ...PLAIN, remotePath: '~/proj' })
    expect(cdWrites()).toEqual(['cd -- ~/proj\r'])
  })

  it('home itself, or no folder: nothing is typed', () => {
    for (const remotePath of ['~', '~/', '']) {
      BASE = `sshpfold${String(++seq).padStart(16, '0')}`
      h.dataCbs = []; h.writes = []
      toPrompt(`${BASE}-partner`, { ...PLAIN, remotePath })
      expect(cdWrites(), JSON.stringify(remotePath)).toEqual([])
      killPty(SID)
    }
  })

  it('a Windows host: nothing is typed (the line is POSIX sh)', () => {
    toPrompt(`${BASE}-partner`, { ...PLAIN, remotePath: '/srv/app', remoteOs: 'windows' }, 'C:\\Users\\dev>')
    expect(cdWrites()).toEqual([])
  })

  it('a folder the session\'s own cd would refuse: nothing is typed', () => {
    for (const remotePath of ['/srv/a b', '/srv/a;b', '/srv/a|b', '/srv/a\nb']) {
      expect(partnerFolderLine(`${BASE}-partner`, { shellOnly: true }, { remotePath }), JSON.stringify(remotePath)).toBeNull()
    }
    toPrompt(`${BASE}-partner`, { ...PLAIN, remotePath: '/srv/a;b' })
    expect(cdWrites()).toEqual([])
  })

  // The partner's folder check is written out in ssh-partner-folder.ts (a
  // shared module may not import the Claude package: dependency-boundaries
  // R2, R4), so it is held here to the session's own check, character by
  // character and on whole paths. Mutation to prove this can fail: let the
  // partner's check accept a space.
  it('accepts exactly the folders the session\'s own cd accepts', async () => {
    const { assertSafeRemotePath } = await import('../../../src/main/providers/claude/ssh-shim')
    const sessionAccepts = (p: string): boolean => { try { assertSafeRemotePath(p); return true } catch { return false } }
    const partnerAccepts = (p: string): boolean => partnerFolderLine(`${BASE}-partner`, { shellOnly: true }, { remotePath: p }) !== null
    const samples: string[] = []
    for (let c = 0; c < 0x250; c++) samples.push(`/srv/a${String.fromCharCode(c)}b`)
    samples.push('/srv/app', '~/work', '-rf', '../up', '/srv/a\n', '/srv/a\r\n', 'srv/a b', '/srv/$HOME', '/srv/`id`', '/srv/aé', '~user/x')
    let accepted = 0
    for (const p of samples) {
      expect(partnerAccepts(p), JSON.stringify(p)).toBe(sessionAccepts(p))
      if (partnerAccepts(p)) { accepted++; expect(partnerFolderLine(`${BASE}-partner`, { shellOnly: true }, { remotePath: p })).toBe(`cd -- ${p}\r`) }
    }
    expect(accepted).toBeGreaterThan(60)
  })

  it('never into a waiting password prompt, even when the idle fallback gives up holding for it', () => {
    SID = `${BASE}-partner`
    spawnPty(fakeWin, SID, { ssh: { ...PLAIN, remotePath: '/srv/app' }, shellOnly: true } as never)
    feed("dev@box.example.com's password: ")
    vi.advanceTimersByTime(20_000) // past the bounded auth hold (~13.5 s)
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(cdWrites()).toEqual([])
  })

  // Mutation to prove this can fail: the partner's guard is the session's own
  // shell-prompt pattern, which has no `%` (the code before this change:
  // on a zsh host, macOS's default, the partner opened at home).
  it('a zsh host, whose default prompt ends in %: the cd line is typed', () => {
    toPrompt(`${BASE}-partner`, { ...PLAIN, remotePath: '/srv/app' }, 'nick@mac ~ % ')
    // The session's prompt pattern does not know `%`; the partner's own
    // prompt match, which does, carries it to its shell.
    vi.advanceTimersByTime(2000)
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(cdWrites()).toEqual(['cd -- /srv/app\r'])
  })

  // Mutation to prove this can fail: the guard reads the session's own sticky
  // prompt line (the code before this change), which drops a line of 200
  // characters or more, so on a window about 185 columns or wider zsh's filler
  // and the prompt after it were never seen and the partner opened at home.
  it('a zsh host on a wide window (the filler zsh prints before its prompt): the cd line is typed', () => {
    for (const cols of [80, 220]) {
      BASE = `sshpfold${String(++seq).padStart(16, '0')}`
      h.dataCbs = []; h.writes = []
      SID = `${BASE}-partner`
      spawnPty(fakeWin, SID, { ssh: { ...PLAIN, remotePath: '/srv/app' }, shellOnly: true } as never)
      feed('Last login: Sat Oct 11 08:00:00 2026 from 10.0.0.2\r\n' + zshFiller(cols) + '\x1b]2;nick@mac:~\x07nick@mac ~ % ')
      vi.advanceTimersByTime(2000)
      expect(getSshFlow(SID)!.getState().state, `${cols} columns`).toBe('shell-only')
      expect(cdWrites(), `${cols} columns`).toEqual(['cd -- /srv/app\r'])
      killPty(SID)
    }
  })

  // Mutation to prove this can fail: as above. The session's sticky line is
  // still the password prompt it answered, so its reading also kept the
  // partner at home after a saved password on a wide window.
  it('a saved password, then a zsh prompt on a wide window: the cd line is typed', () => {
    SID = `${BASE}-partner`
    spawnPty(fakeWin, SID, { ssh: { ...PLAIN, remotePath: '/srv/app', password: 'pw-for-test' }, shellOnly: true } as never)
    feed("dev@box.example.com's password: ")
    vi.advanceTimersByTime(200)
    expect(h.writes).toContain('pw-for-test\r')
    feed('\r\nLast login: Sat Oct 11 08:00:00 2026\r\n' + zshFiller(220) + 'nick@mac ~ % ')
    vi.advanceTimersByTime(20_000) // the session's own auth hold may wait up to ~13.5 s
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(cdWrites()).toEqual(['cd -- /srv/app\r'])
  })

  // A guard that holds before and after the change. Mutation to prove this can
  // fail: drop both checks (type the line at any arrival in the shell).
  it('a macOS password prompt: nothing is typed', () => {
    SID = `${BASE}-partner`
    spawnPty(fakeWin, SID, { ssh: { ...PLAIN, remotePath: '/srv/app' }, shellOnly: true } as never)
    feed('(nick@mac) Password:')
    vi.advanceTimersByTime(20_000) // past the bounded auth hold (~13.5 s)
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(cdWrites()).toEqual([])
  })

  // Refused by both checks: its shape (it ends in `:`) and its words.
  it('a verification-code prompt: nothing is typed', () => {
    SID = `${BASE}-partner`
    spawnPty(fakeWin, SID, { ssh: { ...PLAIN, remotePath: '/srv/app' }, shellOnly: true } as never)
    feed('Verification code: ')
    vi.advanceTimersByTime(2000) // not an auth prompt the fallback holds for
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(cdWrites()).toEqual([])
  })

  // Pins the prompt-shape check on its own: this prompt names no sign-in word.
  // Mutation to prove this can fail: drop the prompt-shape check and keep only
  // the sign-in word check.
  it('a prompt that is not a shell prompt and names no sign-in word (a menu ending in :): nothing is typed', () => {
    SID = `${BASE}-partner`
    spawnPty(fakeWin, SID, { ssh: { ...PLAIN, remotePath: '/srv/app' }, shellOnly: true } as never)
    feed('Select target host [1-3]: ')
    vi.advanceTimersByTime(2000)
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(cdWrites()).toEqual([])
  })

  // The guard's password check could never match
  // a prompt the shape check let through (one needs `:` or `?` last, the other
  // `$ # > ~ %`), so a sign-in prompt ending in one of those got the cd line:
  // one failed password or code attempt, which counts toward a lockout.
  // Mutation to prove this can fail: drop the sign-in word check (the beta.2
  // guard, whose password conjunct was dead).
  it('a sign-in, verification or passphrase prompt that ends like a shell prompt: nothing is typed', () => {
    const prompts = [
      'Enter OTP> ',
      'Enter password > ',
      'Password $ ',
      'Verification code> ',
      "Enter passphrase for key '/home/dev/.ssh/id_ed25519'> ",
      'Passcode or option (1-3)> ',
      'Enter PIN# ',
      'Token % ',
      'One-time code ~ ',
      'Enter your 2FA code> ',
      'MFA token> ',
      'Authenticator app code > ',
    ]
    for (const prompt of prompts) {
      BASE = `sshpfold${String(++seq).padStart(16, '0')}`
      h.dataCbs = []; h.writes = []
      SID = `${BASE}-partner`
      spawnPty(fakeWin, SID, { ssh: { ...PLAIN, remotePath: '/srv/app' }, shellOnly: true } as never)
      feed(`Welcome to box\r\n${prompt}`)
      vi.advanceTimersByTime(20_000) // past any auth hold, so the guard is reached
      expect(getSshFlow(SID)!.getState().state, prompt).toBe('shell-only')
      expect(cdWrites(), prompt).toEqual([])
      killPty(SID)
    }
  })

  /** A fresh partner spawn fed `reads` one by one, then 20 s of quiet (past
   *  any auth hold and the idle fallback): its flow state and its cd lines. */
  const runPartner = (reads: string[], extra: Record<string, unknown> = {}): { state: string; cd: string[] } => {
    BASE = `sshpfold${String(++seq).padStart(16, '0')}`
    h.dataCbs = []; h.writes = []
    SID = `${BASE}-partner`
    spawnPty(fakeWin, SID, { ssh: { ...PLAIN, remotePath: '/srv/app', ...extra }, shellOnly: true } as never)
    for (const r of reads) feed(r)
    vi.advanceTimersByTime(20_000)
    const out = { state: getSshFlow(SID)!.getState().state, cd: cdWrites() }
    killPty(SID)
    return out
  }

  // The sign-in check reads more than the prompt reading of one read (the text
  // after its last line break). A real SSH link splits a prompt across reads
  // (#242), and then that reading is "word>" or "TP>", with no sign-in word in
  // it. Mutation to prove this can fail: check the sign-in words on this
  // read's prompt reading only (isPartnerShellPrompt(tail) with no recent
  // output).
  it('a sign-in prompt split across two reads: nothing is typed', () => {
    const pairs: Array<[string, string]> = [
      ['Welcome\r\nEnter pass', 'word> '],
      ['Welcome\r\nEnter O', 'TP> '],
      ['Welcome\r\nPass', 'code> '],
      ['Welcome\r\nEnter your to', 'ken> '],
    ]
    for (const [a, b] of pairs) {
      const out = runPartner([a, b])
      expect(out.state, `${a}|${b}`).toBe('shell-only')
      expect(out.cd, `${a}|${b}`).toEqual([])
    }
  })

  // A sign-in prompt whose words sit on the line
  // above a bare prompt. Mutation to prove this can fail: as above (the
  // reading is only the bare sigil).
  it('sign-in words on the line above a bare prompt: nothing is typed', () => {
    for (const prompt of [
      'Enter your one-time password\r\n> ',
      'Please enter your OTP code:\r\n> ',
      'Password\r\n$ ',
      'MFA token required\r\n# ',
    ]) {
      const out = runPartner([`Welcome to box\r\n${prompt}`])
      expect(out.state, prompt).toBe('shell-only')
      expect(out.cd, prompt).toEqual([])
    }
  })

  // The line is typed only when the partner reached its shell by a prompt
  // match, never by the idle fallback. These prompts end in %, which the
  // session's own prompt pattern does not know, so the idle fallback can carry
  // the partner to its shell over them (the reading, '%' or 'word %', names no
  // sign-in word). Mutation to prove this can fail: type the line when the
  // idle fallback reaches the shell and the last reading is a shell prompt
  // without the recent-output check.
  it('a sign-in prompt the partner reaches only through the idle fallback: nothing is typed', () => {
    for (const reads of [
      ['Welcome to box\r\nPlease enter your OTP code:\r\n% '],
      ['Welcome to box\r\nEnter pass', 'word % '],
    ]) {
      const out = runPartner(reads)
      expect(out.state, reads.join('|')).toBe('shell-only')
      expect(out.cd, reads.join('|')).toEqual([])
    }
  })

  // The idle fallback reaching the shell before any prompt shows (a slow
  // host) types nothing, and the prompt that follows gets nothing either:
  // the line is considered once, so it never lands after something the user
  // already ran. A guard that holds before and after the change.
  it('the idle fallback reaches the shell before any prompt: nothing is typed, then or at the prompt that follows', () => {
    SID = `${BASE}-partner`
    spawnPty(fakeWin, SID, { ssh: { ...PLAIN, remotePath: '/srv/app' }, shellOnly: true } as never)
    feed('Welcome to box\r\n')
    vi.advanceTimersByTime(2000)
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(cdWrites()).toEqual([])
    feed('dev@box:~$ ')
    vi.advanceTimersByTime(2000)
    expect(cdWrites()).toEqual([])
  })

  // The partner's own prompt match, not the idle fallback, carries it to its
  // shell, so a zsh prompt gets the line as it shows, not 1.5 s later.
  // Mutation to prove this can fail: drop the partner's prompt match from the
  // first-prompt step (only the session's pattern, which has no %, moves the
  // flow there).
  it('a zsh prompt: the cd line is typed as the prompt shows, without waiting for the idle fallback', () => {
    toPrompt(`${BASE}-partner`, { ...PLAIN, remotePath: '/srv/app' }, 'nick@mac ~ % ')
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(cdWrites()).toEqual(['cd -- /srv/app\r'])
  })

  // The password prompt the flow answers itself does not count as the line
  // above the shell prompt. Mutation to prove this can fail: keep the
  // partner's recent output across the saved password (a host that prints
  // nothing between the sign-in and its prompt then opens at home).
  it('a saved password, then a shell prompt right below it: the cd line is typed', () => {
    const out = runPartner(["dev@box.example.com's password: ", '\r\ndev@box:~$ '], { password: 'pw-for-test' })
    expect(out.state).toBe('shell-only')
    expect(out.cd).toEqual(['cd -- /srv/app\r'])
  })

  // A % counts as a prompt only as zsh draws it: alone, or after a space. A
  // read that ends in a percentage (a sign-in banner with no final line break,
  // or a read cut right after the figure) is no prompt match, so the flow
  // stays in connecting and the saved password is typed at the password
  // prompt that follows. Mutation to prove this can fail: let any trailing %
  // count as a prompt (the flow reaches its shell on the banner read, the
  // saved password is never typed, and the cd line goes in ahead of the
  // password prompt).
  it('a sign-in banner read that ends in a percentage: the saved password is typed, then the cd line at the zsh prompt', () => {
    for (const banner of ['Authorized use only. Sessions logged 100%', 'Welcome to box\r\nChecking host keys 10%']) {
      BASE = `sshpfold${String(++seq).padStart(16, '0')}`
      h.dataCbs = []; h.writes = []
      SID = `${BASE}-partner`
      spawnPty(fakeWin, SID, { ssh: { ...PLAIN, remotePath: '/srv/app', password: 'pw-for-test' }, shellOnly: true } as never)
      feed(banner)
      vi.advanceTimersByTime(300)
      expect(getSshFlow(SID)!.getState().state, banner).toBe('connecting')
      expect(h.writes, banner).toEqual([])
      feed("\r\ndev@box.example.com's password: ")
      vi.advanceTimersByTime(200)
      expect(h.writes, banner).toEqual(['pw-for-test\r'])
      feed('\r\nLast login: Sat Oct 11 08:00:00 2026\r\nnick@mac ~ % ')
      expect(getSshFlow(SID)!.getState().state, banner).toBe('shell-only')
      expect(h.writes, banner).toEqual(['pw-for-test\r', 'cd -- /srv/app\r'])
      killPty(SID)
    }
  })

  // Skip hands the partner to the user during connect. From then on only the
  // session's own prompt pattern moves it to its shell; the partner's own
  // prompt match counts only from connecting. So output that ends in a
  // percentage, with or without a space before it (some locales print
  // "45 %"), never types the line into a command the user is running.
  // Mutation to prove this can fail: take the
  // partner's prompt match from skipped too (the read ending " %"; with any
  // trailing % counted as a prompt as well, already the first progress read).
  it('a partner the user took over with Skip: progress output that ends in % gets nothing', () => {
    SID = `${BASE}-partner`
    spawnPty(fakeWin, SID, { ssh: { ...PLAIN, remotePath: '/srv/app' }, shellOnly: true } as never)
    getSshFlow(SID)!.skip()
    expect(getSshFlow(SID)!.getState().state).toBe('skipped')
    feed('Welcome\r\n' + String.fromCodePoint(0x276f) + ' ')
    for (const read of ['apt update\r\nReading package lists... 45%', '\r', '\r\nLecture des listes de paquets... 45 %', '\rCopying files 100 % ']) {
      feed(read)
      vi.advanceTimersByTime(300)
      expect(getSshFlow(SID)!.getState().state, JSON.stringify(read)).toBe('skipped')
    }
    vi.advanceTimersByTime(20_000)
    expect(getSshFlow(SID)!.getState().state).toBe('skipped')
    expect(h.writes).toEqual([])
  })

  // The password prompt the flow answers itself is not read for sign-in words
  // (it would keep a host that prints nothing before its prompt at home), so
  // right after it a prompt must be more than a bare sigil: a second sign-in
  // step that names its words only before the password prompt and then waits
  // at a bare "> " is refused, and that partner opens at home. Mutation to
  // prove this can fail: drop the bare-prompt check after the saved password.
  it('a saved password, then a bare prompt right below it (a second sign-in step): nothing is typed', () => {
    for (const bare of ['> ', '$ ', '# ', '% ', '>> ']) {
      const out = runPartner(['This host asks for your password, then your one-time password.\r\nPassword: ', `\r\n${bare}`], { password: 'pw-for-test' })
      expect(out.state, bare).toBe('shell-only')
      expect(out.cd, bare).toEqual([])
    }
    // A prompt that shows its folder, even only ~, is more than a bare sigil.
    // Mutation to prove this can fail: count ~ as a bare sigil.
    const folderOnly = runPartner(["dev@box.example.com's password: ", '\r\n~ $ '], { password: 'pw-for-test' })
    expect(folderOnly.cd).toEqual(['cd -- /srv/app\r'])
    // Only after the password the flow typed itself: a bare prompt with no
    // sign-in word near it, on a host with no saved password (sh's own "$ "),
    // still gets the line. Mutation to prove this can fail: refuse a bare
    // prompt whether or not the flow typed the password.
    const noSaved = runPartner(['Last login: Sat Oct 11 08:00:00 2026\r\n$ '])
    expect(noSaved.cd).toEqual(['cd -- /srv/app\r'])
    // A saved password the flow never typed (the host signed in by key, so
    // no password prompt came) leaves a bare prompt a match too. Mutation to
    // prove this can fail: refuse a bare prompt whenever a password is saved.
    const keyAuth = runPartner(['Last login: Sat Oct 11 08:00:00 2026\r\n$ '], { password: 'pw-for-test' })
    expect(keyAuth.state).toBe('shell-only')
    expect(keyAuth.cd).toEqual(['cd -- /srv/app\r'])
  })

  // The recent output is the prompt's line and the one above it, no more.
  // Accepted: a sign-in word on the line just above a real shell prompt (a
  // notice that a password expires soon) keeps the partner at home too.
  it('only the prompt\'s line and the line above it are read for sign-in words', () => {
    const twoUp = runPartner(['Your password will expire in 5 days\r\nLast login: Sat Oct 11 08:00:00 2026\r\ndev@box:~$ '])
    expect(twoUp.cd).toEqual(['cd -- /srv/app\r'])
    const oneUp = runPartner(['Last login: Sat Oct 11 08:00:00 2026\r\nYour password will expire in 5 days\r\ndev@box:~$ '])
    expect(oneUp.state).toBe('shell-only')
    expect(oneUp.cd).toEqual([])
  })
})

// The folder line is typed into the partner's input, so it must never land on a
// line the user is typing. A key's echo can end in $ # > ~ (or a % after a
// space) and read as a prompt, and the partner can still be connecting while
// the user types: a prompt the app does not recognise keeps it there for 1.5 s
// after each read, a waiting password prompt for up to about 13.5 s. A line
// joined to the user's command runs with it ("rm -rf ~cd -- /srv/app"). So the
// user's first key into the partner gives the line up, and that partner stays
// where the user is. Each key goes through the real writePty, then its echo
// is fed back.
describe('the partner never types its folder line after the user has typed into it', () => {
  const ARROW_PROMPT = String.fromCodePoint(0x276f) + ' '
  /** A fresh partner spawn under `extra` (a saved password and so on). */
  const startPartner = (extra: Record<string, unknown> = {}): void => {
    BASE = `sshpfold${String(++seq).padStart(16, '0')}`
    h.dataCbs = []; h.writes = []
    SID = `${BASE}-partner`
    spawnPty(fakeWin, SID, { ssh: { ...PLAIN, remotePath: '/srv/app', ...extra }, shellOnly: true } as never)
  }
  /** The user types `line` one key at a time, `gapMs` apart; the remote shell
   *  echoes each key back as its own read. */
  const typeLine = (line: string, gapMs = 150): void => {
    for (const key of line) {
      writePty(SID, key)
      feed(key)
      vi.advanceTimersByTime(gapMs)
    }
  }
  /** Through a saved password the flow types itself, to a shell prompt. */
  const signInWithSavedPassword = (prompt: string): void => {
    startPartner({ password: 'pw-for-test' })
    feed("dev@box.example.com's password: ")
    vi.advanceTimersByTime(200)
    expect(h.writes).toEqual(['pw-for-test\r'])
    feed(`\r\nLast login: Sat Oct 11 08:00:00 2026 from 10.0.0.2\r\n${prompt}`)
  }

  // Mutation to prove this can fail: writePty does not tell the SSH flow about
  // the user's input (the folder line is typed at the echo of the first ~ or $).
  it('a prompt the app does not recognise (an arrow theme), then a typed line whose echoes come under 1.5 s apart: the app types nothing', () => {
    for (const [line, gapMs] of [['rm -rf ~/x', 150], ['git checkout $B', 150], ['git checkout $B', 300], ['rm -rf $B/x', 150]] as Array<[string, number]>) {
      startPartner()
      feed(`Welcome to box\r\n${ARROW_PROMPT}`)
      vi.advanceTimersByTime(1000)
      expect(getSshFlow(SID)!.getState().state, line).toBe('connecting')
      typeLine(line, gapMs)
      vi.advanceTimersByTime(20_000)
      expect(h.writes.join(''), line).toBe(line)
      expect(cdWrites(), line).toEqual([])
      expect(getSshFlow(SID)!.getState().state, line).toBe('shell-only')
      killPty(SID)
    }
  })

  // Mutation to prove this can fail: as above. Here the password prompt the
  // flow answered is still the last line the session could read (the arrow
  // prompt reads as ''), so the flow holds in connecting for up to ~13.5 s.
  it('a saved password, then a prompt the app does not recognise and an 8 s hold, then a typed line: only the password is typed by the app', () => {
    for (const line of ['cd ~/proj', 'rm -rf ~/x']) {
      signInWithSavedPassword(ARROW_PROMPT)
      vi.advanceTimersByTime(8000)
      expect(getSshFlow(SID)!.getState().state, line).toBe('connecting')
      typeLine(line)
      vi.advanceTimersByTime(20_000)
      expect(h.writes, line).toEqual(['pw-for-test\r', ...line])
      expect(getSshFlow(SID)!.getState().state, line).toBe('shell-only')
      killPty(SID)
    }
  })

  // The bare-prompt rule after a saved password (PARTNER_BARE_PROMPT_RE) is the
  // only thing refusing these prompts, and the session's own prompt pattern
  // cannot read them (an escape it stops at, zsh's %, a line of 200 characters
  // or more), so the flow stays in connecting. Such a host opens its partner
  // at home: no later key brings the line. Mutation to prove this can fail: as
  // above (the line was typed at the echo of the first ~).
  it('after a saved password, a bare last prompt line the session cannot read, then typed keys: no folder line, now or later', () => {
    // A two-line prompt whose last line is a bare $ after tput sgr0's glue.
    signInWithSavedPassword('\x1b[32mdev@box ~\r\n\x1b(B\x1b[m$ ')
    vi.advanceTimersByTime(2000)
    expect(getSshFlow(SID)!.getState().state).toBe('connecting')
    typeLine('rm -rf ~/x')
    vi.advanceTimersByTime(20_000)
    expect(h.writes).toEqual(['pw-for-test\r', ...'rm -rf ~/x'])
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    killPty(SID)
    // zsh's bare "% ", typing within 1 s.
    signInWithSavedPassword('% ')
    vi.advanceTimersByTime(500)
    typeLine('rm -rf ~/x')
    vi.advanceTimersByTime(20_000)
    expect(h.writes).toEqual(['pw-for-test\r', ...'rm -rf ~/x'])
    killPty(SID)
    // zsh's bare "% " after its filler on a wide window, typing 8 s later.
    signInWithSavedPassword(zshFiller(220) + '% ')
    vi.advanceTimersByTime(8000)
    expect(getSshFlow(SID)!.getState().state).toBe('connecting')
    typeLine('rm -rf ~/x')
    vi.advanceTimersByTime(20_000)
    expect(h.writes).toEqual(['pw-for-test\r', ...'rm -rf ~/x'])
    killPty(SID)
    // With no typing at all, the same hosts reach the shell with nothing typed.
    for (const prompt of ['\x1b[32mdev@box ~\r\n\x1b(B\x1b[m$ ', '% ', zshFiller(220) + '% ']) {
      signInWithSavedPassword(prompt)
      vi.advanceTimersByTime(20_000)
      expect(getSshFlow(SID)!.getState().state, JSON.stringify(prompt)).toBe('shell-only')
      expect(h.writes, JSON.stringify(prompt)).toEqual(['pw-for-test\r'])
      killPty(SID)
    }
  })

  // Keys typed while the partner connects are already in the remote input
  // when its first prompt shows. Mutation to prove this can fail: as above
  // (the line follows them: "lscd -- /srv/app").
  it('keys typed ahead of the first prompt: the prompt that follows gets no folder line', () => {
    startPartner()
    feed('Welcome to box\r\n')
    writePty(SID, 'l')
    writePty(SID, 's')
    feed('dev@box:~$ ')
    vi.advanceTimersByTime(20_000)
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(h.writes).toEqual(['l', 's'])
  })

  // An arrow key is input too: Up recalls a history line, and the redraw can
  // end in ~ or $. Mutation to prove this can fail: count only writes that
  // hold no escape sequence as the user's input.
  it('an arrow key at a prompt the app does not recognise (a history line recalled): no folder line', () => {
    startPartner()
    feed(`Welcome to box\r\n${ARROW_PROMPT}`)
    vi.advanceTimersByTime(500)
    writePty(SID, '\x1b[A')
    feed(`\r\x1b[K${ARROW_PROMPT}rm -rf ~`)
    vi.advanceTimersByTime(20_000)
    expect(h.writes).toEqual(['\x1b[A'])
  })

  // After Skip the user drives the partner, and a command they typed gives the
  // line up: the prompt after its output gets nothing. Mutation to prove this
  // can fail: take the user's input into account only while connecting.
  it('a partner the user took over with Skip, then a command they typed: no folder line after its output', () => {
    startPartner()
    getSshFlow(SID)!.skip()
    feed(`Welcome to box\r\n${ARROW_PROMPT}`)
    typeLine('ls\r')
    feed('\r\nnotes.txt\r\ndev@box:~$ ')
    vi.advanceTimersByTime(20_000)
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(h.writes).toEqual(['l', 's', '\r'])
  })

  // Accepted, recorded so that a change here is deliberate: a password typed by
  // hand is input too, so that partner opens at home even at a prompt the app
  // recognises. Mutation to prove this can fail: as above.
  it('a password typed by hand: the partner opens at home, also at a recognised prompt', () => {
    startPartner()
    feed("dev@box.example.com's password: ")
    writePty(SID, 'hunter2\r')
    feed('\r\nLast login: Sat Oct 11 08:00:00 2026\r\ndev@box:~$ ')
    vi.advanceTimersByTime(20_000)
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(h.writes).toEqual(['hunter2\r'])
  })

  // Only the folder line is given up: a key typed before the password prompt
  // leaves the saved password to be typed at it, as before. Mutation to prove
  // this can fail: let the user's input also stop the password auto-type.
  it('a key typed before the password prompt: the saved password is still typed, and no folder line follows', () => {
    startPartner({ password: 'pw-for-test' })
    feed('Authorized use only\r\n')
    writePty(SID, 'x')
    feed("dev@box.example.com's password: ")
    vi.advanceTimersByTime(200)
    expect(h.writes).toEqual(['x', 'pw-for-test\r'])
    feed('\r\nLast login: Sat Oct 11 08:00:00 2026\r\ndev@box:~$ ')
    vi.advanceTimersByTime(20_000)
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(h.writes).toEqual(['x', 'pw-for-test\r'])
  })

  // The terminal's own answers to the remote (device attributes, status,
  // cursor position, mode, window size, colour, version) and its focus
  // reports go through the same input path as keys. They are not the user
  // typing: the line is still typed once at a recognised prompt. Mutation to
  // prove this can fail: count every write as the user's input.
  it('the terminal\'s own replies to the remote before the prompt: the cd line is still typed, once', () => {
    const replies = [
      '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[24;80R', '\x1b[?24;80;1R', '\x1b[?2004;1$y', '\x1b[8;24;80t',
      '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\', '\x1b]10;rgb:cdcd/d6d6/f4f4\x07', '\x1b]4;1;rgb:f3f3/8b8b/a8a8\x07',
      '\x1bP>|xterm.js(5.5.0)\x1b\\', '\x1b[I', '\x1b[O', '\x1b[?1;2c\x1b[24;80R',
    ]
    startPartner()
    feed('Welcome to box\r\n')
    for (const r of replies) writePty(SID, r)
    feed('dev@box:~$ ')
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(cdWrites()).toEqual(['cd -- /srv/app\r'])
    typeLine('ls')
    vi.advanceTimersByTime(20_000)
    expect(cdWrites()).toHaveLength(1)
  })

  it('what counts as the user\'s input into the partner', () => {
    // Keys, Enter, control keys, arrows, a paste, a mouse report, a lone
    // escape, and a reply with anything else in the same write.
    for (const data of ['a', '~', '$', '%', '\r', '\x7f', '\x03', '\x1b[A', '\x1bOA', '\x1b', '\x1b[200~ls\x1b[201~', '\x1b[<0;10;5M', '\x1b]', '\x1bP', 'a\x1b[0n', '\x1b[0nx', '\x1b[24;80Rls']) {
      expect(isPartnerUserInput(data), JSON.stringify(data)).toBe(true)
    }
    // Only the terminal's own replies and focus reports, alone or together.
    for (const data of ['', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[24;80R', '\x1b[?24;80;1R', '\x1b[?2004;1$y', '\x1b[2004;2$y', '\x1b[8;24;80t', '\x1b[?0u', '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\', '\x1b]10;rgb:cdcd/d6d6/f4f4\x07', '\x1bP>|xterm.js(5.5.0)\x1b\\', '\x1bP1$r0m\x1b\\', '\x1b[I', '\x1b[O', '\x1b[I\x1b[O']) {
      expect(isPartnerUserInput(data), JSON.stringify(data)).toBe(false)
    }
  })
})

describe('everything else is as it was', () => {
  it('a terminal-only SSH session opens at home: nothing is typed', () => {
    toPrompt(BASE, { ...PLAIN, remotePath: '/srv/app' })
    expect(getSshFlow(SID)!.getState().state).toBe('shell-only')
    expect(cdWrites()).toEqual([])
  })

  it('the partner\'s prompt reading: the text after the line\'s last carriage return, escapes stripped', () => {
    expect(partnerPromptTail('Welcome\r\ndev@box:~$ ')).toBe('dev@box:~$')
    expect(partnerPromptTail(zshFiller(220) + '\x1b]2;t\x07nick@mac ~ % ')).toBe('nick@mac ~ %')
    // A password prompt after a repaint is still read as one, so the guard's
    // password check sees it.
    expect(partnerPromptTail(zshFiller(220) + '(nick@mac) Password:')).toBe('(nick@mac) Password:')
    expect(partnerPromptTail('dev@box:~$ \r   ')).toBe('dev@box:~$')
    // No text at the end of the chunk, or a tail too long to be a prompt: ''
    // (the caller keeps its previous reading).
    expect(partnerPromptTail('ls\r\n')).toBe('')
    expect(partnerPromptTail('\x1b[2K\x1b[1G')).toBe('')
    expect(partnerPromptTail('x'.repeat(250) + '$ ')).toBe('')
    expect(partnerPromptTail('x'.repeat(250) + '\rdev@box:~$ ')).toBe('dev@box:~$')
  })

  it('the partner\'s shell-prompt check: a shell prompt shape and no sign-in word', () => {
    for (const tail of ['dev@box:~$', 'nick@mac ~ %', 'root@box:~#', '[dev@box ~]$', 'dev@box ~>', 'dev@box:~/tokens$', 'dev@pine64:~$']) {
      expect(isPartnerShellPrompt(tail), tail).toBe(true)
    }
    for (const tail of [
      '', 'Password:', "dev@box's password:", 'Verification code:', 'Select target host [1-3]:',
      'Enter OTP>', 'Enter password >', 'Enter passphrase for key \'/k\'>', 'Passcode>', 'PIN#', 'Token %',
      'one time code ~', 'Verify>', 'TOTP>', 'Enter passwd>',
    ]) {
      expect(isPartnerShellPrompt(tail), tail).toBe(false)
    }
    // Accepted: a shell prompt that itself names a sign-in word (a host called
    // pin) is refused too, and that partner opens at home, as one whose prompt
    // is not recognised does.
    expect(isPartnerShellPrompt('dev@pin:~$')).toBe(false)
    // Accepted, the other way (recorded so that a change here is
    // deliberate): the sign-in check is a word list, so a prompt that
    // ends like a shell prompt and names none of its words still passes, for
    // example a host menu ending in > or a code prompt in other words.
    for (const tail of ['Select target host [1-3]>', 'Enter the 6-digit code>', 'Response>']) {
      expect(isPartnerShellPrompt(tail), tail).toBe(true)
    }
    // A % is a prompt only as zsh draws it: alone or after a space. A
    // percentage is not one. Mutation to prove this can fail: let any
    // trailing % count.
    for (const tail of ['%', 'nick@mac ~ %', 'dev@box /srv/app %', 'Copying files 100 %']) {
      expect(isPartnerShellPrompt(tail), tail).toBe(true)
    }
    for (const tail of ['45%', '100%', 'Authorized use only. Sessions logged 100%', 'Reading package lists... 45%', 'Progress: 7%']) {
      expect(isPartnerShellPrompt(tail), tail).toBe(false)
    }
    // Accepted (recorded so that a change here is deliberate): a zsh prompt
    // that draws its % right after other text, as zsh's own fallback prompt
    // does ("box%"), is not recognised, and that partner opens at home.
    expect(isPartnerShellPrompt('box%')).toBe(false)
    // With the partner's recent output: its sign-in words count too.
    expect(isPartnerShellPrompt('>', 'Enter your one-time password\r\n> ')).toBe(false)
    expect(isPartnerShellPrompt('word>', 'Enter password> ')).toBe(false)
    expect(isPartnerShellPrompt('dev@box:~$', 'Last login: Sat Oct 11\r\ndev@box:~$ ')).toBe(true)
  })

  it('the partner\'s recent output: the last two lines, escapes stripped, read across reads', () => {
    let raw = partnerRecentOutput('', 'Welcome\r\nEnter pass')
    raw = partnerRecentOutput(raw, 'word> ')
    expect(partnerRecentText(raw)).toBe('Welcome\r\nEnter password> ')
    expect(partnerRecentText('one\r\ntwo\r\nthree$ ')).toBe('two\r\nthree$ ')
    expect(partnerRecentText('\x1b]0;title\x07\x1b[1mdev\x1b[0m@box:~$ ')).toBe('dev@box:~$ ')
    // zsh's filler counts once, so the line above the prompt is still read.
    expect(partnerRecentText('Password\r\n' + zshFiller(220) + 'nick@mac ~ % ')).toBe('Password\r\n% \r \rnick@mac ~ % ')
    // At most 300 characters, the newest kept.
    expect(partnerRecentText('x'.repeat(500) + '$ ')).toBe('x'.repeat(298) + '$ ')
    // The raw output kept is bounded too.
    expect(partnerRecentOutput('a'.repeat(5000), 'b').length).toBeLessThanOrEqual(4096)
  })

  it('the helper answers only for a shell-only partner id', () => {
    const ssh = { remotePath: '/srv/app' }
    expect(partnerFolderLine(`${BASE}-partner`, { shellOnly: true }, ssh)).toBe('cd -- /srv/app\r')
    expect(partnerFolderLine(`${BASE}-partner`, { shellOnly: false }, ssh)).toBeNull()
    expect(partnerFolderLine(`${BASE}-partner`, undefined, ssh)).toBeNull()
    expect(partnerFolderLine(BASE, { shellOnly: true }, ssh)).toBeNull()
    expect(partnerFolderLine(`${BASE}-partnerx`, { shellOnly: true }, ssh)).toBeNull()
  })
})
