import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Probe P7 (helper/probes/p7-windows-survival.ps1) cannot run in CI: it needs a
 * Windows machine and a real installer. What CAN be checked here is a mistake
 * that makes it fail for the wrong reason. PowerShell variable names are case
 * insensitive, and a type-constrained parameter keeps its type when a script
 * assigns to a variable of the same name in another case: `$installer = Start-
 * Process -PassThru` over `[string]$Installer` turned the process object into
 * text, and the next line then threw. No local may reuse a parameter's name.
 */

const ROOT = resolve(__dirname, '../../..')
const script = readFileSync(resolve(ROOT, 'helper/probes/p7-windows-survival.ps1'), 'utf-8').replace(/\r\n/g, '\n')

/** The script's own top-level parameters, from its param( ... ) block. */
function scriptParams(text: string): string[] {
  const m = /\n\[CmdletBinding\(\)\]\s*\nparam\(([\s\S]*?)\n\)\n/.exec(text)
  if (!m) throw new Error('the param block was not found')
  return [...m[1].matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((x) => x[1])
}

/** Every `$name =` assignment in the script, with its line number. */
function assignments(text: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = []
  text.split('\n').forEach((l, i) => {
    const m = /^\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(l)
    if (m) out.push({ name: m[1], line: i + 1 })
  })
  return out
}

describe('probe P7: no local variable reuses a parameter name in another case', () => {
  const params = scriptParams(script)

  it('finds the parameters it is checking against', () => {
    expect(params).toEqual(expect.arrayContaining(['HelperDir', 'Installer', 'InstallerArgs', 'InstallerTimeoutSec']))
  })

  it('assigns to no variable that case-insensitively equals a parameter, except the parameter-normalising lines near the top', () => {
    const lower = new Set(params.map((p) => p.toLowerCase()))
    // $HelperDir = (Resolve-Path ...) and $Installer = (Resolve-Path ...) re-assign the
    // parameter itself with the same type, which is the intent.
    const allowed = new Set(['HelperDir', 'Installer'])
    const clashes = assignments(script).filter((a) => lower.has(a.name.toLowerCase()) && !allowed.has(a.name))
    expect(clashes, `locals that collide with a parameter: ${JSON.stringify(clashes)}`).toEqual([])
  })

  it('keeps the installer process in its own variable', () => {
    expect(script).toMatch(/\$installerProc = Start-Process/)
    expect(script).not.toMatch(/\$installer\.(WaitForExit|ExitCode|Kill)/)
  })
})
