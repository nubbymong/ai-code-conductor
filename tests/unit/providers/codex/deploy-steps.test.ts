// The provider's start-time deploy puts two things in the resources folder:
// the resume picker (with its helper lib) and the hook forwarder (with its
// Windows wrapper). Each is tried whatever the other did, and the first
// failure is passed on once both were tried (a failed picker deploy never
// skips the hook scripts). Both deploys are faked:
// nothing is written.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  order: [] as string[],
  fails: new Set<'picker' | 'hooks'>(),
}))
vi.mock('../../../../src/main/providers/codex/resume-picker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/providers/codex/resume-picker')>()),
  deployCodexResumePickerScript: async (dir: string) => {
    h.order.push(`picker ${dir}`)
    if (h.fails.has('picker')) throw new Error('picker deploy failed')
  },
}))
vi.mock('../../../../src/main/providers/codex/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/providers/codex/hooks')>()),
  deployCodexHookScripts: async (dir: string) => {
    h.order.push(`hooks ${dir}`)
    if (h.fails.has('hooks')) throw new Error('hook deploy failed')
  },
}))

const { CodexProvider } = await import('../../../../src/main/providers/codex')

const RES = 'C:\\res'
beforeEach(() => {
  h.order.length = 0
  h.fails.clear()
})

describe('the start-time deploy of the resume picker and the hook scripts', () => {
  it('both run, the picker first', async () => {
    await new CodexProvider().deployResumePickerScript(RES)
    expect(h.order).toEqual([`picker ${RES}`, `hooks ${RES}`])
  })

  it('a failed picker deploy does not skip the hook scripts, and its failure is passed on', async () => {
    h.fails.add('picker')
    await expect(new CodexProvider().deployResumePickerScript(RES)).rejects.toThrow('picker deploy failed')
    expect(h.order).toEqual([`picker ${RES}`, `hooks ${RES}`])
  })

  it('a failed hook deploy is passed on too', async () => {
    h.fails.add('hooks')
    await expect(new CodexProvider().deployResumePickerScript(RES)).rejects.toThrow('hook deploy failed')
    expect(h.order).toEqual([`picker ${RES}`, `hooks ${RES}`])
  })

  it('both failing: both are tried, and the first failure is the one passed on', async () => {
    h.fails.add('picker')
    h.fails.add('hooks')
    await expect(new CodexProvider().deployResumePickerScript(RES)).rejects.toThrow('picker deploy failed')
    expect(h.order).toEqual([`picker ${RES}`, `hooks ${RES}`])
  })
})
