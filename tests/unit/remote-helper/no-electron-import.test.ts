/**
 * Remote step 1's modules, and the provider launch core asks, load with no
 * Electron at all (2.1.3-beta.18, plan section 3.2): remote-helper-e2e runs
 * them under plain Node (tests/live/remote-helper-device.live.ts, the
 * dispatch-only job on CI's Linux runner, and a host line). There, importing
 * Electron gives none of its named exports, so a module that reads one as it
 * loads fails. Found by that job (run 45576326034): the Claude package's
 * remote launch imported hooks/session-hooks-writer.ts, whose import of
 * account-profiles.ts reaches update-watcher.ts, which reads
 * `app.isPackaged` as it loads. Every module the live file imports is loaded
 * here afresh, with Electron as plain Node gives it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

/** The app modules tests/unit/setup.ts stands in for. */
const SETUP_STAND_INS = ['../../../src/main/debug-logger', '../../../src/main/ipc/setup-handlers', '../../../src/main/first-start-warmup']

afterEach(() => {
  vi.doUnmock('electron')
  vi.resetModules()
})

describe('the modules the remote helper device check imports', () => {
  it('load with Electron as plain Node gives it (no named exports)', async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({}))
    // The unit setup's own stand-ins (tests/unit/setup.ts) are lifted, so the
    // modules load as the live file loads them: a stand-in there cut the
    // chain this check is for.
    for (const m of SETUP_STAND_INS) vi.doUnmock(m)
    // The check can fail: the module that broke the device check does not load here.
    await expect(import('../../../src/main/update-watcher')).rejects.toThrow(/app/)
    const modules = await Promise.all([
      import('../../../src/main/remote-helper'),
      import('../../../src/main/remote-helper/machines'),
      import('../../../src/main/remote-helper/ssh-exec'),
      import('../../../src/main/remote-helper/session'),
      import('../../../src/main/remote-helper/manifest'),
      import('../../../src/main/providers/claude/remote-launch'),
    ])
    expect(typeof modules[0].remoteLaunchOf).toBe('function')
    expect(typeof modules[5].claudeRemoteLaunch.launch).toBe('function')
  })

  it('the live file imports no other module of the app', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const text = readFileSync(resolve(__dirname, '../../live/remote-helper-device.live.ts'), 'utf8')
    const imported = [...text.matchAll(/from '(\.\.\/\.\.\/src\/[^']+)'/g)].map((m) => m[1]).sort()
    expect(imported).toEqual([
      '../../src/main/providers/claude/remote-launch',
      '../../src/main/remote-helper',
      '../../src/main/remote-helper/machines',
      '../../src/main/remote-helper/manifest',
      '../../src/main/remote-helper/session',
      '../../src/main/remote-helper/ssh-exec',
    ])
  })
})
