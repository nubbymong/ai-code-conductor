; ============================================================
; MACROS FIRST — must be defined before anything else
; These are preprocessor directives and work in any context
; ============================================================
;
; electron-builder emits this file as part of the script HEADER, ahead of its own
; templates/nsis/installer.nsi (NsisTarget.computeCommonInstallerScriptHeader ->
; sharedHeader + installer.nsi). So anything at file scope here compiles FIRST,
; before multiUser.nsh / assistedInstaller.nsh — which is why a define that has
; to beat `!insertmacro addLangs` lives here, while anything needing
; ${INSTALL_REGISTRY_KEY} (defined by multiUser.nsh) has to sit inside a macro
; electron-builder inserts later (customHeader / customInit / customInstall).
;
; The same ordering rule applies to MACROS from electron-builder's own templates:
; installUtil.nsh is included by installer.nsi AFTER Function .onInit, so
; `!insertmacro GetInQuotes` cannot be used from customInit (a Call is resolved
; at link time, a macro insertion is not). That is why the quote stripping below
; is our own CccGetInQuotes rather than electron-builder's.

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; ============================================================
; SHARED PREDICATES
; ============================================================

; Is ${NAME} one of the folder names this app has shipped an INSTALL under?
; Sets ${OUT} to 1 or 0. Every rename added a name here; the " Beta" variants are
; the ones the first version of this check missed, which is how installs ended up
; NESTED (see customInit).
;
; Deliberately NOT listed: "claude-conductor", this repo's npm `name`.
; electron-builder only falls back to the sanitised package name for the install
; directory when productFilename fails /^[-_+0-9a-zA-Z .]+$/
; (out/targets/targetUtil.js getWindowsInstallationDirName), and every brand name
; this app has used passes that test — so no install has ever lived in a folder
; of that name, while a source checkout very plausibly does. Listing it could
; only ever cost someone a working copy.
!macro IsLegacyBrandFolder NAME OUT
  StrCpy ${OUT} 0
  ${If} "${NAME}" == "Claude Command Center"
  ${OrIf} "${NAME}" == "Claude Conductor"
  ${OrIf} "${NAME}" == "Claude Command Center Beta"
  ${OrIf} "${NAME}" == "Claude Conductor Beta"
    StrCpy ${OUT} 1
  ${EndIf}
!macroend

; ${OUT} = 1 when ${NAME} is a folder name that can appear as a LINK in a nesting
; chain: a legacy brand folder, or the current app folder that every rename
; appended one level deeper. This is the same bound FindLegacyRoot climbs, used
; in the other direction by CccProveInstallRoot when it descends.
!macro IsChainFolder NAME OUT
  !insertmacro IsLegacyBrandFolder "${NAME}" ${OUT}
  ${If} ${OUT} != 1
  ${AndIf} "${NAME}" == "${APP_FILENAME}"
    StrCpy ${OUT} 1
  ${EndIf}
!macroend

; ${OUT} = 1 when ${PATH} is ${DIR} itself, or something inside ${DIR}.
; Comparison is case-insensitive because LogicLib's == compiles to StrCmp, which
; is — matching Windows path semantics. Defines no labels of its own, so it is
; safe to insert repeatedly. Scratch: $R5 $R6 $R7.
!macro IsSameOrInside DIR PATH OUT
  StrCpy ${OUT} 0
  ${If} "${PATH}" != ""
    StrLen $R7 "${DIR}"
    StrCpy $R6 "${PATH}" $R7
    ${If} $R6 == "${DIR}"
      StrCpy $R5 "${PATH}" 1 $R7
      ${If} $R5 == ""
      ${OrIf} $R5 == "\"
        StrCpy ${OUT} 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; ${OUT} = 1 when ${A} and ${B} are the same directory, or one contains the
; other, in either direction. Scratch: $R5 $R6 $R7.
!macro PathsOverlap A B OUT
  !insertmacro IsSameOrInside "${A}" "${B}" ${OUT}
  ${If} ${OUT} != 1
    !insertmacro IsSameOrInside "${B}" "${A}" ${OUT}
  ${EndIf}
!macroend

; Two comparable spellings of ${PATH}.
;   ${OUT_PLAIN} — separators normalised to "\" and any trailing separator
;     dropped. A DataDirectory recorded as "C:/Users/x/Claude Command Center"
;     is a real, measured case: a raw prefix compare against the backslash form
;     silently returns "no overlap" and the data directory gets deleted.
;   ${OUT_SHORT} — the same path resolved through the filesystem, which collapses
;     8.3 short names ("C:\PROGRA~1\CLAUDE~1"), "." and ".." to one spelling.
;     GetFullPathName sets the error flag and yields "" for a path that does not
;     exist, so this falls back to ${OUT_PLAIN} there.
; Both forms are kept because a comparison usually has one side that exists (the
; candidate on disk) and one that may not (a directory read out of the registry);
; callers compare plain-to-plain AND short-to-short so either spelling matches.
; Scratch: $cccCanonWork $cccCanonChar $cccCanonIdx $cccCanonTmp.
!macro CanonPathPair PATH OUT_PLAIN OUT_SHORT
  StrCpy ${OUT_PLAIN} ""
  StrCpy ${OUT_SHORT} ""
  ${If} "${PATH}" != ""
    StrCpy $cccCanonWork ""
    StrCpy $cccCanonIdx 0
    ${Do}
      StrCpy $cccCanonChar "${PATH}" 1 $cccCanonIdx
      ${If} $cccCanonChar == ""
        ${ExitDo}
      ${EndIf}
      ${If} $cccCanonChar == "/"
        StrCpy $cccCanonChar "\"
      ${EndIf}
      StrCpy $cccCanonWork "$cccCanonWork$cccCanonChar"
      IntOp $cccCanonIdx $cccCanonIdx + 1
      ${If} $cccCanonIdx > 512
        ${ExitDo}
      ${EndIf}
    ${Loop}
    ; Trailing separators, but never below "X:\".
    ${Do}
      StrLen $cccCanonIdx "$cccCanonWork"
      ${If} $cccCanonIdx < 4
        ${ExitDo}
      ${EndIf}
      StrCpy $cccCanonChar "$cccCanonWork" 1 -1
      ${If} $cccCanonChar != "\"
        ${ExitDo}
      ${EndIf}
      StrCpy $cccCanonWork "$cccCanonWork" -1
    ${Loop}
    StrCpy ${OUT_PLAIN} "$cccCanonWork"
    ClearErrors
    GetFullPathName /SHORT $cccCanonTmp "$cccCanonWork"
    ${If} ${Errors}
    ${OrIf} $cccCanonTmp == ""
      StrCpy ${OUT_SHORT} "$cccCanonWork"
    ${Else}
      StrCpy ${OUT_SHORT} "$cccCanonTmp"
    ${EndIf}
    ClearErrors
  ${EndIf}
!macroend

; PathsOverlap over BOTH canonical spellings. Use this — never a raw StrCmp or a
; raw PathsOverlap — for any comparison that decides whether something may be
; deleted: a raw compare is defeated by a forward slash, a trailing separator or
; an 8.3 short name, all three measured.
; Scratch: $cccCanon* (via CanonPathPair) and $R5 $R6 $R7 (via IsSameOrInside).
!macro PathsOverlapCanon A B OUT
  !insertmacro CanonPathPair "${A}" $cccCanonA $cccCanonAS
  !insertmacro CanonPathPair "${B}" $cccCanonB $cccCanonBS
  !insertmacro PathsOverlap "$cccCanonA" "$cccCanonB" ${OUT}
  ${If} ${OUT} != 1
    !insertmacro PathsOverlap "$cccCanonAS" "$cccCanonBS" ${OUT}
  ${EndIf}
!macroend

; IsSameOrInside over BOTH canonical spellings, in one direction only: ${OUT}
; = 1 when ${PATH} is ${DIR} or something inside it. An empty ${PATH} is 0.
; Scratch: $cccCanon* (via CanonPathPair) and $R5 $R6 $R7 (via IsSameOrInside).
!macro IsSameOrInsideCanon DIR PATH OUT
  !insertmacro CanonPathPair "${DIR}" $cccCanonA $cccCanonAS
  !insertmacro CanonPathPair "${PATH}" $cccCanonB $cccCanonBS
  !insertmacro IsSameOrInside "$cccCanonA" "$cccCanonB" ${OUT}
  ${If} ${OUT} != 1
    !insertmacro IsSameOrInside "$cccCanonAS" "$cccCanonBS" ${OUT}
  ${EndIf}
!macroend

; Walk ${PATH} from its last component upwards and return, in ${OUT}, the
; OUTERMOST legacy-brand folder in the nesting chain ("" = none).
;
; A broken upgrade can be nested several deep:
;   …\Programs\Claude Conductor Beta\Claude Command Center Beta\AI Code Conductor
; That happened because each rename only compared the LAST path component
; against two exact names; a " Beta"-suffixed folder matched neither, so the
; relocation never fired and instFilesPre appended the new name INSIDE the old
; folder. Every rename made it one level deeper. Walking the whole path (not just
; its tail) is what makes this self-healing however deep it already is.
;
; The walk stops at the first component that is NEITHER a legacy name NOR the
; current app name, so it only ever spans an actual nesting CHAIN. That bound is
; load-bearing, because what this finds is what customInstall considers deleting:
; without it, an install at
;   C:\Claude Conductor\dev\AI Code Conductor
; would resolve "C:\Claude Conductor" as the legacy root. "dev" is neither, so
; the climb halts there and nothing above it is ever considered.
; Scratch: $R5 $R6 $R7 $R8 — ${OUT} must not be one of those.
!macro FindLegacyRoot PATH OUT
  StrCpy ${OUT} ""
  StrCpy $R8 "${PATH}"
  StrCpy $R6 0
  ${Do}
    ${GetFileName} "$R8" $R7
    ${If} $R7 == ""
      ${ExitDo}
    ${EndIf}
    !insertmacro IsLegacyBrandFolder "$R7" $R5
    ${If} $R5 == 1
      StrCpy ${OUT} "$R8"
    ${ElseIf} $R7 != "${APP_FILENAME}"
      ; A real parent directory — the nesting chain ends here.
      ${ExitDo}
    ${EndIf}
    ${GetParent} "$R8" $R8
    ${If} $R8 == ""
      ${ExitDo}
    ${EndIf}
    IntOp $R6 $R6 + 1
    ${If} $R6 > 8
      ${ExitDo}
    ${EndIf}
  ${Loop}
!macroend

; Read one of the user-chosen directories, newest brand key first.
;
; HKCU only, because that is the only hive the app itself ever writes
; (src/main/registry.ts) — so on an all-users install elevated by a DIFFERENT
; admin account these come back empty, and RemoveLegacyInstall refuses to delete
; anything rather than sweeping with the data-directory guard switched off.
!macro ReadUserPath NAME OUT
  ReadRegStr ${OUT} HKCU "Software\AI Code Conductor" "${NAME}"
  ${If} ${OUT} == ""
    ReadRegStr ${OUT} HKCU "Software\Claude Command Center" "${NAME}"
  ${EndIf}
  ${If} ${OUT} == ""
    ReadRegStr ${OUT} HKCU "Software\Claude Conductor" "${NAME}"
  ${EndIf}
!macroend

; The path inside the first pair of double quotes of ${STR}, or "".
; electron-builder has a GetInQuotes of its own, but its MACRO is only defined
; once installUtil.nsh has been included — which happens after Function .onInit,
; where customInit needs this. Same shape: an UninstallString is
; '"<dir>\Uninstall <app>.exe" /currentuser'.
; Scratch: $cccQuoteWork $cccQuoteChar $cccQuoteIdx.
!macro CccGetInQuotes STR OUT
  StrCpy ${OUT} ""
  StrCpy $cccQuoteWork "${STR}"
  StrCpy $cccQuoteChar "$cccQuoteWork" 1
  ${If} $cccQuoteChar == '"'
    StrCpy $cccQuoteWork "$cccQuoteWork" "" 1
    StrCpy $cccQuoteIdx 0
    ${Do}
      StrCpy $cccQuoteChar "$cccQuoteWork" 1 $cccQuoteIdx
      ${If} $cccQuoteChar == ""
        StrCpy $cccQuoteIdx 0
        ${ExitDo}
      ${EndIf}
      ${If} $cccQuoteChar == '"'
        ${ExitDo}
      ${EndIf}
      IntOp $cccQuoteIdx $cccQuoteIdx + 1
      ${If} $cccQuoteIdx > 512
        StrCpy $cccQuoteIdx 0
        ${ExitDo}
      ${EndIf}
    ${Loop}
    ${If} $cccQuoteIdx > 0
      StrCpy ${OUT} "$cccQuoteWork" $cccQuoteIdx
    ${EndIf}
  ${EndIf}
!macroend

; ============================================================
; DESTRUCTIVE CLEANUP
; ============================================================

; Delete a directory that is PROVABLY an old install of this app, plus the
; shortcuts that pointed into it.
;
; RMDir /r is irreversible and follows directory junctions — verified with the
; real makensis: a junction made with `mklink /J` had its TARGET tree deleted,
; and ${FileExists} "<junction>\*.*" reports true *through* the junction. A
; matching folder NAME is nowhere near enough on its own. All of these must hold:
;   1. it does not overlap the directory we are installing into. Compared
;      canonically, not with StrCmp: `/S /D=C:\PROGRA~1\CLAUDE~1` gave $INSTDIR
;      an 8.3 spelling that no raw compare against the long form matched, and the
;      just-installed directory was swept;
;   2. it exists;
;   3. it is not a reparse point (junction / symlink / mount point);
;   4. the user's data AND resources directories are both KNOWN. Empty means the
;      overlap test below cannot say anything, not that there is no overlap —
;      measured: PathsOverlap(dir, "") is 0, so an unreadable DataDirectory used
;      to turn the guard off entirely and CONFIG/settings.json was destroyed;
;   5. it does not overlap either of them in either direction — shipped builds
;      defaulted DataDirectory to "$LOCALAPPDATA\Claude Command Center" and
;      ResourcesDirectory to "…\Claude Command Center\resources"
;      (git show 8c0085e:build/installer.nsh), and "Claude Command Center" is a
;      name this sweep looks for, so an install into %LOCALAPPDATA% would
;      otherwise destroy the user's sessions, logs and CONFIG — twenty lines
;      after customInstall adopted that very path;
;   6. it is provably an install root of THIS app (CccProveInstallRoot, or the
;      uninstaller the replaced install recorded), not a source checkout that
;      happens to share the name.
; Expects $R3 = DataDirectory and $R4 = ResourcesDirectory.
; Scratch: $R5 $R6 $R7 $R8 $R9 and $ccc* — never $R2, which customInstall holds.
;
; Known, deliberately out of scope: a junction sitting INSIDE a proven install
; root is still followed by RMDir /r. Logged separately.
!macro RemoveLegacyInstall DIR NAME
  StrCpy $R8 1

  !insertmacro PathsOverlapCanon "${DIR}" "$INSTDIR" $R9
  ${If} $R9 == 1
    StrCpy $R8 0
  ${EndIf}

  ${If} $R8 == 1
  ${AndIfNot} ${FileExists} "${DIR}\*.*"
    StrCpy $R8 0
  ${EndIf}

  ${If} $R8 == 1
    ; Fail closed: GetFileAttributes yields "1", "0", or "" on error, and only a
    ; hard "0" (no reparse attribute) is accepted.
    ${GetFileAttributes} "${DIR}" "REPARSE_POINT" $R9
    ${If} $R9 != 0
      DetailPrint "Refusing to delete a reparse point: ${DIR}"
      StrCpy $R8 0
    ${EndIf}
  ${EndIf}

  ${If} $R8 == 1
    ${If} $R3 == ""
    ${OrIf} $R4 == ""
      DetailPrint "Data/resources directories unknown — refusing to delete ${DIR}"
      StrCpy $R8 0
    ${EndIf}
  ${EndIf}

  ${If} $R8 == 1
    !insertmacro PathsOverlapCanon "${DIR}" "$R3" $R9
    ${If} $R9 == 1
      DetailPrint "Refusing to delete the data directory: ${DIR}"
      StrCpy $R8 0
    ${EndIf}
  ${EndIf}

  ${If} $R8 == 1
    !insertmacro PathsOverlapCanon "${DIR}" "$R4" $R9
    ${If} $R9 == 1
      DetailPrint "Refusing to delete the resources directory: ${DIR}"
      StrCpy $R8 0
    ${EndIf}
  ${EndIf}

  ${If} $R8 == 1
    !insertmacro ProveLegacyInstallRoot "${DIR}" $R9
    ${If} $R9 != 1
      DetailPrint "Not an install of this app, leaving it alone: ${DIR}"
      StrCpy $R8 0
    ${EndIf}
  ${EndIf}

  ${If} $R8 == 1
    DetailPrint "Removing legacy install folder: ${DIR}"
    RMDir /r "${DIR}"
    Delete "$DESKTOP\${NAME}.lnk"
    Delete "$SMPROGRAMS\${NAME}.lnk"
  ${EndIf}
!macroend

; ${OUT} = 1 when ${DIR} is provably an install root of this app.
;
; TWO independent proofs, because either one alone leaves the owner's real case
; unprovable:
;
;   A. an "Uninstall *.exe" FILE at ${DIR} or anywhere down the legacy nesting
;      chain below it (CccProveInstallRoot). Requiring it AT ${DIR} was a
;      regression: in
;        …\Programs\Claude Conductor Beta\Claude Command Center Beta\AI Code Conductor
;      the uninstaller exists ONLY at the leaf, because electron-builder's
;      uninstaller does RMDir /r $INSTDIR before SetOutPath recreates the chain
;      one level deeper — every outer level holds nothing but the next folder.
;      IfFileExists with a wildcard is not recursive (measured), so the proof
;      could never be satisfied on the outer root and several hundred MB of app
;      was left behind with its ARP record already cleared.
;
;   B. the uninstaller the install we are REPLACING recorded, captured by
;      customInit before anything rewrote the record, still on disk and inside
;      ${DIR}. This survives a legacy tree whose chain we cannot walk, and it is
;      strictly stronger than a name match: Windows itself named that file as the
;      way to remove this app.
;
; Scratch: $R5 $R6 $R7 and $ccc* — ${OUT} must not be one of those.
!macro ProveLegacyInstallRoot DIR OUT
  StrCpy $cccProveDir "${DIR}"
  Call CccProveInstallRoot
  StrCpy ${OUT} $cccProveResult

  ${If} ${OUT} != 1
  ${AndIf} $cccLegacyUninstaller != ""
  ${AndIf} ${FileExists} "$cccLegacyUninstaller"
  ${AndIfNot} ${FileExists} "$cccLegacyUninstaller\*.*"
    !insertmacro CanonPathPair "${DIR}" $cccCanonA $cccCanonAS
    !insertmacro CanonPathPair "$cccLegacyUninstaller" $cccCanonB $cccCanonBS
    !insertmacro IsSameOrInside "$cccCanonA" "$cccCanonB" ${OUT}
    ${If} ${OUT} != 1
      !insertmacro IsSameOrInside "$cccCanonAS" "$cccCanonBS" ${OUT}
    ${EndIf}
    ${If} ${OUT} == 1
      DetailPrint "Ownership proved by the recorded uninstaller: $cccLegacyUninstaller"
    ${EndIf}
  ${EndIf}
!macroend

; Drop the recorded previous installation in ${ROOT_KEY}, but only when
; ClassifyUninstallRecord says it is unusable or points into the legacy folder
; this run relocated out of.
;
; Judged per hive, with the caller naming the hive explicitly. appId is frozen,
; so a per-user and a per-machine installation share the same registry key PATH
; but are two SEPARATE installations. Blanket-deleting HKCU from an /allusers run
; would destroy a healthy per-user install's record, and installSection.nsh then
; calls uninstallOldVersion HKEY_CURRENT_USER, reads an empty UninstallString and
; returns — leaving that copy on disk with nothing able to remove it.
; Scratch: $R0 $R1 $R3 $R4 $R9 and $ccc* (via ClassifyUninstallRecord).
!macro ForgetPreviousInstallIn ROOT_KEY
  !insertmacro ClassifyUninstallRecord ${ROOT_KEY}
  ${If} $cccRecordVerdict != ""
    DetailPrint "Clearing the previous uninstall record ($cccRecordVerdict): $cccRecordUninstaller"
    DeleteRegKey ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}"
    ; Dead code for this app: electron-builder only defines
    ; UNINSTALL_REGISTRY_KEY_2 when the GUID contains a backslash
    ; (NsisTarget.js:176-178), and ours is UUID.v5(appId) =
    ; 0210f08e-15d0-5073-901d-684e27f31b7d. Kept so that setting a custom
    ; nsis.guid would still be handled.
    !ifdef UNINSTALL_REGISTRY_KEY_2
      DeleteRegKey ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY_2}"
    !endif
  ${EndIf}
!macroend

; Judge the uninstall record in ${ROOT_KEY}. Sets:
;   $cccRecordUninstaller — the uninstaller path it names ("" if unparseable)
;   $cccRecordVerdict     — "" to keep it, otherwise why it must not be run:
;     "unparseable" / "missing" — electron-builder runs it anyway, retries five
;       times and then shows "$(appCannotBeClosed)" (installUtil.nsh
;       uninstallOldVersion) — a message about the APP being open, raised when
;       the UNINSTALLER failed, with nothing for the user to close. With no
;       UninstallString it returns immediately instead;
;     "legacy" — it points into the legacy folder beside $INSTDIR that this run
;       relocated out of and customInstall is about to delete. Running it is
;       worse than useless: uninstallOldVersion resolves its working directory
;       from ${INSTALL_REGISTRY_KEY}\InstallLocation, which customInit has just
;       RETARGETED at the new $INSTDIR, so the old uninstaller would RMDir /r the
;       directory this run is about to install into.
; Scratch: $R0 $R1 $R3 $R4 $R9 (+ $R5-$R8 via FindLegacyRoot).
!macro ClassifyUninstallRecord ROOT_KEY
  StrCpy $cccRecordVerdict ""
  StrCpy $cccRecordUninstaller ""
  ReadRegStr $R0 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $R0 != ""
    !insertmacro CccGetInQuotes "$R0" $R1
    StrCpy $cccRecordUninstaller "$R1"
    ${If} $R1 == ""
      StrCpy $cccRecordVerdict "unparseable"
    ${ElseIfNot} ${FileExists} "$R1"
      StrCpy $cccRecordVerdict "missing"
    ${Else}
      ${GetParent} "$R1" $R3
      !insertmacro FindLegacyRoot "$R3" $R9
      ${If} $R9 != ""
        ${GetParent} "$R9" $R4
        ${GetParent} "$INSTDIR" $R3
        ${If} $R4 == $R3
          StrCpy $cccRecordVerdict "legacy"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; SHELL_CONTEXT always; HKCU as well on an /allusers run, mirroring
; installSection.nsh, which calls uninstallOldVersion for both.
!macro ForgetBrokenPreviousInstall
  !insertmacro ForgetPreviousInstallIn SHELL_CONTEXT
  ${If} $installMode == "all"
    !insertmacro ForgetPreviousInstallIn HKCU
  ${EndIf}
  ; A ReadRegStr against a key that is not there sets the error flag; do not
  ; leave it set for whatever installSection.nsh does next.
  ClearErrors
!macroend

; Remove ONLY the UninstallString value, remembering it in ${SAVE_VAR} so
; CccRestoreInstallLocation can put it back.
;
; uninstallOldVersion returns immediately when UninstallString is empty
; (installUtil.nsh:156-164), which is the whole point: this is the narrowest
; edit that stops the old uninstaller running, and unlike DeleteRegKey it is
; reversible from a single saved string. registryAddInstallInfo rewrites the
; value a few lines after uninstallOldVersion, so on the success path nothing is
; lost either way.
; Scratch: $R0 $R1 $R3 $R4 $R9 and $ccc* (via ClassifyUninstallRecord).
!macro SuspendUninstallRecordIn HIVE SAVE_VAR
  !insertmacro ClassifyUninstallRecord ${HIVE}
  ${If} $cccRecordVerdict != ""
    ReadRegStr ${SAVE_VAR} ${HIVE} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    DeleteRegValue ${HIVE} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    DetailPrint "Suspended the previous uninstall record ($cccRecordVerdict) so it cannot be aimed at $INSTDIR"
  ${EndIf}
!macroend

; Remember the uninstaller of the install being replaced, before this run
; rewrites any of it. customInstall needs it as proof of ownership, and by then
; the commit point has cleared the record and registryAddInstallInfo has written
; a new one pointing at $INSTDIR.
; Scratch: $R0 $R1 $R3 $R4 $R9 and $ccc* (via ClassifyUninstallRecord).
!macro CaptureRecordedUninstaller
  StrCpy $cccLegacyUninstaller ""
  !insertmacro ClassifyUninstallRecord SHELL_CONTEXT
  StrCpy $cccLegacyUninstaller "$cccRecordUninstaller"
  ${If} $cccLegacyUninstaller == ""
    !insertmacro ClassifyUninstallRecord HKCU
    StrCpy $cccLegacyUninstaller "$cccRecordUninstaller"
  ${EndIf}
  ${If} $cccLegacyUninstaller == ""
    !insertmacro ClassifyUninstallRecord HKLM
    StrCpy $cccLegacyUninstaller "$cccRecordUninstaller"
  ${EndIf}
!macroend

; ============================================================
; CANCEL SAFETY
; ============================================================
; customInit retargets the recorded InstallLocation (see below). That value is
; how BOTH installUtil.nsh's uninstallOldVersion (_?=) and the uninstaller's own
; $INSTDIR are resolved (multiUser.nsh setInstallModePerUser -> uninstaller.nsh
; "RMDir /r $INSTDIR"), so leaving it pointing at a directory that was never
; created would make a later Add/Remove-Programs uninstall delete nothing and
; then drop the entry. Put it back if the wizard never reaches the install. Same
; for the UninstallString the elevated inner instance suspends.
;
; MUI2 defines Function .onUserAbort itself (Interface.nsh
; MUI_FUNCTION_ABORTWARNING, inserted by MUI_LANGUAGE), so this hooks its
; documented callback rather than defining a second one — two definitions would
; not compile. The define has to be in place before electron-builder's
; `!insertmacro addLangs`, which is why it sits at file scope rather than in
; customHeader.
;
; Known, deliberately out of scope: the Quit paths that leave .onInit without
; going through MUI's abort callback still skip this. Logged separately.
!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_ABORT "CccRestoreInstallLocation"
!endif

; customHeader is inserted by installer.nsi at file scope AFTER multiUser.nsh, so
; ${INSTALL_REGISTRY_KEY} resolves here — it does not at the top of this file.
!macro customHeader
  ; CanonPathPair's scratch, in BOTH passes: the installer pass compares paths
  ; in customInit and customInstall, the uninstaller pass in
  ; RemoveUserHelperFolder (customUnInstall). Each pass uses every one of them,
  ; so -WX has nothing to warn about in either.
  Var cccCanonA
  Var cccCanonAS
  Var cccCanonB
  Var cccCanonBS
  Var cccCanonWork
  Var cccCanonChar
  Var cccCanonIdx
  Var cccCanonTmp

  !ifndef BUILD_UNINSTALLER
    Var cccSavedPerUserInstallLocation
    Var cccSavedPerMachineInstallLocation
    Var cccSavedPerUserUninstallString
    Var cccSavedPerMachineUninstallString

    Var cccLegacyUninstaller
    Var cccRecordVerdict
    Var cccRecordUninstaller

    Var cccQuoteWork
    Var cccQuoteChar
    Var cccQuoteIdx

    Var cccProveDir
    Var cccProveResult
    Var cccProveCur
    Var cccProveName
    Var cccProveHandle
    Var cccProveHit
    Var cccProveFlag
    Var cccProvePending
    Var cccProveSeen

    Function CccRestoreInstallLocation
      ${If} $cccSavedPerUserInstallLocation != ""
        WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$cccSavedPerUserInstallLocation"
        StrCpy $cccSavedPerUserInstallLocation ""
      ${EndIf}
      ${If} $cccSavedPerMachineInstallLocation != ""
        WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$cccSavedPerMachineInstallLocation"
        StrCpy $cccSavedPerMachineInstallLocation ""
      ${EndIf}
      ${If} $cccSavedPerUserUninstallString != ""
        WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString" "$cccSavedPerUserUninstallString"
        StrCpy $cccSavedPerUserUninstallString ""
      ${EndIf}
      ${If} $cccSavedPerMachineUninstallString != ""
        WriteRegStr HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString" "$cccSavedPerMachineUninstallString"
        StrCpy $cccSavedPerMachineUninstallString ""
      ${EndIf}
    FunctionEnd

    Function .onInstFailed
      Call CccRestoreInstallLocation
    FunctionEnd

    ; $cccProveResult = 1 when $cccProveDir, or a legacy-chain folder below it,
    ; holds an "Uninstall *.exe" FILE.
    ;
    ; A FILE, checked by name through FindFirst: IfFileExists with a wildcard is
    ; FindFirstFile, which matches DIRECTORIES too — measured, a directory called
    ; "Uninstall whatever.exe\" satisfied the old proof and the sibling source
    ; checkout was deleted.
    ;
    ; The descent is a depth-first walk over the NSIS stack, bounded to 24 nodes,
    ; and it only ever steps into a folder whose NAME can be a link in a nesting
    ; chain (IsChainFolder) — the same bound FindLegacyRoot climbs. Anything
    ; wider would let an unrelated vendored installer somewhere under a source
    ; checkout prove ownership of the checkout. Reparse points are skipped so a
    ; junction cannot manufacture a proof out of a tree that lives elsewhere.
    Function CccProveInstallRoot
      StrCpy $cccProveResult 0
      StrCpy $cccProveSeen 0
      StrCpy $cccProvePending 1
      Push "$cccProveDir"

      ${Do}
        ${If} $cccProvePending < 1
          ${ExitDo}
        ${EndIf}
        Pop $cccProveCur
        IntOp $cccProvePending $cccProvePending - 1
        IntOp $cccProveSeen $cccProveSeen + 1
        ${If} $cccProveSeen > 24
          ${ExitDo}
        ${EndIf}

        StrCpy $cccProveHit 0
        ClearErrors
        FindFirst $cccProveHandle $cccProveName "$cccProveCur\Uninstall *.exe"
        ${Do}
          ${If} $cccProveName == ""
            ${ExitDo}
          ${EndIf}
          ${IfNot} ${FileExists} "$cccProveCur\$cccProveName\*.*"
            StrCpy $cccProveHit 1
            ${ExitDo}
          ${EndIf}
          FindNext $cccProveHandle $cccProveName
        ${Loop}
        FindClose $cccProveHandle
        ClearErrors

        ${If} $cccProveHit == 1
          StrCpy $cccProveResult 1
          ${ExitDo}
        ${EndIf}

        ClearErrors
        FindFirst $cccProveHandle $cccProveName "$cccProveCur\*.*"
        ${Do}
          ${If} $cccProveName == ""
            ${ExitDo}
          ${EndIf}
          ${If} $cccProveName != "."
          ${AndIf} $cccProveName != ".."
          ${AndIf} ${FileExists} "$cccProveCur\$cccProveName\*.*"
            !insertmacro IsChainFolder "$cccProveName" $cccProveFlag
            ${If} $cccProveFlag == 1
              ${GetFileAttributes} "$cccProveCur\$cccProveName" "REPARSE_POINT" $cccProveHit
              ${If} $cccProveHit == 0
                Push "$cccProveCur\$cccProveName"
                IntOp $cccProvePending $cccProvePending + 1
              ${EndIf}
            ${EndIf}
          ${EndIf}
          FindNext $cccProveHandle $cccProveName
        ${Loop}
        FindClose $cccProveHandle
        ClearErrors
      ${Loop}

      ; Whatever is still queued has to come off the stack, or the caller's
      ; frame is corrupt.
      ${Do}
        ${If} $cccProvePending < 1
          ${ExitDo}
        ${EndIf}
        Pop $cccProveCur
        IntOp $cccProvePending $cccProvePending - 1
      ${Loop}
    FunctionEnd
  !endif
!macroend

; ============================================================
; REMOVALS WAITING FOR THE NEXT RESTART
; ============================================================
; An all-users uninstall sets what it could not remove (a file another
; user's running copy holds) to go when Windows next restarts
; (CccReportLeftFiles). That removal names paths, not files: an install into
; the same folder before the restart would lose the new files at those paths
; when it comes. So an all-users install stops first when one is waiting.

; ${OUT} = 1 when Windows has a file operation waiting for its next restart
; on ${DIR} or a path inside it, 0 when it has none there, 2 when the list
; could not be read. MoveFileEx with MOVEFILE_DELAY_UNTIL_REBOOT, and so
; RMDir /REBOOTOK, puts each one in PendingFileRenameOperations under
; HKLM\SYSTEM\CurrentControlSet\Control\Session Manager: a REG_MULTI_SZ of
; pairs, a path and where it goes ("" to remove it; a leading "!" means
; replace). Every path in it counts, on either side of a pair. What comes in
; front of the path is taken off before it is compared: every leading "!",
; and every leading "*" with the digits after it, in either order, then one
; "\??\". Windows 11 (build 22621) was seen to write every entry with a "*1"
; in front of its "\??\" ("*1\??\C:\..."); the plain form ("\??\C:\...") and
; the "!" form are read as before. ReadRegStr cannot read a REG_MULTI_SZ, so
; the value is read whole through advapi32 into a zeroed buffer with room to
; spare and two nulls of its own after it, so the walk always ends inside it.
; An entry longer than NSIS_MAX_STRLEN is compared by its first part, which
; still starts with ${DIR} when the entry is inside it. Paths are compared
; through IsSameOrInsideCanon. Saves and restores every register; ${OUT} may
; be any, ${DIR} must not be $0 to $9 or $R5 to $R7. Scratch: $cccCanon*.
!macro CccPendingRemovalIn DIR OUT
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R5
  Push $R6
  Push $R7
  StrCpy $0 2
  StrCpy $1 0
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000002, w "SYSTEM\CurrentControlSet\Control\Session Manager", i 0, i 0x20119, *p .r1) i .r2'
  ${If} $2 == 2
    ; ERROR_FILE_NOT_FOUND: no such key, so nothing is waiting.
    StrCpy $0 0
  ${ElseIf} $2 == 0
    StrCpy $3 0
    StrCpy $6 0
    System::Call 'advapi32::RegQueryValueExW(p r1, w "PendingFileRenameOperations", p 0, *i .r6, p 0, *i r3 r3) i .r2'
    ${If} $2 == 2
      ; ERROR_FILE_NOT_FOUND: nothing is waiting.
      StrCpy $0 0
    ${ElseIf} $2 == 0
    ${AndIf} $6 == 7
    ${AndIf} $3 >= 0
    ${AndIf} $3 < 16777216
      ; Room for entries added since the size was read, and two nulls after.
      IntOp $3 $3 + 4096
      IntOp $8 $3 + 4
      System::Alloc $8
      Pop $4
      ${If} $4 != 0
        System::Call 'advapi32::RegQueryValueExW(p r1, w "PendingFileRenameOperations", p 0, *i .r6, p r4, *i r3 r3) i .r2'
        ${If} $2 == 0
        ${AndIf} $6 == 7
          StrCpy $0 0
          StrCpy $5 0
          ${DoWhile} $5 < $3
            IntOp $9 $4 + $5
            System::Call 'kernel32::lstrlenW(p r9) i .r6'
            ${If} $6 > 0
              System::Call 'kernel32::lstrcpynW(w .r7, p r9, i ${NSIS_MAX_STRLEN}) p'
              ; Every leading "!", and every leading "*" with its digits.
              ${Do}
                StrCpy $9 "$7" 1
                ${If} $9 == "!"
                  StrCpy $7 "$7" "" 1
                ${ElseIf} $9 == "*"
                  StrCpy $7 "$7" "" 1
                  ${Do}
                    ; A digit reads back as the same number; any other
                    ; character, and the end of the entry, does not.
                    StrCpy $9 "$7" 1
                    IntOp $8 $9 + 0
                    ${If} $8 != $9
                      ${ExitDo}
                    ${EndIf}
                    StrCpy $7 "$7" "" 1
                  ${Loop}
                ${Else}
                  ${ExitDo}
                ${EndIf}
              ${Loop}
              StrCpy $9 "$7" 4
              ${If} $9 == "\??\"
                StrCpy $7 "$7" "" 4
              ${EndIf}
              !insertmacro IsSameOrInsideCanon "${DIR}" "$7" $9
              ${If} $9 == 1
                StrCpy $0 1
                ${ExitDo}
              ${EndIf}
            ${EndIf}
            IntOp $6 $6 + 1
            IntOp $6 $6 * 2
            IntOp $5 $5 + $6
          ${Loop}
        ${EndIf}
        System::Free $4
      ${EndIf}
    ${EndIf}
    System::Call 'advapi32::RegCloseKey(p r1)'
  ${EndIf}
  ClearErrors
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Exch $0
  Pop ${OUT}
!macroend

; Stops the run, with a box, when Windows has a removal waiting for its next
; restart in ${DIR} (CccPendingRemovalIn): Setup puts back what customInit
; changed (CccRestoreInstallLocation) and exits with code 2 before anything
; is installed. A silent run answers the box by itself and stops too. With
; ${DETAILS} 1 it also writes to the details list; 0 where that list does
; not exist yet (.onInit). A list that could not be read is no reason to
; stop. Installer pass only. Saves and restores $R0.
!macro CccStopOnPendingRemoval DIR DETAILS
  Push $R0
  !insertmacro CccPendingRemovalIn "${DIR}" $R0
  ${If} $R0 == 1
    MessageBox MB_OK|MB_ICONEXCLAMATION "Restart Windows before you install AI Code Conductor in this folder again.$\n$\nAn earlier uninstall set files in ${DIR} to be removed when Windows next restarts, and that would remove the new ones too." /SD IDOK
    !if ${DETAILS} == 1
      DetailPrint "An earlier uninstall set files in ${DIR} to be removed when Windows next restarts, so nothing was installed. Restart Windows, then run Setup again."
    !endif
    Call CccRestoreInstallLocation
    SetErrorLevel 2
    Quit
  ${EndIf}
  !if ${DETAILS} == 1
    ${If} $R0 == 2
      DetailPrint "Could not read what Windows will remove at its next restart, so that was not checked."
    ${EndIf}
  !endif
  Pop $R0
!macroend

; ============================================================
; APP-RUNNING CHECK — also the install's commit point
; ============================================================

; electron-builder's CHECK_APP_RUNNING inserts this in both passes: at the top
; of the install section, and in the uninstaller's un.checkAppRunning. It
; closes a running copy of the app before files are replaced or removed, and
; only this user's copies from this install's folder (CccCloseAppCopies, with
; the process macros beside CccScanProcesses below): another user's copy, or
; one started from another folder, keeps running, and the details log says so.
; In the installer pass the folder of the install this run replaces counts
; too: an UPGRADE from a pre-rename build still has the old executable name
; running there, and that copy's file locks would fail the install.
;
; No tasklist, taskkill, WMI or PowerShell. Over a non-interactive sign-in
; (SSH, a scheduled task) tasklist and taskkill answer "Access denied"
; (measured on the VM, see CccScanProcesses), so the old check found nothing
; and closed nothing there; and an elevated run's `taskkill /im` asked every
; signed-in user's copy to close.
;
; The folder of the install this run replaces is the one its uninstall record
; names in SHELL_CONTEXT, the hive this run installs to: the record
; uninstallOldVersion runs next, or, for a legacy tree beside $INSTDIR, the
; one the commit point drops before customInstall's sweep removes that tree.
; Not $cccLegacyUninstaller: customInit falls back to the other hives for it,
; as the sweep's proof of ownership, so on a per-user run it can name an
; all-users install that this run neither uninstalls nor sweeps. An all-users
; run also runs the HKCU record's uninstaller (installSection.nsh); a copy
; running from that per-user folder is left to that uninstaller's own check.
;
; Not covered either: a legacy-named copy running from one of the sibling
; folders customInstall's sweep removes (RemoveLegacyInstall, proved by
; ProveLegacyInstallRoot) when no uninstall record in this hive names that
; folder. It keeps running, and the sweep cannot remove the files it holds.
;
; If a copy is still running after that, the box lets the user deal with it
; and Retry, which runs the whole check again, or Cancel. That is a copy
; asking whether to save its sessions (in a run someone can see, a copy that
; was asked to close is not ended: CccCloseAppCopies), or one this installer
; could not end, or a copy from this folder whose user it could not read
; (this user's copy started as administrator, say, seen from an installer
; that is not; whether Windows lets such an installer see that copy at all is
; a release-smoke check). A silent run answers Cancel, as electron-builder's
; own check does: nobody is there to answer the box, and an unanswered box
; would keep a remote or scheduled install waiting forever. When the check
; itself could not run (this copy's own user, or the running programs, could
; not be read), a second box asks whether to carry on, and a silent run
; stops. Either way a run that stops says so in the details log, puts back
; what customInit changed (installer pass) and exits with code 2.
;
; Before all that, an all-users install (installer pass) stops when an
; earlier uninstall set files in this folder to be removed at the next
; restart: that restart would remove the new files too (CccReportLeftFiles,
; CccStopOnPendingRemoval). A per-user uninstall never sets one.
!macro customCheckAppRunning
  DetailPrint "=== customCheckAppRunning: this user's copies from this install's folder ==="

  !ifndef BUILD_UNINSTALLER
    ${If} $installMode == "all"
      !insertmacro CccStopOnPendingRemoval "$INSTDIR" 1
    ${EndIf}
  !endif

  Push $R0
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $R0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    !insertmacro CccGetInQuotes "$R0" $cccRecordUninstaller
    ClearErrors
  !endif
  cccAppStillRunning:
  !ifndef BUILD_UNINSTALLER
    !insertmacro CccCloseAppCopies "$cccRecordUninstaller"
  !else
    !insertmacro CccCloseAppCopies ""
  !endif
  ${If} $R0 == 1
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "AI Code Conductor is still running.$\n$\nIf it is asking whether to save your sessions, answer it first. Otherwise close it yourself.$\n$\nThen click Retry." /SD IDCANCEL IDRETRY cccAppStillRunning
    !ifndef BUILD_UNINSTALLER
      DetailPrint "AI Code Conductor is still running, so nothing was installed."
    !else
      DetailPrint "AI Code Conductor is still running, so nothing was removed."
    !endif
  ${ElseIf} $R0 == 2
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Could not check whether AI Code Conductor is running.$\n$\nClose it if it is open, then click OK to carry on." /SD IDCANCEL IDOK cccAppCheckCarryOn
    !ifndef BUILD_UNINSTALLER
      DetailPrint "Could not check whether AI Code Conductor is running, so nothing was installed."
    !else
      DetailPrint "Could not check whether AI Code Conductor is running, so nothing was removed."
    !endif
  ${EndIf}
  ${If} $R0 != 0
    !ifndef BUILD_UNINSTALLER
      Call CccRestoreInstallLocation
    !endif
    SetErrorLevel 2
    Quit
  ${EndIf}
  cccAppCheckCarryOn:
  ${If} $R0 == 0
    DetailPrint "No copy of AI Code Conductor is running from this install's folder. Proceeding."
  ${Else}
    DetailPrint "Carrying on without the check, as chosen in the box."
  ${EndIf}
  Pop $R0

  !ifndef BUILD_UNINSTALLER
    ; ---- COMMIT POINT -----------------------------------------------------
    ; installSection.nsh inserts CHECK_APP_RUNNING at the top of the install
    ; section — after every wizard page, after the user pressed Install, and
    ; immediately before uninstallOldVersion, which is the only place the
    ; recorded uninstaller is ever invoked. That makes it the earliest point at
    ; which dropping the record cannot strand anyone: registryAddInstallInfo
    ; rewrites it a few lines later, and a normal electron-builder upgrade drops
    ; it here anyway (the old uninstaller deletes the key itself).
    ;
    ; This used to run from customInit, i.e. inside .onInit, BEFORE the licence,
    ; install-mode, directory and data-directory pages — so cancelling the wizard
    ; or declining UAC left the app fully installed with no Add/Remove Programs
    ; entry at all, uninstallable by neither the user nor an MDM.
    ;
    ; installSection.nsh guards this whole macro with ${ifNot}
    ; ${UAC_IsInnerInstance}, so an /allusers install that had to elevate never
    ; reaches this line. customInit covers that case with the narrower,
    ; reversible SuspendUninstallRecordIn.
    !insertmacro ForgetBrokenPreviousInstall
  !endif
!macroend

; ============================================================
; UPGRADE RELOCATION — move a legacy-named install folder to the new brand
; ============================================================
; The executable is now "AI Code Conductor.exe", which changes ${APP_FILENAME}.
; electron-builder's assisted installer runs instFilesPre AFTER this macro and
; unconditionally appends ${APP_FILENAME} to any $INSTDIR that does not already
; contain it — so an upgrade seeded with the old
;   …\Programs\Claude Command Center
; would otherwise be installed NESTED at
;   …\Programs\Claude Command Center\AI Code Conductor.
; initMultiUser has already seeded $INSTDIR from the previous installation by the
; time customInit runs (installer.nsi inserts it first), so we point $INSTDIR at
;   …\Programs\AI Code Conductor
; instead, and customInstall removes what is left behind.

; Setting $INSTDIR is NOT enough on its own. $INSTDIR is seeded from
; ${INSTALL_REGISTRY_KEY}\InstallLocation, and on any interactive (non-/S) run
; that read happens AGAIN after customInit: oneClick:false defines
; INSTALL_MODE_PER_ALL_USERS_REQUIRED (NsisTarget.js:445-446), so the
; install-mode page exists, and both its Leave callback (multiUserUi.nsh:184,187)
; and every skip path in its Pre (:35,:55,:63) re-run setInstallModePerUser /
; setInstallModePerAllUsers, which do
;   ReadRegStr … "${INSTALL_REGISTRY_KEY}" InstallLocation / StrCpy $INSTDIR …
; (multiUser.nsh:26-28, :75-77). The in-app updater launches the installer with
; NO arguments (src/main/ipc/update-handlers.ts), so auto-update IS that
; interactive path — and installSection.nsh:117 re-runs setInstallModePerAllUsers
; even under /S for a per-machine upgrade. The recorded value therefore has to
; stop naming the legacy tree, or the relocation is undone before a single file
; is written, while the uninstall record has already been dropped.
;
; It is RETARGETED rather than deleted so a custom install location keeps its
; parent: deleting makes setInstallMode* fall through to
; $LocalAppData\Programs\${APP_FILENAME} (multiUser.nsh:47), silently moving an
; install that lived on another drive. Both hives are handled because
; setInstallModePerUser reads HKCU and setInstallModePerAllUsers reads HKLM, and
; the install-mode page lets the user switch between them. /D= still wins either
; way — both macros apply GetDParameter AFTER this read (multiUser.nsh:50-54,
; :93-97).
;
; Only a record that points INTO the legacy tree being left behind is touched,
; and the previous value is remembered so CccRestoreInstallLocation can put it
; back if the wizard is cancelled.
!macro RetargetRecordedInstallLocation HIVE LEGACY_ROOT SAVE_VAR
  ReadRegStr $R3 ${HIVE} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R3 != ""
    !insertmacro IsSameOrInside "${LEGACY_ROOT}" "$R3" $R2
    ${If} $R2 == 1
      StrCpy ${SAVE_VAR} "$R3"
      WriteRegStr ${HIVE} "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
      DetailPrint "Recorded install location retargeted: $R3 -> $INSTDIR"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  ; ---- 0. Remember what the previous install recorded ---------------------
  ; Read before this run touches anything: customCheckAppRunning clears the
  ; record at the commit point and registryAddInstallInfo replaces it, so by the
  ; time customInstall wants to prove which folder is the old install, the only
  ; copy of the answer is this variable.
  !insertmacro CaptureRecordedUninstaller

  ; ---- 1. An explicit /D= is the operator's choice ------------------------
  ; initMultiUser applies /D= last, so $INSTDIR already holds the requested
  ; directory by the time this runs. Relocating it — and then letting
  ; customInstall consider its siblings for deletion — would silently override a
  ; path someone asked for by hand. The in-app updater passes no arguments, so
  ; this never suppresses the relocation on the path that actually matters.
  !insertmacro GetDParameter $R0
  ${If} $R0 != ""
    DetailPrint "Explicit /D= install directory — leaving $INSTDIR alone"
  ${Else}
    ; ---- 2. Find the OUTERMOST legacy folder in $INSTDIR's path -----------
    !insertmacro FindLegacyRoot "$INSTDIR" $R9

    ${If} $R9 != ""
      ; A legacy tree. Relocate beside it, never inside it: the parent of the
      ; OUTERMOST legacy folder is the real install root (…\Programs).
      ${GetParent} "$R9" $R4
      DetailPrint "Relocating install out of legacy folder: $R9"
      ; Set the FINAL path here rather than just stepping up to the parent and
      ; letting instFilesPre append. A silent install (/S) skips MUI pages, so
      ; the page PRE callbacks never fire — leaving $INSTDIR at the parent would
      ; then install straight into …\Programs. Writing the full path is correct
      ; in both modes, and makes instFilesPre's check a no-op because the name is
      ; already present.
      StrCpy $INSTDIR "$R4\${APP_FILENAME}"

      ; ---- 3. Stop the install-mode page undoing it ----------------------
      !insertmacro RetargetRecordedInstallLocation HKCU "$R9" $cccSavedPerUserInstallLocation
      !insertmacro RetargetRecordedInstallLocation HKLM "$R9" $cccSavedPerMachineInstallLocation

      ; ---- 4. The elevated inner instance never reaches the commit point --
      ; installSection.nsh:35-37 guards CHECK_APP_RUNNING with ${ifNot}
      ; ${UAC_IsInnerInstance}, so ForgetBrokenPreviousInstall does not run in
      ; the elevated instance — while the retarget above DOES, because customInit
      ; is inserted unguarded (installer.nsi:79-81) and the HKLM value can only
      ; be written by the elevated instance in the first place. Left alone, the
      ; next thing that instance does is uninstallOldVersion, which reads the
      ; retargeted InstallLocation, runs the OLD uninstaller with _?=<new dir>,
      ; and that uninstaller does RMDir /r $INSTDIR on the directory this run is
      ; about to install into.
      ;
      ; So the record is suspended here instead — the narrowest possible edit
      ; (one value), remembered and restored by CccRestoreInstallLocation if the
      ; wizard the inner instance is still going to show gets cancelled. Both
      ; hives, because installSection.nsh calls uninstallOldVersion for
      ; SHELL_CONTEXT and, on an /allusers run, HKEY_CURRENT_USER as well.
      ${If} ${UAC_IsInnerInstance}
        !insertmacro SuspendUninstallRecordIn HKCU $cccSavedPerUserUninstallString
        !insertmacro SuspendUninstallRecordIn HKLM $cccSavedPerMachineUninstallString
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; ---- 5. The elevated inner instance runs the app check here -------------
  ; installSection.nsh:34-37 skips CHECK_APP_RUNNING (customCheckAppRunning)
  ; in the elevated inner instance of an all-users install that asked for
  ; administrator approval, so nothing there closed a running copy: with no
  ; uninstall record to run (one suspended above, a missing or broken one)
  ; the files it holds failed the install, and with one, its uninstaller's
  ; own check stopped the install with a bare "uninstall failed" box. So the
  ; same check and box run here, after the retarget and the suspend and
  ; before anything is installed, and a stop puts both back
  ; (CccRestoreInstallLocation). The commit point does not move: it stays
  ; in customCheckAppRunning, which this instance never runs.
  ; This instance installs for all users, so the install it replaces is the
  ; one the all-users record names, read here or as suspended above. Two
  ; folders are checked, because $INSTDIR is not yet final here: where
  ; initMultiUser put it (assistedInstaller.nsh initMultiUser; the per-user
  ; folder when both installs are recorded, or when neither is), and the
  ; folder this instance moves it to when it passes the install-mode page
  ; (multiUserUi.nsh, setInstallModePerAllUsers): the all-users record's
  ; InstallLocation, else Program Files\${APP_FILENAME}, with /D= last, as
  ; multiUser.nsh works it out. The folder page after that can still change
  ; it; a folder chosen there is not checked.
  ; The installer is elevated, so the check's elevated rules apply: another
  ; user's copy keeps running. That includes the user who started Setup when
  ; an administrator's name and password were typed into the approval box:
  ; this instance then runs as that administrator, so the starting user's
  ; copy counts as another user's. It is not closed, the box does not
  ; appear, and its files fail the install as before.
  ; This runs in .onInit, before the window with the details list exists,
  ; so no details line is written here (CccCloseAppCopies's own lines are
  ; not shown either): what the user sees is the box.
  ; First of all, a removal an earlier uninstall set for the next restart in
  ; either folder stops the run (CccStopOnPendingRemoval).
  ${If} ${UAC_IsInnerInstance}
    Push $R0
    Push $R1
    Push $R2
    ReadRegStr $R1 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $R1 == ""
      StrCpy $R1 "$PROGRAMFILES"
      !ifdef APP_64
        ${If} ${RunningX64}
          StrCpy $R1 "$PROGRAMFILES64"
        ${EndIf}
      !endif
      !ifdef MENU_FILENAME
        StrCpy $R1 "$R1\${MENU_FILENAME}"
      !endif
      StrCpy $R1 "$R1\${APP_FILENAME}"
    ${EndIf}
    !insertmacro GetDParameter $R2
    ${If} $R2 != ""
      StrCpy $R1 "$R2"
    ${EndIf}
    ClearErrors
    !insertmacro CccStopOnPendingRemoval "$INSTDIR" 0
    ${If} $R1 != "$INSTDIR"
      !insertmacro CccStopOnPendingRemoval "$R1" 0
    ${EndIf}
    ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${If} $R0 == ""
      StrCpy $R0 "$cccSavedPerMachineUninstallString"
    ${EndIf}
    !insertmacro CccGetInQuotes "$R0" $cccRecordUninstaller
    ClearErrors
    cccInnerAppStillRunning:
    !insertmacro CccCloseAppCopies "$cccRecordUninstaller"
    ; Then the folder this instance installs into, when it is another one: a
    ; copy still running there wins, and so does a check that could not run.
    ${If} $R0 != 1
    ${AndIf} $R1 != "$INSTDIR"
      StrCpy $R2 $R0
      Push $INSTDIR
      StrCpy $INSTDIR "$R1"
      !insertmacro CccCloseAppCopies ""
      Pop $INSTDIR
      ${If} $R0 == 0
        StrCpy $R0 $R2
      ${EndIf}
    ${EndIf}
    ${If} $R0 == 1
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "AI Code Conductor is still running.$\n$\nIf it is asking whether to save your sessions, answer it first. Otherwise close it yourself.$\n$\nThen click Retry." /SD IDCANCEL IDRETRY cccInnerAppStillRunning
    ${ElseIf} $R0 == 2
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Could not check whether AI Code Conductor is running.$\n$\nClose it if it is open, then click OK to carry on." /SD IDCANCEL IDOK cccInnerAppCheckCarryOn
    ${EndIf}
    ${If} $R0 != 0
      Call CccRestoreInstallLocation
      SetErrorLevel 2
      Quit
    ${EndIf}
    cccInnerAppCheckCarryOn:
    Pop $R2
    Pop $R1
    Pop $R0
  ${EndIf}
  ; The uninstall RECORD is otherwise deliberately NOT touched here — see the
  ; commit point in customCheckAppRunning for why it can only be cleared once the
  ; install is actually going ahead.
  ;
  ; A ReadRegStr against a key that is not there sets the error flag, and .onInit
  ; hands straight over to the wizard; do not leave it set.
  ClearErrors
!macroend

; Write registry entries after install + migrate from old key
!macro customInstall
  ; --- Adopt settings from either legacy key into the current brand key ---
  ; Newest legacy key first so a newer value never loses to an older one. Values
  ; are only copied where the brand key does not already have one, and the legacy
  ; keys are left in place (the app deletes only the original one — see
  ; registry.ts) so a rollback can still resolve the data directory.
  ;
  ; This runs BEFORE the sweep on purpose: ReadUserPath below is what keeps the
  ; sweep away from the user's data, and on an upgrade the only place those paths
  ; exist yet is a legacy key.
  !insertmacro AdoptLegacyValue "DataDirectory"
  !insertmacro AdoptLegacyValue "ResourcesDirectory"
  !insertmacro AdoptLegacyValue "SourcePath"
  !insertmacro AdoptLegacyValue "UpdateServer"

  ; Always record the install path under the current brand key.
  WriteRegStr HKCU "Software\AI Code Conductor" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "Software\AI Code Conductor" "SourcePath" ""

  ; The uninstall record names the install folder too, for whatever reads
  ; the installed programs list for it (winget, Get-Package, a script).
  ; electron-builder writes InstallLocation only under its own key. Same
  ; hive as the record (SHELL_CONTEXT), so the uninstaller's removal of the
  ; record takes this value with it.
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"

  ; --- Remove a legacy install folder sitting beside this one ---
  ; Only application binaries live there; user data lives in the data and
  ; resources directories, which RemoveLegacyInstall refuses to touch. appId is
  ; frozen, so this install has already overwritten the single uninstall entry to
  ; point at $INSTDIR — leaving the old folder would just orphan a copy that
  ; nothing can uninstall.
  ;
  ; RMDir /r on the OUTERMOST legacy folder takes any nested tree with it, which
  ; is what clears the
  ;   …\Claude Conductor Beta\Claude Command Center Beta\AI Code Conductor
  ; shape that the old two-name check let accumulate. RemoveLegacyInstall refuses
  ; to touch $INSTDIR itself, so relocating first (customInit) is what makes this
  ; reachable at all — and it demands positive proof of ownership before deleting
  ; anything, because a name match alone would also match a source checkout, a
  ; junction, or the user's data directory.
  ;
  ; An explicit /D= skips the sweep entirely, for the same reason customInit
  ; skips the relocation: the siblings of a hand-picked directory are not this
  ; installer's business, and $INSTDIR may then be spelt in a form ($INSTDIR as
  ; an 8.3 short name) that no comparison here should have to survive.
  !insertmacro GetDParameter $R0
  ${If} $R0 != ""
    DetailPrint "Explicit /D= install directory — skipping the legacy folder sweep"
  ${Else}
    !insertmacro ReadUserPath "DataDirectory" $R3
    !insertmacro ReadUserPath "ResourcesDirectory" $R4

    ${GetParent} "$INSTDIR" $R2
    !insertmacro RemoveLegacyInstall "$R2\Claude Conductor Beta" "Claude Conductor Beta"
    !insertmacro RemoveLegacyInstall "$R2\Claude Command Center Beta" "Claude Command Center Beta"
    !insertmacro RemoveLegacyInstall "$R2\Claude Command Center" "Claude Command Center"
    !insertmacro RemoveLegacyInstall "$R2\Claude Conductor" "Claude Conductor"
  ${EndIf}
  ClearErrors
!macroend

; Copy one setting forward into the current brand key if it does not have one
; yet, looking through the legacy keys newest-first.
!macro AdoptLegacyValue NAME
  ReadRegStr $R1 HKCU "Software\AI Code Conductor" "${NAME}"
  ${If} $R1 == ""
    ReadRegStr $R0 HKCU "Software\Claude Command Center" "${NAME}"
    ${If} $R0 == ""
      ReadRegStr $R0 HKCU "Software\Claude Conductor" "${NAME}"
    ${EndIf}
    ${If} $R0 != ""
      WriteRegStr HKCU "Software\AI Code Conductor" "${NAME}" $R0
      DetailPrint "  Adopted ${NAME}: $R0"
    ${EndIf}
  ${EndIf}
!macroend

; ============================================================
; CUSTOM PAGES — directory selection for Data and Resources
; ============================================================
!include "MUI2.nsh"
!include "FileFunc.nsh"

; ============================================================
; PLUGIN ANSWERS: asked once in .onInit, read by the pages
; ============================================================
; The pages below need two answers: is this the elevated inner instance
; (${UAC_IsInnerInstance}, the UAC plugin), and did the updater start this run
; (${isUpdated}, which electron-builder builds on the StdUtils plugin). Both
; plugins live in electron-builder's nsis-resources folder, not in NSIS's own
; Plugins folder. electron-builder adds that folder to the plugin path and
; includes this file from two tasks that run at the same time (app-builder-lib
; NsisTarget.js, computeCommonInstallerScriptHeader), so either line can come
; first in the generated script. A Function at file scope here is compiled
; when this file is included, so a plugin call inside one fails the build with
; "Plugin not found" whenever the include comes first. A macro body is
; compiled where it is inserted instead, and installer.nsi inserts preInit
; inside .onInit, after the whole header, when the folder is always on the
; plugin path.
;
; So preInit asks both questions once and the pages read the answers from
; these variables. preInit is the first hook in .onInit, and .onInit runs
; before .onGUIInit and before every page, so the answers are there before
; anything reads them. Neither can change while Setup runs: both come from how
; the process was started. Not customInit: the makensis probe
; (installer-nsis-behaviour.test.ts) lifts that macro verbatim and has no
; StdUtils. installer-branding-guard.test.ts fails on a plugin call from these
; plugins at file scope.
!ifndef BUILD_UNINSTALLER
  Var cccIsInnerInstance
  Var cccIsUpdated
!endif

!macro preInit
  !ifndef BUILD_UNINSTALLER
    ; ${isUpdated} writes $R9; leave it as it was.
    Push $R9
    StrCpy $cccIsInnerInstance 0
    ${If} ${UAC_IsInnerInstance}
      StrCpy $cccIsInnerInstance 1
    ${EndIf}
    StrCpy $cccIsUpdated 0
    ${If} ${isUpdated}
      StrCpy $cccIsUpdated 1
    ${EndIf}
    Pop $R9
  !endif
!macroend

; ============================================================
; BRANDING: stock light dialog, artwork, light motion, fresh-install splash
; ============================================================
; The art is drawn from the boot splash by scripts/gen-installer-art.mjs and
; committed under build/ (installerSidebar.bmp, installerHeader.bmp,
; installerSplash.bmp, installer-art/). package.json names the sidebar and the
; header explicitly, so a missing file fails the build instead of silently
; shipping NSIS's stock bitmap.
;
; ORDER. This file is compiled ahead of electron-builder's installer.nsi, so
; the Welcome page below is page 1 and the two folder pages stay pages 2 and 3.
; Modern UI reads its interface settings (MUI_BGCOLOR and the like) when the
; FIRST page macro is inserted, which is now MUI_PAGE_WELCOME. This file sets
; none of them now (NO COLOURS OF OUR OWN, below); one added later has to come
; before MUI_PAGE_WELCOME, or Modern UI ignores it without a word.
; MUI_CUSTOMFUNCTION_GUIINIT is read when addLangs inserts the language,
; after all of this. None of it may move into customHeader,
; customInit or customInstall: those macros are lifted verbatim into the
; makensis probe (tests/unit/main/installer-nsis-behaviour.test.ts).
;
; TWO PASSES. electron-builder compiles this file twice, once for the installer
; and once with BUILD_UNINSTALLER for the uninstaller, both with -WX. A Function
; or Var that one pass declares but never references is a warning, and so a
; failed build. So every installer-only Function, Var and the defines that
; reference them sit inside !ifndef BUILD_UNINSTALLER, and the folder pages
; (compiled in both passes) only call them from inside the same guard.
;
; NO COLOURS OF OUR OWN (aicc_planning #295). Modern UI colours only the
; header and the Welcome and Finish pages, and NSIS cannot recolour the
; dialog's own button strip or a Browse button without a skin plugin, so the
; dark theme this file used to set always left stock light parts beside dark
; ones, and dark text on dark where a control ignored the colours. So every
; page, in both passes, keeps Windows' own light dialog and its own themed
; controls, and the brand is in the header bitmap and the sidebar art.
; installer-branding-guard.test.ts fails on a colour define, classic
; controls or a SetCtlColors anywhere in this file.

!ifndef BUILD_UNINSTALLER
  !define CCC_ART_DIR "${BUILD_RESOURCES_DIR}\installer-art"
  ; Frames 1..CCC_ANIM_STEPS-1 are files; the last step is the static bitmap.
  ; Must match ANIM_STEPS in scripts/gen-installer-art.mjs.
  !define CCC_ANIM_STEPS 8
  !define CCC_ANIM_INTERVAL_MS 90

  Var cccAnimCtl
  Var cccAnimPrefix
  Var cccAnimExt
  Var cccAnimFinal
  Var cccAnimStretch
  Var cccAnimFrame
  Var cccAnimPath
  Var cccAnimBitmap
  Var cccAnimNext

  !define MUI_CUSTOMFUNCTION_GUIINIT CccBrandGuiInit

  ; ---- Page 1: Welcome (new) ----
  ; Not customWelcomePage: electron-builder inserts that after the folder pages.
  !define MUI_WELCOMEPAGE_TITLE "Welcome to AI Code Conductor"
  !define MUI_WELCOMEPAGE_TEXT "Setup will install AI Code Conductor ${VERSION}. If an earlier version is installed, Setup updates it and keeps your data and resources folders.$\r$\n$\r$\nClick Next to continue."
  !define MUI_PAGE_CUSTOMFUNCTION_PRE CccWelcomePre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW CccWelcomeShow
  !define MUI_PAGE_CUSTOMFUNCTION_DESTROYED CccAnimStop
  !insertmacro MUI_PAGE_WELCOME

  ; Runs from .onGUIInit, after .onInit: never on a silent (/S) run.
  Function CccBrandGuiInit
    Push $R0
    InitPluginsDir
    File "/oname=$PLUGINSDIR\ccc-side-1.bmp" "${CCC_ART_DIR}\sidebar-1.bmp"
    File "/oname=$PLUGINSDIR\ccc-side-2.bmp" "${CCC_ART_DIR}\sidebar-2.bmp"
    File "/oname=$PLUGINSDIR\ccc-side-3.bmp" "${CCC_ART_DIR}\sidebar-3.bmp"
    File "/oname=$PLUGINSDIR\ccc-side-4.bmp" "${CCC_ART_DIR}\sidebar-4.bmp"
    File "/oname=$PLUGINSDIR\ccc-side-5.bmp" "${CCC_ART_DIR}\sidebar-5.bmp"
    File "/oname=$PLUGINSDIR\ccc-side-6.bmp" "${CCC_ART_DIR}\sidebar-6.bmp"
    File "/oname=$PLUGINSDIR\ccc-side-7.bmp" "${CCC_ART_DIR}\sidebar-7.bmp"
    File "/oname=$PLUGINSDIR\ccc-emblem-1.bmp" "${CCC_ART_DIR}\emblem-1.bmp"
    File "/oname=$PLUGINSDIR\ccc-emblem-2.bmp" "${CCC_ART_DIR}\emblem-2.bmp"
    File "/oname=$PLUGINSDIR\ccc-emblem-3.bmp" "${CCC_ART_DIR}\emblem-3.bmp"
    File "/oname=$PLUGINSDIR\ccc-emblem-4.bmp" "${CCC_ART_DIR}\emblem-4.bmp"
    File "/oname=$PLUGINSDIR\ccc-emblem-5.bmp" "${CCC_ART_DIR}\emblem-5.bmp"
    File "/oname=$PLUGINSDIR\ccc-emblem-6.bmp" "${CCC_ART_DIR}\emblem-6.bmp"
    File "/oname=$PLUGINSDIR\ccc-emblem-7.bmp" "${CCC_ART_DIR}\emblem-7.bmp"
    File "/oname=$PLUGINSDIR\ccc-emblem.bmp" "${CCC_ART_DIR}\emblem.bmp"

    ; The splash fade, on a FRESH install only. The in-app updater starts this
    ; installer with no arguments (src/main/ipc/update-handlers.ts), so an
    ; update is told apart by what is already on the machine: a recorded data
    ; folder under any brand key (the test DataDirPage uses for its default),
    ; or the app's executable where initMultiUser pointed $INSTDIR from the
    ; previous install's record. Never in the elevated inner instance either:
    ; the outer one has already shown it.
    ;
    ; The executable probe is a cosmetic freshness hint for the splash and
    ; nothing else. It is never an install-ownership test: whether a previous
    ; install is still there is decided from the recorded uninstaller, by
    ; ClassifyUninstallRecord, and brand-identity-guard.test.ts forbids an
    ; exe-existence gate for that. It is spelled with PRODUCT_FILENAME on
    ; purpose: APP_EXECUTABLE_FILENAME is defined by electron-builder's
    ; common.nsh, which is included after this file. An exe from beta.5 or
    ; older carries an older name and is missed here; the data-folder read
    ; below still recognises that install. The first two answers come from
    ; preInit (see PLUGIN ANSWERS above).
    ${IfNot} $cccIsInnerInstance == 1
    ${AndIfNot} $cccIsUpdated == 1
    ${AndIfNot} ${FileExists} "$INSTDIR\${PRODUCT_FILENAME}.exe"
      !insertmacro ReadUserPath "DataDirectory" $R0
      ${If} $R0 == ""
        File "/oname=$PLUGINSDIR\ccc-splash.bmp" "${BUILD_RESOURCES_DIR}\installerSplash.bmp"
        ; 350 ms in, 1000 ms held, 250 ms out. AdvSplash takes the name without .bmp.
        advsplash::show 1000 350 250 -1 "$PLUGINSDIR\ccc-splash"
        Pop $R0
        Delete "$PLUGINSDIR\ccc-splash.bmp"
      ${EndIf}
    ${EndIf}
    ClearErrors
    Pop $R0
  FunctionEnd

  ; The elevated inner instance starts its wizard again from page 1. The user
  ; has just read the Welcome page in the outer one, so it starts at the Data
  ; folder page, exactly as it did before this page existed. DataDirPage hides
  ; and disables its Back button there to match: Back from it would skip this
  ; page backwards and end Setup.
  Function CccWelcomePre
    ${If} $cccIsInnerInstance == 1
      Abort
    ${EndIf}
  FunctionEnd

  Function CccWelcomeShow
    StrCpy $cccAnimCtl $mui.WelcomePage.Image
    StrCpy $cccAnimPrefix "ccc-side-"
    ; The settled frame is the sidebar Modern UI itself extracted.
    StrCpy $cccAnimFinal "$PLUGINSDIR\modern-wizard.bmp"
    StrCpy $cccAnimStretch 1
    Call CccAnimStart
  FunctionEnd

  ; Folder pages: an emblem under the fields, centred in a full-width strip
  ; (SS_CENTERIMAGE keeps the bitmap at its own size).
  Function CccFolderArt
    nsDialogs::CreateControl STATIC ${DEFAULT_STYLES}|${SS_BITMAP}|${SS_CENTERIMAGE} 0 0 64% 100% 36% ""
    Pop $cccAnimCtl
    StrCpy $cccAnimPrefix "ccc-emblem-"
    StrCpy $cccAnimFinal "$PLUGINSDIR\ccc-emblem.bmp"
    StrCpy $cccAnimStretch 0
    Call CccAnimStart
  FunctionEnd

  ; Light motion with no extra plugin: an nsDialogs timer swaps the image a
  ; few times and stops on the static frame. Expects $cccAnimCtl,
  ; $cccAnimPrefix, $cccAnimFinal and $cccAnimStretch. The first frame is set
  ; before nsDialogs::Show, so the page never flashes the settled image first.
  Function CccAnimStart
    StrCpy $cccAnimExt ".bmp"
    StrCpy $cccAnimFrame 1
    StrCpy $cccAnimBitmap 0
    Call CccAnimShowFrame
    ${NSD_CreateTimer} CccAnimTick ${CCC_ANIM_INTERVAL_MS}
  FunctionEnd

  Function CccAnimTick
    IntOp $cccAnimFrame $cccAnimFrame + 1
    ${If} $cccAnimFrame >= ${CCC_ANIM_STEPS}
      ${NSD_KillTimer} CccAnimTick
    ${EndIf}
    Call CccAnimShowFrame
  FunctionEnd

  ; Loads the current frame into the control and frees the one it replaces
  ; (a static control never frees a bitmap it was given).
  Function CccAnimShowFrame
    ${If} $cccAnimFrame >= ${CCC_ANIM_STEPS}
      StrCpy $cccAnimPath "$cccAnimFinal"
    ${Else}
      StrCpy $cccAnimPath "$PLUGINSDIR\$cccAnimPrefix$cccAnimFrame$cccAnimExt"
    ${EndIf}
    ${If} $cccAnimStretch == 1
      ${NSD_SetStretchedImage} $cccAnimCtl "$cccAnimPath" $cccAnimNext
    ${Else}
      ${NSD_SetImage} $cccAnimCtl "$cccAnimPath" $cccAnimNext
    ${EndIf}
    ${NSD_FreeImage} $cccAnimBitmap
    StrCpy $cccAnimBitmap $cccAnimNext
  FunctionEnd

  ; After the page closes (Next, Back or Cancel): stop the timer and free the
  ; last frame this code loaded. Modern UI frees its own sidebar bitmap.
  Function CccAnimStop
    ${NSD_KillTimer} CccAnimTick
    ${NSD_FreeImage} $cccAnimBitmap
    StrCpy $cccAnimBitmap 0
  FunctionEnd
!endif

Var DataDir
Var ResourcesDir

; Custom pages for directory selection
Page custom DataDirPage DataDirPageLeave
Page custom ResourcesDirPage ResourcesDirPageLeave

; --- Data Directory Page ---
Function DataDirPage
  !insertmacro MUI_HEADER_TEXT "Data folder" "Where AI Code Conductor keeps sessions, logs and configuration data."
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 0 0 100% 24u "Choose where to store sessions, logs, and configuration data:"
  Pop $0

  ; Current brand key first, then each legacy key, then the fresh-install default.
  ReadRegStr $1 HKCU "Software\AI Code Conductor" "DataDirectory"
  ${If} $1 == ""
    ReadRegStr $1 HKCU "Software\Claude Command Center" "DataDirectory"
  ${EndIf}
  ${If} $1 == ""
    ReadRegStr $1 HKCU "Software\Claude Conductor" "DataDirectory"
  ${EndIf}
  ${If} $1 == ""
    ; FRESH INSTALL ONLY — reached only when neither registry key exists, so an
    ; upgrade always keeps the path it already had. New installs get a
    ; new-brand folder with no legacy name in it.
    StrCpy $1 "$LOCALAPPDATA\AI Code Conductor"
  ${EndIf}

  ${NSD_CreateDirRequest} 0 30u 75% 12u "$1"
  Pop $DataDir

  ${NSD_CreateBrowseButton} 77% 29u 23% 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 OnBrowseDataDir

  !ifndef BUILD_UNINSTALLER
    ; The elevated inner instance shows this page first, but it is no longer
    ; page 1: the Welcome page ahead of it aborts there (CccWelcomePre), so NSIS
    ; gives this page a live Back button. Back would land on that Welcome page,
    ; which aborts again and carries the wizard off its front edge. Setup then
    ; ends with nothing installed and without passing .onUserAbort, so a
    ; suspended uninstall record is never put back (CccRestoreInstallLocation).
    ; Before the Welcome page existed this was page 1 and had no Back button,
    ; so hide it and disable it here (disabled, so no key press reaches it).
    ${If} $cccIsInnerInstance == 1
      GetDlgItem $0 $HWNDPARENT 3
      ShowWindow $0 ${SW_HIDE}
      EnableWindow $0 0
    ${EndIf}
    Call CccFolderArt
  !endif
  nsDialogs::Show
  !ifndef BUILD_UNINSTALLER
    Call CccAnimStop
  !endif
FunctionEnd

Function OnBrowseDataDir
  nsDialogs::SelectFolderDialog "Select Data Directory" "$LOCALAPPDATA\AI Code Conductor"
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $DataDir $0
  ${EndIf}
FunctionEnd

Function DataDirPageLeave
  ${NSD_GetText} $DataDir $0
  WriteRegStr HKCU "Software\AI Code Conductor" "DataDirectory" $0
  CreateDirectory "$0"
  CreateDirectory "$0\sessions"
  CreateDirectory "$0\logs"
FunctionEnd

; --- Resources Directory Page ---
Function ResourcesDirPage
  !insertmacro MUI_HEADER_TEXT "Resources folder" "Shared insights, screenshots, skills and scripts."
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 0 0 100% 36u "Choose where to store shared resources (insights, screenshots, skills, scripts).$\nUse a network-mountable path to share across SSH sessions."
  Pop $0

  ; Current brand key first, then each legacy key, then the fresh-install default.
  ReadRegStr $1 HKCU "Software\AI Code Conductor" "ResourcesDirectory"
  ${If} $1 == ""
    ReadRegStr $1 HKCU "Software\Claude Command Center" "ResourcesDirectory"
  ${EndIf}
  ${If} $1 == ""
    ReadRegStr $1 HKCU "Software\Claude Conductor" "ResourcesDirectory"
  ${EndIf}
  ${If} $1 == ""
    ; FRESH INSTALL ONLY (see DataDirPage) — upgrades keep their existing path.
    StrCpy $1 "$LOCALAPPDATA\AI Code Conductor\resources"
  ${EndIf}

  ${NSD_CreateDirRequest} 0 42u 75% 12u "$1"
  Pop $ResourcesDir

  ${NSD_CreateBrowseButton} 77% 41u 23% 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 OnBrowseResourcesDir

  !ifndef BUILD_UNINSTALLER
    Call CccFolderArt
  !endif
  nsDialogs::Show
  !ifndef BUILD_UNINSTALLER
    Call CccAnimStop
  !endif
FunctionEnd

Function OnBrowseResourcesDir
  nsDialogs::SelectFolderDialog "Select Resources Directory" "$LOCALAPPDATA\AI Code Conductor\resources"
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $ResourcesDir $0
  ${EndIf}
FunctionEnd

Function ResourcesDirPageLeave
  ${NSD_GetText} $ResourcesDir $0
  WriteRegStr HKCU "Software\AI Code Conductor" "ResourcesDirectory" $0
  CreateDirectory "$0"
  CreateDirectory "$0\CONFIG"
  CreateDirectory "$0\insights"
  CreateDirectory "$0\screenshots"
  CreateDirectory "$0\skills"
  CreateDirectory "$0\scripts"
FunctionEnd

; ============================================================
; UNINSTALLER — protect CONFIG/ by default
; ============================================================

; Uninstaller page 1. electron-builder inserts this in place of the stock
; Welcome page, in the BUILD_UNINSTALLER pass only. Every sentence has to hold
; for customUnInstall below: program files go, the data and resources folders
; stay, and the CONFIG question is asked only when that folder exists.
; Known edge: customUnInstall finds the resources folder through HKCU only, so
; a per-machine uninstall elevated as a different administrator account reads
; that account's record. When it has none, the question is not asked and
; CONFIG is kept. That is the safe side, and it was the same before this page.
; The session helper sentence holds on every route, elevated or not
; (RemoveUserHelperFolder). Known edge: an uninstall that runs as another
; account from the start (a standard user who typed an administrator's
; password) ends that account's held terminals and removes its copies, not
; the standard user's.
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Uninstall AI Code Conductor"
  !define MUI_WELCOMEPAGE_TEXT "Setup will remove AI Code Conductor from this computer.$\r$\n$\r$\nYour data and resources folders stay where they are. If your resources folder holds a CONFIG folder of settings, Setup asks whether to remove that too.$\r$\n$\r$\nTerminals the session helper is still holding are ended, and its copies are removed.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; ============================================================
; UNINSTALLER: the per-user session helper folder
; ============================================================
; Held terminals run from the app's own copy of the session helper, kept per
; user and outside the install folder, in %LOCALAPPDATA%\AI Code Conductor\helper
; (src/main/session-helper/install.ts helperRootDir, manager.ts). This is all
; the app and the helper put there, and so all the clean-up removes:
;   <version>-<12 hex>\     one copy per version (installHelperCopy)
;     aicc-helper.exe
;     conpty\               node-pty's ConPTY, for a holder that asks for it
;       conpty.dll          (CONPTY_FILES)
;       OpenConsole.exe
;     .new-<12 hex>\        a ConPTY copy that stopped half way
;                           (makeConptyCopy), with the same two files
;   .new-<12 hex>\          a copy that stopped half way (makeCopy), with
;                           aicc-helper.exe
;   store\                  the held sessions' records (helper/src/store.rs):
;                           .lock, <session>.json, <session>.json.<pid>.tmp
;   bindings.json           which tab holds which terminal (manager.ts)
;   app-running.json        the app's crash mark (manager.ts)
; The Data folder page proposes that SAME parent folder for the user's data
; (DataDirPage), and either folder page takes any path at all.
;
; The clean-up may run as administrator: an uninstall started elevated has no
; user copy behind it (Windows Settings, Apps on an all-users install; an
; administrator prompt). So it is written to be safe there:
;   - It never deletes recursively, and walks only the layout above.
;   - It checks that a folder is not a link (a junction or a symbolic link)
;     before it touches anything in it. A link stays as it is.
;   - Files go by name, or by a wildcard inside the checked store folder.
;     Delete never removes a folder, and on a link it removes the link only.
;     Windows matches a wildcard against a file's short 8.3 name too, so
;     each one is written so that no short name can match it: *.json has a
;     four-letter extension, longer than a short name's three, and
;     *.json.*.tmp has two dots, which a short name never has. *.tmp would
;     also take notes.tmpl, whose short name ends in .TMP.
;   - Folders go with plain RMDir, deepest first. RMDir removes a folder only
;     when it is empty, so anything the app did not make stays, with the
;     folders above it, and the details list says so.
;   - It never removes a folder that is, or holds, the user's data or
;     resources folder.
; Not covered: a program already running as the user that swaps a checked
; folder for a link between the check and the delete. That needs a hostile
; program racing the uninstall, and such cases wait for a real report. Even
; then, only files with the names above could go.
; Not /REBOOTOK either: a delete scheduled for the next start runs before
; anything can check the path again, so a link put there meanwhile would be
; followed. A file still in use stays, and the details list says so.
;
; These are macros, not Functions, and declare no Var: customUnInstall is
; compiled in the uninstaller pass alone, and a Function or Var the installer
; pass never uses fails that pass under -WX (TWO PASSES, in BRANDING above).
; They use registers, and CanonPathPair's $cccCanon* scratch, which
; customHeader declares in both passes.

; ${OUT} = 1 when ${CH} is one of the characters of ${SET}. Case counts (S==).
; Scratch: $0 $1.
!macro CccCharIn CH SET OUT
  StrCpy ${OUT} 0
  StrCpy $1 0
  ${Do}
    StrCpy $0 "${SET}" 1 $1
    ${If} $0 == ""
      ${ExitDo}
    ${EndIf}
    ${If} $0 S== "${CH}"
      StrCpy ${OUT} 1
      ${ExitDo}
    ${EndIf}
    IntOp $1 $1 + 1
  ${Loop}
!macroend

; ${OUT} = 1 when ${STR} is exactly 12 hex digits in lower case, as the app
; writes them. Scratch: $R5 $R6 $R7 $2, and $0 $1 (CccCharIn).
!macro CccIsHex12 STR OUT
  StrCpy ${OUT} 0
  StrLen $R5 "${STR}"
  ${If} $R5 == 12
    StrCpy ${OUT} 1
    StrCpy $R6 0
    ${Do}
      ${If} $R6 >= 12
        ${ExitDo}
      ${EndIf}
      StrCpy $R7 "${STR}" 1 $R6
      !insertmacro CccCharIn "$R7" "0123456789abcdef" $2
      ${If} $2 != 1
        StrCpy ${OUT} 0
        ${ExitDo}
      ${EndIf}
      IntOp $R6 $R6 + 1
    ${Loop}
  ${EndIf}
!macroend

; ${OUT} = 1 when ${NAME} is a version folder's name, <version>-<12 hex>. The
; version is three numbers with a dot between each, then optionally a hyphen
; and a tag of letters, digits and dots (HELPER_FOLDER_RE in
; src/main/session-helper/protocol.ts). Scratch: $R5 to $R9, $0 $1 $2.
!macro IsHelperVersionFolder NAME OUT
  StrCpy ${OUT} 0
  StrLen $R5 "${NAME}"
  ${If} $R5 >= 18
    IntOp $R6 $R5 - 13
    StrCpy $R7 "${NAME}" 1 $R6
    ${If} $R7 == "-"
      StrCpy $R9 "${NAME}" "" -12
      !insertmacro CccIsHex12 "$R9" ${OUT}
    ${EndIf}
  ${EndIf}
  ${If} ${OUT} == 1
    ; The version: $R5 is its length, $R6 the position, $R8 the part (0 to 2
    ; the numbers, 3 the tag) and $R9 how many characters that part has.
    StrLen $R5 "${NAME}"
    IntOp $R5 $R5 - 13
    StrCpy $R6 0
    StrCpy $R8 0
    StrCpy $R9 0
    ${Do}
      ${If} $R6 >= $R5
        ${ExitDo}
      ${EndIf}
      StrCpy $R7 "${NAME}" 1 $R6
      StrCpy $2 0
      ${If} $R8 == 3
        !insertmacro CccCharIn "$R7" "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz." $2
        ${If} $2 == 1
          IntOp $R9 $R9 + 1
        ${EndIf}
      ${Else}
        !insertmacro CccCharIn "$R7" "0123456789" $2
        ${If} $2 == 1
          IntOp $R9 $R9 + 1
        ${ElseIf} $R9 > 0
          ; A dot ends the first and the second number, a hyphen the third.
          ${If} $R7 == "."
            ${If} $R8 < 2
              IntOp $R8 $R8 + 1
              StrCpy $R9 0
              StrCpy $2 1
            ${EndIf}
          ${ElseIf} $R7 == "-"
            ${If} $R8 == 2
              StrCpy $R8 3
              StrCpy $R9 0
              StrCpy $2 1
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
      ${If} $2 != 1
        StrCpy ${OUT} 0
        ${ExitDo}
      ${EndIf}
      IntOp $R6 $R6 + 1
    ${Loop}
    ; It has to end in the third number, or in a tag of one character or more.
    ${If} $R8 < 2
    ${OrIf} $R9 < 1
      StrCpy ${OUT} 0
    ${EndIf}
  ${EndIf}
!macroend

; ${OUT} = 1 when ${NAME} is one of the helper folder's own folders: "store",
; ".new-<12 hex>" or a version folder. Scratch: $R5 to $R9, $0 $1 $2.
!macro IsHelperOwnFolder NAME OUT
  StrCpy ${OUT} 0
  StrCpy $R8 "${NAME}" 5
  ${If} "${NAME}" S== "store"
    StrCpy ${OUT} 1
  ${ElseIf} $R8 S== ".new-"
    StrCpy $R9 "${NAME}" "" 5
    !insertmacro CccIsHex12 "$R9" ${OUT}
  ${Else}
    !insertmacro IsHelperVersionFolder "${NAME}" ${OUT}
  ${EndIf}
!macroend

; ${OUT} = 1 when the user's data folder ($7) or resources folder ($8) is
; ${DIR} or inside it, compared canonically (IsSameOrInsideCanon). Scratch:
; $cccCanon* and $R5 $R6 $R7.
!macro HoldsUserFolder DIR OUT
  !insertmacro IsSameOrInsideCanon "${DIR}" "$7" ${OUT}
  ${If} ${OUT} != 1
    !insertmacro IsSameOrInsideCanon "${DIR}" "$8" ${OUT}
  ${EndIf}
!macroend

; Adds one line to $9, the clean-up's notes, which RemoveUserHelperFolder
; shows in the details list. Lines are kept apart by "|", which no Windows
; path can hold. A line that would not fit in one NSIS string is left out, and
; the list then ends by saying so. Saves its scratch, $0 and $1.
!macro CccHelperNote TEXT
  Push $0
  StrCpy $0 "${TEXT}"
  Push $1
  StrLen $1 "$9|$0"
  ; Room is kept for the closing line below.
  IntOp $1 $1 + 64
  ${If} $1 < ${NSIS_MAX_STRLEN}
    ${If} $9 == ""
      StrCpy $9 "$0"
    ${Else}
      StrCpy $9 "$9|$0"
    ${EndIf}
  ${Else}
    StrCpy $1 "$9" 6 -6
    ${If} $1 != "shows."
      StrCpy $9 "$9|The clean-up did more than this list shows."
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

; Shows $9's notes in the details list, one line each. Saves $0 $1 $2.
!macro CccPrintHelperNotes
  Push $0
  Push $1
  Push $2
  StrCpy $0 0
  StrCpy $1 ""
  ${Do}
    StrCpy $2 "$9" 1 $0
    ${If} $2 == ""
      ${If} $1 != ""
        DetailPrint "$1"
      ${EndIf}
      ${ExitDo}
    ${ElseIf} $2 == "|"
      DetailPrint "$1"
      StrCpy $1 ""
    ${Else}
      StrCpy $1 "$1$2"
    ${EndIf}
    IntOp $0 $0 + 1
  ${Loop}
  Pop $2
  Pop $1
  Pop $0
!macroend

; ${OUT} = 1 when process ${PID} runs as this copy's own user: the SID in its
; token equals $R6, this copy's (CccEndUserHelpers). ${OUT} = 0 when it runs
; as another user, and 2 when that cannot be told: the process or its token
; could not be opened or read (this user's copy started as administrator,
; say, seen from an installer that is not). Callers that test for 1 treat 0
; and 2 alike. $R5 is a 256-byte buffer. ${PID} and ${OUT} must not be
; $0 $1 $2. Scratch: $0 $1 $2.
!macro CccProcessIsMine PID OUT
  StrCpy ${OUT} 2
  ; PROCESS_QUERY_LIMITED_INFORMATION, then TOKEN_QUERY and TokenUser.
  System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i ${PID}) p .r0'
  ${If} $0 != 0
    System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i .r2'
    ${If} $2 != 0
      System::Call 'advapi32::GetTokenInformation(p r1, i 1, p R5, i 256, *i .r2) i .r2'
      ${If} $2 != 0
        System::Call '*$R5(p .r2)'
        System::Call 'advapi32::EqualSid(p r2, p R6) i .r2'
        ${If} $2 != 0
          StrCpy ${OUT} 1
        ${Else}
          StrCpy ${OUT} 0
        ${EndIf}
      ${EndIf}
      System::Call 'kernel32::CloseHandle(p r1)'
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
!macroend

; ${OUT} = when process ${PID} started (a 64-bit FILETIME), or "" when that
; cannot be read. ${PID} and ${OUT} must not be $0 $1 $2. Scratch: $0 $1 $2.
!macro CccProcessStart PID OUT
  StrCpy ${OUT} ""
  System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i ${PID}) p .r0'
  ${If} $0 != 0
    System::Call 'kernel32::GetProcessTimes(p r0, *l .r1, *l, *l, *l) i .r2'
    ${If} $2 != 0
      StrCpy ${OUT} $1
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
!macroend

; ${OUT} = 1 when the number ${ITEM} is in $R1, a list like ",12,345,".
; ${ITEM} and ${OUT} must not be scratch. Scratch: $0 $1 $2 $R7 $R8.
!macro CccInList ITEM OUT
  StrCpy ${OUT} 0
  StrCpy $2 ",${ITEM},"
  StrLen $1 "$2"
  StrLen $R8 "$R1"
  StrCpy $0 0
  ${Do}
    ${If} $0 >= $R8
      ${ExitDo}
    ${EndIf}
    StrCpy $R7 "$R1" $1 $0
    ${If} $R7 == $2
      StrCpy ${OUT} 1
      ${ExitDo}
    ${EndIf}
    IntOp $0 $0 + 1
  ${Loop}
!macroend

; ${OUT} = 1 when $R1, a list like ",12:345,67:890,", has an entry for process
; ${ITEM}: the number before an entry's colon. ${ITEM} and ${OUT} must not be
; scratch. Scratch: $0 $1 $2 $R7 $R8.
!macro CccInPairList ITEM OUT
  StrCpy ${OUT} 0
  StrCpy $2 ",${ITEM}:"
  StrLen $1 "$2"
  StrLen $R8 "$R1"
  StrCpy $0 0
  ${Do}
    ${If} $0 >= $R8
      ${ExitDo}
    ${EndIf}
    StrCpy $R7 "$R1" $1 $0
    ${If} $R7 == $2
      StrCpy ${OUT} 1
      ${ExitDo}
    ${EndIf}
    IntOp $0 $0 + 1
  ${Loop}
!macroend

; One pass over every running process (a Toolhelp snapshot, so no WMI: over
; a non-interactive sign-in tasklist and taskkill answer "Access denied",
; measured on the VM). Each process it lists goes into $R1 as "pid:start,",
; its start as CccProcessStart reads it ("" when that cannot be read), so
; CccEndListed can tell it from a process Windows gives its pid later. MODE 0
; adds each aicc-helper.exe of this copy's user. MODE 1 adds each process of
; this user whose parent is in $R1 and that started after its parent, so a
; parent id Windows has since given to a new process is not taken for its
; parent. $R2 is the snapshot, $R3 a PROCESSENTRY32W (556 bytes, 32-bit).
; Scratch: $3 $4 $5 $6 $7, and CccInPairList's, CccProcessIsMine's and
; CccProcessStart's.
!macro CccScanProcesses MODE
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p .R2'
  ${If} $R2 != 0
  ${AndIf} $R2 != -1
  ${AndIf} $R2 != 4294967295
    System::Call '*$R3(i 556)'
    System::Call 'kernel32::Process32FirstW(p R2, p R3) i .r7'
    ${DoWhile} $7 != 0
      System::Call '*$R3(i, i, i .r3, p, i, i, i .r4, i, i, &w260 .r5)'
      !if "${MODE}" == "0"
        ${If} $5 == "aicc-helper.exe"
          !insertmacro CccProcessIsMine "$3" $6
          ${If} $6 == 1
            !insertmacro CccProcessStart "$3" $R7
            StrCpy $R1 "$R1$3:$R7,"
          ${EndIf}
        ${EndIf}
      !else
        ${If} $4 != 0
          !insertmacro CccInPairList "$4" $6
          ${If} $6 == 1
            !insertmacro CccInPairList "$3" $6
            ${If} $6 == 0
              !insertmacro CccProcessIsMine "$3" $6
              ${If} $6 == 1
                !insertmacro CccProcessStart "$3" $R7
                !insertmacro CccProcessStart "$4" $R8
                ${If} $R7 != ""
                ${AndIf} $R8 != ""
                  System::Int64Op $R7 < $R8
                  Pop $6
                  ${If} $6 == 0
                    StrCpy $R1 "$R1$3:$R7,"
                  ${EndIf}
                ${EndIf}
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
      !endif
      System::Call 'kernel32::Process32NextW(p R2, p R3) i .r7'
    ${Loop}
    System::Call 'kernel32::CloseHandle(p R2)'
  ${EndIf}
!macroend

; Ends each process in $R1, the "pid:start," list CccScanProcesses made, that
; when its turn comes is still this user's and still the process it listed:
; its start, read through a handle held open from before its user is checked
; until it is ended, is the one listed. Windows gives a freed pid to a new
; process within seconds, and that process has a later start, so it is left
; running, as is one whose start could not be read, then or now. Scratch: $3
; $4 $5 $6 $7, and CccNextPair's and CccProcessIsMine's ($0 $1 $2 as well).
!macro CccEndListed
  StrCpy $4 1
  ${Do}
    !insertmacro CccNextPair "$R1" $4 $3 $5
    ${If} $3 == ""
      ${ExitDo}
    ${EndIf}
    ; PROCESS_TERMINATE and PROCESS_QUERY_LIMITED_INFORMATION.
    System::Call 'kernel32::OpenProcess(i 0x1001, i 0, i $3) p .r7'
    ${If} $7 != 0
      !insertmacro CccProcessIsMine "$3" $6
      ${If} $6 == 1
        System::Call 'kernel32::GetProcessTimes(p r7, *l .r1, *l, *l, *l) i .r2'
        ${If} $2 != 0
        ${AndIf} $5 != ""
        ${AndIf} $1 == $5
          System::Call 'kernel32::TerminateProcess(p r7, i 1)'
        ${EndIf}
      ${EndIf}
      System::Call 'kernel32::CloseHandle(p r7)'
    ${EndIf}
  ${Loop}
!macroend

; ------------------------------------------------------------
; The app-running check's own macros (customCheckAppRunning, both passes).
; They use the process macros above, and declare no Var and no Function, so
; neither pass has anything new for -WX to warn about.
; ------------------------------------------------------------

; Reads the next "a:b," entry of ${LIST}, a list like ",12:34,56:78,", from
; position ${POS}, which it moves past the entry, into ${A} and ${B}. ${A} is
; "" at the end of the list. An entry with no colon, as in ",12,34,", comes
; back whole in ${A}. ${LIST}, ${POS}, ${A} and ${B} must not be $R7 or $R8.
; Scratch: $R7 $R8.
!macro CccNextPair LIST POS A B
  StrCpy ${A} ""
  StrCpy ${B} ""
  StrCpy $R8 0
  ${Do}
    StrCpy $R7 "${LIST}" 1 ${POS}
    IntOp ${POS} ${POS} + 1
    ${If} $R7 == ","
    ${OrIf} $R7 == ""
      ${ExitDo}
    ${EndIf}
    ${If} $R7 == ":"
      StrCpy $R8 1
    ${ElseIf} $R8 == 0
      StrCpy ${A} "${A}$R7"
    ${Else}
      StrCpy ${B} "${B}$R7"
    ${EndIf}
  ${Loop}
!macroend

; Why an end of process ${PID}, through the handle ${HANDLE} (opened with at
; least PROCESS_QUERY_LIMITED_INFORMATION), failed, as one details line.
; ${ERROR} is the error Windows gave, taken with the TerminateProcess call
; (?e). Windows refuses to end a process whose own exit is under way, and
; marks it exited only once that exit is done, so the exit code is read for
; up to about half a second: anything but STILL_ACTIVE (259) means it had
; already exited. That is the usual case: the app's own helper processes end
; by themselves once its main process has been ended. Otherwise access was
; denied (5), or the error number is given. ${PID}, ${HANDLE} and ${ERROR}
; must not be $0 $1 $2. Scratch: $0 $1 $2.
!macro CccWhyNotEnded PID HANDLE ERROR
  StrCpy $0 0
  ${Do}
    System::Call 'kernel32::GetExitCodeProcess(p ${HANDLE}, *i .r1) i .r2'
    ${If} $2 == 0
    ${OrIf} $1 != 259
    ${OrIf} $0 >= 10
      ${ExitDo}
    ${EndIf}
    Sleep 50
    IntOp $0 $0 + 1
  ${Loop}
  ${If} $2 != 0
  ${AndIf} $1 != 259
    DetailPrint "Could not end process ${PID}: it had already exited."
  ${ElseIf} ${ERROR} == 5
    DetailPrint "Could not end process ${PID}: access was denied."
  ${Else}
    DetailPrint "Could not end process ${PID}: Windows error ${ERROR}."
  ${EndIf}
!macroend

; One Toolhelp pass for this install's running copies of the app. A copy is
; a process with one of the app's own image names (${APP_EXECUTABLE_FILENAME},
; or one of the two names it had before its rename), that runs as this
; copy's own user (CccProcessIsMine), and whose program file, as Windows
; reports it (QueryFullProcessImageNameW), is $INSTDIR\<name>, or, when
; ${OLD_UNINSTALLER} names the uninstaller of the install this run replaces,
; <that folder>\<name>. Paths are compared through CanonPathPair, so case, a
; forward slash or an 8.3 short name makes no difference. Each candidate is
; held open (PROCESS_QUERY_LIMITED_INFORMATION) from before its user is
; checked until its start time is read, so its pid cannot pass to another
; process in between: the user, the program file and the start time are all
; the same process's. Each copy goes into $R1 as "pid,", and, when ${STARTS}
; names a register, into it as "pid:start," (CccProcessStart). $R1 is ""
; when Windows could not list the running programs at all.
;
; ${REPORT} 0 only counts. ${REPORT} 1, the first look, writes each copy found
; and each same-named process left alone to the details log, with the reason.
; ${REPORT} 2, the last look, writes each copy still running.
;
; When ${UNSURE} names a register that holds 1, a process from this install's
; folder whose user could not be read counts too: nothing here asks it to
; close or ends it, but the install cannot go on over it. It goes into $R1
; only, never into ${STARTS}.
;
; No other image name is looked at: the session helper and the terminals it
; holds keep running through an install. $R2 is the snapshot, $R3 a
; PROCESSENTRY32W (556 bytes, 32-bit), $R5 and $R6 as CccProcessIsMine needs
; them. ${STARTS} and ${UNSURE} must not be $0 to $8 or $R8. Scratch: $3 $4
; $5 $6 $7 $8 $R8, $cccCanon*, and CccProcessIsMine's and CccProcessStart's
; ($0 $1 $2).
!macro CccScanAppCopies REPORT STARTS OLD_UNINSTALLER UNSURE
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p .R2'
  ${If} $R2 != 0
  ${AndIf} $R2 != -1
  ${AndIf} $R2 != 4294967295
    System::Call '*$R3(i 556)'
    System::Call 'kernel32::Process32FirstW(p R2, p R3) i .r7'
    ${DoWhile} $7 != 0
      System::Call '*$R3(i, i, i .r3, p, i, i, i .r4, i, i, &w260 .r5)'
      ${If} $5 == "${APP_EXECUTABLE_FILENAME}"
      ${OrIf} $5 == "Claude Command Center.exe"
      ${OrIf} $5 == "Claude Conductor.exe"
        ; $6: 1 this user's, 0 another user's, 2 its user could not be read,
        ; 3 it could not be opened at all.
        System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i $3) p .R8'
        StrCpy $6 3
        ${If} $R8 != 0
          !insertmacro CccProcessIsMine "$3" $6
        ${EndIf}
        ; Its program file, read through that same handle ($8), and whether
        ; it is this install's ($7; Process32NextW sets $7 again below).
        StrCpy $8 ""
        StrCpy $7 0
        ${If} $6 == 1
        ${OrIf} $6 == 2
          System::Call 'kernel32::QueryFullProcessImageNameW(p R8, i 0, w .r1, *i ${NSIS_MAX_STRLEN}) i .r2'
          ${If} $2 != 0
            StrCpy $8 "$1"
          ${EndIf}
          ${If} $8 != ""
            !insertmacro CanonPathPair "$8" $cccCanonA $cccCanonAS
            !insertmacro CanonPathPair "$INSTDIR\$5" $cccCanonB $cccCanonBS
            ${If} $cccCanonA == $cccCanonB
            ${OrIf} $cccCanonAS == $cccCanonBS
              StrCpy $7 1
            ${EndIf}
            !if "${OLD_UNINSTALLER}" != ""
              ${If} $7 != 1
              ${AndIf} "${OLD_UNINSTALLER}" != ""
                ${GetParent} "${OLD_UNINSTALLER}" $4
                !insertmacro CanonPathPair "$4\$5" $cccCanonB $cccCanonBS
                ${If} $cccCanonA == $cccCanonB
                ${OrIf} $cccCanonAS == $cccCanonBS
                  StrCpy $7 1
                ${EndIf}
              ${EndIf}
            !endif
          ${EndIf}
        ${EndIf}
        ${If} $7 == 1
        ${AndIf} $6 == 1
          StrCpy $R1 "$R1$3,"
          !if "${STARTS}" != ""
            !insertmacro CccProcessStart "$3" $4
            StrCpy ${STARTS} "${STARTS}$3:$4,"
          !endif
        ${EndIf}
        !if ${REPORT} == 1
          ${If} $6 == 3
            DetailPrint "Left $5 (process $3) running: it could not be opened, so its user and folder are not known."
          ${ElseIf} $6 == 0
            DetailPrint "Left $5 (process $3) running: it is another user's."
          ${ElseIf} $8 == ""
            DetailPrint "Left $5 (process $3) running: its program file could not be read."
          ${ElseIf} $7 != 1
            DetailPrint "Left $5 (process $3) running from $8, which is not this install's folder."
          ${ElseIf} $6 == 2
            DetailPrint "Found $5 (process $3) running from this install's folder, but could not read its user, so it is not closed or ended here."
          ${Else}
            DetailPrint "Found $5 (process $3) running from this install's folder."
          ${EndIf}
        !endif
        !if ${REPORT} == 2
          ${If} $7 == 1
          ${AndIf} $6 == 1
            DetailPrint "Still running from this install's folder: $5 (process $3)."
          ${EndIf}
        !endif
        !if "${UNSURE}" != ""
          ${If} $7 == 1
          ${AndIf} $6 == 2
          ${AndIf} ${UNSURE} == 1
            StrCpy $R1 "$R1$3,"
            !if ${REPORT} != 0
              DetailPrint "Still running from this install's folder, its user unknown: $5 (process $3)."
            !endif
          ${EndIf}
        !endif
        ${If} $R8 != 0
          System::Call 'kernel32::CloseHandle(p R8)'
        ${EndIf}
      ${EndIf}
      System::Call 'kernel32::Process32NextW(p R2, p R3) i .r7'
    ${Loop}
    System::Call 'kernel32::CloseHandle(p R2)'
  ${Else}
    StrCpy $R1 ""
    !if ${REPORT} != 0
      DetailPrint "Could not list the running programs, so no copy of AI Code Conductor was looked for."
    !endif
  ${EndIf}
!macroend

; Asks this install's running copies of the app (CccScanAppCopies) to close,
; and ends the ones that do not:
;   1. WM_CLOSE to each top-level window those processes own, as closing the
;      window by hand would. The windows are listed first, as "window:pid",
;      and closed after: a window gone while the list is walked would end the
;      walk early. Before each WM_CLOSE the pid, held open, must still have
;      the start time the first look recorded, and then, last of all, the
;      window must still be that pid's, so a pid or a window handle that
;      passed to another program in between gets nothing. Over a remote or
;      scheduled sign-in the app's windows are on another desktop, which this
;      installer cannot see, so no window is reached and step 3 ends the copy.
;   2. Up to 5 seconds for them to go, looking every 250 ms.
;   3. In a run someone can see (not silent), a copy that was asked to close
;      and is still open may be asking whether to save its sessions: nothing
;      is ended, and the caller's box lets the user answer it and Retry. The
;      app closes at once on a second WM_CLOSE (window-close-coordinator.ts).
;      Otherwise, TerminateProcess for each copy the first look found that is
;      still running, still this user's and has the same start time. A handle
;      to it is held open across those checks, so its pid cannot pass to
;      another process in between, and the handle is what ends it. An end
;      that fails says why: the process had already exited, access was
;      denied, or the error number Windows gave.
;   4. Up to about 2 more seconds for Windows to finish ending them.
;   5. A last look, which writes to the details log what is still running.
; ${OLD_UNINSTALLER} is as for CccScanAppCopies. Leaves in $R0: 0 when no copy
; is running at the end, 1 when one is, and 2 when that could not be checked
; (this copy's own user, or the running programs, could not be read). Until
; then $R0 holds the pids asked to close, and at the last look whether this
; installer is not elevated. Saves and restores every other
; register. $9 holds the first look's "pid:start," list, $R4 the round or the
; place in a list, $R9 this copy's TOKEN_USER (its SID at $R6), $R5 and $R3
; CccScanAppCopies's buffers, $7 the windows to close, then in step 3 why an
; end failed, $8 a window or a process handle, $5 a process handle or a flag,
; $R2 between looks the number of windows asked to close.
!macro CccCloseAppCopies OLD_UNINSTALLER
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  ; This copy's own user, as CccEndUserHelpers reads it.
  System::Alloc 256
  Pop $R9
  System::Alloc 256
  Pop $R5
  System::Alloc 556
  Pop $R3
  StrCpy $R6 0
  System::Call 'kernel32::GetCurrentProcess() p .r0'
  System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i .r2'
  ${If} $2 != 0
    System::Call 'advapi32::GetTokenInformation(p r1, i 1, p R9, i 256, *i .r2) i .r2'
    ${If} $2 != 0
      System::Call '*$R9(p .R6)'
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r1)'
  ${EndIf}

  StrCpy $R1 ","
  ${If} $R6 == 0
    DetailPrint "Could not tell which user this is, so no copy of AI Code Conductor was looked for."
    StrCpy $R1 ""
  ${Else}
    StrCpy $9 ","
    !insertmacro CccScanAppCopies 1 $9 "${OLD_UNINSTALLER}" ""
    ${If} $R1 != ""
      ${If} $R1 != ","
        ; 1. Their top-level windows, as "window:pid,"; then WM_CLOSE to each.
        StrCpy $7 ","
        StrCpy $8 0
        StrCpy $R4 0
        ${Do}
          System::Call 'user32::FindWindowExW(p 0, p r8, p 0, p 0) p .r8'
          ${If} $8 == 0
            ${ExitDo}
          ${EndIf}
          StrCpy $3 0
          System::Call 'user32::GetWindowThreadProcessId(p r8, *i .r3)'
          ${If} $3 != 0
            !insertmacro CccInList "$3" $6
            ${If} $6 == 1
              StrCpy $7 "$7$8:$3,"
            ${EndIf}
          ${EndIf}
          IntOp $R4 $R4 + 1
          ${If} $R4 >= 20000
            ${ExitDo}
          ${EndIf}
        ${Loop}
        StrCpy $R0 ","
        StrCpy $R2 0
        StrCpy $R4 1
        ${Do}
          !insertmacro CccNextPair "$7" $R4 $8 $3
          ${If} $8 == ""
            ${ExitDo}
          ${EndIf}
          ; That pid, held open, still the process the first look found
          ; ("pid:start" in $9); then, last of all, still that pid's window.
          System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i $3) p .r5'
          ${If} $5 != 0
            !insertmacro CccProcessStart "$3" $4
            ${If} $4 != ""
              Push $R1
              StrCpy $R1 "$9"
              !insertmacro CccInList "$3:$4" $6
              Pop $R1
              ${If} $6 == 1
                StrCpy $4 0
                System::Call 'user32::GetWindowThreadProcessId(p r8, *i .r4)'
                ${If} $4 == $3
                  ; WM_CLOSE
                  System::Call 'user32::PostMessageW(p r8, i 0x10, p 0, p 0) i .r6'
                  ${If} $6 != 0
                    IntOp $R2 $R2 + 1
                    StrCpy $R0 "$R0$3,"
                  ${EndIf}
                ${EndIf}
              ${EndIf}
            ${EndIf}
            System::Call 'kernel32::CloseHandle(p r5)'
          ${EndIf}
        ${Loop}
        ${If} $R2 > 0
          DetailPrint "Windows of AI Code Conductor asked to close: $R2."
        ${Else}
          DetailPrint "No window of AI Code Conductor could be reached from here (over a remote or scheduled sign-in its windows are on another desktop), so none was asked to close."
        ${EndIf}

        ; 2. Up to 5 seconds, looking every 250 ms.
        StrCpy $R4 0
        ${Do}
          Sleep 250
          StrCpy $R1 ","
          !insertmacro CccScanAppCopies 0 "" "${OLD_UNINSTALLER}" ""
          IntOp $R4 $R4 + 1
          ${If} $R1 == ","
          ${OrIf} $R4 >= 20
            ${ExitDo}
          ${EndIf}
        ${Loop}

        ${If} $R1 != ","
          ; 3. In a run someone can see, is a copy that was asked to close
          ; still open? ($5 = 1.) Then it may be asking whether to save its
          ; sessions, and nothing is ended.
          StrCpy $5 0
          ${IfNot} ${Silent}
            StrCpy $R4 1
            ${Do}
              !insertmacro CccNextPair "$R0" $R4 $3 $4
              ${If} $3 == ""
                ${ExitDo}
              ${EndIf}
              !insertmacro CccInList "$3" $6
              ${If} $6 == 1
                StrCpy $5 1
              ${EndIf}
            ${Loop}
          ${EndIf}
          ${If} $5 == 1
            DetailPrint "AI Code Conductor was asked to close and is still open. It may be asking whether to save your sessions, so it was not ended."
          ${Else}
            ; Each copy the first look found that the last one still saw: $3
            ; its pid, $4 its start.
            StrCpy $R4 1
            ${Do}
              !insertmacro CccNextPair "$9" $R4 $3 $4
              ${If} $3 == ""
                ${ExitDo}
              ${EndIf}
              !insertmacro CccInList "$3" $6
              ${If} $6 == 1
                ; PROCESS_TERMINATE and PROCESS_QUERY_LIMITED_INFORMATION.
                System::Call 'kernel32::OpenProcess(i 0x1001, i 0, i $3) p .r8'
                ${If} $8 != 0
                  !insertmacro CccProcessIsMine "$3" $6
                  !insertmacro CccProcessStart "$3" $R8
                  ${If} $6 == 1
                  ${AndIf} $4 != ""
                  ${AndIf} $R8 == $4
                    System::Call 'kernel32::TerminateProcess(p r8, i 1) i .r6 ?e'
                    Pop $7
                    ${If} $6 != 0
                      DetailPrint "Ended process $3, which did not close within 5 seconds."
                    ${Else}
                      !insertmacro CccWhyNotEnded "$3" $8 $7
                    ${EndIf}
                  ${Else}
                    DetailPrint "Did not end process $3: it could not be confirmed as the copy found first."
                  ${EndIf}
                  System::Call 'kernel32::CloseHandle(p r8)'
                ${Else}
                  DetailPrint "Could not end process $3: it could not be opened to end it."
                ${EndIf}
              ${EndIf}
            ${Loop}

            ; 4. Windows finishes ending a process a moment later.
            StrCpy $R4 0
            ${Do}
              Sleep 250
              StrCpy $R1 ","
              !insertmacro CccScanAppCopies 0 "" "${OLD_UNINSTALLER}" ""
              IntOp $R4 $R4 + 1
              ${If} $R1 == ","
              ${OrIf} $R4 >= 8
                ${ExitDo}
              ${EndIf}
            ${Loop}
          ${EndIf}
        ${EndIf}
      ${EndIf}

      ; 5. The last look: what is still running from this install's folder.
      ; A process from there whose user could not be read counts too when
      ; this installer is not elevated ($R0 = 1): it is then most likely this
      ; user's copy started as administrator. Run elevated, this installer
      ; can read the user of every copy this user started, elevated or not,
      ; so such a process is another user's and keeps running, as another
      ; user's copy does.
      StrCpy $R0 1
      System::Call 'kernel32::GetCurrentProcess() p .r0'
      System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i .r2'
      ${If} $2 != 0
        ; TokenElevation
        System::Call 'advapi32::GetTokenInformation(p r1, i 20, *i .r3, i 4, *i .r2) i .r2'
        ${If} $2 != 0
        ${AndIf} $3 != 0
          StrCpy $R0 0
        ${EndIf}
        System::Call 'kernel32::CloseHandle(p r1)'
      ${EndIf}
      StrCpy $R1 ","
      !insertmacro CccScanAppCopies 2 "" "${OLD_UNINSTALLER}" $R0
    ${EndIf}
  ${EndIf}

  ${If} $R1 == ","
    StrCpy $R0 0
  ${ElseIf} $R1 == ""
    StrCpy $R0 2
  ${Else}
    StrCpy $R0 1
  ${EndIf}
  System::Free $R3
  System::Free $R5
  System::Free $R9
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; Force-ends every aicc-helper.exe that this copy's own user runs, and what
; each one started: at least 8 levels below each holder, and in practice all
; of them (each pass also takes the children of what it found earlier in the
; same pass). A held terminal
; keeps its copy's files open, the conpty folder's OpenConsole.exe among
; them, and once the app is gone nothing can reach it; a holder has no window
; or console to close. Only this user's, never another user's, even when this
; copy is elevated: the user is the one in this copy's own token, and every
; process is checked against it, again just before it is ended, when it must
; also still be the process listed (its start, CccEndListed). A
; development run's holders end too. Saves and restores every register but
; $9, where it adds its note.
!macro CccEndUserHelpers
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  ; The name, for the notes only.
  StrCpy $8 ""
  System::Call 'secur32::GetUserNameExW(i 2, w .r8, *i ${NSIS_MAX_STRLEN})'
  ${If} $8 == ""
    StrCpy $8 "this user"
  ${EndIf}
  ; This copy's own user: TOKEN_USER in $R0, its SID at $R6.
  System::Alloc 256
  Pop $R0
  System::Alloc 256
  Pop $R5
  System::Alloc 556
  Pop $R3
  StrCpy $R6 0
  System::Call 'kernel32::GetCurrentProcess() p .r0'
  System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i .r2'
  ${If} $2 != 0
    System::Call 'advapi32::GetTokenInformation(p r1, i 1, p R0, i 256, *i .r2) i .r2'
    ${If} $2 != 0
      System::Call '*$R0(p .R6)'
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r1)'
  ${EndIf}

  ${If} $R6 == 0
    !insertmacro CccHelperNote "Could not tell which user this is, so no running session helper was ended."
  ${Else}
    StrCpy $R1 ","
    !insertmacro CccScanProcesses 0
    ${If} $R1 == ","
      !insertmacro CccHelperNote "No session helper of $8 was running."
    ${Else}
      ; What they started: a pass also takes the children of what it found
      ; earlier in the same pass; stop when a pass finds nothing new, or
      ; after 8 passes.
      StrCpy $R4 0
      ${Do}
        StrLen $R9 "$R1"
        !insertmacro CccScanProcesses 1
        StrLen $7 "$R1"
        IntOp $R4 $R4 + 1
        ${If} $7 == $R9
        ${OrIf} $R4 >= 8
          ${ExitDo}
        ${EndIf}
      ${Loop}
      !insertmacro CccEndListed
      ; Windows finishes ending a process a moment later: look again, for
      ; up to about 3 seconds.
      StrCpy $R4 0
      ${Do}
        Sleep 300
        StrCpy $R1 ","
        !insertmacro CccScanProcesses 0
        IntOp $R4 $R4 + 1
        ${If} $R1 == ","
        ${OrIf} $R4 >= 10
          ${ExitDo}
        ${EndIf}
      ${Loop}
      ${If} $R1 == ","
        !insertmacro CccHelperNote "Ended the running session helpers of $8."
      ${Else}
        !insertmacro CccHelperNote "Some session helpers of $8 are still running, so their files may stay."
      ${EndIf}
    ${EndIf}
  ${EndIf}

  System::Free $R3
  System::Free $R5
  System::Free $R0
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; Removes one of the helper folder's own folders, $R0\$R3, by the layout
; above. The caller has checked that it is not a link and that it neither is
; nor holds the user's data or resources folder. Each folder inside it is
; checked not to be a link first. Saves and restores the caller's search
; ($R2 $R3) around its own. Scratch: $R8 $R9 $5 $6, and CccIsHex12's.
!macro CccRemoveHelperOwnFolder
  StrCpy $R8 "$R0\$R3"
  StrCpy $R9 "$R3" 5
  ${If} "$R3" S== "store"
    Delete "$R8\.lock"
    Delete "$R8\*.json"
    Delete "$R8\*.json.*.tmp"
  ${ElseIf} $R9 S== ".new-"
    Delete "$R8\aicc-helper.exe"
  ${Else}
    ; A version folder: its conpty folder, then any ConPTY copy that stopped
    ; half way, then the helper itself.
    ${If} ${FileExists} "$R8\conpty\*.*"
      ${GetFileAttributes} "$R8\conpty" "REPARSE_POINT" $6
      ${If} $6 == 0
        Delete "$R8\conpty\conpty.dll"
        Delete "$R8\conpty\OpenConsole.exe"
        RMDir "$R8\conpty"
      ${EndIf}
    ${EndIf}
    Push $R2
    Push $R3
    ClearErrors
    FindFirst $R2 $R3 "$R8\.new-*"
    ${Do}
      ${If} $R3 == ""
        ${ExitDo}
      ${EndIf}
      StrCpy $R9 "$R3" "" 5
      !insertmacro CccIsHex12 "$R9" $5
      ${If} $5 == 1
      ${AndIf} ${FileExists} "$R8\$R3\*.*"
        ${GetFileAttributes} "$R8\$R3" "REPARSE_POINT" $6
        ${If} $6 == 0
          Delete "$R8\$R3\conpty.dll"
          Delete "$R8\$R3\OpenConsole.exe"
          RMDir "$R8\$R3"
        ${EndIf}
      ${EndIf}
      FindNext $R2 $R3
    ${Loop}
    FindClose $R2
    ClearErrors
    Pop $R3
    Pop $R2
    Delete "$R8\aicc-helper.exe"
  ${EndIf}
  RMDir "$R8"
!macroend

; Removes this user's copies of the session helper and their records, and
; shows in the details list what it did. customUnInstall inserts it, never on
; an update (see there). It runs as the user who started the uninstall:
;   - The elevated copy of an all-users uninstall started by the user. The
;     uninstaller starts as that user, starts itself again as administrator
;     (UAC_RunElevated, multiUser.nsh), and the first copy waits for the
;     second. The clean-up runs in that first copy (UAC_AsUser_Call), with
;     the user's own rights, local app data folder and registry. That copy
;     has no window, so it hands its notes back in $9, which the UAC plugin
;     copies back with the other registers (UAC_SYNCREGISTERS).
;   - Any other uninstall runs it in this copy: a per-user one, and one
;     started already elevated, which has no first copy behind it (Windows
;     Settings, Apps on an all-users install; an administrator prompt). The
;     user is then the account this copy runs as.
; If the first copy did not run it (no notes came back), this copy runs it.
; An uninstall that runs as another account (a standard user who typed an
; administrator's password before it started) reaches that account's folder
; and holders, not the standard user's. The label is called like a Function
; and ends at its Return; a Function would have to sit at file scope, where a
; UAC call compiles before electron-builder adds the plugin.
!macro RemoveUserHelperFolder
  Push $9
  StrCpy $9 ""
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_Call Label cccHelperFolderHere ${UAC_SYNCREGISTERS}
  ${EndIf}
  ${If} $9 == ""
    Call :cccHelperFolderHere
  ${EndIf}
  !insertmacro CccPrintHelperNotes
  Pop $9
  Goto cccHelperFolderDone
  cccHelperFolderHere:
    !insertmacro RemoveUserHelperFolderHere
    Return
  cccHelperFolderDone:
!macroend

; The clean-up itself, in whichever copy RemoveUserHelperFolder chose. It
; adds a note for everything it does or leaves ($9) and shows none itself.
; In order:
;   1. Nothing when the parent or the helper folder is a link. A parent made a
;      junction by hand points at the user's data elsewhere.
;   2. This user's running aicc-helper.exe, with what they started, are
;      force-ended (CccEndUserHelpers).
;   3. Each of the helper folder's own folders (IsHelperOwnFolder) that is not
;      a link, and is not and does not hold the user's data or resources
;      folder, is removed by the layout (CccRemoveHelperOwnFolder). Those two
;      are the ones the user recorded (any brand's key, as ReadUserPath reads
;      them), or the ones the app then uses (src/main/data-paths.ts): with no
;      data folder recorded, the parent, and with no resources folder
;      recorded, the data folder's resources folder. A file still in use (a
;      holder taking a moment to end, a virus scan) is tried again for about
;      3 seconds; what stays after that is noted.
;   4. The two files, by name.
;   5. The helper folder, then the parent, with plain RMDir: each goes only
;      when it is empty, and never when it is the data or resources folder.
; Registers are saved and restored, all but $9. $R0 is the helper folder, $R1
; its parent, $R2 the search handle, $R3 the name found, $R4 the round, $3
; the folders this round tried, $4 the ones still there after it, $5 and $6
; answers, $7 the data folder and $8 the resources folder.
!macro RemoveUserHelperFolderHere
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  ; The app finds the folder the same way (install.ts helperRootDir).
  ReadEnvStr $R1 LOCALAPPDATA
  ${If} $R1 == ""
    !insertmacro CccHelperNote "No local app data folder is set, so there is no session helper folder to remove."
  ${Else}
    StrCpy $R1 "$R1\AI Code Conductor"
    StrCpy $R0 "$R1\helper"
    ${IfNot} ${FileExists} "$R0\*.*"
      !insertmacro CccHelperNote "No session helper folder to remove: $R0"
    ${Else}
      ; Fail closed: only a hard "0" (no reparse attribute) goes on.
      ${GetFileAttributes} "$R1" "REPARSE_POINT" $5
      ${GetFileAttributes} "$R0" "REPARSE_POINT" $6
      ${If} $5 != 0
      ${OrIf} $6 != 0
        !insertmacro CccHelperNote "Left the session helper folder as it is, because it or its parent is a link: $R0"
      ${Else}
        !insertmacro CccHelperNote "Session helper folder: $R0"
        !insertmacro ReadUserPath "DataDirectory" $7
        ${If} $7 == ""
          StrCpy $7 "$R1"
        ${EndIf}
        !insertmacro ReadUserPath "ResourcesDirectory" $8
        ${If} $8 == ""
          ; The data folder's own, as data-paths.ts joins it: from the plain
          ; spelling, so a trailing or forward slash makes no odd path.
          !insertmacro CanonPathPair "$7" $cccCanonA $cccCanonAS
          StrCpy $8 "$cccCanonA\resources"
        ${EndIf}

        !insertmacro CccEndUserHelpers

        StrCpy $R4 0
        ${Do}
          StrCpy $3 0
          StrCpy $4 0
          ClearErrors
          FindFirst $R2 $R3 "$R0\*.*"
          ${Do}
            ${If} $R3 == ""
              ${ExitDo}
            ${EndIf}
            ; Never "." or "..": "helper\.." is the parent, the Data folder's
            ; default. The name test below rejects both as well.
            ${If} $R3 != "."
            ${AndIf} $R3 != ".."
            ${AndIf} ${FileExists} "$R0\$R3\*.*"
              !insertmacro IsHelperOwnFolder "$R3" $5
              ${If} $5 == 1
                ${GetFileAttributes} "$R0\$R3" "REPARSE_POINT" $6
                ${If} $6 != 0
                  ${If} $R4 == 0
                    !insertmacro CccHelperNote "Left $R3 as it is, because it is a link."
                  ${EndIf}
                ${Else}
                  !insertmacro HoldsUserFolder "$R0\$R3" $6
                  ${If} $6 == 1
                    ${If} $R4 == 0
                      !insertmacro CccHelperNote "Left $R3 as it is, because it holds your data or resources folder."
                    ${EndIf}
                  ${Else}
                    IntOp $3 $3 + 1
                    !insertmacro CccRemoveHelperOwnFolder
                    ${If} ${FileExists} "$R0\$R3\*.*"
                      IntOp $4 $4 + 1
                      ${If} $R4 >= 6
                        !insertmacro CccHelperNote "Kept $R3, because a file in it is still in use or was not made by the app."
                      ${EndIf}
                    ${Else}
                      !insertmacro CccHelperNote "Removed $R3"
                    ${EndIf}
                  ${EndIf}
                ${EndIf}
              ${EndIf}
            ${EndIf}
            FindNext $R2 $R3
          ${Loop}
          FindClose $R2
          ClearErrors
          ; Another round after any try: one that tries nothing is done.
          IntOp $R4 $R4 + 1
          ${If} $3 == 0
          ${OrIf} $R4 >= 7
            ${ExitDo}
          ${EndIf}
          ${If} $4 > 0
            Sleep 500
          ${EndIf}
        ${Loop}

        Delete "$R0\bindings.json"
        Delete "$R0\app-running.json"

        !insertmacro HoldsUserFolder "$R0" $6
        ${If} $6 == 1
          !insertmacro CccHelperNote "Kept the session helper folder, because it is, or holds, your data or resources folder."
        ${Else}
          RMDir "$R0"
          ${If} ${FileExists} "$R0\*.*"
            !insertmacro CccHelperNote "Kept the session helper folder, because something in it is still in use or was not made by the app."
          ${Else}
            !insertmacro CccHelperNote "Removed the session helper folder."
          ${EndIf}
        ${EndIf}
        !insertmacro HoldsUserFolder "$R1" $6
        ${If} $6 != 1
          RMDir "$R1"
          ${IfNot} ${FileExists} "$R1\*.*"
            !insertmacro CccHelperNote "Removed the empty folder $R1"
          ${EndIf}
        ${EndIf}
        ClearErrors
      ${EndIf}
    ${EndIf}
  ${EndIf}

  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customUnInstall
  ; Read ResourcesDirectory from new key, fall back to old key
  ReadRegStr $0 HKCU "Software\AI Code Conductor" "ResourcesDirectory"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Claude Command Center" "ResourcesDirectory"
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Claude Conductor" "ResourcesDirectory"
  ${EndIf}
  ${If} $0 != ""
    ${If} ${FileExists} "$0\CONFIG\*.*"
      ; Only ask during manual uninstall (not during silent upgrade)
      IfSilent skip_config_dialog
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also remove user configuration data from:$\n$0\CONFIG$\n$\n(Settings, terminal configs, command buttons, etc.)" IDYES remove_config
        Goto skip_config_removal
        remove_config:
          RMDir /r "$0\CONFIG"
          DetailPrint "Removed CONFIG directory: $0\CONFIG"
        skip_config_removal:
      skip_config_dialog:
    ${EndIf}
  ${EndIf}

  ; U2: remove the legacy planted statusline script from ~/.claude. Pre-U2 installs
  ; left ~/.claude/claude-multi-statusline.js behind (new installs never plant it).
  ; The settings.json statusLine stanza is stripped by CCC's boot-heal on the first
  ; run after upgrade; a belt-and-braces uninstall-time stanza strip is deferred
  ; until it can be build-validated (Unit 13).
  Delete "$PROFILE\.claude\claude-multi-statusline.js"

  ; Clean up old registry key if it still exists
  DeleteRegKey /ifempty HKCU "Software\Claude Conductor"

  ; The session helper's per-user folder (RemoveUserHelperFolder above).
  ; Never on an update: the new installer runs this uninstaller with
  ; --updated (electron-builder installUtil.nsh, uninstallOldVersion), and
  ; held terminals are meant to live through an update, so their helper
  ; copies and records stay. The one exception is Setup started with
  ; --delete-app-data: it then passes that flag instead of --updated, which
  ; asks for the app's data to go, and the helper folder goes with it.
  ${IfNot} ${isUpdated}
    !insertmacro RemoveUserHelperFolder
  ${EndIf}
!macroend

; ============================================================
; UNINSTALLER: removing the program files, and saying what is left
; ============================================================
; electron-builder's uninstall section inserts customRemoveFiles, when it is
; defined, in place of its own removal of the install folder (uninstaller.nsh,
; "!ifmacrodef customRemoveFiles"). customRemoveFiles runs that removal
; unchanged: the lines of its !else branch at the pinned app-builder-lib
; (26.15.3), which installer-branding-guard.test.ts holds this copy to, so a
; newer electron-builder that changes them fails there instead of drifting.
; Then CccReportLeftFiles says what the removal could not take. Before, a file
; another program still had open (another user's running copy of the app, on
; an all-users uninstall) stayed with no word in the details list.
; Uninstaller pass only: the installer pass never inserts either.
!ifdef BUILD_UNINSTALLER
!macro customRemoveFiles
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      # Attempt to restore previous directory
      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}

  ${endif}

  # Move out of $INSTDIR so it can be removed
  SetOutPath $TEMP
  # Remove all files (or remaining shallow directories from the block above)
  RMDir /r $INSTDIR

  !insertmacro CccReportLeftFiles
!macroend

; When $INSTDIR is still there after the removal, one details line for each
; file left in it, at most 50, then how many more. The walk is depth first
; over the stack and bounded: at most 1000 folders are looked in (a folder
; taken off the stack after that is counted as not looked in) and at most
; 256 wait on the stack. It never enters a link: a link is named as left,
; like a file.
; Then, on an uninstall for all users that is not an update, with $INSTDIR
; inside Program Files, what is left is set to go when Windows next restarts
; (RMDir /r /REBOOTOK). Only administrators can write there, so nobody can put
; a link in its place before that restart: a delete set for the next start
; runs before anything can check the path again (the rule beside
; RemoveUserHelperFolder). So nothing is set to go at the next start on a
; per-user uninstall, from an all-users install outside Program Files, or
; when a new install may go into this same folder next: an update
; (--updated), or any uninstall given --delete-app-data. Setup passes that
; flag in place of --updated (installUtil.nsh uninstallOldVersion, when Setup
; itself was given it); a person or a management tool may pass it too, for a
; full uninstall, whose held files then stay rather than wait for a restart. An
; all-users install also stops while such a removal waits in its folder
; (CccStopOnPendingRemoval), because the restart would take the new files at
; those paths too. Nobody is asked to restart now: another user may be signed
; in and using the app, so the reboot flag is cleared again. Saves and
; restores every register it uses: $0 the files found, $1 the folders looked
; in, $2 the folders waiting, $3 the folder, $4 the search, $5 the name found,
; $6 the folders not looked in, $R0 an answer, $R1 1 on an update and 2 on an
; uninstall given --delete-app-data, $R2 $R3 the command line and an option's
; value; $R5 $R6 $R7 and $cccCanon* are IsSameOrInsideCanon's.
!macro CccReportLeftFiles
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R5
  Push $R6
  Push $R7
  ClearErrors
  ${If} ${FileExists} "$INSTDIR\*.*"
    DetailPrint "Could not remove everything in $INSTDIR. A program may still have these open:"
    StrCpy $0 0
    StrCpy $1 0
    StrCpy $2 1
    StrCpy $6 0
    Push "$INSTDIR"
    ${Do}
      ${If} $2 < 1
        ${ExitDo}
      ${EndIf}
      Pop $3
      IntOp $2 $2 - 1
      ${If} $1 >= 1000
        IntOp $6 $6 + 1
        ${Continue}
      ${EndIf}
      IntOp $1 $1 + 1
      ClearErrors
      FindFirst $4 $5 "$3\*.*"
      ${Do}
        ${If} $5 == ""
          ${ExitDo}
        ${EndIf}
        ${If} $5 != "."
        ${AndIf} $5 != ".."
          StrCpy $R0 0
          ${If} ${FileExists} "$3\$5\*.*"
            ; A folder. Fail closed: only a hard "0" (no reparse attribute)
            ; is looked into; a link is named as left.
            ${GetFileAttributes} "$3\$5" "REPARSE_POINT" $R0
            ${If} $R0 == 0
              ${If} $2 < 256
                Push "$3\$5"
                IntOp $2 $2 + 1
              ${Else}
                IntOp $6 $6 + 1
              ${EndIf}
            ${Else}
              StrCpy $R0 1
            ${EndIf}
          ${Else}
            StrCpy $R0 1
          ${EndIf}
          ${If} $R0 == 1
            IntOp $0 $0 + 1
            ${If} $0 <= 50
              DetailPrint "Left: $3\$5"
            ${EndIf}
          ${EndIf}
        ${EndIf}
        FindNext $4 $5
      ${Loop}
      FindClose $4
    ${Loop}
    ClearErrors
    ${If} $0 > 50
      IntOp $R0 $0 - 50
      DetailPrint "And $R0 more files."
    ${EndIf}
    ${If} $6 > 0
      DetailPrint "And $6 more folders, which were not looked in."
    ${EndIf}
    ${If} $0 == 0
    ${AndIf} $6 == 0
      DetailPrint "No file is left in it, but the folder itself could not be removed."
    ${EndIf}

    ; Whether a new install may go into this folder next: 1 on an update, 2
    ; on any uninstall given --delete-app-data (Setup's, in place of --updated,
    ; or a person's full uninstall). Either way nothing is set for the restart.
    StrCpy $R1 0
    ${If} ${isUpdated}
      StrCpy $R1 1
    ${Else}
      ${GetParameters} $R2
      ClearErrors
      ${GetOptions} $R2 "--delete-app-data" $R3
      ${IfNot} ${Errors}
        StrCpy $R1 2
      ${EndIf}
      ClearErrors
    ${EndIf}
    ${If} $installMode == "all"
    ${AndIf} $R1 == 0
      StrCpy $R0 0
      !insertmacro IsSameOrInsideCanon "$PROGRAMFILES64" "$INSTDIR" $R0
      ${If} $R0 != 1
        !insertmacro IsSameOrInsideCanon "$PROGRAMFILES" "$INSTDIR" $R0
      ${EndIf}
      ; Inside it, never Program Files itself.
      ${If} $cccCanonA == $cccCanonB
      ${OrIf} $cccCanonAS == $cccCanonBS
        StrCpy $R0 0
      ${EndIf}
      ${If} $R0 == 1
        SetRebootFlag false
        ClearErrors
        RMDir /r /REBOOTOK "$INSTDIR"
        ${IfNot} ${FileExists} "$INSTDIR\*.*"
          DetailPrint "They were removed on a second try."
        ${ElseIf} ${Errors}
          DetailPrint "Windows could not set them all to be removed at the next restart, so some stay until they are removed by hand."
        ${ElseIf} ${RebootFlag}
          DetailPrint "They are removed when Windows next restarts. Restart before you install AI Code Conductor in this folder again."
        ${Else}
          DetailPrint "Windows could not set them to be removed at the next restart, so they stay until they are removed by hand."
        ${EndIf}
        SetRebootFlag false
      ${Else}
        DetailPrint "They stay until they are removed by hand: this folder is not inside Program Files, so they are not set to be removed at the next restart."
      ${EndIf}
    ${ElseIf} $R1 != 1
      DetailPrint "They stay until they are removed by hand, once the program that has them open has closed."
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
!endif
