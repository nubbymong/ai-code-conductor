/**
 * aicc_planning#378 (2.1.3-beta.13, plan section C3): whether a Claude Code
 * session's latest launch got the app's status line
 * (per-session-settings.ts sessionLaunchedWithoutAppStatusLine). A session
 * launched without it reports no usage figure, so the Usage page fetches its
 * account as one no session uses (account-usage.ts
 * setLiveUsageSessionReports, wired in main/index).
 *
 * The settings file is written in a temp home. The secure writers (an
 * owner-only folder and file) are plain writes here, so no folder's
 * permissions change on the machine the test runs on; a flag makes the file
 * write fail. The Claude provider is a stand-in whose status line command a
 * case sets: a command, undefined (the deployed script failed its launch
 * check) or null (a path the shell would read as more than a path).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ setting: undefined as unknown, writeFails: false }))

vi.mock('../../../src/main/account-profiles', async () => {
  const real = await import('node:fs')
  return {
    mkdirSecure: (d: string) => { real.mkdirSync(d, { recursive: true }) },
    hardenCredentialDir: () => {},
    atomicWriteSecure: (f: string, data: string) => {
      if (h.writeFails) throw new Error('EPERM: the stand-in refused the write')
      real.writeFileSync(f, data)
    },
  }
})
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: () => 'tok',
}))
vi.mock('../../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({
    statusPostUrl: () => '',
    statuslineSetting: () => h.setting,
  }),
}))

const { writeLocalSessionSettings, removeLocalSessionSettings, getLocalSessionSettingsPath, sessionLaunchedWithoutAppStatusLine, noteKeptLaunchStatusLine } =
  await import('../../../src/main/hooks/per-session-settings')

const APP_LINE = { type: 'command', command: 'node "/res/scripts/claude-multi-statusline.js" sid' }

describe('whether a launch got the app\'s status line (aicc_planning#378)', () => {
  let home = ''
  let realHomedir: typeof os.homedir
  const res = () => path.join(home, 'res')
  const written = (sid: string) => JSON.parse(fs.readFileSync(getLocalSessionSettingsPath(sid), 'utf-8')) as Record<string, unknown>

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-sl-flag-'))
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    realHomedir = os.homedir
    ;(os as { homedir: () => string }).homedir = () => home
    h.setting = APP_LINE
    h.writeFails = false
  })
  afterEach(() => {
    ;(os as { homedir: () => string }).homedir = realHomedir
    h.writeFails = false
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('a session not launched in this run is not counted as launched without it', () => {
    expect(sessionLaunchedWithoutAppStatusLine('sid-never')).toBe(false)
  })

  it('with no resources folder (the Status line switch off) the launch is without it', () => {
    writeLocalSessionSettings('sid-off', {})
    expect(written('sid-off').statusLine).toBeUndefined()
    expect(sessionLaunchedWithoutAppStatusLine('sid-off')).toBe(true)
  })

  it('when the deployed script fails its launch check (no command) the launch is without it', () => {
    h.setting = undefined
    writeLocalSessionSettings('sid-undef', { resourcesDir: res() })
    expect(sessionLaunchedWithoutAppStatusLine('sid-undef')).toBe(true)
  })

  it('when the command cannot be set up (null) the launch is without it', () => {
    h.setting = null
    writeLocalSessionSettings('sid-null', { resourcesDir: res() })
    expect(sessionLaunchedWithoutAppStatusLine('sid-null')).toBe(true)
  })

  it('with the app\'s status line set and written, the launch has it', () => {
    writeLocalSessionSettings('sid-on', { resourcesDir: res() })
    expect(written('sid-on').statusLine).toEqual(APP_LINE)
    expect(sessionLaunchedWithoutAppStatusLine('sid-on')).toBe(false)
  })

  it('each launch of the same session decides again (a restart after the switch is changed)', () => {
    writeLocalSessionSettings('sid-restart', { resourcesDir: res() })
    expect(sessionLaunchedWithoutAppStatusLine('sid-restart')).toBe(false)
    writeLocalSessionSettings('sid-restart', {})
    expect(sessionLaunchedWithoutAppStatusLine('sid-restart')).toBe(true)
    writeLocalSessionSettings('sid-restart', { resourcesDir: res() })
    expect(sessionLaunchedWithoutAppStatusLine('sid-restart')).toBe(false)
  })

  it('a settings file that could not be written launches without it, even with the command set', () => {
    h.writeFails = true
    writeLocalSessionSettings('sid-nowrite', { resourcesDir: res() })
    expect(fs.existsSync(getLocalSessionSettingsPath('sid-nowrite'))).toBe(false)
    expect(sessionLaunchedWithoutAppStatusLine('sid-nowrite')).toBe(true)
  })

  it('removing the session\'s settings at its end forgets it', () => {
    writeLocalSessionSettings('sid-end', {})
    expect(sessionLaunchedWithoutAppStatusLine('sid-end')).toBe(true)
    removeLocalSessionSettings('sid-end')
    expect(sessionLaunchedWithoutAppStatusLine('sid-end')).toBe(false)
  })

  // 2.1.3-beta.17 (S16 step 5, aicc_planning#412): a session an update kept
  // running, taken over with no launch in this run: read back from the
  // settings file its launch wrote, which the update kept.
  it("a kept session taken over: with the app's status line when its kept settings file runs the app's script with its id; without it for one of the user's own, none, or no file", () => {
    const kept = (sid: string, statusLine: unknown) => fs.writeFileSync(getLocalSessionSettingsPath(sid), JSON.stringify(statusLine === undefined ? {} : { statusLine }))
    kept('sid-kept-app', { type: 'command', command: 'node "/res/scripts/claude-multi-statusline.js" sid-kept-app "/home/u/.claude/ccc-status-sid-kept-app.url"' })
    kept('sid-kept-own', { type: 'command', command: 'my-own-status-line.sh' })
    kept('sid-kept-other', { type: 'command', command: 'node "/res/scripts/claude-multi-statusline.js" another-sid' })
    kept('sid-kept-none', undefined)
    for (const sid of ['sid-kept-app', 'sid-kept-own', 'sid-kept-other', 'sid-kept-none', 'sid-kept-nofile']) noteKeptLaunchStatusLine(sid)
    expect(sessionLaunchedWithoutAppStatusLine('sid-kept-app')).toBe(false)
    for (const sid of ['sid-kept-own', 'sid-kept-other', 'sid-kept-none', 'sid-kept-nofile']) expect(sessionLaunchedWithoutAppStatusLine(sid), sid).toBe(true)
  })
})
