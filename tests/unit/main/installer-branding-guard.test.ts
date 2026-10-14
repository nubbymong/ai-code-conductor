import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANIM_STEPS, artManifest, bmpMaxDelta, renderAll } from '../../../scripts/gen-installer-art.mjs'

/**
 * Guards for the branded Windows installer (finding O4, aicc_planning #180).
 *
 * makensis cannot run on the owner's machine, so the real compile (-WX, both
 * the installer and the BUILD_UNINSTALLER pass) happens on CI and the VM. This
 * file holds what can be proved from the files alone, and it is aimed at the
 * ways this change could ship broken while every other test stayed green:
 *   - a missing or malformed bitmap (electron-builder falls back to NSIS's
 *     stock art for a default name, and MUI shows a blank panel for a bad BMP);
 *   - an interface define placed after the first page macro (MUI then bakes in
 *     its white defaults without a word);
 *   - a Function or Var that one compile pass declares but never references,
 *     which -WX turns into a failed release build;
 *   - motion or a splash leaking onto the Installing page or an in-app update;
 *   - a live Back button on the elevated inner instance's first page, which
 *     would walk the wizard off its front edge and end Setup;
 *   - a plugin from outside the pinned NSIS bundles;
 *   - a call into electron-builder's own plugins (UAC, StdUtils) compiled at
 *     file scope, directly or through a helper macro a file-scope Function
 *     inserts, which fails the installer pass whenever electron-builder
 *     happens to include this file before it adds their folder.
 * Reads files only: no makensis, no registry, no installer run.
 */

const ROOT = join(__dirname, '../../..')
const NSH_PATH = join(ROOT, 'build', 'installer.nsh')
const readNsh = () => readFileSync(NSH_PATH, 'utf-8').replace(/\r\n/g, '\n')
const pkg = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))

// ---------------------------------------------------------------------------
// BMP header
// ---------------------------------------------------------------------------

interface BmpInfo {
  ok: boolean
  problems: string[]
  width: number
  height: number
}

/** A 24-bit, uncompressed, bottom-up BMP with a 40-byte BITMAPINFOHEADER. */
function inspectBmp(file: string): BmpInfo {
  const problems: string[] = []
  if (!existsSync(file)) return { ok: false, problems: ['missing'], width: 0, height: 0 }
  const b = readFileSync(file)
  if (b.length < 54) return { ok: false, problems: [`only ${b.length} bytes`], width: 0, height: 0 }
  const width = b.readInt32LE(18)
  const height = b.readInt32LE(22)
  if (b.toString('ascii', 0, 2) !== 'BM') problems.push('no BM signature')
  if (b.readUInt32LE(2) !== b.length) problems.push(`size field ${b.readUInt32LE(2)} != file length ${b.length}`)
  if (b.readUInt32LE(10) !== 54) problems.push(`pixel offset ${b.readUInt32LE(10)} != 54`)
  if (b.readUInt32LE(14) !== 40) problems.push(`DIB header ${b.readUInt32LE(14)} bytes, not BITMAPINFOHEADER (40)`)
  if (b.readUInt16LE(26) !== 1) problems.push('planes != 1')
  if (b.readUInt16LE(28) !== 24) problems.push(`${b.readUInt16LE(28)} bpp, not 24`)
  if (b.readUInt32LE(30) !== 0) problems.push(`compression ${b.readUInt32LE(30)}, not BI_RGB`)
  if (height <= 0) problems.push('not bottom-up')
  const stride = Math.ceil((width * 3) / 4) * 4
  if (b.length !== 54 + stride * Math.abs(height)) problems.push(`length ${b.length} != 54 + ${stride} x ${Math.abs(height)}`)
  return { ok: problems.length === 0, problems, width, height }
}

// ---------------------------------------------------------------------------
// A static model of the two compile passes
// ---------------------------------------------------------------------------

type Pass = 'inst' | 'un'
const BOTH: Pass[] = ['inst', 'un']

interface NshLine {
  n: number
  code: string // the line without its comment, trimmed; '' for a comment line
  passes: Pass[] // the passes that compile this line (when it is not in a macro body)
  macro: string | null // the macro whose body holds this line
  fn: string | null // the file-scope Function whose body holds this line
}

/** Drop a ; or # comment that is not inside a string. */
function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c
    } else if (c === ';' || c === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

/**
 * Which pass compiles each line: !ifndef BUILD_UNINSTALLER is the installer
 * only, !ifdef BUILD_UNINSTALLER the uninstaller only, any other !if* both.
 */
function analyse(src: string): NshLine[] {
  const stack: { kind: 'inst' | 'un' | 'other'; inElse: boolean }[] = []
  const out: NshLine[] = []
  let macro: string | null = null
  let fn: string | null = null
  src.split('\n').forEach((raw, idx) => {
    const code = stripComment(raw).trim()
    let m: RegExpMatchArray | null
    if ((m = code.match(/^!macro\s+(\S+)/))) macro = m[1]
    if (/^!ifndef\s+BUILD_UNINSTALLER\b/.test(code)) stack.push({ kind: 'inst', inElse: false })
    else if (/^!ifdef\s+BUILD_UNINSTALLER\b/.test(code)) stack.push({ kind: 'un', inElse: false })
    else if (/^!if/.test(code)) stack.push({ kind: 'other', inElse: false })
    else if (/^!else\b/.test(code)) stack[stack.length - 1].inElse = !stack[stack.length - 1].inElse
    else if (/^!endif\b/.test(code)) stack.pop()
    let passes = [...BOTH]
    for (const f of stack) {
      if (f.kind === 'other') continue
      const only: Pass = (f.kind === 'inst') !== f.inElse ? 'inst' : 'un'
      passes = passes.filter((p) => p === only)
    }
    if (!macro && (m = code.match(/^Function\s+"?([^\s"]+)"?/))) fn = m[1]
    out.push({ n: idx + 1, code, passes, macro, fn })
    if (!macro && /^FunctionEnd\b/.test(code)) fn = null
    if (/^!macroend\b/.test(code)) macro = null
  })
  expect(stack, 'unbalanced !if / !endif in build/installer.nsh').toEqual([])
  return out
}

/** En dash and em dash, by code point (this file stays ASCII). */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** File-scope lines only: macro bodies are compiled where they are inserted, not here. */
const fileScope = (lines: NshLine[]) => lines.filter((l) => !l.macro && l.code !== '')

function functionDefs(lines: NshLine[]) {
  return fileScope(lines)
    .map((l) => ({ l, m: l.code.match(/^Function\s+"?([^\s"]+)"?/) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.m![1], passes: x.l.passes, n: x.l.n }))
}

function varDefs(lines: NshLine[]) {
  return fileScope(lines)
    .filter((l) => !l.fn)
    .map((l) => ({ l, m: l.code.match(/^Var\s+(?:\/GLOBAL\s+)?(\S+)/) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.m![1], passes: x.l.passes, n: x.l.n }))
}

/** The body of one file-scope Function (its lines, without the Function and FunctionEnd lines). */
function functionBody(lines: NshLine[], name: string): NshLine[] {
  return lines.filter((l) => !l.macro && l.fn === name && !/^Function(End)?\b/.test(l.code))
}

function macroBody(src: string, name: string): string {
  const m = src.match(new RegExp(`^!macro ${name}\\b[\\s\\S]*?^!macroend`, 'm'))
  if (!m) throw new Error(`macro ${name} not found in build/installer.nsh`)
  return m[0]
}

/** The page statements at file scope, in the order makensis numbers them. */
const PAGE_RE = /^(!insertmacro\s+(MUI_(UN)?PAGE_\w+|PAGE_INSTALL_MODE)\b|Page(Ex)?\s|UninstPage\s)/
const pageLines = (lines: NshLine[]) => fileScope(lines).filter((l) => PAGE_RE.test(l.code))

/**
 * The plugin a statement calls (`plugin::function` at the start of the
 * statement), lower-cased, or null. Only the statement head counts, so the
 * `dll::function` inside a System::Call string is not taken for a plugin.
 */
const pluginOf = (code: string): string | null => code.match(/^([A-Za-z_]\w*)::\w+/)?.[1].toLowerCase() ?? null

/**
 * A call into a plugin electron-builder ships in its own nsis-resources
 * bundle rather than in NSIS's Plugins folder: directly (`UAC::_`), or through
 * the include file that wraps it (`${UAC_IsInnerInstance}`,
 * `!insertmacro UAC_RunElevated`, `${StdUtils.TestParameter}`), or through a
 * flag define electron-builder generates (`${isUpdated}` and the other
 * `${is...}` flags, each a StdUtils.TestParameter call). electron-builder adds
 * that folder with !addplugindir from a task that runs at the same time as the
 * one that includes build/installer.nsh (app-builder-lib NsisTarget.js,
 * computeCommonInstallerScriptHeader). So when such a call is compiled at file
 * scope, the folder may not be on the plugin path yet, and makensis stops with
 * "Plugin not found". Lower-case `is`: NSIS's own WinVer and x64 defines are
 * `${IsWin10}`, `${IsNativeAMD64}`.
 */
const LATE_PLUGIN_CALLS: RegExp[] = [
  /\b(?:UAC|StdUtils|nsProcess|INetC|nsis7z|nsisunz|WinShell|SpiderBanner|EmbedHTML)::/i,
  /\$\{UAC_\w+\}/,
  /!insertmacro\s+_?UAC_\w+/,
  /\$\{StdUtils\.\w+\}/,
  /!insertmacro\s+_StdU_\w+/,
  /\$\{is[A-Z]\w*\}/,
]

const makesLateCall = (code: string) => LATE_PLUGIN_CALLS.some((re) => re.test(code))

/** Each macro this file defines, with the code lines of its body. */
function localMacros(lines: NshLine[]): Map<string, NshLine[]> {
  const out = new Map<string, NshLine[]>()
  for (const l of lines) {
    if (!l.macro || l.code === '' || /^!macro(end)?\b/.test(l.code)) continue
    out.set(l.macro, [...(out.get(l.macro) ?? []), l])
  }
  return out
}

/**
 * The !define names in this file that insert a macro when used as `${NAME}`:
 * a value that is `!insertmacro X`, or a LogicLib test (`"" X ""`, which
 * ${If} turns into `!insertmacro _X`). Name to macro.
 */
function macroWrappers(lines: NshLine[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const l of lines) {
    const d = l.code.match(/^!define\s+(?:\/\w+\s+)*(\S+)\s+(.+)$/)
    if (!d) continue
    const value = d[2].replace(/^(["'`])(.*)\1$/, '$2').trim()
    const ins = value.match(/^!insertmacro\s+"?([^\s"]+)"?/)
    const test = value.match(/^""\s+(\S+)\s+""$/)
    if (ins) out.set(d[1], ins[1])
    else if (test) out.set(d[1], `_${test[1]}`)
  }
  return out
}

/**
 * The macros one statement inserts: by !insertmacro, or through a `${NAME}`
 * wrapper. A !define line inserts nothing: it only stores the text.
 */
function insertedMacros(code: string, wrappers: Map<string, string>): string[] {
  if (/^!define\b/.test(code)) return []
  const out: string[] = []
  const direct = code.match(/^!insertmacro\s+"?([^\s"]+)"?/)
  if (direct) out.push(direct[1])
  for (const ref of code.matchAll(/\$\{([^}\s]+)\}/g)) {
    const target = wrappers.get(ref[1])
    if (target) out.push(target)
  }
  return out
}

/**
 * The late call a local macro makes, in its own body or in a local macro it
 * inserts (to any depth): the macros on the way, then the call. Null if none.
 */
function lateCallIn(
  name: string,
  macros: Map<string, NshLine[]>,
  wrappers: Map<string, string>,
  seen: Set<string> = new Set(),
): string[] | null {
  if (seen.has(name)) return null
  seen.add(name)
  for (const l of macros.get(name) ?? []) {
    if (makesLateCall(l.code)) return [name, l.code]
    for (const inner of insertedMacros(l.code, wrappers)) {
      const chain = macros.has(inner) ? lateCallIn(inner, macros, wrappers, seen) : null
      if (chain) return [name, ...chain]
    }
  }
  return null
}

interface LateCall {
  n: number
  fn: string | null
  code: string
  via: string[] // empty for a direct call; else the macros inserted on the way, then the call
}

/**
 * Each file-scope line (Function bodies included) that makes such a call,
 * itself or through a macro this file defines and the line inserts.
 *
 * A hook macro (preInit, customInit, customInstall and the rest) is exempt:
 * installer.nsi inserts it after the whole generated header, and this file
 * never inserts one. A helper macro (ReadUserPath, say) counts where it is
 * inserted: from a file-scope Function its body compiles at file scope too,
 * so the line that inserts it is reported, with the chain that leads to the
 * call. From a hook macro it compiles late, like the hook.
 */
function lateCalls(lines: NshLine[]): LateCall[] {
  const macros = localMacros(lines)
  const wrappers = macroWrappers(lines)
  const out: LateCall[] = []
  for (const l of fileScope(lines)) {
    if (makesLateCall(l.code)) {
      out.push({ n: l.n, fn: l.fn, code: l.code, via: [] })
      continue
    }
    for (const name of insertedMacros(l.code, wrappers)) {
      const chain = macros.has(name) ? lateCallIn(name, macros, wrappers) : null
      if (chain) {
        out.push({ n: l.n, fn: l.fn, code: l.code, via: chain })
        break
      }
    }
  }
  return out
}

/** The BRANDING section: from its banner to the folder pages' first Var. */
function brandingSection(src: string): string {
  const start = src.indexOf('; BRANDING:')
  const end = src.indexOf('Var DataDir')
  if (start < 0 || end < 0 || end < start) throw new Error('BRANDING section not found ahead of Var DataDir')
  return src.slice(start, end)
}

// ---------------------------------------------------------------------------

describe('installer branding: assets', () => {
  it('package.json names the sidebar, the uninstaller sidebar and the header explicitly, so a missing file fails the build', () => {
    // A DEFAULT name that is missing silently falls back to nsis3-metro.bmp
    // (platformPackager.getResource); an explicit one that is missing throws.
    const nsis = pkg().build.nsis
    expect(nsis.installerSidebar).toBe('build/installerSidebar.bmp')
    expect(nsis.uninstallerSidebar).toBe('build/installerSidebar.bmp')
    expect(nsis.installerHeader).toBe('build/installerHeader.bmp')
    for (const k of ['installerSidebar', 'uninstallerSidebar', 'installerHeader']) {
      expect(existsSync(join(ROOT, nsis[k])), `${k}: ${nsis[k]} is missing`).toBe(true)
    }
  })

  it('the three Modern UI / AdvSplash bitmaps are 24-bit BI_RGB BMPs at the wizard sizes', () => {
    // 164x314 is the Welcome/Finish panel (109x193 dialog units), 150x57 the
    // header image control (100x35 du), 720x430 the boot splash's own size.
    const want: [string, number, number][] = [
      ['build/installerSidebar.bmp', 164, 314],
      ['build/installerHeader.bmp', 150, 57],
      ['build/installerSplash.bmp', 720, 430],
    ]
    for (const [file, w, h] of want) {
      const info = inspectBmp(join(ROOT, file))
      expect(info.problems, file).toEqual([])
      expect([info.width, info.height], file).toEqual([w, h])
    }
  })

  it('every bitmap the generator owns is committed, well-formed and the right size', () => {
    for (const a of artManifest() as { file: string; width: number; height: number }[]) {
      const info = inspectBmp(join(ROOT, a.file))
      expect(info.problems, a.file).toEqual([])
      expect([info.width, info.height], a.file).toEqual([a.width, a.height])
    }
  })

  it('the committed bitmaps are what scripts/gen-installer-art.mjs draws (re-runnable, not hand-edited)', () => {
    const art = renderAll(ROOT) as Map<string, { toBmp(): Buffer }>
    expect([...art.keys()].sort()).toEqual((artManifest() as { file: string }[]).map((a) => a.file).sort())
    for (const [rel, cv] of art) {
      const file = join(ROOT, rel)
      const delta = existsSync(file) ? bmpMaxDelta(cv.toBmp(), readFileSync(file)) : Infinity
      // One rounding step of slack per channel, so another Node build cannot fail it.
      expect(delta, `${rel} differs from the generator: run node scripts/gen-installer-art.mjs`).toBeLessThanOrEqual(1)
    }
  })

  it('every File the installer embeds exists under build/ as a valid BMP, and the frame set is complete', () => {
    const src = readNsh()
    const sources = [...src.matchAll(/^\s*File\s+"\/oname=\$PLUGINSDIR\\([^"]+)"\s+"([^"]+)"/gm)].map((m) => ({ oname: m[1], src: m[2] }))
    expect(sources.length).toBeGreaterThan(0)
    const manifest = new Map((artManifest() as { file: string; width: number; height: number }[]).map((a) => [a.file, a]))
    for (const s of sources) {
      const rel = s.src.replace('${CCC_ART_DIR}', 'build/installer-art').replace('${BUILD_RESOURCES_DIR}', 'build').replace(/\\/g, '/')
      expect(rel, `${s.src} must resolve under build/`).toMatch(/^build\/[\w/-]+\.bmp$/)
      const info = inspectBmp(join(ROOT, rel))
      expect(info.problems, rel).toEqual([])
      const a = manifest.get(rel)
      expect(a, `${rel} is embedded but the generator does not own it`).toBeDefined()
      expect([info.width, info.height], rel).toEqual([a!.width, a!.height])
    }
    // The animation steps agree between the script and the installer, and
    // every intermediate frame of both sequences is embedded under the name
    // CccAnimShowFrame builds ($PLUGINSDIR\<prefix><n>.bmp).
    const steps = src.match(/!define CCC_ANIM_STEPS (\d+)/)
    expect(Number(steps?.[1])).toBe(ANIM_STEPS)
    expect(ANIM_STEPS).toBeGreaterThanOrEqual(6)
    expect(ANIM_STEPS).toBeLessThanOrEqual(10)
    const onames = new Set(sources.map((s) => s.oname))
    for (let k = 1; k < ANIM_STEPS; k++) {
      expect(onames.has(`ccc-side-${k}.bmp`), `sidebar frame ${k}`).toBe(true)
      expect(onames.has(`ccc-emblem-${k}.bmp`), `emblem frame ${k}`).toBe(true)
    }
    expect(onames.has('ccc-emblem.bmp')).toBe(true)
    expect(onames.has('ccc-splash.bmp')).toBe(true)
    expect(src).toMatch(/StrCpy \$cccAnimPrefix "ccc-side-"/)
    expect(src).toMatch(/StrCpy \$cccAnimPrefix "ccc-emblem-"/)
    expect(src).toMatch(/StrCpy \$cccAnimFinal "\$PLUGINSDIR\\modern-wizard\.bmp"/)
    expect(src).toMatch(/StrCpy \$cccAnimFinal "\$PLUGINSDIR\\ccc-emblem\.bmp"/)
  })
})

describe('installer branding: page order and interface settings', () => {
  it('the new Welcome page is the FIRST page, ahead of the two folder pages', () => {
    const pages = pageLines(analyse(readNsh()))
    expect(pages[0]?.code).toBe('!insertmacro MUI_PAGE_WELCOME')
    expect(pages[0]?.passes).toEqual(['inst'])
    const data = pages.findIndex((l) => /^Page custom DataDirPage\b/.test(l.code))
    const res = pages.findIndex((l) => /^Page custom ResourcesDirPage\b/.test(l.code))
    expect(data).toBe(1)
    expect(res).toBe(2)
    // customWelcomePage would land AFTER the folder pages (assistedInstaller.nsh).
    expect(readNsh()).not.toMatch(/^!macro customWelcomePage\b/m)
  })

  it('the theme, classic-controls, GUIINIT and Welcome hook defines all precede MUI_PAGE_WELCOME', () => {
    // Modern UI reads interface settings when the first page macro inserts
    // MUI_INTERFACE; a define after that point is silently ignored.
    const lines = analyse(readNsh())
    const at = (re: RegExp) => fileScope(lines).find((l) => re.test(l.code))
    const welcome = at(/^!insertmacro MUI_PAGE_WELCOME$/)!
    expect(welcome).toBeDefined()
    for (const re of [
      /^!define MUI_BGCOLOR\b/,
      /^!define MUI_TEXTCOLOR\b/,
      /^!define MUI_FORCECLASSICCONTROLS\b/,
      /^!define MUI_CUSTOMFUNCTION_GUIINIT\b/,
      /^!define MUI_WELCOMEPAGE_TITLE\b/,
      /^!define MUI_WELCOMEPAGE_TEXT\b/,
      /^!define MUI_PAGE_CUSTOMFUNCTION_PRE\b/,
      /^!define MUI_PAGE_CUSTOMFUNCTION_SHOW\b/,
      /^!define MUI_PAGE_CUSTOMFUNCTION_DESTROYED\b/,
    ]) {
      const d = at(re)
      expect(d, `${re} is not defined at file scope`).toBeDefined()
      expect(d!.n, `${re} must come before MUI_PAGE_WELCOME (line ${welcome.n})`).toBeLessThan(welcome.n)
    }
    // The colours are in BOTH passes, so the uninstaller's pages match.
    expect(at(/^!define MUI_BGCOLOR\b/)!.passes).toEqual(BOTH)
    expect(at(/^!define MUI_TEXTCOLOR\b/)!.passes).toEqual(BOTH)
    expect(at(/^!define MUI_FORCECLASSICCONTROLS\b/)!.passes).toEqual(BOTH)
    expect(at(/^!define MUI_BGCOLOR\b/)!.code).toBe('!define MUI_BGCOLOR "${CCC_BRAND_BG}"')
    expect(readNsh()).toMatch(/^!define CCC_BRAND_BG "0B0E15"$/m)
    // The GUIINIT hook and its Function are installer-pass only.
    expect(at(/^!define MUI_CUSTOMFUNCTION_GUIINIT\b/)!.passes).toEqual(['inst'])
    expect(at(/^!define MUI_CUSTOMFUNCTION_GUIINIT\b/)!.code).toBe('!define MUI_CUSTOMFUNCTION_GUIINIT CccBrandGuiInit')
  })

  it('in the elevated inner instance, the first page shown has no live Back button', () => {
    // NSIS gives every page after the first a live Back button when it
    // compiles. The inner instance aborts the Welcome page (CccWelcomePre), so
    // the first page it shows is the second, and Back from there re-enters the
    // aborted Welcome page, skips on backwards off the front of the wizard and
    // ends Setup with nothing installed. That exit bypasses .onUserAbort, so a
    // suspended uninstall record is never restored. So the page after Welcome
    // hides and disables Back in the inner instance, before nsDialogs::Show.
    // The inner-instance answer is $cccIsInnerInstance, recorded by preInit
    // (see 'installer branding: plugin calls' below).
    const lines = analyse(readNsh())
    expect(functionBody(lines, 'CccWelcomePre').map((l) => l.code)).toEqual(['${If} $cccIsInnerInstance == 1', 'Abort', '${EndIf}'])
    const pages = pageLines(lines)
    expect(pages[0]?.code).toBe('!insertmacro MUI_PAGE_WELCOME')
    const creator = pages[1]?.code.match(/^Page custom (\w+)\b/)?.[1]
    expect(creator, 'the page after Welcome is a custom page').toBe('DataDirPage')
    const body = functionBody(lines, creator!)
    const codes = body.map((l) => l.code)
    const at = codes.indexOf('${If} $cccIsInnerInstance == 1')
    expect(at, `${creator} has no inner-instance branch`).toBeGreaterThanOrEqual(0)
    const block = body.slice(at, at + 5)
    const reg = block[1]?.code.match(/^GetDlgItem (\$\w+) \$HWNDPARENT 3$/)?.[1]
    expect(reg, 'GetDlgItem <reg> $HWNDPARENT 3 (the Back button) opens the branch').toBeDefined()
    expect(block[0].code).toBe('${If} $cccIsInnerInstance == 1')
    expect(block.slice(2, 4).map((l) => l.code).sort()).toEqual([`EnableWindow ${reg} 0`, `ShowWindow ${reg} \${SW_HIDE}`])
    expect(block[4].code).toBe('${EndIf}')
    // Installer pass only ($cccIsInnerInstance is declared in that pass only),
    // and in force before the page runs.
    for (const l of block) expect(l.passes, `line ${l.n}`).toEqual(['inst'])
    expect(at).toBeLessThan(codes.indexOf('nsDialogs::Show'))
    expect(codes.indexOf('nsDialogs::Create 1018')).toBeLessThan(at)
  })

  it('both folder pages carry a title and subtitle in the header band', () => {
    const lines = analyse(readNsh())
    const data = functionBody(lines, 'DataDirPage').map((l) => l.code).join('\n')
    const res = functionBody(lines, 'ResourcesDirPage').map((l) => l.code).join('\n')
    expect(data).toMatch(/^!insertmacro MUI_HEADER_TEXT "Data folder" "[^"]+"$/m)
    expect(res).toMatch(/^!insertmacro MUI_HEADER_TEXT "Resources folder" "[^"]+"$/m)
    // Dark bodies: the dialog, its label and the path field take the brand colours.
    for (const body of [data, res]) {
      expect(body).toMatch(/SetCtlColors \$0 "" "\$\{CCC_BRAND_BG\}"/)
      expect(body).toMatch(/SetCtlColors \$0 "\$\{CCC_BRAND_TEXT\}" "\$\{CCC_BRAND_BG\}"/)
      expect(body).toMatch(/SetCtlColors \$(DataDir|ResourcesDir) "\$\{CCC_BRAND_TEXT\}" "\$\{CCC_BRAND_FIELD\}"/)
    }
  })

  it('the folder-page emblem is a centred bitmap on the dark ground, in a strip it fits', () => {
    // Two ways the emblem breaks that only a screen capture would show: a
    // STATIC control with no colours of its own paints the system face colour,
    // so without SetCtlColors the emblem sits in a light box on the dark page;
    // and without SS_CENTERIMAGE the bitmap is drawn at the strip's top-left.
    const lines = analyse(readNsh())
    const body = functionBody(lines, 'CccFolderArt').map((l) => l.code)
    const at = body.findIndex((c) => /^nsDialogs::CreateControl\s+STATIC\s/.test(c))
    expect(at, 'CccFolderArt creates a STATIC control').toBeGreaterThanOrEqual(0)
    // nsDialogs::CreateControl class style exstyle x y width height text
    const m = body[at].match(/^nsDialogs::CreateControl\s+STATIC\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+""$/)
    expect(m, body[at]).not.toBeNull()
    const [, style, , x, y, w, h] = m!
    expect(style.split('|').sort()).toEqual(['${DEFAULT_STYLES}', '${SS_BITMAP}', '${SS_CENTERIMAGE}'])
    expect(body[at + 1]).toBe('Pop $cccAnimCtl')
    const colours = body.indexOf('SetCtlColors $cccAnimCtl "" "${CCC_BRAND_BG}"')
    expect(colours, 'SetCtlColors $cccAnimCtl "" "${CCC_BRAND_BG}"').toBeGreaterThan(at + 1)
    expect(colours).toBeLessThan(body.indexOf('Call CccAnimStart'))

    // The strip: full width, from y to the bottom of the page.
    const pct = (s: string) => {
      const p = s.match(/^(\d+)%$/)
      expect(p, `${s} is a percentage`).not.toBeNull()
      return Number(p![1])
    }
    expect([x, w]).toEqual(['0', '100%'])
    expect(pct(y) + pct(h)).toBe(100)

    // Modern UI's page area is 300 x 140 dialog units. At 96 DPI the wizard's
    // MS Shell Dlg 8 pt gives 13 px per 8 vertical units, and at least 5 px per
    // 4 horizontal units. The bitmap is not scaled (SS_CENTERIMAGE), so it must
    // fit the strip at 100%; at 150% the strip only grows.
    const PAGE_W_DU = 300
    const PAGE_H_DU = 140
    const stripPx = (PAGE_H_DU * (13 / 8) * pct(h)) / 100
    const pageWPx = PAGE_W_DU * (5 / 4)
    const emblem = artManifest().find((a) => a.file === 'build/installer-art/emblem.bmp')
    expect(emblem).toBeDefined()
    expect(emblem!.height, `emblem ${emblem!.height} px in a ${stripPx.toFixed(1)} px strip`).toBeLessThanOrEqual(Math.floor(stripPx))
    expect(emblem!.width).toBeLessThanOrEqual(Math.floor(pageWPx))

    // Nothing on either folder page reaches down into the strip.
    const toDu = (v: string) => {
      if (v === '0') return 0
      const u = v.match(/^(\d+)u$/)
      if (u) return Number(u[1])
      return (pct(v) * PAGE_H_DU) / 100
    }
    for (const page of ['DataDirPage', 'ResourcesDirPage']) {
      const controls = functionBody(lines, page)
        .map((l) => l.code.match(/^\$\{NSD_Create\w+\}\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s/))
        .filter((c): c is RegExpMatchArray => c !== null)
      expect(controls.length, `${page} controls`).toBeGreaterThan(0)
      for (const c of controls) {
        expect(toDu(c[2]) + toDu(c[4]), `${page}: ${c[0]}`).toBeLessThanOrEqual((pct(y) * PAGE_H_DU) / 100)
      }
    }
  })

  it('the uninstaller has its own Welcome page, through electron-builder\'s customUnWelcomePage hook', () => {
    const body = macroBody(readNsh(), 'customUnWelcomePage')
    expect(body).toMatch(/!define MUI_WELCOMEPAGE_TITLE "Uninstall AI Code Conductor"/)
    expect(body).toMatch(/!define MUI_WELCOMEPAGE_TEXT "[^"]+"/)
    expect(body).toMatch(/!insertmacro MUI_UNPAGE_WELCOME\b/)
    // What it promises has to hold for customUnInstall: the CONFIG question is
    // conditional on the folder existing, and the data folder is not touched.
    const un = macroBody(readNsh(), 'customUnInstall')
    expect(un).toMatch(/\$\{If\} \$\{FileExists\} "\$0\\CONFIG\\\*\.\*"/)
    expect(un).not.toMatch(/DataDirectory/)
  })
})

describe('installer branding: -WX in both compile passes', () => {
  it('every file-scope Function is referenced in every pass that compiles it, and never called where it is not defined', () => {
    // makensis -WX: "install function X not referenced - zeroing code out" is
    // a warning, so a Function one pass compiles but never calls fails that
    // pass's build. Self-references (a timer killing itself) do not count.
    const lines = analyse(readNsh())
    const scope = fileScope(lines)
    const defs = functionDefs(lines)
    expect(defs.map((d) => d.name)).toEqual(expect.arrayContaining([
      'CccBrandGuiInit', 'CccWelcomePre', 'CccWelcomeShow', 'CccFolderArt',
      'CccAnimStart', 'CccAnimTick', 'CccAnimShowFrame', 'CccAnimStop', 'DataDirPage', 'ResourcesDirPage',
    ]))
    const unreferenced: string[] = []
    for (const d of defs) {
      const re = new RegExp(`(?<![\\w.])${esc(d.name)}(?![\\w.])`)
      const refs = scope.filter((l) => l.n !== d.n && l.fn !== d.name && re.test(l.code))
      for (const p of d.passes) {
        if (!refs.some((r) => r.passes.includes(p))) unreferenced.push(`${d.name} (${p} pass)`)
      }
    }
    expect(unreferenced).toEqual([])
    // The other direction: a Call / timer / hook naming a Ccc* function only
    // in passes that define it. customHeader's Functions count as defined:
    // electron-builder inserts that macro at file scope (installer.nsi), so the
    // passes its own !ifndef gives them are the passes they exist in.
    const defined = new Map(defs.map((d) => [d.name, d.passes]))
    for (const l of lines.filter((x) => x.macro === 'customHeader')) {
      const m = l.code.match(/^Function\s+"?([^\s"]+)"?/)
      if (m) defined.set(m[1], l.passes)
    }
    const dangling: string[] = []
    for (const l of scope) {
      for (const m of l.code.matchAll(/(?:Call|NSD_CreateTimer\}|NSD_KillTimer\}|GetFunctionAddress\s+\S+|CUSTOMFUNCTION_\w+)\s+"?(Ccc\w+)/g)) {
        const where = defined.get(m[1])
        for (const p of l.passes) if (!where?.includes(p)) dangling.push(`line ${l.n}: ${m[1]} in the ${p} pass`)
      }
    }
    expect(dangling).toEqual([])
  })

  it('every file-scope Var is used in every pass that declares it, and ccc vars only where declared', () => {
    // "Variable X not referenced or never set, wasting memory!" is a warning too.
    const lines = analyse(readNsh())
    const scope = fileScope(lines)
    const vars = varDefs(lines)
    expect(vars.map((v) => v.name)).toEqual(expect.arrayContaining(['cccAnimCtl', 'cccAnimFrame', 'cccAnimBitmap', 'DataDir', 'ResourcesDir']))
    const unused: string[] = []
    for (const v of vars) {
      const re = new RegExp(`\\$${esc(v.name)}(?![\\w.])`)
      for (const p of v.passes) if (!scope.some((l) => l.n !== v.n && l.passes.includes(p) && re.test(l.code))) unused.push(`${v.name} (${p} pass)`)
    }
    expect(unused).toEqual([])
    const declared = new Map(vars.map((v) => [v.name, v.passes]))
    const undeclared: string[] = []
    for (const l of scope) {
      for (const m of l.code.matchAll(/\$(ccc\w+)/g)) {
        const where = declared.get(m[1])
        for (const p of l.passes) if (!where?.includes(p)) undeclared.push(`line ${l.n}: $${m[1]} in the ${p} pass`)
      }
    }
    expect(undeclared).toEqual([])
  })

  it('no variable is glued to a following ".": "$var.bmp" depends on makensis guessing where the name ends', () => {
    const lines = fileScope(analyse(readNsh()))
    const glued = lines.filter((l) => /\$ccc\w+\./.test(l.code)).map((l) => `line ${l.n}: ${l.code}`)
    expect(glued).toEqual([])
  })

  it('the makensis probe\'s lifted macros carry none of the branding', () => {
    // installer-nsis-behaviour.test.ts compiles customHeader, customInit and
    // customInstall verbatim; branding there would change what it proves.
    const src = readNsh()
    for (const name of ['customHeader', 'customInit', 'customInstall']) {
      expect(macroBody(src, name), name).not.toMatch(/advsplash|MUI_|CccAnim|CccBrand|CccWelcome|CccFolder|installer-art/i)
    }
  })
})

describe('installer branding: plugin calls compile only after electron-builder adds their folder', () => {
  it('nothing compiled at file scope calls a plugin from electron-builder\'s own bundle (UAC, StdUtils and the rest)', () => {
    // The VM build of the beta.3 candidate failed the installer pass, 2 runs
    // of 2: "Plugin not found, cannot call UAC::_" at the splash guard in
    // CccBrandGuiInit. A file-scope Function is compiled when electron-builder
    // includes this file, and the !addplugindir for UAC.dll and StdUtils.dll
    // comes from a task racing that include. A hook macro (preInit,
    // customInit and the rest) is compiled where installer.nsi inserts it,
    // after the whole generated header, so the hook macros are exempt. A
    // helper macro this file defines counts where it is inserted: inserted
    // from a file-scope Function, it compiles at file scope.
    const found = lateCalls(analyse(readNsh())).map(
      (l) => `line ${l.n} (${l.fn ?? 'outside a Function'}): ${l.code}${l.via.length ? ` via ${l.via.join(' > ')}` : ''}`,
    )
    expect(found).toEqual([])
  })

  it('a helper macro counts where it is inserted: from a file-scope Function its call compiles at file scope', () => {
    // ReadUserPath is the live case: CccBrandGuiInit inserts it at file scope,
    // customInstall inserts it late. A plugin call added to its body would
    // bring the race back through the Function.
    const sample = [
      '!macro Helper OUT',
      '  ${If} ${UAC_IsInnerInstance}',
      '    StrCpy ${OUT} 1',
      '  ${EndIf}',
      '!macroend',
      '!macro Outer',
      '  ReadRegStr $R0 HKCU "Software\\X" "Y"',
      '  !insertmacro Helper $R1',
      '!macroend',
      '!macro Plain OUT',
      '  ReadRegStr ${OUT} HKCU "Software\\X" "Y"',
      '!macroend',
      '!macro LoopA',
      '  !insertmacro LoopB',
      '!macroend',
      '!macro LoopB',
      '  !insertmacro LoopA',
      '!macroend',
      '!macro _CccTest _a _b _t _f',
      '  StdUtils::TestParameter /NOUNLOAD "updated"',
      '!macroend',
      '!define CccTest `"" CccTest ""`',
      '!define CccWrapHelper "!insertmacro Helper $R2"',
      '!macro Hook',
      '  !insertmacro Helper $R3',
      '  !insertmacro Outer',
      '  ${CccWrapHelper}',
      '!macroend',
      'Function F',
      '  !insertmacro Helper $R0',
      '  !insertmacro "Helper" $R0',
      '  !insertmacro Outer',
      '  !insertmacro Plain $R0',
      '  !insertmacro LoopA',
      '  !insertmacro MUI_HEADER_TEXT "a" "b"',
      '  ${If} ${CccTest}',
      '  ${CccWrapHelper}',
      '  ; !insertmacro Helper $R0 in a comment',
      'FunctionEnd',
    ]
    expect(lateCalls(analyse(sample.join('\n'))).map((l) => `${l.code} via ${l.via.join(' > ')}`)).toEqual([
      '!insertmacro Helper $R0 via Helper > ${If} ${UAC_IsInnerInstance}',
      '!insertmacro "Helper" $R0 via Helper > ${If} ${UAC_IsInnerInstance}',
      '!insertmacro Outer via Outer > Helper > ${If} ${UAC_IsInnerInstance}',
      '${If} ${CccTest} via _CccTest > StdUtils::TestParameter /NOUNLOAD "updated"',
      '${CccWrapHelper} via Helper > ${If} ${UAC_IsInnerInstance}',
    ])
  })

  it('the file-scope check knows every spelling of such a call, and leaves comments and macro bodies alone', () => {
    const sample = [
      'Function F',
      '  ${If} ${UAC_IsInnerInstance}',
      '  ${AndIfNot} ${UAC_IsAdmin}',
      '  ${OrIfNot} ${isUpdated}',
      '  ${If} ${isForceRun}',
      '  UAC::_ 3',
      '  uac::_ 2',
      '  !insertmacro UAC_RunElevated',
      '  ${StdUtils.TestParameter} $R9 "updated"',
      '  StdUtils::TestParameter /NOUNLOAD "updated"',
      '  !insertmacro _StdU_TestParameter $R9 "updated"',
      '  nsProcess::_FindProcess "x.exe"',
      '  nsis7z::Extract "x.7z"',
      '  ; ${UAC_IsInnerInstance} in a comment',
      '  System::Call "kernel32::GetTickCount() i .r0"',
      '  nsDialogs::Create 1018',
      '  advsplash::show 1000 350 250 -1 "x"',
      '  ${If} $cccIsInnerInstance == 1',
      '  ${If} ${IsWin10}',
      'FunctionEnd',
      '!macro M',
      '  ${If} ${UAC_IsInnerInstance}',
      '  StdUtils::TestParameter /NOUNLOAD "updated"',
      '!macroend',
    ]
    expect(lateCalls(analyse(sample.join('\n'))).map((l) => l.code)).toEqual([
      '${If} ${UAC_IsInnerInstance}',
      '${AndIfNot} ${UAC_IsAdmin}',
      '${OrIfNot} ${isUpdated}',
      '${If} ${isForceRun}',
      'UAC::_ 3',
      'uac::_ 2',
      '!insertmacro UAC_RunElevated',
      '${StdUtils.TestParameter} $R9 "updated"',
      'StdUtils::TestParameter /NOUNLOAD "updated"',
      '!insertmacro _StdU_TestParameter $R9 "updated"',
      'nsProcess::_FindProcess "x.exe"',
      'nsis7z::Extract "x.7z"',
    ])
  })

  it('preInit asks both questions once, in the installer pass, and only the three page functions read the answers', () => {
    const lines = analyse(readNsh())
    // Unconditional, in this order, in the installer pass only (the variables
    // do not exist in the uninstaller pass). $R9 is saved because
    // ${isUpdated} writes it.
    const body = lines.filter((l) => l.macro === 'preInit' && l.code !== '' && !/^!(macro|macroend|ifndef|endif)\b/.test(l.code))
    expect(body.map((l) => l.code)).toEqual([
      'Push $R9',
      'StrCpy $cccIsInnerInstance 0',
      '${If} ${UAC_IsInnerInstance}',
      'StrCpy $cccIsInnerInstance 1',
      '${EndIf}',
      'StrCpy $cccIsUpdated 0',
      '${If} ${isUpdated}',
      'StrCpy $cccIsUpdated 1',
      '${EndIf}',
      'Pop $R9',
    ])
    for (const l of body) expect(l.passes, `line ${l.n}`).toEqual(['inst'])

    // Declared at file scope, installer pass only, ahead of every reader.
    const vars = varDefs(lines)
    const readers = (name: string) => fileScope(lines).filter((l) => new RegExp(`\\$${name}(?![\\w.])`).test(l.code))
    for (const name of ['cccIsInnerInstance', 'cccIsUpdated']) {
      const v = vars.find((x) => x.name === name)
      expect(v, `Var ${name}`).toBeDefined()
      expect(v!.passes, name).toEqual(['inst'])
      for (const r of readers(name)) expect(r.n, `line ${r.n} reads $${name} before it is declared`).toBeGreaterThan(v!.n)
    }
    // The splash guard, the Welcome page skip and the Data folder page's Back button.
    expect(readers('cccIsInnerInstance').map((l) => l.fn)).toEqual(['CccBrandGuiInit', 'CccWelcomePre', 'DataDirPage'])
    expect(readers('cccIsUpdated').map((l) => l.fn)).toEqual(['CccBrandGuiInit'])

    // preInit is the only writer, so nothing changes an answer after .onInit.
    const writers = lines.filter((l) => /^[A-Za-z]\w*\s+\$cccIs(?:InnerInstance|Updated)\b/.test(l.code))
    expect(writers.length).toBe(4)
    for (const w of writers) expect(w.macro, `line ${w.n}: ${w.code}`).toBe('preInit')

    // The readers run only from Modern UI's .onGUIInit hook and the page list,
    // both after .onInit has returned: no Call or other reference anywhere.
    const refs = (fn: string) => lines
      .filter((l) => l.code !== '' && l.fn !== fn && !/^Function\b/.test(l.code) && new RegExp(`(?<![\\w.])${fn}(?![\\w.])`).test(l.code))
      .map((l) => l.code)
    expect(refs('CccBrandGuiInit')).toEqual(['!define MUI_CUSTOMFUNCTION_GUIINIT CccBrandGuiInit'])
    expect(refs('CccWelcomePre')).toEqual(['!define MUI_PAGE_CUSTOMFUNCTION_PRE CccWelcomePre'])
    expect(refs('DataDirPage')).toEqual(['Page custom DataDirPage DataDirPageLeave'])
  })

  it('electron-builder inserts preInit first in .onInit, ahead of anything that can quit or show a page', () => {
    // The order the fix relies on, read from the pinned electron-builder. The
    // template body (installer.nsi) follows the generated header, where every
    // !addplugindir is, so a macro inserted here always finds its plugins.
    const nsi = readFileSync(join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'installer.nsi'), 'utf-8').replace(/\r\n/g, '\n')
    const onInit = nsi.match(/^Function \.onInit\n([\s\S]*?)^FunctionEnd/m)?.[1]
    expect(onInit, 'Function .onInit in installer.nsi').toBeDefined()
    const code = onInit!.split('\n').map((l) => stripComment(l).trim()).filter((l) => l !== '')
    const at = code.indexOf('!insertmacro preInit')
    expect(at, '!insertmacro preInit in .onInit').toBeGreaterThan(0)
    expect(code[at - 1]).toBe('!ifmacrodef preInit')
    // Only plain statements ahead of it: nothing that can quit or open a page.
    expect(code.slice(0, at - 1)).toEqual(['Call setInstallSectionSpaceRequired', 'SetOutPath $INSTDIR', '${LogSet} on'])
    for (const later of ['!ifdef BUILD_UNINSTALLER', '!insertmacro ALLOW_ONLY_ONE_INSTALLER_INSTANCE', '!insertmacro initMultiUser', '!insertmacro customInit']) {
      expect(code.indexOf(later), later).toBeGreaterThan(at)
    }
  })

  it('electron-builder puts the generated header, with its plugin folders, ahead of installer.nsi in both passes', () => {
    // The other half of that order, read from the pinned electron-builder:
    // the header that adds every plugin folder (!addplugindir) is prepended to
    // the template body, in the installer pass and the uninstaller pass. If a
    // later electron-builder put template content first, preInit would no
    // longer be sure to find its plugins, and this fails.
    const js = readFileSync(join(ROOT, 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js'), 'utf-8').replace(/\r\n/g, '\n')
    const runs = [...js.matchAll(/await this\.executeMakensis\(([^\n]*)/g)].map((m) => m[1])
    expect(runs.length, 'two makensis runs: the uninstaller pass and the installer pass').toBe(2)
    for (const args of runs) expect(args).toMatch(/^defines, commands, sharedHeader \+ \(await this\.computeFinalScript\(/)
    expect(js).toContain('const sharedHeader = await this.computeCommonInstallerScriptHeader();')
    expect(js).toContain('this.computeScriptAndSignUninstaller(definesUninstaller, commandsUninstaller, installerPath, sharedHeader, archs)')
    const header = js.match(/\n {4}async computeCommonInstallerScriptHeader\(\) \{\n([\s\S]*?)\n {4}\}\n/)?.[1]
    expect(header, 'computeCommonInstallerScriptHeader in NsisTarget.js').toBeDefined()
    expect(header).toContain('scriptGenerator.addPluginDir(')
    expect(header!.trimEnd()).toMatch(/return scriptGenerator\.build\(\);$/)
  })
})

describe('installer branding: motion and splash stay where they belong', () => {
  it('the timer starts only from the Welcome page and the two folder pages, never the Installing page', () => {
    const src = readNsh()
    const lines = analyse(src)
    expect(src.match(/\$\{NSD_CreateTimer\}/g)).toHaveLength(1)
    expect(functionBody(lines, 'CccAnimStart').some((l) => /^\$\{NSD_CreateTimer\} CccAnimTick\b/.test(l.code))).toBe(true)
    const starters = fileScope(lines).filter((l) => /^Call CccAnimStart$/.test(l.code)).map((l) => l.fn).sort()
    expect(starters).toEqual(['CccFolderArt', 'CccWelcomeShow'])
    const folder = fileScope(lines).filter((l) => /^Call CccFolderArt$/.test(l.code)).map((l) => l.fn).sort()
    expect(folder).toEqual(['DataDirPage', 'ResourcesDirPage'])
    // Every page that starts the timer stops it once nsDialogs::Show returns.
    for (const page of ['DataDirPage', 'ResourcesDirPage']) {
      const body = functionBody(lines, page).map((l) => l.code)
      expect(body.indexOf('Call CccAnimStop'), page).toBeGreaterThan(body.indexOf('nsDialogs::Show'))
    }
    expect(src).toMatch(/!define MUI_PAGE_CUSTOMFUNCTION_DESTROYED CccAnimStop/)
    // No hook into the Installing page or the page after the directory page.
    expect(src).not.toMatch(/^!macro customPageAfterChangeDir\b/m)
    expect(src.match(/!define MUI_PAGE_CUSTOMFUNCTION_SHOW\b/g)).toHaveLength(1)
    expect(src).not.toMatch(/EmbedHTML|AnimGif|NewAdvSplash|nsisSlideshow/i)
  })

  it('the animation settles on the static frame: the last step shows $cccAnimFinal and the timer dies there', () => {
    // Steps 1..CCC_ANIM_STEPS-1 load $PLUGINSDIR\<prefix><n>.bmp; step
    // CCC_ANIM_STEPS loads the settled image. With ">" in place of ">=", the
    // last step would ask for a frame file that does not exist (a blank panel
    // for good, since the tick kills the timer at that same step).
    const lines = analyse(readNsh())
    const body = (name: string) => functionBody(lines, name).map((l) => l.code)
    expect(body('CccAnimStart').slice(0, 2)).toEqual(['StrCpy $cccAnimExt ".bmp"', 'StrCpy $cccAnimFrame 1'])
    expect(body('CccAnimTick')).toEqual([
      'IntOp $cccAnimFrame $cccAnimFrame + 1',
      '${If} $cccAnimFrame >= ${CCC_ANIM_STEPS}',
      '${NSD_KillTimer} CccAnimTick',
      '${EndIf}',
      'Call CccAnimShowFrame',
    ])
    expect(body('CccAnimShowFrame').slice(0, 5)).toEqual([
      '${If} $cccAnimFrame >= ${CCC_ANIM_STEPS}',
      'StrCpy $cccAnimPath "$cccAnimFinal"',
      '${Else}',
      'StrCpy $cccAnimPath "$PLUGINSDIR\\$cccAnimPrefix$cccAnimFrame$cccAnimExt"',
      '${EndIf}',
    ])
  })

  it('the splash runs from .onGUIInit only, and only on a fresh install outside the elevated instance', () => {
    // .onGUIInit never runs under /S; the in-app updater passes no arguments,
    // so an update is recognised by the data folder or the installed exe.
    const src = readNsh()
    const lines = analyse(src)
    const fileLines = fileScope(lines)
    const splash = fileLines.filter((l) => /^advsplash::show\b/i.test(l.code))
    expect(splash).toHaveLength(1)
    expect(splash[0].fn).toBe('CccBrandGuiInit')
    expect(splash[0].code).toBe('advsplash::show 1000 350 250 -1 "$PLUGINSDIR\\ccc-splash"')
    const body = functionBody(lines, 'CccBrandGuiInit').map((l) => l.code)
    const at = (s: string) => body.findIndex((c) => c === s)
    const show = at('advsplash::show 1000 350 250 -1 "$PLUGINSDIR\\ccc-splash"')
    // The first two answers are recorded by preInit (see 'installer branding:
    // plugin calls' above).
    const guards = [
      '${IfNot} $cccIsInnerInstance == 1',
      '${AndIfNot} $cccIsUpdated == 1',
      '${AndIfNot} ${FileExists} "$INSTDIR\\${PRODUCT_FILENAME}.exe"',
      '!insertmacro ReadUserPath "DataDirectory" $R0',
      '${If} $R0 == ""',
    ]
    let prev = -1
    for (const g of guards) {
      const i = at(g)
      expect(i, `missing guard: ${g}`).toBeGreaterThan(prev)
      prev = i
    }
    expect(show).toBeGreaterThan(prev)
    // Nothing between the guards and the call closes them early.
    // (ReadUserPath's own If/EndIf live in its macro body, not on these lines.)
    expect(body.slice(at(guards[0]), show).filter((c) => /^\$\{EndIf\}$/.test(c))).toHaveLength(0)
    // Not from .onInit's hooks either.
    for (const name of ['preInit', 'customInit']) {
      if (new RegExp(`^!macro ${name}\\b`, 'm').test(src)) expect(macroBody(src, name), name).not.toMatch(/advsplash/i)
    }
    // The Welcome page is skipped in the elevated inner instance, as the
    // folder-page wizard there started before this change.
    expect(functionBody(lines, 'CccWelcomePre').map((l) => l.code)).toEqual(['${If} $cccIsInnerInstance == 1', 'Abort', '${EndIf}'])
  })

  it('plugins come only from the pinned NSIS bundles, with no plugin directory of our own', () => {
    const src = readNsh()
    const allowed = new Set(['nsdialogs', 'nsexec', 'system', 'advsplash'])
    const used = new Set<string>()
    for (const l of analyse(src).filter((x) => x.code !== '')) {
      const p = pluginOf(l.code)
      if (p) used.add(p)
    }
    expect([...used].filter((p) => !allowed.has(p))).toEqual([])
    expect(used.has('advsplash')).toBe(true)
    // A dll::function inside a System::Call string is not a plugin.
    expect(pluginOf(`System::Call 'user32::LoadImage(p0, t "x", i 0, i 0, i 0, i 0x10) p.r0'`)).toBe('system')
    expect(pluginOf(`StrCpy $0 "UXTHEME::SetWindowTheme"`)).toBeNull()
    expect(src).not.toMatch(/!addplugindir/i)
    expect(existsSync(join(ROOT, 'build', 'x86-unicode'))).toBe(false)
    expect(existsSync(join(ROOT, 'build', 'x86-ansi'))).toBe(false)
  })
})

describe('installer branding: copy', () => {
  it('the new user-visible strings are plain ASCII with no em or en dashes', () => {
    const src = readNsh()
    const strings = [
      ...[...src.matchAll(/!define MUI_WELCOMEPAGE_(?:TITLE|TEXT) "([^"]*)"/g)].map((m) => m[1]),
      ...[...src.matchAll(/!insertmacro MUI_HEADER_TEXT "([^"]*)" "([^"]*)"/g)].flatMap((m) => [m[1], m[2]]),
    ]
    expect(strings.length).toBe(8)
    for (const s of strings) {
      expect(s, s).not.toMatch(DASHES)
      expect(s, s).toMatch(/^[\x20-\x7e]*$/)
    }
    // The Welcome page names the version it installs.
    expect(src).toMatch(/!define MUI_WELCOMEPAGE_TEXT "Setup will install AI Code Conductor \$\{VERSION\}\./)
  })

  it('the branding section and the uninstaller Welcome macro are ASCII throughout', () => {
    const src = readNsh()
    for (const [name, text] of [['BRANDING section', brandingSection(src)], ['customUnWelcomePage', macroBody(src, 'customUnWelcomePage')]]) {
      const bad = text.split('\n').filter((l) => /[^\x09\x20-\x7e]/.test(l))
      expect(bad, name).toEqual([])
    }
    const gen = readFileSync(join(ROOT, 'scripts', 'gen-installer-art.mjs'), 'utf-8')
    expect(gen.split('\n').filter((l) => /[^\x09\x0d\x20-\x7e]/.test(l))).toEqual([])
  })
})
