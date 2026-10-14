// When the app cannot make an account's sign-in folders private to the user,
// the refusal names the folder the user can act on: AI Code Conductor's
// resources folder (where the account folders live), never "the app data
// folder", which a Windows user reads as %APPDATA%, another folder. (The
// managed account folders of the other provider say the same:
// realm-folders-owner-only-wiring.test.ts.)
//
// 2.1.1-beta.3 (F7): the remedy asks for the owner of that folder AND of
// everything in it, as the Feature Guide's known issue does: owning the top
// folder alone leaves the folders inside it as they were, so the refusal
// would come back after a restart.
//
// Host-safe: no process starts.
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

import { CREDENTIAL_FOLDER_REFUSAL } from '../../../src/main/account-profiles'
import { APP_KNOWLEDGE_SECTIONS } from '../../../src/shared/app-knowledge'

/** The remedy both texts give, word for word. */
const REMEDY = "the owner of AI Code Conductor's resources folder (the folder chosen for its data when it was set up) and of everything in it"

describe('a refusal to use an account\'s sign-in folders names the resources folder', () => {
  it('names AI Code Conductor\'s resources folder, never the app data folder', () => {
    expect(CREDENTIAL_FOLDER_REFUSAL).toMatch(/AI Code Conductor's resources folder/)
    expect(CREDENTIAL_FOLDER_REFUSAL).not.toMatch(/app data folder|app's data folder/i)
  })

  it('asks for the owner of that folder and of everything in it (F7)', () => {
    expect(CREDENTIAL_FOLDER_REFUSAL).toContain(REMEDY)
    // Still one sentence a user can follow: the alternative and the restart.
    expect(CREDENTIAL_FOLDER_REFUSAL).toMatch(/and of everything in it, or move that folder to an NTFS disk, then restart AI Code Conductor\.$/)
  })

  it('gives the same remedy as the Feature Guide\'s known issue', () => {
    const all = APP_KNOWLEDGE_SECTIONS.map((s) => s.body).join('\n')
    const issue = all.split('\n').find((line) => line.includes("if the app cannot make an account's sign-in folders readable by you alone"))
    expect(issue, 'the known issue for a refused sign-in folder').toBeTruthy()
    expect(issue!).toContain(REMEDY)
  })
})
