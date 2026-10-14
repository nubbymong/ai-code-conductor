/**
 * P3.13 (row 72): the one-at-a-time rule and its words are ONE definition,
 * asked by the renderer's launch surfaces and by main at pty:spawn. These pin
 * the rule's table, the words, and the one naming convention main and the
 * renderer must agree on (the partner terminal's PTY id).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isOneAtATimeBlocked,
  alreadyRunningCopy,
  alreadyRunningRefusalMessage,
  PARTNER_PTY_SUFFIX,
  isPartnerPtyId,
  parentOfPartnerPtyId,
  partnerSshOf,
  isPartnerSshOf,
  PARTNER_NEEDS_SESSION_MESSAGE,
} from '../../../src/shared/multi-spawn-rule'
import { refusedTabText, launchRefusalOf, spawnRefusalOf, PROVIDER_LAUNCH_REFUSAL_CODES, SPAWN_REFUSAL_CODES } from '../../../src/shared/providers'

const ROOT = resolve(__dirname, '..', '..', '..')

describe('isOneAtATimeBlocked', () => {
  it('nothing else running: never blocked, whatever the stored value', () => {
    for (const v of [undefined, false, true, 'yes', 1, null]) expect(isOneAtATimeBlocked(v, 0), String(v)).toBe(false)
  })

  it('another copy running: only an explicit true lets a launch through', () => {
    expect(isOneAtATimeBlocked(true, 1)).toBe(false)
    expect(isOneAtATimeBlocked(true, 5)).toBe(false)
    // never chosen, declined, and anything a hand edit could leave behind
    for (const v of [undefined, false, 'yes', 'true', 1, 0, null, {}, []]) expect(isOneAtATimeBlocked(v, 1), String(v)).toBe(true)
  })

  it('a count that is not a count never blocks', () => {
    for (const n of [0, -1, Number.NaN]) expect(isOneAtATimeBlocked(false, n), String(n)).toBe(false)
  })
})

describe('the words', () => {
  it('the popover copy is what the sidebar has always said', () => {
    expect(alreadyRunningCopy('App Dev')).toEqual({
      headline: 'App Dev is already running.',
      body: "It isn't a Multi Spawn config, so it runs one at a time.",
    })
  })

  it('main\'s refusal says it and then what to do, and reads as a whole sentence in the tab', () => {
    const message = alreadyRunningRefusalMessage('App Dev')
    expect(message).toBe("App Dev is already running. It isn't a Multi Spawn config, so it runs one at a time. Close the other copy, or turn on Allow Multi Spawn for it.")
    expect(refusedTabText({ message })).toBe("Not started. App Dev is already running. It isn't a Multi Spawn config, so it runs one at a time. Close the other copy, or turn on Allow Multi Spawn for it, then Restart this tab.")
  })

  it('the words name the setting by the label the config dialog shows', () => {
    const dialog = readFileSync(resolve(ROOT, 'src/renderer/components/SessionDialog.tsx'), 'utf8')
    expect(dialog).toContain('Allow Multi Spawn')
    expect(alreadyRunningRefusalMessage('x')).toContain('Allow Multi Spawn')
  })

  it('every refusal is plain ASCII', () => {
    expect(alreadyRunningRefusalMessage('x')).toMatch(/^[\x20-\x7e]+$/)
  })
})

describe('the partner terminal id', () => {
  it('is a session id plus the suffix', () => {
    expect(isPartnerPtyId('a1b2c3-partner')).toBe(true)
    expect(isPartnerPtyId('a1b2c3')).toBe(false)
    expect(isPartnerPtyId('a1b2c3-partner-x')).toBe(false)
    expect(isPartnerPtyId('')).toBe(false)
  })

  it('is the suffix every renderer site that names a partner terminal uses', () => {
    // main recognises the shell of a session by this shape; a renderer that
    // named it another way would make the shell count as a copy of its config.
    for (const file of ['src/renderer/App.tsx', 'src/renderer/hooks/useRestartSession.ts', 'src/renderer/ptyTracker.ts']) {
      const text = readFileSync(resolve(ROOT, file), 'utf8')
      const named = [...text.matchAll(/\+\s*'(-[a-z]+)'/g)].map((m) => m[1]).filter((s) => /partner/.test(s))
      expect(named.length, file).toBeGreaterThan(0)
      for (const s of named) expect(s, file).toBe(PARTNER_PTY_SUFFIX)
    }
  })
})

/**
 * #86: the partner shell of an SSH session is a plain shell on the session's
 * own host. ONE definition of its ssh block: the renderer starts the partner
 * with partnerSshOf(session's block), and main recognises it with
 * isPartnerSshOf(its record of the session's spawn, the partner's request).
 */
describe('the partner of an SSH session (#86)', () => {
  const session = {
    host: 'build-box', port: 2222, username: 'nick', remotePath: '~/proj',
    postCommand: 'sudo docker exec -it app bash', runtime: { type: 'container', engine: 'docker', container: 'app' },
    dockerContainer: 'app', detachable: true, remoteOs: 'unix', hasPassword: true, hasSudoPassword: true,
  } as const

  it('the parent id is the partner id without the suffix, and nothing for any other id', () => {
    expect(parentOfPartnerPtyId('a1b2c3-partner')).toBe('a1b2c3')
    expect(parentOfPartnerPtyId('a1b2c3')).toBeNull()
    expect(parentOfPartnerPtyId('-partner')).toBeNull()
    expect(parentOfPartnerPtyId('a1-partnerx')).toBeNull()
  })

  it('is the session\'s own host, port, user and folder as a plain connection: no post-connect command, no container, persistence off', () => {
    expect(partnerSshOf(session)).toEqual({
      host: 'build-box', port: 2222, username: 'nick', remotePath: '~/proj',
      remoteOs: 'unix', hasPassword: true, hasSudoPassword: true, detachable: false,
    })
    // persistence off whatever the session says, and nothing reconnects
    expect(partnerSshOf({ host: 'h', port: 22, username: 'u', remotePath: '~', reconnect: true } as never)).toEqual({ host: 'h', port: 22, username: 'u', remotePath: '~', detachable: false })
    expect(partnerSshOf({ host: 'h', port: 22, username: 'u', remotePath: '~', detachable: false })).toEqual({ host: 'h', port: 22, username: 'u', remotePath: '~', detachable: false })
  })

  it('main recognises exactly the partner block of its record, the spawn\'s own reconnect flag aside', () => {
    const recorded = { ...session, reconnect: true } // what main recorded of the session's spawn
    const asked = { ...partnerSshOf(session), reconnect: false } // what the partner's spawn sends (TerminalView adds reconnect)
    expect(isPartnerSshOf(recorded, asked)).toBe(true)
    expect(isPartnerSshOf(session, partnerSshOf(session))).toBe(true)
  })

  it('anything else is not the partner: another host, port, user or folder, a post-connect command, a container, persistence, a reconnect, an extra field, a missing one', () => {
    const p = partnerSshOf(session) as Record<string, unknown>
    const not = (over: Record<string, unknown>, label: string) => expect(isPartnerSshOf(session, { ...p, ...over }), label).toBe(false)
    not({ host: 'other-box' }, 'host')
    not({ port: 22 }, 'port')
    not({ port: '2222' }, 'port as text')
    not({ username: 'root' }, 'user')
    not({ remotePath: '/' }, 'folder')
    not({ remoteOs: 'windows' }, 'remote os')
    not({ postCommand: 'sudo docker exec -it app bash' }, 'post-connect command')
    not({ runtime: session.runtime }, 'container')
    not({ dockerContainer: 'app' }, 'legacy container')
    not({ detachable: true }, 'persistence')
    not({ detachable: undefined }, 'persistence unsaid')
    not({ reconnect: true }, 'reconnect')
    not({ identityFile: '~/.ssh/other' }, 'an extra field')
    const missing = { ...p }; delete missing.hasPassword
    expect(isPartnerSshOf(session, missing), 'a missing field').toBe(false)
  })

  it('a key holding undefined is no key, on either side', () => {
    expect(isPartnerSshOf({ ...session, postCommand: undefined, identityFile: undefined }, { ...partnerSshOf(session), identityFile: undefined, reconnect: undefined })).toBe(true)
  })

  it('never matches what is not an ssh block', () => {
    const p = partnerSshOf(session)
    for (const bad of [undefined, null, 'x', 3, [], [p]]) {
      expect(isPartnerSshOf(bad, p), JSON.stringify(bad)).toBe(false)
      expect(isPartnerSshOf(session, bad), JSON.stringify(bad)).toBe(false)
    }
    expect(isPartnerSshOf({ host: 'h' }, { host: 'h', detachable: false })).toBe(false) // a record with no port, user or folder
    expect(isPartnerSshOf(session, { ...p, nested: [1] })).toBe(false)
  })
})

describe('the refusal pty:spawn answers (N3: its own type, not the provider gate type)', () => {
  const answer = (code: string) => ({ started: false, refused: { code, providerId: 'claude', message: 'Why.' } })

  it('already-running is a pty:spawn refusal and not a provider-gate refusal', () => {
    expect(spawnRefusalOf(answer('already-running'))).toEqual({ code: 'already-running', providerId: 'claude', message: 'Why.' })
    expect(launchRefusalOf(answer('already-running'))).toBeNull()
    expect(PROVIDER_LAUNCH_REFUSAL_CODES).not.toContain('already-running')
    expect(SPAWN_REFUSAL_CODES).toContain('already-running')
  })

  it('#86: partner-needs-session is a pty:spawn refusal too, and its tab says what to do', () => {
    expect(spawnRefusalOf(answer('partner-needs-session'))?.code).toBe('partner-needs-session')
    expect(launchRefusalOf(answer('partner-needs-session'))).toBeNull()
    expect(PROVIDER_LAUNCH_REFUSAL_CODES).not.toContain('partner-needs-session')
    expect(refusedTabText({ message: PARTNER_NEEDS_SESSION_MESSAGE })).toBe('Not started. The partner shell opens on the host once its session is running. Start or restart the session, then Restart this tab.')
  })

  it('every provider-gate refusal is still a pty:spawn refusal (main refuses the provider first)', () => {
    for (const code of PROVIDER_LAUNCH_REFUSAL_CODES) {
      expect(spawnRefusalOf(answer(code))?.code).toBe(code)
      expect(launchRefusalOf(answer(code))?.code).toBe(code)
    }
  })

  it('anything else reads as no refusal', () => {
    for (const v of [null, undefined, 'x', 3, {}, { refused: null }, { refused: 'x' }, answer('nope'), answer(''), { refused: { code: 'already-running', providerId: 'claude', message: '' } }, { refused: { code: 'already-running', providerId: 5, message: 'x' } }]) {
      expect(spawnRefusalOf(v), JSON.stringify(v)).toBeNull()
    }
  })
})
