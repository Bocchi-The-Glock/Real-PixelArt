; Single EXE, no install wizard, registry entries, shortcuts or elevation.
; Uses only plugins already shipped with electron-builder's pinned NSIS toolset.
!include "common.nsh"
!include "${PROJECT_DIR}\dist\runtime-cache.nsh"
Icon "${MUI_ICON}"
RequestExecutionLevel user
CRCCheck off
WindowIcon Off
AutoCloseWindow True
SilentInstall silent

Var CacheRoot
Var CacheDir
Var Mutex
Var Lease
Var Valid
Var Quiet
Var BannerShown
Var ExitCode
Var FindHandle
Var Candidate
Var ScanPath
Var SafeTree

; Expected directories/files must never redirect validation outside the cache.
!macro CheckDirectory RELATIVE
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\${RELATIVE}") i.r0'
  IntCmp $0 -1 invalid
  IntOp $0 $0 & 0x400
  IntCmp $0 0 +2
    Goto invalid
!macroend
!macro CheckFile RELATIVE HASH
  !insertmacro CheckDirectory "${RELATIVE}"
  ${StdUtils.HashFile} $0 "SHA2-256" "$INSTDIR\${RELATIVE}"
  StrCmp $0 "${HASH}" +2
    Goto invalid
!macroend

Function VerifyRuntime
  StrCpy $Valid 0
  !insertmacro CheckRuntime
  StrCpy $Valid 1
  invalid:
FunctionEnd

; Refuse recursive removal if ANY child is a junction/symlink. Only owned cache
; directories under the fixed per-user root are ever passed to this function.
Function CheckTree
  Push $0
  Push $1
  Push $2
  System::Call 'kernel32::GetFileAttributesW(w "$ScanPath") i.r0'
  IntCmp $0 -1 tree_done
  IntOp $1 $0 & 0x400
  ${If} $1 != 0
    StrCpy $SafeTree 0
    Goto tree_done
  ${EndIf}
  FindFirst $1 $2 "$ScanPath\*"
  tree_loop:
    StrCmp $2 "" tree_close
    StrCmp $2 "." tree_next
    StrCmp $2 ".." tree_next
    System::Call 'kernel32::GetFileAttributesW(w "$ScanPath\$2") i.r0'
    IntOp $0 $0 & 0x410
    ${If} $0 >= 0x400
      StrCpy $SafeTree 0
      Goto tree_close
    ${ElseIf} $0 == 0x10
      Push $ScanPath
      StrCpy $ScanPath "$ScanPath\$2"
      Call CheckTree
      Pop $ScanPath
      StrCmp $SafeTree 0 tree_close
    ${EndIf}
    tree_next:
      FindNext $1 $2
      Goto tree_loop
  tree_close:
    FindClose $1
  tree_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function LockCache
  System::Call 'kernel32::WaitForSingleObject(p $Mutex, i 120000) i.r0'
  ${If} $0 != 0
  ${AndIf} $0 != 0x80
    MessageBox MB_OK|MB_ICONSTOP "Cannot access the runtime cache. Please try again. / 无法访问程序缓存，请重试。"
    SetErrorLevel 1
    Quit
  ${EndIf}
FunctionEnd

Function ReleaseCache
  System::Call 'kernel32::ReleaseMutex(p $Mutex)'
FunctionEnd

Function .onInit
  SetShellVarContext current
  InitPluginsDir
  ${StdUtils.TestParameter} $Quiet "smoke-test"
  StrCpy $CacheRoot "$LOCALAPPDATA\RealPixelArt\Runtime"
  StrCpy $CacheDir "$CacheRoot\${CACHE_ID}"
  ; Do not follow a redirected application/cache root during extraction/deletion.
  StrCpy $INSTDIR "$LOCALAPPDATA"
  !insertmacro CheckDirectory "RealPixelArt"
  !insertmacro CheckDirectory "RealPixelArt\Runtime"
  Goto root_ok
  invalid:
    ; Missing directories are normal on the first run; reparse points are not.
    System::Call 'kernel32::GetFileAttributesW(w "$LOCALAPPDATA\RealPixelArt") i.r0'
    ${If} $0 != -1
      IntOp $0 $0 & 0x400
      IntCmp $0 0 +2
        Goto unsafe_root
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w "$CacheRoot") i.r0'
    ${If} $0 != -1
      IntOp $0 $0 & 0x400
      IntCmp $0 0 +2
        Goto unsafe_root
    ${EndIf}
  root_ok:
  ClearErrors
  CreateDirectory "$CacheRoot"
  IfErrors unsafe_root
  ; Include the user root in the lock name: separate Windows users do not block.
  ${StdUtils.HashText} $0 "SHA2-256" "$CacheRoot"
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\RealPixelArt.Runtime.$0") p.s'
  Pop $Mutex
  StrCmp $Mutex 0 unsafe_root
  Return
  unsafe_root:
    MessageBox MB_OK|MB_ICONSTOP "Cannot safely create the runtime cache. / 无法安全创建程序缓存。$\n$CacheRoot"
    SetErrorLevel 1
    Quit
FunctionEnd

Section
  Call LockCache
  StrCpy $INSTDIR $CacheDir
  System::Call 'kernel32::GetFileAttributesW(w "$CacheDir") i.r0'
  ${If} $0 != -1
    IntOp $0 $0 & 0x400
    IntCmp $0 0 +2
      Goto failed
  ${EndIf}
  StrCpy $Valid 0
  ReadINIStr $0 "$INSTDIR\.runtime-cache.ini" "cache" "id"
  ${If} $0 == "${CACHE_ID}"
    Call VerifyRuntime
  ${EndIf}
  ${If} $Valid != 1
    ; An active launcher holds this file without FILE_SHARE_WRITE/DELETE.
    ; Never overwrite a runtime still used by another running window.
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\.in-use", i 0xC0000000, i 0, p 0, i 3, i 0x80, p 0) p.s'
    Pop $Lease
    ${If} $Lease == -1
      IfFileExists "$INSTDIR\.in-use" busy
    ${Else}
      System::Call 'kernel32::CloseHandle(p $Lease)'
    ${EndIf}
    StrCpy $ScanPath $INSTDIR
    StrCpy $SafeTree 1
    Call CheckTree
    StrCmp $SafeTree 0 failed
    RMDir /r "$INSTDIR"
    IfFileExists "$INSTDIR\*" failed
    CreateDirectory "$INSTDIR"
    ClearErrors
    SetOutPath "$INSTDIR"
    IfErrors failed
    ${If} $Quiet != "true"
      Banner::show /NOUNLOAD "正在准备程序，首次运行需要解压…$\nPreparing the app; please wait..."
      StrCpy $BannerShown 1
    ${EndIf}
    ; Embedded 7z is stored uncompressed in the EXE, so warm launches never read
    ; or inflate the 100 MiB payload. Extract directly, then verify every file.
    SetCompress off
    File /oname=$PLUGINSDIR\runtime.7z "${APP_64}"
    Nsis7z::Extract "$PLUGINSDIR\runtime.7z"
    Delete "$PLUGINSDIR\runtime.7z"
    Call VerifyRuntime
    StrCmp $Valid 1 +2
      Goto failed
    WriteINIStr "$INSTDIR\.runtime-cache.ini" "cache" "owner" "RealPixelArt.Runtime.v1"
    WriteINIStr "$INSTDIR\.runtime-cache.ini" "cache" "id" "${CACHE_ID}"
  ${EndIf}
  ; Shared read leases permit repeated double-clicks. Cleanup/repair requires
  ; exclusive access, and Windows releases leases automatically after a crash.
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\.in-use", i 0x80000000, i 1, p 0, i 4, i 0x80, p 0) p.s'
  Pop $Lease
  StrCmp $Lease -1 failed
  Call ReleaseCache
  ${If} $BannerShown == 1
    Banner::destroy
    StrCpy $BannerShown 0
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_DIR", w "$EXEDIR")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_FILE", w "$EXEPATH")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "PIXELART_RUNTIME_DIR", w "$INSTDIR")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "PIXELART_RUNTIME_ID", w "${CACHE_ID}")'
  ${StdUtils.GetAllParameters} $R0 0
  ClearErrors
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" $R0' $ExitCode
  IfErrors launch_failed
  System::Call 'kernel32::CloseHandle(p $Lease)'
  SetOutPath "$EXEDIR"
  ; Only retire previous caches after the new app has successfully opened.
  IfFileExists "$CacheDir\.app-started" 0 done
  FileOpen $0 "$CacheDir\.app-started" r
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "${CACHE_ID}" 0 done
  Call LockCache
  FindFirst $FindHandle $Candidate "$CacheRoot\realpixelart-*-x64-*"
  cleanup_loop:
    StrCmp $Candidate "" cleanup_done
    StrCmp $Candidate "${CACHE_ID}" cleanup_next
    StrCpy $INSTDIR "$CacheRoot\$Candidate"
    ReadINIStr $0 "$INSTDIR\.runtime-cache.ini" "cache" "owner"
    StrCmp $0 "RealPixelArt.Runtime.v1" 0 cleanup_next
    ReadINIStr $0 "$INSTDIR\.runtime-cache.ini" "cache" "id"
    StrCmp $0 $Candidate 0 cleanup_next
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\.in-use", i 0xC0000000, i 0, p 0, i 3, i 0x80, p 0) p.s'
    Pop $Lease
    StrCmp $Lease -1 cleanup_next
    System::Call 'kernel32::CloseHandle(p $Lease)'
    StrCpy $ScanPath $INSTDIR
    StrCpy $SafeTree 1
    Call CheckTree
    StrCmp $SafeTree 0 cleanup_next
    RMDir /r "$INSTDIR"
    cleanup_next:
      FindNext $FindHandle $Candidate
      Goto cleanup_loop
  cleanup_done:
    FindClose $FindHandle
    Call ReleaseCache
  done:
    System::Call 'kernel32::CloseHandle(p $Mutex)'
    SetErrorLevel $ExitCode
    Quit
  launch_failed:
    System::Call 'kernel32::CloseHandle(p $Lease)'
    Goto failed
  busy:
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close RealPixelArt before repairing its cache. / 请先关闭正在运行的程序，再重新打开以修复缓存。"
    SetErrorLevel 1
    Quit
  failed:
    ${If} $BannerShown == 1
      Banner::destroy
    ${EndIf}
    MessageBox MB_OK|MB_ICONSTOP "Could not prepare/start the app. Check free disk space and retry. / 程序准备或启动失败，请检查磁盘空间后重试。$\n$CacheDir"
    SetErrorLevel 1
SectionEnd
