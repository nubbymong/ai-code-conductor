// 2.1.1-beta.3: on Windows a sign in again links the earlier conversation
// files into the new account folder only when the account's folder in use
// reads back owner-only now (a read that writes nothing). From any other
// folder -- one that reads back otherwise, one that cannot be read, or no
// answer at all -- each file is copied instead, and a copy takes the new
// folder's rights.
//
// PURE: the accounts service on the fake CLI harness and an in-memory folder
// tree (tests/wp1/accounts-harness.ts); the realm folder code once more on its own,
// with no read-only check at all. No file is written and no process starts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { harness, addCodexAccount, managedHome, memoryFs, RES, USER } from '../../wp1/accounts-harness'
import { createCodexRealmFolders, createCodexRealmLocks, resolveCodexRealmRoots } from '../../../src/main/providers/codex'
import type { CodexFolderLookup } from '../../../src/main/providers/codex'
// The test setup replaces the app's log with recording fakes; the realm
// folder code says its choice there.
import { logWarn } from '../../../src/main/debug-logger'

type H = Awaited<ReturnType<typeof harness>>
type Answer = ReadonlyArray<{ dir: string; ok: boolean; detail?: string }>

const realmIdOf = (h: H, a: string) => h.doc().accounts.find((x) => x.id === a)!.authRealmId
const homeOf = (realmId: string) => managedHome(realmId).toLowerCase()
const links = (h: H) => h.folders.log.filter((l) => l.startsWith('link '))
const copies = (h: H) => h.folders.log.filter((l) => l.startsWith('copyFile '))
const said = () => vi.mocked(logWarn).mock.calls.map((c) => c.map(String).join(' '))
beforeEach(() => { vi.mocked(logWarn).mockClear() })

/** Two conversations from before and the prompt history, in a realm's home. */
function plant(h: H, home: string): string[] {
  for (const d of ['sessions', 'sessions\\2026', 'sessions\\2026\\09', 'sessions\\2026\\09\\01']) h.folders.dirs.add(`${home}\\${d}`)
  const files = [`${home}\\sessions\\2026\\09\\01\\rollout-1.jsonl`, `${home}\\sessions\\2026\\09\\01\\rollout-2.jsonl`, `${home}\\history.jsonl`]
  for (const f of files) h.folders.files.add(f)
  return files
}

/** One account with history, signed in again with `readOwnerOnly` as the check. */
async function signInAgainWith(readOwnerOnly?: (dirs: readonly string[]) => Promise<Answer>) {
  const asked: string[][] = []
  const h = await harness(readOwnerOnly ? { readOwnerOnly: async (dirs) => { asked.push([...dirs]); return readOwnerOnly(dirs) } } : {})
  const a = await addCodexAccount(h, 'A')
  const oldHome = homeOf(realmIdOf(h, a))
  const files = plant(h, oldHome)
  const r = await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)
  const newHome = homeOf(realmIdOf(h, a))
  return { h, a, r, oldHome, newHome, files, asked }
}

describe('a sign in again links history only from a folder that reads back owner-only (2.1.1-beta.3)', () => {
  it('a folder that does not read back owner-only: every file is copied, none linked, and the log says so', async () => {
    const { h, r, oldHome, newHome, files, asked } = await signInAgainWith(async (dirs) => dirs.map((dir) => ({ dir, ok: false, detail: 'it inherits rights from above' })))
    expect(r).toEqual({ ok: true, state: 'signed-in' })
    // Asked once, about the account's folder in use, and nothing else.
    expect(asked.map((d) => d.map((x) => x.toLowerCase()))).toEqual([[oldHome]])
    expect(links(h)).toEqual([])
    expect(copies(h)).toHaveLength(files.length)
    for (const f of files) {
      const moved = f.replace(oldHome, newHome)
      expect(h.folders.files.has(moved), moved).toBe(true)
      // A file of its own (one name), not a second name of the old one.
      expect(h.folders.fs.lstat(moved).nlink).toBe(1)
      expect(h.folders.fs.lstat(moved).ino).not.toBe(h.folders.fs.lstat(f).ino)
      // Carried over, not moved.
      expect(h.folders.files.has(f)).toBe(true)
    }
    expect(said().some((l) => l.includes('sign in again: the earlier account folder did not read back as private to this user, so its conversation files are copied into the new folder, not linked'))).toBe(true)
    expect(said().filter((l) => l.includes('sign in again: the earlier account folder')).join('\n')).not.toMatch(/[A-Za-z]:\\/)
  })

  it('a folder that reads back owner-only: the files are linked, as before', async () => {
    const { h, r, oldHome, newHome, files, asked } = await signInAgainWith(async (dirs) => dirs.map((dir) => ({ dir, ok: true, detail: 'owner-only' })))
    expect(r).toEqual({ ok: true, state: 'signed-in' })
    expect(asked).toHaveLength(1)
    expect(copies(h)).toEqual([])
    expect(links(h)).toHaveLength(files.length)
    expect(h.folders.fs.lstat(files[0].replace(oldHome, newHome))).toMatchObject({ ino: h.folders.fs.lstat(files[0]).ino, nlink: 2 })
    expect(said().some((l) => l.includes('sign in again: the earlier account folder'))).toBe(false)
  })

  it('no answer counts as not owner-only: a check that throws, answers for another folder, gives no answer per folder, or not a plain yes', async () => {
    const odd: Array<(dirs: readonly string[]) => Promise<Answer>> = [
      async () => { throw new Error('the check could not run') },
      async (dirs) => dirs.map(() => ({ dir: 'C:\\somewhere\\else', ok: true })),
      async () => [],
      async (dirs) => [...dirs, ...dirs].map((dir) => ({ dir, ok: true })),
      async (dirs) => dirs.map((dir) => ({ dir, ok: 'yes' as unknown as boolean })),
      async () => null as unknown as Answer,
    ]
    for (const [i, check] of odd.entries()) {
      const { h, r, files } = await signInAgainWith(check)
      expect(r, `check ${i}`).toEqual({ ok: true, state: 'signed-in' })
      expect(links(h), `check ${i}`).toEqual([])
      expect(copies(h), `check ${i}`).toHaveLength(files.length)
    }
  })

  it('a copy keeps every other rule: a file with a name the app did not give it is still left behind, never copied', async () => {
    const h = await harness({ readOwnerOnly: async (dirs) => dirs.map((dir) => ({ dir, ok: false })) })
    const a = await addCodexAccount(h, 'A')
    const oldHome = homeOf(realmIdOf(h, a))
    plant(h, oldHome)
    const elsewhere = 'c:\\users\\u\\elsewhere.json'
    h.folders.files.add(elsewhere)
    const linkIn = `${oldHome}\\sessions\\2026\\09\\01\\rollout-linked.jsonl`
    h.folders.ops.link(elsewhere, linkIn)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in', notCarriedOver: 1 })
    const newHome = homeOf(realmIdOf(h, a))
    expect(h.folders.files.has(linkIn.replace(oldHome, newHome))).toBe(false)
    expect(copies(h).some((l) => l.includes('rollout-linked'))).toBe(false)
  })
})

describe('the realm folder code on its own, with no read-only check', () => {
  it('Windows: without a check, history is copied, never linked', async () => {
    const folders = memoryFs()
    const SRC = `realm-${'a'.repeat(16)}`
    const DST = `realm-${'b'.repeat(16)}`
    const realms = new Map<string, Extract<CodexFolderLookup, { ok: true }>['realm']>([
      [SRC, { id: SRC, providerId: 'codex', kind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${SRC}`, lifecycle: 'active' }],
      [DST, { id: DST, providerId: 'codex', kind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${DST}`, lifecycle: 'pending' }],
    ])
    const lookupRealm = async (ref: { authRealmId: string }): Promise<CodexFolderLookup> => {
      const realm = realms.get(ref.authRealmId)
      const roots = resolveCodexRealmRoots({ resourcesDir: RES, env: {}, homeDir: USER }, folders.fs)
      return realm && roots.ok ? { ok: true, realm, roots: roots.roots } : { ok: false }
    }
    const src = homeOf(SRC)
    const dst = homeOf(DST)
    folders.fs.mkdirSecure(src)
    folders.fs.mkdirSecure(dst)
    folders.dirs.add(`${src}\\sessions`)
    folders.files.add(`${src}\\sessions\\rollout-1.jsonl`)
    folders.files.add(`${src}\\history.jsonl`)
    const ops = createCodexRealmFolders({ lookupRealm, fs: folders.fs, locks: createCodexRealmLocks() })
    expect(await ops.copyHistory!({ authRealmId: SRC }, { authRealmId: DST })).toMatchObject({ ok: true, copied: 2, linked: 0, skipped: 0 })
    expect(folders.log.filter((l) => l.startsWith('link '))).toEqual([])
    expect(folders.log.filter((l) => l.startsWith('copyFile '))).toHaveLength(2)
    expect(folders.files.has(`${dst}\\sessions\\rollout-1.jsonl`)).toBe(true)
  })
})
