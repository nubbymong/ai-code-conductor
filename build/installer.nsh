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
  !ifndef BUILD_UNINSTALLER
    Var cccSavedPerUserInstallLocation
    Var cccSavedPerMachineInstallLocation
    Var cccSavedPerUserUninstallString
    Var cccSavedPerMachineUninstallString

    Var cccLegacyUninstaller
    Var cccRecordVerdict
    Var cccRecordUninstaller

    Var cccCanonA
    Var cccCanonAS
    Var cccCanonB
    Var cccCanonBS
    Var cccCanonWork
    Var cccCanonChar
    Var cccCanonIdx
    Var cccCanonTmp

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
; APP-RUNNING CHECK — also the install's commit point
; ============================================================

; Override the default "app is running" check with debug-enabled version.
; Close a running instance before installing. An UPGRADE from a pre-rename build
; still has "Claude Command Center.exe" running, so both the current and the
; legacy executable names have to be checked — matching only
; ${APP_EXECUTABLE_FILENAME} would let the old process keep a file lock and fail
; the install.
!macro KillIfRunning EXE
  nsExec::Exec /TIMEOUT=5000 `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${EXE}" /FO csv | "$SYSDIR\find.exe" "${EXE}"`
  Pop $R0
  ${if} $R0 == 0
    DetailPrint "Found running ${EXE}, attempting to close..."
    nsExec::Exec `taskkill /im "${EXE}"`
    Sleep 2000
  ${endIf}
!macroend

!macro customCheckAppRunning
  DetailPrint "=== customCheckAppRunning: current + legacy executables ==="

  !insertmacro KillIfRunning "${APP_EXECUTABLE_FILENAME}"
  !insertmacro KillIfRunning "Claude Command Center.exe"
  !insertmacro KillIfRunning "Claude Conductor.exe"

  ; Re-check the current executable; if it survived a taskkill, let the user act.
  nsExec::Exec /TIMEOUT=5000 `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" "${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
  ${if} $R0 == 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "AI Code Conductor is still running.$\n$\nProcess: ${APP_EXECUTABLE_FILENAME}$\n$\nPlease close it manually and click Retry." IDRETRY retry_check
    !ifndef BUILD_UNINSTALLER
      Call CccRestoreInstallLocation
    !endif
    Quit
    retry_check:
  ${else}
    DetailPrint "No running instance found. Proceeding."
  ${endIf}

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
; BRANDING: dark theme, artwork, light motion, fresh-install splash
; ============================================================
; The art is drawn from the boot splash by scripts/gen-installer-art.mjs and
; committed under build/ (installerSidebar.bmp, installerHeader.bmp,
; installerSplash.bmp, installer-art/). package.json names the sidebar and the
; header explicitly, so a missing file fails the build instead of silently
; shipping NSIS's stock bitmap.
;
; ORDER. This file is compiled ahead of electron-builder's installer.nsi, so
; the Welcome page below is page 1 and the two folder pages stay pages 2 and 3.
; Modern UI reads its interface settings (MUI_BGCOLOR, MUI_TEXTCOLOR) when the
; FIRST page macro is inserted, which is now MUI_PAGE_WELCOME, so they are
; defined above it. MUI_CUSTOMFUNCTION_GUIINIT is read when addLangs inserts
; the language, after all of this. None of it may move into customHeader,
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
; The colours are shared by both passes, so the uninstaller matches.
!define CCC_BRAND_BG "0B0E15"
!define CCC_BRAND_TEXT "F4F7FA"
!define CCC_BRAND_FIELD "161B26"
!define MUI_BGCOLOR "${CCC_BRAND_BG}"
!define MUI_TEXTCOLOR "${CCC_BRAND_TEXT}"
; A themed checkbox ignores SetCtlColors, which would leave the Finish page's
; "Run" label dark on dark. Stock MUI: this drops the high-contrast-only guard
; in Finish.nsh (the IsHighContrastModeActive branch), so every check and radio
; control the Finish pages can show (Run, Show readme and the two reboot
; choices) is unthemed and takes the light text colour. A control a page does
; not create gets SetWindowTheme on a null handle, which does nothing.
!define MUI_FORCECLASSICCONTROLS

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
    SetCtlColors $cccAnimCtl "" "${CCC_BRAND_BG}"
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
  SetCtlColors $0 "" "${CCC_BRAND_BG}"

  ${NSD_CreateLabel} 0 0 100% 24u "Choose where to store sessions, logs, and configuration data:"
  Pop $0
  SetCtlColors $0 "${CCC_BRAND_TEXT}" "${CCC_BRAND_BG}"

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
  SetCtlColors $DataDir "${CCC_BRAND_TEXT}" "${CCC_BRAND_FIELD}"

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
  SetCtlColors $0 "" "${CCC_BRAND_BG}"

  ${NSD_CreateLabel} 0 0 100% 36u "Choose where to store shared resources (insights, screenshots, skills, scripts).$\nUse a network-mountable path to share across SSH sessions."
  Pop $0
  SetCtlColors $0 "${CCC_BRAND_TEXT}" "${CCC_BRAND_BG}"

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
  SetCtlColors $ResourcesDir "${CCC_BRAND_TEXT}" "${CCC_BRAND_FIELD}"

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
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Uninstall AI Code Conductor"
  !define MUI_WELCOMEPAGE_TEXT "Setup will remove AI Code Conductor from this computer.$\r$\n$\r$\nYour data and resources folders stay where they are. If your resources folder holds a CONFIG folder of settings, Setup asks whether to remove that too.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_UNPAGE_WELCOME
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
!macroend
