// 2.1.3-beta.6, plan section E: the wiring that makes the real-path look take
// effect. The look is kept under (realm, session, conversation, folder) by
// CodexProvider.warmResumeLookup and read by the launch builder through
// buildCodexSpawn; if the two ever stopped agreeing on that key, the look
// would silently do nothing and the unit tests of each half would stay green.
// So this test drives both halves, as pty-manager does: a conversation
// recorded under a link (a spelling that is not on this disk), the tab on the
// real folder, and the disk's real-path answer a stand-in.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, dirname, basename, resolve } from 'path'
import { tmpdir } from 'os'

vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => '',
}))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: () => 'tok',
}))
vi.mock('../../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: () => ({ outcome: 'absent', value: null }),
  getConfigDir: () => '/cfg',
}))

import * as fs from 'fs'
import { CodexProvider } from '../../../../src/main/providers/codex'
import { __resetWarmedCodexResumeForTests, __resetCodexDiskMemoryForTests } from '../../../../src/main/providers/codex/rollout-lookup'

const ID = '019dd000-0001-7000-8000-0000000000f1'
const codexOptions = { model: 'gpt-5.5', permissionsPreset: 'standard' as const }

const temps: string[] = []
const temp = (tag: string): string => { const d = mkdtempSync(join(tmpdir(), `ccc-e1-wire-${tag}-`)); temps.push(d); return d }

let project: string
let link: string
let configured: string
let sessionsDir: string
let otherSessionsDir: string
let file: string

/** A realm whose only rollout records `cwd`. */
function realmRecording(cwd: string): { sessionsDir: string; file: string } {
  const home = temp('realm')
  const dir = join(home, 'sessions', '2026', '09', '01')
  mkdirSync(dir, { recursive: true })
  const rollout = join(dir, `rollout-2026-09-01T12-00-00-${ID}.jsonl`)
  writeFileSync(rollout, JSON.stringify({ timestamp: '2026-09-01T12:00:00.000Z', type: 'session_meta', payload: { id: ID, cwd, cli_version: '0.155.1' } }) + '\n')
  return { sessionsDir: join(home, 'sessions'), file: rollout }
}

const launchIn = (dir: string) => ({ executable: '/proven/codex', env: { PATH: '/usr/bin', CODEX_HOME: dirname(dir) }, sessionsDir: dir })

beforeEach(() => {
  __resetWarmedCodexResumeForTests()
  __resetCodexDiskMemoryForTests()
  project = fs.realpathSync(temp('project'))
  configured = fs.realpathSync(temp('configured'))
  // A link spelling that is not on this disk: only the stand-in knows it.
  link = join(project, 'a-link-that-is-not-made')
  const realm = realmRecording(link)
  sessionsDir = realm.sessionsDir
  file = realm.file
  otherSessionsDir = realmRecording(link).sessionsDir
  const original = fs.promises.realpath.bind(fs.promises) as (p: string) => Promise<string>
  vi.spyOn(fs.promises, 'realpath').mockImplementation(((p: string) => (p === link ? Promise.resolve(project) : original(p))) as unknown as typeof fs.promises.realpath)
})
afterEach(() => {
  vi.restoreAllMocks()
  // Only a folder this file made (its own prefix, directly in the temp folder) is removed.
  for (const d of temps.splice(0)) if (dirname(d) === tmpdir() && /^ccc-e1-wire-/.test(basename(d))) rmSync(d, { recursive: true, force: true })
})

const build = (dir: string, sessionId = 'sid') => new CodexProvider().buildSpawnCommand({
  sessionId, realmLaunch: launchIn(dir), cwd: configured, resume: { uuid: ID, cwd: project }, codexOptions,
})

describe('the provider\'s look and the launch builder read one answer', () => {
  it('without a look, the spelling differs: it starts in the configured folder and says so (the case the look is for)', () => {
    const out = build(sessionsDir)
    expect(out.resumeId).toBe(ID)
    expect(out.cwd).toBe(configured)
    expect(out.resumeCwdMismatch).toBe(true)
  })

  // Mutation to prove this can fail: make the key the provider keeps differ from the one the builder reads (the sessions folder, the session, ...).
  it('with the look the provider made for this realm, session, conversation and folder: it starts in the tab\'s folder, and the rollout is the one chosen', async () => {
    await new CodexProvider().warmResumeLookup({ uuid: ID, cwd: project }, sessionsDir, 'sid', configured)
    const out = build(sessionsDir)
    expect(out.resumeCwdMismatch).toBe(false)
    expect(out.cwd).toBe(resolve(project))
    expect(out.resumePath).toBe(file)
  })

  it('a look made for another realm is not read by this launch', async () => {
    await new CodexProvider().warmResumeLookup({ uuid: ID, cwd: project }, otherSessionsDir, 'sid', configured)
    expect(build(sessionsDir)).toMatchObject({ resumeCwdMismatch: true, cwd: configured })
  })

  it('a look made for another session is not read by this launch', async () => {
    await new CodexProvider().warmResumeLookup({ uuid: ID, cwd: project }, sessionsDir, 'another-sid', configured)
    expect(build(sessionsDir)).toMatchObject({ resumeCwdMismatch: true, cwd: configured })
  })

  it('a look made for another folder of the tab is not read by this launch', async () => {
    await new CodexProvider().warmResumeLookup({ uuid: ID, cwd: configured }, sessionsDir, 'sid', configured)
    expect(build(sessionsDir)).toMatchObject({ resumeCwdMismatch: true, cwd: configured })
  })

  it('is read once: a second launch of the same session compares the spelling again', async () => {
    await new CodexProvider().warmResumeLookup({ uuid: ID, cwd: project }, sessionsDir, 'sid', configured)
    expect(build(sessionsDir).resumeCwdMismatch).toBe(false)
    expect(build(sessionsDir).resumeCwdMismatch).toBe(true)
  })

  it('a provider look that gets no session or configured folder still works (they only narrow it)', async () => {
    await new CodexProvider().warmResumeLookup({ uuid: ID, cwd: project }, sessionsDir)
    const out = new CodexProvider().buildSpawnCommand({
      sessionId: '', realmLaunch: launchIn(sessionsDir), cwd: configured, resume: { uuid: ID, cwd: project }, codexOptions,
    })
    expect(out.resumeCwdMismatch).toBe(false)
  })
})
