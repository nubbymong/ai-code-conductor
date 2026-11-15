// A Claude session whose account has been switched off starts nothing, wherever
// the account id came from (a restored tab or a saved session: the picker only
// hides the account). The sentence names the account and says how to move the
// tab to another. The real spawnPty with node-pty mocked, so no process
// starts. The refusal comes before any profile home is touched, so no profile
// folder is built here: the account is a row in profiles.json under a temp
// root and an empty folder where its home would be.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const spawned: string[] = []
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => process.env.TEMP ?? '/tmp' },
}))
vi.mock('node-pty', () => ({ spawn: () => { spawned.push('spawn'); throw new Error('no process should start') } }))
vi.mock('../../../src/main/usage/usage-snapshots', () => ({ loadSnapshots: () => new Map(), saveSnapshots() {} }))
// A launch that is NOT refused would carry on to the profile's folders and the
// Claude CLI. None of that may happen here (it would harden folders and could
// start a process), so those steps are stood in: the refusal is the only thing
// under test, and a missing refusal fails the assertions, not the host.
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  setupProfileLinks: () => {},
  syncPrimaryCredentialsWithGlobal: () => {},
  backupProfileHomeToCanonical: () => {},
  checkProfileCredentialFolders: async () => {},
}))
// The project-settings check a managed launch waits on is held for good, so a
// launch that is not refused stops there, before any folder is touched.
vi.mock('../../../src/main/managed-launch-diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/managed-launch-diagnostics')>()),
  gateManagedLaunchDirs: () => new Promise(() => {}),
}))
vi.mock('../../../src/main/claude-cli-version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/claude-cli-version')>()),
  ensureClaudeCliVersion: () => {},
  probeClaudeCliVersion: async () => null,
}))
vi.mock('../../../src/main/provider-launch-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/provider-launch-gate')>()),
  providerLaunchRefusal: () => null,
}))

const profiles = await import('../../../src/main/account-profiles')
const { spawnPty, REMOVED_ACCOUNT_REFUSAL } = await import('../../../src/main/pty-manager')
const { registerFakeClaudePackage } = await import('../../helpers/claude-package')

const win = { webContents: { send: () => {} }, isDestroyed: () => false } as never
let sandbox = ''

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-inactive-spawn-'))
  profiles._setRootsForTest({ resourcesDir: sandbox, sharedRoot: path.join(sandbox, 'global', '.claude') })
  registerFakeClaudePackage({
    id: 'claude', displayName: 'Claude',
    buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }), detectUiRunning: () => false,
    ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
    resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {},
    getSshSettingsPath: () => '', getSshMcpConfigPath: () => '', configureRemoteSettings: () => '',
  })
  spawned.length = 0
})
afterEach(() => {
  profiles._setRootsForTest(null)
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** An account the app knows: its row, and an empty folder where its home is. */
function makeAccount(id: string, over: Record<string, unknown>): void {
  profiles.upsertProfile({ id, name: 'Side project', accountEmail: 'a@example.test', createdAt: 0, ...over })
  fs.mkdirSync(profiles.getProfileConfigDir(id), { recursive: true })
}

describe('a session naming a switched-off account', () => {
  it('starts nothing and says which account it is and how to move the tab', () => {
    makeAccount('profile-off', { active: false })
    let thrown = ''
    try { spawnPty(win, 'inactive-1', { cwd: sandbox, shellOnly: false, profileId: 'profile-off' } as never) } catch (e) { thrown = (e as Error).message }
    expect(thrown).toContain('"Side project"')
    expect(thrown).toMatch(/is inactive/)
    expect(thrown).toMatch(/use Make active on "Side project" in Settings, Accounts/)
    expect(thrown).toMatch(/Switch Account/)
    expect(thrown).not.toBe(REMOVED_ACCOUNT_REFUSAL)
    expect(spawned).toEqual([])
  })

  it('still answers an account that is not set up at all with the missing-account sentence', () => {
    expect(() => spawnPty(win, 'inactive-2', { cwd: sandbox, shellOnly: false, profileId: 'profile-gone' } as never)).toThrow(REMOVED_ACCOUNT_REFUSAL)
    expect(spawned).toEqual([])
  })
})
