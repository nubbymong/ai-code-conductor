// HOST QUARANTINE: plants junctions; writes a probe registry key; starts real processes. [CI] [VM] only -- never run on the owner's machine.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { originalHomeEnv } from '../../helpers/home-guard-core.mjs'
import { makensisIn, nsisCacheFolders, nsisCachePresent } from '../../helpers/nsis-cache'

/**
 * BEHAVIOURAL tests for the destructive half of build/installer.nsh.
 *
 * The sibling brand-identity-guard.test.ts asserts that the guards are PRESENT.
 * Presence is not enough and was measured not to be: every deletion mutant went
 * red, and every POLARITY mutant stayed green — including `${If} $R8 == 1`
 * rewritten to `${If} "1" == "1"` immediately before `RMDir /r`, which compiled,
 * ran, and destroyed a junction target, a source checkout and the user's
 * CONFIG/settings.json with the suite still green.
 *
 * So this compiles the REAL macros out of build/installer.nsh with the REAL
 * makensis, runs them over a real fixture tree (junction, source checkout, data
 * directory, a directory named like an uninstaller, a triple-nested legacy
 * chain) and asserts which paths survive and which do not. A flipped guard
 * changes what is on disk afterwards, which is the only thing that can catch it.
 *
 * Sandboxing, because this executes RMDir /r and writes to the registry for
 * real:
 *   - every path lives under a mkdtemp directory that is removed afterwards;
 *   - `Software\<brand>` reads/writes are rewritten to `Software\CccProbe\…`
 *     and that key is deleted afterwards;
 *   - `$DESKTOP` / `$SMPROGRAMS` are rewritten to a fixture directory so the
 *     shortcut deletion cannot reach the real user's Desktop or Start Menu.
 *
 * Skips (does not fail) when makensis is unavailable, so non-Windows CI is
 * unaffected — with a tripwire below that fails if it skips on a machine that
 * plainly does have it.
 */

const NSH = join(__dirname, '../../../build/installer.nsh')

/** Macros lifted verbatim out of build/installer.nsh into the probe script. */
const PROBE_MACROS = [
  'IsLegacyBrandFolder',
  'IsChainFolder',
  'IsSameOrInside',
  'PathsOverlap',
  'CanonPathPair',
  'PathsOverlapCanon',
  'FindLegacyRoot',
  'ReadUserPath',
  'CccGetInQuotes',
  'RemoveLegacyInstall',
  'ProveLegacyInstallRoot',
  'ClassifyUninstallRecord',
  'ForgetPreviousInstallIn',
  'ForgetBrokenPreviousInstall',
  'SuspendUninstallRecordIn',
  'CaptureRecordedUninstaller',
  'RetargetRecordedInstallLocation',
  'customHeader',
  'customInit',
  'customInstall',
  'AdoptLegacyValue',
  // The app-running check (aicc_planning #319), run by the 'apps' probe below.
  'CccProcessIsMine',
  'CccProcessStart',
  'CccInList',
  'CccNextPair',
  'CccScanAppCopies',
  'CccCloseAppCopies',
  'customCheckAppRunning',
]

/**
 * The app's image names as the probes see them: stand-ins, so a probe can
 * never ask a real copy of the app to close or end one, even on a machine
 * where the app runs. ${APP_EXECUTABLE_FILENAME} is defined as the first; the
 * two names the app had before its rename are rewritten to the others.
 */
const PROBE_APP_EXE = 'ccc-probe-app.exe'
const PROBE_LEGACY_EXES: Record<string, string> = {
  'Claude Command Center.exe': 'ccc-probe-legacy-1.exe',
  'Claude Conductor.exe': 'ccc-probe-legacy-2.exe',
}

/**
 * Lift the named macros verbatim out of build/installer.nsh, and with them
 * every macro of that file they insert, to any depth (a helper such as
 * CccWhyNotEnded), so a probe always compiles what the named ones insert.
 */
function liftMacros(names: string[]): string {
  const src = readFileSync(NSH, 'utf-8')
  const body = (name: string) => {
    const m = src.match(new RegExp(`^!macro ${name}\\b[\\s\\S]*?^!macroend`, 'm'))
    if (!m) throw new Error(`macro ${name} not found in build/installer.nsh`)
    return m[0]
  }
  const all = [...names]
  for (let i = 0; i < all.length; i++) {
    for (const ref of body(all[i]).matchAll(/^[ \t]*!insertmacro\s+"?(\w+)/gm)) {
      if (!all.includes(ref[1]) && new RegExp(`^!macro ${ref[1]}\\b`, 'm').test(src)) all.push(ref[1])
    }
  }
  return all.map(body).join('\n\n')
}

/**
 * CccCloseAppCopies's one "is this run silent?" gate. The probes are silent
 * (so the box answers itself), and a case that needs a run someone can see
 * sets `seen=1` in the probe's ini, which this gate then reads instead.
 */
const SEEN_GATE = '${IfNot} ${Silent}'

/**
 * The app check's sandbox: the old image names become stand-ins, and with
 * `details` every DetailPrint is logged too (CccProbeDetail), so a case can
 * read the details list. Fails closed on any real image name left, and on a
 * gate that is not there exactly once.
 */
function sandboxAppCheck(text: string, details: boolean): string {
  let out = text.replace(/"(Claude Command Center|Claude Conductor)\.exe"/g, (_m, name: string) => `"${PROBE_LEGACY_EXES[`${name}.exe`]}"`)
  if (details) out = out.replace(/^(\s*)DetailPrint\b/gm, '$1!insertmacro CccProbeDetail')
  const real = out.match(/(AI Code Conductor|Claude Command Center|Claude Conductor)\.exe"/)
  if (real) throw new Error(`the probe would reach a real copy of the app: ${real[0]}`)
  if (/^!macro CccCloseAppCopies\b/m.test(out)) {
    const gates = out.split(SEEN_GATE).length - 1
    if (gates !== 1) throw new Error(`expected CccCloseAppCopies's ${SEEN_GATE} gate once, found ${gates}`)
    out = out.replace(SEEN_GATE, () => '${If} $cccProbeSeen == "1"')
  }
  return out
}

const PROBE_REG_KEY = 'HKCU\\Software\\CccProbe'

// electron-builder's cache folder in the LOCALAPPDATA the test home guard found: the guard
// (tests/helpers/home-isolation.ts) points the variable at an isolated folder, and the
// cache is in the original one. Read only, to locate the compiler; nothing is written there.
function electronBuilderCache(): string | null {
  const local = originalHomeEnv().LOCALAPPDATA ?? process.env.LOCALAPPDATA
  return local ? join(local, 'electron-builder', 'Cache') : null
}

function findMakensis(): string | null {
  if (process.platform !== 'win32') return null
  if (process.env.MAKENSIS && existsSync(process.env.MAKENSIS)) return process.env.MAKENSIS
  const cache = electronBuilderCache()
  // Both cache layouts electron-builder has used, newest first (tests/helpers/nsis-cache.ts).
  const cached = cache ? makensisIn(nsisCacheFolders(cache)) : null
  if (cached) return cached
  for (const p of [
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ]) {
    if (existsSync(p)) return p
  }
  return null
}

const MAKENSIS = findMakensis()

describe('installer.nsh behavioural probe — availability', () => {
  it('finds makensis wherever electron-builder cached it', () => {
    // The whole point of this file is that it RUNS. If the locator quietly
    // stops finding a compiler that is obviously present, everything below
    // turns into a green no-op and the guards go back to being untested.
    // NSIS cached in ANY layout (electron-builder 26 moved it from Cache\nsis\nsis-<v>\ to
    // Cache\nsis-<v>\nsis-<v>-<random>\, and the old locator then skipped all 13 cases):
    // the compiler must have been found.
    const cache = electronBuilderCache()
    const cachePresent = process.platform === 'win32' && cache !== null && nsisCachePresent(cache)
    if (cachePresent) expect(MAKENSIS, `electron-builder caches NSIS under ${cache}, but no makensis.exe was found there`).not.toBeNull()
    else expect(true).toBe(true) // nothing to find; the suite below skips
  })

  it('on a Windows CI runner the compiler is always there, so the probes below never skip in CI', () => {
    // [CI] The Windows test parts fetch electron-builder's own NSIS compiler
    // and set MAKENSIS (scripts/ci/fetch-makensis.mjs, ci.yml). Before that,
    // CI had no compiler and skipped every probe below while staying green.
    if (process.platform === 'win32' && process.env.CI) {
      expect(process.env.MAKENSIS, 'the CI job sets MAKENSIS (scripts/ci/fetch-makensis.mjs)').toBeTruthy()
      expect(MAKENSIS, `MAKENSIS=${process.env.MAKENSIS} is not a file`).toBe(process.env.MAKENSIS)
    } else {
      expect(true).toBe(true) // not a Windows CI runner
    }
  })

  it('looks in the LOCALAPPDATA the test home guard found, not the isolated one it points the variable at', () => {
    // [host][CI] The guard (tests/helpers/home-isolation.ts) points LOCALAPPDATA at an
    // isolated folder that never holds electron-builder's cache. A locator reading the
    // variable skipped everything below, and the check above skipped with it.
    const local = originalHomeEnv().LOCALAPPDATA ?? process.env.LOCALAPPDATA
    expect(electronBuilderCache()).toBe(local ? join(local, 'electron-builder', 'Cache') : null)
  })
})

/** One probe run's inputs. Everything is read at RUNTIME from an ini file, so
 *  the two probe executables are compiled once and re-used by every scenario. */
interface ProbeConfig {
  instdir: string
  parent: string
  data: string
  res: string
  legacyUninstaller: string
  linkRoot: string
  dparam: string
  installMode: string
  inner: boolean
  repage: boolean
  shortenInstdir: boolean
  abort: boolean
  seedFromRegistry: boolean
}

function extractMacros(details = false): string {
  const text = liftMacros(PROBE_MACROS)
    // Sandbox the app's own registry keys — the probe must never touch the real ones.
    .replace(/Software\\(AI Code Conductor|Claude Command Center|Claude Conductor)/g,
      'Software\\CccProbe\\$1')
    // ...and never the real user's shortcuts.
    .replace(/\$DESKTOP/g, '$cccProbeLinkRoot')
    .replace(/\$SMPROGRAMS/g, '$cccProbeLinkRoot')
  // ...and never a real copy of the app.
  return sandboxAppCheck(text, details)
}

function probeScript(mode: 'sweep' | 'e2e' | 'apps', out: string, cfg: string, log: string): string {
  const readCfg = (v: string, key: string) => `  ReadINIStr ${v} "${cfg}" "probe" "${key}"`

  const body = mode === 'apps'
    ? `
  ; installSection.nsh: CHECK_APP_RUNNING, in the installer pass, with $INSTDIR
  ; and customInit's capture of a recorded uninstaller as customInit leaves
  ; them. The replaced install's record is the case's, in the probe key, and
  ; so is the install location customInit saved for a Cancel to put back.
  StrCpy $INSTDIR $cccProbeInstDir
  StrCpy $cccLegacyUninstaller $cccProbeLegacyUninst
  StrCpy $cccSavedPerUserInstallLocation $cccProbeSavedLoc
  !insertmacro customCheckAppRunning
  FileWrite $cccProbeLog "passed=1$\\r$\\n"
`
    : mode === 'sweep'
    ? `
  StrCpy $INSTDIR $cccProbeInstDir
  \${If} $cccProbeShorten == "1"
    GetFullPathName /SHORT $R0 "$INSTDIR"
    \${If} $R0 != ""
      StrCpy $INSTDIR "$R0"
    \${EndIf}
    ClearErrors
  \${EndIf}
  FileWrite $cccProbeLog "instdir=$INSTDIR$\\r$\\n"
  StrCpy $R3 $cccProbeData
  StrCpy $R4 $cccProbeRes
  StrCpy $cccLegacyUninstaller $cccProbeLegacyUninst
  StrCpy $R2 $cccProbeParent
  !insertmacro RemoveLegacyInstall "$R2\\Claude Conductor Beta" "Claude Conductor Beta"
  !insertmacro RemoveLegacyInstall "$R2\\Claude Command Center Beta" "Claude Command Center Beta"
  !insertmacro RemoveLegacyInstall "$R2\\Claude Command Center" "Claude Command Center"
  !insertmacro RemoveLegacyInstall "$R2\\Claude Conductor" "Claude Conductor"
`
    : `
  ; initMultiUser: $INSTDIR is seeded from the recorded install location.
  StrCpy $INSTDIR $cccProbeInstDir
  \${If} $cccProbeSeedReg == "1"
    ReadRegStr $0 HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
    \${If} $0 != ""
      StrCpy $INSTDIR "$0"
    \${EndIf}
  \${EndIf}
  FileWrite $cccProbeLog "seed=$INSTDIR$\\r$\\n"

  !insertmacro customInit
  ReadRegStr $9 HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
  FileWrite $cccProbeLog "afterInit=$INSTDIR$\\r$\\n"
  FileWrite $cccProbeLog "installLocationAfterInit=$9$\\r$\\n"
  FileWrite $cccProbeLog "captured=$cccLegacyUninstaller$\\r$\\n"

  ; Interactive run: the install-mode page's Leave callback re-runs
  ; setInstallModePerUser, which re-seeds $INSTDIR from the same value.
  \${If} $cccProbeRepage == "1"
    ReadRegStr $0 HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
    \${If} $0 != ""
      StrCpy $INSTDIR "$0"
    \${EndIf}
  \${EndIf}
  FileWrite $cccProbeLog "afterPage=$INSTDIR$\\r$\\n"

  \${If} $cccProbeAbort == "1"
    ; The wizard is cancelled after customInit — MUI's abort callback.
    Call CccRestoreInstallLocation
    ReadRegStr $7 HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ReadRegStr $8 HKCU "\${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    FileWrite $cccProbeLog "restoredInstallLocation=$7$\\r$\\n"
    FileWrite $cccProbeLog "restoredUninstallString=$8$\\r$\\n"
    Goto cccProbeFinished

  \${EndIf}

  ; installSection.nsh: CHECK_APP_RUNNING, guarded by \${ifNot} \${UAC_IsInnerInstance}.
  \${If} $cccProbeInner != "1"
    !insertmacro ForgetBrokenPreviousInstall
  \${EndIf}

  ; installSection.nsh: uninstallOldVersion — where the OLD uninstaller is run,
  ; with _?=<installationDir> resolved exactly as installUtil.nsh:155-176 does.
  ReadRegStr $1 HKCU "\${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCpy $2 ""
  \${If} $1 != ""
    !insertmacro CccGetInQuotes "$1" $3
    ReadRegStr $2 HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
    \${If} $2 == ""
      \${GetParent} "$3" $2
    \${EndIf}
  \${EndIf}
  FileWrite $cccProbeLog "oldUninstallString=$1$\\r$\\n"
  FileWrite $cccProbeLog "oldUninstallTarget=$2$\\r$\\n"

  ; installApplicationFiles + registryAddInstallInfo.
  CreateDirectory "$INSTDIR"
  FileOpen $4 "$INSTDIR\\AI Code Conductor.exe" w
  FileWrite $4 "new"
  FileClose $4
  FileOpen $4 "$INSTDIR\\Uninstall AI Code Conductor.exe" w
  FileWrite $4 "new"
  FileClose $4
  WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "\${UNINSTALL_REGISTRY_KEY}" "UninstallString" '"$INSTDIR\\Uninstall AI Code Conductor.exe" /currentuser'

  !insertmacro customInstall

  ReadRegStr $5 HKCU "\${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ReadRegStr $6 HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
  FileWrite $cccProbeLog "arpUninstallString=$5$\\r$\\n"
  FileWrite $cccProbeLog "arpInstallLocation=$6$\\r$\\n"
  FileWrite $cccProbeLog "final=$INSTDIR$\\r$\\n"
  cccProbeFinished:
`

  return `Unicode true
SetCompress off
RequestExecutionLevel user
SilentInstall silent
Name "CccInstallerProbe"
OutFile "${out}"
InstallDir "$TEMP\\ccc-nsis-probe-unused"

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define APP_FILENAME "AI Code Conductor"
!define APP_EXECUTABLE_FILENAME "${PROBE_APP_EXE}"
!define INSTALL_REGISTRY_KEY "Software\\CccProbe\\Install"
!define UNINSTALL_REGISTRY_KEY "Software\\CccProbe\\Uninstall"

Var installMode
Var cccProbeLog
Var cccProbeInner
Var cccProbeRepage
Var cccProbeShorten
Var cccProbeAbort
Var cccProbeSeedReg
Var cccProbeInstDir
Var cccProbeParent
Var cccProbeData
Var cccProbeRes
Var cccProbeLegacyUninst
Var cccProbeLinkRoot
Var cccProbeD
Var cccProbeSeen
Var cccProbeSavedLoc

; multiUser.nsh's UAC predicate, driven by the ini instead of a real elevation.
!define UAC_IsInnerInstance \`$cccProbeInner == "1"\`

; multiUser.nsh's /D= reader, driven by the ini instead of StdUtils.
!macro GetDParameter outVar
  StrCpy \${outVar} $cccProbeD
!macroend

; In 'apps' mode, each DetailPrint of the macros under test: logged, then shown.
!macro CccProbeDetail TEXT
  FileWrite $cccProbeLog "detail=\${TEXT}$\\r$\\n"
  DetailPrint "\${TEXT}"
!macroend

${extractMacros(mode === 'apps')}

!insertmacro customHeader

Page instfiles

Section "probe"
  SetShellVarContext current
${readCfg('$cccProbeInstDir', 'instdir')}
${readCfg('$cccProbeParent', 'parent')}
${readCfg('$cccProbeData', 'data')}
${readCfg('$cccProbeRes', 'res')}
${readCfg('$cccProbeLegacyUninst', 'legacyUninstaller')}
${readCfg('$cccProbeLinkRoot', 'linkRoot')}
${readCfg('$cccProbeD', 'dparam')}
${readCfg('$cccProbeInner', 'inner')}
${readCfg('$cccProbeRepage', 'repage')}
${readCfg('$cccProbeShorten', 'shortenInstdir')}
${readCfg('$cccProbeAbort', 'abort')}
${readCfg('$cccProbeSeedReg', 'seedFromRegistry')}
${readCfg('$installMode', 'installMode')}
${readCfg('$cccProbeSeen', 'seen')}
${readCfg('$cccProbeSavedLoc', 'savedInstallLocation')}
  ClearErrors
  FileOpen $cccProbeLog "${log}" w
${body}
  FileWrite $cccProbeLog "done=1$\\r$\\n"
  FileClose $cccProbeLog
SectionEnd
`
}

// ---------------------------------------------------------------- harness ---

let work = ''
const sweepExe = () => join(work, 'probe-sweep.exe')
const e2eExe = () => join(work, 'probe-e2e.exe')
const cfgPath = () => join(work, 'probe.ini')
const logPath = () => join(work, 'probe.log')

function compile(mode: 'sweep' | 'e2e', out: string) {
  const nsi = join(work, `probe-${mode}.nsi`)
  writeFileSync(nsi, probeScript(mode, out, cfgPath(), logPath()))
  try {
    execFileSync(MAKENSIS as string, ['/V2', nsi], { encoding: 'utf-8', stdio: 'pipe' })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    throw new Error(`makensis failed for ${mode}:\n${err.stdout ?? ''}${err.stderr ?? ''}`)
  }
}

function run(mode: 'sweep' | 'e2e', cfg: Partial<ProbeConfig>): Record<string, string> {
  const merged: ProbeConfig = {
    instdir: '', parent: '', data: '', res: '', legacyUninstaller: '', linkRoot: '',
    dparam: '', installMode: 'CurrentUser', inner: false, repage: false,
    shortenInstdir: false, abort: false, seedFromRegistry: true, ...cfg,
  }
  writeFileSync(cfgPath(), [
    '[probe]',
    `instdir=${merged.instdir}`,
    `parent=${merged.parent}`,
    `data=${merged.data}`,
    `res=${merged.res}`,
    `legacyUninstaller=${merged.legacyUninstaller}`,
    `linkRoot=${merged.linkRoot}`,
    `dparam=${merged.dparam}`,
    `installMode=${merged.installMode}`,
    `inner=${merged.inner ? 1 : 0}`,
    `repage=${merged.repage ? 1 : 0}`,
    `shortenInstdir=${merged.shortenInstdir ? 1 : 0}`,
    `abort=${merged.abort ? 1 : 0}`,
    `seedFromRegistry=${merged.seedFromRegistry ? 1 : 0}`,
    '',
  ].join('\r\n'))
  rmSync(logPath(), { force: true })
  execFileSync(mode === 'sweep' ? sweepExe() : e2eExe(), [], { encoding: 'utf-8', stdio: 'pipe' })
  const out: Record<string, string> = {}
  for (const line of readFileSync(logPath(), 'utf-8').split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
  }
  if (out.done !== '1') throw new Error(`probe did not complete: ${JSON.stringify(out)}`)
  return out
}

const dir = (p: string) => mkdirSync(p, { recursive: true })
const file = (p: string, c = 'x') => { dir(dirname(p)); writeFileSync(p, c) }
const junction = (link: string, target: string) =>
  execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' })

function regClear() {
  try { execFileSync('reg', ['delete', PROBE_REG_KEY, '/f'], { stdio: 'pipe' }) } catch { /* absent */ }
}
function regSet(sub: string, name: string, value: string) {
  execFileSync('reg',
    ['add', `${PROBE_REG_KEY}\\${sub}`, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
    { stdio: 'pipe' })
}

/** A fresh fixture root per scenario; RMDir /r makes them single-use. */
function scenario(name: string) {
  const root = join(work, name)
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  const links = join(root, 'links')
  dir(links)
  return { root, programs: join(root, 'Programs'), links }
}

/** The triple-nested shape this whole change exists to clean up. */
function nestedChain(programs: string) {
  return join(programs, 'Claude Conductor Beta', 'Claude Command Center Beta', 'AI Code Conductor')
}

describe.skipIf(!MAKENSIS)('installer.nsh behavioural probe', () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'ccc-nsis-probe-'))
    regClear()
    compile('sweep', sweepExe())
    compile('e2e', e2eExe())
  }, 120_000)

  afterAll(() => {
    regClear()
    if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5 })
  })

  it('sweeps the nested legacy tree and nothing else', () => {
    const { root, programs, links } = scenario('guards')
    dir(join(programs, 'AI Code Conductor'))

    // (a) the owner's real shape: the uninstaller exists ONLY at the leaf.
    const leaf = nestedChain(programs)
    dir(leaf)
    file(join(leaf, 'Uninstall AI Code Conductor.exe'))

    // (b) a junction whose target holds a perfectly good uninstaller.
    dir(join(root, 'junction-target'))
    file(join(root, 'junction-target', 'keep.txt'))
    file(join(root, 'junction-target', 'Uninstall AI Code Conductor.exe'))
    junction(join(programs, 'Claude Command Center'), join(root, 'junction-target'))

    // (c) a source checkout, with a DIRECTORY named like an uninstaller.
    file(join(programs, 'Claude Conductor', 'src', 'index.ts'))
    dir(join(programs, 'Claude Conductor', 'Uninstall trick.exe'))

    // (d) the user's data directory, which is also a legacy-named sibling AND
    //     contains a real uninstaller, so only the overlap check saves it.
    const data = join(programs, 'Claude Command Center Beta')
    file(join(data, 'CONFIG', 'settings.json'), '{}')
    file(join(data, 'Uninstall AI Code Conductor.exe'))

    file(join(links, 'Claude Conductor Beta.lnk'))
    file(join(links, 'Claude Conductor.lnk'))
    dir(join(root, 'res'))

    run('sweep', {
      instdir: join(programs, 'AI Code Conductor'),
      parent: programs,
      data,
      res: join(root, 'res'),
      linkRoot: links,
    })

    expect(existsSync(join(programs, 'Claude Conductor Beta'))).toBe(false)
    expect(existsSync(join(links, 'Claude Conductor Beta.lnk'))).toBe(false)
    // junction, and above all the tree it points at
    expect(existsSync(join(programs, 'Claude Command Center'))).toBe(true)
    expect(existsSync(join(root, 'junction-target', 'keep.txt'))).toBe(true)
    // source checkout — a directory called "Uninstall trick.exe" is not proof
    expect(existsSync(join(programs, 'Claude Conductor', 'src', 'index.ts'))).toBe(true)
    // user data
    expect(existsSync(join(data, 'CONFIG', 'settings.json'))).toBe(true)
    // and the install we just made
    expect(existsSync(join(programs, 'AI Code Conductor'))).toBe(true)
    expect(existsSync(join(links, 'Claude Conductor.lnk'))).toBe(true)
  }, 60_000)

  it('refuses a data directory recorded with forward slashes', () => {
    const { root, programs, links } = scenario('slash')
    dir(join(programs, 'AI Code Conductor'))
    const data = join(programs, 'Claude Command Center Beta')
    file(join(data, 'CONFIG', 'settings.json'), '{}')
    file(join(data, 'Uninstall AI Code Conductor.exe'))
    dir(join(root, 'res'))

    run('sweep', {
      instdir: join(programs, 'AI Code Conductor'),
      parent: programs,
      data: data.replace(/\\/g, '/'),
      res: join(root, 'res'),
      linkRoot: links,
    })

    expect(existsSync(join(data, 'CONFIG', 'settings.json'))).toBe(true)
  }, 60_000)

  it('refuses everything when the data/resources directories are unreadable', () => {
    // HKCU-only reads come back empty on an all-users install elevated by a
    // different admin. Empty must mean "cannot tell", not "no overlap".
    const { programs, links } = scenario('unknown-data')
    dir(join(programs, 'AI Code Conductor'))
    const data = join(programs, 'Claude Command Center Beta')
    file(join(data, 'CONFIG', 'settings.json'), '{}')
    file(join(data, 'Uninstall AI Code Conductor.exe'))
    const leaf = nestedChain(programs)
    dir(leaf)
    file(join(leaf, 'Uninstall AI Code Conductor.exe'))

    run('sweep', {
      instdir: join(programs, 'AI Code Conductor'),
      parent: programs,
      data: '',
      res: '',
      linkRoot: links,
    })

    expect(existsSync(join(data, 'CONFIG', 'settings.json'))).toBe(true)
    expect(existsSync(join(programs, 'Claude Conductor Beta'))).toBe(true)
  }, 60_000)

  it('never sweeps $INSTDIR, even spelled as an 8.3 short name', () => {
    const { root, programs, links } = scenario('shortname')
    const target = join(programs, 'Claude Conductor')
    file(join(target, 'Uninstall AI Code Conductor.exe'))
    file(join(target, 'app.asar'))
    dir(join(root, 'data'))
    dir(join(root, 'res'))

    const log = run('sweep', {
      instdir: target,
      parent: programs,
      data: join(root, 'data'),
      res: join(root, 'res'),
      linkRoot: links,
      shortenInstdir: true,
    })

    // Only meaningful where the volume actually generates 8.3 names.
    if (log.instdir.toLowerCase() !== target.toLowerCase()) {
      expect(log.instdir).toMatch(/~1/)
    }
    expect(existsSync(join(target, 'app.asar'))).toBe(true)
  }, 60_000)

  it('accepts the uninstaller the replaced install recorded as proof', () => {
    // No "Uninstall *.exe" anywhere in the tree — the only evidence is the path
    // the ARP record named, captured by customInit before it was rewritten.
    const { root, programs, links } = scenario('recorded')
    dir(join(programs, 'AI Code Conductor'))
    const leaf = nestedChain(programs)
    dir(leaf)
    file(join(leaf, 'unins000.exe'))
    file(join(programs, 'Claude Conductor', 'src', 'index.ts'))
    dir(join(root, 'data'))
    dir(join(root, 'res'))

    run('sweep', {
      instdir: join(programs, 'AI Code Conductor'),
      parent: programs,
      data: join(root, 'data'),
      res: join(root, 'res'),
      linkRoot: links,
      legacyUninstaller: join(leaf, 'unins000.exe'),
    })

    expect(existsSync(join(programs, 'Claude Conductor Beta'))).toBe(false)
    // ...and the record proves nothing about a folder it does not name.
    expect(existsSync(join(programs, 'Claude Conductor', 'src', 'index.ts'))).toBe(true)
  }, 60_000)

  /** The owner's real case, start to finish. */
  function upgradeFixture(name: string, uninstallerName = 'Uninstall AI Code Conductor.exe') {
    const s = scenario(name)
    const leaf = nestedChain(s.programs)
    dir(leaf)
    file(join(leaf, uninstallerName))
    file(join(leaf, 'app.asar'))
    file(join(s.root, 'data', 'CONFIG', 'settings.json'), '{}')
    dir(join(s.root, 'res'))

    regClear()
    regSet('Install', 'InstallLocation', leaf)
    regSet('Uninstall', 'UninstallString', `"${join(leaf, uninstallerName)}" /currentuser`)
    // Only the LEGACY brand key has them, so customInstall's AdoptLegacyValue is
    // what makes the data-directory guard usable at all.
    regSet('Claude Command Center', 'DataDirectory', join(s.root, 'data'))
    regSet('Claude Command Center', 'ResourcesDirectory', join(s.root, 'res'))
    return { ...s, leaf, uninstaller: join(leaf, uninstallerName), expected: join(s.programs, 'AI Code Conductor') }
  }

  for (const [label, opts] of [
    ['silently (/S)', { repage: false }],
    ['interactively', { repage: true }],
  ] as const) {
    it(`upgrades a triple-nested install ${label}`, () => {
      const f = upgradeFixture(`e2e-${opts.repage ? 'interactive' : 'silent'}`)
      const log = run('e2e', { instdir: f.expected, parent: f.programs, linkRoot: f.links, ...opts })
      regClear()

      // relocated out of the legacy tree, and the relocation SURVIVED the
      // install-mode page re-reading InstallLocation
      expect(log.afterInit).toBe(f.expected)
      expect(log.afterPage).toBe(f.expected)
      // the old uninstaller is never run
      expect(log.oldUninstallString).toBe('')
      expect(log.oldUninstallTarget).toBe('')
      // the old tree is GONE — the regression this change exists to fix
      expect(existsSync(join(f.programs, 'Claude Conductor Beta'))).toBe(false)
      // ...and the ARP record points at the new install
      expect(log.arpInstallLocation).toBe(f.expected)
      expect(log.arpUninstallString).toContain(f.expected)
      expect(existsSync(join(f.expected, 'AI Code Conductor.exe'))).toBe(true)
      // user data untouched
      expect(existsSync(join(f.root, 'data', 'CONFIG', 'settings.json'))).toBe(true)
    }, 60_000)
  }

  it('carries the recorded uninstaller across the commit point as proof', () => {
    // Nothing in the tree matches "Uninstall *.exe", so the ONLY thing that can
    // prove the folder is an install of this app is the path the ARP record
    // named — and by the time customInstall runs, the commit point has cleared
    // that record and registryAddInstallInfo has written a new one pointing at
    // $INSTDIR. customInit capturing it in .onInit is the whole mechanism.
    const f = upgradeFixture('e2e-recorded', 'unins000.exe')
    const log = run('e2e', { instdir: f.expected, parent: f.programs, linkRoot: f.links })
    regClear()

    expect(log.captured).toBe(f.uninstaller)
    expect(existsSync(join(f.programs, 'Claude Conductor Beta'))).toBe(false)
  }, 60_000)

  it('leaves an install location recorded OUTSIDE the legacy tree alone', () => {
    // appId is frozen, so a per-user and a per-machine install share the key
    // PATH but are two separate installations. Retargeting a record that does
    // not name the tree being replaced would point the OTHER installation's
    // uninstaller — and its own next upgrade — at this run's directory.
    const s = scenario('e2e-foreign-record')
    const leaf = nestedChain(s.programs)
    dir(leaf)
    file(join(leaf, 'Uninstall AI Code Conductor.exe'))
    const foreign = join(s.programs, 'Elsewhere', 'AI Code Conductor')
    file(join(foreign, 'Uninstall AI Code Conductor.exe'))
    file(join(s.root, 'data', 'CONFIG', 'settings.json'), '{}')
    dir(join(s.root, 'res'))

    regClear()
    regSet('Install', 'InstallLocation', foreign)
    regSet('Claude Command Center', 'DataDirectory', join(s.root, 'data'))
    regSet('Claude Command Center', 'ResourcesDirectory', join(s.root, 'res'))

    const log = run('e2e', {
      instdir: leaf, parent: s.programs, linkRoot: s.links, seedFromRegistry: false,
    })
    regClear()

    expect(log.afterInit).toBe(join(s.programs, 'AI Code Conductor'))
    expect(log.installLocationAfterInit).toBe(foreign)
  }, 60_000)

  it('never aims the old uninstaller at the new directory in the elevated inner instance', () => {
    // installSection.nsh:35-37 skips CHECK_APP_RUNNING for ${UAC_IsInnerInstance},
    // so the commit-point clear never runs there while customInit's retarget
    // does — which pointed uninstallOldVersion's _?= at the NEW directory and
    // had the old uninstaller RMDir /r it before installApplicationFiles.
    const f = upgradeFixture('e2e-inner')
    const log = run('e2e', {
      instdir: f.expected, parent: f.programs, linkRoot: f.links,
      inner: true, repage: true, installMode: 'all',
    })
    regClear()

    expect(log.afterPage).toBe(f.expected)
    expect(log.oldUninstallTarget).not.toBe(f.expected)
    expect(log.oldUninstallString).toBe('')
    expect(existsSync(join(f.programs, 'Claude Conductor Beta'))).toBe(false)
    expect(existsSync(join(f.root, 'data', 'CONFIG', 'settings.json'))).toBe(true)
  }, 60_000)

  it('puts the retargeted and suspended registry values back when the wizard is cancelled', () => {
    // customInit rewrites InstallLocation (and, in the elevated inner instance,
    // removes UninstallString) inside .onInit — long before the user commits.
    // Both are the uninstaller's only way home: a dangling InstallLocation makes
    // a later Add/Remove-Programs uninstall delete nothing and then drop the
    // entry, and a missing UninstallString removes the uninstall button.
    const f = upgradeFixture('e2e-abort')
    const log = run('e2e', {
      instdir: f.expected, parent: f.programs, linkRoot: f.links,
      inner: true, repage: true, installMode: 'all', abort: true,
    })
    regClear()

    expect(log.afterInit).toBe(f.expected) // the retarget did happen...
    expect(log.restoredInstallLocation).toBe(f.leaf) // ...and was undone
    expect(log.restoredUninstallString)
      .toBe(`"${join(f.leaf, 'Uninstall AI Code Conductor.exe')}" /currentuser`)
  }, 60_000)

  it('never relocates an explicit /D= directory', () => {
    const f = upgradeFixture('e2e-dparam-relocate')
    const log = run('e2e', {
      instdir: f.leaf, parent: f.programs, linkRoot: f.links,
      dparam: f.leaf, seedFromRegistry: false,
    })
    regClear()

    expect(log.afterInit).toBe(f.leaf)
  }, 60_000)

  it('never sweeps the siblings of an explicit /D= directory', () => {
    // initMultiUser applies /D= last, so $INSTDIR is the operator's directory
    // and its siblings are not this installer's business — the same reasoning
    // that already suppresses the relocation.
    const f = upgradeFixture('e2e-dparam-sweep')
    const custom = join(f.programs, 'Custom Location')
    dir(custom)
    const log = run('e2e', {
      instdir: custom, parent: f.programs, linkRoot: f.links,
      dparam: custom, seedFromRegistry: false,
    })
    regClear()

    expect(log.afterInit).toBe(custom)
    expect(existsSync(join(f.programs, 'Claude Conductor Beta'))).toBe(true)
  }, 60_000)
})

// ------------------------------------------ uninstall: the helper folder ---

/**
 * The uninstaller's clean-up of the per-user session helper folder
 * (RemoveUserHelperFolder, inserted by customUnInstall). It deletes near the
 * user's data: the Data folder page proposes the same parent folder. So the
 * real macros run over a real tree, with real junctions and real running
 * stand-ins for a holder and what it starts.
 *
 * A probe of its own, so the cases above still compile against an
 * installer.nsh without these macros. It compiles as the uninstaller pass
 * does: BUILD_UNINSTALLER defined, the real customHeader lifted for the
 * variables both passes declare, and /WX, so a variable or label the
 * uninstaller pass would warn about fails here too. Sandboxed like the cases
 * above: the local app data folder, the profile folder and the registry keys
 * are rewritten to fixture paths and the probe key, and the helper's name
 * is the stand-in's everywhere (the force-end by name, the delete by
 * name), so a real holder on the machine is never touched. Every DetailPrint
 * is logged as well, so a case can read the details list. One shown by the
 * user's first copy of an all-users uninstall is logged apart: that copy has
 * no window, so nobody sees it.
 */
const UNINSTALL_PROBE_MACROS = [
  'customHeader',
  'IsSameOrInside',
  'CanonPathPair',
  'IsSameOrInsideCanon',
  'ReadUserPath',
  'CccCharIn',
  'CccIsHex12',
  'IsHelperVersionFolder',
  'IsHelperOwnFolder',
  'HoldsUserFolder',
  'CccHelperNote',
  'CccPrintHelperNotes',
  'CccProcessIsMine',
  'CccProcessStart',
  'CccInList',
  'CccScanProcesses',
  'CccEndListed',
  'CccEndUserHelpers',
  'CccRemoveHelperOwnFolder',
  'RemoveUserHelperFolderHere',
  'RemoveUserHelperFolder',
  'customUnInstall',
]

/** What the probe's taskkill ends in place of aicc-helper.exe. */
const PROBE_HELPER_EXE = 'ccc-probe-helper.exe'
/** A child a stand-in starts from its conpty folder, under the name a holder's child has there. */
const PROBE_CHILD_EXE = 'OpenConsole.exe'

function extractUninstallMacros(): string {
  const src = readFileSync(NSH, 'utf-8')
  const text = UNINSTALL_PROBE_MACROS.map((name) => {
    const m = src.match(new RegExp(`^!macro ${name}\\b[\\s\\S]*?^!macroend`, 'm'))
    if (!m) throw new Error(`macro ${name} not found in build/installer.nsh`)
    return m[0]
  }).join('\n\n')
    .replace(/Software\\(AI Code Conductor|Claude Command Center|Claude Conductor)/g, 'Software\\CccProbe\\$1')
    .replace(/\$PROFILE/g, '$cccProbeProfile')
    .replace(/ReadEnvStr (\$\w+) LOCALAPPDATA/g, 'StrCpy $1 $cccProbeLocalAppData')
    .replace(/aicc-helper\.exe/gi, PROBE_HELPER_EXE)
    .replace(/^(\s*)DetailPrint\b/gm, '$1!insertmacro CccProbeDetail')
  // Fail closed: anything that could still reach the real folders, the real
  // helper or the real keys stops the probe before it is compiled.
  for (const [what, re] of [
    ['the real local app data folder', /LOCALAPPDATA|ReadEnvStr/],
    ['the real profile folder', /\$PROFILE/],
    ['the real helper', /aicc-helper/i],
    ['a real registry key', /Software\\(?!CccProbe\\)/],
    ['a detail line the probe cannot read', /\bDetailPrint\b/],
  ] as const) {
    if (re.test(text)) throw new Error(`the uninstall probe would reach ${what}: ${text.match(re)?.[0]}`)
  }
  if (!text.includes(PROBE_HELPER_EXE)) throw new Error('the uninstall probe has no force-end of the stand-in helper')
  return text
}

function uninstallProbeScript(out: string, cfg: string, log: string): string {
  const readCfg = (v: string, key: string) => `  ReadINIStr ${v} "${cfg}" "probe" "${key}"`
  return `Unicode true
SetCompress off
RequestExecutionLevel user
SilentInstall silent
Name "CccUninstallProbe"
OutFile "${out}"
InstallDir "$TEMP\\ccc-nsis-probe-unused"

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; The uninstaller pass: customHeader declares only what both passes use.
!define BUILD_UNINSTALLER

Var cccProbeLog
Var cccProbeUpdated
Var cccProbeAdmin
Var cccProbeInner
Var cccProbeOuterGone
Var cccProbeOuter
Var cccProbeLocalAppData
Var cccProbeProfile

; electron-builder's update flag (StdUtils) and UAC.nsh's two tests, driven by
; the ini instead of a real update or a real elevation.
!define isUpdated \`$cccProbeUpdated == "1"\`
!define UAC_IsAdmin \`$cccProbeAdmin == "1"\`
!define UAC_IsInnerInstance \`$cccProbeInner == "1"\`
!define UAC_SYNCREGISTERS 0x1

; UAC.nsh runs the label in the uninstaller's first copy, the one the user
; started, and copies the registers there and back (UAC_SYNCREGISTERS), but
; not the stack. Here: the same code, in this process, logged. While it runs,
; a detail line is logged as hidden: that copy has no window. A stack the
; label leaves changed is logged too. With outerGone the first copy is gone
; and the call does nothing.
!macro UAC_AsUser_Call TYPE NAME FLAGS
  !if "\${TYPE}" != "Label"
    !error "the probe's UAC_AsUser_Call takes a Label"
  !endif
  FileWrite $cccProbeLog "asuser=1$\\r$\\n"
  \${If} $cccProbeOuterGone != "1"
    Push "ccc-probe-stack"
    StrCpy $cccProbeOuter 1
    Call :\${NAME}
    StrCpy $cccProbeOuter 0
    Exch $0
    \${If} $0 != "ccc-probe-stack"
      FileWrite $cccProbeLog "stack=bad$\\r$\\n"
    \${EndIf}
    Pop $0
  \${EndIf}
!macroend

; Each DetailPrint of the macros under test: logged, then shown.
!macro CccProbeDetail TEXT
  \${If} $cccProbeOuter == "1"
    FileWrite $cccProbeLog "hidden-detail=\${TEXT}$\\r$\\n"
  \${Else}
    FileWrite $cccProbeLog "detail=\${TEXT}$\\r$\\n"
  \${EndIf}
  DetailPrint "\${TEXT}"
!macroend

${extractUninstallMacros()}

!insertmacro customHeader

Page instfiles

Section "probe"
  SetShellVarContext current
${readCfg('$cccProbeLocalAppData', 'localAppData')}
${readCfg('$cccProbeProfile', 'profile')}
${readCfg('$cccProbeUpdated', 'updated')}
${readCfg('$cccProbeAdmin', 'admin')}
${readCfg('$cccProbeInner', 'inner')}
${readCfg('$cccProbeOuterGone', 'outerGone')}
  StrCpy $cccProbeOuter 0
  ClearErrors
  FileOpen $cccProbeLog "${log}" w
  !insertmacro customUnInstall
  FileWrite $cccProbeLog "done=1$\\r$\\n"
  FileClose $cccProbeLog
SectionEnd
`
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function waitGone(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!isAlive(pid)) return true
    await pause(100)
  }
  return !isAlive(pid)
}
async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await pause(100)
  }
  return check()
}

/**
 * The idle script a stand-in runs; with a child exe and a pid file, it first
 * starts that child. Detached: Node otherwise puts a child in a job that ends
 * it with its parent (measured on the VM: the no-/T mutant stayed green).
 * Nothing promises that for a holder's OpenConsole.exe, and #317 records a
 * console process outliving a forced end, so the child here has to be able
 * to outlive a stand-in ended alone.
 */
const IDLE = 'setInterval(() => {}, 1000)'
const STARTS_CHILD = [
  "const { spawn } = require('child_process')",
  "const c = spawn(process.argv[1], ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true, env: { SystemRoot: process.env.SystemRoot } })",
  'c.unref()',
  "require('fs').writeFileSync(process.argv[2], String(c.pid))",
  IDLE,
].join('\n')

describe.skipIf(!MAKENSIS)('installer.nsh behavioural probe: uninstall removes the per-user helper folder', () => {
  let uwork = ''
  const uexe = () => join(uwork, 'probe-uninstall.exe')
  const ucfg = () => join(uwork, 'probe-uninstall.ini')
  const ulog = () => join(uwork, 'probe-uninstall.log')
  const started: number[] = []

  beforeAll(() => {
    uwork = mkdtempSync(join(tmpdir(), 'ccc-nsis-unprobe-'))
    regClear()
    const nsi = join(uwork, 'probe-uninstall.nsi')
    writeFileSync(nsi, uninstallProbeScript(uexe(), ucfg(), ulog()))
    try {
      // /WX as electron-builder compiles both passes.
      execFileSync(MAKENSIS as string, ['/V2', '/WX', nsi], { encoding: 'utf-8', stdio: 'pipe' })
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string }
      throw new Error(`makensis failed for the uninstall probe:\n${err.stdout ?? ''}${err.stderr ?? ''}`)
    }
  }, 120_000)

  afterAll(async () => {
    for (const pid of started) {
      if (isAlive(pid)) {
        try {
          process.kill(pid)
        } catch {
          // already gone
        }
        await waitGone(pid)
      }
    }
    regClear()
    if (uwork) rmSync(uwork, { recursive: true, force: true, maxRetries: 5 })
  }, 60_000)

  /** One uninstall over the tree. `data` and `res` are the folders recorded
   *  under the (sandboxed) brand key; left out, nothing is recorded. `inner`
   *  is the elevated copy of an all-users uninstall, with a user copy behind
   *  it; `outerGone`, that copy did not run the call. `admin` alone is an
   *  uninstall started elevated, with no user copy behind it. Returns the
   *  probe's log, the details list (`details`) and how long the uninstall
   *  took. A loop that never ends fails at 30 seconds instead of hanging the
   *  suite. */
  function runUninstall(cfg: { localAppData: string; profile: string; updated?: boolean; admin?: boolean; inner?: boolean; outerGone?: boolean; data?: string; res?: string }) {
    regClear()
    if (cfg.data !== undefined) regSet('AI Code Conductor', 'DataDirectory', cfg.data)
    if (cfg.res !== undefined) regSet('AI Code Conductor', 'ResourcesDirectory', cfg.res)
    writeFileSync(ucfg(), [
      '[probe]',
      `localAppData=${cfg.localAppData}`,
      `profile=${cfg.profile}`,
      `updated=${cfg.updated ? 1 : 0}`,
      `admin=${cfg.admin ? 1 : 0}`,
      `inner=${cfg.inner ? 1 : 0}`,
      `outerGone=${cfg.outerGone ? 1 : 0}`,
      '',
    ].join('\r\n'))
    rmSync(ulog(), { force: true })
    const t0 = Date.now()
    try {
      execFileSync(uexe(), [], { encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 })
    } finally {
      regClear()
    }
    const ms = Date.now() - t0
    const log = readFileSync(ulog(), 'utf-8')
    expect(log).toContain('done=1')
    // What the user can read: the details list of the copy with a window.
    // Nothing is shown in the windowless first copy, and the stack is as it was.
    expect(log, 'a detail line was shown where nobody sees it').not.toContain('hidden-detail=')
    expect(log, 'the user copy\'s call left the stack changed').not.toContain('stack=bad')
    const details = log.split(/\r?\n/).filter((l) => l.startsWith('detail=')).map((l) => l.slice('detail='.length))
    return { log, ms, details }
  }

  /**
   * A running stand-in: a copy of this Node under `name`, idling in `folder`.
   * While it runs, its program file cannot be deleted, so that folder goes
   * only once it is ended. With `child`, it first starts a second copy from
   * that path, as a holder starts OpenConsole.exe from its conpty folder, and
   * the child's pid is returned too. Each gets an environment of its own,
   * never this one.
   */
  async function startStandIn(folder: string, name = PROBE_HELPER_EXE, child?: string): Promise<{ pid: number; childPid?: number }> {
    dir(folder)
    const exe = join(folder, name)
    copyFileSync(process.execPath, exe)
    let pidFile: string | undefined
    if (child) {
      dir(dirname(child))
      copyFileSync(process.execPath, child)
      pidFile = join(uwork, `child-${started.length}.pid`)
      rmSync(pidFile, { force: true })
    }
    const proc = spawn(exe, child ? ['-e', STARTS_CHILD, child, pidFile!] : ['-e', IDLE], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
    })
    proc.unref()
    expect(proc.pid, 'the stand-in started').toBeDefined()
    started.push(proc.pid!)
    let childPid: number | undefined
    if (pidFile) {
      expect(await waitFor(() => existsSync(pidFile!) && readFileSync(pidFile!, 'utf-8') !== ''), 'the stand-in started its child').toBe(true)
      childPid = Number(readFileSync(pidFile, 'utf-8'))
      started.push(childPid)
      expect(isAlive(childPid), 'the child is running before the uninstall').toBe(true)
    } else {
      await pause(500)
    }
    expect(isAlive(proc.pid!), 'the stand-in is running before the uninstall').toBe(true)
    return { pid: proc.pid!, childPid }
  }

  /**
   * The helper folder as the app and the helper leave it (install.ts,
   * manager.ts, helper/src/store.rs), with what is not the app's beside it.
   * The helper's program file has the stand-in's name, as everywhere in the probe.
   */
  function helperTree(name: string) {
    const root = join(uwork, name)
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    const lad = join(root, 'Local')
    const parent = join(lad, 'AI Code Conductor')
    const helper = join(parent, 'helper')
    const own = {
      version: join(helper, '0.1.0-abcdef123456'),
      tagged: join(helper, '2.1.3-beta.7-0123456789ab'),
      staging: join(helper, '.new-0123456789ab'),
      store: join(helper, 'store'),
      bindings: join(helper, 'bindings.json'),
      crashMark: join(helper, 'app-running.json'),
    }
    file(join(own.version, PROBE_HELPER_EXE))
    file(join(own.version, 'conpty', 'conpty.dll'))
    file(join(own.version, 'conpty', 'OpenConsole.exe'))
    // A ConPTY copy that stopped half way, inside the version folder.
    file(join(own.version, '.new-89abcdef0123', 'conpty.dll'))
    file(join(own.version, '.new-89abcdef0123', 'OpenConsole.exe'))
    file(join(own.tagged, PROBE_HELPER_EXE))
    file(join(own.staging, PROBE_HELPER_EXE))
    file(join(own.store, 'sess-0001.json'), '{}')
    file(join(own.store, 'sess-0002.json.4242.tmp'), '{}')
    file(join(own.store, '.lock'), '')
    file(own.bindings, '{"v":1,"bindings":{}}')
    file(own.crashMark, '{}')
    const keep = {
      // a folder the user made, and a development run's copies
      notes: join(helper, 'notes', 'keep.txt'),
      dev: join(helper, 'dev', '0.1.0-abcdef123456', 'aicc-helper.exe'),
      // the default Data folder is this same parent
      sessions: join(parent, 'sessions', 'keep.json'),
    }
    for (const p of Object.values(keep)) file(p)
    return { root, lad, parent, helper, own, keep }
  }

  /** The details list of a clean-up that ended one helper and removed `t`'s own folders. */
  function expectCleanupDetails(details: string[], t: ReturnType<typeof helperTree>) {
    expect(details[0]).toBe(`Session helper folder: ${t.helper}`)
    expect(details.filter((d) => /^Ended the running session helpers of .+\\.+\.$/.test(d)), details.join('\n')).toHaveLength(1)
    for (const n of ['0.1.0-abcdef123456', '2.1.3-beta.7-0123456789ab', '.new-0123456789ab', 'store']) expect(details).toContain(`Removed ${n}`)
    // A folder the user made is still in it.
    expect(details).toContain('Kept the session helper folder, because something in it is still in use or was not made by the app.')
  }

  it('ends the running helpers, then removes the copies, a half-made copy and the records, and nothing else', async () => {
    const t = helperTree('un-main')
    const { pid } = await startStandIn(t.own.version)
    const { log, details } = runUninstall({ localAppData: t.lad, profile: t.root })

    expect(await waitGone(pid), 'the running helper was ended').toBe(true)
    for (const [k, p] of Object.entries(t.own)) expect(existsSync(p), `${k} is removed`).toBe(false)
    for (const [k, p] of Object.entries(t.keep)) expect(existsSync(p), `${k} stays`).toBe(true)
    // Not empty, so neither goes.
    expect(existsSync(t.helper)).toBe(true)
    expect(existsSync(t.parent)).toBe(true)
    // A per-user uninstall runs the clean-up itself, and the details list says what it did.
    expect(log).not.toContain('asuser=1')
    expectCleanupDetails(details, t)
  }, 60_000)

  it('started already elevated, with no user copy behind it (Settings, Apps on an all-users install), ends this user\'s helpers and removes the copies in this copy', async () => {
    // electron-builder skips UAC_RunElevated when the uninstaller starts as
    // administrator, so no first copy waits to take UAC_AsUser_Call.
    const t = helperTree('un-admin')
    const { pid } = await startStandIn(t.own.version)
    const { log, details } = runUninstall({ localAppData: t.lad, profile: t.root, admin: true })

    expect(log).not.toContain('asuser=1')
    expect(await waitGone(pid), 'the running helper was ended').toBe(true)
    for (const [k, p] of Object.entries(t.own)) expect(existsSync(p), `${k} is removed`).toBe(false)
    for (const [k, p] of Object.entries(t.keep)) expect(existsSync(p), `${k} stays`).toBe(true)
    expectCleanupDetails(details, t)
  }, 60_000)

  it('ends what a running helper started too, so its conpty folder is not left locked', async () => {
    // A holder on the bundled ConPTY starts OpenConsole.exe from the copy's
    // conpty folder. Ending only the holder leaves that child running, its
    // program file locked, and the copy's folder behind for good.
    const t = helperTree('un-child')
    const child = join(t.own.version, 'conpty', PROBE_CHILD_EXE)
    const { pid, childPid } = await startStandIn(t.own.version, PROBE_HELPER_EXE, child)
    runUninstall({ localAppData: t.lad, profile: t.root })

    expect(await waitGone(pid), 'the running helper was ended').toBe(true)
    expect(await waitGone(childPid!), 'what it started was ended').toBe(true)
    expect(existsSync(t.own.version), 'its copy is removed').toBe(false)
    for (const [k, p] of Object.entries(t.own)) expect(existsSync(p), `${k} is removed`).toBe(false)
  }, 60_000)

  it('leaves a folder another program holds open, and still finishes, after about 3 seconds of tries', async () => {
    // A program that is not a holder's, running from a file the clean-up
    // deletes by name: that file cannot go, so its copy stays, the others
    // go, and the tries are bounded.
    const t = helperTree('un-locked')
    const { pid } = await startStandIn(join(t.own.tagged, 'conpty'), 'OpenConsole.exe')
    const { ms, details } = runUninstall({ localAppData: t.lad, profile: t.root })

    expect(isAlive(pid), 'the other program was not ended').toBe(true)
    expect(existsSync(join(t.own.tagged, 'conpty', 'OpenConsole.exe')), 'the file in use stays').toBe(true)
    for (const [k, p] of Object.entries(t.own).filter(([name]) => name !== 'tagged')) expect(existsSync(p), `${k} is removed`).toBe(false)
    for (const [k, p] of Object.entries(t.keep)) expect(existsSync(p), `${k} stays`).toBe(true)
    expect(ms, 'it tried again for a while').toBeGreaterThanOrEqual(2500)
    expect(ms, 'and then stopped').toBeLessThan(20_000)
    expect(details).toContain('Kept 2.1.3-beta.7-0123456789ab, because a file in it is still in use or was not made by the app.')
    // No holder ran, and the other program is not one.
    expect(details.some((d) => /^No session helper of .+ was running\.$/.test(d)), details.join('\n')).toBe(true)
    process.kill(pid)
    await waitGone(pid)
  }, 60_000)

  it('leaves every name that only looks like one of the helper folder\'s own', () => {
    const t = helperTree('un-lookalike')
    // Names are case-blind on Windows, so the upper-case ones must not match
    // one of the app's own folders above in any case: they would be that folder.
    const lookalikes = [
      '0.4.0-ABCDEF123456', // hex in upper case
      '0.1.0-abcdef12345', // 11 hex digits
      '0.1.0-abcdef1234567', // 13
      '0.1-abcdef123456', // two numbers
      '0.1.0.1-abcdef123456', // four
      '0..1.0-abcdef123456', // an empty number
      'v0.1.0-abcdef123456', // a letter in front
      '0.1.0--abcdef123456', // an empty tag
      '0.1.0-be_ta-abcdef123456', // a character a tag cannot have
      '.new-ABCDEF012345',
      '.new-0123456789a',
      'store.old',
      'stores',
    ]
    for (const n of lookalikes) file(join(t.helper, n, 'keep.txt'))
    // A FILE with a version folder's name is not a version folder, and only
    // the app's two files go by name.
    const files = ['0.3.0-abcdef123456', 'bindings.json.bak', 'notes.json']
    for (const n of files) file(join(t.helper, n))

    runUninstall({ localAppData: t.lad, profile: t.root })

    for (const n of lookalikes) expect(existsSync(join(t.helper, n, 'keep.txt')), n).toBe(true)
    for (const n of files) expect(existsSync(join(t.helper, n)), n).toBe(true)
    for (const [k, p] of Object.entries(t.own)) expect(existsSync(p), `${k} is removed`).toBe(false)
  }, 60_000)

  /** Only the app's own things in the helper folder, and nothing else in its parent. */
  function bareTree(name: string) {
    const root = join(uwork, name)
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    const lad = join(root, 'Local')
    const parent = join(lad, 'AI Code Conductor')
    const helper = join(parent, 'helper')
    file(join(helper, '0.1.0-abcdef123456', PROBE_HELPER_EXE))
    file(join(helper, 'store', 'x.json'), '{}')
    file(join(helper, 'bindings.json'), '{}')
    file(join(helper, 'app-running.json'), '{}')
    file(join(lad, 'Other App', 'keep.txt'))
    return { root, lad, parent, helper }
  }

  it('removes the helper folder and its parent once nothing else is in them', () => {
    const t = bareTree('un-empty')
    // The user's folders are elsewhere.
    const { details } = runUninstall({ localAppData: t.lad, profile: t.root, data: join(t.root, 'My Data'), res: join(t.root, 'My Resources') })

    expect(existsSync(t.parent)).toBe(false)
    // The local app data folder itself, and every other app's folder, stay.
    expect(existsSync(join(t.lad, 'Other App', 'keep.txt'))).toBe(true)
    expect(details.slice(-2)).toEqual(['Removed the session helper folder.', `Removed the empty folder ${t.parent}`])
  }, 60_000)

  it('with only the data folder recorded, elsewhere, takes the resources folder inside it, as the app does, and removes the empty parent', () => {
    // src/main/data-paths.ts: no resources folder recorded is <data>\resources.
    // Recorded with a trailing slash, so the join has to use the plain spelling.
    const t = bareTree('un-data-only')
    const data = join(t.root, 'My Data')
    file(join(data, 'resources', 'CONFIG', 'settings.json'), '{}')
    runUninstall({ localAppData: t.lad, profile: t.root, data: `${data}\\` })

    expect(existsSync(t.parent), 'nothing of the user\'s is in it, so it goes').toBe(false)
    expect(existsSync(join(data, 'resources', 'CONFIG', 'settings.json'))).toBe(true)
  }, 60_000)

  it('keeps the parent, even empty, when nothing is recorded: the app then uses it as the data folder', () => {
    const t = bareTree('un-default-data')
    runUninstall({ localAppData: t.lad, profile: t.root })

    expect(existsSync(t.helper)).toBe(false)
    expect(existsSync(t.parent)).toBe(true)
  }, 60_000)

  it('never removes the user\'s data or resources folder, or a folder of the helper\'s that holds one', () => {
    // Either folder page takes any path. Recorded in another spelling (forward
    // slashes, a trailing separator), so only the canonical compare matches.
    const a = helperTree('un-user-folder-inside')
    const data = join(a.own.store, 'My Data')
    const res = join(a.own.version, 'My Resources')
    file(join(data, 'sessions', 'keep.json'))
    file(join(res, 'CONFIG', 'settings.json'), '{}')
    runUninstall({ localAppData: a.lad, profile: a.root, data: `${data.replace(/\\/g, '/')}/`, res })

    expect(existsSync(join(data, 'sessions', 'keep.json')), 'the data folder').toBe(true)
    expect(existsSync(join(res, 'CONFIG', 'settings.json')), 'the resources folder').toBe(true)
    expect(existsSync(a.own.tagged)).toBe(false)
    expect(existsSync(a.own.staging)).toBe(false)

    // The helper folder itself recorded as the data folder: what is the
    // app's in it goes, and the folder stays, even once it is empty.
    const b = bareTree('un-user-folder-is-helper')
    runUninstall({ localAppData: b.lad, profile: b.root, data: `${b.helper}\\`, res: join(b.root, 'My Resources') })

    expect(existsSync(join(b.helper, 'store'))).toBe(false)
    expect(existsSync(join(b.helper, 'bindings.json'))).toBe(false)
    expect(existsSync(b.helper), 'the data folder stays').toBe(true)
  }, 60_000)

  for (const [label, flags] of [
    ['on an update', { updated: true }],
    ['on an update started as administrator', { updated: true, admin: true }],
    ['on an update, even in the elevated copy', { updated: true, admin: true, inner: true }],
  ] as const) {
    it(`keeps the whole tree, and running helpers, ${label}`, async () => {
      const t = helperTree(`un-keep-${Object.keys(flags).join('-')}`)
      const { pid } = await startStandIn(t.own.version)
      const { log, details } = runUninstall({ localAppData: t.lad, profile: t.root, ...flags })

      expect(isAlive(pid), 'the running helper was not ended').toBe(true)
      for (const [k, p] of Object.entries({ ...t.own, ...t.keep })) expect(existsSync(p), `${k} stays`).toBe(true)
      expect(log).not.toContain('asuser=1')
      expect(details).toEqual([])
      process.kill(pid)
      await waitGone(pid)
    }, 60_000)
  }

  it('in the elevated copy of an all-users uninstall, runs the clean-up as the user who started it, and shows what it did', async () => {
    // electron-builder's uninstaller starts itself again as administrator and
    // the user's first copy waits; the clean-up runs there. That copy has no
    // window, so its notes come back in a register and show here.
    const t = helperTree('un-elevated')
    const { pid } = await startStandIn(t.own.version)
    const { log, details } = runUninstall({ localAppData: t.lad, profile: t.root, admin: true, inner: true })

    expect(log).toContain('asuser=1')
    expect(await waitGone(pid), 'the running helper was ended').toBe(true)
    for (const [k, p] of Object.entries(t.own)) expect(existsSync(p), `${k} is removed`).toBe(false)
    for (const [k, p] of Object.entries(t.keep)) expect(existsSync(p), `${k} stays`).toBe(true)
    expectCleanupDetails(details, t)
  }, 60_000)

  it('runs the clean-up in the elevated copy when the user copy did not', async () => {
    const t = helperTree('un-elevated-outer-gone')
    const { pid } = await startStandIn(t.own.version)
    const { log, details } = runUninstall({ localAppData: t.lad, profile: t.root, admin: true, inner: true, outerGone: true })

    expect(log).toContain('asuser=1')
    expect(await waitGone(pid), 'the running helper was ended').toBe(true)
    for (const [k, p] of Object.entries(t.own)) expect(existsSync(p), `${k} is removed`).toBe(false)
    expectCleanupDetails(details, t)
  }, 60_000)

  it('never enters a link inside a helper copy or the store, and leaves what it points at', () => {
    // An elevated clean-up must not follow a link anywhere in the folder: in
    // a copy's conpty folder, a half-made ConPTY copy, or the store. Each
    // link points at files with the very names the clean-up deletes.
    const t = helperTree('un-link-inside')
    const outside = join(t.root, 'outside')
    const targets = ['conpty', 'newcopy', 'store']
    for (const n of targets) {
      for (const f of ['conpty.dll', 'OpenConsole.exe', PROBE_HELPER_EXE, 'sess-0009.json', '.lock']) file(join(outside, n, f))
    }
    rmSync(join(t.own.version, 'conpty'), { recursive: true, force: true })
    junction(join(t.own.version, 'conpty'), join(outside, 'conpty'))
    junction(join(t.own.tagged, '.new-89abcdef0123'), join(outside, 'newcopy'))
    junction(join(t.own.store, 'sub'), join(outside, 'store'))

    const { details } = runUninstall({ localAppData: t.lad, profile: t.root })

    for (const n of targets) {
      for (const f of ['conpty.dll', 'OpenConsole.exe', PROBE_HELPER_EXE, 'sess-0009.json', '.lock']) expect(existsSync(join(outside, n, f)), `${n}\\${f}`).toBe(true)
    }
    // Each folder with a link in it stays, with the link; what the app made around it goes.
    for (const k of ['version', 'tagged', 'store'] as const) expect(existsSync(t.own[k]), k).toBe(true)
    expect(existsSync(join(t.own.version, PROBE_HELPER_EXE))).toBe(false)
    expect(existsSync(join(t.own.version, '.new-89abcdef0123'))).toBe(false)
    expect(existsSync(join(t.own.store, 'sess-0001.json'))).toBe(false)
    expect(existsSync(t.own.staging)).toBe(false)
    for (const n of ['0.1.0-abcdef123456', '2.1.3-beta.7-0123456789ab', 'store']) expect(details).toContain(`Kept ${n}, because a file in it is still in use or was not made by the app.`)
  }, 60_000)

  it('keeps a file the app did not make, and the folders above it, and says so', () => {
    const t = helperTree('un-unknown')
    const unknown = [
      join(t.own.version, 'notes.txt'),
      join(t.own.version, 'conpty', 'notes.txt'),
      join(t.own.store, 'notes.txt'),
      join(t.own.store, 'sub', 'sess-0003.json'),
      // The helper's only temporary name is <session>.json.<digits>.tmp
      // (helper/src/store.rs, is_tmp_name), so these are not the app's.
      // Windows matches a wildcard against the short 8.3 name too, so a
      // "*.tmp" in the store also takes the last three (short names such as
      // NOTES~1.TMP), but only on a volume that makes short names: only
      // there do they fail against it. notes.tmp fails against it everywhere.
      join(t.own.store, 'notes.tmp'),
      join(t.own.store, 'notes.tmpx'),
      join(t.own.store, 'x.tmp1'),
      join(t.own.store, 'a.tmp_old'),
    ]
    for (const p of unknown) file(p)

    const { details } = runUninstall({ localAppData: t.lad, profile: t.root })

    for (const p of unknown) expect(existsSync(p), p).toBe(true)
    // What the app made goes, around them.
    for (const p of [join(t.own.version, PROBE_HELPER_EXE), join(t.own.version, 'conpty', 'OpenConsole.exe'), join(t.own.version, '.new-89abcdef0123'), join(t.own.store, 'sess-0001.json'), join(t.own.store, 'sess-0002.json.4242.tmp'), join(t.own.store, '.lock')]) {
      expect(existsSync(p), p).toBe(false)
    }
    expect(existsSync(t.own.tagged)).toBe(false)
    expect(existsSync(t.own.staging)).toBe(false)
    for (const n of ['0.1.0-abcdef123456', 'store']) expect(details).toContain(`Kept ${n}, because a file in it is still in use or was not made by the app.`)
    expect(details).toContain('Kept the session helper folder, because something in it is still in use or was not made by the app.')
  }, 60_000)

  it('says why it kept the helper folder when the only thing left is a copy still in use', async () => {
    // Nothing of the user's in it: only a copy another program holds open
    // keeps the folder, so the note must not say the user put something there.
    const t = bareTree('un-locked-only')
    const version = join(t.helper, '0.1.0-abcdef123456')
    const { pid } = await startStandIn(join(version, 'conpty'), 'OpenConsole.exe')
    const { details } = runUninstall({ localAppData: t.lad, profile: t.root, data: join(t.root, 'My Data'), res: join(t.root, 'My Resources') })

    expect(isAlive(pid), 'the other program was not ended').toBe(true)
    expect(existsSync(join(version, 'conpty', 'OpenConsole.exe')), 'the file in use stays').toBe(true)
    // Everything else the app made is gone, so the copy in use is the only reason.
    expect(existsSync(join(version, PROBE_HELPER_EXE))).toBe(false)
    expect(readdirSync(t.helper)).toEqual(['0.1.0-abcdef123456'])
    expect(readdirSync(version)).toEqual(['conpty'])
    expect(readdirSync(join(version, 'conpty'))).toEqual(['OpenConsole.exe'])
    expect(details).toContain('Kept 0.1.0-abcdef123456, because a file in it is still in use or was not made by the app.')
    expect(details).toContain('Kept the session helper folder, because something in it is still in use or was not made by the app.')
    expect(details.some((d) => /did not make is still in it/.test(d)), details.join('\n')).toBe(false)
    expect(existsSync(t.parent), 'the helper folder is still in it').toBe(true)
    process.kill(pid)
    await waitGone(pid)
  }, 60_000)

  it('never follows a version folder that is a link', () => {
    const t = helperTree('un-link-version')
    const outside = join(t.root, 'outside')
    file(join(outside, 'keep.txt'))
    junction(join(t.helper, '0.2.0-abcdef123456'), outside)

    runUninstall({ localAppData: t.lad, profile: t.root })

    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    // The real copies still go.
    for (const [k, p] of Object.entries(t.own)) expect(existsSync(p), `${k} is removed`).toBe(false)
  }, 60_000)

  for (const which of ['parent', 'helper'] as const) {
    it(`leaves everything alone when the ${which} folder is a link`, () => {
      const root = join(uwork, `un-link-${which}`)
      rmSync(root, { recursive: true, force: true, maxRetries: 5 })
      const lad = join(root, 'Local')
      const target = join(root, 'moved')
      // The folders behind the link, and the link itself.
      const behind = which === 'parent' ? join(target, 'helper') : target
      file(join(behind, '0.1.0-abcdef123456', 'aicc-helper.exe'))
      file(join(behind, 'store', 'x.json'), '{}')
      const link = which === 'parent' ? join(lad, 'AI Code Conductor') : join(lad, 'AI Code Conductor', 'helper')
      dir(dirname(link))
      junction(link, target)

      const { details } = runUninstall({ localAppData: lad, profile: root })

      expect(existsSync(link), 'the link stays').toBe(true)
      expect(existsSync(join(behind, '0.1.0-abcdef123456', 'aicc-helper.exe'))).toBe(true)
      expect(existsSync(join(behind, 'store', 'x.json'))).toBe(true)
      expect(details).toEqual([`Left the session helper folder as it is, because it or its parent is a link: ${join(lad, 'AI Code Conductor', 'helper')}`])
    }, 60_000)
  }
})

// ------------------------------------------- the app-running check (#319) ---

/**
 * customCheckAppRunning, which electron-builder inserts in both passes, run
 * for real against running stand-ins. It must ask only this user's copies of
 * the app from this install's folder to close, end only those that do not,
 * and leave everything else running: a same-named copy in another folder, the
 * session helper, an install that only another hive records, and, in the
 * uninstaller pass, which does not know it, the install this run replaces.
 * In a run someone can see, a copy that was asked to close and stays open
 * (the app asking whether to save its sessions) is not ended. A copy still
 * running at the end stops the run: the box answers Cancel, the installer
 * pass puts back the install location customInit saved, and the run exits
 * with code 2. Another user's copy, and this user's copy started as
 * administrator, cannot be made on a CI runner; those are the VM's (the
 * release smoke).
 *
 * Two probes. The installer pass is the 'apps' mode of the probe above, with
 * everything the hook inserts there (the commit point too), compiled as that
 * probe is. The uninstaller pass is its own, compiled as electron-builder
 * compiles that pass: BUILD_UNINSTALLER defined, the real customHeader lifted
 * for the variables both passes declare, and /WX, so a variable or label the
 * uninstaller pass would warn about fails here too. Both are silent, so the
 * boxes answer Cancel and a run that stops ends without "passed". A case that
 * needs a run someone can see sets `seen`, which CccCloseAppCopies's one
 * silent-run gate reads instead (SEEN_GATE). The app's image names are
 * stand-ins in both (PROBE_APP_EXE, PROBE_LEGACY_EXES), so a real copy of the
 * app is never reached.
 */
const APP_CHECK_UN_MACROS = [
  'customHeader',
  'CanonPathPair',
  'CccProcessIsMine',
  'CccProcessStart',
  'CccInList',
  'CccNextPair',
  'CccScanAppCopies',
  'CccCloseAppCopies',
  'customCheckAppRunning',
]

function appCheckUnProbeScript(out: string, cfg: string, log: string): string {
  return `Unicode true
SetCompress off
RequestExecutionLevel user
SilentInstall silent
Name "CccAppCheckProbe"
OutFile "${out}"
InstallDir "$TEMP\\ccc-nsis-probe-unused"

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; The uninstaller pass: customHeader declares only what both passes use.
!define BUILD_UNINSTALLER
!define APP_EXECUTABLE_FILENAME "${PROBE_APP_EXE}"

Var cccProbeLog
Var cccProbeInstDir
Var cccProbeSeen

!macro CccProbeDetail TEXT
  FileWrite $cccProbeLog "detail=\${TEXT}$\\r$\\n"
  DetailPrint "\${TEXT}"
!macroend

${sandboxAppCheck(liftMacros(APP_CHECK_UN_MACROS), true)}

!insertmacro customHeader

Page instfiles

Section "probe"
  ReadINIStr $cccProbeInstDir "${cfg}" "probe" "instdir"
  ReadINIStr $cccProbeSeen "${cfg}" "probe" "seen"
  ClearErrors
  FileOpen $cccProbeLog "${log}" w
  ; uninstaller.nsh: un.checkAppRunning, $INSTDIR the uninstaller's folder.
  StrCpy $INSTDIR $cccProbeInstDir
  !insertmacro customCheckAppRunning
  FileWrite $cccProbeLog "passed=1$\\r$\\n"
  FileWrite $cccProbeLog "done=1$\\r$\\n"
  FileClose $cccProbeLog
SectionEnd
`
}

/**
 * The stand-in for a running copy: one small NSIS program, copied under each
 * name a case needs. "<exe>-ready" says its window is up.
 * - /window: a wizard page that waits; a WM_CLOSE cancels it the way the
 *   window's close button does, which runs .onUserAbort, so "<exe>-closed"
 *   says it closed itself and was not ended.
 * - /window-stay: the same page, but a WM_CLOSE leaves it open, as the app's
 *   window stays open while it asks whether to save its sessions;
 *   "<exe>-asked" says one arrived.
 * - /window-respawn: on a WM_CLOSE it first starts a fresh copy of itself
 *   (/respawned, no window), which writes its pid to "<exe>-respawned", and
 *   then closes: a pid the check's first look never saw.
 * - /exit-soon: no window; it exits by itself about 3 seconds after it starts.
 * - anything else: no window at all; it idles for up to 5 minutes, so only
 *   TerminateProcess ends it sooner.
 */
function standInScript(out: string): string {
  return `Unicode true
SetCompress off
RequestExecutionLevel user
Name "CccAppCheckStandIn"
OutFile "${out}"
InstallDir "$TEMP\\ccc-probe-stand-in-unused"

!include "LogicLib.nsh"
!include "FileFunc.nsh"

Page directory
Page instfiles

Function .onInit
  \${GetParameters} $0
  \${If} $0 != "/window"
  \${AndIf} $0 != "/window-stay"
  \${AndIf} $0 != "/window-respawn"
    SetSilent silent
  \${EndIf}
  \${If} $0 == "/respawned"
    System::Call 'kernel32::GetCurrentProcessId() i .r1'
    FileOpen $2 "$EXEPATH-respawned" w
    FileWrite $2 "$1"
    FileClose $2
  \${EndIf}
FunctionEnd

Function .onGUIInit
  FileOpen $0 "$EXEPATH-ready" w
  FileClose $0
FunctionEnd

Function .onUserAbort
  \${GetParameters} $0
  \${If} $0 == "/window-stay"
    FileOpen $1 "$EXEPATH-asked" w
    FileClose $1
    Abort
  \${EndIf}
  \${If} $0 == "/window-respawn"
    Exec '"$EXEPATH" /respawned'
  \${EndIf}
  FileOpen $1 "$EXEPATH-closed" w
  FileClose $1
FunctionEnd

Section "stand-in"
  \${GetParameters} $0
  \${If} $0 == "/exit-soon"
    Sleep 3000
  \${Else}
    StrCpy $1 0
    \${Do}
      Sleep 1000
      IntOp $1 $1 + 1
    \${LoopUntil} $1 >= 300
  \${EndIf}
SectionEnd
`
}

/** One value under the probe key, or null when it is not there. */
function regGet(sub: string, name: string): string | null {
  try {
    const out = execFileSync('reg', ['query', `${PROBE_REG_KEY}\\${sub}`, '/v', name], { encoding: 'utf-8', stdio: 'pipe' })
    const m = out.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'm'))
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

describe.skipIf(!MAKENSIS)('installer.nsh behavioural probe: the app check closes only this user\'s copies from this install\'s folder', () => {
  let awork = ''
  const standIn = () => join(awork, 'stand-in.exe')
  const instProbe = () => join(awork, 'probe-apps-inst.exe')
  const unProbe = () => join(awork, 'probe-apps-un.exe')
  const acfg = () => join(awork, 'probe-apps.ini')
  const alog = () => join(awork, 'probe-apps.log')
  const started: number[] = []

  function compileTo(name: string, script: string, wx: boolean) {
    const nsi = join(awork, `${name}.nsi`)
    writeFileSync(nsi, script)
    try {
      execFileSync(MAKENSIS as string, wx ? ['/V2', '/WX', nsi] : ['/V2', nsi], { encoding: 'utf-8', stdio: 'pipe' })
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string }
      throw new Error(`makensis failed for ${name}:\n${err.stdout ?? ''}${err.stderr ?? ''}`)
    }
  }

  beforeAll(() => {
    awork = mkdtempSync(join(tmpdir(), 'ccc-nsis-appprobe-'))
    regClear()
    compileTo('stand-in', standInScript(standIn()), false)
    compileTo('probe-apps-inst', probeScript('apps', instProbe(), acfg(), alog()), false)
    // /WX, as electron-builder compiles the uninstaller pass.
    compileTo('probe-apps-un', appCheckUnProbeScript(unProbe(), acfg(), alog()), true)
  }, 120_000)

  afterAll(async () => {
    for (const pid of started) {
      if (isAlive(pid)) {
        try {
          process.kill(pid)
        } catch {
          // already gone
        }
        await waitGone(pid)
      }
    }
    regClear()
    // A stand-in's program file stays locked for a moment after it ends.
    if (awork) rmSync(awork, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }, 60_000)

  type Window = boolean | 'stay' | 'respawn' | 'exit-soon'
  const WINDOW_ARGS: Record<string, string[]> = { true: ['/window'], false: [], stay: ['/window-stay'], respawn: ['/window-respawn'], 'exit-soon': ['/exit-soon'] }

  /** A copy of the stand-in as `folder\name`, started as this user, with an environment of its own. */
  async function startCopy(folder: string, name: string, window: Window): Promise<{ pid: number; exe: string }> {
    dir(folder)
    const exe = join(folder, name)
    copyFileSync(standIn(), exe)
    const proc = spawn(exe, WINDOW_ARGS[String(window)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', TEMP: awork, TMP: awork },
    })
    proc.unref()
    expect(proc.pid, `${name} started`).toBeDefined()
    started.push(proc.pid!)
    if (window !== false && window !== 'exit-soon') expect(await waitFor(() => existsSync(`${exe}-ready`), 10_000), `${name}'s window is up`).toBe(true)
    else await pause(500)
    expect(isAlive(proc.pid!), `${name} is running before the check`).toBe(true)
    return { pid: proc.pid!, exe }
  }

  /** Ends the stand-ins a case left running. */
  async function endAll(pids: number[]) {
    for (const pid of pids) {
      if (isAlive(pid)) {
        process.kill(pid)
        await waitGone(pid)
      }
    }
  }

  /**
   * One app check, in the installer or the uninstaller pass. `record` is the
   * replaced install's uninstaller as its uninstall record names it in the
   * hive this run installs to (the probe key; SHELL_CONTEXT is the user's
   * here); `legacyUninstaller` is customInit's capture, which can come from
   * another hive. `seen` runs CccCloseAppCopies as in a run someone can see;
   * `savedInstallLocation` is what customInit saved for a Cancel to put back
   * (installer pass). Returns the log, the details list, how long it took,
   * the exit code, and the install location in the probe key afterwards.
   */
  function runAppCheck(pass: 'installer' | 'uninstaller', cfg: { instdir: string; legacyUninstaller: string; record?: string; seen?: boolean; savedInstallLocation?: string }) {
    regClear()
    if (cfg.record) regSet('Uninstall', 'UninstallString', `"${cfg.record}" /currentuser`)
    writeFileSync(acfg(), [
      '[probe]',
      `instdir=${cfg.instdir}`,
      `legacyUninstaller=${cfg.legacyUninstaller}`,
      `seen=${cfg.seen ? 1 : 0}`,
      `savedInstallLocation=${cfg.savedInstallLocation ?? ''}`,
      'installMode=CurrentUser',
      '',
    ].join('\r\n'))
    rmSync(alog(), { force: true })
    const t0 = Date.now()
    let status: number | null = null
    let restored: string | null = null
    try {
      const run = spawnSync(pass === 'installer' ? instProbe() : unProbe(), [], { encoding: 'utf-8', stdio: 'pipe', timeout: 60_000 })
      if (run.error) throw run.error
      status = run.status
      restored = regGet('Install', 'InstallLocation')
    } finally {
      regClear()
    }
    const ms = Date.now() - t0
    const log = readFileSync(alog(), 'utf-8')
    const details = log.split(/\r?\n/).filter((l) => l.startsWith('detail=')).map((l) => l.slice('detail='.length))
    return { log, ms, details, status, restored }
  }

  const leftFrom = (name: string, pid: number) =>
    new RegExp(`^Left ${name.replace(/[.]/g, '\\.')} \\(process ${pid}\\) running from .+\\\\${name.replace(/[.]/g, '\\.')}, which is not this install's folder\\.$`, 'i')
  const ASKED = /^Windows of AI Code Conductor asked to close: [1-9]\d*\.$/
  const ENDS = /^(Ended process|Could not end process|Did not end process)/

  for (const pass of ['installer', 'uninstaller'] as const) {
    it(`${pass} pass: closes this user's copies from this install's folder, ends the one that will not close, and leaves the rest running`, async () => {
      const root = join(awork, `apps-${pass}`)
      rmSync(root, { recursive: true, force: true, maxRetries: 5 })
      const install = join(root, 'Programs', 'AI Code Conductor')
      const replaced = join(root, 'Programs', 'Claude Command Center')
      const elsewhere = join(root, 'Elsewhere')
      const legacy1 = PROBE_LEGACY_EXES['Claude Command Center.exe']

      // This install's: one that closes on WM_CLOSE, and one with no window
      // under an old image name, which only TerminateProcess ends.
      const windowed = await startCopy(install, PROBE_APP_EXE, true)
      const windowless = await startCopy(install, legacy1, false)
      // Not this install's: the same name from another folder, with a window
      // that a stray WM_CLOSE would close, and the session helper in this very
      // folder.
      const outside = await startCopy(elsewhere, PROBE_APP_EXE, true)
      const helper = await startCopy(install, 'aicc-helper.exe', false)
      // The install this run replaces (a pre-rename one): only the installer
      // pass knows its folder, from its uninstall record in this run's hive.
      const old = await startCopy(replaced, legacy1, false)

      const uninstaller = join(replaced, 'Uninstall Claude Command Center.exe')
      const { log, ms, details, status, restored } = runAppCheck(pass, { instdir: install, legacyUninstaller: uninstaller, record: uninstaller })
      const all = details.join('\n')

      expect(log, all).toContain('passed=1')
      expect(status, all).toBe(0)
      expect(restored, 'nothing is put back when the check passes').toBe(null)
      expect(details.filter((d) => ASKED.test(d)), all).toHaveLength(1)
      expect(details, all).toContain('No copy of AI Code Conductor is running from this install\'s folder. Proceeding.')
      // Closed itself on WM_CLOSE, so it was not ended.
      expect(await waitGone(windowed.pid), 'the copy with a window closed').toBe(true)
      expect(existsSync(`${windowed.exe}-closed`), 'it closed through its own close, not TerminateProcess').toBe(true)
      expect(details.filter((d) => d.startsWith(`Ended process ${windowed.pid},`)), all).toEqual([])
      // Ended after the 5 second wait.
      expect(await waitGone(windowless.pid), 'the copy with no window was ended').toBe(true)
      expect(details, all).toContain(`Ended process ${windowless.pid}, which did not close within 5 seconds.`)
      expect(ms, 'it waited for the copies to close').toBeGreaterThanOrEqual(4500)
      expect(ms, 'and then stopped').toBeLessThan(30_000)
      expect(existsSync(`${windowless.exe}-closed`)).toBe(false)
      // Left running, and the details list says why.
      expect(isAlive(outside.pid), 'the same name in another folder keeps running').toBe(true)
      expect(existsSync(`${outside.exe}-closed`), 'no WM_CLOSE reached its window').toBe(false)
      expect(details.some((d) => leftFrom(PROBE_APP_EXE, outside.pid).test(d)), all).toBe(true)
      expect(isAlive(helper.pid), 'the session helper keeps running').toBe(true)
      expect(all).not.toMatch(/aicc-helper/i)
      expect(all).not.toContain(`process ${helper.pid})`)
      if (pass === 'installer') {
        expect(await waitGone(old.pid), 'the replaced install\'s copy was ended').toBe(true)
        expect(details, all).toContain(`Ended process ${old.pid}, which did not close within 5 seconds.`)
      } else {
        expect(isAlive(old.pid), 'the uninstaller pass leaves the replaced install\'s copy alone').toBe(true)
        expect(details.some((d) => leftFrom(legacy1, old.pid).test(d)), all).toBe(true)
      }

      await endAll([outside.pid, helper.pid, old.pid])
    }, 90_000)
  }

  for (const pass of ['installer', 'uninstaller'] as const) {
    it(`${pass} pass, in a run someone can see: a copy that stays open when asked to close is not ended, nor is any other, and the box stops the run`, async () => {
      // The app, asked to close with sessions open, asks whether to save them
      // and stays open meanwhile. Ending it 5 seconds later would cut that
      // answer off, so nothing is ended: the box asks the user to answer it
      // and Retry. Here the box answers Cancel, as a silent run's does.
      const root = join(awork, `apps-seen-${pass}`)
      rmSync(root, { recursive: true, force: true, maxRetries: 5 })
      const install = join(root, 'Programs', 'AI Code Conductor')
      const stays = await startCopy(install, PROBE_APP_EXE, 'stay')
      const windowless = await startCopy(install, PROBE_LEGACY_EXES['Claude Command Center.exe'], false)
      const saved = join(root, 'Programs', 'Saved Install Location')

      const { log, ms, details, status, restored } = runAppCheck(pass, { instdir: install, legacyUninstaller: '', seen: true, savedInstallLocation: saved })
      const all = details.join('\n')

      expect(existsSync(`${stays.exe}-asked`), 'it was asked to close').toBe(true)
      expect(isAlive(stays.pid), 'and was not ended while it asks').toBe(true)
      expect(isAlive(windowless.pid), 'nothing else is ended either').toBe(true)
      expect(details.filter((d) => ENDS.test(d)), all).toEqual([])
      expect(details.filter((d) => ASKED.test(d)), all).toHaveLength(1)
      expect(details, all).toContain('AI Code Conductor was asked to close and is still open. It may be asking whether to save your sessions, so it was not ended.')
      expect(ms, 'it waited 5 seconds first').toBeGreaterThanOrEqual(4500)
      // What is still running, then the stop.
      expect(details, all).toContain(`Still running from this install's folder: ${PROBE_APP_EXE} (process ${stays.pid}).`)
      expect(log, all).not.toContain('passed=1')
      expect(status, all).toBe(2)
      expect(details.some((d) => d.startsWith('No copy of AI Code Conductor is running')), all).toBe(false)
      if (pass === 'installer') {
        expect(details, all).toContain('AI Code Conductor is still running, so nothing was installed.')
        expect(restored, 'Cancel put back the install location customInit saved').toBe(saved)
      } else {
        expect(details, all).toContain('AI Code Conductor is still running, so nothing was removed.')
      }

      await endAll([stays.pid, windowless.pid])
    }, 90_000)
  }

  it('installer pass, silent: a copy that stays open is ended, and a copy that starts again after the first look stops the run, so Cancel puts the saved install location back', async () => {
    const root = join(awork, 'apps-cancel')
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    const install = join(root, 'Programs', 'AI Code Conductor')
    // Closes on WM_CLOSE, but first starts a fresh copy of itself: a pid the
    // first look never saw, so the check cannot end it.
    const respawner = await startCopy(install, PROBE_APP_EXE, 'respawn')
    // Stays open on WM_CLOSE. A silent run has nobody to answer, so it is ended.
    const stays = await startCopy(install, PROBE_LEGACY_EXES['Claude Command Center.exe'], 'stay')
    const saved = join(root, 'Programs', 'Saved Install Location')

    const { log, details, status, restored } = runAppCheck('installer', { instdir: install, legacyUninstaller: '', savedInstallLocation: saved })
    const all = details.join('\n')

    const pidFile = `${respawner.exe}-respawned`
    expect(await waitFor(() => existsSync(pidFile) && /^\d+$/.test(readFileSync(pidFile, 'utf-8').trim()), 5000), 'the fresh copy started').toBe(true)
    const again = Number(readFileSync(pidFile, 'utf-8').trim())
    expect(again, 'its pid').toBeGreaterThan(0)
    started.push(again)
    expect(await waitGone(respawner.pid), 'the first copy closed itself').toBe(true)
    expect(existsSync(`${respawner.exe}-closed`)).toBe(true)
    expect(isAlive(again), 'the fresh copy is still running').toBe(true)
    expect(existsSync(`${stays.exe}-asked`)).toBe(true)
    expect(await waitGone(stays.pid), 'the copy that stayed open was ended').toBe(true)
    expect(details, all).toContain(`Ended process ${stays.pid}, which did not close within 5 seconds.`)
    expect(details, all).toContain(`Still running from this install's folder: ${PROBE_APP_EXE} (process ${again}).`)
    expect(details, all).toContain('AI Code Conductor is still running, so nothing was installed.')
    expect(details.some((d) => d.startsWith('No copy of AI Code Conductor is running')), all).toBe(false)
    expect(log, all).not.toContain('passed=1')
    expect(status, all).toBe(2)
    expect(restored, 'Cancel put back the install location customInit saved').toBe(saved)

    await endAll([again])
  }, 90_000)

  it('installer pass: an install recorded only in another hive is not this run\'s, so its copy keeps running', async () => {
    // customInit's capture falls back to the other hives for the sweep's
    // proof of ownership. On a per-user run it can name an all-users install
    // that this run neither uninstalls nor sweeps: no record of it in this
    // run's hive, so its copy is not this install's.
    const root = join(awork, 'apps-other-hive')
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    const install = join(root, 'Programs', 'AI Code Conductor')
    dir(install)
    const machineWide = join(root, 'Program Files', 'AI Code Conductor')
    const other = await startCopy(machineWide, PROBE_APP_EXE, true)

    const { log, ms, details, status } = runAppCheck('installer', { instdir: install, legacyUninstaller: join(machineWide, 'Uninstall AI Code Conductor.exe') })
    const all = details.join('\n')

    expect(log, all).toContain('passed=1')
    expect(status, all).toBe(0)
    expect(ms, 'no wait').toBeLessThan(4000)
    expect(isAlive(other.pid), 'the other install\'s copy keeps running').toBe(true)
    expect(existsSync(`${other.exe}-closed`), 'and is not asked to close').toBe(false)
    expect(details.some((d) => leftFrom(PROBE_APP_EXE, other.pid).test(d)), all).toBe(true)

    await endAll([other.pid])
  }, 60_000)

  it('goes straight on when none of this install\'s copies runs, and leaves the others running', async () => {
    const root = join(awork, 'apps-none')
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    const install = join(root, 'Programs', 'AI Code Conductor')
    dir(install)
    const outside = await startCopy(join(root, 'Elsewhere'), PROBE_APP_EXE, true)
    const helper = await startCopy(install, 'aicc-helper.exe', false)

    const { log, ms, details, status } = runAppCheck('uninstaller', { instdir: install, legacyUninstaller: '' })
    const all = details.join('\n')

    expect(log, all).toContain('passed=1')
    expect(status, all).toBe(0)
    expect(ms, 'no wait').toBeLessThan(4000)
    expect(isAlive(outside.pid)).toBe(true)
    expect(existsSync(`${outside.exe}-closed`), 'no WM_CLOSE reached a window of another folder\'s copy').toBe(false)
    expect(isAlive(helper.pid)).toBe(true)
    expect(details.some((d) => leftFrom(PROBE_APP_EXE, outside.pid).test(d)), all).toBe(true)
    expect(details.filter((d) => ENDS.test(d) || ASKED.test(d)), all).toEqual([])
    expect(details, all).toContain('No copy of AI Code Conductor is running from this install\'s folder. Proceeding.')

    await endAll([outside.pid, helper.pid])
  }, 60_000)

  // ---- Why an end failed (aicc_planning #328): CccWhyNotEnded, for real ----
  // The app check's step 3 holds a copy open, checks it, then ends it through
  // that handle; when the end fails it inserts CccWhyNotEnded with the error
  // the call left (installer-branding-guard.test.ts pins that). This probe
  // does the same open and end, then inserts the macro. Compiled here, not in
  // beforeAll, so a missing macro fails only these cases.
  const whyProbe = () => join(awork, 'probe-why.exe')
  const wcfg = () => join(awork, 'probe-why.ini')
  const wlog = () => join(awork, 'probe-why.log')
  let whyCompiled = false

  function whyProbeScript(out: string, cfg: string, log: string): string {
    const lifted = liftMacros(['CccWhyNotEnded']).replace(/^(\s*)DetailPrint\b/gm, '$1!insertmacro CccProbeDetail')
    if (/\bDetailPrint\b/.test(lifted)) throw new Error('the why probe has a detail line it cannot read')
    return `Unicode true
SetCompress off
RequestExecutionLevel user
SilentInstall silent
Name "CccWhyProbe"
OutFile "${out}"
InstallDir "$TEMP\\ccc-nsis-probe-unused"

!include "LogicLib.nsh"

Var cccProbeLog

!macro CccProbeDetail TEXT
  FileWrite $cccProbeLog "detail=\${TEXT}$\\r$\\n"
!macroend

${lifted}

Section "probe"
  ReadINIStr $3 "${cfg}" "why" "pid"
  ReadINIStr $4 "${cfg}" "why" "rights"
  ReadINIStr $5 "${cfg}" "why" "waitExit"
  ClearErrors
  FileOpen $cccProbeLog "${log}" w
  StrCpy $8 0
  \${If} $4 != "none"
    System::Call 'kernel32::OpenProcess(i $4, i 0, i $3) p .r8'
  \${EndIf}
  FileWrite $cccProbeLog "opened=$8$\\r$\\n"
  \${If} $5 == "1"
    ; Until it has exited by itself, through the handle held: up to 30 s.
    StrCpy $6 0
    \${Do}
      System::Call 'kernel32::GetExitCodeProcess(p r8, *i .r1) i .r2'
      \${If} $2 == 0
      \${OrIf} $1 != 259
      \${OrIf} $6 >= 300
        \${ExitDo}
      \${EndIf}
      Sleep 100
      IntOp $6 $6 + 1
    \${Loop}
    FileWrite $cccProbeLog "exitcode=$1$\\r$\\n"
  \${EndIf}
  ; The end, as CccCloseAppCopies step 3 makes it.
  System::Call 'kernel32::TerminateProcess(p r8, i 1) i .r6 ?e'
  Pop $7
  FileWrite $cccProbeLog "terminated=$6$\\r$\\n"
  FileWrite $cccProbeLog "error=$7$\\r$\\n"
  \${If} $6 == 0
    !insertmacro CccWhyNotEnded "$3" $8 $7
  \${EndIf}
  \${If} $8 != 0
    System::Call 'kernel32::CloseHandle(p r8)'
  \${EndIf}
  FileWrite $cccProbeLog "done=1$\\r$\\n"
  FileClose $cccProbeLog
SectionEnd
`
  }

  /** The why probe, compiled once, before a case starts its copy. */
  function compileWhy() {
    if (!whyCompiled) {
      compileTo('probe-why', whyProbeScript(whyProbe(), wcfg(), wlog()), false)
      whyCompiled = true
    }
  }

  /** Open `pid` with `rights` ("none": no handle at all), wait for it to exit when `waitExit`, end it, and read why that failed. */
  function runWhy(cfg: { pid: number; rights: string; waitExit: boolean }) {
    compileWhy()
    writeFileSync(wcfg(), ['[why]', `pid=${cfg.pid}`, `rights=${cfg.rights}`, `waitExit=${cfg.waitExit ? 1 : 0}`, ''].join('\r\n'))
    rmSync(wlog(), { force: true })
    const run = spawnSync(whyProbe(), [], { encoding: 'utf-8', stdio: 'pipe', timeout: 60_000 })
    if (run.error) throw run.error
    const log = readFileSync(wlog(), 'utf-8')
    const out: Record<string, string> = {}
    for (const line of log.split(/\r?\n/)) {
      const i = line.indexOf('=')
      if (i > 0 && !line.startsWith('detail=')) out[line.slice(0, i)] = line.slice(i + 1)
    }
    const details = log.split(/\r?\n/).filter((l) => l.startsWith('detail=')).map((l) => l.slice('detail='.length))
    expect(out.done, log).toBe('1')
    return { out, details, log }
  }

  it('an end that fails because the copy had already exited says so', async () => {
    // As the app's own helper processes do once its main process is ended:
    // the copy exits by itself after it was opened and checked, and before
    // the end, which Windows then refuses.
    compileWhy()
    const copy = await startCopy(join(awork, 'why-exited'), 'why-exits.exe', 'exit-soon')
    const { out, details, log } = runWhy({ pid: copy.pid, rights: '0x1001', waitExit: true })
    expect(Number(out.opened), log).not.toBe(0)
    expect(out.exitcode, 'it exited by itself before the end').not.toBe('259')
    expect(out.terminated, log).toBe('0')
    expect(details, log).toEqual([`Could not end process ${copy.pid}: it had already exited.`])
    expect(await waitGone(copy.pid)).toBe(true)
  }, 60_000)

  it('an end that is refused while the copy still runs says access was denied, after about half a second', async () => {
    // Opened without the right to end it, so Windows refuses the end while it runs.
    compileWhy()
    const copy = await startCopy(join(awork, 'why-denied'), 'why-runs.exe', false)
    const t0 = Date.now()
    const { out, details, log } = runWhy({ pid: copy.pid, rights: '0x1000', waitExit: false })
    const ms = Date.now() - t0
    expect(out.terminated, log).toBe('0')
    expect(out.error, log).toBe('5')
    expect(details, log).toEqual([`Could not end process ${copy.pid}: access was denied.`])
    expect(ms, 'it read the exit code for about half a second first').toBeGreaterThanOrEqual(400)
    expect(isAlive(copy.pid), 'and it still runs').toBe(true)
    await endAll([copy.pid])
  }, 60_000)

  it('any other failed end gives the error number Windows gave', () => {
    // No handle at all: Windows answers ERROR_INVALID_HANDLE (6).
    const { out, details, log } = runWhy({ pid: 4242, rights: 'none', waitExit: false })
    expect(out.terminated, log).toBe('0')
    expect(out.error, log).toBe('6')
    expect(details, log).toEqual(['Could not end process 4242: Windows error 6.'])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// The uninstaller's removal of the program files (aicc_planning #328)
// ---------------------------------------------------------------------------

/**
 * customRemoveFiles, for real, over a temporary install folder: electron-
 * builder's own removal, then CccReportLeftFiles. Sandboxed, and fails closed
 * on anything left real: Program Files is a fixture folder, the removal set
 * for the next restart is logged (and the reboot flag set, as RMDir /REBOOTOK
 * sets it) instead of made, every details line is logged, and the template's
 * two Functions, which an installer script cannot call, are stand-ins.
 */
function removeProbeScript(out: string, cfg: string, log: string): string {
  const lifted = liftMacros(['customHeader', 'customRemoveFiles'])
    .replace(/Call un\.atomicRMDir/g, 'Call CccProbeAtomicRMDir')
    .replace(/Call un\.restoreFiles/g, 'Call CccProbeRestoreFiles')
    .replace(/\$PROGRAMFILES(64)?\b/g, '$cccProbeProgramFiles')
    .replace(/^([ \t]*)RMDir \/r \/REBOOTOK "\$INSTDIR"[ \t\r]*$/gm, '$1FileWrite $cccProbeLog "rebootok=$INSTDIR$\\r$\\n"\n$1SetRebootFlag true')
    .replace(/^(\s*)DetailPrint\b/gm, '$1!insertmacro CccProbeDetail')
  for (const [what, re] of [
    ['a delete set for the next restart', /REBOOTOK/i],
    ['the real Program Files', /\$PROGRAMFILES/],
    ['a Function an installer cannot call', /Call un\./],
    ['a detail line the probe cannot read', /\bDetailPrint\b/],
  ] as const) {
    if (re.test(lifted)) throw new Error(`the removal probe would reach ${what}: ${lifted.match(re)?.[0]}`)
  }
  if (!lifted.includes('rebootok=')) throw new Error('the removal probe has no stand-in for the delete set for the next restart')
  return `Unicode true
SetCompress off
RequestExecutionLevel user
SilentInstall silent
Name "CccRemoveProbe"
OutFile "${out}"
InstallDir "$TEMP\\ccc-nsis-probe-unused"

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; The uninstaller pass: customHeader declares only what both passes use.
!define BUILD_UNINSTALLER

Var installMode
Var cccProbeLog
Var cccProbeUpdated
Var cccProbeProgramFiles

; electron-builder's --updated flag, driven by the ini.
!define isUpdated \`$cccProbeUpdated == "1"\`

!macro CccProbeDetail TEXT
  FileWrite $cccProbeLog "detail=\${TEXT}$\\r$\\n"
!macroend

${lifted}

!insertmacro customHeader

; Stand-ins for uninstaller.nsh's un.atomicRMDir and un.restoreFiles: on an
; update, the move out of the folder succeeds.
Function CccProbeAtomicRMDir
  Exch $R9
  StrCpy $R9 0
  Exch $R9
FunctionEnd

Function CccProbeRestoreFiles
  Exch $R9
  StrCpy $R9 0
  Exch $R9
FunctionEnd

Page instfiles

Section "probe"
  ReadINIStr $INSTDIR "${cfg}" "remove" "instdir"
  ReadINIStr $installMode "${cfg}" "remove" "installMode"
  ReadINIStr $cccProbeUpdated "${cfg}" "remove" "updated"
  ReadINIStr $cccProbeProgramFiles "${cfg}" "remove" "programFiles"
  ClearErrors
  FileOpen $cccProbeLog "${log}" w
  InitPluginsDir
  !insertmacro customRemoveFiles
  \${If} \${RebootFlag}
    FileWrite $cccProbeLog "rebootflag=1$\\r$\\n"
  \${EndIf}
  FileWrite $cccProbeLog "done=1$\\r$\\n"
  FileClose $cccProbeLog
SectionEnd
`
}

describe.skipIf(!MAKENSIS)('installer.nsh behavioural probe: the uninstaller names the files it could not remove (aicc_planning #328)', () => {
  let rwork = ''
  const standIn = () => join(rwork, 'stand-in.exe')
  const probe = () => join(rwork, 'probe-remove.exe')
  const rcfg = () => join(rwork, 'probe-remove.ini')
  const rlog = () => join(rwork, 'probe-remove.log')
  const started: number[] = []
  const HELD = 'ccc-probe-held.exe'

  function compileTo(name: string, script: string) {
    const nsi = join(rwork, `${name}.nsi`)
    writeFileSync(nsi, script)
    try {
      execFileSync(MAKENSIS as string, ['/V2', nsi], { encoding: 'utf-8', stdio: 'pipe' })
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string }
      throw new Error(`makensis failed for ${name}:\n${err.stdout ?? ''}${err.stderr ?? ''}`)
    }
  }

  beforeAll(() => {
    rwork = mkdtempSync(join(tmpdir(), 'ccc-nsis-removeprobe-'))
    compileTo('stand-in', standInScript(standIn()))
    compileTo('probe-remove', removeProbeScript(probe(), rcfg(), rlog()))
  }, 120_000)

  afterAll(async () => {
    for (const pid of started) {
      if (isAlive(pid)) {
        try {
          process.kill(pid)
        } catch {
          // already gone
        }
        await waitGone(pid)
      }
    }
    // A stand-in's program file stays locked for a moment after it ends.
    if (rwork) rmSync(rwork, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }, 60_000)

  /**
   * A fixture install folder in a fixture Program Files: a file, two folders
   * with one each, and, when `held`, a program running from it, whose file
   * Windows will not let anyone remove while it runs.
   */
  async function fixture(name: string, held: boolean) {
    const root = join(rwork, name)
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    const programFiles = join(root, 'Program Files')
    const instdir = join(programFiles, 'AI Code Conductor')
    file(join(instdir, 'ffmpeg.dll'))
    file(join(instdir, 'resources', 'app.asar'))
    file(join(instdir, 'locales', 'en-US.pak'))
    const exe = join(instdir, HELD)
    let pid = 0
    if (held) {
      copyFileSync(standIn(), exe)
      const proc = spawn(exe, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', TEMP: rwork, TMP: rwork },
      })
      proc.unref()
      expect(proc.pid, 'the held program started').toBeDefined()
      pid = proc.pid!
      started.push(pid)
      await pause(500)
      expect(isAlive(pid), 'the held program runs').toBe(true)
    }
    return { root, programFiles, instdir, exe, pid }
  }

  function runRemove(cfg: { instdir: string; installMode: 'all' | 'CurrentUser'; updated?: boolean; programFiles: string }) {
    // The removal is real (RMDir /r), so it only ever runs on a folder of its own.
    if (!cfg.instdir.startsWith(rwork + '\\')) throw new Error(`the removal probe refuses ${cfg.instdir}: not under ${rwork}`)
    writeFileSync(rcfg(), [
      '[remove]',
      `instdir=${cfg.instdir}`,
      `installMode=${cfg.installMode}`,
      `updated=${cfg.updated ? 1 : 0}`,
      `programFiles=${cfg.programFiles}`,
      '',
    ].join('\r\n'))
    rmSync(rlog(), { force: true })
    const run = spawnSync(probe(), [], { encoding: 'utf-8', stdio: 'pipe', timeout: 60_000 })
    if (run.error) throw run.error
    const log = readFileSync(rlog(), 'utf-8')
    const lines = log.split(/\r?\n/)
    expect(lines, log).toContain('done=1')
    return {
      log,
      details: lines.filter((l) => l.startsWith('detail=')).map((l) => l.slice('detail='.length)),
      rebootok: lines.filter((l) => l.startsWith('rebootok=')).map((l) => l.slice('rebootok='.length)),
      rebootflag: lines.includes('rebootflag=1'),
    }
  }

  const heading = (instdir: string) => `Could not remove everything in ${instdir}. A program may still have these open:`

  /** What else of the fixture went: everything but the held program. */
  function onlyHeldLeft(f: { instdir: string; exe: string }) {
    expect(existsSync(f.exe), 'the running program\'s file stays').toBe(true)
    for (const gone of ['ffmpeg.dll', 'resources', 'locales']) expect(existsSync(join(f.instdir, gone)), `${gone} was removed`).toBe(false)
  }

  async function endHeld(pid: number) {
    if (isAlive(pid)) {
      process.kill(pid)
      await waitGone(pid)
    }
  }

  it('per-user: names the file a running program holds, removes the rest, and sets nothing for the next restart', async () => {
    const f = await fixture('per-user', true)
    const r = runRemove({ instdir: f.instdir, installMode: 'CurrentUser', programFiles: f.programFiles })
    expect(r.details, r.log).toEqual([
      heading(f.instdir),
      `Left: ${f.exe}`,
      'They stay until they are removed by hand, once the program that has them open has closed.',
    ])
    onlyHeldLeft(f)
    expect(r.rebootok, 'nothing is set for the next restart on a per-user uninstall').toEqual([])
    expect(r.rebootflag).toBe(false)
    await endHeld(f.pid)
  }, 60_000)

  it('all users, inside Program Files: also sets what is left to go at the next restart, says so, and asks nobody to restart', async () => {
    const f = await fixture('all-users', true)
    const r = runRemove({ instdir: f.instdir, installMode: 'all', programFiles: f.programFiles })
    expect(r.details, r.log).toEqual([
      heading(f.instdir),
      `Left: ${f.exe}`,
      'They are removed when Windows next restarts. Restart before you install AI Code Conductor in this folder again.',
    ])
    onlyHeldLeft(f)
    expect(r.rebootok).toEqual([f.instdir])
    expect(r.rebootflag, 'the reboot flag is cleared again, so the finish page offers no restart').toBe(false)
    await endHeld(f.pid)
  }, 60_000)

  it('all users, outside Program Files: names the file and sets nothing for the next restart', async () => {
    const f = await fixture('all-users-elsewhere', true)
    const r = runRemove({ instdir: f.instdir, installMode: 'all', programFiles: join(f.root, 'Other Program Files') })
    expect(r.details, r.log).toEqual([
      heading(f.instdir),
      `Left: ${f.exe}`,
      'They stay until they are removed by hand: this folder is not inside Program Files, so they are not set to be removed at the next restart.',
    ])
    onlyHeldLeft(f)
    expect(r.rebootok).toEqual([])
    expect(r.rebootflag).toBe(false)
    await endHeld(f.pid)
  }, 60_000)

  it('all users, never Program Files itself: nothing is set for the next restart', async () => {
    const f = await fixture('program-files-itself', true)
    const r = runRemove({ instdir: f.instdir, installMode: 'all', programFiles: f.instdir })
    expect(r.details, r.log).toContain(`Left: ${f.exe}`)
    expect(r.rebootok).toEqual([])
    await endHeld(f.pid)
  }, 60_000)

  it('on an update: names the file and sets nothing for the next restart, as the new files go into this same folder', async () => {
    const f = await fixture('update', true)
    const r = runRemove({ instdir: f.instdir, installMode: 'all', updated: true, programFiles: f.programFiles })
    expect(r.details, r.log).toEqual([heading(f.instdir), `Left: ${f.exe}`])
    onlyHeldLeft(f)
    expect(r.rebootok).toEqual([])
    expect(r.rebootflag).toBe(false)
    await endHeld(f.pid)
  }, 60_000)

  it('with nothing held, the whole folder goes and nothing is said', async () => {
    const f = await fixture('nothing-held', false)
    const r = runRemove({ instdir: f.instdir, installMode: 'all', programFiles: f.programFiles })
    expect(r.details, r.log).toEqual([])
    expect(existsSync(f.instdir)).toBe(false)
    expect(r.rebootok).toEqual([])
  }, 60_000)
})
