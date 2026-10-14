// The account sign-in folders' owner-only check is wired into the app: the
// main process turns it on at start and runs the start's profile steps that
// write a sign-in only once every profile's folders are checked, and a managed
// launch held for its project check waits for its own profile's folder check
// too, so the launch reads a verdict; the account list the window reads at
// start, and a Claude session that names no account (it runs on the primary
// account those steps may still be making), wait for those profile steps; and
// the Claude sign-in check and sign-out wait for their account's folder check.
// Read from the source: the start sequence runs inside Electron's ready
// handler, the launches inside the terminal manager and IPC handlers, none of
// which a unit test here starts; the behaviour itself is pinned in
// account-profiles-owner-only-credentials.test.ts.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/** A source file with its whole-line comments taken out (they may hold parentheses). */
function code(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8').replace(/\r\n/g, '\n').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** The argument text of the call whose opening parenthesis is at `open`. */
function argsAt(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i)
  }
  throw new Error('unbalanced call')
}

const count = (text: string, needle: string) => text.split(needle).length - 1

/** The elements of an array literal's text (`[a, b(c, [d]), e]`), split at
 *  its own commas only: those inside a call, an array, an object or a quoted
 *  string belong to the element they are in. */
function arrayItems(text: string): string[] {
  const body = text.trim()
  if (!body.startsWith('[') || !body.endsWith(']')) throw new Error(`not an array literal: ${body.slice(0, 40)}`)
  const items: string[] = []
  let depth = 0
  let quote = ''
  let start = 1
  for (let i = 1; i < body.length - 1; i++) {
    const c = body[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === "'" || c === '"' || c === '`') quote = c
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === ',' && depth === 0) { items.push(body.slice(start, i).trim()); start = i + 1 }
  }
  items.push(body.slice(start, body.length - 1).trim())
  return items.filter((s) => s.length > 0)
}

/** `text` with every comment taken out (a line comment up to its line end, a
 *  block comment replaced by spaces) and the inside of every string literal
 *  blanked, its quotes kept, so that only code can satisfy a match: a
 *  comment or a string that names a call is not that call. A small
 *  tokenizer: it knows ' " and ` strings (a template's `${...}` is blanked
 *  with the rest of it) and both comment forms, not regular expression
 *  literals nor a template inside a template's `${...}`, so it is used only
 *  on a region that has neither (the held launch below). */
function codeOnly(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      i = (end === -1 ? text.length : end) - 1
      continue
    }
    if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close === -1 ? text.length : close + 2
      out += text.slice(i, end).replace(/[^\n]/g, ' ')
      i = end - 1
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      for (; j < text.length && text[j] !== c; j++) {
        if (text[j] === '\\') j++
        else if (c !== '`' && text[j] === '\n') break
      }
      out += c + text.slice(i + 1, j).replace(/[^\n]/g, ' ') + (text[j] === c ? c : '')
      i = text[j] === c ? j : j - 1
      continue
    }
    out += c
  }
  return out
}

/** Whether the launch held for its project check awaits its own profile's
 *  folder check, in `src` (pty-manager.ts with its whole-line comments taken
 *  out): from the folders its project check reads to the hold itself, the
 *  check awaited on its own, or as an element of an awaited Promise.all's
 *  array (read element by element, so whatever the other elements hold).
 *  Only code counts (codeOnly). */
function heldAwaitsFolderCheck(src: string): { ok: boolean; held: string } {
  const from = src.search(/=\s*managedLaunchGateDirs\(sessionId/)
  const to = from < 0 ? -1 : src.indexOf('deferSpawnUntil(', from)
  if (from < 0 || to < 0) return { ok: false, held: '' }
  const held = codeOnly(src.slice(from, to))
  const CHECK = /^checkProfileCredentialFolders\(\s*\w+\s*\)$/
  const awaitedAlone = /\bawait\s+checkProfileCredentialFolders\(/.test(held)
  const awaitedInAll = [...held.matchAll(/\bawait\s+Promise\.all\(/g)]
    .some((m) => arrayItems(argsAt(held, m.index! + m[0].length - 1)).some((item) => CHECK.test(item)))
  return { ok: awaitedAlone || awaitedInAll, held }
}

describe('at start the profile steps that write a sign-in run only after every profile\'s folders are checked', () => {
  const src = code('src/main/index.ts')
  const CALL = 'startOwnerOnlyCredentialFolders('
  const STEPS = ['runFirstRunCapture()', 'cleanupSessionHomes()', 'syncPrimaryCredentialsWithGlobal()']

  it('the main process turns the check on, once, from the account profiles module', () => {
    expect(src).toMatch(/import \{[^}]*\bstartOwnerOnlyCredentialFolders\b[^}]*\} from '\.\/account-profiles'/)
    expect(count(src, CALL)).toBe(1)
  })

  it('every such step runs inside the check\'s continuation and nowhere else', () => {
    const at = src.indexOf(CALL)
    expect(at).toBeGreaterThan(-1)
    const inside = argsAt(src, at + CALL.length - 1)
    for (const step of STEPS) {
      expect(count(inside, step)).toBe(1)
      expect(count(src, step)).toBe(1)
    }
  })

  it('the check starts after the layout migration and the junction repair, which write no sign-in', () => {
    const at = src.indexOf(CALL)
    for (const before of ['migrateProfilesToHomeLayout()', 'repairSharedProjectJunctions()']) {
      expect(src.indexOf(before)).toBeGreaterThan(-1)
      expect(src.indexOf(before)).toBeLessThan(at)
    }
  })
})

describe('a managed launch held for its project check waits for its profile\'s folder check too', () => {
  const src = code('src/main/pty-manager.ts')

  it('the terminal manager waits for the profile\'s check while the launch is held', () => {
    expect(src).toMatch(/import \{[^}]*\bcheckProfileCredentialFolders\b[^}]*\} from '\.\/account-profiles'/)
    // Where the launch is held: from the folders its project check reads to the hold itself.
    const from = src.search(/=\s*managedLaunchGateDirs\(sessionId/)
    expect(from).toBeGreaterThan(-1)
    expect(src.indexOf('deferSpawnUntil(', from)).toBeGreaterThan(from)
    const { ok, held } = heldAwaitsFolderCheck(src)
    expect(ok, held).toBe(true)
  })

  // A pin that read comments and strings as code would stay green under a
  // refactor that dropped the check and left a comment naming the await.
  // Each mutant below is the real source with the check taken out of the
  // awaited Promise.all and named again where it does nothing; the pin must
  // fail on every one, and pass on the real source.
  describe('the pin fails when the check is gone and only named', () => {
    /** The real source with the check's element taken out of the awaited array. */
    const withoutCheck = (): string => {
      const from = src.search(/=\s*managedLaunchGateDirs\(sessionId/)
      const to = src.indexOf('deferSpawnUntil(', from)
      const m = /^[ \t]*checkProfileCredentialFolders\(\s*\w+\s*\),?[ \t]*\r?\n/m.exec(src.slice(from, to))
      expect(m, 'the check is an element of its own line in the held launch').not.toBeNull()
      const at = from + m!.index
      return src.slice(0, at) + src.slice(at + m![0].length)
    }
    /** `add` written right after the first match of `line` inside the held
     *  launch (from the folders its project check reads on), so the mutant
     *  lands where the pin reads. */
    const onLine = (text: string, line: RegExp, add: string): string => {
      const from = text.search(/=\s*managedLaunchGateDirs\(sessionId/)
      const to = text.indexOf('deferSpawnUntil(', from)
      const m = new RegExp(line.source).exec(text.slice(from))
      expect(m, String(line)).not.toBeNull()
      const at = from + m!.index + m![0].length
      expect(at, `${String(line)} inside the held launch`).toBeLessThan(to)
      return text.slice(0, at) + add + text.slice(at)
    }

    it('the real source passes', () => {
      expect(heldAwaitsFolderCheck(src).ok).toBe(true)
    })

    it.each([
      ['a trailing comment naming the await', (s: string) => onLine(s, /const dirs = [^\r\n]*/, ' // await checkProfileCredentialFolders(gateProfileId)')],
      ['a block comment naming the await', (s: string) => onLine(s, /return \{ verdict, dirs \}/, ' /* await checkProfileCredentialFolders(gateProfileId) */')],
      ['a block comment over several lines', (s: string) => onLine(s, /const dirs = [^\r\n]*/, '\n          /*\n          await checkProfileCredentialFolders(gateProfileId)\n          */')],
      ['a string naming the await', (s: string) => onLine(s, /const dirs = [^\r\n]*/, "\n          const note = 'await checkProfileCredentialFolders(gateProfileId)'")],
      ['a comment as the array element', (s: string) => onLine(s, /await Promise\.all\(\[/, ' // checkProfileCredentialFolders(gateProfileId),')],
    ])('%s', (_label, mutate) => {
      expect(heldAwaitsFolderCheck(mutate(withoutCheck())).ok).toBe(false)
    })

    it('the check still in the array, but the array not awaited', () => {
      const mutated = src.replace(/await Promise\.all\(\[/, 'Promise.all([')
      expect(mutated).not.toBe(src)
      expect(heldAwaitsFolderCheck(mutated).ok).toBe(false)
    })
  })
})

describe('the account list the window reads at start waits for the start\'s profile steps', () => {
  const src = code('src/main/ipc/account-profiles-handlers.ts')

  it('the list handler waits for the start\'s profile steps (the first sign-in capture among them) before it reads the list', () => {
    expect(src).toMatch(/import \{[^}]*\bstartProfileStepsSettled\b[^}]*\} from '\.\.\/account-profiles'/)
    const CALL = 'handle(IPC.ACCOUNT_PROFILES_LIST,'
    expect(count(src, CALL)).toBe(1)
    const body = argsAt(src, src.indexOf(CALL) + 'handle'.length)
    expect(body).toMatch(/await\s+startProfileStepsSettled\(\)[\s\S]*\blistProfiles\(\)/)
  })
})

describe('a Claude session that names no account waits for the start\'s profile steps before it starts', () => {
  const src = code('src/main/ipc/pty-handlers.ts')
  const body = src.slice(src.indexOf('const spawnSession = async ('), src.indexOf("ipcMain.handle('pty:spawn'"))

  it('a local Claude launch naming no account is held as a prepared spawn while the steps are still to run, and waits for them before it starts', () => {
    expect(src).toMatch(/import \{[^}]*\bstartProfileStepsPending\b[^}]*\} from '\.\.\/account-profiles'/)
    expect(src).toMatch(/import \{[^}]*\bstartProfileStepsSettled\b[^}]*\} from '\.\.\/account-profiles'/)
    expect(body.length).toBeGreaterThan(0)
    // Decided for a local Claude launch that names no account, while the steps are pending.
    const hold = body.match(/const (\w+) = launchProvider === 'claude' && !options\?\.ssh && !options\?\.profileId && startProfileStepsPending\(\)/)
    expect(hold).not.toBeNull()
    const name = hold![1]
    // Held as a prepared spawn, so a close or a newer spawn of the tab supersedes it while it waits.
    expect(body).toMatch(new RegExp(`const preparation = [^\\n]*\\b${name}\\b[^\\n]*\\? beginSpawnPreparation\\(`))
    // It waits for the steps before the closed-or-superseded check, so nothing starts for a tab closed meanwhile.
    const wait = body.search(new RegExp(`if \\(${name}\\) await startProfileStepsSettled\\(\\)`))
    expect(wait).toBeGreaterThan(-1)
    const superseded = body.indexOf('closed or superseded while its spawn was prepared')
    expect(superseded).toBeGreaterThan(-1)
    expect(wait).toBeLessThan(superseded)
  })
})

describe('the Claude sign-in check and sign-out run only once their account\'s sign-in folders have a verdict', () => {
  const src = code('src/main/account-web/claude-cli-auth.ts')

  it('each waits for the account\'s folder check, when its folders have no verdict yet, before it builds the account\'s environment', () => {
    expect(src).toMatch(/import \{[^}]*\bcheckProfileCredentialFolders\b[^}]*\} from '\.\.\/account-profiles'/)
    expect(src).toMatch(/import \{[^}]*\bprofileCredentialFoldersChecked\b[^}]*\} from '\.\.\/account-profiles'/)
    for (const launchId of ['auth-status', 'auth-logout']) {
      const at = src.indexOf(`launchId: '${launchId}'`)
      expect(at, launchId).toBeGreaterThan(-1)
      expect(count(src, `launchId: '${launchId}'`), launchId).toBe(1)
      const fn = src.lastIndexOf('async function ', at)
      expect(src.slice(fn, at), launchId).toMatch(/if \(!profileCredentialFoldersChecked\(profileId\)\) await checkProfileCredentialFolders\(profileId\)/)
    }
  })
})

// Only the account sign-in folders have what is inside them read and put
// right (secureSignInFoldersWindows); every other caller of the owner-only
// rule -- the other assistant's managed folders and its hook folders -- gets
// the folders' own rights only (secureOwnerOnlyFolders), so a folder those
// callers secure never has what an account keeps inside it judged or reset.
describe('only the account sign-in folders have what is inside them read', () => {
  /** Every TypeScript file below `dir`, by its path from the repository root. */
  const files = (dir: string): string[] => fs.readdirSync(path.join(__dirname, '..', '..', '..', dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []))

  it('the account rule asks for it, with the home mirror\'s links left out; no other source calls the rule with what is inside, or the rule\'s parts directly', () => {
    const ap = code('src/main/account-profiles.ts')
    expect(ap).toContain('const signInFolderRule: CredentialFolderRule = (dirs) => secureSignInFoldersWindows(dirs, homeMirrorLinks(dirs))')
    expect(ap).toContain('rule: CredentialFolderRule = signInFolderRule,')
    const sources = files(path.join('src', 'main')).filter((f) => path.basename(f) !== 'owner-only-folders.ts')
    expect(sources.length).toBeGreaterThan(10)
    for (const f of sources) {
      const src = code(f)
      if (path.basename(f) !== 'account-profiles.ts') expect(src, f).not.toMatch(/secureSignInFoldersWindows/)
      expect(src, f).not.toMatch(/secureFoldersWindows\s*\(|secureFoldersNative\s*\(/)
    }
    // The hook folders get the folders' own rule.
    expect(code('src/main/index.ts')).toContain('getResourcesDirectory(), secureOwnerOnlyFolders)')
  })
})
