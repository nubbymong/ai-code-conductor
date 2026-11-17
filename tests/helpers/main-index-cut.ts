// src/main/index.ts cannot be imported in a unit test (it boots the app). A
// suite that needs one of its blocks (the quit teardown, a window callback)
// cuts that block out of the source, type-strips it with esbuild and runs it
// against fakes. Every other name the block uses gets an inert stand-in, so a
// step another change adds does not break the suite.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

/** src/main/index.ts, with LF line ends. */
export const MAIN_INDEX = fs.readFileSync(path.resolve(process.cwd(), 'src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The text from `from` to the brace that closes the block opened by the
 *  first `{` at or after `from`. Strings, template literals and comments are
 *  skipped. Throws when there is no such block. */
export function block(src: string, from: number): string {
  let i = src.indexOf('{', from)
  if (i < 0) throw new Error('no opening brace')
  let depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(from, i + 1) }
  }
  throw new Error('unbalanced braces')
}

/** A stand-in for every other service the code calls: any property, any call,
 *  answers itself (so `getGateway()?.stop().catch(...)` runs), never a promise. */
function inert(): unknown {
  const f: unknown = new Proxy(() => {}, { get: (_t, k) => (k === 'then' ? undefined : f), apply: () => f })
  return f
}

/** Compile an arrow cut from the source and evaluate it with `fakes`; every
 *  other name it uses gets an inert stand-in. */
export function runCut<T>(code: string, fakes: Record<string, unknown>): T {
  const globals: Record<string, unknown> = {}
  for (const name of new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    if (!(name in globalThis)) globals[name] = inert()
  }
  const js = transformSync(`(${code})`, { loader: 'ts', target: 'es2022', format: 'esm' }).code
  return vm.runInContext(js, vm.createContext({ ...globals, console, ...fakes })) as T
}

/** The quit teardown's arrow (`quitTeardown = () => { ... }`), as source. */
export function quitTeardownSource(): string {
  const marker = 'quitTeardown = '
  const at = MAIN_INDEX.indexOf(`${marker}() => {`)
  if (at < 0) throw new Error('the quit teardown was not found in src/main/index.ts')
  return block(MAIN_INDEX, at + marker.length)
}
