// The screenshot history menu is gone (aicc_planning#435, plan 2.1.3-beta.19
// section 5).
//
// ScreenshotContextMenu was rendered nowhere: no user could open it. It was
// the only caller of sendStoryboardToSession and of the screenshot:listRecent
// chain (preload, handler, listRecentScreenshots, channel constant, type).
// All of it is removed, and so is every sentence a user or a model could read
// about a "storyboard" (a feature the app dropped in 1.4).
//
// WHAT THIS HOLDS, read from the source tree as text (no app, no IPC):
//  1. No file under src/main, src/renderer, src/shared or src/preload says
//     "storyboard" in code or in a string or in JSX text. Comments are left
//     out, and so is src/renderer/changelog.ts (release history).
//  2. The channel constant, its string, the handler's function and the
//     renderer's call are gone, comments included.
//  3. The menu's file and its one-use time helper are gone, and nothing
//     imports either.
// Not checked here: the image door (image-transfer-*.test.ts, session.test.ts
// "an image paste"), which this change leaves as it was.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, resolve, sep } from 'path'

const ROOT = resolve(__dirname, '../../..')
const SRC_DIRS = ['src/main', 'src/renderer', 'src/shared', 'src/preload']

function sourceFiles(): string[] {
  const out: string[] = []
  for (const dir of SRC_DIRS) {
    for (const rel of readdirSync(join(ROOT, dir), { recursive: true }) as string[]) {
      if (/\.(ts|tsx)$/.test(rel)) out.push(join(dir, rel).split(sep).join('/'))
    }
  }
  return out
}

/** The text with every comment blanked and nothing else changed: strings (and
 *  the code inside a template literal's `${}`) are kept as written. A string
 *  ends at its closing quote or at the end of its line. */
function withoutComments(src: string): string {
  let out = ''
  let i = 0
  let inTemplate = false
  const depth: number[] = [] // one per open template: braces open inside its `${`
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]
    if (inTemplate) {
      if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
      if (c === '`') { inTemplate = false; out += c; i++; continue }
      if (c === '$' && d === '{') { depth.push(0); inTemplate = false; out += '${'; i += 2; continue }
      out += c; i++; continue
    }
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      out += ' '
      continue
    }
    if (c === '\'' || c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === '`') { inTemplate = true; out += c; i++; continue }
    if (c === '{' && depth.length) depth[depth.length - 1]++
    if (c === '}' && depth.length) {
      if (depth[depth.length - 1] === 0) { depth.pop(); inTemplate = true; out += c; i++; continue }
      depth[depth.length - 1]--
    }
    out += c; i++
  }
  return out
}

describe('the screenshot history menu is removed', () => {
  const files = sourceFiles()

  it('the comment reader keeps text and drops comments (so the check below can fail)', () => {
    expect(withoutComments('// storyboard\nconst a = 1')).not.toMatch(/storyboard/i)
    expect(withoutComments('/* a\n storyboard */ const a = 1')).not.toMatch(/storyboard/i)
    expect(withoutComments('const a = \'a storyboard\'')).toMatch(/storyboard/)
    expect(withoutComments('const a = "http://x" // storyboard')).not.toMatch(/storyboard/i)
    expect(withoutComments('const a = `x ${b} storyboard`')).toMatch(/storyboard/)
    expect(withoutComments('const a = `x ${ `y` } ${ {z: 1}.z } storyboard`')).toMatch(/storyboard/)
    expect(withoutComments('<p>Used by storyboard frames</p>')).toMatch(/storyboard/)
    expect(withoutComments('function sendStoryboardToSession() {}')).toMatch(/storyboard/i)
  })

  it('no source file says "storyboard" in code, a string or JSX text (changelog history and comments aside)', () => {
    const hits: string[] = []
    for (const f of files) {
      if (f === 'src/renderer/changelog.ts') continue
      const raw = readFileSync(join(ROOT, f), 'utf8')
      if (!/storyboard/i.test(raw)) continue
      const code = withoutComments(raw)
      for (const line of code.split('\n')) {
        if (/storyboard/i.test(line)) hits.push(`${f}: ${line.trim().slice(0, 120)}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('the screenshot:listRecent chain is gone, comments included', () => {
    const names = ['SCREENSHOT_LIST_RECENT', 'screenshot:listRecent', 'listRecentScreenshots', 'listRecent']
    const hits: string[] = []
    for (const f of files) {
      const raw = readFileSync(join(ROOT, f), 'utf8')
      for (const name of names) if (raw.includes(name)) hits.push(`${f}: ${name}`)
    }
    expect(hits).toEqual([])
  })

  it('the menu and its time helper are gone, and nothing imports either', () => {
    expect(existsSync(join(ROOT, 'src/renderer/components/ScreenshotContextMenu.tsx'))).toBe(false)
    expect(existsSync(join(ROOT, 'src/renderer/utils/screenshotPath.ts'))).toBe(false)
    const hits: string[] = []
    for (const f of files) {
      const raw = readFileSync(join(ROOT, f), 'utf8')
      if (/ScreenshotContextMenu|screenshotPath/.test(raw)) hits.push(f)
    }
    expect(hits).toEqual([])
  })
})
