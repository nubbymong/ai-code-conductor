// 2.1.3-beta.14 (aicc_planning#358, its code half): the hooks gateway's
// permission hold is deleted, not kept dormant. Nothing in src set its flag
// (`gateActive`, through `setPermissionGateActive` and the child's `setGate`
// message) and nothing answered a held request (`resolveResponder` had no
// caller), so the app answers no permission; the CLI's own prompt decides
// every one (ADR-030's parity row "Permission answers from the app").
//
// This is a whole-word name check: each name of the hold, as a word of its
// own, is in no file under src, and not in the Codex hook forwarder (which
// sent the marker only the hold read). `setGate` as a word does not match
// `setGateway` (hooks/index.ts), which stays.
//
// Not checked: tests/, docs/, CONTEXT.d/ and architecture/ (history and the
// deleted tests' own record); helper/ (the session helper never had the
// hold); a name built at run time from pieces, which a text search cannot
// see; files under src that are not text (images, fonts).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const SRC = path.join(ROOT, 'src')
const FORWARDER = path.join(ROOT, 'scripts', 'ccc-codex-hook.js')

/** Every name of the deleted hold: the flag and its setter, the child's two
 *  control messages and its announcement, the responder registry and its
 *  module, the gateway's and the proxy's hooks into it, and the forwarder's
 *  marker header with its two constants. */
const GONE = [
  'gateActive', 'setPermissionGateActive', 'setGate',
  'permission-respond', 'permission-open',
  'resolveResponder', 'registerResponder', 'deregisterResponder', 'permission-responders',
  'permissionResponders', 'permissionRegister', 'permissionDeregister',
  'resolvePermission', 'openPermissionRequests', '_registerResponderForTest',
  'x-ccc-hook-client', 'CODEX_HOOK_CLIENT_HEADER', 'CODEX_HOOK_CLIENT',
]

const TEXT = /\.(ts|tsx|js|mjs|cjs|json|html|css)$/

function textFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) textFiles(full, out)
    else if (TEXT.test(entry.name)) out.push(full)
  }
  return out
}

/** `name` as a word of its own: no letter, digit, `_`, `$` or `-` touches it. */
const asWord = (name: string) => new RegExp(`(?<![A-Za-z0-9_$-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$-])`)

describe('the dormant permission hold is gone (aicc_planning#358)', () => {
  it('the match is whole-word: it finds each name alone and not inside a longer one', () => {
    expect(asWord('setGate').test('gateway.setGate(x)')).toBe(true)
    expect(asWord('setGate').test('export function setGateway(gw)')).toBe(false)
    expect(asWord('CODEX_HOOK_CLIENT').test('CODEX_HOOK_CLIENT_HEADER')).toBe(false)
    expect(asWord('permission-open').test("{ type: 'permission-open' }")).toBe(true)
    expect(asWord('permission-responders').test("from '../permission-responders'")).toBe(true)
  })

  it('no file under src, and not the Codex hook forwarder, names any part of it', () => {
    const files = [...textFiles(SRC), FORWARDER]
    expect(files.length).toBeGreaterThan(900)
    const hits: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      for (const name of GONE) {
        if (asWord(name).test(text)) hits.push(`${path.relative(ROOT, file).split(path.sep).join('/')}: ${name}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('the responder registry module is gone', () => {
    expect(fs.existsSync(path.join(SRC, 'main', 'permission-responders.ts'))).toBe(false)
  })
})
