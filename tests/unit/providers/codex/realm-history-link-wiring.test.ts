// 2.1.1-beta.3: the managed Codex account folders on this disk get the app's
// read-only owner-only check (owner-only-folders.ts readOwnerOnlyFoldersWindows)
// for a sign in again's history: on Windows the files are linked in only when
// the account's folder in use reads back owner-only; otherwise each is a copy
// of its own. The check is replaced here, so no process starts; the folders
// and files are real, in a temp folder this test makes and removes (a hard
// link or a byte copy, never a change of rights).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const asked: string[][] = []
let answerOk = false
vi.mock('../../../../src/main/owner-only-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/owner-only-folders')>()),
  readOwnerOnlyFoldersWindows: vi.fn(async (dirs: readonly string[]) => {
    asked.push([...dirs])
    return dirs.map((dir) => ({ dir, ok: answerOk, detail: answerOk ? 'owner-only' : 'it inherits rights from above' }))
  }),
  secureOwnerOnlyFolders: vi.fn(async () => { throw new Error('no folder is made owner-only in this test') }),
}))

import { createCodexPackage } from '../../../../src/main/providers/codex'

const SRC = `realm-${'a'.repeat(16)}`
const DST = `realm-${'b'.repeat(16)}`

describe('a sign in again on this disk asks the read-only check before it links history in', () => {
  let tmp = ''
  beforeEach(() => {
    asked.length = 0
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-history-link-wiring-')))
  })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const source = () => ({
    lookup: async (r: { authRealmId: string }) => ({
      ok: true as const,
      realm: { id: r.authRealmId, providerId: 'codex' as const, kind: 'codex-home' as const, ownership: 'conductor-managed' as const, pathRef: `managed:${r.authRealmId}`, lifecycle: r.authRealmId === SRC ? 'active' as const : 'pending' as const },
      resourcesDir: tmp,
    }),
    mkdirSecure: (dir: string) => { fs.mkdirSync(dir, { recursive: true }) },
  })

  /** Both account folders, with one conversation and the prompt history in the source. */
  function homes() {
    const root = path.join(tmp, 'codex-realms')
    const src = path.join(root, SRC)
    const dst = path.join(root, DST)
    fs.mkdirSync(path.join(src, 'sessions', '2026'), { recursive: true })
    fs.mkdirSync(dst, { recursive: true })
    fs.writeFileSync(path.join(src, 'sessions', '2026', 'rollout-1.jsonl'), '{}\n')
    fs.writeFileSync(path.join(src, 'history.jsonl'), '{}\n')
    return { src, dst }
  }

  it.each([false, true])('the check answers owner-only=%s', async (ok) => {
    answerOk = ok
    const { src, dst } = homes()
    const pkg = createCodexPackage({ realms: source(), hostHome: { env: {}, homeDir: path.join(tmp, 'home') } })
    const r = await pkg.realmFolders!.copyHistory!({ authRealmId: SRC }, { authRealmId: DST })
    const carried = path.join(dst, 'sessions', '2026', 'rollout-1.jsonl')
    expect(fs.readFileSync(carried, 'utf8')).toBe('{}\n')
    expect(fs.readFileSync(path.join(dst, 'history.jsonl'), 'utf8')).toBe('{}\n')
    if (process.platform === 'win32') {
      // Asked about the source folder only, by the app's own read.
      expect(asked).toEqual([[src]])
      if (ok) {
        expect(r).toMatchObject({ ok: true, copied: 2, linked: 2 })
        expect(fs.statSync(carried).nlink).toBe(2)
      } else {
        expect(r).toMatchObject({ ok: true, copied: 2, linked: 0 })
        expect(fs.statSync(carried).nlink).toBe(1)
        expect(fs.statSync(path.join(src, 'sessions', '2026', 'rollout-1.jsonl')).nlink).toBe(1)
      }
    } else {
      // POSIX: never asked; a second name sits below the new folder's 0700.
      expect(asked).toEqual([])
      expect(r).toMatchObject({ ok: true, copied: 2, linked: 2 })
    }
  })

  it('the app\'s composition passes no read-only check of its own, so the folders on this disk always get the app\'s', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'src', 'main', 'providers', 'compose.ts'), 'utf8')
    expect(src).not.toMatch(/\breadOwnerOnly\b/)
  })
})
