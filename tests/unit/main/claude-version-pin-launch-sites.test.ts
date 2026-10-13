// A Claude Code version pinned in an older release is no longer used to
// launch (2.1.1-beta.3). Every launch path runs the installed Claude Code, so
// none of them asks the folder of pinned versions anything, installs into it,
// or tells the launch preflight about a pin. The module that manages that
// folder stays, reached only by its own maintenance handlers; the setting
// stays in saved configs, untouched. The behaviour is held per site by
// claude-version-pin-not-used.test.ts (resolveClaudeBinary),
// pty-claude-version-pin-not-used.test.ts (the launch line),
// pty-spawn-provider-off.test.ts (no install at pty:spawn) and
// cloud-agent-claude-start.test.ts (cloud agents); this file keeps a new
// caller from appearing. Reads source only; nothing runs.
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** Every production source file, by its path from the repo root. */
function productionSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = `${dir}/${name}`
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel)
      else if (/\.(ts|tsx|js|cjs|mjs)$/.test(name)) out.push(rel)
    }
  }
  walk('src')
  return out
}

/** The paths that start Claude Code for a session or a cloud agent. */
const LAUNCH_SITES = [
  'src/main/providers/claude/spawn.ts',
  'src/main/pty-manager.ts',
  'src/main/ipc/pty-handlers.ts',
  'src/main/cloud-agent-manager.ts',
  'src/main/spawn-claude-command.ts',
]

/** The module that manages the folder of pinned versions, and its own handlers. */
const MANAGER = 'src/main/legacy-version-manager.ts'
const MANAGER_HANDLERS = 'src/main/ipc/legacy-version-handlers.ts'

describe('no launch path consults a Claude Code version pinned in an older release', () => {
  it('each launch site asks the folder of pinned versions nothing and passes no pin to the preflight', () => {
    for (const site of LAUNCH_SITES) {
      const text = read(site)
      expect(text.length, site).toBeGreaterThan(0)
      expect(text, `${site} asks the folder of pinned versions nothing`).not.toMatch(/\b(legacyCliPin|resolveVersionBinary|isVersionInstalled|installVersion)\b/)
      expect(text, `${site} passes no pin to the launch preflight`).not.toMatch(/\bpinnedCli\b/)
    }
  })

  // A static import, a dynamic import() and a require() all count, with or
  // without a file extension.
  const IMPORTS_MANAGER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"`][./]*(?:[\w-]+\/)*legacy-version-manager(?:\.[cm]?[jt]s)?['"`]/

  it('only the manager\'s own handlers import the manager', () => {
    const importers = productionSources().filter((f) => f !== MANAGER && IMPORTS_MANAGER.test(read(f)))
    expect(importers).toEqual([MANAGER_HANDLERS])
  })

  it('the import check sees every way of loading the manager', () => {
    for (const line of [
      "import { resolveVersionBinary } from './legacy-version-manager'",
      "import * as m from '../legacy-version-manager.ts'",
      "const m = await import('./legacy-version-manager')",
      'const m = await import ( "../../main/legacy-version-manager.js" )',
      "const m = require('./legacy-version-manager')",
      'const m = require(`./legacy-version-manager`)',
    ]) expect(IMPORTS_MANAGER.test(line), line).toBe(true)
    expect(IMPORTS_MANAGER.test("import { x } from './legacy-version'")).toBe(false)
    expect(IMPORTS_MANAGER.test("import { x } from './legacy-version-manager-notes'")).toBe(false)
  })

  // A launch that worked out the folder's path itself, without the manager,
  // would get past the import check above. The folder's name appears in main
  // only in the manager and its own handlers.
  it('no other main-process file names the folder of pinned versions', () => {
    const FOLDER = 'claude-versions'
    expect(read(MANAGER), 'the manager names the folder, as this check spells it').toContain(FOLDER)
    const naming = productionSources().filter((f) => f.startsWith('src/main/') && f !== MANAGER && f !== MANAGER_HANDLERS && read(f).includes(FOLDER))
    expect(naming).toEqual([])
  })

  it('the manager is still there, and so is the saved setting it read', () => {
    expect(fs.existsSync(path.join(ROOT, MANAGER))).toBe(true)
    expect(read('src/shared/types.ts')).toMatch(/legacyVersion\?:/)
  })
})
