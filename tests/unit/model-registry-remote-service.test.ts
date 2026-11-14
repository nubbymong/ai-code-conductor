/**
 * Model definitions as data (2.1.3-beta.1), through the REAL registry
 * service: the model file is read once at start-up, in the background; a
 * good one is used at once by every reader and kept as the last good copy;
 * on any failure the last good copy is used, else the bundled file, and one
 * line in the log says why.
 *
 * The read is a stand-in in every case (no request leaves this suite), and
 * the only folder made is this suite's own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import bundledJson from '../../resources/model-registry.json'

const logged = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { logged.lines.push(a.join(' ')) },
  logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn(),
}))

import {
  _initRegistryForTest, getRegistry, getBaseline, onRegistryReload, refreshModelRegistry, applyOverlayEntry, modelDataFile,
} from '../../src/main/model-registry-service'
import { resolveModelInfo, buildModelPickerRows } from '../../src/shared/model-registry'

type Loose = Record<string, any>
const NEW_MODEL = { id: 'claude-fable-6', patterns: ['fable-6'], family: 'fable', label: 'Fable 6', fallbackPricing: { input: 6, output: 30, cacheRead: 0.15, cacheWrite: 7.5 } }
const fileText = (change?: (f: Loose) => void): string => {
  const f = JSON.parse(JSON.stringify(bundledJson)) as Loose
  ;(change ?? ((x: Loose) => { x.models.unshift(NEW_MODEL) }))(f)
  return JSON.stringify(f)
}
const answers = (text: string) => async () => ({ ok: true as const, text })
const fails = (reason: string) => async () => ({ ok: false as const, reason })
const has = (id: string) => getRegistry().models.some((m) => m.id === id)
const registryLines = () => logged.lines.filter((l) => l.startsWith('[registry]'))

const PREFIX = 'ccc-model-data-'
let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  // The app's config folder, as config-manager has made it by the time a read ends.
  fs.mkdirSync(path.join(dir, 'CONFIG'))
  logged.lines.length = 0
  _initRegistryForTest(dir)
})
afterEach(() => {
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (path.basename(dir).startsWith(PREFIX) && path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a good model file', () => {
  it('is used at once: every reader sees the new model, and the reload is announced once', async () => {
    const reloads: number[] = []
    const off = onRegistryReload((reg) => { reloads.push(reg.models.length) })
    expect(has('claude-fable-6')).toBe(false)
    expect(await refreshModelRegistry({ fetchText: answers(fileText()) })).toBe(true)
    off()
    expect(has('claude-fable-6')).toBe(true)
    expect(reloads).toEqual([bundledJson.models.length + 1])
    expect(resolveModelInfo(getRegistry(), 'claude-fable-6')).toMatchObject({ known: true, label: 'Fable 6' })
    expect(buildModelPickerRows(getRegistry()).some((r) => r.value === 'claude-fable-6')).toBe(true)
    // The baseline the overlay is reconciled against carries it too.
    expect(getBaseline().models.some((m) => m.id === 'claude-fable-6')).toBe(true)
    expect(registryLines()).toEqual([`[registry] model data read: ${bundledJson.models.length + 1} models, in use`])
  })

  it('is kept as the last good copy in the app\'s own config folder, and a later start uses it with no read at all', async () => {
    await refreshModelRegistry({ fetchText: answers(fileText()) })
    const saved = modelDataFile()!
    expect(saved).toBe(path.join(dir, 'CONFIG', 'model-data.json'))
    expect(JSON.parse(fs.readFileSync(saved, 'utf-8'))).toMatchObject({ formatVersion: 1, models: expect.arrayContaining([NEW_MODEL]) })
    _initRegistryForTest(dir)                              // the next start, before any read
    expect(has('claude-fable-6')).toBe(true)
  })

  it('the user\'s own overlay still applies on top', async () => {
    await refreshModelRegistry({ fetchText: answers(fileText()) })
    applyOverlayEntry({ id: 'claude-fable-6', patterns: ['fable-6'], family: 'fable', label: 'My Fable', provenance: { addedBy: 'user', date: '2026-11-14' } })
    expect(resolveModelInfo(getRegistry(), 'claude-fable-6').label).toBe('My Fable')
  })

  it('a file that says what is already in use changes nothing and announces nothing', async () => {
    await refreshModelRegistry({ fetchText: answers(fileText()) })
    _initRegistryForTest(dir)
    let reloads = 0
    const off = onRegistryReload(() => { reloads++ })
    const before = fs.statSync(modelDataFile()!).mtimeMs
    expect(await refreshModelRegistry({ fetchText: answers(fileText()) })).toBe(false)
    off()
    expect(reloads).toBe(0)
    expect(fs.statSync(modelDataFile()!).mtimeMs).toBe(before)
    expect(has('claude-fable-6')).toBe(true)
  })

  it('is read once per start: a second call is the same read', async () => {
    let reads = 0
    const fetchText = async () => { reads++; return { ok: true as const, text: fileText() } }
    const [a, b] = await Promise.all([refreshModelRegistry({ fetchText }), refreshModelRegistry({ fetchText })])
    await refreshModelRegistry({ fetchText })
    expect(reads).toBe(1)
    expect([a, b]).toEqual([true, true])
  })

  it('the config folder is never made here (it holds secrets, and is config-manager\'s to make owner-only): with none, the file is used and not kept', async () => {
    fs.rmdirSync(path.join(dir, 'CONFIG'))
    expect(await refreshModelRegistry({ fetchText: answers(fileText()) })).toBe(true)
    expect(has('claude-fable-6')).toBe(true)
    expect(fs.existsSync(path.join(dir, 'CONFIG'))).toBe(false)
    expect(registryLines().some((l) => /could not be kept/.test(l))).toBe(true)
  })

  it('a last good copy that cannot be written is said, and the file is still used', async () => {
    fs.rmdirSync(path.join(dir, 'CONFIG'))
    fs.writeFileSync(path.join(dir, 'CONFIG'), 'a file where the folder should be')
    expect(await refreshModelRegistry({ fetchText: answers(fileText()) })).toBe(true)
    expect(has('claude-fable-6')).toBe(true)
    expect(registryLines().some((l) => /could not be kept/.test(l))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'CONFIG'), 'utf-8')).toBe('a file where the folder should be')
  })
})

describe('a read that fails', () => {
  it('no last good copy: the bundled file, and one line that says why', async () => {
    expect(await refreshModelRegistry({ fetchText: fails('no answer within 5 s') })).toBe(false)
    expect(getRegistry().models.map((m) => m.id)).toEqual(bundledJson.models.map((m) => m.id))
    expect(registryLines()).toEqual(['[registry] model data not read (no answer within 5 s); using the bundled file'])
    expect(fs.existsSync(modelDataFile()!)).toBe(false)
  })

  it('with a last good copy: that copy stays in use, and the line says so', async () => {
    await refreshModelRegistry({ fetchText: answers(fileText()) })
    _initRegistryForTest(dir)
    logged.lines.length = 0
    expect(await refreshModelRegistry({ fetchText: fails('HTTP 503') })).toBe(false)
    expect(has('claude-fable-6')).toBe(true)
    expect(registryLines()).toEqual(['[registry] model data not read (HTTP 503); using the last good copy'])
  })

  it.each([
    ['not JSON', '{nope'],
    ['a newer format', fileText((f) => { f.formatVersion = 2 })],
    ['an unknown field', fileText((f) => { f.models[0].exec = 'calc.exe' })],
    ['a pattern that is an expression', fileText((f) => { f.models[0].patterns = ['(a+)+$'] })],
  ])('a file that is %s is not used and not kept; the last good copy is untouched', async (_what, text) => {
    await refreshModelRegistry({ fetchText: answers(fileText()) })
    const good = fs.readFileSync(modelDataFile()!, 'utf-8')
    _initRegistryForTest(dir)
    logged.lines.length = 0
    expect(await refreshModelRegistry({ fetchText: answers(text) })).toBe(false)
    expect(fs.readFileSync(modelDataFile()!, 'utf-8')).toBe(good)
    expect(has('claude-fable-6')).toBe(true)
    expect(registryLines()).toHaveLength(1)
    expect(registryLines()[0]).toMatch(/^\[registry\] model data not read \(.+\); using the last good copy$/)
  })

  it('a read that throws is a failure like any other: nothing is thrown, the bundled file is used', async () => {
    await expect(refreshModelRegistry({ fetchText: async () => { throw new Error('boom') } })).resolves.toBe(false)
    expect(has('claude-opus-5-5')).toBe(true)
    expect(registryLines()).toHaveLength(1)
  })

  it('a reason is logged as one plain line, whatever it holds', async () => {
    await refreshModelRegistry({ fetchText: fails(`first\nsecond \u001b[31m${'x'.repeat(400)}`) })
    expect(registryLines()).toHaveLength(1)
    expect(registryLines()[0]).not.toMatch(/[\n\u001b]/)
    expect(registryLines()[0].length).toBeLessThan(260)
  })
})

describe('the last good copy is checked like a fetched file', () => {
  const plant = (text: string | Buffer) => {
    fs.writeFileSync(path.join(dir, 'CONFIG', 'model-data.json'), text)
  }

  it('a damaged copy is ignored with one line, and the bundled file is used', () => {
    plant('{broken')
    logged.lines.length = 0
    _initRegistryForTest(dir)
    expect(getRegistry().models.map((m) => m.id)).toEqual(bundledJson.models.map((m) => m.id))
    expect(registryLines()).toEqual(['[registry] the last good model data is not usable (not JSON); using the bundled file'])
  })

  it('a copy edited to carry what a fetched file may not is ignored', () => {
    plant(fileText((f) => { f.models.unshift({ ...NEW_MODEL, id: 'x\n/exit' }) }))
    _initRegistryForTest(dir)
    expect(getRegistry().models).toHaveLength(bundledJson.models.length)
  })

  it('a copy larger than 256 KB is not read', () => {
    plant(Buffer.concat([Buffer.from(fileText()), Buffer.alloc(256 * 1024, 0x20)]))
    _initRegistryForTest(dir)
    expect(has('claude-fable-6')).toBe(false)
  })

  it('no copy: nothing is logged about it', () => {
    expect(registryLines()).toEqual([])
  })
})
