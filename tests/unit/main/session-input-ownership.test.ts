// One door for the app's own typing into a session (ADR-030 component row 3's
// submit; 2.1.3-beta.9 section A1). The session input module
// (src/main/session-input/) is where the main process decides, on its own
// initiative, what goes into a session's terminal: the Watchdog's retry, an
// Agent Canvas marker, Ask Conductor's question. (A Claude Code marker it
// hands to canvas/claude-marker-typing.ts, which has the renderer type it.)
// Every other caller asks the module (submitLine, typeKeys, submitMarker,
// handOffAskQuestion); askQuestion, which skips the Ask check, is the PTY
// manager's Ask launch's only, and codexRunScreen, the Codex run screen
// itself, is the PTY manager's only (it resizes and closes each pane through
// it).
//
// This reads every src/main/**/*.ts file and finds, in each file outside the
// module, every place that types into a session's terminal:
//  - writePty, writeSubmittedLine, pastePty, writeCanvasMarkerLine,
//    handOffAskQuestion, submitCodexText or writeCliSetupPty named in code,
//    under any name: imported, or destructured (from a namespace, a require, a
//    dynamic import, an assignment or a parameter, renamed or not, with a
//    default or nested), then called, or handed on as a value (an argument, a
//    property, a name, an array element, a return, a bind); and the same read
//    from any object, a namespace import included, by name or by a static key
//    (a string, or a template literal with no expressions), called or handed
//    on. A destructured one counts where it is read and at each use. A call
//    counts once. A namespace of a module that exports one (the PTY manager,
//    the Codex run screen's module, the first-run terminal's handlers) handed
//    on whole (spread, passed, stored, read by a computed key, re-exported)
//    counts too. The module's own exports are the door: a name imported or
//    destructured from src/main/session-input, or read from a namespace of
//    it, is not counted, whatever it is (but what its codexRunScreen returns
//    is a run screen, below);
//  - `.submit` read from a provider's run screen, or destructured from one:
//    anything traced to a `.runScreen` read (destructured included), typed
//    SessionRunScreen or `X['runScreen']`, typed as what the module's
//    codexRunScreen returns (`ReturnType<typeof codexRunScreen>`, wrapped in
//    NonNullable, or through a type alias of the same file), or a call of the
//    module's codexRunScreen under any name (imported, renamed or not, read
//    from a namespace, a require or an import() of the module, destructured
//    from one, set to a name or a class field from one of those, or a
//    constructor parameter property whose default is one);
//  - `.write` read from a PTY handle, or destructured from one: anything typed
//    IPty or HelperPty or `X['ptyProcess']` (or a type alias of this file that
//    names one), the result of node-pty's spawn (imported, required or
//    imported at run time), spawnPlainPty, spawnAgentPty or spawnRunPty
//    (under any name), a `new HelperPty`, a
//    `.ptyProcess` read (destructured included), a function in the same file
//    that returns one, a call handed a function that returns one (a start
//    wrapped in a timing helper), an element of a collection of them (a list
//    or a map typed with them or built from them: an index, get, at, values,
//    entries or find, a for-of, a collection callback's first parameter), and
//    any name, constructor parameter property or `this` field set from those,
//    through casts, `!`, `?.`, `??`, aliases and destructuring; and, as a
//    backstop, by name: `.write` read from anything named ptyProcess,
//    cliSetupPty, codexRun or pane (the Codex run screen's pane, which holds
//    the raw writer the PTY manager hands it), or destructured under another
//    name from a property of one of those names.
// Each site is grouped by the named function it is in (a function
// declaration, a function set to a name, a method; else the top level). The
// committed allow-list below keeps today's other sites, each group with its
// count, its reason and the slice that removes it. A count above its entry
// fails, a group not listed fails, and a count below its entry fails and says
// to lower it, so the list only shrinks. The self-test at the end feeds each
// shape.
//
// It also holds the module's own shape: nothing it imports, directly or
// through any file it loads, is the PTY manager (so the ports cannot be
// registered before the module is ready, and imports run one way); the PTY
// manager registers the ports in one statement of its own, when it loads; and
// askQuestion and codexRunScreen are reached from the PTY manager only.
//
// Not checked here: the renderer (its typing moves with S13); a PTY handle
// held in an object property other than `ptyProcess` (or a backstop name) of
// an object that is not `this`; a handle handed to an untyped parameter other
// than a collection callback's; a writer reached through a field of an
// injected dependency object (`deps.write`: the composer rule's and the
// Watchdog's own writers, handed in by the PTY manager and by this module);
// the module's codexRunScreen handed on as a value and called elsewhere (only
// the PTY manager may import it, above); a run screen's type written
// `typeof import('...')`; a `#` private class field (`this.#name`) holding
// a handle, a screen or the module's codexRunScreen; a computed key that is
// not a literal, except on a namespace of a module that exports a typing
// function, which then counts whole; a reach through
// `Reflect`, `eval` or a require whose name is built at run time; and a local
// name that shadows a typing function's (counted as one, which only
// over-counts).
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import { parse } from '@babel/parser'

const ROOT = resolve(__dirname, '..', '..', '..')
const MODULE_DIR = 'src/main/session-input/'
const MODULE_ENTRY = 'src/main/session-input/index.ts'

/** The functions that type into a session: today's, and the ones they replaced. */
const TYPING_FUNCTIONS = new Set(['writePty', 'writeSubmittedLine', 'pastePty', 'writeCanvasMarkerLine', 'handOffAskQuestion', 'submitCodexText', 'writeCliSetupPty'])
/** The modules that export one: a namespace of one handed on whole hands them on. */
const TYPING_MODULES = new Set(['src/main/pty-manager', 'src/main/providers/codex/session-screen', 'src/main/ipc/setup-handlers'])
const PTY_TYPES = new Set(['IPty', 'HelperPty'])
const PTY_STARTS = new Set(['spawnPlainPty', 'spawnAgentPty', 'spawnRunPty'])
const SCREEN_TYPES = new Set(['SessionRunScreen'])
/** The module's export that returns the Codex run screen: a call of it is a run screen. */
const DOOR_SCREEN = 'codexRunScreen'
/** The property an indexed type names a PTY handle or a run screen by (`PtySession['ptyProcess']`). */
const INDEXED = { pty: 'ptyProcess', screen: 'runScreen' } as const
const BY_NAME = new Set(['ptyProcess', 'cliSetupPty', 'codexRun', 'pane'])
/** Calls that take an element out of a list or a map. */
const COLLECTION_READS = new Set(['get', 'at', 'values', 'entries', 'find', 'findLast', 'pop', 'shift'])
/** Calls that hand each element of a list or a map to their callback's first parameter. */
const COLLECTION_CALLBACKS = new Set(['forEach', 'map', 'filter', 'find', 'findLast', 'some', 'every', 'flatMap'])
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'])
const WRAPPERS = ['TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ParenthesizedExpression', 'AwaitExpression']

type Allowed = { count: number; why: string; until: string }
/**
 * Today's other sites, by file and by the function they are in. Lower a count
 * when its sites go, take an entry out when none is left; never raise one and
 * never add one (type through the module instead).
 */
const ALLOWED: Record<string, Record<string, Allowed>> = {
  'src/main/pty-manager.ts': {
    '(top level)': { count: 1, why: "the session input module's write port, registered when the PTY manager loads: writePty, the one writer the module types through", until: 'stays' },
    writePty: { count: 2, why: "writePty itself: the tab's own keystrokes (pty:write) and the module's one writer, with the duplicate guard and the launch-pending buffer; and its hand-off of the first-run terminal's keys to writeCliSetupPty (declared exception 10)", until: 'stays' },
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

function isMember(e: N | undefined): boolean { return e?.type === 'MemberExpression' || e?.type === 'OptionalMemberExpression' }
const isCall = (e: N | undefined): boolean => e?.type === 'CallExpression' || e?.type === 'OptionalCallExpression'
const unwrap = (e: N | undefined): N | undefined => {
  while (e && WRAPPERS.includes(e.type)) e = e.expression ?? e.argument
  return e
}
/** A key written as a string, or as a template literal with no expressions. */
const staticKey = (k: N | undefined): string | null => {
  if (k?.type === 'StringLiteral') return k.value
  if (k?.type === 'TemplateLiteral' && k.expressions.length === 0) return k.quasis[0]?.value?.cooked ?? null
  return null
}
const propName = (m: N): string | null => (m.computed ? staticKey(m.property) : m.property?.name ?? null)
/** The module `require('x')`, `import('x')` or `await import('x')` loads, or null. */
function moduleCallSpec(raw: N | undefined): string | null {
  const e = unwrap(raw)
  if (e?.type === 'ImportExpression') return e.source?.type === 'StringLiteral' ? e.source.value : null
  if (e?.type !== 'CallExpression') return null
  const c = e.callee
  if (c?.type === 'Import' || (c?.type === 'Identifier' && c.name === 'require')) return e.arguments?.[0]?.type === 'StringLiteral' ? e.arguments[0].value : null
  return null
}

type NsKind = 'door' | 'typing' | 'node-pty'

/** Every place in `code` that types into a session's terminal. `file` is the
 *  file's repo path (it decides which imports are the module's). */
export function typingSites(code: string, file = 'src/main/snippet.ts'): Site[] {
  const ast = parseTs(code, file)
  const door = new Set<string>()          // names imported or destructured from the module
  const doorScreens = new Set<string>()   // names (or `this` fields) holding the module's codexRunScreen
  const namespaces = new Map<string, NsKind>()
  const typingImports = new Map<string, string>()
  const startNames = new Set<string>()
  const typeAlias = new Map<string, string>()
  const nodePtySpawn = new Set<string>()
  const specKind = (spec: string): NsKind | null =>
    isModuleImport(file, spec) ? 'door' : spec === 'node-pty' ? 'node-pty' : TYPING_MODULES.has(importTarget(file, spec) ?? '') ? 'typing' : null
  /** What module namespace `raw` is, if any: a name bound to one, or a require or import of one. */
  const nsKind = (raw: N | undefined): NsKind | null => {
    const e = unwrap(raw)
    if (e?.type === 'Identifier') return namespaces.get(e.name) ?? null
    const spec = moduleCallSpec(e)
    return spec === null ? null : specKind(spec)
  }
  walk(ast, (n) => {
    if (n.type !== 'ImportDeclaration') return
    const kind = specKind(String(n.source.value))
    for (const s of n.specifiers as N[]) {
      if (s.type === 'ImportSpecifier') {
        const imported = s.imported.name ?? s.imported.value
        if (kind === 'door') {
          door.add(s.local.name)
          if (imported === DOOR_SCREEN) doorScreens.add(s.local.name)
          continue
        }
        if (TYPING_FUNCTIONS.has(imported)) typingImports.set(s.local.name, imported)
        if (PTY_STARTS.has(imported)) startNames.add(s.local.name)
        if (PTY_TYPES.has(imported) || SCREEN_TYPES.has(imported)) typeAlias.set(s.local.name, imported)
        if (kind === 'node-pty' && imported === 'spawn') nodePtySpawn.add(s.local.name)
      } else if (kind) {
        namespaces.set(s.local.name, kind)
      }
    }
  })
  const typeName = (name: string): string => typeAlias.get(name) ?? name
  const localTypes = new Map<string, N>()     // type X = ..., declared in this file
  walk(ast, (n) => { if (n.type === 'TSTypeAliasDeclaration' && n.id?.name) localTypes.set(n.id.name, n.typeAnnotation) })
  const resolving = new Set<string>()
  /** Whether `exprName`, the name a `typeof` reads, is the module's codexRunScreen: a name bound to it, or read from a namespace of the module. */
  const isDoorScreenQuery = (exprName: N | undefined): boolean => {
    if (exprName?.type === 'Identifier') return doorScreens.has(exprName.name)
    return exprName?.type === 'TSQualifiedName' && exprName.right?.name === DOOR_SCREEN && exprName.left?.type === 'Identifier' && namespaces.get(exprName.left.name) === 'door'
  }
  /** Whether a type names a PTY handle or a run screen anywhere in it (a union,
   *  a list, a map, `X['ptyProcess']`, a type alias of this file, and, for a run
   *  screen, `typeof codexRunScreen`, as `ReturnType<typeof codexRunScreen>`). */
  const namesType = (t: N | undefined, kind: keyof typeof INDEXED): boolean => {
    const set = kind === 'pty' ? PTY_TYPES : SCREEN_TYPES
    let found = false
    if (t) walk(t, (n) => {
      if (n.type === 'TSIndexedAccessType' && n.indexType?.type === 'TSLiteralType' && n.indexType.literal?.value === INDEXED[kind]) found = true
      if (kind === 'screen' && n.type === 'TSTypeQuery' && isDoorScreenQuery(n.exprName)) found = true
      if (n.type !== 'TSTypeReference') return
      const tn = n.typeName
      const name = tn?.type === 'Identifier' ? typeName(tn.name) : tn?.type === 'TSQualifiedName' ? tn.right?.name : null
      if (name && set.has(name)) found = true
      if (tn?.type === 'Identifier' && localTypes.has(tn.name) && !resolving.has(tn.name)) {
        resolving.add(tn.name)
        try { if (namesType(localTypes.get(tn.name), kind)) found = true } finally { resolving.delete(tn.name) }
      }
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

  const handles = new Set<string>()     // a PTY handle, or a list or map of them
  const screens = new Set<string>()
  const following = new Set<string>()
  /** Whether `raw` holds what `own` recognises, directly, through a name or
   *  field in `held`, as an element of what holds it, or as what a function in
   *  this file returns. */
  const traced = (raw: N | undefined, held: Set<string>, own: (e: N) => boolean): boolean => {
    const e = unwrap(raw)
    if (!e) return false
    if (e.type === 'LogicalExpression') return traced(e.left, held, own) || traced(e.right, held, own)
    if (e.type === 'ConditionalExpression') return traced(e.consequent, held, own) || traced(e.alternate, held, own)
    if (e.type === 'SequenceExpression') return traced(e.expressions[e.expressions.length - 1], held, own)
    if (e.type === 'ArrayExpression') return (e.elements as Array<N | null>).some((x) => !!x && traced(x.type === 'SpreadElement' ? x.argument : x, held, own))
    if (own(e)) return true
    // An element: list[i].
    if (isMember(e) && e.computed && propName(e) === null) return traced(e.object, held, own)
    if (isCall(e)) {
      const c = unwrap(e.callee)
      // An element read out of a list or a map: map.get(id), list.at(0), map.values().
      if (c && isMember(c) && COLLECTION_READS.has(propName(c) ?? '') && traced(c.object, held, own)) return true
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
    if (e.type === 'NewExpression' && namesType(e.typeParameters, 'pty')) return true     // new Map<string, IPty>()
    if (!isCall(e)) return false
    const c = unwrap(e.callee)
    if (c?.type === 'Identifier' && (startNames.has(c.name) || PTY_STARTS.has(c.name) || nodePtySpawn.has(c.name))) return true
    if (c && isMember(c) && propName(c) === 'spawn' && nsKind(c.object) === 'node-pty') return true
    if (c && isMember(c) && PTY_STARTS.has(propName(c) ?? '')) return true
    // A start wrapped in a helper: timedStart(cmd, () => pty.spawn(...)).
    for (const a of e.arguments as N[]) {
      if (['ArrowFunctionExpression', 'FunctionExpression'].includes(a.type) && returnsOf(a).some((r) => isHandle(r))) return true
    }
    return false
  }
  /** Whether `raw` is the module's codexRunScreen: a name or field bound to
   *  it, or read from a namespace, a require or an import() of the module. */
  const isDoorScreen = (raw: N | undefined): boolean => {
    const e = unwrap(raw)
    if (!e) return false
    const k = keyOf(e)
    if (k !== null && doorScreens.has(k)) return true
    return isMember(e) && propName(e) === DOOR_SCREEN && nsKind(e.object) === 'door'
  }
  const ownScreen = (e: N): boolean => (isMember(e) && propName(e) === 'runScreen') || (e.type === 'NewExpression' && namesType(e.typeParameters, 'screen'))
    || (isCall(e) && isDoorScreen(e.callee))     // codexRunScreen(), under any name
  const isScreen = (e: N | undefined): boolean => traced(e, screens, ownScreen)
  const byName = (raw: N | undefined): boolean => {
    const e = unwrap(raw)
    if (e?.type === 'Identifier') return BY_NAME.has(e.name)
    if (e && isMember(e)) return BY_NAME.has(propName(e) ?? '')
    return false
  }

  /** What a name set from `value` holds. */
  const bindTo = (k: string, value: N | undefined): void => {
    if (!value) return
    if (isHandle(value)) handles.add(k)
    if (isScreen(value)) screens.add(k)
    if (isDoorScreen(value)) doorScreens.add(k)
    const ns = nsKind(value)
    if (ns && !k.startsWith('this.')) namespaces.set(k, ns)
  }
  // Stand-ins for a destructured read: `source.key`, `source[0]`, and an
  // unknown source (a parameter's argument).
  const UNKNOWN: N = { type: 'Identifier', name: '\0unknown', start: -1 }
  const readOf = (source: N | undefined, key: string): N => ({ type: 'MemberExpression', object: source ?? UNKNOWN, property: { type: 'Identifier', name: key, start: -1 }, computed: false, start: -1 })
  const elementOf = (source: N | undefined): N | undefined => source && { type: 'MemberExpression', object: source, property: { type: 'NumericLiteral', value: 0, start: -1 }, computed: true, start: -1 }
  /** Bind the names a destructuring pattern sets from `source` (undefined:
   *  not known, as a parameter's argument), and hand each property it reads
   *  to `onRead`, as the read `source.key` it is. */
  const bindPattern = (pattern: N | null | undefined, source: N | undefined, onRead?: (prop: N, read: N) => void): void => {
    if (!pattern) return
    if (pattern.type === 'AssignmentPattern') return bindPattern(pattern.left, source ?? pattern.right, onRead)
    if (pattern.type === 'RestElement') return bindPattern(pattern.argument, source, onRead)
    if (pattern.type === 'TSParameterProperty') return bindPattern(pattern.parameter, source, onRead)
    if (pattern.type === 'Identifier') return bindTo(pattern.name, source)
    if (pattern.type === 'ArrayPattern') { for (const el of pattern.elements as Array<N | null>) bindPattern(el, elementOf(source), onRead); return }
    if (pattern.type !== 'ObjectPattern') return
    const kind = nsKind(source)
    for (const prop of pattern.properties as N[]) {
      if (prop.type === 'RestElement') { if (kind && prop.argument?.type === 'Identifier') namespaces.set(prop.argument.name, kind); continue }
      const key = prop.computed ? staticKey(prop.key) : (prop.key?.name ?? prop.key?.value ?? null)
      if (key === null) continue
      const read = readOf(source, String(key))
      onRead?.(prop, read)
      const fallback = prop.value?.type === 'AssignmentPattern' ? prop.value.right : undefined
      const target = prop.value?.type === 'AssignmentPattern' ? prop.value.left : prop.value
      if (target?.type !== 'Identifier') { bindPattern(prop.value, read, onRead); continue }
      const v = target.name
      if (kind === 'door') {
        door.add(v)
        if (key === DOOR_SCREEN) doorScreens.add(v)
        continue
      }
      if (TYPING_FUNCTIONS.has(key)) typingImports.set(v, key)
      if (PTY_STARTS.has(key)) startNames.add(v)
      if (kind === 'node-pty' && key === 'spawn') nodePtySpawn.add(v)
      if (isHandle(read) || BY_NAME.has(key) || isHandle(fallback)) handles.add(v)
      if (isScreen(read) || isScreen(fallback)) screens.add(v)
    }
  }
  /** The patterns a node binds, each with its source: a declaration, an
   *  assignment, a for-of, a function's parameters, a collection callback's
   *  first parameter. `inner` is where a site in it is: inside the function
   *  for a parameter. */
  const patternsOf = (n: N): Array<{ pattern: N; source: N | undefined; inner?: N[] }> => {
    if (n.type === 'VariableDeclarator') return keyOf(n.id) ? [] : [{ pattern: n.id, source: n.init ?? undefined }]
    if (n.type === 'AssignmentExpression') return keyOf(n.left) ? [] : [{ pattern: n.left, source: n.right }]
    if (n.type === 'ForOfStatement') {
      const left = n.left?.type === 'VariableDeclaration' ? n.left.declarations[0]?.id : n.left
      return left ? [{ pattern: left, source: elementOf(n.right) }] : []
    }
    if (FUNCTION_TYPES.has(n.type)) return (n.params as N[]).filter((p) => p.type !== 'Identifier').map((p) => ({ pattern: p, source: undefined, inner: [n] }))
    if (isCall(n)) {
      const c = unwrap(n.callee)
      const cb = (n.arguments as N[])[0]
      if (c && isMember(c) && COLLECTION_CALLBACKS.has(propName(c) ?? '') && cb && ['ArrowFunctionExpression', 'FunctionExpression'].includes(cb.type) && cb.params[0] && isHandle(c.object)) {
        return [{ pattern: cb.params[0], source: elementOf(c.object), inner: [n, cb] }]
      }
    }
    return []
  }

  // Grow the sets of holders until nothing new is found (aliases of aliases).
  const total = (): number => handles.size + screens.size + doorScreens.size + namespaces.size + door.size + typingImports.size + startNames.size + nodePtySpawn.size
  for (let size = -1; size !== total();) {
    size = total()
    walk(ast, (n) => {
      for (const { pattern, source } of patternsOf(n)) bindPattern(pattern, source)
      if (n.type === 'VariableDeclarator') {
        const k = keyOf(n.id)
        if (k) {
          bindTo(k, n.init ?? undefined)
          if (namesType(n.id.typeAnnotation, 'pty')) handles.add(k)
          if (namesType(n.id.typeAnnotation, 'screen')) screens.add(k)
        }
      } else if (n.type === 'AssignmentExpression') {
        const k = keyOf(n.left)
        if (k) bindTo(k, n.right)
      } else if (n.type === 'ClassProperty' || n.type === 'ClassPrivateProperty') {
        const name = n.key?.name ?? n.key?.id?.name
        if (name && (namesType(n.typeAnnotation, 'pty') || isHandle(n.value))) handles.add(`this.${name}`)
        if (name && (namesType(n.typeAnnotation, 'screen') || isScreen(n.value))) screens.add(`this.${name}`)
        if (name && isDoorScreen(n.value)) doorScreens.add(`this.${name}`)     // cs = codexRunScreen
      } else if (n.type === 'TSParameterProperty') {
        // constructor(private pty: IPty): a `this` field.
        const p = n.parameter?.type === 'AssignmentPattern' ? n.parameter.left : n.parameter
        const fallback = n.parameter?.type === 'AssignmentPattern' ? n.parameter.right : undefined
        if (p?.type === 'Identifier') {
          if (namesType(p.typeAnnotation, 'pty') || isHandle(fallback)) handles.add(`this.${p.name}`)
          if (namesType(p.typeAnnotation, 'screen') || isScreen(fallback)) screens.add(`this.${p.name}`)
          if (isDoorScreen(fallback)) doorScreens.add(`this.${p.name}`)     // constructor(private cs = codexRunScreen)
        }
      } else if (n.type === 'Identifier' && n.typeAnnotation) {
        if (namesType(n.typeAnnotation, 'pty')) handles.add(n.name)     // a parameter or a field typed as a PTY
        if (namesType(n.typeAnnotation, 'screen')) screens.add(n.name)
      }
    })
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
  /** A read of `m`'s property, counted at `at`: a typing function, a PTY's
   *  write or a run screen's submit. */
  const readSites = (m: N, at: N, ancestors: N[], how = ''): void => {
    const prop = propName(m)
    if (prop && TYPING_FUNCTIONS.has(prop) && nsKind(m.object) !== 'door') add(at, ancestors, `.${prop}${how}`)
    if (prop === 'write' && (isHandle(m.object) || byName(m.object))) add(at, ancestors, `.write on a PTY${how}`)
    if (prop === 'submit' && isScreen(m.object)) add(at, ancestors, `.submit on a run screen${how}`)
  }
  /** Whether a namespace at `n` is only read through (a static key, a binding
   *  whose own uses are judged, a load for its side effects), not handed on. */
  const readThrough = (n: N, ancestors: N[]): boolean => {
    let child = n
    let i = ancestors.length - 1
    while (i >= 0 && WRAPPERS.includes(ancestors[i].type)) child = ancestors[i--]
    const p = ancestors[i]
    if (!p) return true
    if (isMember(p) && p.object === child) return propName(p) !== null
    if (p.type === 'VariableDeclarator' && p.init === child) return true
    if (p.type === 'AssignmentExpression' && p.right === child) return true
    return p.type === 'ExpressionStatement'
  }
  walk(ast, (n, ancestors) => {
    const parent = ancestors[ancestors.length - 1]
    // A destructuring pattern's reads, each judged as the read it is.
    for (const { pattern, source, inner } of patternsOf(n)) {
      const at = inner ? [...ancestors, ...inner] : ancestors
      bindPattern(pattern, source, (prop, read) => readSites(read, prop, at, ' destructured'))
    }
    // A typing function named in code: called, or handed on as a value
    // (an argument, a property, a name, an array element, a return, a bind).
    // A call and its callee start at the same place, so a call counts once.
    if (n.type === 'Identifier' && typingName(n.name) && isReference(n, parent, ancestors)) {
      const called = parent && isCall(parent) && parent.callee === n
      add(n, ancestors, called ? `${typingImports.get(n.name) ?? n.name}()` : `${n.name} handed on`)
    }
    // A namespace of a module that exports one, handed on whole.
    const whole = (n.type === 'Identifier' && namespaces.get(n.name) === 'typing' && isReference(n, parent, ancestors))
      || (moduleCallSpec(n) !== null && (n.type === 'CallExpression' || n.type === 'ImportExpression') && specKind(moduleCallSpec(n)!) === 'typing')
    if (whole && !readThrough(n, ancestors)) add(n, ancestors, 'a typing module handed on whole')
    if (n.type === 'ExportAllDeclaration' && specKind(String(n.source.value)) === 'typing') add(n, ancestors, 'a typing module re-exported whole')
    if (n.type === 'ExportNamespaceSpecifier' && parent?.source && specKind(String(parent.source.value)) === 'typing') add(n, ancestors, 'a typing module re-exported whole')
    // The same read from any object, a namespace import included, called or handed on.
    if (isMember(n)) readSites(n, n, ancestors)
  })
  return [...sites.values()].sort((a, b) => a.line - b.line)
}

const TYPE_ONLY = new Set(['TSTypeAnnotation', 'TSTypeQuery', 'TSTypeReference', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration'])
/** Whether an identifier is a value read, not a declaration, an import, a
 *  property's name, a name a pattern binds, or a type. */
function isReference(n: N, parent: N | undefined, ancestors: N[]): boolean {
  if (!parent) return true
  if (ancestors.some((a) => TYPE_ONLY.has(a.type))) return false
  if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type)) return false
  if (parent.type === 'ExportSpecifier') return parent.local === n
  if (parent.type === 'VariableDeclarator' && parent.id === n) return false
  if (FUNCTION_TYPES.has(parent.type) && (parent.id === n || (parent.params as N[]).includes(n))) return false
  if ((parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && parent.id === n) return false
  if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.property === n && !parent.computed) return false
  // A destructuring pattern's key and the name it binds: the read is judged
  // where the pattern is.
  const grand = ancestors[ancestors.length - 2]
  if (parent.type === 'ObjectProperty' && grand?.type === 'ObjectPattern' && (parent.key === n || parent.value === n)) return false
  if (parent.type === 'AssignmentPattern' && parent.left === n) return false
  if (['ArrayPattern', 'RestElement', 'TSParameterProperty'].includes(parent.type)) return false
  if (['ObjectProperty', 'ObjectMethod', 'ClassProperty', 'ClassMethod', 'ClassPrivateProperty'].includes(parent.type) && parent.key === n && !parent.computed && !parent.shorthand) return false
  return true
}

/** Each export of the session input module that `code` reaches, by name:
 *  imported, re-exported, read from a namespace of it (an import, a require
 *  or a dynamic import), or destructured from one; `*` for all of them. */
export function doorReads(code: string, file: string): Array<{ name: string; line: number }> {
  const ast = parseTs(code, file)
  const ns = new Set<string>()
  const isDoor = (raw: N | undefined): boolean => {
    const e = unwrap(raw)
    if (e?.type === 'Identifier') return ns.has(e.name)
    const spec = moduleCallSpec(e)
    return spec !== null && isModuleImport(file, spec)
  }
  for (let size = -1; size !== ns.size;) {
    size = ns.size
    walk(ast, (n) => {
      if (n.type === 'ImportDeclaration' && isModuleImport(file, String(n.source.value))) for (const s of n.specifiers as N[]) if (s.type !== 'ImportSpecifier') ns.add(s.local.name)
      if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && isDoor(n.init)) ns.add(n.id.name)
    })
  }
  const out = new Map<number, { name: string; line: number }>()
  const put = (n: N, name: string): void => { if (!out.has(n.start)) out.set(n.start, { name, line: n.loc!.start.line }) }
  walk(ast, (n) => {
    const fromDoor = (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source && isModuleImport(file, String(n.source.value))
    if (fromDoor && n.type === 'ExportAllDeclaration') put(n, '*')
    if (fromDoor) {
      for (const s of (n.specifiers ?? []) as N[]) {
        if (s.type === 'ImportSpecifier') put(s, s.imported.name ?? s.imported.value)
        if (s.type === 'ExportSpecifier') put(s, s.local.name ?? s.local.value)
        if (s.type === 'ExportNamespaceSpecifier') put(s, '*')
      }
    }
    const pattern = n.type === 'VariableDeclarator' && isDoor(n.init) ? n.id : n.type === 'AssignmentExpression' && isDoor(n.right) ? n.left : null
    if (pattern?.type === 'ObjectPattern') {
      for (const p of pattern.properties as N[]) {
        if (p.type === 'RestElement') { put(p, '*'); continue }
        const key = p.computed ? staticKey(p.key) : (p.key?.name ?? p.key?.value ?? null)
        put(p, key ?? '*')
      }
    }
    if (isMember(n) && isDoor(n.object)) put(n, propName(n) ?? '*')
  })
  return [...out.values()].sort((a, b) => a.line - b.line)
}

/** How often `code` calls setSessionInputPorts, and how many of those calls
 *  are a statement of the file itself (run when it loads, inside no function
 *  and no condition). */
export function portRegistrations(code: string, label: string): { calls: number; atLoad: number } {
  const program = parseTs(code, label)
  const named = (e: N | undefined): boolean => isCall(e) && e!.callee?.type === 'Identifier' && e!.callee.name === 'setSessionInputPorts'
  let calls = 0
  walk(program, (n) => { if (named(n)) calls++ })
  const atLoad = (program.body as N[]).filter((s) => s.type === 'ExpressionStatement' && named(s.expression)).length
  return { calls, atLoad }
}

/** The relative-import closure of `entry`: every file it loads at run time,
 *  directly or through a file it loads (static imports, re-exports, import()
 *  and require; type-only imports, which load nothing, left out). `readFile`
 *  answers null for a path that is not a file. A relative import that
 *  resolves to no file fails loudly: a walk that stopped short could miss a
 *  path back. */
export function importClosure(entry: string, readFile: (p: string) => string | null): string[] {
  const resolveSpec = (from: string, spec: string): string => {
    const base = posix.normalize(posix.join(posix.dirname(from), spec))
    const found = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((p) => readFile(p) !== null)
    if (!found) throw new Error(`${from}: the import ${spec} resolves to no file`)
    return found
  }
  const typeOnly = (n: N): boolean => n.importKind === 'type' || n.exportKind === 'type'
    || (n.type === 'ImportDeclaration' && n.specifiers.length > 0 && (n.specifiers as N[]).every((s) => s.importKind === 'type'))
  const seen = new Set([entry])
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (!/\.tsx?$/.test(file)) continue
    const code = readFile(file)
    if (code === null) throw new Error(`${file}: not found`)
    walk(parseTs(code, file), (n) => {
      const spec = (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source && !typeOnly(n) ? n.source.value
        : moduleCallSpec(n)
      if (typeof spec !== 'string' || !spec.startsWith('.')) return
      const target = resolveSpec(file, spec)
      if (!seen.has(target)) { seen.add(target); queue.push(target) }
    })
  }
  return [...seen].sort()
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
/** A repo file's text, or null when the path is not a file. */
const readIfFile = (p: string): string | null => {
  try { return statSync(resolve(ROOT, p)).isFile() ? read(p) : null } catch { return null }
}

describe('the session input module is the one door for the app\'s own typing into a session (A1)', () => {
  it('reads the main process source, the module included', () => {
    expect(sources.length).toBeGreaterThan(100)
    expect(sources).toContain(MODULE_ENTRY)
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

  it('nothing the module loads, directly or through any file it loads, is the PTY manager: the PTY manager registers its ports with it', () => {
    const closure = importClosure(MODULE_ENTRY, readIfFile)
    // The walk followed the module's imports past its own folder.
    expect(closure).toContain('src/main/canvas/claude-marker-typing.ts')
    expect(closure).toContain('src/main/providers/core/index.ts')
    expect(closure.filter((p) => p === 'src/main/pty-manager.ts' || p.startsWith('src/main/pty-manager/')), closure.join('\n')).toEqual([])
  })

  it('the PTY manager registers the ports once, when it loads: one call, a statement of the file itself', () => {
    expect(portRegistrations(read('src/main/pty-manager.ts'), 'src/main/pty-manager.ts')).toEqual({ calls: 1, atLoad: 1 })
    for (const p of sources) {
      if (p === 'src/main/pty-manager.ts' || p.startsWith(MODULE_DIR)) continue
      expect(portRegistrations(read(p), p).calls, p).toBe(0)
    }
  })

  it('askQuestion, which skips the Ask check, is reached from the PTY manager only (its Ask launch)', () => {
    const where: string[] = []
    for (const p of sources) {
      if (p.startsWith(MODULE_DIR)) continue
      for (const r of doorReads(read(p), p)) if (r.name === 'askQuestion' || r.name === '*') where.push(`${p}:${r.line} (${r.name})`)
    }
    expect(where.map((w) => w.split(':')[0]), where.join('\n')).toEqual(['src/main/pty-manager.ts'])
  })

  it('codexRunScreen, the Codex run screen itself, is reached from the PTY manager only (it resizes and closes each pane through it)', () => {
    const where: string[] = []
    for (const p of sources) {
      if (p.startsWith(MODULE_DIR)) continue
      for (const r of doorReads(read(p), p)) if (r.name === 'codexRunScreen' || r.name === '*') where.push(`${p}:${r.line} (${r.name})`)
    }
    expect(where.map((w) => w.split(':')[0]), where.join('\n')).toEqual(['src/main/pty-manager.ts'])
  })
})

describe('the check sees each way of typing into a session (verify the verifier)', () => {
  const flagged: Array<[string, string, string?]> = [
    ['a writePty call', `import { writePty } from './pty-manager'\nwritePty(id, 'x\\r')`],
    ['a writePty call under another name', `import { writePty as w } from './pty-manager'\nw(id, 'x')`],
    ['a call through a namespace import', `import * as pm from './pty-manager'\npm.writeSubmittedLine(id, 'continue')`],
    ['writeSubmittedLine', `writeSubmittedLine(id, 'continue')`],
    ['pastePty', `import { pastePty } from '../pty-manager'\npastePty(id, envelope)`],
    ['writeCanvasMarkerLine', `import { writeCanvasMarkerLine } from './pty-manager'\nconst a = writeCanvasMarkerLine(id, line)`],
    ['handOffAskQuestion from the PTY manager', `import { handOffAskQuestion } from '../pty-manager'\nhandOffAskQuestion(win, id, q)`],
    ['submitCodexText', `import { submitCodexText as send } from './session-screen'\nsend(id, text, { readyWaitMs: 1 })`],
    ['writeCliSetupPty', `import { writeCliSetupPty } from './ipc/setup-handlers'\nwriteCliSetupPty('x')`],
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
    ['a typing function read with a template-literal key', `import * as pm from './pty-manager'\npm[\`writePty\`](id, 'x')`],
    // Destructured and renamed.
    ['a typing function destructured from a namespace under another name', `import * as pm from './pty-manager'\nconst { writePty: w } = pm\nw(id, 'x')`],
    ['a typing function destructured from require under another name', `const { writePty: w } = require('./pty-manager')\nw(id, 'x')`],
    ['a typing function destructured from a dynamic import under another name', `async function go() {\n  const { writePty: w } = await import('./pty-manager')\n  w(id, 'x')\n}`],
    ['a typing function destructured in a parameter', `function f({ writePty: w }) { w(id, 'x') }`],
    ['a typing function destructured in a parameter with a default', `const f = ({ pastePty: p } = deps) => p(id, e)`],
    ['a typing function destructured in an assignment', `import * as pm from './pty-manager'\nlet w\n;({ writePty: w } = pm)\nw(id, 'x')`],
    ['a typing function destructured with a template-literal key', `import * as pm from './pty-manager'\nconst { [\`writePty\`]: w } = pm\nw(id, 'x')`],
    ['a ptyProcess destructured under another name', `const { ptyProcess: p } = session\np.write('x')`],
    ['a ptyProcess destructured in a parameter', `function f({ ptyProcess: p }) { p.write('x') }`],
    ['a ptyProcess destructured from a nested object', `const { session: { ptyProcess: p } } = entry\np.write('x')`],
    ['a backstop name destructured under another name', `const { cliSetupPty: c } = holder\nc.write('x')`],
    ['a write destructured from a PTY handle', `const { write } = s.ptyProcess\nwrite('x')`],
    ['a write destructured from a PTY handle under another name', `function f(t: IPty) { const { write: w } = t; w('x') }`],
    ['a run screen destructured', `const { runScreen } = getProvider('codex')\nrunScreen!.submit(id, t, o)`],
    ['a run screen destructured under another name', `const { runScreen: s } = getProvider('codex')\ns?.submit(id, t, o)`],
    ['a submit destructured from a run screen', `const { submit } = provider.runScreen!\nsubmit(id, t, o)`],
    ['a constructor parameter property typed IPty', `class Z {\n  constructor(private pty: IPty) {}\n  go() { this.pty.write('x') }\n}`],
    ['a field destructured from this', `class Q {\n  private inner: IPty | undefined\n  go() { const { inner } = this; inner!.write('x') }\n}`],
    // Run screens and PTY handles.
    ['a run screen\'s submit', `getProvider('codex').runScreen.submit(id, t, { readyWaitMs: 1 })`],
    ['a run screen read into a name', `const s = provider.runScreen\ns?.submit(id, t, o)`],
    ['a run screen from a function in the file', `function screen() { try { return getProvider('codex').runScreen } catch { return undefined } }\nconst x = screen()\nx!.submit(id, t, o)`],
    ['a run screen typed as one', `const go = (s: SessionRunScreen) => s.submit(id, t, o)`],
    ['a run screen\'s submit, bracketed', `provider.runScreen!['submit'](id, t, o)`],
    ['a parameter typed as the provider\'s run screen', `function f(s: NonNullable<SessionProvider['runScreen']>) { s.submit(id, t, o) }`],
    ['a parameter typed IPty', `import * as pty from 'node-pty'\nfunction f(p: pty.IPty) { p.write('x') }`],
    ['a name typed IPty', `import type { IPty } from 'node-pty'\nlet t: IPty | null = null\nt!.write('x')`],
    ['an aliased PTY type', `import type { IPty as Term } from 'node-pty'\nconst f = (t: Term) => t.write('x')`],
    ['a name typed HelperPty', `function f(t: HelperPty) { t.write('x') }`],
    ['a parameter typed as a session\'s PTY', `function f(p: PtySession['ptyProcess']) { p.write('x') }`],
    ['node-pty\'s spawn', `import * as pty from 'node-pty'\nconst p = pty.spawn('sh', [], {})\np.write('x')`],
    ['node-pty\'s spawn under another name', `import { spawn as start } from 'node-pty'\nconst t = start('sh', [], {})\nt.write('x')`],
    ['node-pty required and spawned at once', `const p = require('node-pty').spawn('sh', [], {})\np.write('x')`],
    ['node-pty required into a name', `const pty = require('node-pty')\nconst p = pty.spawn('sh', [], {})\np.write('x')`],
    ['node-pty\'s spawn destructured from require', `const { spawn } = require('node-pty')\nconst t = spawn('sh', [], {})\nt.write('x')`],
    ['node-pty imported at run time', `async function go() {\n  const pty = await import('node-pty')\n  pty.spawn('sh', [], {}).write('x')\n}`],
    ['spawnPlainPty', `const t = spawnPlainPty(ctx, f, a, o)\nt.write('x')`],
    ['spawnAgentPty under another name', `import { spawnAgentPty as agent } from './session-helper/manager'\nconst t = agent(ctx, f, a, o)\nt.write('x')`],
    ['spawnRunPty', `import { spawnRunPty } from './session-helper/manager'\nconst t = spawnRunPty(ctx, f, a, o)\nt.write('x')`],
    ['spawnAgentPty destructured from a dynamic import under another name', `async function go() {\n  const { spawnAgentPty: s } = await import('./session-helper/manager')\n  s(ctx, f, a, o).write('x')\n}`],
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
    // Collections of handles.
    ['a handle read from a map typed with IPty', `const ptys = new Map<string, IPty>()\nptys.get(id)!.write('x')`],
    ['a handle read from a map field typed with HelperPty', `class M {\n  private readonly live = new Map<string, HelperPty>()\n  go() { this.live.get(id)?.write('x') }\n}`],
    ['a handle read from a map, into a name', `const ptys: Map<string, HelperPty> = new Map()\nconst t = ptys.get(id)\nt?.write('x')`],
    ['an array element of handles', `const list: IPty[] = []\nlist[0].write('x')`],
    ['an element of a list built from a handle', `const both = [s.ptyProcess]\nboth[0].write('x')`],
    ['a handle from a for-of over handles', `const list: IPty[] = []\nfor (const t of list) t.write('x')`],
    ['a handle from a for-of over a map\'s values', `const live = new Map<string, HelperPty>()\nfor (const t of live.values()) t.write('x')`],
    ['a handle from a for-of over a map\'s entries', `const live = new Map<string, HelperPty>()\nfor (const [, t] of live.entries()) t.write('x')`],
    ['a handle in a collection callback', `const list: IPty[] = []\nlist.forEach((t) => t.write('x'))`],
    // A typing module's namespace handed on whole.
    ['a namespace of the PTY manager spread into an object', `import * as pm from './pty-manager'\nstart({ ...pm })`],
    ['a namespace of the PTY manager handed on', `import * as pm from './pty-manager'\nstart(pm)`],
    ['a namespace of the PTY manager read with a computed key', `import * as pm from './pty-manager'\npm[name](id, 'x')`],
    ['a namespace of the PTY manager from require, spread', `const pm = require('./pty-manager')\nstart({ ...pm })`],
    ['the PTY manager required and handed on at once', `start(require('./pty-manager'))`],
    ['the PTY manager re-exported whole', `export * from './pty-manager'`],
    ['the PTY manager re-exported as a namespace', `export * as pm from './pty-manager'`],
    // By name, as a backstop.
    ['by name: ptyProcess', `function f(ptyProcess) { ptyProcess.write('x') }`],
    ['by name: cliSetupPty', `cliSetupPty?.write(data)`],
    ['by name: codexRun', `const f = (codexRun) => codexRun.write(bytes)`],
    ['by name: the run screen\'s pane', `const pane = panes.get(id)\npane.write(data)`],
    ['by name: a field of another object', `deps.ptyProcess.write('x')`],
    // The door's own copy of the Codex run screen (codexRunScreen): its submit
    // is still a run screen's submit, however the function is reached.
    ['a submit on the door\'s run screen', `import { codexRunScreen } from './session-input'\ncodexRunScreen()?.submit(id, t, o)`],
    ['a submit on the door\'s run screen in the PTY manager, as its marker writer once did', `import { setSessionInputPorts, codexRunScreen } from './session-input'\nexport function writeCanvasMarkerLine(sessionId: string, line: string) {\n  const screen = codexRunScreen()\n  if (!screen) return\n  return screen.submit(sessionId, line, { readyWaitMs: 1 })\n}`, 'src/main/pty-manager.ts'],
    ['a submit on the door\'s run screen read into a name', `import { codexRunScreen } from './session-input'\nconst s = codexRunScreen()\ns!.submit(id, t, o)`],
    ['a submit on the door\'s run screen through a namespace of the module', `import * as input from './session-input'\ninput.codexRunScreen()!.submit(id, t, o)`],
    ['a submit on the door\'s run screen imported under another name', `import { codexRunScreen as cs } from '../session-input'\ncs()?.submit(id, t, o)`, 'src/main/ipc/feature.ts'],
    ['a submit destructured from the door\'s run screen', `import { codexRunScreen } from './session-input'\nconst { submit } = codexRunScreen()!\nsubmit(id, t, o)`],
    ['a submit on the door\'s run screen destructured from require under another name', `const { codexRunScreen: cs } = require('./session-input')\ncs()!.submit(id, t, o)`],
    ['a submit on the door\'s run screen destructured from a dynamic import', `async function go() {\n  const { codexRunScreen } = await import('../session-input')\n  await codexRunScreen()?.submit(id, t, o)\n}`, 'src/main/ipc/feature.ts'],
    ['a submit on the door\'s run screen read from a required namespace into a name', `const input = require('./session-input')\nconst cs = input.codexRunScreen\ncs()?.submit(id, t, o)`],
    ['a submit on the door\'s run screen read with a string key', `import * as input from './session-input'\ninput['codexRunScreen']()!.submit(id, t, o)`],
    ['a submit on the door\'s run screen required and called at once', `require('./session-input').codexRunScreen()?.submit(id, t, o)`],
    ['a submit destructured under another name from the door\'s run screen in a name', `import { codexRunScreen as cs } from './session-input'\nconst screen = cs()\nconst { submit: send } = screen!\nsend(id, t, o)`],
    // A run screen typed from the door's function: the type is what codexRunScreen returns.
    ['a parameter typed NonNullable of the door\'s run screen', `import { codexRunScreen } from './session-input'\nfunction deliver(s: NonNullable<ReturnType<typeof codexRunScreen>>) { s.submit(id, t, o) }`, 'src/main/pty-manager.ts'],
    ['a parameter typed as what the door\'s run screen returns', `import { codexRunScreen } from './session-input'\nfunction deliver(s: ReturnType<typeof codexRunScreen>) { s?.submit(id, t, o) }`],
    ['a parameter typed by a type alias of the door\'s run screen', `import { codexRunScreen } from './session-input'\ntype Screen = NonNullable<ReturnType<typeof codexRunScreen>>\nfunction deliver(s: Screen) { s.submit(id, t, o) }`],
    ['a name typed as what the door\'s run screen returns, imported under another name', `import { codexRunScreen as cs } from './session-input'\nlet s: ReturnType<typeof cs> = undefined\ns?.submit(id, t, o)`],
    ['a name typed as what the door\'s run screen returns, read from a namespace of the module', `import * as input from './session-input'\nconst go = (s: NonNullable<ReturnType<typeof input.codexRunScreen>>) => s.submit(id, t, o)`],
    ['a parameter typed by a type alias of IPty', `import type { IPty } from 'node-pty'\ntype Term = IPty | null\nfunction f(t: Term) { t!.write('x') }`],
    // The door's function held by a class, from where the class declares it.
    ['the door\'s run screen held by a class field', `import { codexRunScreen } from './session-input'\nclass X {\n  cs = codexRunScreen\n  go() { this.cs()?.submit(id, t, o) }\n}`],
    ['the door\'s run screen held by a constructor parameter property with a default', `import { codexRunScreen } from './session-input'\nclass X {\n  constructor(private cs = codexRunScreen) {}\n  go() { this.cs()?.submit(id, t, o) }\n}`],
  ]
  for (const [what, code, file] of flagged) {
    it(`flags ${what}`, () => { expect(typingSites(code, file).length).toBeGreaterThan(0) })
  }

  const clean: Array<[string, string, string?]> = [
    ['the module\'s submitLine', `import { submitLine } from './session-input'\nsubmitLine(id, 'continue')`],
    ['the module\'s own handOffAskQuestion, from a folder below', `import { handOffAskQuestion } from '../session-input'\nhandOffAskQuestion(win, id, q)`, 'src/main/ipc/feature.ts'],
    ['the module through a namespace import', `import * as input from './session-input'\ninput.submitMarker(id, line)\ninput.handOffAskQuestion(win, id, q)`],
    ['the module named by its index file', `import { typeKeys } from './session-input/index'\nstart({ write: (s, d) => typeKeys(s, d) })`],
    ['the module\'s own exports handed on through its namespace', `import * as input from './session-input'\nstart({ write: input.typeKeys, ask: input.handOffAskQuestion })\nconst h = input.handOffAskQuestion`],
    ['the module\'s own export destructured from a dynamic import', `async function go() {\n  const { handOffAskQuestion } = await import('../session-input')\n  handOffAskQuestion(win, id, q)\n}`, 'src/main/ipc/feature.ts'],
    ['the module required into a name', `const input = require('./session-input')\ninput.handOffAskQuestion(win, id, q)\nstart({ ...input })`],
    ['a declaration, a property name and a type that only share a name', `export function writePty(id: string, d: string): void {}\nconst ports = { pastePty: () => 0 }\ntype W = typeof writePty\nlet f: typeof pastePty`],
    ['the PTY manager\'s other exports, imported, destructured or read from its namespace', `import * as pm from './pty-manager'\nimport { killPty } from './pty-manager'\nconst { resizePty } = pm\npm.isSessionWritable(id)\nkillPty(id)\nasync function go() { const { spawnPty } = await import('./pty-manager'); spawnPty(w, id, o) }`],
    ['a stream write', `stream.write(line)\nres.write(': ping')`],
    ['a headless terminal\'s write', `entry.term.write(data)\npane.term.write('', cb)`],
    ['child_process\'s spawn', `import { spawn } from 'child_process'\nconst c = spawn('git', [])\nc.stdin.write('x')`],
    ['a PTY handle\'s other fields destructured', `const { cols, rows, pid } = s.ptyProcess\nconst { kill } = s.ptyProcess\nkill()`],
    ['a run screen\'s other calls', `provider.runScreen?.open(id, o)\ncodexRunScreen()?.close(id)`],
    ['a run screen\'s other calls destructured', `const { open, close } = getProvider('codex').runScreen!\nopen(id, o)`],
    ['the door\'s run screen\'s other calls, as the PTY manager makes them', `import { setSessionInputPorts, codexRunScreen } from './session-input'\ncodexRunScreen()?.close(id)\ncodexRunScreen()?.resize(id, 80, 24)\nconst s = codexRunScreen()\nif (s?.has(id)) s.close(id)\nconst { close } = codexRunScreen()!\nclose(id)`, 'src/main/pty-manager.ts'],
    ['the door\'s run screen\'s other calls, through a namespace or under another name', `import * as input from './session-input'\nimport { codexRunScreen as cs } from './session-input'\ninput.codexRunScreen()?.close(id)\ncs()?.resize(id, 80, 24)`],
    ['the door\'s run screen\'s other calls, through its type', `import { codexRunScreen } from './session-input'\ntype Screen = NonNullable<ReturnType<typeof codexRunScreen>>\nfunction f(s: Screen, t: ReturnType<typeof codexRunScreen>) { s.close(id); t?.resize(id, 80, 24) }`],
    ['the door\'s run screen\'s other calls, through a class that holds it', `import { codexRunScreen } from './session-input'\nclass X {\n  cs = codexRunScreen\n  constructor(private other = codexRunScreen) {}\n  go() { this.cs()?.close(id); this.other()?.resize(id, 80, 24) }\n}`],
    ['another submit', `form.submit()\nqueue.submit(job)`],
    ['another module\'s namespace spread', `import * as fs from 'fs'\nstart({ ...fs })`],
    ['a map of other things', `const m = new Map<string, number>()\nm.get(id)\nconst w = new Map<string, NodeJS.WritableStream>()\nw.get(id)!.write('x')`],
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

  it('a destructured typing function counts where it is read and at each use under its new name, and its name is not counted as a use', () => {
    expect(typingSites(`import * as pm from './pty-manager'\nconst { writePty: w } = pm\nw(id, 'x')\nstart({ write: w })`)).toEqual([
      { line: 2, what: '.writePty destructured', in: '(top level)' },
      { line: 3, what: 'writePty()', in: '(top level)' },
      { line: 4, what: 'w handed on', in: '(top level)' },
    ])
    expect(typingSites(`const g = ({ writePty: w }) => w(id, 'x')`)).toEqual([
      { line: 1, what: '.writePty destructured', in: 'g' },
      { line: 1, what: 'writePty()', in: 'g' },
    ])
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

  it('the import walk follows every way a file loads another, leaves type-only imports out, and fails on an import it cannot resolve', () => {
    const files: Record<string, string> = {
      'src/main/session-input/index.ts': `import { a } from '../a'\nexport { b } from '../b'\nimport type { T } from '../pty-manager'\nimport { type U } from '../pty-manager'`,
      'src/main/a.ts': `export const a = () => import('./c')`,
      'src/main/b.ts': `export * from './d'`,
      'src/main/c.ts': `const e = require('./e/index')`,
      'src/main/d.ts': `export const d = 1`,
      'src/main/e/index.ts': `import './pty-manager.js'`,
      'src/main/e/pty-manager.ts': `export {}`,
      'src/main/pty-manager.ts': `export const T = 1`,
    }
    const fake = (p: string): string | null => files[p] ?? null
    expect(importClosure('src/main/session-input/index.ts', fake)).toEqual([
      'src/main/a.ts', 'src/main/b.ts', 'src/main/c.ts', 'src/main/d.ts', 'src/main/e/index.ts', 'src/main/e/pty-manager.ts', 'src/main/session-input/index.ts',
    ])
    files['src/main/d.ts'] = `import { x } from './pty-manager'`
    expect(importClosure('src/main/session-input/index.ts', fake)).toContain('src/main/pty-manager.ts')
    files['src/main/d.ts'] = `import { x } from './nowhere'`
    expect(() => importClosure('src/main/session-input/index.ts', fake)).toThrow(/src\/main\/d\.ts: the import \.\/nowhere resolves to no file/)
  })

  it('the registration check tells a statement of the file from a call inside a function or a condition', () => {
    expect(portRegistrations(`import { setSessionInputPorts } from './session-input'\nsetSessionInputPorts(p)`, 'a.ts')).toEqual({ calls: 1, atLoad: 1 })
    expect(portRegistrations(`export function spawnPty() { setSessionInputPorts(p) }`, 'a.ts')).toEqual({ calls: 1, atLoad: 0 })
    expect(portRegistrations(`if (ready) setSessionInputPorts(p)`, 'a.ts')).toEqual({ calls: 1, atLoad: 0 })
    expect(portRegistrations(`setSessionInputPorts(p)\nsetSessionInputPorts(q)`, 'a.ts')).toEqual({ calls: 2, atLoad: 2 })
  })

  it('the door check sees askQuestion however it is reached: imported, renamed, from a namespace, a require, a dynamic import, destructured or re-exported', () => {
    const names = (code: string, file = 'src/main/feature.ts'): string[] => doorReads(code, file).map((r) => r.name)
    expect(names(`import { askQuestion as ask, submitLine } from './session-input'`)).toEqual(['askQuestion', 'submitLine'])
    expect(names(`import * as input from './session-input'\ninput.askQuestion(w, id, q)`)).toEqual(['askQuestion'])
    expect(names(`const input = require('../session-input')\nconst again = input\nagain['askQuestion'](w, id, q)`, 'src/main/ipc/feature.ts')).toEqual(['askQuestion'])
    expect(names(`async function go() { const { askQuestion: a } = await import('./session-input'); a(w, id, q) }`)).toEqual(['askQuestion'])
    expect(names(`export { askQuestion } from './session-input'\nexport * from './session-input'`)).toEqual(['askQuestion', '*'])
    expect(names(`import { askQuestion } from './pty-manager'\nconst { askQuestion: b } = other`)).toEqual([])
    expect(names(`import { codexRunScreen as cs } from '../session-input'\nconst { codexRunScreen: again } = require('../session-input')`, 'src/main/ipc/feature.ts')).toEqual(['codexRunScreen', 'codexRunScreen'])
  })
})
