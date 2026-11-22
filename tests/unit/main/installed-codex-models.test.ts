// aicc_planning#362: main reads the installed Codex's own model list and
// hands it to the model registry, so the Codex picker, the Codex launch's
// effort check and Sentinel all offer that list. The accounts service is
// faked: no process starts, no folder is made (the registry's resources
// folder is a path that is never created), no network is touched.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))

import {
  followInstalledCodexModels, readInstalledCodexModels, installedCodexModelReadsInFlight, type CodexModelListAnswer,
} from '../../../src/main/installed-codex-models'
import { _initRegistryForTest, getRegistry, onRegistryReload, setInstalledCodexModels } from '../../../src/main/model-registry-service'
import { buildModelPickerRows, codexEffortRuns } from '../../../src/shared/model-registry'

const NEVER_MADE = path.join(os.tmpdir(), `ccc-c9-registry-never-made-${process.pid}`)
const tick = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r)) }
const codexRows = (): string[] => buildModelPickerRows(getRegistry(), 'codex').map((r) => r.value)

const listed = (version: string, ids: string[]): CodexModelListAnswer => ({
  ok: true,
  catalogue: { ok: true, version, models: ids.map((id) => ({ id, label: id.toUpperCase(), efforts: id === 'gpt-7-nova' ? ['low', 'medium'] : ['low', 'medium', 'high'] })) },
})

/** A fake accounts service: what it found of Codex, and the reads it answered. */
function fakeService(found: Record<string, unknown> | null) {
  const listeners = new Set<() => void>()
  const svc = {
    found,
    answer: listed('0.180.0', ['gpt-7-nova', 'gpt-5.5']) as CodexModelListAnswer,
    hold: null as Promise<void> | null,
    reads: 0,
    snapshot: () => ({ providers: svc.found ? [{ providerId: 'claude', enabled: true, discoveryState: 'found' }, { providerId: 'codex', ...svc.found }] : [] }),
    subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l) },
    readModelCatalogue: async () => { svc.reads++; if (svc.hold) await svc.hold; return svc.answer },
    changed: () => { for (const l of listeners) l() },
  }
  return svc
}
const FOUND = { enabled: true, discoveryState: 'found', version: '0.180.0', compatibility: 'too-new' }

beforeEach(() => {
  _initRegistryForTest(NEVER_MADE)
})

describe('the installed Codex\'s model list reaches the registry (aicc_planning#362)', () => {
  it('Codex found: one read, and the picker offers its list, a model the registry lacks with its own levels', async () => {
    const before = codexRows()
    expect(before).not.toContain('gpt-7-nova')
    const svc = fakeService(FOUND)
    followInstalledCodexModels(svc as never)
    await tick()
    expect(svc.reads).toBe(1)
    expect(codexRows()).toEqual(['gpt-7-nova', 'gpt-5.5'])
    expect(getRegistry().installedCodex).toEqual({ version: '0.180.0' })
    expect(codexEffortRuns(getRegistry(), 'gpt-7-nova', 'medium')).toBe(true)
    expect(codexEffortRuns(getRegistry(), 'gpt-7-nova', 'high')).toBe(false)
    // Another change that leaves Codex as it was reads nothing again.
    svc.changed()
    await tick()
    expect(svc.reads).toBe(1)
  })

  it('a read that fails, Codex off, or Codex not found: the registry alone', async () => {
    const failing = fakeService(FOUND)
    failing.answer = { ok: true, catalogue: { ok: false, code: 'unreadable', detail: 'x' } }
    const before = codexRows()
    followInstalledCodexModels(failing as never)
    await tick()
    expect(failing.reads).toBe(1)
    expect(codexRows()).toEqual(before)
    expect(getRegistry().installedCodex).toBeUndefined()
    for (const codex of [{ ...FOUND, enabled: false }, { enabled: true, discoveryState: 'missing', compatibility: 'unknown' }, null]) {
      _initRegistryForTest(NEVER_MADE)
      const svc = fakeService(codex)
      followInstalledCodexModels(svc as never)
      await tick()
      expect(svc.reads, JSON.stringify(codex)).toBe(0)
      expect(codexRows()).toEqual(before)
    }
  })

  it('a list read earlier goes when Codex is switched off, and comes back when it is on again', async () => {
    const svc = fakeService(FOUND)
    const before = codexRows()
    followInstalledCodexModels(svc as never)
    await tick()
    expect(codexRows()).toEqual(['gpt-7-nova', 'gpt-5.5'])
    svc.found = { ...FOUND, enabled: false }
    svc.changed()
    await tick()
    expect(codexRows()).toEqual(before)
    svc.found = FOUND
    svc.changed()
    await tick()
    expect(svc.reads).toBe(2)
    expect(codexRows()).toEqual(['gpt-7-nova', 'gpt-5.5'])
  })

  it('another version found is read again; a read that a switch-off overtook is not used', async () => {
    const svc = fakeService(FOUND)
    followInstalledCodexModels(svc as never)
    await tick()
    let release!: () => void
    svc.hold = new Promise<void>((r) => { release = r })
    svc.answer = listed('0.181.0', ['gpt-7-terra'])
    svc.found = { ...FOUND, version: '0.181.0' }
    svc.changed()
    await tick()
    expect(svc.reads).toBe(2)
    // Switched off while that read runs: its answer is dropped.
    svc.found = { ...FOUND, version: '0.181.0', enabled: false }
    svc.changed()
    await tick()
    release()
    await tick()
    expect(codexRows()).not.toContain('gpt-7-terra')
    expect(getRegistry().installedCodex).toBeUndefined()
  })

  it('a read counts as Codex in use from its start to its end', async () => {
    const svc = fakeService(FOUND)
    let release!: () => void
    svc.hold = new Promise<void>((r) => { release = r })
    const done = readInstalledCodexModels(svc as never, { fresh: true })
    expect(installedCodexModelReadsInFlight()).toBe(1)
    release()
    await done
    expect(installedCodexModelReadsInFlight()).toBe(0)
  })

  it('Sentinel\'s start-up read joins the one in flight, then takes its answer: one run of Codex for a start', async () => {
    const svc = fakeService(FOUND)
    let release!: () => void
    svc.hold = new Promise<void>((r) => { release = r })
    followInstalledCodexModels(svc as never)
    await tick()
    const joined = readInstalledCodexModels(svc as never, { fresh: false })
    release()
    expect(await joined).toEqual(svc.answer)
    expect(await readInstalledCodexModels(svc as never, { fresh: false })).toEqual(svc.answer)
    expect(svc.reads).toBe(1)
    // A Re-run reads again.
    await readInstalledCodexModels(svc as never, { fresh: true })
    expect(svc.reads).toBe(2)
  })

  it('the registry is reloaded (and pushed) only when the list changes', () => {
    const pushed: number[] = []
    const off = onRegistryReload(() => pushed.push(1))
    try {
      const l = { version: '0.180.0', models: [{ id: 'gpt-7-nova', label: 'GPT-7-Nova', efforts: ['low'] }] }
      expect(setInstalledCodexModels(l)).toBe(true)
      expect(setInstalledCodexModels({ ...l, models: [...l.models] })).toBe(false)
      expect(setInstalledCodexModels(null)).toBe(true)
      expect(setInstalledCodexModels(null)).toBe(false)
      expect(pushed).toHaveLength(2)
    } finally {
      off()
    }
  })
})
