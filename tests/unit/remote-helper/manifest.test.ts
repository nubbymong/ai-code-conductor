/**
 * The installer's Linux helper and its manifest, read by the app (plan
 * 2.1.3-beta.17, section A2, against A1's contract; aicc_planning#411): the
 * app finds the two where A1's scripts put them, in a package
 * (resources/helper/manifest.json and resources/helper/linux-x64/aicc-helper)
 * and in a dev run (helper/target/helper-manifest/manifest.json and
 * helper/target/helper-linux-musl/aicc-helper), and reads what A1's manifest
 * writer writes. A file changed after its manifest was written is refused.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { helperManifest } from '../../../scripts/write-helper-manifest.mjs'
import { LINUX_HELPER, LINUX_HELPER_SOURCE, MANIFEST, MANIFEST_SOURCE, makeManifest, manifestText } from '../../../scripts/verify-bundled-helper.mjs'
import { buildElf } from '../scripts/elf-image'
import { LINUX_HELPER_PATH, MANIFEST_NAME, NO_LINUX_HELPER, bundledHelperPaths, readBundledLinuxHelper } from '../../../src/main/remote-helper/manifest'

const CARGO = readFileSync(resolve(__dirname, '../../../helper/Cargo.toml'), 'utf8')
const VERSION = /^version = "([^"]+)"/m.exec(CARGO)![1]

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
/** A static Linux helper and the manifest A1's writer makes for it. */
function written(body: number[] = [1, 2, 3]): { bytes: Buffer; text: string; sha256: string } {
  const bytes = buildElf({ body })
  const { problems, text } = helperManifest(bytes, CARGO) as { problems: string[]; text?: string }
  expect(problems).toEqual([])
  return { bytes, text: text!, sha256: createHash('sha256').update(bytes).digest('hex') }
}

describe('the installer\'s Linux helper: where the app looks', () => {
  it('in a package: resources/helper, with the names A1\'s packaging uses', () => {
    expect(LINUX_HELPER_PATH).toBe(LINUX_HELPER)
    expect(MANIFEST_NAME).toBe(MANIFEST)
    const p = bundledHelperPaths({ isPackaged: true, resourcesPath: join('C:', 'App', 'resources'), appPath: join('C:', 'App', 'resources', 'app.asar') })
    expect(p).toEqual({ manifest: join('C:', 'App', 'resources', 'helper', 'manifest.json'), file: join('C:', 'App', 'resources', 'helper', 'linux-x64', 'aicc-helper') })
  })

  it('in a dev run: where A1\'s scripts put the helper and write its manifest before packaging', () => {
    const p = bundledHelperPaths({ isPackaged: false, resourcesPath: join('R'), appPath: join('C:', 'src') })
    expect(p).toEqual({ manifest: join('C:', 'src', ...MANIFEST_SOURCE.split('/')), file: join('C:', 'src', ...LINUX_HELPER_SOURCE.split('/')) })
  })
})

describe('the installer\'s Linux helper: what the app reads', () => {
  for (const isPackaged of [false, true]) {
    it(`reads the manifest A1's writer makes, and the helper by its hash (${isPackaged ? 'a package' : 'a dev run'})`, async () => {
      const root = tempRoot()
      const p = bundledHelperPaths({ isPackaged, resourcesPath: root, appPath: root })
      const w = written()
      put(p.file, w.bytes)
      put(p.manifest, w.text)
      const r = await readBundledLinuxHelper(p)
      expect(r).toEqual({ ok: true, helper: { file: p.file, version: VERSION, sha256: w.sha256, size: w.bytes.length, folder: `${VERSION}-${w.sha256.slice(0, 12)}` } })
    })
  }

  it('a helper changed after its manifest was written is refused, and nothing is offered for upload', async () => {
    const root = tempRoot()
    const p = bundledHelperPaths({ isPackaged: true, resourcesPath: root, appPath: root })
    put(p.manifest, written([1]).text)
    put(p.file, written([2]).bytes)
    const r = await readBundledLinuxHelper(p)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.why).toMatch(/not the one its manifest names/)
  })

  it('no manifest, no helper, or a manifest that names only the Windows helper: this build carries none', async () => {
    const root = tempRoot()
    const p = bundledHelperPaths({ isPackaged: true, resourcesPath: root, appPath: root })
    const w = written()
    put(p.file, w.bytes)
    expect(await readBundledLinuxHelper(p)).toEqual({ ok: false, why: NO_LINUX_HELPER })
    put(p.manifest, manifestText({ v: 1, files: [{ path: 'aicc-helper.exe', version: VERSION, sha256: w.sha256 }] }))
    expect(await readBundledLinuxHelper(p)).toEqual({ ok: false, why: NO_LINUX_HELPER })
    put(p.manifest, manifestText(makeManifest({ version: VERSION, sha256: w.sha256 })))
    rmSync(p.file)
    expect(await readBundledLinuxHelper(p)).toEqual({ ok: false, why: NO_LINUX_HELPER })
  })
})
