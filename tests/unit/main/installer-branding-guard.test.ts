import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANIM_STEPS, artManifest, bmpMaxDelta, renderAll } from '../../../scripts/gen-installer-art.mjs'

/**
 * Guards for the branded Windows installer (finding O4, aicc_planning #180).
 *
 * makensis cannot run on the owner's machine. The real compile (-WX, both the
 * installer and the BUILD_UNINSTALLER pass) happens in a release build and on
 * the VM, and the makensis probes (installer-nsis-behaviour.test.ts) on CI's
 * Windows parts and the VM. This file holds what can be proved from the files
 * alone, everywhere, and it is aimed at the ways this change could ship
 * broken while every other test stayed green:
 *   - a missing or malformed bitmap (electron-builder falls back to NSIS's
 *     stock art for a default name, and MUI shows a blank panel for a bad BMP);
 *   - an interface define placed after the first page macro (MUI then bakes in
 *     its defaults without a word);
 *   - a colour of our own: every page keeps Windows' stock light dialog, and
 *     the brand is in the header bitmap and the sidebar art (aicc_planning #295);
 *   - a Function or Var that one compile pass declares but never references,
 *     which -WX turns into a failed release build;
 *   - motion or a splash leaking onto the Installing page or an in-app update;
 *   - a live Back button on the elevated inner instance's first page, which
 *     would walk the wizard off its front edge and end Setup;
 *   - a plugin from outside the pinned NSIS bundles;
 *   - a call into electron-builder's own plugins (UAC, StdUtils) compiled at
 *     file scope, directly or through a helper macro a file-scope Function
 *     inserts, which fails the installer pass whenever electron-builder
 *     happens to include this file before it adds their folder;
 *   - the uninstaller's clean-up of the session helper folder running on an
 *     update or as administrator, or deleting more than its own folders.
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

  it('the header bitmap and the folder-page emblem are drawn on the light grounds they sit on (aicc_planning #295)', () => {
    // Every page keeps the stock light dialog. The header band is white, and
    // the emblem's SS_CENTERIMAGE strip takes the bitmap's top-left pixel, so
    // a dark corner shows as a dark tile on the header, or a dark band across
    // the folder page. The sidebar keeps the dark brand ground, as a panel.
    const corners = (file: string) => {
      const b = readFileSync(join(ROOT, file))
      const w = b.readInt32LE(18)
      const h = b.readInt32LE(22)
      const stride = Math.ceil((w * 3) / 4) * 4
      const px = (x: number, y: number) => {
        const o = 54 + (h - 1 - y) * stride + x * 3 // bottom-up rows, BGR
        return [b[o + 2], b[o + 1], b[o]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
      }
      return [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)]
    }
    expect(corners('build/installerHeader.bmp'), 'the header band is white').toEqual(Array(4).fill('FFFFFF'))
    const emblems = (artManifest() as { file: string }[]).map((a) => a.file).filter((f) => /installer-art\/emblem(-\d+)?\.bmp$/.test(f))
    expect(emblems).toHaveLength(ANIM_STEPS)
    for (const f of emblems) expect(corners(f), `${f}: the dialog face colour`).toEqual(Array(4).fill('F0F0F0'))
    expect(corners('build/installerSidebar.bmp')[0], 'the sidebar keeps its dark ground').not.toBe('FFFFFF')
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

  it('the GUIINIT and Welcome hook defines all precede MUI_PAGE_WELCOME', () => {
    // Modern UI reads interface settings when the first page macro inserts
    // MUI_INTERFACE; a define after that point is silently ignored.
    const lines = analyse(readNsh())
    const at = (re: RegExp) => fileScope(lines).find((l) => re.test(l.code))
    const welcome = at(/^!insertmacro MUI_PAGE_WELCOME$/)!
    expect(welcome).toBeDefined()
    for (const re of [
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
    // The GUIINIT hook and its Function are installer-pass only.
    expect(at(/^!define MUI_CUSTOMFUNCTION_GUIINIT\b/)!.passes).toEqual(['inst'])
    expect(at(/^!define MUI_CUSTOMFUNCTION_GUIINIT\b/)!.code).toBe('!define MUI_CUSTOMFUNCTION_GUIINIT CccBrandGuiInit')
  })

  it('every page keeps Windows\' stock light dialog: no colour define, no classic controls, no SetCtlColors (aicc_planning #295)', () => {
    // Modern UI colours only the header and the Welcome and Finish pages, and
    // NSIS cannot recolour the button strip or a Browse button without a skin
    // plugin, so a dark theme left stock light parts beside dark ones. The
    // brand is in the header bitmap and the sidebar art only, in both passes.
    // Any Modern UI colour define (MUI_BGCOLOR, MUI_TEXTCOLOR, MUI_*_COLOR,
    // MUI_*_COLORS, MUI_*_BGCOLOR), with or without a /ifndef or /redef
    // switch, classic controls, a CCC_BRAND_* colour, or SetCtlColors.
    const ownColour = (code: string) =>
      /^!define\s+(?:\/\w+\s+)*(?:MUI_\w*COLORS?\b|MUI_FORCECLASSICCONTROLS\b|CCC_BRAND_\w+)/.test(code) ||
      /^SetCtlColors\b/i.test(code)
    // The detector catches every line this file used to set: the 11 distinct
    // lines below are all 13 that the stock-dialog change removed (each folder
    // page had the same two SetCtlColors $0 lines). And it catches the other
    // ways to set a colour, which this file never used.
    for (const old of [
      '!define CCC_BRAND_BG "0B0E15"',
      '!define CCC_BRAND_TEXT "F4F7FA"',
      '!define CCC_BRAND_FIELD "161B26"',
      '!define MUI_BGCOLOR "${CCC_BRAND_BG}"',
      '!define MUI_TEXTCOLOR "${CCC_BRAND_TEXT}"',
      '!define MUI_FORCECLASSICCONTROLS',
      'SetCtlColors $cccAnimCtl "" "${CCC_BRAND_BG}"',
      'SetCtlColors $0 "" "${CCC_BRAND_BG}"',
      'SetCtlColors $0 "${CCC_BRAND_TEXT}" "${CCC_BRAND_BG}"',
      'SetCtlColors $DataDir "${CCC_BRAND_TEXT}" "${CCC_BRAND_FIELD}"',
      'SetCtlColors $ResourcesDir "${CCC_BRAND_TEXT}" "${CCC_BRAND_FIELD}"',
      '!define MUI_INSTFILESPAGE_COLORS "F4F7FA 0B0E15"',
      '!define MUI_LICENSEPAGE_BGCOLOR /grey',
      '!define MUI_FINISHPAGE_LINK_COLOR 000080',
      '!define /ifndef MUI_BGCOLOR 0B0E15',
      '!define /redef MUI_TEXTCOLOR F4F7FA',
    ]) {
      expect(ownColour(old), old).toBe(true)
    }
    for (const fine of ['!define MUI_WELCOMEPAGE_TITLE "x"', '!define MUI_CUSTOMFUNCTION_GUIINIT CccBrandGuiInit', '; SetCtlColors in a comment', '']) {
      expect(ownColour(fine), fine).toBe(false)
    }
    const found = analyse(readNsh()).filter((l) => ownColour(l.code)).map((l) => `line ${l.n}: ${l.code}`)
    expect(found).toEqual([])
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
    // Stock bodies: the dialog, its label and the path field keep the system
    // colours (see the stock light dialog test above).
    for (const body of [data, res]) expect(body).not.toMatch(/SetCtlColors/i)
  })

  it('the folder-page emblem is a centred bitmap in a strip it fits', () => {
    // A way the emblem breaks that only a screen capture would show: without
    // SS_CENTERIMAGE the bitmap is drawn at the strip's top-left. Its STATIC
    // control keeps the page's own system colour around it.
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
    expect(body.indexOf('Call CccAnimStart')).toBeGreaterThan(at + 1)
    expect(body.some((c) => /^SetCtlColors\b/i.test(c)), 'no colours of its own').toBe(false)

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

// ---------------------------------------------------------------------------
// The uninstaller's clean-up of the session helper folder
// ---------------------------------------------------------------------------

/** The code lines of one macro's body, without comments, blanks or the !macro lines. */
const bodyCode = (lines: NshLine[], name: string) =>
  lines.filter((l) => l.macro === name && l.code !== '' && !/^!macro(end)?\b/.test(l.code)).map((l) => l.code)

/** A DetailPrint line with its text left out, so the wording can change. */
const quiet = (c: string) => c.replace(/^DetailPrint ".*"$/, 'DetailPrint "..."')

/** `name` and every local macro it inserts, to any depth. */
function reachableMacros(name: string, lines: NshLine[]): Set<string> {
  const macros = localMacros(lines)
  const wrappers = macroWrappers(lines)
  const seen = new Set<string>()
  const walk = (m: string) => {
    if (seen.has(m) || !macros.has(m)) return
    seen.add(m)
    for (const l of macros.get(m)!) for (const x of insertedMacros(l.code, wrappers)) walk(x)
  }
  walk(name)
  return seen
}

/** A note line with its text left out, so the wording can change. */
const quietNote = (c: string) => quiet(c).replace(/^!insertmacro CccHelperNote ".*"$/, '!insertmacro CccHelperNote "..."')

/** The code lines of `name` and of every local macro it inserts, to any depth, with the macro each is in. */
function reachableCode(lines: NshLine[], name: string): { macro: string; code: string }[] {
  const names = reachableMacros(name, lines)
  return lines
    .filter((l) => l.macro !== null && names.has(l.macro) && l.code !== '' && !/^!macro(end)?\b/.test(l.code))
    .map((l) => ({ macro: l.macro as string, code: l.code }))
}

describe('installer: the uninstaller removes the session helper folder, and nothing more (static)', () => {
  // installer-nsis-behaviour.test.ts runs these macros for real with makensis,
  // on CI's Windows parts and the VM. These hold, everywhere, what the file
  // alone can prove: a gate dropped, a recursive delete brought back or a
  // variable moved out of the uninstaller pass fails here even where nothing
  // compiles.

  it('customUnInstall inserts the clean-up once, inside ${IfNot} ${isUpdated} and nowhere else', () => {
    const lines = analyse(readNsh())
    const body = bodyCode(lines, 'customUnInstall')
    const at = body.indexOf('!insertmacro RemoveUserHelperFolder')
    expect(at, 'customUnInstall inserts RemoveUserHelperFolder').toBeGreaterThan(0)
    expect(body.slice(at - 1, at + 2)).toEqual(['${IfNot} ${isUpdated}', '!insertmacro RemoveUserHelperFolder', '${EndIf}'])
    const inserts = lines
      .filter((l) => /^!insertmacro\s+"?RemoveUserHelperFolder(Here)?\b/.test(l.code))
      .map((l) => `${l.macro}: ${l.code}`)
    expect(inserts).toEqual([
      'RemoveUserHelperFolder: !insertmacro RemoveUserHelperFolderHere',
      'customUnInstall: !insertmacro RemoveUserHelperFolder',
    ])
  })

  it('it runs in the user\'s own copy when there is one, in this copy otherwise, and on every route shows what it did', () => {
    const lines = analyse(readNsh())
    // electron-builder's elevated copy of an all-users uninstall hands the
    // clean-up to the copy the user started. Any other copy runs it itself,
    // elevated or not, and so does the elevated copy when no notes came back.
    // The notes come back in $9, a register the UAC plugin copies back.
    expect(bodyCode(lines, 'RemoveUserHelperFolder')).toEqual([
      'Push $9',
      'StrCpy $9 ""',
      '${If} ${UAC_IsInnerInstance}',
      '!insertmacro UAC_AsUser_Call Label cccHelperFolderHere ${UAC_SYNCREGISTERS}',
      '${EndIf}',
      '${If} $9 == ""',
      'Call :cccHelperFolderHere',
      '${EndIf}',
      '!insertmacro CccPrintHelperNotes',
      'Pop $9',
      'Goto cccHelperFolderDone',
      'cccHelperFolderHere:',
      '!insertmacro RemoveUserHelperFolderHere',
      'Return',
      'cccHelperFolderDone:',
    ])
    const all = reachableCode(lines, 'RemoveUserHelperFolder')
    // No route skips the clean-up for running as administrator.
    expect(all.filter((l) => /UAC_IsAdmin/.test(l.code))).toEqual([])
    // The clean-up itself shows nothing: the first copy has no window. Only
    // the printer does, in the copy that has one.
    expect(all.filter((l) => /^DetailPrint\b/.test(l.code)).map((l) => `${l.macro}: ${l.code}`)).toEqual([
      'CccPrintHelperNotes: DetailPrint "$1"',
      'CccPrintHelperNotes: DetailPrint "$1"',
    ])
    // $9 holds the notes across the call: nothing in the clean-up saves and
    // restores it over them.
    const here = reachableCode(lines, 'RemoveUserHelperFolderHere')
    expect(here.filter((l) => /^(Push|Pop|Exch)\s+\$9\b/.test(l.code))).toEqual([])
    expect(here.filter((l) => /^StrCpy \$9\b/.test(l.code)).map((l) => l.macro)).toEqual(['CccHelperNote', 'CccHelperNote', 'CccHelperNote'])
  })

  it('it ends only this user\'s helpers, by image name, with what they started, through no WMI tool, and never loops for long', () => {
    const lines = analyse(readNsh())
    const all = reachableCode(lines, 'RemoveUserHelperFolder')
    // No taskkill or tasklist: over a non-interactive sign-in both answer
    // "Access denied" (WMI), measured on the VM. No other program is run at all.
    expect(all.filter((l) => /taskkill|tasklist|tskill|wmic|Stop-Process|KillProc|nsExec::|ExecWait|ExecShell|\bExec\b/i.test(l.code))).toEqual([])
    // TerminateProcess appears twice in the file: here, in CccEndListed, only
    // for a process checked to be this copy's own user's just before, and to
    // be still the process the scan listed; and in the app-running check's
    // CccCloseAppCopies (its own tests, below), which the clean-up never
    // reaches.
    const kills = lines.filter((l) => /TerminateProcess/.test(l.code))
    expect(kills.map((l) => l.macro)).toEqual(['CccEndListed', 'CccCloseAppCopies'])
    expect(all.filter((l) => /TerminateProcess/.test(l.code)).map((l) => l.macro)).toEqual(['CccEndListed'])
    // aicc_planning #400: each listed "pid:start" is held open (PROCESS_TERMINATE
    // and PROCESS_QUERY_LIMITED_INFORMATION) from before its user is checked
    // until it is ended, and ended only when its start, read through that
    // handle, is the listed one: a pid Windows has given to a new process
    // since the scan, or a start that cannot be read, ends nothing.
    expect(bodyCode(lines, 'CccEndListed')).toEqual([
      'StrCpy $4 1',
      '${Do}',
      '!insertmacro CccNextPair "$R1" $4 $3 $5',
      '${If} $3 == ""',
      '${ExitDo}',
      '${EndIf}',
      'System::Call \'kernel32::OpenProcess(i 0x1001, i 0, i $3) p .r7\'',
      '${If} $7 != 0',
      '!insertmacro CccProcessIsMine "$3" $6',
      '${If} $6 == 1',
      'System::Call \'kernel32::GetProcessTimes(p r7, *l .r1, *l, *l, *l) i .r2\'',
      '${If} $2 != 0',
      '${AndIf} $5 != ""',
      '${AndIf} $1 == $5',
      'System::Call \'kernel32::TerminateProcess(p r7, i 1)\'',
      '${EndIf}',
      '${EndIf}',
      'System::Call \'kernel32::CloseHandle(p r7)\'',
      '${EndIf}',
      '${Loop}',
    ])
    // "Mine" is the SID in the process's token against this copy's own.
    expect(bodyCode(lines, 'CccProcessIsMine').filter((c) => /System::Call/.test(c))).toEqual([
      'System::Call \'kernel32::OpenProcess(i 0x1000, i 0, i ${PID}) p .r0\'',
      'System::Call \'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i .r2\'',
      'System::Call \'advapi32::GetTokenInformation(p r1, i 1, p R5, i 256, *i .r2) i .r2\'',
      'System::Call \'*$R5(p .r2)\'',
      'System::Call \'advapi32::EqualSid(p r2, p R6) i .r2\'',
      'System::Call \'kernel32::CloseHandle(p r1)\'',
      'System::Call \'kernel32::CloseHandle(p r0)\'',
    ])
    const end = bodyCode(lines, 'CccEndUserHelpers')
    const own = end.indexOf('System::Call \'kernel32::GetCurrentProcess() p .r0\'')
    expect(end.slice(own, own + 6)).toEqual([
      'System::Call \'kernel32::GetCurrentProcess() p .r0\'',
      'System::Call \'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i .r2\'',
      '${If} $2 != 0',
      'System::Call \'advapi32::GetTokenInformation(p r1, i 1, p R0, i 256, *i .r2) i .r2\'',
      '${If} $2 != 0',
      'System::Call \'*$R0(p .R6)\'',
    ])
    // With no SID of its own, nothing is scanned or ended.
    const none = end.indexOf('${If} $R6 == 0')
    expect(none).toBeGreaterThan(own)
    expect(end.slice(none, none + 3).map(quietNote)).toEqual(['${If} $R6 == 0', '!insertmacro CccHelperNote "..."', '${Else}'])
    expect(end.findIndex((c) => /^!insertmacro CccScanProcesses\b/.test(c))).toBeGreaterThan(none)
    // Helpers by name and owner; what they started by parent, owner and start
    // time. Each goes into the list with its start ("pid:start"), which
    // CccEndListed compares before it ends anything.
    const scan = bodyCode(lines, 'CccScanProcesses')
    const byName = scan.indexOf('${If} $5 == "aicc-helper.exe"')
    expect(scan.slice(byName, byName + 5)).toEqual(['${If} $5 == "aicc-helper.exe"', '!insertmacro CccProcessIsMine "$3" $6', '${If} $6 == 1', '!insertmacro CccProcessStart "$3" $R7', 'StrCpy $R1 "$R1$3:$R7,"'])
    const byParent = scan.indexOf('!insertmacro CccInPairList "$4" $6')
    expect(scan.slice(byParent, byParent + 14)).toEqual([
      '!insertmacro CccInPairList "$4" $6',
      '${If} $6 == 1',
      '!insertmacro CccInPairList "$3" $6',
      '${If} $6 == 0',
      '!insertmacro CccProcessIsMine "$3" $6',
      '${If} $6 == 1',
      '!insertmacro CccProcessStart "$3" $R7',
      '!insertmacro CccProcessStart "$4" $R8',
      '${If} $R7 != ""',
      '${AndIf} $R8 != ""',
      'System::Int64Op $R7 < $R8',
      'Pop $6',
      '${If} $6 == 0',
      'StrCpy $R1 "$R1$3:$R7,"',
    ])
    expect(scan.filter((c) => /^StrCpy \$R1\b/.test(c))).toEqual(['StrCpy $R1 "$R1$3:$R7,"', 'StrCpy $R1 "$R1$3:$R7,"'])
    // A pid is in the list when an entry's number before its colon is that pid.
    expect(bodyCode(lines, 'CccInPairList').slice(0, 2)).toEqual(['StrCpy ${OUT} 0', 'StrCpy $2 ",${ITEM}:"'])
    // Every loop is bounded: 8 passes, 10 looks after the end.
    expect(end.filter((c) => /^\$\{OrIf\} \$R4 >= /.test(c))).toEqual(['${OrIf} $R4 >= 8', '${OrIf} $R4 >= 10'])
    // The buffers it takes are given back.
    expect(end.filter((c) => /^System::(Alloc|Free)\b/.test(c))).toEqual([
      'System::Alloc 256', 'System::Alloc 256', 'System::Alloc 556', 'System::Free $R3', 'System::Free $R5', 'System::Free $R0',
    ])
  })

  it('it never deletes recursively: files go by name, folders only when empty, and no delete waits for the next start', () => {
    const lines = analyse(readNsh())
    const all = reachableCode(lines, 'RemoveUserHelperFolder')
    expect(all.filter((l) => /^RMDir\b/i.test(l.code) && /\/r\b/i.test(l.code)), 'no RMDir /r').toEqual([])
    expect(all.some((l) => /REBOOTOK/i.test(l.code)), 'no delete is scheduled for the next start').toBe(false)
    expect(all.filter((l) => /^RMDir\b/i.test(l.code)).map((l) => `${l.macro}: ${l.code}`)).toEqual([
      'CccRemoveHelperOwnFolder: RMDir "$R8\\conpty"',
      'CccRemoveHelperOwnFolder: RMDir "$R8\\$R3"',
      'CccRemoveHelperOwnFolder: RMDir "$R8"',
      'RemoveUserHelperFolderHere: RMDir "$R0"',
      'RemoveUserHelperFolderHere: RMDir "$R1"',
    ])
    expect(all.filter((l) => /^Delete\b/i.test(l.code)).map((l) => `${l.macro}: ${l.code}`)).toEqual([
      'CccRemoveHelperOwnFolder: Delete "$R8\\.lock"',
      'CccRemoveHelperOwnFolder: Delete "$R8\\*.json"',
      'CccRemoveHelperOwnFolder: Delete "$R8\\*.json.*.tmp"',
      'CccRemoveHelperOwnFolder: Delete "$R8\\aicc-helper.exe"',
      'CccRemoveHelperOwnFolder: Delete "$R8\\conpty\\conpty.dll"',
      'CccRemoveHelperOwnFolder: Delete "$R8\\conpty\\OpenConsole.exe"',
      'CccRemoveHelperOwnFolder: Delete "$R8\\$R3\\conpty.dll"',
      'CccRemoveHelperOwnFolder: Delete "$R8\\$R3\\OpenConsole.exe"',
      'CccRemoveHelperOwnFolder: Delete "$R8\\aicc-helper.exe"',
      'RemoveUserHelperFolderHere: Delete "$R0\\bindings.json"',
      'RemoveUserHelperFolderHere: Delete "$R0\\app-running.json"',
    ])
  })

  it('it checks every folder is not a link before it touches anything in it, and walks only the helper\'s own layout', () => {
    const lines = analyse(readNsh())
    const own = bodyCode(lines, 'CccRemoveHelperOwnFolder')
    // The wildcards only in the store, by the store's own name.
    const store = own.indexOf('${If} "$R3" S== "store"')
    expect(own.slice(store, store + 5)).toEqual([
      '${If} "$R3" S== "store"',
      'Delete "$R8\\.lock"',
      'Delete "$R8\\*.json"',
      'Delete "$R8\\*.json.*.tmp"',
      '${ElseIf} $R9 S== ".new-"',
    ])
    // Windows matches a wildcard against a file's short 8.3 name too, so
    // "*.tmp" would also take notes.tmpl (short name NOTES~1.TMP). A short
    // name has at most one dot and an extension of at most three letters, so
    // a wildcard is safe only with two dots, or a longer last extension.
    const wild = reachableCode(lines, 'RemoveUserHelperFolder')
      .map((l) => /^Delete\s+"([^"]*)"/i.exec(l.code)?.[1])
      .filter((p): p is string => p !== undefined && /[*?]/.test(p.split('\\').pop() ?? ''))
      .map((p) => p.split('\\').pop() as string)
    expect(wild).toEqual(['*.json', '*.json.*.tmp'])
    for (const name of wild) {
      const dots = name.split('.').length - 1
      const ext = name.slice(name.lastIndexOf('.') + 1)
      expect(dots >= 2 || (ext.length > 3 && !/[*?]/.test(ext)), `${name} can match a short 8.3 name`).toBe(true)
    }
    // The conpty folder: checked, then its two files, then the folder.
    const conpty = own.indexOf('${If} ${FileExists} "$R8\\conpty\\*.*"')
    expect(own.slice(conpty, conpty + 6)).toEqual([
      '${If} ${FileExists} "$R8\\conpty\\*.*"',
      '${GetFileAttributes} "$R8\\conpty" "REPARSE_POINT" $6',
      '${If} $6 == 0',
      'Delete "$R8\\conpty\\conpty.dll"',
      'Delete "$R8\\conpty\\OpenConsole.exe"',
      'RMDir "$R8\\conpty"',
    ])
    // A ConPTY copy that stopped half way: its own name, a folder, not a link.
    const half = own.indexOf('FindFirst $R2 $R3 "$R8\\.new-*"')
    expect(own.slice(half - 3, half)).toEqual(['Push $R2', 'Push $R3', 'ClearErrors'])
    const check = own.indexOf('!insertmacro CccIsHex12 "$R9" $5')
    expect(own.slice(check, check + 7)).toEqual([
      '!insertmacro CccIsHex12 "$R9" $5',
      '${If} $5 == 1',
      '${AndIf} ${FileExists} "$R8\\$R3\\*.*"',
      '${GetFileAttributes} "$R8\\$R3" "REPARSE_POINT" $6',
      '${If} $6 == 0',
      'Delete "$R8\\$R3\\conpty.dll"',
      'Delete "$R8\\$R3\\OpenConsole.exe"',
    ])
    expect(own.slice(own.indexOf('FindClose $R2'), own.indexOf('FindClose $R2') + 4)).toEqual(['FindClose $R2', 'ClearErrors', 'Pop $R3', 'Pop $R2'])

    const body = bodyCode(lines, 'RemoveUserHelperFolderHere')
    // Neither the parent nor the helper folder may be a link.
    const linkCheck = body.indexOf('${GetFileAttributes} "$R1" "REPARSE_POINT" $5')
    expect(linkCheck).toBeGreaterThan(-1)
    expect(body.slice(linkCheck, linkCheck + 5).map(quietNote)).toEqual([
      '${GetFileAttributes} "$R1" "REPARSE_POINT" $5',
      '${GetFileAttributes} "$R0" "REPARSE_POINT" $6',
      '${If} $5 != 0',
      '${OrIf} $6 != 0',
      '!insertmacro CccHelperNote "..."',
    ])
    // The force-end comes after that check.
    expect(body.indexOf('!insertmacro CccEndUserHelpers')).toBeGreaterThan(linkCheck)

    // Each entry: not "." or "..", a folder, of the helper's own name, not a
    // link, and neither the user's data or resources folder nor holding one.
    const entry = body.indexOf('${If} $R3 != "."')
    expect(entry).toBeGreaterThan(linkCheck)
    expect(body.slice(entry, entry + 20).map(quietNote)).toEqual([
      '${If} $R3 != "."',
      '${AndIf} $R3 != ".."',
      '${AndIf} ${FileExists} "$R0\\$R3\\*.*"',
      '!insertmacro IsHelperOwnFolder "$R3" $5',
      '${If} $5 == 1',
      '${GetFileAttributes} "$R0\\$R3" "REPARSE_POINT" $6',
      '${If} $6 != 0',
      '${If} $R4 == 0',
      '!insertmacro CccHelperNote "..."',
      '${EndIf}',
      '${Else}',
      '!insertmacro HoldsUserFolder "$R0\\$R3" $6',
      '${If} $6 == 1',
      '${If} $R4 == 0',
      '!insertmacro CccHelperNote "..."',
      '${EndIf}',
      '${Else}',
      'IntOp $3 $3 + 1',
      '!insertmacro CccRemoveHelperOwnFolder',
      '${If} ${FileExists} "$R0\\$R3\\*.*"',
    ])

    // The tries are bounded.
    const bound = body.indexOf('${OrIf} $R4 >= 7')
    expect(body.slice(bound - 2, bound + 2)).toEqual(['IntOp $R4 $R4 + 1', '${If} $3 == 0', '${OrIf} $R4 >= 7', '${ExitDo}'])

    // The helper folder, then the parent: plain RMDir, never when it is or holds a user folder.
    const helperAt = body.indexOf('RMDir "$R0"')
    expect(body.slice(helperAt - 4, helperAt + 1).map(quietNote)).toEqual([
      '!insertmacro HoldsUserFolder "$R0" $6',
      '${If} $6 == 1',
      '!insertmacro CccHelperNote "..."',
      '${Else}',
      'RMDir "$R0"',
    ])
    const parentAt = body.indexOf('RMDir "$R1"')
    expect(body.slice(parentAt - 2, parentAt + 1)).toEqual(['!insertmacro HoldsUserFolder "$R1" $6', '${If} $6 != 1', 'RMDir "$R1"'])
    expect(parentAt).toBeGreaterThan(helperAt)
  })

  it('the user\'s folders are the recorded ones, or the ones the app then uses (src/main/data-paths.ts)', () => {
    const body = bodyCode(analyse(readNsh()), 'RemoveUserHelperFolderHere')
    const at = body.indexOf('!insertmacro ReadUserPath "DataDirectory" $7')
    expect(body.slice(at, at + 9)).toEqual([
      '!insertmacro ReadUserPath "DataDirectory" $7',
      '${If} $7 == ""',
      'StrCpy $7 "$R1"',
      '${EndIf}',
      '!insertmacro ReadUserPath "ResourcesDirectory" $8',
      '${If} $8 == ""',
      '!insertmacro CanonPathPair "$7" $cccCanonA $cccCanonAS',
      'StrCpy $8 "$cccCanonA\\resources"',
      '${EndIf}',
    ])
  })

  it('CanonPathPair\'s eight scratch variables are declared in both passes, and each pass uses every one (-WX)', () => {
    const lines = analyse(readNsh())
    const NAMES = ['cccCanonA', 'cccCanonAS', 'cccCanonB', 'cccCanonBS', 'cccCanonWork', 'cccCanonChar', 'cccCanonIdx', 'cccCanonTmp']
    const decl = lines.filter((l) => /^Var\s+(?:\/GLOBAL\s+)?cccCanon\w*$/.test(l.code))
    expect(decl.map((l) => l.code.split(/\s+/).pop()).sort()).toEqual([...NAMES].sort())
    for (const l of decl) {
      expect(l.macro, `${l.code} is declared in customHeader`).toBe('customHeader')
      expect(l.passes, `${l.code} compiles in both passes`).toEqual(BOTH)
    }
    // "Variable X not referenced" fails a pass under -WX: the uninstaller pass
    // uses them through customUnInstall, the installer pass through customInit
    // and customInstall.
    const unused = (roots: string[], pass: Pass) => {
      const names = new Set(roots.flatMap((r) => [...reachableMacros(r, lines)]))
      const code = lines.filter((l) => l.macro !== null && names.has(l.macro) && l.passes.includes(pass)).map((l) => l.code).join('\n')
      return NAMES.filter((n) => !new RegExp(`\\$${n}(?![\\w.])`).test(code))
    }
    expect(unused(['customUnInstall'], 'un'), 'unused in the uninstaller pass').toEqual([])
    expect(unused(['customInit', 'customInstall'], 'inst'), 'unused in the installer pass').toEqual([])
  })
})

describe('installer: the uninstall record names the install folder (static, aicc_planning #403)', () => {
  // electron-builder writes InstallLocation only under its own key, so the
  // installed programs list (winget, Get-Package) had no folder for the app.
  // installer-nsis-behaviour.test.ts reads the value the real macro writes.
  it('customInstall writes InstallLocation = $INSTDIR into the uninstall record, in the hive the record is in, and nothing else writes it', () => {
    const lines = analyse(readNsh())
    const writes = lines.filter((l) => /^WriteReg\w+ .*"\$\{UNINSTALL_REGISTRY_KEY\}" "?InstallLocation\b/.test(l.code))
    expect(writes.map((l) => [l.macro, l.code])).toEqual([
      ['customInstall', 'WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"'],
    ])
  })
})

// ---------------------------------------------------------------------------
// The app-running check (aicc_planning #319)
// ---------------------------------------------------------------------------

describe('installer: the app-running check closes only this user\'s copies from this install\'s folder (static)', () => {
  // installer-nsis-behaviour.test.ts runs these macros for real with makensis,
  // on CI's Windows parts and the VM, against running stand-ins. These hold,
  // everywhere, what the file alone can prove.

  /** The registers CccCloseAppCopies saves and restores: all but $R0, its answer. */
  const SAVED = ['$0', '$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', '$R1', '$R2', '$R3', '$R4', '$R5', '$R6', '$R7', '$R8', '$R9']

  it('no line of installer.nsh runs tasklist, taskkill, WMI or PowerShell, and the check starts no program at all', () => {
    // Over a non-interactive sign-in (SSH, a scheduled task) tasklist and
    // taskkill answer "Access denied" (measured on the VM), so the old check
    // found and closed nothing there; and an elevated `taskkill /im` asked
    // every signed-in user's copy to close. Comments may name them; code may not.
    const lines = analyse(readNsh())
    const named = lines.filter((l) => /\b(tasklist|taskkill|tskill|wmic|powershell|pwsh|Get-CimInstance|Get-WmiObject|Win32_Process|Stop-Process)\b/i.test(l.code))
    expect(named.map((l) => `line ${l.n}: ${l.code}`)).toEqual([])
    const all = reachableCode(lines, 'customCheckAppRunning')
    expect(all.filter((l) => /nsExec::|nsProcess::|ExecWait|ExecShell|ExecDos|\bExec\b/i.test(l.code)).map((l) => `${l.macro}: ${l.code}`)).toEqual([])
    expect(lines.some((l) => /^!macro\s+KillIfRunning\b/.test(l.code)), 'the tasklist macro is gone').toBe(false)
  })

  it('keeps the hook electron-builder calls, closes copies through CccCloseAppCopies, and keeps the boxes, the stop and the commit point', () => {
    const lines = analyse(readNsh())
    expect(bodyCode(lines, 'customCheckAppRunning')).toEqual([
      'DetailPrint "=== customCheckAppRunning: this user\'s copies from this install\'s folder ==="',
      // An all-users install first stops on a removal set for the next restart in its folder.
      '!ifndef BUILD_UNINSTALLER',
      '${If} $installMode == "all"',
      '!insertmacro CccStopOnPendingRemoval "$INSTDIR" 1',
      '${EndIf}',
      '!endif',
      'Push $R0',
      // The install this run replaces: the record in the hive it installs to.
      '!ifndef BUILD_UNINSTALLER',
      'ReadRegStr $R0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"',
      '!insertmacro CccGetInQuotes "$R0" $cccRecordUninstaller',
      'ClearErrors',
      '!endif',
      'cccAppStillRunning:',
      '!ifndef BUILD_UNINSTALLER',
      '!insertmacro CccCloseAppCopies "$cccRecordUninstaller"',
      '!else',
      '!insertmacro CccCloseAppCopies ""',
      '!endif',
      // Still running: Retry runs the whole check again; a silent run cannot
      // answer, so it cancels. The text names no one image name: the copy
      // left can be any of the three, and the details log says which.
      '${If} $R0 == 1',
      'MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "AI Code Conductor is still running.$\\n$\\nIf it is asking whether to save your sessions, answer it first. Otherwise close it yourself.$\\n$\\nThen click Retry." /SD IDCANCEL IDRETRY cccAppStillRunning',
      '!ifndef BUILD_UNINSTALLER',
      'DetailPrint "AI Code Conductor is still running, so nothing was installed."',
      '!else',
      'DetailPrint "AI Code Conductor is still running, so nothing was removed."',
      '!endif',
      // The check could not run: only a user can choose to carry on.
      '${ElseIf} $R0 == 2',
      'MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Could not check whether AI Code Conductor is running.$\\n$\\nClose it if it is open, then click OK to carry on." /SD IDCANCEL IDOK cccAppCheckCarryOn',
      '!ifndef BUILD_UNINSTALLER',
      'DetailPrint "Could not check whether AI Code Conductor is running, so nothing was installed."',
      '!else',
      'DetailPrint "Could not check whether AI Code Conductor is running, so nothing was removed."',
      '!endif',
      '${EndIf}',
      // A run that stops puts back what customInit changed and does not exit 0.
      '${If} $R0 != 0',
      '!ifndef BUILD_UNINSTALLER',
      'Call CccRestoreInstallLocation',
      '!endif',
      'SetErrorLevel 2',
      'Quit',
      '${EndIf}',
      'cccAppCheckCarryOn:',
      // "No copy is running" only after a check that ran and found none.
      '${If} $R0 == 0',
      'DetailPrint "No copy of AI Code Conductor is running from this install\'s folder. Proceeding."',
      '${Else}',
      'DetailPrint "Carrying on without the check, as chosen in the box."',
      '${EndIf}',
      'Pop $R0',
      '!ifndef BUILD_UNINSTALLER',
      '!insertmacro ForgetBrokenPreviousInstall',
      '!endif',
    ])
    // The folder of the install this run replaces, the cancel restore and the
    // commit point are the installer pass's; the uninstaller pass knows only $INSTDIR.
    const passesOf = (code: string) => lines.filter((l) => l.macro === 'customCheckAppRunning' && l.code === code).map((l) => l.passes)
    expect(passesOf('ReadRegStr $R0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"')).toEqual([['inst']])
    expect(passesOf('!insertmacro CccGetInQuotes "$R0" $cccRecordUninstaller')).toEqual([['inst']])
    expect(passesOf('!insertmacro CccCloseAppCopies "$cccRecordUninstaller"')).toEqual([['inst']])
    expect(passesOf('!insertmacro CccCloseAppCopies ""')).toEqual([['un']])
    expect(passesOf('Call CccRestoreInstallLocation')).toEqual([['inst']])
    expect(passesOf('!insertmacro ForgetBrokenPreviousInstall')).toEqual([['inst']])
    // Both labels, and the stop, are in both passes.
    for (const code of ['cccAppStillRunning:', 'cccAppCheckCarryOn:', 'SetErrorLevel 2', 'Quit']) expect(passesOf(code), code).toEqual([['inst', 'un']])
    // Never customInit's capture: it falls back to the other hives (the sweep's
    // proof of ownership), so it can name an install this run does not replace.
    expect(reachableCode(lines, 'customCheckAppRunning').filter((l) => /\$cccLegacyUninstaller\b/.test(l.code))).toEqual([])
  })

  it('"mine" has three answers: this user\'s, another user\'s, or not known; the helper clean-up still acts on "this user\'s" only', () => {
    const lines = analyse(readNsh())
    expect(bodyCode(lines, 'CccProcessIsMine').filter((c) => /^StrCpy \$\{OUT\}/.test(c))).toEqual(['StrCpy ${OUT} 2', 'StrCpy ${OUT} 1', 'StrCpy ${OUT} 0'])
    const mine = bodyCode(lines, 'CccProcessIsMine')
    const equal = mine.indexOf("System::Call 'advapi32::EqualSid(p r2, p R6) i .r2'")
    expect(mine.slice(equal, equal + 6)).toEqual([
      "System::Call 'advapi32::EqualSid(p r2, p R6) i .r2'",
      '${If} $2 != 0',
      'StrCpy ${OUT} 1',
      '${Else}',
      'StrCpy ${OUT} 0',
      '${EndIf}',
    ])
    // Every caller outside the app check tests for 1, so 0 and 2 are alike there.
    const callers = lines.filter((l) => /^!insertmacro CccProcessIsMine\b/.test(l.code) && !['CccScanAppCopies', 'CccCloseAppCopies'].includes(l.macro ?? ''))
    expect(callers.length).toBeGreaterThan(0)
    for (const c of callers) {
      const next = lines.slice(lines.indexOf(c) + 1).find((l) => l.code !== '')
      expect(next?.code, `${c.macro} line ${c.n}`).toBe('${If} $6 == 1')
    }
  })

  it('a copy is one of the app\'s own image names, of this user, whose program file is in this install\'s folder or the replaced install\'s, compared canonically', () => {
    const lines = analyse(readNsh())
    const scan = bodyCode(lines, 'CccScanAppCopies')
    const byName = scan.indexOf('${If} $5 == "${APP_EXECUTABLE_FILENAME}"')
    expect(byName).toBeGreaterThan(-1)
    expect(scan.slice(byName, byName + 8)).toEqual([
      '${If} $5 == "${APP_EXECUTABLE_FILENAME}"',
      '${OrIf} $5 == "Claude Command Center.exe"',
      '${OrIf} $5 == "Claude Conductor.exe"',
      // Held open with the least access, from before the user check ...
      "System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i $3) p .R8'",
      // ... 3 when it cannot be opened at all, else CccProcessIsMine's answer.
      'StrCpy $6 3',
      '${If} $R8 != 0',
      '!insertmacro CccProcessIsMine "$3" $6',
      '${EndIf}',
    ])
    // Those three names only: never the session helper, whose held terminals
    // live through an install.
    expect(scan.filter((c) => /\$5\s*S?==/.test(c))).toHaveLength(3)
    expect(reachableCode(lines, 'customCheckAppRunning').filter((l) => /aicc-helper/i.test(l.code))).toEqual([])
    // ... through the program file, read from that same handle, and the start
    // time, to its close: the pid cannot pass to another process in between,
    // so the user, the file and the start time are one process's.
    expect(scan.filter((c) => /OpenProcess|CloseHandle\(p R8\)/.test(c))).toEqual([
      "System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i $3) p .R8'",
      "System::Call 'kernel32::CloseHandle(p R8)'",
    ])
    const read = scan.indexOf("System::Call 'kernel32::QueryFullProcessImageNameW(p R8, i 0, w .r1, *i ${NSIS_MAX_STRLEN}) i .r2'")
    expect(read).toBeGreaterThan(scan.indexOf('!insertmacro CccProcessIsMine "$3" $6'))
    expect(scan.indexOf('!insertmacro CccProcessStart "$3" $4')).toBeGreaterThan(read)
    expect(scan.indexOf("System::Call 'kernel32::CloseHandle(p R8)'")).toBeGreaterThan(scan.indexOf('!insertmacro CccProcessStart "$3" $4'))
    // The file is read only for this user's, or one whose user is not known.
    expect(scan.slice(read - 4, read)).toEqual(['StrCpy $8 ""', 'StrCpy $7 0', '${If} $6 == 1', '${OrIf} $6 == 2'])
    // $INSTDIR\<name>, then the replaced install's folder\<name>, both
    // spellings through CanonPathPair: $7 says it is this install's.
    const cmp = read + 4
    expect(scan.slice(cmp, cmp + 29)).toEqual([
      '${If} $8 != ""',
      '!insertmacro CanonPathPair "$8" $cccCanonA $cccCanonAS',
      '!insertmacro CanonPathPair "$INSTDIR\\$5" $cccCanonB $cccCanonBS',
      '${If} $cccCanonA == $cccCanonB',
      '${OrIf} $cccCanonAS == $cccCanonBS',
      'StrCpy $7 1',
      '${EndIf}',
      '!if "${OLD_UNINSTALLER}" != ""',
      '${If} $7 != 1',
      '${AndIf} "${OLD_UNINSTALLER}" != ""',
      '${GetParent} "${OLD_UNINSTALLER}" $4',
      '!insertmacro CanonPathPair "$4\\$5" $cccCanonB $cccCanonBS',
      '${If} $cccCanonA == $cccCanonB',
      '${OrIf} $cccCanonAS == $cccCanonBS',
      'StrCpy $7 1',
      '${EndIf}',
      '${EndIf}',
      '!endif',
      '${EndIf}',
      '${EndIf}',
      // Listed, with its start, only when it is this install's AND this user's.
      '${If} $7 == 1',
      '${AndIf} $6 == 1',
      'StrCpy $R1 "$R1$3,"',
      '!if "${STARTS}" != ""',
      '!insertmacro CccProcessStart "$3" $4',
      'StrCpy ${STARTS} "${STARTS}$3:$4,"',
      '!endif',
      '${EndIf}',
      '!if ${REPORT} == 1',
    ])
    // The one other way into $R1: a process from this install's folder whose
    // user is not known, only when the caller says so (never into STARTS, so
    // nothing asks it to close or ends it).
    expect(scan.filter((c) => /^StrCpy \$R1\b/.test(c))).toEqual(['StrCpy $R1 "$R1$3,"', 'StrCpy $R1 "$R1$3,"', 'StrCpy $R1 ""'])
    const unsure = scan.indexOf('!if "${UNSURE}" != ""')
    expect(scan.slice(unsure, unsure + 6)).toEqual([
      '!if "${UNSURE}" != ""',
      '${If} $7 == 1',
      '${AndIf} $6 == 2',
      '${AndIf} ${UNSURE} == 1',
      'StrCpy $R1 "$R1$3,"',
      '!if ${REPORT} != 0',
    ])
    // A snapshot that cannot be taken leaves $R1 "": the caller cannot read
    // that as "none running".
    const fail = scan.lastIndexOf('${Else}')
    expect(scan.slice(fail - 1, fail + 3)).toEqual(["System::Call 'kernel32::CloseHandle(p R2)'", '${Else}', 'StrCpy $R1 ""', '!if ${REPORT} != 0'])
  })

  it('the details log gives the true reason for each same-named process left alone', () => {
    const lines = analyse(readNsh())
    const scan = bodyCode(lines, 'CccScanAppCopies')
    const report = scan.indexOf('!if ${REPORT} == 1')
    expect(scan.slice(report, report + 15)).toEqual([
      '!if ${REPORT} == 1',
      '${If} $6 == 3',
      'DetailPrint "Left $5 (process $3) running: it could not be opened, so its user and folder are not known."',
      '${ElseIf} $6 == 0',
      'DetailPrint "Left $5 (process $3) running: it is another user\'s."',
      '${ElseIf} $8 == ""',
      'DetailPrint "Left $5 (process $3) running: its program file could not be read."',
      '${ElseIf} $7 != 1',
      'DetailPrint "Left $5 (process $3) running from $8, which is not this install\'s folder."',
      '${ElseIf} $6 == 2',
      'DetailPrint "Found $5 (process $3) running from this install\'s folder, but could not read its user, so it is not closed or ended here."',
      '${Else}',
      'DetailPrint "Found $5 (process $3) running from this install\'s folder."',
      '${EndIf}',
      '!endif',
    ])
    // The last look says what is still running.
    const last = scan.indexOf('!if ${REPORT} == 2')
    expect(scan.slice(last, last + 6).map(quiet)).toEqual(['!if ${REPORT} == 2', '${If} $7 == 1', '${AndIf} $6 == 1', 'DetailPrint "..."', '${EndIf}', '!endif'])
  })

  it('WM_CLOSE goes only to the top-level windows of the copies found, each re-checked last of all, then it waits 5 seconds at most, looking every 250 ms', () => {
    const lines = analyse(readNsh())
    const close = bodyCode(lines, 'CccCloseAppCopies')
    const find = close.indexOf("System::Call 'user32::FindWindowExW(p 0, p r8, p 0, p 0) p .r8'")
    expect(find).toBeGreaterThan(close.indexOf('!insertmacro CccScanAppCopies 1 $9 "${OLD_UNINSTALLER}" ""'))
    expect(close.slice(find, find + 15)).toEqual([
      "System::Call 'user32::FindWindowExW(p 0, p r8, p 0, p 0) p .r8'",
      '${If} $8 == 0',
      '${ExitDo}',
      '${EndIf}',
      'StrCpy $3 0',
      "System::Call 'user32::GetWindowThreadProcessId(p r8, *i .r3)'",
      '${If} $3 != 0',
      '!insertmacro CccInList "$3" $6',
      '${If} $6 == 1',
      'StrCpy $7 "$7$8:$3,"',
      '${EndIf}',
      '${EndIf}',
      'IntOp $R4 $R4 + 1',
      '${If} $R4 >= 20000',
      '${ExitDo}',
    ])
    // Before each WM_CLOSE: the pid, held open, still has the start time the
    // first look recorded ("pid:start" in $9); then, the last step before the
    // post, the window is still that pid's. A pid or a window handle that
    // passed to another program gets nothing. Each post that lands is
    // counted ($R2) and its pid noted ($R0).
    const post = close.indexOf('!insertmacro CccNextPair "$7" $R4 $8 $3')
    expect(post).toBeGreaterThan(find)
    expect(close.slice(post - 4, post)).toEqual(['StrCpy $R0 ","', 'StrCpy $R2 0', 'StrCpy $R4 1', '${Do}'])
    expect(close.slice(post, post + 25)).toEqual([
      '!insertmacro CccNextPair "$7" $R4 $8 $3',
      '${If} $8 == ""',
      '${ExitDo}',
      '${EndIf}',
      "System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i $3) p .r5'",
      '${If} $5 != 0',
      '!insertmacro CccProcessStart "$3" $4',
      '${If} $4 != ""',
      'Push $R1',
      'StrCpy $R1 "$9"',
      '!insertmacro CccInList "$3:$4" $6',
      'Pop $R1',
      '${If} $6 == 1',
      'StrCpy $4 0',
      "System::Call 'user32::GetWindowThreadProcessId(p r8, *i .r4)'",
      '${If} $4 == $3',
      "System::Call 'user32::PostMessageW(p r8, i 0x10, p 0, p 0) i .r6'",
      '${If} $6 != 0',
      'IntOp $R2 $R2 + 1',
      'StrCpy $R0 "$R0$3,"',
      '${EndIf}',
      '${EndIf}',
      '${EndIf}',
      '${EndIf}',
      "System::Call 'kernel32::CloseHandle(p r5)'",
    ])
    // The details log says how many windows were asked, or that none could be reached.
    const said = close.indexOf('${If} $R2 > 0')
    expect(said).toBeGreaterThan(post)
    expect(close.slice(said, said + 5)).toEqual([
      '${If} $R2 > 0',
      'DetailPrint "Windows of AI Code Conductor asked to close: $R2."',
      '${Else}',
      'DetailPrint "No window of AI Code Conductor could be reached from here (over a remote or scheduled sign-in its windows are on another desktop), so none was asked to close."',
      '${EndIf}',
    ])
    // The list reader: "a" before the colon, "b" after it, one entry a call.
    expect(bodyCode(lines, 'CccNextPair')).toEqual([
      'StrCpy ${A} ""',
      'StrCpy ${B} ""',
      'StrCpy $R8 0',
      '${Do}',
      'StrCpy $R7 "${LIST}" 1 ${POS}',
      'IntOp ${POS} ${POS} + 1',
      '${If} $R7 == ","',
      '${OrIf} $R7 == ""',
      '${ExitDo}',
      '${EndIf}',
      '${If} $R7 == ":"',
      'StrCpy $R8 1',
      '${ElseIf} $R8 == 0',
      'StrCpy ${A} "${A}$R7"',
      '${Else}',
      'StrCpy ${B} "${B}$R7"',
      '${EndIf}',
      '${Loop}',
    ])
    // One message, to the listed windows only, and nothing sent and waited on.
    const all = reachableCode(lines, 'customCheckAppRunning')
    expect(all.filter((l) => /PostMessage|SendMessage|SendNotifyMessage|BroadcastSystemMessage/i.test(l.code)).map((l) => `${l.macro}: ${l.code}`)).toEqual([
      "CccCloseAppCopies: System::Call 'user32::PostMessageW(p r8, i 0x10, p 0, p 0) i .r6'",
    ])
    // The first look reports and records start times; the waits only count;
    // the last look reports what is left, and alone may count a process whose
    // user is not known.
    expect(close.filter((c) => /^!insertmacro CccScanAppCopies\b/.test(c))).toEqual([
      '!insertmacro CccScanAppCopies 1 $9 "${OLD_UNINSTALLER}" ""',
      '!insertmacro CccScanAppCopies 0 "" "${OLD_UNINSTALLER}" ""',
      '!insertmacro CccScanAppCopies 0 "" "${OLD_UNINSTALLER}" ""',
      '!insertmacro CccScanAppCopies 2 "" "${OLD_UNINSTALLER}" $R0',
    ])
    // Every loop is bounded: 20 looks of 250 ms (5 s), then 8 more after the ends.
    expect(close.filter((c) => /^Sleep\b/.test(c))).toEqual(['Sleep 250', 'Sleep 250'])
    expect(close.filter((c) => /^\$\{OrIf\} \$R4 >= /.test(c))).toEqual(['${OrIf} $R4 >= 20', '${OrIf} $R4 >= 8'])
    // An end that failed reads the exit code 10 more times at most, 50 ms apart.
    const why = bodyCode(lines, 'CccWhyNotEnded')
    expect(why.filter((c) => /^Sleep\b|^\$\{OrIf\} \$0 >= /.test(c))).toEqual(['${OrIf} $0 >= 10', 'Sleep 50'])
  })

  it('in a run someone can see, nothing is ended while a copy that was asked to close is still open (it may be asking whether to save)', () => {
    const lines = analyse(readNsh())
    const close = bodyCode(lines, 'CccCloseAppCopies')
    // The file's one silent-run gate, after the 5 second wait and before any end.
    expect(reachableCode(lines, 'customCheckAppRunning').filter((l) => /\$\{Silent\}|IfSilent/.test(l.code)).map((l) => `${l.macro}: ${l.code}`)).toEqual([
      'CccCloseAppCopies: ${IfNot} ${Silent}',
    ])
    const gate = close.indexOf('${IfNot} ${Silent}')
    expect(gate).toBeGreaterThan(close.indexOf('${OrIf} $R4 >= 20'))
    expect(gate).toBeLessThan(close.indexOf("System::Call 'kernel32::OpenProcess(i 0x1001, i 0, i $3) p .r8'"))
    expect(close.slice(gate - 2, gate + 16).map(quiet)).toEqual([
      '${If} $R1 != ","',
      'StrCpy $5 0',
      '${IfNot} ${Silent}',
      'StrCpy $R4 1',
      '${Do}',
      // Each pid a WM_CLOSE reached ($R0), still running ($R1)?
      '!insertmacro CccNextPair "$R0" $R4 $3 $4',
      '${If} $3 == ""',
      '${ExitDo}',
      '${EndIf}',
      '!insertmacro CccInList "$3" $6',
      '${If} $6 == 1',
      'StrCpy $5 1',
      '${EndIf}',
      '${Loop}',
      '${EndIf}',
      '${If} $5 == 1',
      'DetailPrint "..."',
      '${Else}',
    ])
    // Everything that ends a copy is in that ${Else}.
    const otherwise = gate + 15
    expect(close.indexOf("System::Call 'kernel32::TerminateProcess(p r8, i 1) i .r6 ?e'")).toBeGreaterThan(otherwise)
  })

  it('it ends a copy only through a handle it holds, after checking that process is still this user\'s with the same start time, and logs every outcome', () => {
    const lines = analyse(readNsh())
    const close = bodyCode(lines, 'CccCloseAppCopies')
    const open = close.indexOf("System::Call 'kernel32::OpenProcess(i 0x1001, i 0, i $3) p .r8'")
    // Only after the wait, only for a copy the first look found ($9) that the
    // last wait still saw ($R1).
    expect(open).toBeGreaterThan(close.indexOf('${OrIf} $R4 >= 20'))
    expect(close.slice(open - 6, open)).toEqual(['!insertmacro CccNextPair "$9" $R4 $3 $4', '${If} $3 == ""', '${ExitDo}', '${EndIf}', '!insertmacro CccInList "$3" $6', '${If} $6 == 1'])
    expect(close.slice(open, open + 21)).toEqual([
      "System::Call 'kernel32::OpenProcess(i 0x1001, i 0, i $3) p .r8'",
      '${If} $8 != 0',
      '!insertmacro CccProcessIsMine "$3" $6',
      '!insertmacro CccProcessStart "$3" $R8',
      '${If} $6 == 1',
      '${AndIf} $4 != ""',
      '${AndIf} $R8 == $4',
      // Windows' error is taken with the call (?e) and off the stack at once.
      "System::Call 'kernel32::TerminateProcess(p r8, i 1) i .r6 ?e'",
      'Pop $7',
      '${If} $6 != 0',
      'DetailPrint "Ended process $3, which did not close within 5 seconds."',
      '${Else}',
      // An end that failed says why (aicc_planning #328), through the handle
      // it was tried with, from the error the call left.
      '!insertmacro CccWhyNotEnded "$3" $8 $7',
      '${EndIf}',
      '${Else}',
      'DetailPrint "Did not end process $3: it could not be confirmed as the copy found first."',
      '${EndIf}',
      "System::Call 'kernel32::CloseHandle(p r8)'",
      '${Else}',
      'DetailPrint "Could not end process $3: it could not be opened to end it."',
      '${EndIf}',
    ])
    // $3 and $4 are the pid and start the first look recorded, read back from $9.
    const scan = bodyCode(lines, 'CccScanAppCopies')
    const start = scan.indexOf('!insertmacro CccProcessStart "$3" $4')
    expect(scan.slice(start - 1, start + 2)).toEqual(['!if "${STARTS}" != ""', '!insertmacro CccProcessStart "$3" $4', 'StrCpy ${STARTS} "${STARTS}$3:$4,"'])
    // This copy's own user, read as CccEndUserHelpers reads it.
    const own = close.indexOf("System::Call 'kernel32::GetCurrentProcess() p .r0'")
    expect(close.slice(own, own + 6)).toEqual([
      "System::Call 'kernel32::GetCurrentProcess() p .r0'",
      "System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i .r2'",
      '${If} $2 != 0',
      "System::Call 'advapi32::GetTokenInformation(p r1, i 1, p R9, i 256, *i .r2) i .r2'",
      '${If} $2 != 0',
      "System::Call '*$R9(p .R6)'",
    ])
    // With none, nothing is looked at or ended, and the answer is "could not
    // check" ($R1 ""), never "none running".
    const none = close.indexOf('${If} $R6 == 0')
    expect(none).toBeGreaterThan(own)
    expect(close.slice(none, none + 4).map(quiet)).toEqual(['${If} $R6 == 0', 'DetailPrint "..."', 'StrCpy $R1 ""', '${Else}'])
    expect(close.findIndex((c) => /^!insertmacro CccScanAppCopies\b/.test(c))).toBeGreaterThan(none)
    // The buffers it takes are given back.
    expect(close.filter((c) => /^System::(Alloc|Free)\b/.test(c))).toEqual([
      'System::Alloc 256', 'System::Alloc 256', 'System::Alloc 556', 'System::Free $R3', 'System::Free $R5', 'System::Free $R9',
    ])
  })

  it('an end that failed says why: it had already exited, access was denied, or the error number (aicc_planning #328)', () => {
    // installer-nsis-behaviour.test.ts runs CccWhyNotEnded for real on each of the three.
    const lines = analyse(readNsh())
    expect(bodyCode(lines, 'CccWhyNotEnded')).toEqual([
      'StrCpy $0 0',
      '${Do}',
      // The handle the end was tried with, so the pid cannot have passed on.
      "System::Call 'kernel32::GetExitCodeProcess(p ${HANDLE}, *i .r1) i .r2'",
      '${If} $2 == 0',
      '${OrIf} $1 != 259',
      '${OrIf} $0 >= 10',
      '${ExitDo}',
      '${EndIf}',
      'Sleep 50',
      'IntOp $0 $0 + 1',
      '${Loop}',
      '${If} $2 != 0',
      '${AndIf} $1 != 259',
      'DetailPrint "Could not end process ${PID}: it had already exited."',
      '${ElseIf} ${ERROR} == 5',
      'DetailPrint "Could not end process ${PID}: access was denied."',
      '${Else}',
      'DetailPrint "Could not end process ${PID}: Windows error ${ERROR}."',
      '${EndIf}',
    ])
    // Its one caller passes the pid, the handle and the error the end left.
    expect(lines.filter((l) => /^!insertmacro CccWhyNotEnded\b/.test(l.code)).map((l) => `${l.macro}: ${l.code}`)).toEqual(['CccCloseAppCopies: !insertmacro CccWhyNotEnded "$3" $8 $7'])
    // No line says "Could not end process" with no reason any more.
    expect(lines.filter((l) => /"Could not end process [^:"]*\."/.test(l.code)).map((l) => l.code)).toEqual([])
  })

  it('the last look counts a copy whose user is not known only when this installer is not elevated, and the answer is 0, 1 or 2', () => {
    const lines = analyse(readNsh())
    const close = bodyCode(lines, 'CccCloseAppCopies')
    const last = close.indexOf('!insertmacro CccScanAppCopies 2 "" "${OLD_UNINSTALLER}" $R0')
    expect(close.slice(last - 12, last + 1)).toEqual([
      'StrCpy $R0 1',
      "System::Call 'kernel32::GetCurrentProcess() p .r0'",
      "System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i .r2'",
      '${If} $2 != 0',
      // TokenElevation
      "System::Call 'advapi32::GetTokenInformation(p r1, i 20, *i .r3, i 4, *i .r2) i .r2'",
      '${If} $2 != 0',
      '${AndIf} $3 != 0',
      'StrCpy $R0 0',
      '${EndIf}',
      "System::Call 'kernel32::CloseHandle(p r1)'",
      '${EndIf}',
      'StrCpy $R1 ","',
      '!insertmacro CccScanAppCopies 2 "" "${OLD_UNINSTALLER}" $R0',
    ])
    // It runs whenever the first look could list the programs, so a copy
    // whose user is not known is seen even when no copy of this user's was.
    const first = close.indexOf('!insertmacro CccScanAppCopies 1 $9 "${OLD_UNINSTALLER}" ""')
    expect(close.slice(first + 1, first + 3)).toEqual(['${If} $R1 != ""', '${If} $R1 != ","'])
    expect(close.slice(last + 1, last + 9)).toEqual(['${EndIf}', '${EndIf}', '${If} $R1 == ","', 'StrCpy $R0 0', '${ElseIf} $R1 == ""', 'StrCpy $R0 2', '${Else}', 'StrCpy $R0 1'])
  })

  it('it saves and restores every register but $R0, its answer, and customCheckAppRunning gives $R0 back to its caller', () => {
    const lines = analyse(readNsh())
    const close = bodyCode(lines, 'CccCloseAppCopies')
    expect(close.slice(0, SAVED.length)).toEqual(SAVED.map((r) => `Push ${r}`))
    expect(close.slice(-SAVED.length)).toEqual([...SAVED].reverse().map((r) => `Pop ${r}`))
    // $R0 holds the pids asked to close, then the elevation answer, then the
    // answer; nothing it inserts touches it.
    expect(reachableCode(lines, 'CccCloseAppCopies').filter((l) => /\$R0\b/.test(l.code)).map((l) => `${l.macro}: ${l.code}`)).toEqual([
      'CccCloseAppCopies: StrCpy $R0 ","',
      'CccCloseAppCopies: StrCpy $R0 "$R0$3,"',
      'CccCloseAppCopies: !insertmacro CccNextPair "$R0" $R4 $3 $4',
      'CccCloseAppCopies: StrCpy $R0 1',
      'CccCloseAppCopies: StrCpy $R0 0',
      'CccCloseAppCopies: !insertmacro CccScanAppCopies 2 "" "${OLD_UNINSTALLER}" $R0',
      'CccCloseAppCopies: StrCpy $R0 0',
      'CccCloseAppCopies: StrCpy $R0 2',
      'CccCloseAppCopies: StrCpy $R0 1',
    ])
    const check = bodyCode(lines, 'customCheckAppRunning')
    expect(check.filter((c) => /^(Push|Pop|Exch)\b/.test(c))).toEqual(['Push $R0', 'Pop $R0'])
    // The Retry label sits after the Push, so a Retry leaves the stack as it
    // was; the carry-on label sits before the Pop.
    expect(check.indexOf('cccAppStillRunning:')).toBeGreaterThan(check.indexOf('Push $R0'))
    expect(check.indexOf('cccAppStillRunning:')).toBeGreaterThan(check.indexOf('ClearErrors'))
    expect(check.indexOf('cccAppCheckCarryOn:')).toBeLessThan(check.indexOf('Pop $R0'))
    expect(check.indexOf('cccAppCheckCarryOn:')).toBeGreaterThan(check.indexOf('Quit'))
  })

  it('-WX in both passes: the check declares no Var or Function, and what only the installer pass has is used only there', () => {
    // customCheckAppRunning is inserted in both passes (installSection.nsh and
    // uninstaller.nsh's un.checkAppRunning). A Var or Function one pass never
    // uses fails that pass's build under -WX.
    const lines = analyse(readNsh())
    const names = reachableMacros('customCheckAppRunning', lines)
    for (const n of ['CccCloseAppCopies', 'CccScanAppCopies', 'CccNextPair', 'CccProcessIsMine', 'CccProcessStart', 'CccInList', 'CanonPathPair', 'CccGetInQuotes']) expect(names.has(n), n).toBe(true)
    const own = lines.filter((l) => l.macro !== null && ['customCheckAppRunning', 'CccCloseAppCopies', 'CccScanAppCopies', 'CccNextPair'].includes(l.macro))
    expect(own.filter((l) => /^(Var|Function)\b/.test(l.code)).map((l) => l.code)).toEqual([])
    // Compiled in both passes, they use only CanonPathPair's scratch, which
    // customHeader declares in both.
    const bothPass = new Set(own.filter((l) => l.passes.length === 2).flatMap((l) => [...l.code.matchAll(/\$(ccc\w+)/g)].map((m) => m[1])))
    expect([...bothPass].sort()).toEqual(['cccCanonA', 'cccCanonAS', 'cccCanonB', 'cccCanonBS'])
    // The replaced install's record (an installer-only variable, and
    // CccGetInQuotes, whose scratch is installer-only too) and the cancel
    // restore: installer pass only.
    expect(own.filter((l) => /\$ccc(?!Canon)\w+|CccRestoreInstallLocation|CccGetInQuotes|CccStopOnPendingRemoval|SHELL_CONTEXT/.test(l.code)).map((l) => [l.code, l.passes])).toEqual([
      // Which calls CccRestoreInstallLocation, so it is the installer pass's too.
      ['!insertmacro CccStopOnPendingRemoval "$INSTDIR" 1', ['inst']],
      ['ReadRegStr $R0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"', ['inst']],
      ['!insertmacro CccGetInQuotes "$R0" $cccRecordUninstaller', ['inst']],
      ['!insertmacro CccCloseAppCopies "$cccRecordUninstaller"', ['inst']],
      ['Call CccRestoreInstallLocation', ['inst']],
    ])
    // Each label is jumped to in both passes, by the box beside it.
    const check = lines.filter((l) => l.macro === 'customCheckAppRunning')
    for (const label of ['cccAppStillRunning', 'cccAppCheckCarryOn']) {
      const jumps = check.filter((l) => new RegExp(`\\b(IDRETRY|IDOK)\\s+${label}$`).test(l.code))
      expect(jumps.map((l) => l.passes), label).toEqual([['inst', 'un']])
    }
  })

  it('the elevated inner instance runs the same check and box from customInit, after the retarget and the suspend, and the commit point stays where it was (aicc_planning #327)', () => {
    // installSection.nsh skips CHECK_APP_RUNNING in the elevated inner
    // instance (${ifNot} ${UAC_IsInnerInstance}), so before this nothing there
    // closed a running copy before the files.
    const lines = analyse(readNsh())
    const init = bodyCode(lines, 'customInit')
    const check = init.indexOf('!insertmacro CccCloseAppCopies "$cccRecordUninstaller"')
    expect(check, 'customInit runs CccCloseAppCopies').toBeGreaterThan(-1)
    // Twice: $INSTDIR as initMultiUser left it (with the record's folder), then the folder this instance installs into.
    expect(init.filter((c) => /^!insertmacro CccCloseAppCopies\b/.test(c))).toEqual(['!insertmacro CccCloseAppCopies "$cccRecordUninstaller"', '!insertmacro CccCloseAppCopies ""'])
    // After the retarget and the suspend, so a stop can put both back.
    for (const before of [
      '!insertmacro RetargetRecordedInstallLocation HKCU "$R9" $cccSavedPerUserInstallLocation',
      '!insertmacro RetargetRecordedInstallLocation HKLM "$R9" $cccSavedPerMachineInstallLocation',
      '!insertmacro SuspendUninstallRecordIn HKCU $cccSavedPerUserUninstallString',
      '!insertmacro SuspendUninstallRecordIn HKLM $cccSavedPerMachineUninstallString',
    ]) {
      expect(init.indexOf(before), before).toBeGreaterThan(-1)
      expect(init.indexOf(before), before).toBeLessThan(check)
    }
    // Its own ${If} ${UAC_IsInnerInstance}, at the top level of customInit:
    // not inside the legacy relocation or the /D= branch, so every elevated
    // inner instance runs it.
    const open = init.lastIndexOf('${If} ${UAC_IsInnerInstance}', check)
    expect(open).toBeGreaterThan(init.indexOf('!insertmacro SuspendUninstallRecordIn HKLM $cccSavedPerMachineUninstallString'))
    expect(enclosingBlocks(init, open)).toEqual([])
    expect(init.slice(open)).toEqual([
      '${If} ${UAC_IsInnerInstance}',
      'Push $R0',
      'Push $R1',
      'Push $R2',
      // The folder setInstallModePerAllUsers moves $INSTDIR to at the
      // install-mode page (pinned against the template below).
      'ReadRegStr $R1 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"',
      '${If} $R1 == ""',
      'StrCpy $R1 "$PROGRAMFILES"',
      '!ifdef APP_64',
      '${If} ${RunningX64}',
      'StrCpy $R1 "$PROGRAMFILES64"',
      '${EndIf}',
      '!endif',
      '!ifdef MENU_FILENAME',
      'StrCpy $R1 "$R1\\${MENU_FILENAME}"',
      '!endif',
      'StrCpy $R1 "$R1\\${APP_FILENAME}"',
      '${EndIf}',
      '!insertmacro GetDParameter $R2',
      '${If} $R2 != ""',
      'StrCpy $R1 "$R2"',
      '${EndIf}',
      'ClearErrors',
      // First, a removal set for the next restart in either folder stops it
      // (no details list exists yet in .onInit, so 0).
      '!insertmacro CccStopOnPendingRemoval "$INSTDIR" 0',
      '${If} $R1 != "$INSTDIR"',
      '!insertmacro CccStopOnPendingRemoval "$R1" 0',
      '${EndIf}',
      // The install this run replaces: the all-users record, as it is or as
      // the suspend above saved it.
      'ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"',
      '${If} $R0 == ""',
      'StrCpy $R0 "$cccSavedPerMachineUninstallString"',
      '${EndIf}',
      '!insertmacro CccGetInQuotes "$R0" $cccRecordUninstaller',
      'ClearErrors',
      'cccInnerAppStillRunning:',
      '!insertmacro CccCloseAppCopies "$cccRecordUninstaller"',
      // Then the folder it installs into, when that is another: a copy
      // running there (1) wins, then a check that could not run (2).
      '${If} $R0 != 1',
      '${AndIf} $R1 != "$INSTDIR"',
      'StrCpy $R2 $R0',
      'Push $INSTDIR',
      'StrCpy $INSTDIR "$R1"',
      '!insertmacro CccCloseAppCopies ""',
      'Pop $INSTDIR',
      '${If} $R0 == 0',
      'StrCpy $R0 $R2',
      '${EndIf}',
      '${EndIf}',
      '${If} $R0 == 1',
      'MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "AI Code Conductor is still running.$\\n$\\nIf it is asking whether to save your sessions, answer it first. Otherwise close it yourself.$\\n$\\nThen click Retry." /SD IDCANCEL IDRETRY cccInnerAppStillRunning',
      '${ElseIf} $R0 == 2',
      'MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Could not check whether AI Code Conductor is running.$\\n$\\nClose it if it is open, then click OK to carry on." /SD IDCANCEL IDOK cccInnerAppCheckCarryOn',
      '${EndIf}',
      // A stop puts back what customInit changed and does not exit 0.
      '${If} $R0 != 0',
      'Call CccRestoreInstallLocation',
      'SetErrorLevel 2',
      'Quit',
      '${EndIf}',
      'cccInnerAppCheckCarryOn:',
      'Pop $R2',
      'Pop $R1',
      'Pop $R0',
      '${EndIf}',
      'ClearErrors',
    ])
    // .onInit has no details list yet, so the block writes none: what the user sees is the box.
    expect(init.slice(open).filter((c) => /^DetailPrint\b/.test(c))).toEqual([])
    // The folder rule is electron-builder's setInstallModePerAllUsers at the
    // pinned app-builder-lib: a change there fails here.
    const tpl = readFileSync(join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'multiUser.nsh'), 'utf-8').replace(/\r\n/g, '\n').split('\n').map((l) => stripComment(l).trim()).filter((c) => c !== '')
    const from = tpl.indexOf('ReadRegStr $perMachineInstallationFolder HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation')
    expect(from, 'setInstallModePerAllUsers reads the all-users InstallLocation').toBeGreaterThan(-1)
    expect(tpl.slice(from, from + 19)).toEqual([
      'ReadRegStr $perMachineInstallationFolder HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation',
      '${if} $perMachineInstallationFolder != ""',
      'StrCpy $INSTDIR $perMachineInstallationFolder',
      '${else}',
      'StrCpy $0 "$PROGRAMFILES"',
      '!ifdef APP_64',
      '${if} ${RunningX64}',
      'StrCpy $0 "$PROGRAMFILES64"',
      '${endif}',
      '!endif',
      '!ifdef MENU_FILENAME',
      'StrCpy $0 "$0\\${MENU_FILENAME}"',
      '!endif',
      'StrCpy $INSTDIR "$0\\${APP_FILENAME}"',
      '${endif}',
      '!insertmacro GetDParameter $R0',
      '${If} $R0 != ""',
      'StrCpy $INSTDIR $R0',
      '${endif}',
    ])
    // And the inner instance passes that page (multiUserUi.nsh: inner and admin, setInstallModePerAllUsers).
    const ui = readFileSync(join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'multiUserUi.nsh'), 'utf-8').replace(/\r\n/g, '\n').split('\n').map((l) => stripComment(l).trim()).filter((c) => c !== '')
    const inner = ui.indexOf('${if} ${UAC_IsInnerInstance}')
    expect(ui.slice(inner, inner + 4)).toEqual(['${if} ${UAC_IsInnerInstance}', '${andIf} ${UAC_IsAdmin}', '!insertmacro setInstallModePerAllUsers', 'Abort'])
    // The same two boxes customCheckAppRunning shows, word for word.
    const boxes = (body: string[]) => body.filter((c) => /^MessageBox\b/.test(c)).map((c) => c.replace(/\s+(IDRETRY|IDOK)\s+\w+$/, ''))
    expect(boxes(init.slice(open))).toEqual(boxes(bodyCode(lines, 'customCheckAppRunning')))
    // The commit point does not move: customInit drops no record.
    expect(reachableCode(lines, 'customInit').filter((l) => /ForgetBrokenPreviousInstall|ForgetPreviousInstallIn/.test(l.code))).toEqual([])
    expect(bodyCode(lines, 'customCheckAppRunning').slice(-3)).toEqual(['!ifndef BUILD_UNINSTALLER', '!insertmacro ForgetBrokenPreviousInstall', '!endif'])
  })
})

/**
 * The blocks enclosing body[at], innermost first: each block's opening line
 * with the ${AndIf} / ${OrIf} lines that join it, and any ${Else} or
 * ${ElseIf} passed on the way (so a line in an else branch says so).
 */
function enclosingBlocks(body: string[], at: number): { open: string[]; via: string[] }[] {
  const out: { open: string[]; via: string[] }[] = []
  let depth = 0
  let via: string[] = []
  for (let i = at - 1; i >= 0; i--) {
    const c = body[i]
    if (/^\$\{(EndIf|EndUnless)\}$/i.test(c)) {
      depth++
    } else if (/^\$\{(Else|ElseIf|ElseIfNot|ElseUnless)\}/i.test(c)) {
      if (depth === 0) via.push(c)
    } else if (/^\$\{(If|IfNot|Unless)\}/i.test(c)) {
      if (depth > 0) {
        depth--
      } else {
        const open = [c]
        for (let j = i + 1; j < body.length && /^\$\{(AndIf|AndIfNot|AndUnless|OrIf|OrIfNot|OrUnless)\}/i.test(body[j]); j++) open.push(body[j])
        out.push({ open, via })
        via = []
      }
    }
  }
  return out
}

describe('installer: the uninstaller removes the program files as electron-builder does, then says what is left (static, aicc_planning #328)', () => {
  // installer-nsis-behaviour.test.ts runs CccReportLeftFiles for real with
  // makensis, on CI's Windows parts, over a folder with a running program in it.

  /** The app-builder-lib whose uninstaller.nsh customRemoveFiles copies. */
  const PINNED_APP_BUILDER_LIB = '26.15.3'
  const TEMPLATE = join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'uninstaller.nsh')

  /** The code lines of the template's own removal: the !else branch of its !ifmacrodef customRemoveFiles. */
  function templateRemoval(): string[] {
    const src = readFileSync(TEMPLATE, 'utf-8').replace(/\r\n/g, '\n').split('\n').map((l) => stripComment(l).trim())
    const at = src.indexOf('!ifmacrodef customRemoveFiles')
    expect(at, 'uninstaller.nsh asks for customRemoveFiles').toBeGreaterThan(-1)
    expect(src.slice(at, at + 3)).toEqual(['!ifmacrodef customRemoveFiles', '!insertmacro customRemoveFiles', '!else'])
    const out: string[] = []
    let depth = 0
    for (const c of src.slice(at + 3)) {
      if (/^!if/.test(c)) depth++
      if (/^!endif\b/.test(c)) {
        if (depth === 0) return out
        depth--
      }
      if (c !== '') out.push(c)
    }
    throw new Error('no !endif closes the template\'s !ifmacrodef customRemoveFiles')
  }

  it('customRemoveFiles is electron-builder\'s own removal, line for line, at the pinned app-builder-lib, then the report', () => {
    // A newer electron-builder that changes its removal fails here, so the
    // copy cannot drift silently: compare the new template's block with
    // customRemoveFiles, carry the change over, then move the pin.
    const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'app-builder-lib', 'package.json'), 'utf-8')).version
    expect(pkgVersion, 'app-builder-lib moved: compare customRemoveFiles with its uninstaller.nsh, then update the pin').toBe(PINNED_APP_BUILDER_LIB)
    const tpl = templateRemoval()
    expect(tpl).toContain('RMDir /r $INSTDIR')
    expect(tpl).toContain('Call un.atomicRMDir')
    const lines = analyse(readNsh())
    const body = bodyCode(lines, 'customRemoveFiles')
    expect(body.slice(0, tpl.length)).toEqual(tpl)
    expect(body.slice(tpl.length)).toEqual(['!insertmacro CccReportLeftFiles'])
  })

  it('both macros are the uninstaller pass\'s only, declare no Var or Function, and the installer pass never inserts them', () => {
    const lines = analyse(readNsh())
    for (const name of ['customRemoveFiles', 'CccReportLeftFiles']) {
      const own = lines.filter((l) => l.macro === name)
      expect(own.length, name).toBeGreaterThan(0)
      expect([...new Set(own.map((l) => l.passes.join(',')))], name).toEqual(['un'])
      expect(own.filter((l) => /^(Var|Function)\b/.test(l.code)).map((l) => l.code), name).toEqual([])
    }
    expect(lines.filter((l) => /^!insertmacro\s+"?customRemoveFiles\b/.test(l.code))).toEqual([])
    expect(lines.filter((l) => /^!insertmacro\s+"?CccReportLeftFiles\b/.test(l.code)).map((l) => l.macro)).toEqual(['customRemoveFiles'])
  })

  it('/REBOOTOK appears once, only on an all-users uninstall that no new install follows into this folder, inside Program Files; nobody is asked to restart', () => {
    const lines = analyse(readNsh())
    const reboot = lines.filter((l) => /REBOOTOK/i.test(l.code))
    expect(reboot.map((l) => `${l.macro}: ${l.code}`)).toEqual(['CccReportLeftFiles: RMDir /r /REBOOTOK "$INSTDIR"'])
    expect(reboot[0].passes).toEqual(['un'])
    const body = bodyCode(lines, 'CccReportLeftFiles')
    const at = body.indexOf('RMDir /r /REBOOTOK "$INSTDIR"')
    const blocks = enclosingBlocks(body, at)
    expect(blocks).toEqual([
      { open: ['${If} $R0 == 1'], via: [] },
      { open: ['${If} $installMode == "all"', '${AndIf} $R1 == 0'], via: [] },
      { open: ['${If} ${FileExists} "$INSTDIR\\*.*"'], via: [] },
    ])
    // $R1 is 0 only when this is not an update and the uninstall was not given
    // --delete-app-data (Setup passes it in place of --updated, installUtil.nsh
    // uninstallOldVersion; a person may pass it too): then nothing is set.
    const flag = body.indexOf('StrCpy $R1 0')
    expect(body.slice(flag, flag + 14)).toEqual([
      'StrCpy $R1 0',
      '${If} ${isUpdated}',
      'StrCpy $R1 1',
      '${Else}',
      '${GetParameters} $R2',
      'ClearErrors',
      '${GetOptions} $R2 "--delete-app-data" $R3',
      '${IfNot} ${Errors}',
      'StrCpy $R1 2',
      '${EndIf}',
      'ClearErrors',
      '${EndIf}',
      '${If} $installMode == "all"',
      '${AndIf} $R1 == 0',
    ])
    expect(body.filter((c) => /^StrCpy \$R1\b/.test(c))).toEqual(['StrCpy $R1 0', 'StrCpy $R1 1', 'StrCpy $R1 2'])
    // The template passes exactly that option name in place of --updated.
    const util = readFileSync(join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include', 'installUtil.nsh'), 'utf-8').replace(/\r\n/g, '\n').split('\n').map((l) => stripComment(l).trim()).filter((c) => c !== '')
    const del = util.indexOf('${if} ${isDeleteAppData}')
    expect(util.slice(del, del + 5)).toEqual(['${if} ${isDeleteAppData}', 'StrCpy $0 "$0 --delete-app-data"', '${else}', 'StrCpy $0 "$0 --updated"', '${endif}'])
    // $R0 is 1 only when $INSTDIR is inside one of the Program Files folders,
    // and never Program Files itself.
    const allUsers = body.indexOf('${If} $installMode == "all"')
    expect(body.slice(allUsers + 2, at - 2)).toEqual([
      'StrCpy $R0 0',
      '!insertmacro IsSameOrInsideCanon "$PROGRAMFILES64" "$INSTDIR" $R0',
      '${If} $R0 != 1',
      '!insertmacro IsSameOrInsideCanon "$PROGRAMFILES" "$INSTDIR" $R0',
      '${EndIf}',
      '${If} $cccCanonA == $cccCanonB',
      '${OrIf} $cccCanonAS == $cccCanonBS',
      'StrCpy $R0 0',
      '${EndIf}',
      '${If} $R0 == 1',
    ])
    expect(body.slice(at - 2, at)).toEqual(['SetRebootFlag false', 'ClearErrors'])
    // The reboot flag is cleared again before the branch ends, so the finish
    // page offers no restart; outside Program Files nothing is set.
    const again = body.indexOf('SetRebootFlag false', at)
    expect(body.slice(again - 1, again + 3).map(quiet)).toEqual(['${EndIf}', 'SetRebootFlag false', '${Else}', 'DetailPrint "..."'])
    expect(body[again + 2]).toMatch(/not inside Program Files/)
    // A per-user uninstall, or any uninstall given --delete-app-data, says the
    // files stay, and sets nothing; an update says nothing more.
    const stay = body.indexOf('${ElseIf} $R1 != 1')
    expect(stay).toBeGreaterThan(at)
    expect(body.slice(stay, stay + 3)).toEqual(['${ElseIf} $R1 != 1', 'DetailPrint "They stay until they are removed by hand, once the program that has them open has closed."', '${EndIf}'])
  })

  it('it names each file left, at most 50 and then how many more, never enters a link, is bounded, and gives back every register', () => {
    const lines = analyse(readNsh())
    const body = bodyCode(lines, 'CccReportLeftFiles')
    const left = body.indexOf('DetailPrint "Left: $3\\$5"')
    expect(left).toBeGreaterThan(-1)
    expect(body.slice(left - 3, left)).toEqual(['${If} $R0 == 1', 'IntOp $0 $0 + 1', '${If} $0 <= 50'])
    expect(body).toContain('DetailPrint "And $R0 more files."')
    // A folder is looked into only when it is not a link, and it waits on the
    // stack only while fewer than 256 do; past that it is counted as not looked in.
    const attr = body.indexOf('${GetFileAttributes} "$3\\$5" "REPARSE_POINT" $R0')
    expect(attr).toBeGreaterThan(-1)
    expect(body.slice(attr, attr + 7)).toEqual([
      '${GetFileAttributes} "$3\\$5" "REPARSE_POINT" $R0',
      '${If} $R0 == 0',
      '${If} $2 < 256',
      'Push "$3\\$5"',
      'IntOp $2 $2 + 1',
      '${Else}',
      'IntOp $6 $6 + 1',
    ])
    expect(body.filter((c) => /^Push "/.test(c))).toEqual(['Push "$INSTDIR"', 'Push "$3\\$5"'])
    // At most 1000 folders are looked in: the bound is tested as each folder
    // comes off the stack, before it is counted and looked in, so a folder
    // already waiting there when the bound is reached is counted as not
    // looked in too. It is the only place $1 grows.
    const pop = body.indexOf('Pop $3')
    expect(body.slice(pop, pop + 8)).toEqual([
      'Pop $3',
      'IntOp $2 $2 - 1',
      '${If} $1 >= 1000',
      'IntOp $6 $6 + 1',
      '${Continue}',
      '${EndIf}',
      'IntOp $1 $1 + 1',
      'ClearErrors',
    ])
    expect(body.filter((c) => /^IntOp \$1\b/.test(c))).toEqual(['IntOp $1 $1 + 1'])
    expect(body.filter((c) => /\$1 (<|<=|>|>=|==|!=) /.test(c))).toEqual(['${If} $1 >= 1000'])
    // The walk pops exactly what it pushed ($2 counts them), inside the saved registers.
    const saved = ['$0', '$1', '$2', '$3', '$4', '$5', '$6', '$R0', '$R1', '$R2', '$R3', '$R5', '$R6', '$R7']
    expect(body.slice(0, saved.length)).toEqual(saved.map((r) => `Push ${r}`))
    expect(body.slice(-saved.length)).toEqual([...saved].reverse().map((r) => `Pop ${r}`))
    expect(body.filter((c) => /^Pop \$3$/.test(c))).toHaveLength(2)
    // It only reads and reports: the one removal is the /REBOOTOK one.
    expect(body.filter((c) => /^(RMDir|Delete)\b/i.test(c))).toEqual(['RMDir /r /REBOOTOK "$INSTDIR"'])
  })

  it('an all-users install stops first while a removal set for the next restart waits in its folder, in both places an all-users install checks for the app', () => {
    // A restart takes what is at those paths, so the new files too.
    // installer-nsis-behaviour.test.ts runs it for real over a stand-in for
    // the value.
    const lines = analyse(readNsh())
    const stops = lines.filter((l) => /^!insertmacro\s+CccStopOnPendingRemoval\b/.test(l.code))
    expect(stops.map((l) => `${l.macro}: ${l.code}`)).toEqual([
      'customCheckAppRunning: !insertmacro CccStopOnPendingRemoval "$INSTDIR" 1',
      'customInit: !insertmacro CccStopOnPendingRemoval "$INSTDIR" 0',
      'customInit: !insertmacro CccStopOnPendingRemoval "$R1" 0',
    ])
    // customCheckAppRunning runs in both passes: there it is the installer pass's, for an all-users install, before the check.
    const check = bodyCode(lines, 'customCheckAppRunning')
    const at = check.indexOf('!insertmacro CccStopOnPendingRemoval "$INSTDIR" 1')
    expect(stops[0].passes).toEqual(['inst'])
    expect(check.slice(at - 2, at + 3)).toEqual(['!ifndef BUILD_UNINSTALLER', '${If} $installMode == "all"', '!insertmacro CccStopOnPendingRemoval "$INSTDIR" 1', '${EndIf}', '!endif'])
    expect(at).toBeLessThan(check.indexOf('cccAppStillRunning:'))
    // In customInit, before the app check.
    const init = bodyCode(lines, 'customInit')
    expect(init.indexOf('!insertmacro CccStopOnPendingRemoval "$R1" 0')).toBeLessThan(init.indexOf('cccInnerAppStillRunning:'))

    // The stop: a box, then what customInit changed is put back, exit code 2.
    const stop = bodyCode(lines, 'CccStopOnPendingRemoval')
    expect(stop.map(quiet)).toEqual([
      'Push $R0',
      '!insertmacro CccPendingRemovalIn "${DIR}" $R0',
      '${If} $R0 == 1',
      'MessageBox MB_OK|MB_ICONEXCLAMATION "Restart Windows before you install AI Code Conductor in this folder again.$\\n$\\nAn earlier uninstall set files in ${DIR} to be removed when Windows next restarts, and that would remove the new ones too." /SD IDOK',
      '!if ${DETAILS} == 1',
      'DetailPrint "..."',
      '!endif',
      'Call CccRestoreInstallLocation',
      'SetErrorLevel 2',
      'Quit',
      '${EndIf}',
      '!if ${DETAILS} == 1',
      '${If} $R0 == 2',
      'DetailPrint "..."',
      '${EndIf}',
      '!endif',
      'Pop $R0',
    ])

    // The read: Windows' own list, through advapi32, read-only, the key closed again.
    const read = bodyCode(lines, 'CccPendingRemovalIn')
    const calls = read.filter((c) => /^System::(Call|Alloc|Free)\b/.test(c))
    expect(calls).toEqual([
      'System::Call \'advapi32::RegOpenKeyExW(p 0x80000002, w "SYSTEM\\CurrentControlSet\\Control\\Session Manager", i 0, i 0x20119, *p .r1) i .r2\'',
      'System::Call \'advapi32::RegQueryValueExW(p r1, w "PendingFileRenameOperations", p 0, *i .r6, p 0, *i r3 r3) i .r2\'',
      'System::Alloc $8',
      'System::Call \'advapi32::RegQueryValueExW(p r1, w "PendingFileRenameOperations", p 0, *i .r6, p r4, *i r3 r3) i .r2\'',
      'System::Call \'kernel32::lstrlenW(p r9) i .r6\'',
      'System::Call \'kernel32::lstrcpynW(w .r7, p r9, i ${NSIS_MAX_STRLEN}) p\'',
      'System::Free $4',
      'System::Call \'advapi32::RegCloseKey(p r1)\'',
    ])
    // The buffer has two nulls past the size the read is given, so the walk ends inside it.
    const room = read.indexOf('IntOp $3 $3 + 4096')
    expect(read.slice(room, room + 3)).toEqual(['IntOp $3 $3 + 4096', 'IntOp $8 $3 + 4', 'System::Alloc $8'])
    // Only a REG_MULTI_SZ (7) is walked; an entry counts by IsSameOrInsideCanon, without what is in
    // front of its path: every leading "!" and every leading "*" with its digits, in either order
    // (Windows 11 was seen to write "*1\??\C:\..."), then one "\??\". The makensis probes in
    // installer-nsis-behaviour.test.ts run it over each form.
    expect(read.filter((c) => c === '${AndIf} $6 == 7')).toHaveLength(2)
    const copied = read.indexOf('System::Call \'kernel32::lstrcpynW(w .r7, p r9, i ${NSIS_MAX_STRLEN}) p\'')
    const compared = read.indexOf('!insertmacro IsSameOrInsideCanon "${DIR}" "$7" $9')
    expect(copied).toBeGreaterThan(-1)
    expect(read.slice(copied + 1, compared)).toEqual([
      '${Do}',
      'StrCpy $9 "$7" 1',
      '${If} $9 == "!"',
      'StrCpy $7 "$7" "" 1',
      '${ElseIf} $9 == "*"',
      'StrCpy $7 "$7" "" 1',
      '${Do}',
      'StrCpy $9 "$7" 1',
      'IntOp $8 $9 + 0',
      '${If} $8 != $9',
      '${ExitDo}',
      '${EndIf}',
      'StrCpy $7 "$7" "" 1',
      '${Loop}',
      '${Else}',
      '${ExitDo}',
      '${EndIf}',
      '${Loop}',
      'StrCpy $9 "$7" 4',
      '${If} $9 == "\\??\\"',
      'StrCpy $7 "$7" "" 4',
      '${EndIf}',
    ])
    // Every register comes back; the answer leaves through the stack.
    const saved = ['$0', '$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', '$R5', '$R6', '$R7']
    expect(read.slice(0, saved.length)).toEqual(saved.map((r) => `Push ${r}`))
    expect(read.slice(-(saved.length + 1))).toEqual([...saved.slice(1)].reverse().map((r) => `Pop ${r}`).concat(['Exch $0', 'Pop ${OUT}']))
    // No key is written: the only registry calls are the open, the two reads and the close.
    expect(read.filter((c) => /RegSet|RegDelete|RegCreate|WriteReg|DeleteReg/i.test(c))).toEqual([])
  })
})
