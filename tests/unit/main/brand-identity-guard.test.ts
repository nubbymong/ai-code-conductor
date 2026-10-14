import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Rename-safety tripwires for the "AI Code Conductor" display rename.
 *
 * The display name lives ONLY in build.productName. Everything filename- and
 * identity-shaped is deliberately frozen to the legacy values so existing
 * installs keep updating and upgrading in place:
 *   - win/mac executableName pin the exe / .app bundle filename (the NSIS
 *     assisted installer appends APP_FILENAME to any install dir that does not
 *     contain it, and the mac drag-install replaces only on filename collision)
 *   - artifactName now carries the CURRENT brand, which is only safe because
 *     the updater accepts both prefixes (since 2.1.0-beta.6); that tolerance is
 *     pinned by its own test below and must outlive the rename
 *   - a top-level productName must never exist (Electron app.name would follow
 *     it and relocate userData away from %APPDATA%/claude-conductor)
 */
const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf-8'))

const readNsh = () => readFileSync(join(__dirname, '../../../build/installer.nsh'), 'utf-8')

/**
 * The body of one NSIS macro, so an assertion cannot be satisfied by a match
 * somewhere else in the file. That is not hypothetical: an earlier round of this
 * guard used whole-file `toContain` for the legacy folder names, and stayed
 * GREEN while the detection list was gutted — because the same names also appear
 * in the customInstall cleanup calls and in the comments.
 */
function nshMacro(name: string): string {
  return nshMacroIn(readNsh(), name)
}

/** The body of one NSIS macro in the given text (installer.nsh, or a test's
 *  mutant of it). */
function nshMacroIn(src: string, name: string): string {
  const m = src.match(new RegExp(`^!macro ${name}\\b[\\s\\S]*?^!macroend`, 'm'))
  if (!m) throw new Error(`macro ${name} not found in build/installer.nsh`)
  return m[0]
}

/**
 * A file-existence test in NSIS: `${FileExists} <target>` or
 * `IfFileExists <target>`, the target in double quotes, single quotes,
 * backticks or none, as NSIS takes all four.
 */
const FILE_TEST = /(?:\$\{FileExists\}|\bIfFileExists)\s+(?:"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+))/gi

/**
 * Whether a file-existence target is the app's executable, in any spelling
 * and in any folder: its last part ends in `.exe` (a name spelled out, any
 * define such as `${PRODUCT_FILENAME}`, `${APP_FILENAME}` or `${PRODUCT_NAME}`
 * with `.exe`, or a wildcard) or is `${APP_EXECUTABLE_FILENAME}`. The
 * uninstaller (`Uninstall <name>.exe`) is not the app. Naming only some
 * spellings, and only under `$INSTDIR`, let others back in unnoticed:
 * `$R3\${APP_EXECUTABLE_FILENAME}`, an
 * exe test on the recorded uninstaller's own folder, is the beta.5 bug. A
 * test through a variable (`StrCpy $R0 ...`, then `${FileExists} "$R0"`) is
 * past what a text guard can see.
 */
function isAppExe(target: string): boolean {
  const last = target.split(/[\\/]/).pop() ?? ''
  if (/^uninstall\b/i.test(last)) return false
  return /\.exe$/i.test(last) || /^\$\{APP_EXECUTABLE_FILENAME\}$/i.test(last)
}

/** Every file-existence test in the code lines of an NSIS text (comments and
 *  blank lines left out, a line continued with a trailing backslash joined to
 *  the next), with the test as written, its target, the Function it sits in
 *  (null outside one, a macro body included) and the two code lines before
 *  it. */
function fileExistenceTests(src: string): Array<{ test: string; target: string; code: string; fn: string | null; before: string[] }> {
  const out: Array<{ test: string; target: string; code: string; fn: string | null; before: string[] }> = []
  const code: string[] = []
  let fn: string | null = null
  const lines = src.replace(/\\[ \t]*\r?\n[ \t]*/g, ' ').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
    const opened = /^Function\s+(\S+)/i.exec(line)
    if (opened) fn = opened[1]
    for (const m of line.matchAll(FILE_TEST)) {
      out.push({ test: m[0], target: m[1] ?? m[2] ?? m[3] ?? m[4] ?? '', code: line, fn, before: code.slice(-2) })
    }
    if (/^FunctionEnd\b/i.test(line)) fn = null
    code.push(line)
  }
  return out
}

/** The tests among them of whether the app's executable exists. */
function exeExistenceProbes(src: string): Array<{ code: string; fn: string | null; before: string[] }> {
  return fileExistenceTests(src).filter((t) => isAppExe(t.target))
}

/** What ClassifyUninstallRecord may test with `${FileExists}` or
 *  `IfFileExists`: the recorded uninstaller ($R1), and nothing else. An
 *  allow-list, so a test of any other file, in any spelling, through those two
 *  fails the guard. The other ways NSIS can tell whether a file is there are
 *  banned in that macro outright (CLASSIFY_BANNED_PROBES), and so is any
 *  naming of the app's executable (APP_EXE_NAMING). These three read the
 *  macro's own lines only: a macro it inserts (CccGetInQuotes, and
 *  FindLegacyRoot, whose folder-name comparison names APP_FILENAME) or a
 *  function it calls is outside them. The file-wide exe test check
 *  (exeExistenceProbes over the whole file) still reads those, for the two
 *  FileExists spellings only. */
const CLASSIFY_ALLOWED_TESTS = ['${FileExists} "$R1"']
const classifyExistenceTests = (nsh: string): string[] => fileExistenceTests(nshMacroIn(nsh, 'ClassifyUninstallRecord')).map((t) => t.test)

/** The code lines of one macro: comments and blank lines left out, a line
 *  continued with a trailing backslash joined to the next. */
function macroCodeLines(nsh: string, name: string): string[] {
  return nshMacroIn(nsh, name).replace(/\\[ \t]*\r?\n[ \t]*/g, ' ').split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith(';') && !l.startsWith('#'))
}

/** Any naming of the app's executable: `.exe`, or a define its name is built
 *  from. The classification reads the recorded uninstaller only, so it has no
 *  reason to name the app's executable at all, by any test or none. */
const APP_EXE_NAMING = /\.exe\b|\b(?:APP_EXECUTABLE_FILENAME|PRODUCT_FILENAME|PRODUCT_NAME|APP_FILENAME)\b/i
/** The other ways NSIS can tell whether a file is there (instructions, and
 *  FileFunc macros), each of which can stand in for `${FileExists}`: an
 *  open or a time read that sets the error flag, an attribute or size read, a
 *  search, a version read. */
const CLASSIFY_BANNED_PROBES = /\b(?:GetFileTime(?:Local)?|FileOpen|GetFileAttributes|FindFirst|GetSize|GetDLLVersion(?:Local)?|SearchPath|Locate)\b/i
/** The code lines of ClassifyUninstallRecord that name the app's executable. */
const classifyExeNaming = (nsh: string): string[] => macroCodeLines(nsh, 'ClassifyUninstallRecord').filter((l) => APP_EXE_NAMING.test(l))
/** The code lines of ClassifyUninstallRecord that probe a file another way. */
const classifyOtherProbes = (nsh: string): string[] => macroCodeLines(nsh, 'ClassifyUninstallRecord').filter((l) => CLASSIFY_BANNED_PROBES.test(l))

describe('brand identity guard', () => {
  it('display name is AI Code Conductor, set only under build', () => {
    expect(pkg.build.productName).toBe('AI Code Conductor')
    expect(Object.prototype.hasOwnProperty.call(pkg, 'productName')).toBe(false)
  })

  it('exe and .app bundle carry the current brand, so a fresh install has no legacy name', () => {
    // These WERE pinned to "Claude Command Center" to stop upgrades relocating,
    // because electron-builder's instFilesPre appends ${APP_FILENAME} to any
    // $INSTDIR lacking it. A fresh install therefore landed in
    // …\Programs\Claude Command Center\Claude Command Center.exe — the legacy
    // name in the install path and in Task Manager. The pin is now replaced by
    // an explicit relocation in build/installer.nsh (customInit steps $INSTDIR
    // up to the parent when it ends in a legacy folder name, so the append
    // re-lands it under the new name, and customInstall removes the old folder).
    // If these two ever revert, that relocation silently becomes dead code.
    expect(pkg.build.win.executableName).toBe('AI Code Conductor')
    expect(pkg.build.mac.executableName).toBe('AI Code Conductor')
    // Still never top-level — Linux has no relocation story and derives its
    // binary name from productName.
    expect(pkg.build.executableName).toBeUndefined()
  })

  it('the installer still relocates a legacy install folder instead of nesting inside it', () => {
    const nsh = readNsh()
    // customInit must run the step-up, and it must recognise the legacy folder
    // names; without this an upgrade installs to <old folder>\AI Code Conductor.
    expect(nsh).toMatch(/!macro customInit/)
    expect(nsh).toMatch(/GetParent/)
    expect(nshMacro('customInit')).toMatch(/StrCpy \$INSTDIR "\$R4\\\$\{APP_FILENAME\}"/)
    // And the old folder has to be cleaned up, or the machine keeps a dead copy
    // that nothing can uninstall (the single uninstall entry now points at the
    // new folder).
    expect(nsh).toMatch(/!macro RemoveLegacyInstall/)
    expect(nsh).toMatch(/RMDir \/r "\$\{DIR\}"/)
  })

  it('the relocation recognises the " Beta"-suffixed folder names too', () => {
    // The original check compared only against "Claude Command Center" and
    // "Claude Conductor". Real installs were in "Claude Conductor Beta" and
    // "Claude Command Center Beta", which matched NEITHER — so the relocation
    // never fired and each rename installed INSIDE the previous folder:
    //   …\Claude Conductor Beta\Claude Command Center Beta\AI Code Conductor
    // Missing any of these names re-opens that nesting.
    const detect = nshMacro('IsLegacyBrandFolder')
    for (const name of [
      '"Claude Command Center"',
      '"Claude Conductor"',
      '"Claude Command Center Beta"',
      '"Claude Conductor Beta"',
    ]) {
      expect(detect).toContain(name)
    }
    // ...and "claude-conductor" must NOT be one of them. It is this repo's npm
    // `name`, never an install directory: electron-builder only falls back to
    // the sanitised package name when productFilename fails
    // /^[-_+0-9a-zA-Z .]+$/ (targetUtil.js getWindowsInstallationDirName), and
    // every brand name here passes. It IS, however, the obvious directory name
    // for a source checkout — so listing it aims the sweep at working copies for
    // no upside at all.
    expect(detect).not.toContain('claude-conductor')

    const nsh = readNsh()
    // The walk has to look at ANCESTORS, not just the last component — a nested
    // install's tail is already the current brand name.
    expect(nsh).toMatch(/GetFileName/)
    expect(nsh).toMatch(/\$\{Loop\}/)
    // ...but it must STOP at the first component that is neither a legacy name
    // nor the app name. customInstall RMDir /r's siblings of whatever this
    // resolves to, so an unbounded climb would let an install at
    //   C:\Claude Conductor\dev\AI Code Conductor
    // treat C:\Claude Conductor as the legacy root.
    expect(nsh).toMatch(/\$\{ElseIf\}\s+\$R7\s+!=\s+"\$\{APP_FILENAME\}"/)
  })

  it('the sweep demands proof of ownership before RMDir /r', () => {
    // RMDir /r is irreversible and FOLLOWS DIRECTORY JUNCTIONS — verified with
    // the real makensis: with the reparse check removed, RMDir /r on a
    // `mklink /J` junction emptied the tree it pointed at. A folder-name match
    // is therefore not remotely enough. Scoped to the macro body, because every
    // one of these tokens also appears in prose elsewhere in the file.
    //
    // These are PRESENCE assertions and cannot catch a flipped guard — a
    // measured fact, not a worry: 6/6 polarity mutants stayed green here.
    // installer-nsis-behaviour.test.ts compiles these macros with the real
    // makensis and checks what survives on disk; that is what actually holds
    // them. Keep both — this one names the shape, that one enforces it.
    const body = nshMacro('RemoveLegacyInstall')
    // 1. never the directory we are installing into. Compared CANONICALLY: a
    //    raw StrCmp is defeated by an 8.3 short-name $INSTDIR
    //    (`/S /D=C:\PROGRA~1\CLAUDE~1`), which swept the just-installed folder.
    expect(body).toMatch(/PathsOverlapCanon "\$\{DIR\}" "\$INSTDIR"/)
    // 2. never a junction / symlink / mount point
    expect(body).toMatch(/GetFileAttributes\}\s+"\$\{DIR\}"\s+"REPARSE_POINT"/)
    // 3. the data/resources directories must be KNOWN. PathsOverlap(dir, "") is
    //    0, so an unreadable DataDirectory used to switch the next check off
    //    entirely — and ReadUserPath is HKCU-only, so both come back empty on
    //    an all-users install elevated by a different admin.
    expect(body).toMatch(/\$\{If\} \$R3 == ""\s*\n\s*\$\{OrIf\} \$R4 == ""/)
    // 4. never anything overlapping either of them. Shipped builds defaulted
    //    DataDirectory to "$LOCALAPPDATA\Claude Command Center" — a name this
    //    sweep looks for — so an install into %LOCALAPPDATA% would delete the
    //    user's sessions, logs and CONFIG, twenty lines after customInstall
    //    adopted that path.
    expect(body).toMatch(/PathsOverlapCanon "\$\{DIR\}" "\$R3"/)
    expect(body).toMatch(/PathsOverlapCanon "\$\{DIR\}" "\$R4"/)
    // 5. positive proof it is an install root and not a source checkout
    expect(body).toMatch(/ProveLegacyInstallRoot "\$\{DIR\}"/)
    // ...and the deletion itself still has to be there.
    expect(body).toMatch(/RMDir \/r "\$\{DIR\}"/)
    // The data/resources paths must actually be loaded before the sweep runs,
    // from every brand key.
    const install = nshMacro('customInstall')
    expect(install).toMatch(/ReadUserPath "DataDirectory" \$R3/)
    expect(install).toMatch(/ReadUserPath "ResourcesDirectory" \$R4/)
    expect(nshMacro('ReadUserPath')).toContain('Software\\Claude Conductor')
    // The cleanup list must not name the npm package directory either.
    expect(install).not.toContain('claude-conductor')
    // An explicit /D= directory's siblings are not this installer's business.
    expect(install).toMatch(/GetDParameter/)
  })

  it('ownership is proved down the nesting CHAIN, not just at its top', () => {
    // The uninstaller in
    //   …\Claude Conductor Beta\Claude Command Center Beta\AI Code Conductor
    // exists ONLY at the leaf: electron-builder's uninstaller does
    // RMDir /r $INSTDIR before SetOutPath recreates the chain one level deeper,
    // so every outer level holds nothing but the next folder. Demanding
    // "Uninstall *.exe" at the candidate itself therefore could NEVER be
    // satisfied on the outer root — while ForgetPreviousInstallIn still cleared
    // the ARP record for that shape, orphaning the whole tree.
    const prove = nshMacro('ProveLegacyInstallRoot')
    expect(prove).toMatch(/Call CccProveInstallRoot/)
    // ...or the uninstaller the replaced install recorded, captured before the
    // commit point overwrote it.
    expect(prove).toContain('$cccLegacyUninstaller')
    expect(nshMacro('customInit')).toMatch(/CaptureRecordedUninstaller/)

    // The walk itself: it must look INSIDE the candidate, only follow folders
    // that can be a link in a nesting chain, skip reparse points, and treat a
    // wildcard hit as proof only when it is a FILE — IfFileExists with a
    // wildcard is FindFirstFile, which matches DIRECTORIES (measured: a folder
    // called "Uninstall whatever.exe" satisfied the old proof and the sibling
    // source checkout was deleted).
    const header = nshMacro('customHeader')
    expect(header).toMatch(/FindFirst \$cccProveHandle \$cccProveName "\$cccProveCur\\Uninstall \*\.exe"/)
    expect(header).toMatch(/\$\{IfNot\} \$\{FileExists\} "\$cccProveCur\\\$cccProveName\\\*\.\*"/)
    expect(header).toMatch(/IsChainFolder "\$cccProveName"/)
    expect(header).toMatch(/GetFileAttributes\} "\$cccProveCur\\\$cccProveName" "REPARSE_POINT"/)
  })

  it('the uninstall record is only dropped once the install is committing', () => {
    // customInit runs inside .onInit — BEFORE the licence, install-mode,
    // directory and data-directory pages. Clearing the Add/Remove Programs
    // record there meant cancelling the wizard (or declining UAC) left the app
    // fully installed with no ARP entry, uninstallable by neither user nor MDM.
    // installSection.nsh inserts CHECK_APP_RUNNING immediately before
    // uninstallOldVersion, which is both after the user committed and before the
    // only place the old uninstaller is ever run.
    expect(nshMacro('customInit')).not.toMatch(/DeleteRegKey/)
    expect(nshMacro('customCheckAppRunning')).toMatch(/ForgetBrokenPreviousInstall/)

    // And the delete has to follow the hive it was asked about. appId is frozen,
    // so a per-user and a per-machine install share the key PATH but are two
    // separate installations: an unconditional `DeleteRegKey HKCU` from an
    // /allusers run destroyed a healthy per-user record, after which
    // uninstallOldVersion HKEY_CURRENT_USER read an empty UninstallString and
    // returned — orphaning that copy on disk.
    const forget = nshMacro('ForgetPreviousInstallIn')
    expect(forget).toMatch(/DeleteRegKey \$\{ROOT_KEY\} "\$\{UNINSTALL_REGISTRY_KEY\}"/)
    expect(forget).not.toMatch(/DeleteRegKey HKCU/)
    expect(forget).not.toMatch(/DeleteRegKey SHELL_CONTEXT/)

    // The "is the previous install still there?" test reads the RECORDED
    // uninstaller, not $INSTDIR\<app>.exe. The old exe-existence gate wrongly
    // condemned any beta.5-or-older install sitting in a non-legacy-named
    // folder, where the executable was still called Claude Command Center.exe.
    const classify = nshMacro('ClassifyUninstallRecord')
    expect(classify).toMatch(/ReadRegStr \$R0 \$\{ROOT_KEY\} "\$\{UNINSTALL_REGISTRY_KEY\}" "UninstallString"/)
    expect(classify).toMatch(/\$\{ElseIfNot\} \$\{FileExists\} "\$R1"/)
    // An allow-list: the recorded uninstaller is the only file whose
    // existence the classification tests. A
    // deny-list of exe spellings under $INSTDIR stayed green under
    // `${ElseIfNot} ${FileExists} "$INSTDIR\${PRODUCT_NAME}.exe"` and under an
    // exe test on the uninstaller's own folder (`$R3`), the beta.5 bug; the
    // mutants below are pinned in 'the guard fails on each way the exe test
    // could come back'.
    expect(classifyExistenceTests(readNsh())).toEqual(CLASSIFY_ALLOWED_TESTS)
    // No other way to tell whether a file is there (GetFileTime, FileOpen,
    // GetFileAttributes, FindFirst and the rest), and no naming of the app's
    // executable in any spelling: the mutants below are pinned in 'the guard
    // fails on each other way the exe could be probed'.
    expect(classifyOtherProbes(readNsh())).toEqual([])
    expect(classifyExeNaming(readNsh())).toEqual([])
    // No exe-existence test in any spelling of the exe's name, in any folder,
    // anywhere, but the splash probe: a cosmetic freshness hint in
    // CccBrandGuiInit, under its two guards. Spelled with PRODUCT_FILENAME
    // there because APP_EXECUTABLE_FILENAME is defined later, by
    // electron-builder's common.nsh.
    const probes = exeExistenceProbes(readNsh())
    expect(probes.map((p) => p.code)).toEqual(['${AndIfNot} ${FileExists} "$INSTDIR\\${PRODUCT_FILENAME}.exe"'])
    expect(probes[0].fn).toBe('CccBrandGuiInit')
    expect(probes[0].before).toEqual(['${IfNot} $cccIsInnerInstance == 1', '${AndIfNot} $cccIsUpdated == 1'])
  })

  it('the exe-existence matcher knows every spelling, in any folder, and only code lines count', () => {
    const lines = [
      'Function F',
      '  ${If} ${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"',
      '  ${ElseIfNot} ${FileExists} "$INSTDIR\\${PRODUCT_FILENAME}.exe"',
      '  IfFileExists "$INSTDIR\\${APP_FILENAME}.exe" 0 +2',
      '  ${OrIfNot} ${FileExists} $INSTDIR\\${PRODUCT_FILENAME}.exe',
      "  ${AndIf} ${FileExists} '$INSTDIR\\${APP_EXECUTABLE_FILENAME}'",
      '  IfFileExists `$INSTDIR/${PRODUCT_FILENAME}.exe` +2 0',
      '  ${ElseIfNot} ${FileExists} "$INSTDIR\\${PRODUCT_NAME}.exe"',
      '  ${IfNot} ${FileExists} "$R3\\${APP_EXECUTABLE_FILENAME}"',
      '  ${If} ${FileExists} "$INSTDIR\\AI Code Conductor.exe"',
      '  ${If} ${FileExists} "$INSTDIR\\*.exe"',
      '  ${If} ${FileExists} \\',
      '      "$INSTDIR\\${PRODUCT_FILENAME}.exe"',
      '  ; ${FileExists} "$INSTDIR\\${PRODUCT_FILENAME}.exe" in a comment',
      '  ${If} ${FileExists} "$INSTDIR\\Uninstall x.exe"',
      '  ${If} ${FileExists} "$R1"',
      '  ${If} ${FileExists} "$0\\CONFIG\\*.*"',
      'FunctionEnd',
      '!macro M',
      '  ${If} ${FileExists} "$INSTDIR\\${PRODUCT_FILENAME}.exe"',
      '!macroend',
    ].join('\r\n')
    const found = exeExistenceProbes(lines)
    expect(found.map((p) => [p.fn, p.code.split(' ')[0]])).toEqual([
      ['F', '${If}'], ['F', '${ElseIfNot}'], ['F', 'IfFileExists'],
      ['F', '${OrIfNot}'], ['F', '${AndIf}'], ['F', 'IfFileExists'],
      ['F', '${ElseIfNot}'], ['F', '${IfNot}'], ['F', '${If}'], ['F', '${If}'], ['F', '${If}'],
      [null, '${If}'],
    ])
    // Every file-existence test is seen, the uninstaller's and a folder's included.
    expect(fileExistenceTests(lines).map((t) => t.target)).toContain('$R1')
    expect(fileExistenceTests(lines).map((t) => t.target)).toContain('$INSTDIR\\Uninstall x.exe')
  })

  // Each way an exe test could come back into the classification, built from
  // the real installer.nsh in memory, fails the guard (the allow-list and the
  // whole-file probe list both). A deny-list guard stays green under the first
  // two, and a narrower matcher misses the rest.
  it.each([
    ['the product name spelling', '    ${ElseIfNot} ${FileExists} "$INSTDIR\\${PRODUCT_NAME}.exe"\r\n      StrCpy $cccRecordVerdict "missing"\r\n'],
    ['the exe on the uninstaller\'s own folder (the beta.5 bug)', '    ${ElseIfNot} ${FileExists} "$R3\\${APP_EXECUTABLE_FILENAME}"\r\n      StrCpy $cccRecordVerdict "missing"\r\n'],
    ['the name spelled out', '    ${ElseIfNot} ${FileExists} "$INSTDIR\\AI Code Conductor.exe"\r\n      StrCpy $cccRecordVerdict "missing"\r\n'],
    ['a wildcard', '    ${ElseIfNot} ${FileExists} "$INSTDIR\\*.exe"\r\n      StrCpy $cccRecordVerdict "missing"\r\n'],
    ['a test split across two lines', '    ${ElseIfNot} ${FileExists} \\\r\n        "$INSTDIR\\${PRODUCT_FILENAME}.exe"\r\n      StrCpy $cccRecordVerdict "missing"\r\n'],
    ['IfFileExists, unquoted', '    IfFileExists $INSTDIR\\${APP_FILENAME}.exe 0 +2\r\n'],
  ])('the guard fails on each way the exe test could come back: %s', (_label, mutant) => {
    const nsh = readNsh().replace(/\r?\n/g, '\r\n')
    const anchor = '    ${Else}\r\n      ${GetParent} "$R1" $R3\r\n'
    const at = nshMacroIn(nsh, 'ClassifyUninstallRecord').indexOf(anchor)
    expect(at, 'the place in ClassifyUninstallRecord the mutant goes').toBeGreaterThan(-1)
    const macroAt = nsh.indexOf('!macro ClassifyUninstallRecord')
    const mutated = nsh.slice(0, macroAt + at) + mutant + nsh.slice(macroAt + at)
    // The control: the real file passes both checks.
    expect(classifyExistenceTests(nsh)).toEqual(CLASSIFY_ALLOWED_TESTS)
    expect(exeExistenceProbes(nsh)).toHaveLength(1)
    expect(classifyExeNaming(nsh)).toEqual([])
    // The mutant fails all three.
    expect(classifyExistenceTests(mutated)).not.toEqual(CLASSIFY_ALLOWED_TESTS)
    expect(exeExistenceProbes(mutated)).toHaveLength(2)
    expect(classifyExeNaming(mutated)).not.toEqual([])
  })

  // Each other way NSIS can tell whether the app's executable is there,
  // placed after the uninstaller's folder is read into $R3, condemns a
  // previous install whose folder lacks the renamed exe (the beta.5 bug
  // class). The FileExists allow-list cannot see these; the ban on naming the
  // exe and the ban on the other probes each catch them, and the last two
  // rows pin each ban on its own (a probe that names no exe, a naming with no
  // probe). Mutation to prove this can fail: empty either list.
  it.each([
    ['GetFileTime, read through the error flag', '      ClearErrors\r\n      GetFileTime "$R3\\${APP_EXECUTABLE_FILENAME}" $R4 $R4\r\n      ${If} ${Errors}\r\n        StrCpy $cccRecordVerdict "missing"\r\n      ${EndIf}\r\n', { naming: true, probe: true }],
    ['FileOpen, then IfErrors', '      FileOpen $R4 "$R3\\${APP_EXECUTABLE_FILENAME}" r\r\n      IfErrors 0 +2\r\n        StrCpy $cccRecordVerdict "missing"\r\n      FileClose $R4\r\n', { naming: true, probe: true }],
    ['GetFileAttributes on the exe', '      ${GetFileAttributes} "$R3\\${PRODUCT_FILENAME}.exe" "ALL" $R4\r\n      ${If} $R4 == ""\r\n        StrCpy $cccRecordVerdict "missing"\r\n      ${EndIf}\r\n', { naming: true, probe: true }],
    ['FindFirst on the exe by its spelled-out name', '      FindFirst $R4 $R5 "$R3\\AI Code Conductor.exe"\r\n      ${If} $R5 == ""\r\n        StrCpy $cccRecordVerdict "missing"\r\n      ${EndIf}\r\n      FindClose $R4\r\n', { naming: true, probe: true }],
    ['a probe that names no exe (FindFirst on a wildcard)', '      FindFirst $R4 $R5 "$R3\\*"\r\n      ${If} $R5 == ""\r\n        StrCpy $cccRecordVerdict "missing"\r\n      ${EndIf}\r\n      FindClose $R4\r\n', { naming: false, probe: true }],
    ['a naming of the exe with no probe', '      StrCpy $R4 "$R3\\${PRODUCT_NAME}"\r\n', { naming: true, probe: false }],
  ])('the guard fails on each other way the exe could be probed: %s', (_label, mutant, caught) => {
    const nsh = readNsh().replace(/\r?\n/g, '\r\n')
    const anchor = '      ${GetParent} "$R1" $R3\r\n'
    const at = nshMacroIn(nsh, 'ClassifyUninstallRecord').indexOf(anchor)
    expect(at, 'the place in ClassifyUninstallRecord the mutant goes').toBeGreaterThan(-1)
    const macroAt = nsh.indexOf('!macro ClassifyUninstallRecord')
    const mutated = nsh.slice(0, macroAt + at + anchor.length) + mutant + nsh.slice(macroAt + at + anchor.length)
    // The control: the real file passes both bans.
    expect(classifyExeNaming(nsh)).toEqual([])
    expect(classifyOtherProbes(nsh)).toEqual([])
    // The FileExists allow-list stays green under each of these.
    expect(classifyExistenceTests(mutated)).toEqual(CLASSIFY_ALLOWED_TESTS)
    // Each ban catches what it should.
    expect(classifyExeNaming(mutated).length > 0).toBe(caught.naming)
    expect(classifyOtherProbes(mutated).length > 0).toBe(caught.probe)
  })

  it('the elevated inner instance, which never reaches the commit point, is covered too', () => {
    // installSection.nsh:35-37 guards CHECK_APP_RUNNING with ${ifNot}
    // ${UAC_IsInnerInstance}, so ForgetBrokenPreviousInstall never runs in the
    // elevated instance — but customInit is inserted UNGUARDED
    // (installer.nsi:79-81), so the retarget does. uninstallOldVersion then read
    // that retargeted InstallLocation and ran the OLD uninstaller with
    // _?=<new dir>; uninstaller.nsh:187 does RMDir /r $INSTDIR, on the directory
    // this run was about to install into.
    const init = nshMacro('customInit')
    expect(init).toMatch(/\$\{If\} \$\{UAC_IsInnerInstance\}/)
    expect(init).toMatch(/SuspendUninstallRecordIn HKCU \$cccSavedPerUserUninstallString/)
    expect(init).toMatch(/SuspendUninstallRecordIn HKLM \$cccSavedPerMachineUninstallString/)

    // It removes ONE value, not the key: uninstallOldVersion returns
    // immediately on an empty UninstallString (installUtil.nsh:156-164), and a
    // single string is restorable.
    const suspend = nshMacro('SuspendUninstallRecordIn')
    expect(suspend).toMatch(/DeleteRegValue \$\{HIVE\} "\$\{UNINSTALL_REGISTRY_KEY\}" "UninstallString"/)
    expect(suspend).not.toMatch(/DeleteRegKey/)
    // ...and restored if the wizard the inner instance still shows is cancelled.
    const header = nshMacro('customHeader')
    expect(header).toMatch(/WriteRegStr HKCU "\$\{UNINSTALL_REGISTRY_KEY\}" "UninstallString" "\$cccSavedPerUserUninstallString"/)
    expect(header).toMatch(/WriteRegStr HKLM "\$\{UNINSTALL_REGISTRY_KEY\}" "UninstallString" "\$cccSavedPerMachineUninstallString"/)
  })

  it('the relocation also neutralises the registry seed that would undo it', () => {
    // $INSTDIR is seeded from ${INSTALL_REGISTRY_KEY}\InstallLocation, and on
    // any interactive run that read happens AGAIN after customInit: the
    // install-mode page's Leave (multiUserUi.nsh:184,187) and every skip path in
    // its Pre re-run setInstallModePerUser / setInstallModePerAllUsers. The
    // in-app updater launches the installer with no arguments, so auto-update IS
    // that path — leaving just `StrCpy $INSTDIR` here would re-nest the install
    // AND leave the old tree orphaned.
    const init = nshMacro('customInit')
    expect(init).toMatch(/RetargetRecordedInstallLocation HKCU/)
    expect(init).toMatch(/RetargetRecordedInstallLocation HKLM/)
    const retarget = nshMacro('RetargetRecordedInstallLocation')
    expect(retarget).toMatch(/ReadRegStr \$R3 \$\{HIVE\} "\$\{INSTALL_REGISTRY_KEY\}" "InstallLocation"/)
    expect(retarget).toMatch(/WriteRegStr \$\{HIVE\} "\$\{INSTALL_REGISTRY_KEY\}" "InstallLocation" "\$INSTDIR"/)
    // Only a record that names the tree being left behind is touched.
    expect(retarget).toMatch(/IsSameOrInside "\$\{LEGACY_ROOT\}"/)

    // ...and it is undone if the wizard never installs anything: that value is
    // where the UNINSTALLER gets its $INSTDIR from, so a dangling one would make
    // a later uninstall delete nothing and then drop the ARP entry. MUI2 owns
    // Function .onUserAbort, so this has to ride its callback.
    const nsh = readNsh()
    expect(nsh).toMatch(/!define MUI_CUSTOMFUNCTION_ABORT "CccRestoreInstallLocation"/)
    expect(nsh).toMatch(/Function CccRestoreInstallLocation/)
    expect(nsh).toMatch(/Function \.onInstFailed/)

    // An explicit /D= is the operator's directory and is never relocated.
    expect(init).toMatch(/GetDParameter/)
  })

  it('release artifacts carry the current brand name; the Mac download also names the macOS it needs', () => {
    // These WERE frozen to ClaudeCommandCenter- because the updater in shipped
    // clients matched release assets by that literal prefix, so renaming them
    // would have made every install see "no matching asset" — indistinguishable
    // from "up to date", and unfixable, since the fix only ships in the build
    // they can no longer see. Releases worked around it by publishing each
    // installer TWICE, under both names.
    //
    // 2.1.0-beta.6 taught the updater BOTH prefixes (see the next test), so a
    // Windows or Linux client that can reach a new release resolves the brand
    // name, and the duplicate is dead weight: its .blockmap and latest*.yml
    // never even referenced it. Only installs on beta.5 or older are left
    // behind there, and they can download from the release page by hand.
    //
    // The Mac download is named AICodeConductor-<version>-macosNN.dmg, where NN
    // is the macOS the packaged app needs (build.mac.minimumSystemVersion). The
    // updater in a build from before that floor matches neither name, so a Mac
    // on such a build is offered nothing from this release and downloads it
    // from the release page by hand (tests/unit/main/update-macos-floor.test.ts).
    expect(pkg.build.nsis.artifactName).toBe('AI-Code-Conductor-${version}.${ext}')
    const macosMajor = parseInt(String(pkg.build.mac.minimumSystemVersion), 10)
    expect(macosMajor).toBeGreaterThanOrEqual(13)
    expect(pkg.build.mac.artifactName).toBe('AICodeConductor-${version}-macos' + macosMajor + '.${ext}')
    expect(pkg.build.linux.artifactName).toBe('AI-Code-Conductor-${version}-linux-${arch}.${ext}')
  })

  it('the updater still accepts the LEGACY prefix, which is what makes the rename safe', () => {
    // This is the load-bearing half of the rename and the reason the assertion
    // above could change at all. Dropping 'ClaudeCommandCenter-' from this list
    // is harmless for assets published from now on, but it would strand any
    // client still running a build whose release assets carried the old name if
    // one is ever re-published. Keep both until beta-era installs are gone.
    const updater = readFileSync(join(__dirname, '../../../src/main/github-update.ts'), 'utf-8')
    const line = updater.match(/const INSTALLER_PREFIXES = \[([^\]]+)\]/)
    expect(line).not.toBeNull()
    expect(line![1]).toContain("'ClaudeCommandCenter-'")
    expect(line![1]).toContain("'AI-Code-Conductor-'")
  })

  it('releases publish ONE set of installers — no legacy duplicate', () => {
    // The duplicate-copy step is what put two names on every release. If it
    // comes back, so does the "which one do I download?" confusion, and the
    // copies carry no matching .blockmap.
    const workflow = readFileSync(join(__dirname, '../../../.github/workflows/release.yml'), 'utf-8')
    expect(workflow).not.toMatch(/cp -- "\$f" "\$clean"/)
    expect(workflow).toContain('INSTALLER="AI-Code-Conductor-${VERSION}.exe"')
  })

  it('npm name and appId stay frozen (userData path + NSIS upgrade GUID)', () => {
    expect(pkg.name).toBe('claude-conductor')
    expect(pkg.build.appId).toBe('com.claudeconductor.app')
  })

  it('window title and the screenshot self-exclusion filter move in lockstep', () => {
    // The vision window-picker excludes the app by substring-matching the OS
    // window title against a literal in the MAIN process, while the title
    // itself comes from the renderer <title> (prod) / dev override. All three
    // live in different files; this pins them to each other.
    const html = readFileSync(join(__dirname, '../../../src/renderer/index.html'), 'utf-8')
    const mainIndex = readFileSync(join(__dirname, '../../../src/main/index.ts'), 'utf-8')
    const capture = readFileSync(join(__dirname, '../../../src/main/screenshot-capture.ts'), 'utf-8')

    const titleMatch = html.match(/<title>([^<]+)<\/title>/)
    expect(titleMatch).not.toBeNull()
    const prodTitle = titleMatch![1]

    const filterMatch = capture.match(/!s\.name\.includes\('([^']+)'\)/)
    expect(filterMatch).not.toBeNull()
    const filter = filterMatch![1]

    const devTitleMatch = mainIndex.match(/const devTitle = '([^']+)'/)
    expect(devTitleMatch).not.toBeNull()
    const devTitle = devTitleMatch![1]

    expect(prodTitle).toContain(filter)
    expect(devTitle).toContain(filter)
  })
})
