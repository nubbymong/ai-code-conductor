// aicc_planning#117: the main-process half of "Always start a new
// conversation". The spawn option `freshConversation` may only REMOVE a resume.
// The helper is pinned directly; its wiring is read from the source, because
// the terminal manager's spawn and the IPC handler are not started by a unit
// test here (the same idiom as account-profiles-owner-only-wiring.test.ts).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { resumeUnlessFresh } from '../../../src/main/fresh-conversation'
import { spawnOptionsSchema } from '../../../src/main/ipc/pty-handlers'

/** A source file with its whole-line comments taken out. */
function code(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8').replace(/\r\n/g, '\n').replace(/^[ \t]*\/\/.*$/gm, '')
}

const target = { uuid: 'u-1', cwd: 'C:/wt' }

describe('resumeUnlessFresh', () => {
  it('drops the target only for freshConversation === true', () => {
    expect(resumeUnlessFresh({ freshConversation: true }, target)).toBeUndefined()
    expect(resumeUnlessFresh({ freshConversation: false }, target)).toBe(target)
    expect(resumeUnlessFresh({}, target)).toBe(target)
    expect(resumeUnlessFresh(undefined, target)).toBe(target)
    expect(resumeUnlessFresh({ freshConversation: 'true' as unknown as boolean }, target)).toBe(target)
  })

  it('never invents a target', () => {
    expect(resumeUnlessFresh({ freshConversation: true }, undefined)).toBeUndefined()
    expect(resumeUnlessFresh({ freshConversation: false }, undefined)).toBeUndefined()
  })
})

describe('spawnOptionsSchema.freshConversation', () => {
  const base = { cwd: 'C:/proj', cols: 80, rows: 24 }
  it('accepts a boolean or nothing', () => {
    expect(spawnOptionsSchema.safeParse({ ...base, freshConversation: true }).success).toBe(true)
    expect(spawnOptionsSchema.safeParse({ ...base, freshConversation: false }).success).toBe(true)
    expect(spawnOptionsSchema.safeParse(base).success).toBe(true)
  })
  it('refuses anything else', () => {
    for (const v of ['true', 1, {}, null]) {
      expect(spawnOptionsSchema.safeParse({ ...base, freshConversation: v }).success).toBe(false)
    }
  })
})

describe('wiring', () => {
  const mgr = code('src/main/pty-manager.ts')
  const handlers = code('src/main/ipc/pty-handlers.ts')

  it('every resume target main reads goes through resumeUnlessFresh', () => {
    // the launch gate, the Claude exact resume, the Codex resume
    expect(mgr).toContain('resumeUnlessFresh(options, options?.resume ?? getLastResumeTarget(sessionId))')
    expect(mgr).toContain('resumeUnlessFresh(options, persistedTarget ?? selfCapturedTarget)')
    expect(mgr).toMatch(/let resumeTarget = resumeUnlessFresh\(options, options\?\.resume \?\? /)
    expect(mgr.match(/resumeUnlessFresh\(/g)).toHaveLength(3)
  })

  it('the Claude branch still consumes the self-captured target first', () => {
    expect(mgr).toMatch(/clearLastResumeTarget\(sessionId\)\s*const effectiveTarget = resumeUnlessFresh\(/)
  })

  it('a fresh spawn skips the Codex account carry', () => {
    expect(handlers).toContain('if (!options?.resume && !options?.useResumePicker && !options?.freshConversation) carry =')
  })
})
