; Runs inside Hindsight's installer (also during auto-updates).

!macro NSIS_HOOK_PREINSTALL
  ; Stop Hindsight's helper tools still running from this folder (for example an
  ; ffmpeg left behind by a crash), or their files can't be replaced and the
  ; update fails halfway. Clips cut off this way are finished on next start.
  nsExec::Exec `powershell -NoProfile -NonInteractive -Command "Get-Process ffmpeg,ffprobe,PresentMon -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$INSTDIR\*' } | Stop-Process -Force"`
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Moving from the old name: Hindsight used to install as "Rewind" (in
  ; %LOCALAPPDATA%\Rewind, as rewind.exe). Remove that copy so there aren't two
  ; apps starting with Windows. Its uninstaller, run silently, never deletes
  ; app data, and settings, caches and clips live elsewhere anyway (under
  ; com.rewind.app, which hasn't changed, and the clips folder).
  ${If} ${FileExists} "$LOCALAPPDATA\Rewind\uninstall.exe"
  ${AndIf} "$INSTDIR" != "$LOCALAPPDATA\Rewind"
    nsExec::Exec `taskkill /F /IM rewind.exe`
    Pop $0
    ExecWait `"$LOCALAPPDATA\Rewind\uninstall.exe" /S _?=$LOCALAPPDATA\Rewind`
    Delete "$LOCALAPPDATA\Rewind\uninstall.exe"
    RMDir "$LOCALAPPDATA\Rewind"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Rewind"
  ${EndIf}

  ; Windows keeps old shortcut icons in its icon cache: refresh it so the new
  ; logo shows in the Start menu and taskbar without signing out.
  nsExec::Exec `"$SYSDIR\ie4uinit.exe" -show`
  Pop $0
!macroend
