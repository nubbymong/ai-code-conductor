// [host] At start the main process puts the app's own scripts in the resources
// folder: each registered provider's statusline script and resume picker,
// provider by provider in the registry's order (today the statusline script,
// the Claude resume picker, and the Codex resume picker with the Codex hook
// forwarder). Before them, the scripts folders go through the owner-only rule
// (script-folders.ts secureScriptFolders, with the scripts folders' rule);
// after them, the launches waiting for all of that are let go
// (scriptFoldersDeployed). Each step has its own catch, so one that fails
// cannot skip the steps after it, nor what follows the deploys (the Codex hook
// folders, the canvas skills, the backfill). A failing Claude picker deploy
// never leaves the Codex scripts missing on a fresh folder, or stale after an
// update. Later in the start, each registered provider that keeps resume-list
// pick folders sweeps the ones a killed run left (aicc_planning#407), each
// sweep by itself.
//
// Both loops go over the registered providers (providerMembers), so neither
// names a provider: a provider is reached because it offers the step, and one
// that does not is skipped.
//
// index.ts cannot be imported in a unit test (it boots the app), so the deploy
// chain and the sweep are cut out of its source, type-stripped with esbuild
// and run against fake providers in the real registry, as
// setup-terminal-quit-teardown.test.ts does with the quit teardown. Nothing is
// written.
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { registerProvider, getProvider, providerMembers, _resetProviderRegistryForTest } from '../../../src/main/providers/core'
import type { SessionProvider } from '../../../src/main/providers/types'
import type { ProviderId } from '../../../src/shared/providers'

const INDEX = fs.readFileSync(path.resolve(process.cwd(), 'src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The deploy chain: from the `Promise.resolve()` that starts it (the folder
 *  check is its first step) to the step that starts the Codex hook folders,
 *  which follows the deploys. */
const CHAIN = (() => {
  const folders = INDEX.indexOf('secureScriptFolders(getResourcesDirectory()')
  expect(folders, 'the scripts folders\' check').toBeGreaterThan(-1)
  const start = INDEX.lastIndexOf('Promise.resolve()', folders)
  expect(start, 'the chain start').toBeGreaterThan(-1)
  const next = INDEX.indexOf('.then(() => {\n        startCodexHookFolders(', folders)
  expect(next, 'the step after the deploys').toBeGreaterThan(folders)
  return INDEX.slice(start, next).trim()
})()

/** The sweep of left-over pick folders: from its comment to the step after it. */
const SWEEP = (() => {
  const from = INDEX.indexOf('// aicc_planning#407: the pick folders')
  expect(from, 'the sweep').toBeGreaterThan(-1)
  const to = INDEX.indexOf('endLeftoverConsoleHostsAtStart()', from)
  expect(to, 'the step after the sweep').toBeGreaterThan(from)
  return INDEX.slice(from, to)
})()

const js = (cut: string): string => transformSync(cut, { loader: 'ts', target: 'es2022', format: 'esm' }).code

/** A fake provider, registered, with the members given and nothing else. */
const register = (id: ProviderId, members: Record<string, unknown>): void => {
  registerProvider({ id, displayName: id, ...members } as unknown as SessionProvider)
}

/** What both cuts run with: the real registry's lookup and its loop. */
const context = (extra: Record<string, unknown>): vm.Context => vm.createContext({ Promise, getProvider, providerMembers, ...extra })

type Step = 'folders' | 'statusline' | 'claude-picker' | 'codex-statusline' | 'codex-picker' | 'deployed'
type DeployMember = 'deployStatuslineScript' | 'deployResumePickerScript'
/** Which deploys each provider offers, by the step each records. */
type Offered = Partial<Record<ProviderId, Partial<Record<DeployMember, Step>>>>

/** Runs the chain with the providers `offered` registered; `fails` names the
 *  steps that reject. Resolves with the steps that ran, what each deploy was
 *  handed, the warnings logged, and whether what follows the deploys ran. */
async function runChain(offered: Offered, fails: Step[]): Promise<{ ran: Step[]; handed: unknown[]; warned: string[]; after: boolean }> {
  const ran: Step[] = []
  const handed: unknown[] = []
  const warned: string[] = []
  const step = (name: Step) => async (...a: unknown[]): Promise<void> => {
    ran.push(name)
    handed.push(...a)
    if (fails.includes(name)) throw Object.assign(new Error(`EPERM: ${name}`), { code: 'EPERM' })
  }
  for (const [id, members] of Object.entries(offered) as Array<[ProviderId, Partial<Record<DeployMember, Step>>]>) {
    register(id, Object.fromEntries(Object.entries(members).map(([member, name]) => [member, step(name)])))
  }
  const rule = (): void => {}
  const folders: unknown[][] = []
  // The closing parenthesis on a line of its own: the cut may end in a comment.
  const chain = vm.runInContext(js(`(${CHAIN}\n)`), context({
    getResourcesDirectory: () => 'C:\\res',
    secureScriptFoldersRule: rule,
    secureScriptFolders: (...a: unknown[]) => { folders.push(a); return step('folders')() },
    scriptFoldersDeployed: () => { ran.push('deployed') },
    console: { warn: (...a: unknown[]) => { warned.push(a.map(String).join(' ')) } },
  })) as Promise<unknown>
  let after = false
  await chain.then(() => { after = true })
  expect(folders).toEqual([['C:\\res', rule]])
  return { ran, handed, warned, after }
}

/** Today's providers: Claude Code's statusline script and resume picker, and
 *  Codex's resume picker (with its hook forwarder). */
const TODAY: Offered = {
  claude: { deployStatuslineScript: 'statusline', deployResumePickerScript: 'claude-picker' },
  codex: { deployResumePickerScript: 'codex-picker' },
}

const ALL: Step[] = ['folders', 'statusline', 'claude-picker', 'codex-picker', 'deployed']

beforeEach(() => { _resetProviderRegistryForTest() })

describe('the start\'s script deploys', () => {
  // Mutations to prove this can fail: deploy before the folder check; let the
  // launches go before the deploys ran; name a provider in place of the loop.
  it('with nothing failing: the scripts folders checked first (the resources folder, the scripts folders\' rule), the three deploys in order, then the launches let go, and the start goes on', async () => {
    const r = await runChain(TODAY, [])
    expect(r.ran).toEqual(ALL)
    expect(r.handed).toEqual(['C:\\res', 'C:\\res', 'C:\\res'])
    expect(r.warned).toEqual([])
    expect(r.after).toBe(true)
  })

  it.each([
    ['folders'],
    ['statusline'],
    ['claude-picker'],
    ['codex-picker'],
  ] as Array<[Step]>)('the %s step failing skips no other step, the launches are still let go last, and the start goes on', async (failing) => {
    const r = await runChain(TODAY, [failing])
    expect(r.ran).toEqual(ALL)
    expect(r.warned).toHaveLength(1)
    expect(r.warned[0]).toContain(`EPERM: ${failing}`)
    expect(r.after).toBe(true)
  })

  it('every step failing: each is still tried, each logs its own warning, the launches are let go, and the start goes on', async () => {
    const r = await runChain(TODAY, ['folders', 'statusline', 'claude-picker', 'codex-picker'])
    expect(r.ran).toEqual(ALL)
    expect(r.warned).toHaveLength(4)
    expect(r.after).toBe(true)
  })

  it('each registered provider\'s deploys run once, provider by provider, and a provider that does not offer one is skipped for it', async () => {
    // The other way round from today: the first provider offers its resume
    // picker only, the second its statusline script and its picker; the
    // second's statusline deploy fails and is caught by itself.
    const swapped: Offered = {
      claude: { deployResumePickerScript: 'claude-picker' },
      codex: { deployStatuslineScript: 'codex-statusline', deployResumePickerScript: 'codex-picker' },
    }
    const r = await runChain(swapped, ['codex-statusline'])
    expect(r.ran).toEqual(['folders', 'claude-picker', 'codex-statusline', 'codex-picker', 'deployed'])
    expect(r.warned).toHaveLength(1)
    expect(r.warned[0]).toContain('EPERM: codex-statusline')
    expect(r.after).toBe(true)
  })

  it('a deploy is called on its own provider', async () => {
    const on: unknown[] = []
    register('codex', { deployResumePickerScript(this: unknown) { on.push(this); return Promise.resolve() } })
    await (vm.runInContext(js(`(${CHAIN}\n)`), context({
      getResourcesDirectory: () => 'C:\\res', secureScriptFoldersRule: () => {}, secureScriptFolders: async () => {}, scriptFoldersDeployed: () => {}, console: { warn: () => {} },
    })) as Promise<unknown>)
    expect(on).toEqual([getProvider('codex')])
  })
})

describe('the start\'s sweep of left-over pick folders', () => {
  /** Registers a provider per entry, whose sweep records the provider it was
   *  called on and, for `throws`, then throws; runs the cut sweep and gives
   *  back the sweeps that ran, in order. */
  function runSweep(sweeps: Partial<Record<ProviderId, 'ok' | 'throws' | 'none'>>): string[] {
    const ran: string[] = []
    for (const [id, how] of Object.entries(sweeps) as Array<[ProviderId, 'ok' | 'throws' | 'none']>) {
      register(id, how === 'none' ? {} : {
        sweepLeftoverPickFolders(this: SessionProvider) { ran.push(this.id); if (how === 'throws') throw new Error(`EBUSY: ${id}`) },
      })
    }
    vm.runInContext(js(SWEEP), context({}))
    return ran
  }

  it('each registered provider that keeps pick folders sweeps once, on itself, in the registry\'s order', () => {
    expect(runSweep({ claude: 'ok', codex: 'ok' })).toEqual(['claude', 'codex'])
  })

  it('a sweep that throws does not stop the next provider\'s, and the start goes on', () => {
    expect(runSweep({ claude: 'throws', codex: 'ok' })).toEqual(['claude', 'codex'])
  })

  it('a provider without a sweep is skipped, and the one that has a sweep still runs it', () => {
    expect(runSweep({ claude: 'ok', codex: 'none' })).toEqual(['claude'])
  })
})
