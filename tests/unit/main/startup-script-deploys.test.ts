// [host] At start the main process puts the app's own scripts in the resources
// folder in three steps: the statusline script, the Claude resume picker, and
// the Codex resume picker with the Codex hook forwarder. Before them, the
// scripts folders go through the owner-only rule (script-folders.ts
// secureScriptFolders, with the scripts folders' rule); after them, the
// launches waiting for all of that are let go (scriptFoldersDeployed). Each
// step has its own catch, so one that fails cannot skip the steps after it,
// nor what follows the deploys (the Codex hook folders, the canvas skills, the
// backfill). A failing Claude picker deploy never leaves the Codex scripts
// missing on a fresh folder, or stale after an update.
//
// index.ts cannot be imported in a unit test (it boots the app), so the deploy
// chain is cut out of its source, type-stripped with esbuild and run against
// fakes, as setup-terminal-quit-teardown.test.ts does with the quit teardown.
// Nothing is written.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const INDEX = fs.readFileSync(path.resolve(process.cwd(), 'src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The deploy chain: from the `Promise.resolve()` that starts it to the step
 *  that starts the Codex hook folders, which follows the deploys. */
const CHAIN = (() => {
  const first = INDEX.indexOf("getProvider('claude').deployStatuslineScript")
  expect(first, 'the statusline deploy').toBeGreaterThan(-1)
  const start = INDEX.lastIndexOf('Promise.resolve()', first)
  expect(start, 'the chain start').toBeGreaterThan(-1)
  const next = INDEX.indexOf('.then(() => {\n        startCodexHookFolders(', first)
  expect(next, 'the step after the deploys').toBeGreaterThan(first)
  return INDEX.slice(start, next).trim()
})()

type Step = 'folders' | 'statusline' | 'claude-picker' | 'codex-picker' | 'deployed'

/** Runs the chain with fake providers; `fails` names the steps that reject.
 *  Resolves with the steps that ran, the warnings logged, and whether what
 *  follows the deploys ran. */
async function runChain(fails: Step[]): Promise<{ ran: Step[]; warned: string[]; after: boolean }> {
  const ran: Step[] = []
  const warned: string[] = []
  const step = (name: Step) => async (): Promise<void> => {
    ran.push(name)
    if (fails.includes(name)) throw Object.assign(new Error(`EPERM: ${name}`), { code: 'EPERM' })
  }
  const providers = {
    claude: { deployStatuslineScript: step('statusline'), deployResumePickerScript: step('claude-picker') },
    codex: { deployResumePickerScript: step('codex-picker') },
  }
  const rule = (): void => {}
  const folders: unknown[][] = []
  // The closing parenthesis on a line of its own: the cut may end in a comment.
  const js = transformSync(`(${CHAIN}\n)`, { loader: 'ts', target: 'es2022', format: 'esm' }).code
  const chain = vm.runInContext(js, vm.createContext({
    Promise,
    getProvider: (id: 'claude' | 'codex') => providers[id],
    getResourcesDirectory: () => 'C:\\res',
    secureScriptFoldersRule: rule,
    secureScriptFolders: (...a: unknown[]) => { folders.push(a); return step('folders')() },
    scriptFoldersDeployed: () => { ran.push('deployed') },
    console: { warn: (...a: unknown[]) => { warned.push(a.map(String).join(' ')) } },
  })) as Promise<unknown>
  let after = false
  await chain.then(() => { after = true })
  expect(folders).toEqual([['C:\\res', rule]])
  return { ran, warned, after }
}

const ALL: Step[] = ['folders', 'statusline', 'claude-picker', 'codex-picker', 'deployed']

describe('the start\'s script deploys', () => {
  // Mutations to prove this can fail: deploy before the folder check; let the
  // launches go before the deploys ran.
  it('with nothing failing: the scripts folders checked first (the resources folder, the scripts folders\' rule), the three deploys in order, then the launches let go, and the start goes on', async () => {
    const r = await runChain([])
    expect(r.ran).toEqual(ALL)
    expect(r.warned).toEqual([])
    expect(r.after).toBe(true)
  })

  it.each([
    ['folders'],
    ['statusline'],
    ['claude-picker'],
    ['codex-picker'],
  ] as Array<[Step]>)('the %s step failing skips no other step, the launches are still let go last, and the start goes on', async (failing) => {
    const r = await runChain([failing])
    expect(r.ran).toEqual(ALL)
    expect(r.warned).toHaveLength(1)
    expect(r.warned[0]).toContain(`EPERM: ${failing}`)
    expect(r.after).toBe(true)
  })

  it('every step failing: each is still tried, each logs its own warning, the launches are let go, and the start goes on', async () => {
    const r = await runChain(['folders', 'statusline', 'claude-picker', 'codex-picker'])
    expect(r.ran).toEqual(ALL)
    expect(r.warned).toHaveLength(4)
    expect(r.after).toBe(true)
  })
})
