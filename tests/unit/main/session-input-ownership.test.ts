// One door for the app's own typing into a session (ADR-030 component row 3's
// submit; 2.1.3-beta.9 section A1). The session input module
// (src/main/session-input/) is the only code in the main process that types
// into a session's terminal on main's own initiative: the Watchdog's retry,
// an Agent Canvas marker, Ask Conductor's question. Every other caller asks
// the module (submitLine, typeKeys, submitMarker, askQuestion,
// handOffAskQuestion).
//
// This reads every src/main/**/*.ts file and finds, in each file outside the
// module, every place that types into a session's terminal:
//  - writePty, writeSubmittedLine, pastePty, writeCanvasMarkerLine,
//    handOffAskQuestion or submitCodexText named in code, under any import
//    name: called, or handed on as a value (an argument, a property, a name,
//    an array element, a return, a bind); and the same read from any object,
//    a namespace import included, called or handed on. A call counts once.
//    The module's own exports are the door: a name imported from
//    src/main/session-input, or read from a namespace import of it, is not
//    counted, whatever it is;
//  - `.submit` read from a provider's run screen: anything traced to a
//    `.runScreen` read or typed SessionRunScreen;
//  - `.write` read from a PTY handle: anything typed IPty or HelperPty, the
//    result of node-pty's spawn, spawnPlainPty, spawnAgentPty or spawnRunPty
//    (under any import name), a `new HelperPty`, a `.ptyProcess` read, a
//    function in the same file that returns one, a call handed a function
//    that returns one (a start wrapped in a timing helper), and any name or
//    `this` field set from those, through casts, `!`, `?.`, `??` and aliases;
//    and, as a backstop, by name: `.write` read from anything named
//    ptyProcess, cliSetupPty, codexRun or pane (the Codex run screen's pane,
//    which holds the raw writer the PTY manager hands it).
// Each site is grouped by the named function it is in (a function
// declaration, a function set to a name, a method; else the top level). The
// committed allow-list below keeps today's other sites, each group with its
// count, its reason and the slice that removes it. A count above its entry
// fails, a group not listed fails, and a count below its entry fails and says
// to lower it, so the list only shrinks. The self-test at the end feeds each
// shape.
//
// Not checked here: the renderer (its typing moves with S13), a PTY handle
// held in an object property other than `ptyProcess` or passed to an untyped
// parameter, a writer reached through a field of an injected dependency
// object (`deps.write`: the composer rule's and the Watchdog's own writers,
// handed in by the PTY manager and by this module), and a computed property
// name other than a string literal.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import { parse } from '@babel/parser'

const ROOT = resolve(__dirname, '..', '..', '..')
const MODULE_DIR = 'src/main/session-input/'

/** The functions that type into a session: today's, and the ones they replaced. */
const TYPING_FUNCTIONS = new Set(['writePty', 'writeSubmittedLine', 'pastePty', 'writeCanvasMarkerLine', 'handOffAskQuestion', 'submitCodexText'])
const PTY_TYPES = new Set(['IPty', 'HelperPty'])
const PTY_STARTS = new Set(['spawnPlainPty', 'spawnAgentPty', 'spawnRunPty'])
const SCREEN_TYPES = new Set(['SessionRunScreen'])
const BY_NAME = new Set(['ptyProcess', 'cliSetupPty', 'codexRun', 'pane'])
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'])

type Allowed = { count: number; why: string; until: string }
/**
 * Today's other sites, by file and by the function they are in. Lower a count
 * when its sites go, take an entry out when none is left; never raise one and
 * never add one (type through the module instead).
 */
const ALLOWED: Record<string, Record<string, Allowed>> = {
  'src/main/pty-manager.ts': {
    '(top level)': { count: 1, why: "the session input module's write port, registered when the PTY manager loads: writePty, the one writer the module types through", until: 'stays' },
    writePty: { count: 1, why: "writePty itself: the tab's own keystrokes (pty:write) and the module's one writer, with the duplicate guard and the launch-pending buffer", until: 'stays' },
    writeChunked: { count: 1, why: "writePty's chunked writer, for a write over 256 bytes", until: 'stays' },
    releaseLaunchHold: { count: 1, why: 'the replay of the writes held while the launch line was pending', until: 'S11 (the launch spec, locally)' },
    endSshRemoteDetailed: { count: 1, why: "the End exec's own ssh terminal: its password or sudo answer (not a session's terminal)", until: 'S25 (the launch spec, remotely)' },
    probeTmuxLive: { count: 1, why: "the liveness probe's own ssh terminal: its password answer (not a session's terminal)", until: 'S25 (the launch spec, remotely)' },
    writeHostSetupCmd: { count: 1, why: 'the SSH launch sequence: the host setup line', until: 'S25 (the launch spec, remotely)' },
    writePostCommand: { count: 1, why: 'the SSH launch sequence: the post-connect command', until: 'S25 (the launch spec, remotely)' },
    writeContainerSetupCmd: { count: 1, why: 'the SSH launch sequence: the container setup line', until: 'S25 (the launch spec, remotely)' },
    startEntryGuard: { count: 1, why: 'the SSH launch sequence: the container entry guard', until: 'S25 (the launch spec, remotely)' },
    writeClaudeCmd: { count: 1, why: 'the SSH launch sequence: the Claude Code launch line', until: 'S25 (the launch spec, remotely)' },
    handleWrappedLaunchFailure: { count: 1, why: 'the SSH launch sequence: the bare launch after a tmux-wrapped one failed', until: 'S25 (the launch spec, remotely)' },
    writeTmuxStageCmd: { count: 2, why: 'the SSH launch sequence: the architecture probe and the tmux stage', until: 'S25 (the launch spec, remotely)' },
    attemptTmuxPush: { count: 3, why: 'the SSH launch sequence: the tmux push, its Ctrl-C and its clean-up line', until: 'S25 (the launch spec, remotely)' },
    spawnPtyResolved: {
      count: 10,
      why: "in the SSH branch the tmux patch (2), the password and sudo answers (2) and the partner folder line (1); in the local branch the folder line, the launch line and a plain terminal's start command (3); the Codex pane writer, the raw writer the run screen types through, reached only through this module, and the Codex colour answer, a terminal reply (2)",
      until: 'S25 and S11 (the launch writes); the pane writer and the colour answer stay',
    },
    writeEnvelopeChunked: { count: 1, why: "the channel envelope writer (a Tier 1 paste)", until: 'A2' },
    gracefulExitPty: { count: 3, why: 'the quit keys: Escape, Ctrl-C and /exit', until: 'A2' },
  },
  'src/main/ipc/pty-handlers.ts': {
    registerPtyHandlers: { count: 1, why: "pty:write, the renderer's own typing into the tab", until: "S13 (the renderer's typing moves once main holds a Claude Code screen)" },
  },
  'src/main/channel-bus.ts': {
    send: { count: 1, why: 'pastePty: a channel message, as a Tier 1 paste', until: 'A2' },
  },
  'src/main/ipc/setup-handlers.ts': {
    writeCliSetupPty: { count: 1, why: 'the first-run terminal (declared exception 10)', until: 'stays (exception 10)' },
    registerSetupHandlers: { count: 1, why: 'the first-run terminal: its claude line (declared exception 10)', until: 'stays (exception 10)' },
  },
  'src/main/insights-runner.ts': {
    sendInsights: { count: 1, why: "Insights' own report terminal: /insights", until: 'S18' },
    acceptTrustPrompt: { count: 1, why: "Insights' own report terminal: the trust prompt's Enter", until: 'S18' },
    spawnClaudeInsights: { count: 1, why: "Insights' own report terminal: /exit", until: 'S18' },
  },
  'src/main/providers/codex/session-screen.ts': {
    run: { count: 1, why: 'the pane writer: the raw writer the Codex run screen types through, reached only through runScreen.submit, which only this module calls', until: 'stays' },
  },
  'src/main/providers/codex/index.ts': {
    '(top level)': { count: 1, why: "the Codex package's runScreen.submit itself, handing a submission to its pane (submitCodexText)", until: 'stays' },
  },
  'src/main/session-helper/helper-pty.ts': {
    write: { count: 1, why: "the session helper's transport: a held terminal's input, as raw input frames, or into the direct terminal", until: 'stays' },
    fallBack: { count: 1, why: "the session helper's transport: the input queued before a fall back to a direct terminal", until: 'stays' },
  },
}

type N = { type: string; start: number; loc?: { start: { line: number } }; [k: string]: any }
type Site = { line: number; what: string; in: string }
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range'])

/** Visit every node with its ancestors; a visitor that returns false skips that node's children. */
function walk(node: N, visit: (n: N, ancestors: N[]) => void | false, ancestors: N[] = []): void {
  if (visit(node, ancestors) === false) return
  ancestors.push(node)
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue
    const v = node[key]
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, visit, ancestors) }
    else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, visit, ancestors)
  }
  ancestors.pop()
}

/** Parse TypeScript. Anything the parser could not read fails loudly, naming
 *  the file: a partial tree could hide a write. */
function parseTs(code: string, label: string): N {
  let file: { program: N; errors?: Array<{ message?: string }> }
  try {
    file = parse(code, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true }) as unknown as typeof file
  } catch (err) {
    throw new Error(`${label}: the parser could not read it: ${(err as Error).message}`)
  }
  const errors = file.errors ?? []
  if (errors.length > 0) throw new Error(`${label}: the parser could not read it: ${errors.map((e) => e.message).join('; ')}`)
  return file.program
}

/** Where an import specifier points, as a repo path with no extension. */
function importTarget(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  return posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.(ts|js)$/, '').replace(/\/index$/, '')
}
const isModuleImport = (file: string, spec: string): boolean => importTarget(file, spec) === MODULE_DIR.slice(0, -1)

/** Every place in `code` that types into a session's terminal. `file` is the
 *  file's repo path (it decides which imports are the module's). */
export function typingSites(code: string, file = 'src/main/snippet.ts'): Site[] {
  const ast = parseTs(code, file)
  const door = new Set<string>()          // names imported from the module
  const doorNamespaces = new Set<string>()
  const typingImports = new Map<string, string>()
  const startNames = new Set<string>()
  const typeAlias = new Map<string, string>()
  const nodePtyNamespaces = new Set<string>()
  const nodePtySpawn = new Set<string>()
  walk(ast, (n) => {
    if (n.type !== 'ImportDeclaration') return
    const src = String(n.source.value)
    for (const s of n.specifiers as N[]) {
      if (s.type === 'ImportSpecifier') {
        const imported = s.imported.name ?? s.imported.value
        if (isModuleImport(file, src)) { door.add(s.local.name); continue }
        if (TYPING_FUNCTIONS.has(imported)) typingImports.set(s.local.name, imported)
        if (PTY_STARTS.has(imported)) startNames.add(s.local.name)
        if (PTY_TYPES.has(imported) || SCREEN_TYPES.has(imported)) typeAlias.set(s.local.name, imported)
        if (src === 'node-pty' && imported === 'spawn') nodePtySpawn.add(s.local.name)
      } else {
        if (src === 'node-pty') nodePtyNamespaces.add(s.local.name)
        if (isModuleImport(file, src)) doorNamespaces.add(s.local.name)
      }
    }
  })
  const typeName = (name: string): string => typeAlias.get(name) ?? name
  const namesType = (t: N | undefined, set: Set<string>): boolean => {
    let found = false
    if (t) walk(t, (n) => {
      if (n.type !== 'TSTypeReference') return
      const tn = n.typeName
      const name = tn?.type === 'Identifier' ? typeName(tn.name) : tn?.type === 'TSQualifiedName' ? tn.right?.name : null
      if (name && set.has(name)) found = true
    })
    return found
  }
  const functionsByName = new Map<string, N>()
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) functionsByName.set(n.id.name, n)
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(n.init?.type)) functionsByName.set(n.id.name, n.init)
  })
  /** What a function returns (its own returns, not those of a function nested in it). */
  const returnsOf = (fn: N): N[] => {
    if (fn.body?.type !== 'BlockStatement') return fn.body ? [fn.body] : []
    const out: N[] = []
    walk(fn.body, (n) => {
      if (FUNCTION_TYPES.has(n.type)) return false
      if (n.type === 'ReturnStatement' && n.argument) out.push(n.argument)
    })
    return out
  }
  const keyOf = (e: N | undefined): string | null => {
    if (!e) return null
    if (e.type === 'Identifier') return e.name
    if (isMember(e) && e.object?.type === 'ThisExpression' && !e.computed && e.property?.type === 'Identifier') return `this.${e.property.name}`
    return null
  }
  const unwrap = (e: N | undefined): N | undefined => {
    while (e && ['TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ParenthesizedExpression', 'AwaitExpression'].includes(e.type)) e = e.expression ?? e.argument
    return e
  }
  function isMember(e: N | undefined): boolean { return e?.type === 'MemberExpression' || e?.type === 'OptionalMemberExpression' }
  const isCall = (e: N | undefined): boolean => e?.type === 'CallExpression' || e?.type === 'OptionalCallExpression'
  const propName = (m: N): string | null => (m.computed ? (m.property?.type === 'StringLiteral' ? m.property.value : null) : m.property?.name ?? null)

  const handles = new Set<string>()
  const screens = new Set<string>()
  const following = new Set<string>()
  /** Whether `raw` holds what `own` recognises, directly, through a name or
   *  field in `held`, or as what a function in this file returns. */
  const traced = (raw: N | undefined, held: Set<string>, own: (e: N) => boolean): boolean => {
    const e = unwrap(raw)
    if (!e) return false
    if (e.type === 'LogicalExpression') return traced(e.left, held, own) || traced(e.right, held, own)
    if (e.type === 'ConditionalExpression') return traced(e.consequent, held, own) || traced(e.alternate, held, own)
    if (e.type === 'SequenceExpression') return traced(e.expressions[e.expressions.length - 1], held, own)
    if (own(e)) return true
    if (isCall(e)) {
      const c = unwrap(e.callee)
      if (c?.type === 'Identifier' && functionsByName.has(c.name) && !following.has(c.name)) {
        following.add(c.name)
        try { if (returnsOf(functionsByName.get(c.name)!).some((r) => traced(r, held, own))) return true } finally { following.delete(c.name) }
      }
      return false
    }
    const k = keyOf(e)
    return k !== null && held.has(k)
  }
  const isHandle = (e: N | undefined): boolean => traced(e, handles, ownHandle)
  function ownHandle(e: N): boolean {
    if (isMember(e) && propName(e) === 'ptyProcess') return true
    if (e.type === 'NewExpression' && e.callee?.type === 'Identifier' && typeName(e.callee.name) === 'HelperPty') return true
    if (!isCall(e)) return false
    const c = unwrap(e.callee)
    if (c?.type === 'Identifier' && (startNames.has(c.name) || PTY_STARTS.has(c.name) || nodePtySpawn.has(c.name))) return true
    if (c && isMember(c) && propName(c) === 'spawn' && c.object?.type === 'Identifier' && nodePtyNamespaces.has(c.object.name)) return true
    if (c && isMember(c) && PTY_STARTS.has(propName(c) ?? '')) return true
    // A start wrapped in a helper: timedStart(cmd, () => pty.spawn(...)).
    for (const a of e.arguments as N[]) {
      if (['ArrowFunctionExpression', 'FunctionExpression'].includes(a.type) && returnsOf(a).some((r) => isHandle(r))) return true
    }
    return false
  }
  const isScreen = (e: N | undefined): boolean => traced(e, screens, (x) => isMember(x) && propName(x) === 'runScreen')

  // Grow the sets of holders until nothing new is found (aliases of aliases).
  for (let size = -1; size !== handles.size + screens.size;) {
    size = handles.size + screens.size
    walk(ast, (n) => {
      if (n.type === 'VariableDeclarator') {
        const k = keyOf(n.id)
        if (k && (isHandle(n.init) || namesType(n.id.typeAnnotation, PTY_TYPES))) handles.add(k)
        if (k && (isScreen(n.init) || namesType(n.id.typeAnnotation, SCREEN_TYPES))) screens.add(k)
      } else if (n.type === 'AssignmentExpression') {
        const k = keyOf(n.left)
        if (k && isHandle(n.right)) handles.add(k)
        if (k && isScreen(n.right)) screens.add(k)
      } else if (n.type === 'ClassProperty' || n.type === 'ClassPrivateProperty') {
        const name = n.key?.name ?? n.key?.id?.name
        if (name && (namesType(n.typeAnnotation, PTY_TYPES) || isHandle(n.value))) handles.add(`this.${name}`)
        if (name && (namesType(n.typeAnnotation, SCREEN_TYPES) || isScreen(n.value))) screens.add(`this.${name}`)
      } else if (n.type === 'Identifier' && n.typeAnnotation) {
        if (namesType(n.typeAnnotation, PTY_TYPES)) handles.add(n.name)     // a parameter or a field typed as a PTY
        if (namesType(n.typeAnnotation, SCREEN_TYPES)) screens.add(n.name)
      }
    })
  }

  const byName = (raw: N | undefined): boolean => {
    const e = unwrap(raw)
    if (e?.type === 'Identifier') return BY_NAME.has(e.name)
    if (e && isMember(e)) return BY_NAME.has(propName(e) ?? '')
    return false
  }
  const enclosing = (ancestors: N[]): string => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i]
      if (a.type === 'FunctionDeclaration' && a.id) return a.id.name
      if ((a.type === 'ClassMethod' || a.type === 'ObjectMethod' || a.type === 'ClassPrivateMethod') && (a.key?.name ?? a.key?.id?.name)) return a.key.name ?? a.key.id.name
      if (a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression') {
        const p = ancestors[i - 1]
        if (p?.type === 'VariableDeclarator' && p.id?.type === 'Identifier') return p.id.name
      }
    }
    return '(top level)'
  }
  const typingName = (name: string): boolean => !door.has(name) && (typingImports.has(name) || TYPING_FUNCTIONS.has(name))
  const sites = new Map<number, Site>()
  const add = (n: N, ancestors: N[], what: string): void => {
    if (!sites.has(n.start)) sites.set(n.start, { line: n.loc!.start.line, what, in: enclosing(ancestors) })
  }
  walk(ast, (n, ancestors) => {
    const parent = ancestors[ancestors.length - 1]
    // A typing function named in code: called, or handed on as a value
    // (an argument, a property, a name, an array element, a return, a bind).
    // A call and its callee start at the same place, so a call counts once.
    if (n.type === 'Identifier' && typingName(n.name) && isReference(n, parent, ancestors)) {
      const called = parent && isCall(parent) && parent.callee === n
      add(n, ancestors, called ? `${typingImports.get(n.name) ?? n.name}()` : `${n.name} handed on`)
    }
    if (isMember(n)) {
      const prop = propName(n)
      // The same through a namespace import or any other object, called or handed on.
      if (prop && TYPING_FUNCTIONS.has(prop) && !(n.object?.type === 'Identifier' && doorNamespaces.has(n.object.name))) add(n, ancestors, `.${prop}`)
      if (prop === 'write' && (isHandle(n.object) || byName(n.object))) add(n, ancestors, '.write on a PTY')
      if (prop === 'submit' && isScreen(n.object)) add(n, ancestors, '.submit on a run screen')
    }
  })
  return [...sites.values()].sort((a, b) => a.line - b.line)
}

const TYPE_ONLY = new Set(['TSTypeAnnotation', 'TSTypeQuery', 'TSTypeReference', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration'])
/** Whether an identifier is a value read, not a declaration, an import, a
 *  property's name or a type. */
function isReference(n: N, parent: N | undefined, ancestors: N[]): boolean {
  if (!parent) return true
  if (ancestors.some((a) => TYPE_ONLY.has(a.type))) return false
  if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type)) return false
  if (parent.type === 'ExportSpecifier') return parent.local === n
  if (parent.type === 'VariableDeclarator' && parent.id === n) return false
  if (FUNCTION_TYPES.has(parent.type) && (parent.id === n || (parent.params as N[]).includes(n))) return false
  if ((parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && parent.id === n) return false
  if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.property === n && !parent.computed) return false
  if (['ObjectProperty', 'ObjectMethod', 'ClassProperty', 'ClassMethod', 'ClassPrivateProperty'].includes(parent.type) && parent.key === n && !parent.computed && !parent.shorthand) return false
  return true
}

/** What is wrong with `found` (file -> sites) against the allow-list. */
export function allowListProblems(found: Record<string, Site[]>, allowed: Record<string, Record<string, Allowed>>): string[] {
  const problems: string[] = []
  const files = new Set([...Object.keys(found), ...Object.keys(allowed)])
  for (const file of [...files].sort()) {
    const groups = new Map<string, Site[]>()
    for (const s of found[file] ?? []) groups.set(s.in, [...(groups.get(s.in) ?? []), s])
    const names = new Set([...groups.keys(), ...Object.keys(allowed[file] ?? {})])
    for (const name of [...names].sort()) {
      const sites = groups.get(name) ?? []
      const entry = allowed[file]?.[name]
      const where = sites.map((s) => `${file}:${s.line} (${s.what})`).join(', ')
      if (!entry) problems.push(`NOT ALLOWED: ${where} in ${name}: type through src/main/session-input/ instead`)
      else if (sites.length > entry.count) problems.push(`OVER: ${file} ${name} has ${sites.length} sites, its entry allows ${entry.count}: ${where}`)
      else if (sites.length < entry.count) problems.push(`LOWER IT: ${file} ${name} has ${sites.length} sites, its entry still allows ${entry.count}: lower the entry${sites.length === 0 ? ' (take it out)' : ''}`)
    }
  }
  return problems
}

/** Every .ts file under src/main, as a repo-relative path. Read from the folder
 *  itself (no git process), so the suite starts nothing on the host. */
function mainSources(dir = join(ROOT, 'src', 'main'), out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') mainSources(p, out) }
    else if (entry.name.endsWith('.ts')) out.push(relative(ROOT, p).split(sep).join('/'))
  }
  return out
}
const sources = mainSources().sort()
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8')

describe('the session input module is the one door for the app\'s own typing into a session (A1)', () => {
  it('reads the main process source, the module included', () => {
    expect(sources.length).toBeGreaterThan(100)
    expect(sources).toContain('src/main/session-input/index.ts')
    for (const file of Object.keys(ALLOWED)) expect(sources).toContain(file)
  })

  it('every entry says why and which slice removes it', () => {
    for (const [file, groups] of Object.entries(ALLOWED)) {
      for (const [name, e] of Object.entries(groups)) {
        expect(e.count, `${file} ${name}`).toBeGreaterThan(0)
        expect(e.why.length, `${file} ${name}`).toBeGreaterThan(10)
        expect(e.until.length, `${file} ${name}`).toBeGreaterThan(1)
      }
    }
  })

  it('no file outside the module types into a session beyond the allow-list, and the list holds no more than is left', () => {
    const found: Record<string, Site[]> = {}
    for (const p of sources) {
      if (p.startsWith(MODULE_DIR)) continue
      const sites = typingSites(read(p), p)
      if (sites.length > 0) found[p] = sites
    }
    const problems = allowListProblems(found, ALLOWED)
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('the module imports nothing from the PTY manager: the PTY manager registers its ports with it', () => {
    const reach: string[] = []
    for (const p of sources.filter((q) => q.startsWith(MODULE_DIR))) {
      walk(parseTs(read(p), p), (n) => {
        const spec = n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration' ? n.source?.value
          : n.type === 'ImportExpression' ? n.source?.value
          : n.type === 'CallExpression' && (n.callee?.type === 'Import' || (n.callee?.type === 'Identifier' && n.callee.name === 'require')) ? n.arguments?.[0]?.value
          : undefined
        if (typeof spec === 'string' && importTarget(p, spec) === 'src/main/pty-manager') reach.push(`${p}:${n.loc!.start.line}`)
      })
    }
    expect(reach).toEqual([])
    let registrations = 0
    walk(parseTs(read('src/main/pty-manager.ts'), 'src/main/pty-manager.ts'), (n) => {
      if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'setSessionInputPorts') registrations++
    })
    expect(registrations).toBe(1)
  })
})

describe('the check sees each way of typing into a session (verify the verifier)', () => {
  const flagged: Array<[string, string]> = [
    ['a writePty call', `import { writePty } from './pty-manager'\nwritePty(id, 'x\\r')`],
    ['a writePty call under another name', `import { writePty as w } from './pty-manager'\nw(id, 'x')`],
    ['a call through a namespace import', `import * as pm from './pty-manager'\npm.writeSubmittedLine(id, 'continue')`],
    ['writeSubmittedLine', `writeSubmittedLine(id, 'continue')`],
    ['pastePty', `import { pastePty } from '../pty-manager'\npastePty(id, envelope)`],
    ['writeCanvasMarkerLine', `import { writeCanvasMarkerLine } from './pty-manager'\nconst a = writeCanvasMarkerLine(id, line)`],
    ['handOffAskQuestion from the PTY manager', `import { handOffAskQuestion } from '../pty-manager'\nhandOffAskQuestion(win, id, q)`],
    ['submitCodexText', `import { submitCodexText as send } from './session-screen'\nsend(id, text, { readyWaitMs: 1 })`],
    ['a typing function handed on as an argument', `import { writePty } from './pty-manager'\ninitWatchdog(writePty)`],
    ['a typing function handed on as a property', `import { writePty } from './pty-manager'\nstart({ write: writePty })`],
    ['a typing function handed on as a shorthand property', `import { writePty } from './pty-manager'\nstart({ writePty })`],
    ['a typing function set to a name', `import { writePty } from './pty-manager'\nconst w = writePty`],
    ['a typing function assigned', `import { writePty } from './pty-manager'\nlet w\nw = writePty`],
    ['a typing function in a list', `import { pastePty } from './pty-manager'\nconst writers = [pastePty]`],
    ['a typing function returned', `import { writePty } from './pty-manager'\nfunction pick() { return writePty }`],
    ['a typing function bound', `import { writePty } from './pty-manager'\nconst w = writePty.bind(null)`],
    ['a typing function re-exported', `export { writePty } from './pty-manager'`],
    ['a typing function destructured from a module object', `const { writePty } = require('./pty-manager')`],
    ['a namespace member handed on as a property', `import * as pm from './pty-manager'\nstart({ write: pm.writePty })`],
    ['a namespace member handed on as an argument', `import * as pm from './pty-manager'\ninitWatchdog(pm.writeSubmittedLine)`],
    ['a namespace member set to a name', `import * as pm from './pty-manager'\nconst w = pm.writePty`],
    ['a typing function read from another object', `deps.pastePty(id, envelope)`],
    ['a run screen\'s submit', `getProvider('codex').runScreen.submit(id, t, { readyWaitMs: 1 })`],
    ['a run screen read into a name', `const s = provider.runScreen\ns?.submit(id, t, o)`],
    ['a run screen from a function in the file', `function screen() { try { return getProvider('codex').runScreen } catch { return undefined } }\nconst x = screen()\nx!.submit(id, t, o)`],
    ['a run screen typed as one', `const go = (s: SessionRunScreen) => s.submit(id, t, o)`],
    ['a run screen\'s submit, bracketed', `provider.runScreen!['submit'](id, t, o)`],
    ['a parameter typed IPty', `import * as pty from 'node-pty'\nfunction f(p: pty.IPty) { p.write('x') }`],
    ['a name typed IPty', `import type { IPty } from 'node-pty'\nlet t: IPty | null = null\nt!.write('x')`],
    ['an aliased PTY type', `import type { IPty as Term } from 'node-pty'\nconst f = (t: Term) => t.write('x')`],
    ['a name typed HelperPty', `function f(t: HelperPty) { t.write('x') }`],
    ['node-pty\'s spawn', `import * as pty from 'node-pty'\nconst p = pty.spawn('sh', [], {})\np.write('x')`],
    ['node-pty\'s spawn under another name', `import { spawn as start } from 'node-pty'\nconst t = start('sh', [], {})\nt.write('x')`],
    ['spawnPlainPty', `const t = spawnPlainPty(ctx, f, a, o)\nt.write('x')`],
    ['spawnAgentPty under another name', `import { spawnAgentPty as agent } from './session-helper/manager'\nconst t = agent(ctx, f, a, o)\nt.write('x')`],
    ['spawnRunPty', `import { spawnRunPty } from './session-helper/manager'\nconst t = spawnRunPty(ctx, f, a, o)\nt.write('x')`],
    ['a new HelperPty', `new HelperPty(opts).write('x')`],
    ['a ptyProcess read', `sessions.get(id)?.ptyProcess.write('x')`],
    ['a name set from a ptyProcess read', `const proc = sessions.get(id)?.ptyProcess\nif (proc) proc.write('x')`],
    ['an alias of an alias', `const a = sessions.get(id)?.ptyProcess\nconst b = a\nconst c = b as any\nc.write('x')`],
    ['a fallback', `const t = sessions.get(id)?.ptyProcess ?? other\nt.write('x')`],
    ['a class field typed IPty', `class X {\n  private inner: IPty | undefined\n  go() { this.inner?.write('x') }\n}`],
    ['a field set from a start', `class Y { go() { this.t = spawnAgentPty(c, f, a, o); this.t.write('x') } }`],
    ['a start wrapped in a helper', `import * as pty from 'node-pty'\nconst proc = timedStart(cmd, () => pty.spawn(cmd, [], {}))\nproc.write('/insights\\r')`],
    ['a start from a function in the file', `const startIt = (o) => spawnAgentPty(c, f, a, o)\nconst run = startIt(1)\nrun.write('x')`],
    ['a bound write', `const w = sessions.get(id)!.ptyProcess.write.bind(null)`],
    ['by name: ptyProcess', `function f(ptyProcess) { ptyProcess.write('x') }`],
    ['by name: cliSetupPty', `cliSetupPty?.write(data)`],
    ['by name: codexRun', `const f = (codexRun) => codexRun.write(bytes)`],
    ['by name: the run screen\'s pane', `const pane = panes.get(id)\npane.write(data)`],
    ['by name: a field of another object', `deps.ptyProcess.write('x')`],
  ]
  for (const [what, code] of flagged) {
    it(`flags ${what}`, () => { expect(typingSites(code).length).toBeGreaterThan(0) })
  }

  const clean: Array<[string, string, string?]> = [
    ['the module\'s submitLine', `import { submitLine } from './session-input'\nsubmitLine(id, 'continue')`],
    ['the module\'s own handOffAskQuestion, from a folder below', `import { handOffAskQuestion } from '../session-input'\nhandOffAskQuestion(win, id, q)`, 'src/main/ipc/feature.ts'],
    ['the module through a namespace import', `import * as input from './session-input'\ninput.submitMarker(id, line)\ninput.handOffAskQuestion(win, id, q)`],
    ['the module named by its index file', `import { typeKeys } from './session-input/index'\nstart({ write: (s, d) => typeKeys(s, d) })`],
    ['the module\'s own exports handed on through its namespace', `import * as input from './session-input'\nstart({ write: input.typeKeys, ask: input.handOffAskQuestion })\nconst h = input.handOffAskQuestion`],
    ['a declaration, a property name and a type that only share a name', `export function writePty(id: string, d: string): void {}\nconst ports = { pastePty: () => 0 }\ntype W = typeof writePty\nlet f: typeof pastePty`],
    ['a stream write', `stream.write(line)\nres.write(': ping')`],
    ['a headless terminal\'s write', `entry.term.write(data)\npane.term.write('', cb)`],
    ['child_process\'s spawn', `import { spawn } from 'child_process'\nconst c = spawn('git', [])\nc.stdin.write('x')`],
    ['a run screen\'s other calls', `provider.runScreen?.open(id, o)\ncodexRunScreen()?.close(id)`],
    ['another submit', `form.submit()\nqueue.submit(job)`],
    ['a typing function only named in a comment or a string', `// writePty(id, 'x')\nconst s = 'pastePty'`],
    ['the injected writer of a dependency object', `deps.write(text)\nthis.host.write(id, text)`],
  ]
  for (const [what, code, file] of clean) {
    it(`does not flag ${what}`, () => { expect(typingSites(code, file ?? 'src/main/feature.ts')).toEqual([]) })
  }

  it('counts a call once, however the function is reached', () => {
    expect(typingSites(`import * as pm from './pty-manager'\npm.writePty(id, 'x')`)).toHaveLength(1)
    expect(typingSites(`import { writePty as w } from './pty-manager'\nw(id, 'x')`)).toHaveLength(1)
    expect(typingSites(`writeSubmittedLine(id, 'x')`)).toEqual([{ line: 1, what: 'writeSubmittedLine()', in: '(top level)' }])
  })

  it('groups each site by the named function it is in', () => {
    const code = `function outer() {\n  const inner = () => {\n    sessions.get(id)?.ptyProcess.write('a')\n  }\n  ptyProcess.write('b')\n}\nclass C { send() { cliSetupPty.write('c') } }\nstart({ write: (d) => codexRun.write(d) })`
    expect(typingSites(code).map((s) => `${s.line} ${s.in}`)).toEqual(['3 inner', '5 outer', '7 send', '8 (top level)'])
  })

  it('a file the parser cannot read fails loudly, naming the file', () => {
    expect(() => typingSites('const = (;', 'src/main/broken.ts')).toThrow(/src\/main\/broken\.ts: the parser could not read it/)
  })

  it('the allow-list check: a site not listed, a count over, a count under and an entry left over each fail', () => {
    const site = (line: number, fn: string): Site => ({ line, what: '.write on a PTY', in: fn })
    const allowed = { 'src/main/a.ts': { f: { count: 2, why: 'a reason long enough', until: 'X1' }, g: { count: 1, why: 'a reason long enough', until: 'X1' } } }
    expect(allowListProblems({ 'src/main/a.ts': [site(1, 'f'), site(2, 'f'), site(3, 'g')] }, allowed)).toEqual([])
    expect(allowListProblems({ 'src/main/a.ts': [site(1, 'f'), site(2, 'f'), site(3, 'g'), site(4, 'h')] }, allowed)).toEqual([
      'NOT ALLOWED: src/main/a.ts:4 (.write on a PTY) in h: type through src/main/session-input/ instead',
    ])
    expect(allowListProblems({ 'src/main/a.ts': [site(1, 'f'), site(2, 'f'), site(3, 'f'), site(4, 'g')] }, allowed)[0]).toMatch(/^OVER: src\/main\/a\.ts f has 3 sites, its entry allows 2/)
    expect(allowListProblems({ 'src/main/a.ts': [site(1, 'f'), site(3, 'g')] }, allowed)).toEqual([
      'LOWER IT: src/main/a.ts f has 1 sites, its entry still allows 2: lower the entry',
    ])
    expect(allowListProblems({ 'src/main/a.ts': [site(1, 'f'), site(2, 'f')] }, allowed)).toEqual([
      'LOWER IT: src/main/a.ts g has 0 sites, its entry still allows 1: lower the entry (take it out)',
    ])
    expect(allowListProblems({ 'src/main/b.ts': [site(9, 'k')] }, allowed)[0]).toMatch(/^LOWER IT: src\/main\/a\.ts f/)
    expect(allowListProblems({ 'src/main/b.ts': [site(9, 'k')] }, allowed)).toContain('NOT ALLOWED: src/main/b.ts:9 (.write on a PTY) in k: type through src/main/session-input/ instead')
  })
})
