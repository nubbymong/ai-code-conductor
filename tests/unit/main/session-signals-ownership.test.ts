// One owner of what a hook event or a status line means (ADR-030 component
// row 13; 2.1.3-beta.8 section A2). The session signals module
// (src/main/session-signals/) is the only code in the main process that
// subscribes to the hooks gateway, and it holds the status line fan-out.
// Every other consumer takes hook events from the module (onHookEvent).
//
// This reads every tracked src/main/**/*.ts file and fails when a file outside
// the module subscribes to the gateway or still defines the old status
// fan-out (fanOutStatusline). A subscription is found by what it is called
// on, not by a variable's name: anything that holds the gateway counts,
// whatever it is called (see the self-test at the end, which proves each way
// of reaching the gateway is seen).
//
// What holds the gateway, per file: a getGateway() call (under any import
// name, or through a namespace import); a function handed to onGateway (its
// first parameter); anything typed HooksGatewayLike, HooksGateway or
// HooksGatewayProxy; a new HooksGateway or HooksGatewayProxy; what a
// ServiceSupervisor's start() returns; anything handed to setGateway; and any
// name or `this` field set from one of those, through casts, `!`, `?.`, `??`
// and aliases. A subscription is reading `subscribe` from one of them: a
// call, a bracket read, a `.bind`, or a destructuring.
//
// Not checked here: the gateway's own implementation (src/main/hooks/, and
// the proxy, which hands its own subscribers to the in-process gateway when it
// falls back to it), and a gateway passed to an untyped helper defined in
// another file.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from '@babel/parser'

const ROOT = resolve(__dirname, '..', '..', '..')
const MODULE_DIR = 'src/main/session-signals/'
/** The gateway's own implementation, which subscribes to itself. */
const GATEWAY_IMPLEMENTATION = (p: string) => p.startsWith('src/main/hooks/') || p === 'src/main/services/hooks-gateway-proxy.ts'

const GATEWAY_TYPES = new Set(['HooksGatewayLike', 'HooksGateway', 'HooksGatewayProxy'])
const GATEWAY_CLASSES = new Set(['HooksGateway', 'HooksGatewayProxy'])
const TRACKED_NAMES = new Set(['getGateway', 'onGateway', 'setGateway', 'ServiceSupervisor', ...GATEWAY_TYPES])

type N = { type: string; loc?: { start: { line: number } }; [k: string]: any }
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range'])

function walk(node: N, visit: (n: N) => void): void {
  visit(node)
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue
    const v = node[key]
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, visit) }
    else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, visit)
  }
}

/** The lines of `code` where `subscribe` is read from the hooks gateway. */
export function gatewaySubscriptions(code: string): number[] {
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true }).program as unknown as N

  // Import names: `import { getGateway as g }` makes `g` mean getGateway.
  const alias = new Map<string, string>()
  walk(ast, (n) => {
    if (n.type === 'ImportSpecifier' && TRACKED_NAMES.has(n.imported?.name ?? n.imported?.value)) alias.set(n.local.name, n.imported.name ?? n.imported.value)
  })
  const canonical = (name: string) => alias.get(name) ?? name
  const nameOf = (callee: N | undefined): string | null => {
    if (!callee) return null
    if (callee.type === 'Identifier') return canonical(callee.name)
    if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && !callee.computed && callee.property?.type === 'Identifier') return callee.property.name
    return null
  }
  const namesGatewayType = (t: N | undefined): boolean => {
    let found = false
    if (t) walk(t, (n) => {
      if (n.type !== 'TSTypeReference') return
      const tn = n.typeName
      const name = tn?.type === 'Identifier' ? canonical(tn.name) : tn?.type === 'TSQualifiedName' ? tn.right?.name : null
      if (name && GATEWAY_TYPES.has(name)) found = true
    })
    return found
  }

  const gateways = new Set<string>()      // names (and `this.x` fields) that hold the gateway
  const supervisors = new Set<string>()
  const keyOf = (e: N | undefined): string | null => {
    if (!e) return null
    if (e.type === 'Identifier') return e.name
    if ((e.type === 'MemberExpression' || e.type === 'OptionalMemberExpression') && e.object?.type === 'ThisExpression' && !e.computed && e.property?.type === 'Identifier') return `this.${e.property.name}`
    return null
  }
  const unwrap = (e: N | undefined): N | undefined => {
    while (e && ['TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ParenthesizedExpression', 'AwaitExpression'].includes(e.type)) e = e.expression ?? e.argument
    return e
  }
  const isGateway = (raw: N | undefined): boolean => {
    const e = unwrap(raw)
    if (!e) return false
    if (e.type === 'LogicalExpression') return isGateway(e.left) || isGateway(e.right)
    if (e.type === 'ConditionalExpression') return isGateway(e.consequent) || isGateway(e.alternate)
    if (e.type === 'SequenceExpression') return isGateway(e.expressions[e.expressions.length - 1])
    if (e.type === 'CallExpression' || e.type === 'OptionalCallExpression') {
      if (nameOf(e.callee) === 'getGateway') return true
      const c = unwrap(e.callee)
      if ((c?.type === 'MemberExpression' || c?.type === 'OptionalMemberExpression') && !c.computed && c.property?.name === 'start') {
        const o = unwrap(c.object)
        const k = keyOf(o)
        if ((k && supervisors.has(k)) || (o?.type === 'NewExpression' && nameOf(o.callee) === 'ServiceSupervisor')) return true
      }
      return false
    }
    if (e.type === 'NewExpression') return GATEWAY_CLASSES.has(nameOf(e.callee) ?? '')
    const k = keyOf(e)
    return k !== null && gateways.has(k)
  }

  const functionsByName = new Map<string, N>()
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) functionsByName.set(n.id.name, n)
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(n.init?.type)) functionsByName.set(n.id.name, n.init)
  })
  const firstParam = (fn: N | undefined): string | null => {
    const p = fn?.params?.[0]
    if (p?.type === 'Identifier') return p.name
    if (p?.type === 'AssignmentPattern' && p.left?.type === 'Identifier') return p.left.name
    return null
  }

  // Grow the set of gateway holders until nothing new is found (aliases of aliases).
  for (let size = -1; size !== gateways.size + supervisors.size;) {
    size = gateways.size + supervisors.size
    walk(ast, (n) => {
      if (n.type === 'VariableDeclarator') {
        const k = keyOf(n.id)
        if (k && (isGateway(n.init) || namesGatewayType(n.id.typeAnnotation))) gateways.add(k)
        if (k && unwrap(n.init)?.type === 'NewExpression' && nameOf(unwrap(n.init)!.callee) === 'ServiceSupervisor') supervisors.add(k)
      } else if (n.type === 'AssignmentExpression') {
        const k = keyOf(n.left)
        if (k && isGateway(n.right)) gateways.add(k)
        if (k && unwrap(n.right)?.type === 'NewExpression' && nameOf(unwrap(n.right)!.callee) === 'ServiceSupervisor') supervisors.add(k)
      } else if (n.type === 'ClassProperty' || n.type === 'ClassPrivateProperty') {
        const name = n.key?.name ?? n.key?.id?.name
        if (name && (namesGatewayType(n.typeAnnotation) || isGateway(n.value))) gateways.add(`this.${name}`)
      } else if (n.type === 'Identifier' && n.typeAnnotation && namesGatewayType(n.typeAnnotation)) {
        gateways.add(n.name)                                   // a parameter or a field typed as the gateway
      } else if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
        const callee = nameOf(n.callee)
        if (callee === 'onGateway') {
          for (const a of n.arguments) {
            const fn = ['ArrowFunctionExpression', 'FunctionExpression'].includes(a.type) ? a : a.type === 'Identifier' ? functionsByName.get(a.name) : undefined
            const p = firstParam(fn)
            if (p) gateways.add(p)
          }
        }
        if (callee === 'setGateway') { const k = keyOf(unwrap(n.arguments[0])); if (k) gateways.add(k) }
      }
    })
  }

  const lines = new Set<number>()
  walk(ast, (n) => {
    if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') {
      const prop = n.computed ? (n.property?.type === 'StringLiteral' ? n.property.value : null) : n.property?.name
      if (prop === 'subscribe' && isGateway(n.object)) lines.add(n.loc!.start.line)
    }
    if (n.type === 'VariableDeclarator' && n.id?.type === 'ObjectPattern' && isGateway(n.init)) {
      if (n.id.properties.some((p: N) => p.type === 'ObjectProperty' && (p.key?.name ?? p.key?.value) === 'subscribe')) lines.add(n.loc!.start.line)
    }
  })
  return [...lines].sort((a, b) => a - b)
}

/** The lines of `code` that name the old status fan-out. */
export function statusFanOutNames(code: string): number[] {
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true }).program as unknown as N
  const lines: number[] = []
  walk(ast, (n) => { if (n.type === 'Identifier' && n.name === 'fanOutStatusline') lines.push(n.loc!.start.line) })
  return lines
}

const tracked = execFileSync('git', ['ls-files', '-z', '--', 'src/main/*.ts'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter((p) => p.endsWith('.ts'))
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

describe('the session signals module is the one owner of what a hook event or status line means (A2)', () => {
  it('reads the main process source', () => {
    expect(tracked.length).toBeGreaterThan(100)
    expect(tracked).toContain('src/main/session-signals/hooks.ts')
    expect(tracked).toContain('src/main/session-signals/status.ts')
  })

  it('no file outside the module subscribes to the hooks gateway', () => {
    const found: string[] = []
    for (const p of tracked) {
      if (p.startsWith(MODULE_DIR) || GATEWAY_IMPLEMENTATION(p)) continue
      for (const line of gatewaySubscriptions(read(p))) found.push(`${p}:${line}`)
    }
    expect(found, `subscribe to the gateway through onHookEvent (src/main/session-signals/hooks.ts) instead:\n${found.join('\n')}`).toEqual([])
  })

  it('no file outside the module defines or calls the old status fan-out', () => {
    const found: string[] = []
    for (const p of tracked) {
      if (p.startsWith(MODULE_DIR)) continue
      for (const line of statusFanOutNames(read(p))) found.push(`${p}:${line}`)
    }
    expect(found, `the status fan-out is deliverStatus (src/main/session-signals/status.ts):\n${found.join('\n')}`).toEqual([])
  })

  it('inside the module, exactly one subscription to the gateway, in hooks.ts', () => {
    const found: string[] = []
    for (const p of tracked.filter((q) => q.startsWith(MODULE_DIR))) {
      for (const line of gatewaySubscriptions(read(p))) found.push(`${p}:${line}`)
    }
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/^src\/main\/session-signals\/hooks\.ts:\d+$/)
  })
})

describe('the check sees a gateway subscription however the gateway is named or reached (verify the verifier)', () => {
  const flagged: Array<[string, string]> = [
    ['a renamed variable', `import { getGateway } from './hooks/index'\nconst hooksBackbone = getGateway()\nhooksBackbone?.subscribe(cb)`],
    ['an import alias', `import { getGateway as gg } from './hooks/index'\ngg()!.subscribe(cb)`],
    ['a namespace import', `import * as hooks from './hooks'\nhooks.getGateway()?.subscribe(cb)`],
    ['a direct call', `getGateway()?.subscribe((e) => { use(e) })`],
    ['an onGateway callback, any parameter name', `onGateway((anything) => anything.subscribe(cb))`],
    ['an aliased onGateway', `import { onGateway as whenSet } from '../hooks/index'\nwhenSet(function (x) { return x.subscribe(cb) })`],
    ['a named function handed to onGateway', `function bindIt(g) { return g.subscribe(cb) }\nonGateway(bindIt)`],
    ['a parameter typed as the gateway', `function wire(target: HooksGatewayLike) { target.subscribe(cb) }`],
    ['an aliased gateway type', `import type { HooksGatewayLike as Feed } from './hooks'\nconst f = (src: Feed | null) => src?.subscribe(cb)`],
    ['a class field', `class X {\n  private feed: HooksGatewayLike | null = null\n  go() { this.feed?.subscribe(cb) }\n}`],
    ['a field set from getGateway', `class Y { go() { this.g = getGateway(); this.g!.subscribe(cb) } }`],
    ['an alias of an alias', `const a = getGateway()\nconst b = a\nconst c = b as any\nc.subscribe(cb)`],
    ['a fallback', `const g = getGateway() ?? other\ng.subscribe(cb)`],
    ['a destructured subscribe', `const { subscribe } = getGateway()!\nsubscribe(cb)`],
    ['a bracket read', `getGateway()!['subscribe'](cb)`],
    ['a bound subscribe', `const s = getGateway()!.subscribe.bind(null)`],
    ['a gateway built here', `const p = new HooksGateway({ defaultPort: 0 })\np.subscribe(cb)`],
    ['a supervisor\'s proxy', `const sup = new ServiceSupervisor({})\nconst proxy = sup.start()\nproxy.subscribe(cb)`],
    ['what is handed to setGateway', `setGateway(made)\nmade.subscribe(cb)`],
  ]
  for (const [what, code] of flagged) {
    it(`flags ${what}`, () => { expect(gatewaySubscriptions(code).length).toBeGreaterThan(0) })
  }

  const clean: Array<[string, string]> = [
    ['another service\'s subscribe', `getAccountsService()?.subscribe(listener)`],
    ['a lease store', `deps.leases().subscribe(() => {})`],
    ['a state store', `const s = getSentinelState()\ns?.subscribe(cb)`],
    ['the module\'s own entry', `onHookEvent((e) => use(e))`],
    ['a gateway used for something else', `const gw = getGateway()\ngw?.registerSession(id)`],
  ]
  for (const [what, code] of clean) {
    it(`does not flag ${what}`, () => { expect(gatewaySubscriptions(code)).toEqual([]) })
  }

  it('finds the old status fan-out by name in code, not in a comment', () => {
    expect(statusFanOutNames(`function fanOutStatusline(d) {}\nfanOutStatusline(x)`)).toEqual([1, 2])
    expect(statusFanOutNames(`// fanOutStatusline moved\nconst y = 1`)).toEqual([])
  })
})
