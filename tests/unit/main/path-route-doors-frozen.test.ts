// The path route's doors stay byte for byte as they were at 49a8ddb9
// (2.1.3-beta.20) for this beta (ADR-032; plan 2.1.3-beta.21 phase 2, 2.1.3,
// 2.1.6 and Q5): the C2 proof runs the path route beside the clipboard route
// in one job, so the path route must be the one that failed under load, not
// a changed one. Each door's source (line endings read as LF) is held to the
// SHA-256 of its text at 49a8ddb9:
//  - Codex's path paste (src/main/providers/codex/session-screen.ts,
//    pasteImageIntoCodexComposer, :452 there);
//  - Claude Code's path paste (src/main/providers/claude/run-screen.ts,
//    pasteClaudeImage, :129 there);
//  - the renderer's typed path into Codex (src/renderer/lib/codexComposer.ts,
//    sendImagePathToCodex, :351-366 there).
// They are deleted in 2.1.3-beta.22 with this test. A change to any of them
// in this beta fails here.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = resolve(__dirname, '..', '..', '..')
const body = (file: string, head: string): string => {
  const text = readFileSync(resolve(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
  const i = text.indexOf(head)
  expect(i, `${head} in ${file}`).toBeGreaterThanOrEqual(0)
  const j = text.indexOf('\n}\n', i)
  return text.slice(i, j + 3)
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

describe('the path route\'s doors are as they were at 49a8ddb9', () => {
  it.each([
    ['src/main/providers/codex/session-screen.ts', 'export async function pasteImageIntoCodexComposer(', 'c7dddc5e73778bf82b5915894fed1d5a7ce52a6f3f105797defebced4ae97f9f'],
    ['src/main/providers/claude/run-screen.ts', 'async function pasteClaudeImage(', 'da7d78f2ab3e45e2d5d1896e8ffcf50d0489a7539c13a6486bbb7d2c7dbb3b43'],
    ['src/renderer/lib/codexComposer.ts', 'export function sendImagePathToCodex(', '94848ef77eac2ffa92f1a9e5f6548e74ed063000a077900e841be3d8c0fac9dd'],
  ])('%s: %s', (file, head, expected) => {
    expect(sha(body(file, head))).toBe(expected)
  })
})
