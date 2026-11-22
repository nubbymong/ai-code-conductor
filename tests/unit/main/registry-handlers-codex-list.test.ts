// aicc_planning#362: registering the registry handlers is the one production
// call that follows the installed Codex (installed-codex-models.ts). With
// Sentinel off (its default) nothing else reads the Codex model list, so this
// pins the wiring: drop the call and the picker never gets the list. The
// accounts service is faked: no process starts, no folder is made (the
// registry's resources folder is a path that is never created), no network.
import { it, expect, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))

const fake = vi.hoisted(() => {
  const s = {
    reads: 0,
    snapshot: () => ({ providers: [{ providerId: 'codex', enabled: true, discoveryState: 'found', version: '0.180.0', compatibility: 'too-new' }] }),
    subscribe: () => () => {},
    readModelCatalogue: async () => { s.reads++; return { ok: true, catalogue: { ok: true, version: '0.180.0', models: [{ id: 'gpt-7-nova', label: 'GPT-7-Nova', efforts: ['low'] }] } } },
  }
  return s
})
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => fake }))

import { registerRegistryHandlers } from '../../../src/main/ipc/registry-handlers'
import { getRegistry } from '../../../src/main/model-registry-service'
import { buildModelPickerRows } from '../../../src/shared/model-registry'

it('registering the registry handlers follows the installed Codex: its list is the picker with no Sentinel run', async () => {
  registerRegistryHandlers(path.join(os.tmpdir(), `ccc-c9-handlers-never-made-${process.pid}`))
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r))
  expect(fake.reads).toBe(1)
  expect(buildModelPickerRows(getRegistry(), 'codex').map((r) => r.value)).toEqual(['gpt-7-nova'])
})
