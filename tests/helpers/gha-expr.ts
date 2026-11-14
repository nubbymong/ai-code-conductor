/**
 * A small evaluator for GitHub Actions expressions, enough to truth-table the
 * `if:` conditions and the concurrency group of this repo's workflows in a
 * unit test (tests/unit/scripts/ci-cadence.test.ts). Pinning the text of a
 * condition proves nothing about what it does; evaluating it does.
 *
 * Covered, as GitHub documents them: `||`, `&&` (binds tighter), `!`, `==`,
 * `!=`, parentheses, single-quoted strings ('' is a quote), numbers, true,
 * false, null, context paths with the `.*` filter, and the functions
 * contains, startsWith, endsWith, format, fromJSON and the four status
 * functions. Comparison is loose as GitHub's is: strings ignore case, and
 * values of different types are compared as numbers. A missing property is
 * null. Anything else throws, so a test never passes on a guess.
 */
export type GhaContext = Record<string, unknown>

type Tok = { t: 'op' | 'str' | 'num' | 'id'; v: string }

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === "'") {
      let s = ''
      i++
      for (;;) {
        if (i >= src.length) throw new Error(`unterminated string in: ${src}`)
        if (src[i] === "'") { if (src[i + 1] === "'") { s += "'"; i += 2; continue } i++; break }
        s += src[i++]
      }
      out.push({ t: 'str', v: s })
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === '&&' || two === '||' || two === '==' || two === '!=') { out.push({ t: 'op', v: two }); i += 2; continue }
    if ('()!,.*[]'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i))
    if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i))
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue }
    throw new Error(`unexpected "${c}" in: ${src}`)
  }
  return out
}

const truthy = (v: unknown): boolean => !(v === false || v === null || v === undefined || v === '' || v === 0 || (typeof v === 'number' && Number.isNaN(v)))

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  if (typeof v === 'string') return v.trim() === '' ? 0 : Number(v)
  return NaN
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null
  if (b === undefined) b = null
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase()
  if (typeof a === typeof b && (a === null) === (b === null)) return a === b
  if ((typeof a === 'object' && a !== null) || (typeof b === 'object' && b !== null)) return false
  return toNumber(a) === toNumber(b)
}

const asString = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v))

const FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  contains: ([search, item]) => Array.isArray(search)
    ? search.some((x) => looseEquals(x, item))
    : asString(search).toLowerCase().includes(asString(item).toLowerCase()),
  startswith: ([s, p]) => asString(s).toLowerCase().startsWith(asString(p).toLowerCase()),
  endswith: ([s, p]) => asString(s).toLowerCase().endsWith(asString(p).toLowerCase()),
  format: ([f, ...rest]) => asString(f).replace(/\{(\d+)\}/g, (_m, n: string) => {
    if (Number(n) >= rest.length) throw new Error(`format() has no argument {${n}}`)
    return asString(rest[Number(n)])
  }),
  fromjson: ([s]) => JSON.parse(asString(s)),
  success: () => true,
  always: () => true,
  failure: () => false,
  cancelled: () => false,
}

class Parser {
  private at = 0
  constructor(private readonly toks: Tok[], private readonly ctx: GhaContext, private readonly src: string) {}

  private peek(v?: string): boolean {
    const k = this.toks[this.at]
    return !!k && (v === undefined || (k.t === 'op' && k.v === v))
  }
  private eat(v: string): void {
    if (!this.peek(v)) throw new Error(`expected "${v}" at token ${this.at} in: ${this.src}`)
    this.at++
  }

  parse(): unknown {
    const v = this.or()
    if (this.at !== this.toks.length) throw new Error(`unexpected "${this.toks[this.at].v}" in: ${this.src}`)
    return v
  }
  // Both sides are always evaluated (a lookup has no side effect), and the
  // value is an operand, as in GitHub: `a && b || c` picks b or c.
  private or(): unknown {
    let l = this.and()
    while (this.peek('||')) { this.at++; const r = this.and(); l = truthy(l) ? l : r }
    return l
  }
  private and(): unknown {
    let l = this.eq()
    while (this.peek('&&')) { this.at++; const r = this.eq(); l = truthy(l) ? r : l }
    return l
  }
  private eq(): unknown {
    let l = this.unary()
    while (this.peek('==') || this.peek('!=')) {
      const op = this.toks[this.at++].v
      const r = this.unary()
      l = op === '==' ? looseEquals(l, r) : !looseEquals(l, r)
    }
    return l
  }
  private unary(): unknown {
    if (this.peek('!')) { this.at++; return !truthy(this.unary()) }
    return this.primary()
  }
  private primary(): unknown {
    const k = this.toks[this.at]
    if (!k) throw new Error(`unexpected end of: ${this.src}`)
    if (k.t === 'op' && k.v === '(') { this.at++; const v = this.or(); this.eat(')'); return v }
    if (k.t === 'str') { this.at++; return k.v }
    if (k.t === 'num') { this.at++; return Number(k.v) }
    if (k.t !== 'id') throw new Error(`unexpected "${k.v}" in: ${this.src}`)
    this.at++
    if (k.v === 'true') return true
    if (k.v === 'false') return false
    if (k.v === 'null') return null
    if (this.peek('(')) {
      const fn = FUNCTIONS[k.v.toLowerCase()]
      if (!fn) throw new Error(`unsupported function ${k.v}() in: ${this.src}`)
      this.at++
      const args: unknown[] = []
      if (!this.peek(')')) { args.push(this.or()); while (this.peek(',')) { this.at++; args.push(this.or()) } }
      this.eat(')')
      return fn(args)
    }
    if (!(k.v in this.ctx)) throw new Error(`unknown context "${k.v}" in: ${this.src}`)
    let v: unknown = this.ctx[k.v]
    for (;;) {
      if (this.peek('.')) {
        this.at++
        const n = this.toks[this.at++]
        if (n && n.t === 'op' && n.v === '*') { v = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []; v = new Filtered(v as unknown[]); continue }
        if (!n || (n.t !== 'id' && n.t !== 'num')) throw new Error(`bad property in: ${this.src}`)
        v = prop(v, n.v)
        continue
      }
      if (this.peek('[')) { this.at++; const key = this.or(); this.eat(']'); v = prop(v, asString(key)); continue }
      break
    }
    return v instanceof Filtered ? v.items : v
  }
}

/** The result of a `.*` filter: a later property applies to every item. */
class Filtered { constructor(readonly items: unknown[]) {} }

function prop(v: unknown, name: string): unknown {
  if (v instanceof Filtered) return new Filtered(v.items.map((x) => prop(x, name)).filter((x) => x !== null))
  if (v === null || v === undefined || typeof v !== 'object') return null
  const hit = Object.keys(v as object).find((k) => k.toLowerCase() === name.toLowerCase())
  return hit === undefined ? null : (v as Record<string, unknown>)[hit] ?? null
}

/** Evaluate one bare expression (no `${{ }}` around it). */
export function evalExpr(expr: string, ctx: GhaContext): unknown {
  return new Parser(lex(expr), ctx, expr).parse()
}

/** Evaluate a workflow value: a bare expression, one `${{ }}` (its value), or
 *  text with `${{ }}` parts (a string). */
export function evalValue(value: unknown, ctx: GhaContext): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  const whole = /^\$\{\{([\s\S]*)\}\}$/.exec(text)
  if (whole && !whole[1].includes('${{')) return evalExpr(whole[1], ctx)
  if (!text.includes('${{')) return evalExpr(text, ctx)
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_m, e: string) => asString(evalExpr(e, ctx)))
}

/** An `if:` as GitHub decides it. */
export function evalIf(value: unknown, ctx: GhaContext): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'boolean') return value
  return truthy(evalValue(value, ctx))
}
