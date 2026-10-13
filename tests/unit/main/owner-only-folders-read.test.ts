// 2.1.1-beta.3: the read-only owner-only check (readOwnerOnlyFoldersWindows).
// A sign in again asks it about the account's folder in use before it links
// history in; it must read and never write: whoami.exe for the user's SID and
// one read of the folders' attributes and rights (OWNER_ONLY_READ_SCRIPT),
// judged by the same verdict as the rule that makes folders owner-only.
//
// Host-safe: whoami and Windows PowerShell are fakes handed to the function,
// and `node:child_process` is mocked to refuse anything else.
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const no = (file: unknown) => { throw new Error(`no process in this test: ${String(file)}`) }
  const execFileSync = vi.fn(no)
  const execFile = vi.fn(no)
  const spawn = vi.fn(no)
  const spawnSync = vi.fn(no)
  const execSync = vi.fn(no)
  return { ...real, execFileSync, execFile, spawn, spawnSync, execSync, default: { ...real, execFileSync, execFile, spawn, spawnSync, execSync } }
})

import { readOwnerOnlyFoldersWindows, OWNER_ONLY_READ_SCRIPT, OWNER_ONLY_SCRIPT, OWNER_ONLY_DIRS_ENV } from '../../../src/main/owner-only-folders'

const USER = 'S-1-5-21-1-2-3-1001'
/** Another local group (a neutral synthetic SID). */
const GROUP = 'S-1-5-21-9-9-9-1050'
const DIR_ATTR = 0x10
const LINK_ATTR = 0x400
const OWNER_ONLY = `O:${USER}D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)`

type Read = { missing?: boolean; attributes?: number | null; sddl?: string | null; error?: boolean }

function tools(whoami: { code: number | null; stdout: string } = { code: 0, stdout: `"host\\me","${USER}"\r\n` }) {
  const ran: Array<{ program: string; args: readonly string[] }> = []
  return {
    ran,
    run: async (program: 'whoami' | 'icacls', args: readonly string[]) => {
      ran.push({ program, args })
      if (program !== 'whoami') throw new Error('only whoami may run here')
      return whoami
    },
  }
}

function reader(answer: (dirs: string[]) => Read[] | string) {
  const asked: Array<{ script: string; env: Record<string, string> }> = []
  const read = async (script: string, env: Record<string, string>) => {
    asked.push({ script, env })
    const dirs = (env[OWNER_ONLY_DIRS_ENV] ?? '').split('\n').filter(Boolean)
    const out = answer(dirs)
    return typeof out === 'string' ? out : JSON.stringify(out.map((r) => ({ missing: false, attributes: DIR_ATTR, sddl: OWNER_ONLY, error: false, ...r })))
  }
  return { asked, read }
}

describe('the read-only owner-only check', () => {
  it('a protected folder that only the user, SYSTEM and the Administrators group may use reads back owner-only', async () => {
    const t = tools()
    const r = reader((dirs) => dirs.map(() => ({})))
    expect(await readOwnerOnlyFoldersWindows(['C:\\res\\accounts\\a'], t, r.read)).toEqual([{ dir: 'C:\\res\\accounts\\a', ok: true, detail: 'owner-only' }])
  })

  it('reads and never writes: whoami alone runs, and the one read is the read script, not the rule that sets rights', async () => {
    const t = tools()
    const r = reader((dirs) => dirs.map(() => ({})))
    await readOwnerOnlyFoldersWindows(['C:\\a', 'C:\\b'], t, r.read)
    expect(t.ran.map((x) => x.program)).toEqual(['whoami'])
    expect(r.asked).toHaveLength(1)
    expect(r.asked[0].script).toBe(OWNER_ONLY_READ_SCRIPT)
    expect(r.asked[0].script).not.toBe(OWNER_ONLY_SCRIPT)
    expect(r.asked[0].script).not.toMatch(/SetAccessControl|icacls|Set-Acl|CreateDirectory/i)
    // The folders through the environment, one a line, never the script's text.
    expect(r.asked[0].env).toEqual({ [OWNER_ONLY_DIRS_ENV]: 'C:\\a\nC:\\b' })
  })

  it('a folder that inherits from above, gives another group rights, or is not the user\'s is not owner-only', async () => {
    const t = tools()
    const cases: Array<[string, string]> = [
      [`O:${USER}D:AI(A;OICIID;FA;;;${USER})(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;${GROUP})`, 'it inherits rights from above'],
      [`O:${USER}D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;${GROUP})`, `an entry for ${GROUP}`],
      [`O:BAD:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)`, 'its owner is not this user'],
    ]
    for (const [sddl, why] of cases) {
      const r = reader((dirs) => dirs.map(() => ({ sddl })))
      expect(await readOwnerOnlyFoldersWindows(['C:\\x'], t, r.read), sddl).toEqual([{ dir: 'C:\\x', ok: false, detail: why }])
    }
  })

  it('a link, a file, a missing folder or a failed read is not owner-only; each answer is matched to its folder by place', async () => {
    const t = tools()
    const r = reader(() => [{ attributes: DIR_ATTR | LINK_ATTR }, { attributes: 0x20 }, { missing: true, attributes: null, sddl: null }, { error: true }, {}])
    const out = await readOwnerOnlyFoldersWindows(['C:\\l', 'C:\\f', 'C:\\m', 'C:\\e', 'C:\\ok'], t, r.read)
    expect(out.map((x) => [x.dir, x.ok, x.detail])).toEqual([
      ['C:\\l', false, 'a link'], ['C:\\f', false, 'not a folder'], ['C:\\m', false, 'it is missing'], ['C:\\e', false, 'it could not be read'], ['C:\\ok', true, 'owner-only'],
    ])
  })

  it('no read at all says unread for every folder: whoami fails, the read fails, or its answer does not match what was asked', async () => {
    const bad = [
      { t: tools({ code: 1, stdout: '' }), r: reader((dirs) => dirs.map(() => ({}))) },
      { t: tools(), r: { asked: [], read: async () => { throw new Error('Constrained Language Mode') } } },
      { t: tools(), r: reader(() => [{}]) },
      { t: tools(), r: reader(() => 'not json') },
    ]
    for (const [i, { t, r }] of bad.entries()) {
      const out = await readOwnerOnlyFoldersWindows(['C:\\a', 'C:\\b'], t, r.read)
      expect(out.map((x) => [x.dir, x.ok, x.unread]), `case ${i}`).toEqual([['C:\\a', false, true], ['C:\\b', false, true]])
    }
  })

  it('a folder that cannot be named safely is refused and never sent', async () => {
    const t = tools()
    const r = reader((dirs) => dirs.map(() => ({})))
    const out = await readOwnerOnlyFoldersWindows(['relative\\x', 'C:\\ok', 'C:\\dot.\\x'], t, r.read)
    expect(out.map((x) => [x.dir, x.ok])).toEqual([['relative\\x', false], ['C:\\ok', true], ['C:\\dot.\\x', false]])
    expect(r.asked[0].env[OWNER_ONLY_DIRS_ENV]).toBe('C:\\ok')
    const none = reader(() => [])
    expect((await readOwnerOnlyFoldersWindows(['relative'], t, none.read)).map((x) => x.ok)).toEqual([false])
    expect(none.asked).toEqual([])
  })
})
