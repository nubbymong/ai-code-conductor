/**
 * The installer's Linux helpers and their manifest, read by the app (plan
 * 2.1.3-beta.17, section A2, against A1's contract; aicc_planning#411; from
 * 2.1.3-beta.19, section 1.3, aicc_planning#438, one per machine
 * architecture): the app finds them where A1's scripts put them, in a package
 * (resources/helper/manifest.json, resources/helper/linux-x64/aicc-helper and
 * resources/helper/linux-arm64/aicc-helper) and in a dev run
 * (helper/target/helper-manifest/manifest.json,
 * helper/target/helper-linux-musl/aicc-helper and
 * helper/target/helper-linux-musl-arm64/aicc-helper), and reads what A1's
 * manifest writer writes. A file changed after its manifest was written, or
 * not built for its row's machine, is refused; a dev run lists what it has.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { helperManifest } from '../../../scripts/write-helper-manifest.mjs'
import {
  LINUX_ARM64_HELPER, LINUX_ARM64_HELPER_SOURCE, LINUX_HELPER, LINUX_HELPER_SOURCE, LINUX_HELPERS, MANIFEST, MANIFEST_SOURCE, makeManifest, manifestText,
} from '../../../scripts/verify-bundled-helper.mjs'
import { buildElf } from '../scripts/elf-image'
import {
  CHANGED_LINUX_HELPER, DEV_LINUX_ARM64_HELPER, DEV_LINUX_HELPER, DEV_MANIFEST, LINUX_ARM64_HELPER_PATH, LINUX_HELPER_PATH, LINUX_HELPER_ROWS, MANIFEST_NAME,
  NO_LINUX_HELPER, bundledHelperPaths, manifestSha256For, readBundledLinuxHelper, readBundledLinuxHelpers,
} from '../../../src/main/remote-helper/manifest'

const CARGO = readFileSync(resolve(__dirname, '../../../helper/Cargo.toml'), 'utf8')
const VERSION = /^version = "([^"]+)"/m.exec(CARGO)![1]
const [X64_ROW, ARM_ROW] = LINUX_HELPER_ROWS

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'aicc-remote-manifest-'))
  made.push(d)
  return d
}
function put(file: string, bytes: Buffer | string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes)
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
/** A static x86-64 Linux helper and the manifest A1's writer makes for it alone (a dev run's). */
function written(body: number[] = [1, 2, 3]): { bytes: Buffer; text: string; sha256: string } {
  const bytes = buildElf({ body })
  const { problems, text } = helperManifest({ [LINUX_HELPER_SOURCE]: bytes }, CARGO, { onlyPresent: true }) as { problems: string[]; text?: string }
  expect(problems).toEqual([])
  return { bytes, text: text!, sha256: sha(bytes) }
}
/** Both static Linux helpers and the manifest A1's writer makes for a package. */
function writtenBoth(x64Body: number[] = [1, 2, 3], armBody: number[] = [4, 5, 6]) {
  const x64 = buildElf({ body: x64Body })
  const arm = buildElf({ machine: 183, body: armBody })
  const { problems, text } = helperManifest({ [LINUX_HELPER_SOURCE]: x64, [LINUX_ARM64_HELPER_SOURCE]: arm }, CARGO) as { problems: string[]; text?: string }
  expect(problems).toEqual([])
  return { x64, arm, text: text! }
}

describe('the installer\'s Linux helpers: where the app looks', () => {
  it('in a package: resources/helper, with the names A1\'s packaging uses, one file per architecture', () => {
    expect(LINUX_HELPER_PATH).toBe(LINUX_HELPER)
    expect(LINUX_ARM64_HELPER_PATH).toBe(LINUX_ARM64_HELPER)
    expect(MANIFEST_NAME).toBe(MANIFEST)
    const where = { isPackaged: true, resourcesPath: join('C:', 'App', 'resources'), appPath: join('C:', 'App', 'resources', 'app.asar') }
    expect(bundledHelperPaths(where)).toEqual({ manifest: join('C:', 'App', 'resources', 'helper', 'manifest.json'), file: join('C:', 'App', 'resources', 'helper', 'linux-x64', 'aicc-helper') })
    expect(bundledHelperPaths(where, ARM_ROW)).toEqual({ manifest: join('C:', 'App', 'resources', 'helper', 'manifest.json'), file: join('C:', 'App', 'resources', 'helper', 'linux-arm64', 'aicc-helper') })
  })

  it('in a dev run: where A1\'s scripts put each helper and write the manifest before packaging', () => {
    const where = { isPackaged: false, resourcesPath: join('R'), appPath: join('C:', 'src') }
    expect(bundledHelperPaths(where)).toEqual({ manifest: join('C:', 'src', ...MANIFEST_SOURCE.split('/')), file: join('C:', 'src', ...LINUX_HELPER_SOURCE.split('/')) })
    expect(bundledHelperPaths(where, ARM_ROW)).toEqual({ manifest: join('C:', 'src', ...MANIFEST_SOURCE.split('/')), file: join('C:', 'src', ...LINUX_ARM64_HELPER_SOURCE.split('/')) })
    expect([DEV_LINUX_HELPER, DEV_LINUX_ARM64_HELPER, DEV_MANIFEST]).toEqual([LINUX_HELPER_SOURCE, LINUX_ARM64_HELPER_SOURCE, MANIFEST_SOURCE])
  })

  it('the app\'s table and the packaging scripts\' table are the same rows, in the same order, each for its own ELF machine', () => {
    expect(LINUX_HELPER_ROWS.map((r) => ({ path: r.path, source: r.dev, machine: r.machine }))).toEqual(LINUX_HELPERS.map((h: { path: string; source: string; machine: number }) => ({ path: h.path, source: h.source, machine: h.machine })))
    expect([X64_ROW.arch, ARM_ROW.arch]).toEqual(['x86_64', 'aarch64'])
  })
})

describe('the installer\'s Linux helpers: what the app reads', () => {
  for (const isPackaged of [false, true]) {
    it(`reads the manifest A1's writer makes, and the x86-64 helper by its hash (${isPackaged ? 'a package' : 'a dev run'})`, async () => {
      const root = tempRoot()
      const p = bundledHelperPaths({ isPackaged, resourcesPath: root, appPath: root })
      const w = written()
      put(p.file, w.bytes)
      put(p.manifest, w.text)
      const r = await readBundledLinuxHelper(p)
      expect(r).toEqual({ ok: true, helper: { arch: 'x86_64', path: LINUX_HELPER, file: p.file, version: VERSION, sha256: w.sha256, size: w.bytes.length, folder: `${VERSION}-${w.sha256.slice(0, 12)}` } })
    })

    it(`reads both helpers of a package's manifest, each by its own hash, in the table's order (${isPackaged ? 'a package' : 'a dev run'})`, async () => {
      const root = tempRoot()
      const where = { isPackaged, resourcesPath: root, appPath: root }
      const w = writtenBoth()
      put(bundledHelperPaths(where).file, w.x64)
      put(bundledHelperPaths(where, ARM_ROW).file, w.arm)
      put(bundledHelperPaths(where).manifest, w.text)
      const r = await readBundledLinuxHelpers(where)
      expect(r).toEqual({
        ok: true,
        helpers: [
          { arch: 'x86_64', path: LINUX_HELPER, file: bundledHelperPaths(where).file, version: VERSION, sha256: sha(w.x64), size: w.x64.length, folder: `${VERSION}-${sha(w.x64).slice(0, 12)}` },
          { arch: 'aarch64', path: LINUX_ARM64_HELPER, file: bundledHelperPaths(where, ARM_ROW).file, version: VERSION, sha256: sha(w.arm), size: w.arm.length, folder: `${VERSION}-${sha(w.arm).slice(0, 12)}` },
        ],
      })
    })
  }

  it('a dev run with the x86-64 helper only (the writer\'s --only-present) lists what it has', async () => {
    const root = tempRoot()
    const where = { isPackaged: false, resourcesPath: root, appPath: root }
    const w = written()
    put(bundledHelperPaths(where).file, w.bytes)
    put(bundledHelperPaths(where).manifest, w.text)
    const r = await readBundledLinuxHelpers(where)
    expect(r.ok && r.helpers.map((h) => h.arch)).toEqual(['x86_64'])
  })

  it('a helper changed after its manifest was written is refused, and nothing is offered for upload', async () => {
    const root = tempRoot()
    const p = bundledHelperPaths({ isPackaged: true, resourcesPath: root, appPath: root })
    put(p.manifest, written([1]).text)
    put(p.file, written([2]).bytes)
    const r = await readBundledLinuxHelper(p)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.why).toMatch(/not the one its manifest names/)
    // Of two, one changed: neither is offered.
    const where = { isPackaged: true, resourcesPath: tempRoot(), appPath: '' }
    const w = writtenBoth()
    put(bundledHelperPaths(where).file, w.x64)
    put(bundledHelperPaths(where, ARM_ROW).file, buildElf({ machine: 183, body: [9, 9] }))
    put(bundledHelperPaths(where).manifest, w.text)
    expect(await readBundledLinuxHelpers(where)).toEqual({ ok: false, why: CHANGED_LINUX_HELPER })
  })

  it('a file not built for its row\'s machine is refused even when the manifest names its hash: the x86-64 file in the arm64 place is never offered', async () => {
    const where = { isPackaged: true, resourcesPath: tempRoot(), appPath: '' }
    const x64 = buildElf({ body: [1] })
    put(bundledHelperPaths(where).file, x64)
    put(bundledHelperPaths(where, ARM_ROW).file, x64)
    put(bundledHelperPaths(where).manifest, manifestText(makeManifest({ version: VERSION, sha256: { [LINUX_HELPER]: sha(x64), [LINUX_ARM64_HELPER]: sha(x64) } })))
    expect(await readBundledLinuxHelpers(where)).toEqual({ ok: false, why: CHANGED_LINUX_HELPER })
    expect(await readBundledLinuxHelper(bundledHelperPaths(where, ARM_ROW), ARM_ROW)).toEqual({ ok: false, why: CHANGED_LINUX_HELPER })
  })

  it('no manifest, no helper, or a manifest that names only the Windows helper: this build carries none', async () => {
    const root = tempRoot()
    const where = { isPackaged: true, resourcesPath: root, appPath: root }
    const p = bundledHelperPaths(where)
    const w = written()
    put(p.file, w.bytes)
    expect(await readBundledLinuxHelper(p)).toEqual({ ok: false, why: NO_LINUX_HELPER })
    expect(await readBundledLinuxHelpers(where)).toEqual({ ok: false, why: NO_LINUX_HELPER })
    put(p.manifest, manifestText({ v: 1, files: [{ path: 'aicc-helper.exe', version: VERSION, sha256: w.sha256 }] }))
    expect(await readBundledLinuxHelper(p)).toEqual({ ok: false, why: NO_LINUX_HELPER })
    expect(await readBundledLinuxHelpers(where)).toEqual({ ok: false, why: NO_LINUX_HELPER })
    put(p.manifest, manifestText(makeManifest({ version: VERSION, sha256: { [LINUX_HELPER]: w.sha256 } })))
    rmSync(p.file)
    expect(await readBundledLinuxHelper(p)).toEqual({ ok: false, why: NO_LINUX_HELPER })
    expect(await readBundledLinuxHelpers(where)).toEqual({ ok: false, why: NO_LINUX_HELPER })
  })
})

describe('the manifest entry a machine is compared with: its own architecture\'s', () => {
  const json = { v: 1, files: [{ path: LINUX_HELPER, version: '0.1.0', sha256: 'a'.repeat(64) }, { path: LINUX_ARM64_HELPER, version: '0.1.0', sha256: 'b'.repeat(64) }] }

  it('aarch64 reads the arm64 entry and x86_64 the x86-64 one; anything else reads none', () => {
    expect(manifestSha256For(json, 'aarch64')).toBe('b'.repeat(64))
    expect(manifestSha256For(json, 'x86_64')).toBe('a'.repeat(64))
    for (const arch of ['armv7l', 'armhf', 'arm64', 'linux-arm64/aicc-helper', '../linux-x64', '', null]) expect(manifestSha256For(json, arch), String(arch)).toBeNull()
    // A manifest with the x86-64 entry only (a dev run) has none for aarch64.
    expect(manifestSha256For({ v: 1, files: [json.files[0]] }, 'aarch64')).toBeNull()
    expect(manifestSha256For(null, 'x86_64')).toBeNull()
  })
})
