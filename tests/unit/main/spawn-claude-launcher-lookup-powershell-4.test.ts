// HOST QUARANTINE: starts real processes (Windows PowerShell 5.1, PowerShell 7 when present, cmd.exe). [CI] [VM] only -- never run on the owner's machine.
// Part 4 of 4 of the launcher lookup checks in real shells. The cases,
// what they prove and why they are split are in
// spawn-claude-launcher-lookup-powershell-harness.ts.
import { vi } from 'vitest'

// node.exe is never found, so a route that would start the resume list
// starts Claude Code itself; every other lookup is the real one.
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  const nodeOnly = (names: readonly string[]): boolean => names.length === 1 && names[0] === 'node.exe'
  return {
    ...actual,
    findOnWindowsPath: ((names, ...rest) => (nodeOnly(names) ? null : actual.findOnWindowsPath(names, ...rest))) as typeof actual.findOnWindowsPath,
    findOnWindowsPathAsync: (async (names, ...rest) => (nodeOnly(names) ? null : actual.findOnWindowsPathAsync(names, ...rest))) as typeof actual.findOnWindowsPathAsync,
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
import { describeLauncherLookup } from './spawn-claude-launcher-lookup-powershell-harness'

describeLauncherLookup(4, 4)
