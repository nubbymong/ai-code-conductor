// Three account and launch rules that sit in account-profiles.ts:
//   - a Mac session on a Claude account other than the primary one is refused
//     (profileLaunchRefusal, enforced by withProfileHome);
//   - an account switched off is refused for a session (inactiveAccountRefusal);
//   - git and npm are pinned to the real home's config only where that hides
//     nothing (sharedConfigPins).
// No profile home is built: profiles.json is written under a temp root, and the
// platform is an argument, so every case runs on any OS.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AccountProfile } from '../../src/shared/account-types'
import {
  _setRootsForTest, upsertProfile, withProfileHome, profileLaunchRefusal, inactiveAccountRefusal, assertAccountActive, launchRefusalText, refusalSentenceOrMessage, sharedConfigPins,
  MAC_NON_PRIMARY_REFUSAL, MAC_PRIMARY_UNKNOWN_REFUSAL, MANAGED_LAUNCH_REFUSAL, _resetMacNoPrimaryLogForTest, getProfilesRoot,
} from '../../src/main/account-profiles'
import { composeProviders } from '../../src/main/providers/compose'
import { APP_KNOWLEDGE_SECTIONS } from '../../src/shared/app-knowledge'
import { logWarn } from '../../src/main/debug-logger'

// Only the warning the no-primary case says once is watched; the rest of the logger is the real one.
vi.mock('../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/debug-logger')>()),
  logWarn: vi.fn(),
}))

const profile = (over: Partial<AccountProfile>): AccountProfile => ({ id: 'p1', name: 'Work', accountEmail: 'a@example.test', createdAt: 0, ...over })

describe('profileLaunchRefusal: a Mac session never runs on a profile that is not the primary account', () => {
  const list = [profile({ id: 'p1', isPrimary: true }), profile({ id: 'p2' })]

  it('refuses a profile that is not the primary one on macOS, with a sentence that says what to do', () => {
    const refusal = profileLaunchRefusal('p2', 'darwin', () => list)
    expect(refusal).toBe(MAC_NON_PRIMARY_REFUSAL)
    expect(refusal).toMatch(/normal Claude sign-in/)
    expect(refusal).toMatch(/Choose your primary account/)
    // Nothing in it is about a tab: an Insights run and a cloud agent read it too.
    expect(refusal).not.toMatch(/tab|session/i)
  })

  it('lets the primary account run on macOS', () => {
    expect(profileLaunchRefusal('p1', 'darwin', () => list)).toBeNull()
  })

  it('has no macOS rule on Windows or Linux', () => {
    for (const platform of ['win32', 'linux'] as const) expect(profileLaunchRefusal('p2', platform, () => list)).toBeNull()
  })

  it('refuses when it cannot read the account list, rather than letting any account run', () => {
    expect(profileLaunchRefusal('p1', 'darwin', () => null)).toBe(MAC_PRIMARY_UNKNOWN_REFUSAL)
    expect(profileLaunchRefusal('p1', 'darwin', () => { throw new Error('boom') })).toBe(MAC_PRIMARY_UNKNOWN_REFUSAL)
  })

  it('does not refuse when the list reads but no primary is recorded (a real state: no normal sign-in to capture, an older config, one account)', () => {
    expect(profileLaunchRefusal('p1', 'darwin', () => [profile({ id: 'p1' })])).toBeNull()
    expect(profileLaunchRefusal('p2', 'darwin', () => [profile({ id: 'p1' }), profile({ id: 'p2' })])).toBeNull()
    expect(profileLaunchRefusal('p1', 'darwin', () => [])).toBeNull()
  })

  it('says so once in the log when it goes ahead with no primary recorded', () => {
    _resetMacNoPrimaryLogForTest()
    const warn = vi.mocked(logWarn)
    warn.mockClear()
    for (let i = 0; i < 3; i++) profileLaunchRefusal('p1', 'darwin', () => [profile({ id: 'p1' })])
    const said = warn.mock.calls.filter((c) => /no account is marked as the normal sign-in/.test(String(c[0])))
    expect(said).toHaveLength(1)
    // A list that names a primary says nothing.
    _resetMacNoPrimaryLogForTest()
    warn.mockClear()
    profileLaunchRefusal('p2', 'darwin', () => [profile({ id: 'p1', isPrimary: true }), profile({ id: 'p2' })])
    expect(warn).not.toHaveBeenCalled()
  })

  it('says nothing off macOS even when the list cannot be read', () => {
    expect(profileLaunchRefusal('p1', 'win32', () => null)).toBeNull()
  })
})

describe('withProfileHome enforces the macOS rule before composing anything', () => {
  let tmp = ''
  // A platform-native fake home whose last segment is the profile id.
  const homeOf = (id: string): string => path.resolve(`/r/account-profiles/${id}`)
  beforeAll(() => { composeProviders() })
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-launch-refusal-'))
    _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
    upsertProfile(profile({ id: 'p1', isPrimary: true }))
    upsertProfile(profile({ id: 'p2' }))
  })
  afterEach(() => {
    _setRootsForTest(null)
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('throws the managed-launch refusal, with the sentence, for a non-primary account on macOS', () => {
    const launch = () => withProfileHome({ PATH: '/x' }, homeOf('p2'), undefined, 'darwin')
    expect(launch).toThrow(MANAGED_LAUNCH_REFUSAL)
    expect(launch).toThrow(MAC_NON_PRIMARY_REFUSAL)
  })

  it('does not refuse the same account off macOS', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(() => withProfileHome({ PATH: '/x' }, homeOf('p2'), undefined, platform), platform).not.toThrow()
    }
  })

  it('does not refuse the primary account on macOS', () => {
    expect(() => withProfileHome({ PATH: '/x' }, homeOf('p1'), undefined, 'darwin')).not.toThrow()
  })

  it('does not refuse any account on macOS when no primary is recorded, so every account can still start', () => {
    fs.rmSync(path.join(getProfilesRoot(), 'profiles.json'), { force: true })
    upsertProfile(profile({ id: 'p1' }))
    upsertProfile(profile({ id: 'p2' }))
    for (const id of ['p1', 'p2']) expect(() => withProfileHome({ PATH: '/x' }, homeOf(id), undefined, 'darwin'), id).not.toThrow()
  })

  it('still refuses on macOS when the account list cannot be read', () => {
    fs.writeFileSync(path.join(getProfilesRoot(), 'profiles.json'), '{ not json')
    const launch = () => withProfileHome({ PATH: '/x' }, homeOf('p1'), undefined, 'darwin')
    expect(launch).toThrow(MANAGED_LAUNCH_REFUSAL)
    expect(launch).toThrow(MAC_PRIMARY_UNKNOWN_REFUSAL)
  })
})

describe('inactiveAccountRefusal: a switched-off account starts no session', () => {
  it('refuses an inactive account, names it and says how to move the tab to another', () => {
    const refusal = inactiveAccountRefusal('p2', () => [profile({ id: 'p2', name: 'Side project', active: false })])
    expect(refusal).toContain('"Side project"')
    expect(refusal).toMatch(/is inactive/)
    expect(refusal).toMatch(/Switch Account/)
    // The control the Accounts menu shows, by its own label (AccountsPanel: Make active).
    expect(refusal).toMatch(/use Make active on "Side project" in Settings, Accounts/)
  })

  it('lets an active account, and one that never recorded the flag, start', () => {
    expect(inactiveAccountRefusal('p1', () => [profile({ id: 'p1', active: true })])).toBeNull()
    expect(inactiveAccountRefusal('p1', () => [profile({ id: 'p1' })])).toBeNull()
  })

  it('never refuses the primary account, even if the file marks it inactive', () => {
    expect(inactiveAccountRefusal('p1', () => [profile({ id: 'p1', isPrimary: true, active: false })])).toBeNull()
  })

  it('leaves an account that is not in the list to the missing-account refusal', () => {
    expect(inactiveAccountRefusal('p9', () => [profile({ id: 'p2', active: false })])).toBeNull()
    expect(inactiveAccountRefusal('p9', () => [])).toBeNull()
  })

  it('has a sentence that fits a tab, an agent and an Insights run alike', () => {
    const refusal = inactiveAccountRefusal('p2', () => [profile({ id: 'p2', name: 'Side project', active: false })])!
    expect(refusal).toMatch(/^The Claude account "Side project" is inactive, so nothing was started on it\./)
  })

  it('reads the saved list by default', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-inactive-refusal-'))
    _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
    try {
      upsertProfile(profile({ id: 'p2', name: 'Parked', active: false }))
      expect(inactiveAccountRefusal('p2')).toContain('"Parked"')
    } finally {
      _setRootsForTest(null)
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})

describe('Ask Conductor and the Feature Guide quote the sentences users are shown', () => {
  const known = APP_KNOWLEDGE_SECTIONS.find((x) => x.id === 'known-issues')!.body
  it('knows the Mac refusal, word for word, and that the account shows as not checked', () => {
    expect(known).toContain(MAC_NON_PRIMARY_REFUSAL)
    expect(known).toContain('such an account shows as not checked on this Mac, not as signed out')
  })
  it('knows the switched-off refusal, word for word with the account name as NAME', () => {
    const sentence = inactiveAccountRefusal('p2', () => [profile({ id: 'p2', name: 'NAME', active: false })])!
    expect(known).toContain(sentence)
    expect(known).toContain("Workaround: use Switch Account in the tab's right-click menu")
  })
})

describe('assertAccountActive: the one call a launch makes', () => {
  let tmp = ''
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-assert-active-'))
    _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
    upsertProfile(profile({ id: 'p2', name: 'Parked', active: false }))
    upsertProfile(profile({ id: 'p3', name: 'On' }))
  })
  afterEach(() => {
    _setRootsForTest(null)
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('throws the sentence for a switched-off account', () => {
    expect(() => assertAccountActive('p2', 'session-1')).toThrow(/"Parked" is inactive/)
  })

  it('does nothing for an active account', () => {
    expect(() => assertAccountActive('p3', 'session-1')).not.toThrow()
  })
})

describe('launchRefusalText: a refusal as a user reads it', () => {
  it('drops the log marker and starts with a capital letter', () => {
    expect(launchRefusalText(`${MANAGED_LAUNCH_REFUSAL}: the project's own settings could redirect this account`)).toBe("The project's own settings could redirect this account")
    expect(launchRefusalText(`${MANAGED_LAUNCH_REFUSAL}: ${MAC_NON_PRIMARY_REFUSAL}`)).toBe(MAC_NON_PRIMARY_REFUSAL)
  })

  it('leaves any other message as it is', () => {
    expect(launchRefusalText('Unknown error')).toBe('Unknown error')
  })
})

describe('refusalSentenceOrMessage: a failed spawn as a terminal line says it', () => {
  it('gives a refusal as its sentence', () => {
    expect(refusalSentenceOrMessage(`${MANAGED_LAUNCH_REFUSAL}: ${MAC_NON_PRIMARY_REFUSAL}`)).toBe(MAC_NON_PRIMARY_REFUSAL)
  })

  it('never cuts a message that only quotes the marker further in, such as a directory name in a spawn error', () => {
    const quoting = `spawn failed in C:\\work\\${MANAGED_LAUNCH_REFUSAL}: x\\project`
    expect(refusalSentenceOrMessage(quoting)).toBe(quoting)
    expect(refusalSentenceOrMessage('Unknown error')).toBe('Unknown error')
  })
})

describe('sharedConfigPins: git and npm config pinned to the real home only where that hides nothing', () => {
  let home = ''
  const touch = (...parts: string[]): void => {
    const file = path.join(home, ...parts)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
  }
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-config-pins-')) })
  afterEach(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('pins neither with neither file there', () => {
    expect(sharedConfigPins(home, {})).toEqual({})
  })

  it('pins ~/.gitconfig when it is the only git config', () => {
    touch('.gitconfig')
    expect(sharedConfigPins(home, {})).toEqual({ GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') })
  })

  it('leaves git unpinned when the config is kept only in ~/.config/git/config', () => {
    touch('.config', 'git', 'config')
    expect(sharedConfigPins(home, {}).GIT_CONFIG_GLOBAL).toBeUndefined()
  })

  it('leaves git unpinned when both files exist, so git reads both as a normal terminal does', () => {
    touch('.gitconfig')
    touch('.config', 'git', 'config')
    expect(sharedConfigPins(home, {}).GIT_CONFIG_GLOBAL).toBeUndefined()
  })

  describe('a symlinked ~/.gitconfig beside an XDG git config (the mirror skips a root-level link)', () => {
    const rc = (): string => path.join(home, '.gitconfig')
    const exists = (p: string): boolean => fs.existsSync(p)
    const isRcLink = (p: string): boolean => p === rc()

    it('adds the real ~/.gitconfig as an include, and leaves the XDG lookup and GIT_CONFIG_GLOBAL alone', () => {
      touch('.gitconfig')
      touch('.config', 'git', 'config')
      const pins = sharedConfigPins(home, {}, exists, isRcLink)
      expect(pins.GIT_CONFIG_GLOBAL).toBeUndefined()
      expect(pins).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'include.path', GIT_CONFIG_VALUE_0: rc() })
    })

    it('does the same when XDG_CONFIG_HOME holds the XDG config', () => {
      touch('.gitconfig')
      touch('xdg', 'git', 'config')
      const pins = sharedConfigPins(home, { XDG_CONFIG_HOME: path.join(home, 'xdg') }, exists, isRcLink)
      expect(pins).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'include.path', GIT_CONFIG_VALUE_0: rc() })
    })

    it('continues a count the environment already has, and keeps its entries', () => {
      touch('.gitconfig')
      touch('.config', 'git', 'config')
      const pins = sharedConfigPins(home, { GIT_CONFIG_COUNT: '2' }, exists, isRcLink)
      expect(pins).toEqual({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'include.path', GIT_CONFIG_VALUE_2: rc() })
    })

    it('leaves an unreadable count alone rather than guessing where to append', () => {
      touch('.gitconfig')
      touch('.config', 'git', 'config')
      expect(sharedConfigPins(home, { GIT_CONFIG_COUNT: 'two' }, exists, isRcLink)).toEqual({})
    })

    it('adds nothing for a regular ~/.gitconfig, which the mirror hard-links and an include would read twice', () => {
      touch('.gitconfig')
      touch('.config', 'git', 'config')
      expect(sharedConfigPins(home, {}, exists, () => false)).toEqual({})
    })

    it('adds nothing when the link check cannot be made', () => {
      touch('.gitconfig')
      touch('.config', 'git', 'config')
      expect(sharedConfigPins(home, {}, exists, () => { throw new Error('denied') })).toEqual({})
    })

    it('still pins the file itself when the symlinked ~/.gitconfig is the only git config', () => {
      touch('.gitconfig')
      expect(sharedConfigPins(home, {}, exists, isRcLink)).toEqual({ GIT_CONFIG_GLOBAL: rc() })
    })
  })

  it('leaves git unpinned when XDG_CONFIG_HOME holds the config', () => {
    touch('.gitconfig')
    touch('xdg', 'git', 'config')
    expect(sharedConfigPins(home, { XDG_CONFIG_HOME: path.join(home, 'xdg') }).GIT_CONFIG_GLOBAL).toBeUndefined()
  })

  it('still pins ~/.gitconfig when XDG_CONFIG_HOME names a folder with no git config', () => {
    touch('.gitconfig')
    expect(sharedConfigPins(home, { XDG_CONFIG_HOME: path.join(home, 'xdg') }).GIT_CONFIG_GLOBAL).toBe(path.join(home, '.gitconfig'))
  })

  it('pins ~/.npmrc only when it exists', () => {
    expect(sharedConfigPins(home, {}).npm_config_userconfig).toBeUndefined()
    touch('.npmrc')
    expect(sharedConfigPins(home, {}).npm_config_userconfig).toBe(path.join(home, '.npmrc'))
  })

  it('treats a file the check cannot ask about as absent', () => {
    expect(sharedConfigPins(home, {}, () => { throw new Error('denied') })).toEqual({})
  })

  describe('as a managed launch composes it', () => {
    const FAKE_HOME = path.resolve('/r/account-profiles/p1')
    beforeAll(() => { composeProviders() })
    afterEach(() => { vi.restoreAllMocks() })

    it('carries the pin when ~/.gitconfig is the only config, and drops it when a config is kept in the XDG place', () => {
      vi.spyOn(os, 'homedir').mockReturnValue(home)
      touch('.gitconfig')
      touch('.npmrc')
      // The platform is named (not the host's), so a macOS run does not read this
      // machine's account list: the Mac rule is covered by the cases above.
      const pinned = withProfileHome({ PATH: '/x' }, FAKE_HOME, undefined, 'linux')
      expect(pinned.GIT_CONFIG_GLOBAL).toBe(path.join(home, '.gitconfig'))
      expect(pinned.npm_config_userconfig).toBe(path.join(home, '.npmrc'))
      touch('.config', 'git', 'config')
      const both = withProfileHome({ PATH: '/x' }, FAKE_HOME, undefined, 'linux')
      expect(both.GIT_CONFIG_GLOBAL).toBeUndefined()
      expect(both.npm_config_userconfig).toBe(path.join(home, '.npmrc'))
    })

    it('hands a symlinked ~/.gitconfig on as an include through the launch hardening, after the user\'s own entries', () => {
      vi.spyOn(os, 'homedir').mockReturnValue(home)
      touch('.gitconfig')
      touch('.config', 'git', 'config')
      // The link is stood in for (making one needs a privilege on Windows): only this file reads as a symlink.
      const rc = path.join(home, '.gitconfig')
      const realLstat = fs.lstatSync
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        const st = (realLstat as (...a: unknown[]) => fs.Stats)(p, ...rest)
        return String(p) === rc ? Object.assign(Object.create(st), { isSymbolicLink: () => true }) : st
      }) as typeof fs.lstatSync)
      const env = withProfileHome({ PATH: '/x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' }, FAKE_HOME, undefined, 'linux')
      expect(env.GIT_CONFIG_GLOBAL).toBeUndefined()
      expect(env.GIT_CONFIG_COUNT).toBe('2')
      expect(env.GIT_CONFIG_KEY_0).toBe('core.autocrlf')
      expect(env.GIT_CONFIG_KEY_1).toBe('include.path')
      expect(env.GIT_CONFIG_VALUE_1).toBe(rc)
    })
  })
})
