// HOST QUARANTINE: starts real processes (Node on a copy of the CI line's stand-in Codex, in a temp folder of its own). [CI] [VM] only -- never run on the owner's machine.
/**
 * nubbymong/aicc_planning#446 (2.1.3-beta.21, plan block 6): the stand-in
 * Codex the remote-helper-e2e job puts on the sshd account's login PATH
 * (helper/probes/pv-codex-stand-in.cjs, REMOTE_REVIEW_CODEX=stand-in in
 * tests/live/remote-review.live.ts) reads as the Codex package reads the real
 * one: its version, its model list and its review events by the package's own
 * rules, and any other command line exits 2.
 *
 * It starts Node on a copy of the script, so it is kept apart from
 * remote-review.test.ts, which starts nothing and runs on the host.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { codexRemoteReview } from '../../../src/main/providers/codex/remote-review'

describe('the review line\'s stand-in in CI reads as the package reads the real one', () => {
  it('its version, its model list and its review events read by the package\'s own rules; any other command line exits 2', () => {
    // A copy in a folder of the test's own: it writes its record beside itself.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-pv-stand-in-'))
    const script = path.join(dir, 'codex.cjs')
    fs.copyFileSync(path.join(__dirname, '../../../helper/probes/pv-codex-stand-in.cjs'), script)
    // A minimal environment: never this process's whole one.
    const env: Record<string, string> = {}
    for (const k of ['SystemRoot', 'SYSTEMROOT']) if (process.env[k]) env[k] = process.env[k] as string
    const run = (args: string[], input = '') => spawnSync(process.execPath, [script, ...args], { input, env, encoding: 'utf8', timeout: 30_000 })
    try {
      const v = run(['--version'])
      expect([v.status, codexRemoteReview.parseVersion(v.stdout)]).toEqual([0, '0.157.1'])
      expect(codexRemoteReview.tooOld('0.157.1')).toBe(false)
      const m = run([...codexRemoteReview.modelListRead.words])
      expect(m.status).toBe(0)
      expect(codexRemoteReview.parseModelList(m.stdout)).toEqual([{ id: 'gpt-pv-1', label: 'PV One', efforts: ['low', 'medium', 'high'] }, { id: 'gpt-pv-2', label: 'PV Two' }])
      const args = codexRemoteReview.args({ effort: 'low' })
      if (!Array.isArray(args)) throw new Error('no argv')
      const e = run([...args], 'Review this.\ndiff --git a/a.ts b/a.ts\n+x\n')
      expect(e.status).toBe(0)
      const out = codexRemoteReview.readOutput(e.stdout)
      expect(out.text).toBe('PV stand-in review of 41 bytes. First change line: diff --git a/a.ts b/a.ts')
      expect(out.usage).toEqual({ inputTokens: 41, cachedInputTokens: 0, outputTokens: 9 })
      const rec = JSON.parse(fs.readFileSync(path.join(dir, 'codex-runs', fs.readdirSync(path.join(dir, 'codex-runs'))[0]), 'utf8')) as { argv: string[]; promptBytes: number }
      expect([rec.argv, rec.promptBytes]).toEqual([[...args], 41])
      expect(run(['login']).status).toBe(2)
    } finally {
      if (path.basename(dir).startsWith('aicc-pv-stand-in-')) fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
